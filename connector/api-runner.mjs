import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { codexMetadata } from './codex-config.mjs';
import { privateDirectory, redact } from './common.mjs';

// Direct OpenAI-compatible Chat Completions access. The API key stays in the
// named local environment variable; only its name is saved in connection.json.
export const TEST_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build)\b|\bnode\s+(?:[^\n]*\s)?--test\b|\b(?:pytest|vitest|jest|cargo\s+test|go\s+test|make\s+(?:test|check))\b/;
const MAX_TURNS = 80, MAX_READ = 200000, MAX_OUTPUT = 20000;

export function apiBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('--api-base-url must be a valid URL'); }
  if (url.username || url.password || url.search || url.hash) throw Error('--api-base-url must not contain credentials, query or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('--api-base-url must use HTTPS, or HTTP on loopback');
  return url.href.replace(/\/+$/, '');
}
// Resolve the saved API selection, optionally deriving base URL, key variable
// and model from a Codex profile's provider definition.
export async function apiSelection(api = {}, workspace) {
  let { baseUrl, keyEnv, model } = api;
  if (api.profile) {
    const metadata = await codexMetadata({ profile: api.profile }, workspace);
    baseUrl ||= metadata.baseUrl; keyEnv ||= metadata.envKey; model ||= metadata.model;
  }
  if (!baseUrl) throw Error('API access needs --api-base-url or --api-profile with a provider base_url');
  if (!keyEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw Error('API access needs --api-key-env naming a local environment variable');
  if (!model) throw Error('API access needs --api-model or a profile model');
  return { baseUrl: apiBaseUrl(baseUrl), keyEnv, model, reasoning: api.reasoning || null, host: new URL(baseUrl).host };
}
async function apiFetch(selection, path, init = {}, signal, timeoutMs = 10000) {
  const key = process.env[selection.keyEnv];
  if (!key) throw Error(`API key environment variable ${selection.keyEnv} is not set on this machine`);
  const response = await fetch(selection.baseUrl + path, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
  const text = await response.text();
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw Error('Model API response exceeds the limit');
  let body; try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok) {
    const message = body?.error?.message || body?.message || text.slice(0, 500) || response.statusText;
    throw Error(`Model API ${response.status === 401 || response.status === 403 ? 'authentication failed' : 'request failed'} (${response.status}): ${message}`);
  }
  if (!body) throw Error('Model API returned invalid JSON');
  return body;
}
// Real connectivity check against the configured endpoint and key.
export async function apiReadiness(selection) {
  const listing = await apiFetch(selection, '/models');
  const ids = Array.isArray(listing.data) ? listing.data.map(entry => entry.id) : [];
  if (ids.length && !ids.includes(selection.model)) throw Error(`Model API does not list model ${selection.model}`);
  return { ready: true, authMode: 'api' };
}

async function inside(root, path, { create = false } = {}) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw Error('A relative path is required');
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(root + sep)) throw Error('Path is outside the workspace');
  const rel = relative(root, target);
  if (rel.split(sep)[0] === '.git') throw Error('The Git directory is not editable');
  let existing = target;
  while (true) {
    try { const real = await realpath(existing); if (real !== root && !real.startsWith(root + sep)) throw Error('Path resolves outside the workspace'); break; }
    catch (error) { if (error.code !== 'ENOENT' || !create) { if (error.code === 'ENOENT') throw Error(`No such file: ${rel}`); throw error; } existing = dirname(existing); }
  }
  return target;
}
function runShell(cwd, commandLine, timeoutMs, signal, keyEnv) {
  return new Promise(accept => {
    const env = { ...process.env, NO_COLOR: '1', PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}` };
    delete env[keyEnv];
    const child = spawn('/bin/sh', ['-c', commandLine], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', done = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } };
    const timer = setTimeout(() => { output += '\n[command timed out]'; kill(); }, timeoutMs);
    const abort = () => { output += '\n[run cancelled]'; kill(); };
    signal.addEventListener('abort', abort, { once: true });
    const append = data => { if (output.length < 400000) output += data; };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const finish = code => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); kill(); accept({ code, output }); };
    child.once('error', error => finish(127, output += String(error.message)));
    child.once('close', code => finish(code ?? 1));
  });
}
const fn = (name, description, properties, required = Object.keys(properties)) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
const str = description => ({ type: 'string', description });

// Runs one planning or development job through a tool-calling loop. It returns
// the same { result, tests, agentSession } contract as the Codex runner.
export async function runApi({ config, cwd, directory, schema, prompt, sandbox, timeoutMs, signal, event }) {
  const selection = await apiSelection(config.api, config.workspace);
  Object.defineProperty(config, 'runtimeSecrets', { value: [process.env[selection.keyEnv]].filter(Boolean), writable: true, configurable: true });
  await privateDirectory(directory);
  const root = await realpath(cwd), writable = sandbox === 'workspace-write';
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const receipts = [], session = `api-${randomUUID()}`;
  const tools = [
    fn('list_files', 'List files (Git-tracked and untracked, not ignored) under a directory of the workspace.', { path: str('Relative directory, "." for the root') }),
    fn('read_file', 'Read a UTF-8 file from the workspace.', { path: str('Relative file path') }),
    fn('search', 'Search workspace text with ripgrep; returns matching lines.', { pattern: str('Regular expression'), path: str('Relative directory or file, "." for all') }),
    ...(writable ? [
      fn('write_file', 'Create or replace a UTF-8 file in the workspace.', { path: str('Relative file path'), content: str('Complete new file content') }),
      fn('replace_in_file', 'Replace one exact unique occurrence of text in a workspace file.', { path: str('Relative file path'), old: str('Exact existing text'), new: str('Replacement text') }),
      fn('run_command', 'Run a shell command in the workspace root (tests, builds, git status). Network, pushing and publishing are not permitted.', { command: str('Shell command') }),
    ] : []),
    { type: 'function', function: { name: 'submit_result', description: 'Submit the final structured result as the arguments object; ends the task.', parameters: schema } },
  ];
  const system = `You are an autonomous coding agent operating through tools in the repository at the workspace root. ${writable ? 'You may edit files inside the workspace and run commands there.' : 'This is read-only: inspect files but change nothing.'} Paths are relative to the workspace root. Finish by calling submit_result exactly once with the result object matching its schema. Do not reply with plain text instead of tools.`;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  const transcript = join(directory, 'api-transcript.jsonl');
  await writeFile(transcript, '', { mode: 0o600 });
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (deadline.aborted) throw Error(signal.aborted ? String(signal.reason?.message || signal.reason || 'Run cancelled') : 'Model API execution timed out');
    const body = { model: selection.model, messages, tools, tool_choice: 'auto', ...(selection.reasoning ? { reasoning_effort: selection.reasoning } : {}) };
    const response = await apiFetch(selection, '/chat/completions', { method: 'POST', body: JSON.stringify(body) }, deadline, timeoutMs);
    const message = response.choices?.[0]?.message;
    if (!message) throw Error('Model API returned no message');
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    messages.push({ role: 'assistant', content: message.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
    await writeFile(transcript, JSON.stringify({ turn, content: redact(message.content || '', config, 4000), tools: calls.map(call => call.function?.name) }) + '\n', { flag: 'a' });
    if (!calls.length) { messages.push({ role: 'user', content: 'Continue using tools. When finished, call submit_result with the final result.' }); continue; }
    for (const call of calls) {
      let output;
      try {
        let args;
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { throw Error('Tool arguments are not valid JSON'); }
        const name = call.function?.name;
        if (name === 'submit_result') {
          const result = args.result && typeof args.result === 'object' && !schema.properties.result ? args.result : args;
          const shaped = conform(schema, result, 'result');
          await writeFile(join(directory, 'result.json'), JSON.stringify(shaped), { mode: 0o600 });
          return { result: shaped, tests: receipts, agentSession: session };
        }
        output = await execute(name, args);
      } catch (error) { output = `Error: ${redact(error, config, 2000)}`; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: String(output).slice(0, MAX_READ) });
    }
  }
  throw Error(`Model did not submit a result within ${MAX_TURNS} turns`);

  async function execute(name, args) {
    if (name === 'list_files') {
      const base = await inside(root, args.path || '.');
      const result = await runShell(root, `git ls-files --cached --others --exclude-standard -- ${JSON.stringify(relative(root, base) || '.')} | head -2000`, 15000, deadline, selection.keyEnv);
      if (result.output.trim()) return result.output;
      return (await readdir(base)).join('\n');
    }
    if (name === 'read_file') {
      const file = await inside(root, args.path);
      if (!(await lstat(file)).isFile()) throw Error('Not a regular file');
      const text = await readFile(file, 'utf8');
      return text.length > MAX_READ ? text.slice(0, MAX_READ) + '\n[truncated]' : text;
    }
    if (name === 'search') {
      const base = await inside(root, args.path || '.');
      const result = await runShell(root, `rg -n --max-count 50 --max-columns 300 -e ${shellQuote(String(args.pattern || ''))} -- ${shellQuote(relative(root, base) || '.')} | head -400`, 20000, deadline, selection.keyEnv);
      return result.output || 'No matches';
    }
    if (!writable) throw Error(`Tool ${name} is unavailable in read-only mode`);
    if (name === 'write_file') {
      if (typeof args.content !== 'string') throw Error('content must be a string');
      const file = await inside(root, args.path, { create: true });
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, args.content);
      return `Wrote ${relative(root, file)} (${Buffer.byteLength(args.content)} bytes)`;
    }
    if (name === 'replace_in_file') {
      const file = await inside(root, args.path);
      const text = await readFile(file, 'utf8');
      const count = typeof args.old === 'string' && args.old ? text.split(args.old).length - 1 : 0;
      if (count !== 1) throw Error(`old text must occur exactly once (found ${count})`);
      await writeFile(file, text.replace(args.old, () => String(args.new ?? '')));
      return `Updated ${relative(root, file)}`;
    }
    if (name === 'run_command') {
      const commandLine = String(args.command || '');
      if (!commandLine.trim()) throw Error('command is required');
      if (/\bgit\s+(?:push|remote|config)\b|\bnpm\s+publish\b/.test(commandLine)) throw Error('Pushing, publishing and Git configuration changes are not permitted');
      await event?.('agent', `Command started: ${redact(commandLine, config, 300)}`);
      const result = await runShell(root, commandLine, Math.min(600000, timeoutMs), deadline, selection.keyEnv);
      const output = redact(result.output, config, MAX_OUTPUT);
      if (TEST_COMMAND.test(commandLine)) {
        receipts.push({ command: redact(commandLine, config), exitCode: result.code, output });
        await event?.('checking', `Test command finished (${result.code}): ${redact(commandLine, config, 300)}`);
      }
      return `exit code ${result.code}\n${output}`;
    }
    throw Error(`Unknown tool ${name}`);
  }
}
// Codex enforces strict schema output; API models do not, so keep exactly the
// declared fields and report type mismatches back to the model for repair.
function conform(schema, value, path) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${path} must be an object`);
    const missing = schema.required.filter(key => value[key] === undefined);
    if (missing.length) throw Error(`${path} is missing required fields: ${missing.join(', ')}`);
    return Object.fromEntries(Object.keys(schema.properties).map(key => [key, conform(schema.properties[key], value[key], `${path}.${key}`)]));
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw Error(`${path} must be an array`);
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw Error(`${path} must have ${schema.minItems}-${schema.maxItems} items`);
    return value.map((item, index) => conform(schema.items, item, `${path}[${index}]`));
  }
  if (schema.type === 'string') {
    if (value === null) return '';
    if (typeof value !== 'string') throw Error(`${path} must be a string`);
    return value;
  }
  return value;
}
function shellQuote(value) { return `'${value.replace(/'/g, `'\\''`)}'`; }
