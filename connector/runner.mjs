import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command, privateDirectory, redact } from './common.mjs';
import { codexMetadata, selectedCodexOptions } from './codex-config.mjs';

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return `linux:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    const result = await command('ps', ['-o', 'lstart=', '-p', String(pid)]).catch(() => null);
    return result?.code === 0 && result.stdout.trim() ? `ps:${result.stdout.trim()}` : null;
  }
}
function killGroup(pid, signal) {
  try { process.kill(process.platform === 'win32' ? pid : -pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function identifiedAlive(pid, identity) {
  if (await processIdentity(pid) !== identity) return false;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return true; }
}
export async function stopRecoveredProcess(journal) {
  if (!journal.pid || !journal.processIdentity || await processIdentity(journal.pid) !== journal.processIdentity) return;
  killGroup(journal.pid, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && await identifiedAlive(journal.pid, journal.processIdentity)) await new Promise(accept => setTimeout(accept, 50));
  killGroup(journal.pid, 'SIGKILL');
  // Do not release ownership while an identified previous model process remains alive.
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline && await identifiedAlive(journal.pid, journal.processIdentity)) await new Promise(accept => setTimeout(accept, 50));
  if (await identifiedAlive(journal.pid, journal.processIdentity)) throw Error('Previous model process remains alive; refusing duplicate execution');
}
export function runnerInvocation(options, args) {
  return options['test-runner'] ? { executable: process.execPath, args: [options['test-runner'], ...args] } : { executable: options.codex || 'codex', args };
}
export async function runCodex({ config, options, cwd, directory, schema, prompt, sandbox, timeoutMs, signal, started, event }) {
  options = selectedCodexOptions(config, options);
  const metadata = await codexMetadata(options, cwd);
  Object.defineProperty(config, 'runtimeSecrets', { value: metadata.secrets, writable: true, configurable: true });
  await privateDirectory(directory);
  const schemaFile = join(directory, 'schema.json'), outputFile = join(directory, 'result.json');
  await writeFile(schemaFile, JSON.stringify(schema), { mode: 0o600 });
  const args = ['exec', '--ephemeral', '--sandbox', sandbox, '--json', '--color', 'never'];
  if (options.profile && options.profile !== 'default') args.push('--profile', options.profile);
  if (options.model) args.push('--model', options.model);
  if (options.reasoning) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.reasoning)}`);
  args.push('-c', 'approval_policy="never"');
  for (const name of metadata.mcp) if (name !== 'agent_task_hub') args.push('-c', `mcp_servers.${JSON.stringify(name)}.enabled=false`);
  for (const [name, value] of Object.entries({ command: process.execPath, args: [config.runtime, 'mcp', '--config', config.file], cwd: config.workspace, enabled: true, enabled_tools: ['get_idea', 'get_ticket', 'get_plan', 'list_tickets', 'list_plans'] })) args.push('-c', `mcp_servers.agent_task_hub.${name}=${JSON.stringify(value)}`);
  args.push('--cd', cwd, '--output-schema', schemaFile, '--output-last-message', outputFile, '-');
  const invocation = runnerInvocation(options, args);
  const childEnvironment = { ...process.env, NO_COLOR: '1' };
  const ownerIdentity = await processIdentity(process.pid);
  const supervisedArgs = [join(import.meta.dirname, 'supervisor.mjs'), String(process.pid), ownerIdentity, String(Date.now() + timeoutMs), invocation.executable, ...invocation.args];
  const child = spawn(process.execPath, supervisedArgs, { cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: childEnvironment });
  // Attach all process listeners before awaiting persistent journal I/O.
  let buffered = '', stderr = '', session, failure, stopReason, bytes = 0;
  const receipts = [], commands = new Set();
  let eventQueue = Promise.resolve();
  const notify = (stage, message) => { eventQueue = eventQueue.then(() => event?.(stage, redact(message, config))).catch(error => { failure ||= error; stop(`Event delivery failed: ${redact(error, config)}`); }); };
  let forceTimer;
  function stop(reason) {
    if (stopReason) return;
    stopReason = reason;
    if (child.pid) {
      killGroup(child.pid, 'SIGTERM');
      forceTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), 2000);
    }
  }
  const abort = () => stop(String(signal.reason?.message || signal.reason || 'Run cancelled'));
  const timer = setTimeout(() => stop('Codex execution timed out'), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const closed = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => accept(code));
  });
  closed.catch(() => {});
  function line(raw) {
    if (!raw.trim()) return;
    let value;
    try { value = JSON.parse(raw); } catch { failure ||= Error('Codex emitted invalid JSONL'); stop('Invalid Codex JSONL output'); return; }
    if (value.type === 'thread.started') session = value.thread_id;
    if (value.type === 'turn.failed' || value.type === 'error') { failure ||= Error(redact(value.error?.message || value.message || 'Codex model request failed', config)); stop(failure.message); }
    if (value.type === 'item.completed' && value.item?.type === 'command_execution') {
      const item = value.item;
      if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build)\b|\bnode\s+(?:[^\n]*\s)?--test\b|\b(?:pytest|vitest|jest|cargo\s+test|go\s+test|make\s+(?:test|check))\b/.test(item.command || '') && Number.isInteger(item.exit_code) && !commands.has(item.id)) {
        commands.add(item.id);
        receipts.push({ command: redact(item.command, config), exitCode: item.exit_code, output: redact(item.aggregated_output ?? '', config, 20000) });
        notify('checking', `Test command finished (${item.exit_code}): ${item.command}`);
      }
    }
  }
  child.stdout.on('data', data => {
    bytes += data.length;
    if (bytes > 8 * 1024 * 1024) { failure ||= Error('Codex output exceeds the limit'); stop(failure.message); return; }
    buffered += data.toString();
    let boundary;
    while ((boundary = buffered.indexOf('\n')) !== -1) { line(buffered.slice(0, boundary)); buffered = buffered.slice(boundary + 1); }
  });
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-12000); });
  try {
    const identity = await processIdentity(child.pid);
    if (child.pid && identity) await started({ pid: child.pid, processIdentity: identity });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const code = await closed;
    // Dispose of background descendants whose stdio was redirected before returning evidence.
    killGroup(child.pid, 'SIGTERM');
    await new Promise(accept => setTimeout(accept, 50));
    killGroup(child.pid, 'SIGKILL');
    if (buffered.trim()) line(buffered);
    await eventQueue;
    if (stopReason || failure) throw failure || Error(stopReason);
    if (code !== 0) throw Error(`Codex failed (${code}): ${redact(stderr.trim() || 'No diagnostic output', config)}`);
    let result;
    try { result = JSON.parse(await readFile(outputFile, 'utf8')); } catch { throw Error('Codex did not produce valid schema output'); }
    return { result, tests: receipts, agentSession: session };
  } catch (error) {
    stop(redact(error, config));
    await closed.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer); signal.removeEventListener('abort', abort);
  }
}
