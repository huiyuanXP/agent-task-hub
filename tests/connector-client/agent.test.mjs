import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { redact } from '../../connector/common.mjs';

const root = resolve(import.meta.dirname, '../..'), cli = join(root, 'connector/cli.mjs');
function run(executable, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => accept({ code, stdout, stderr }));
    child.stdin.end(options.input || '');
  });
}
const syntheticSource = `import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
const args=process.argv.slice(2);
if(args[0]==='login') process.exit(0);
const option=name=>args[args.indexOf(name)+1];
const cwd=option('--cd');
writeFileSync(join(cwd,'synthetic-invocation.json'),JSON.stringify(args));
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const output=option('--output-last-message');
if(prompt.includes('WAIT_FOR_CANCEL')) {
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 writeFileSync(join(cwd,'synthetic-child-pid'),String(child.pid));
 setInterval(()=>{},1000);
} else if(option('--sandbox')==='read-only') {
 writeFileSync(output,JSON.stringify({plan:{title:'Synthetic plan',goal:'Fixture protocol',scope:'Planning only',acceptance:'Exact save',assumptions:'Synthetic'},tickets:[{key:'fixture',title:'Synthetic Ticket',goal:'Fixture',scope:'Local',acceptance:'Fixture',dependencies:'',assumptions:'Synthetic'}]}));
} else {
 writeFileSync(join(cwd,'README.md'),readFileSync(join(cwd,'README.md'),'utf8')+'actual isolated change\\n');
 const file=join(cwd,'change.test.mjs');writeFileSync(file,"import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('actual changed README',()=>assert.match(readFileSync(new URL('./README.md',import.meta.url),'utf8'),/actual isolated change/));");
 const receiptEnvironment={...process.env};delete receiptEnvironment.NODE_TEST_CONTEXT;
 const receipt=spawnSync(process.execPath,['--test','change.test.mjs'],{cwd,encoding:'utf8',env:receiptEnvironment});
 console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-session'}));
 console.log(JSON.stringify({type:'item.completed',item:{id:'real-test-process',type:'command_execution',command:'node --test change.test.mjs',exit_code:receipt.status,aggregated_output:receipt.stdout+receipt.stderr}}));
 writeFileSync(output,JSON.stringify({summary:'Synthetic model fixture changed README and ran an actual Node test'}));
}
`;
async function setup(t, { planning = false, stalePlanning = false, timeoutMs = 10000, leaseMs = 30000, wait = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ath-agent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await run('git', ['init', directory])).code, 0);
  await writeFile(join(directory, 'README.md'), 'original main workspace\n');
  await run('git', ['-C', directory, 'add', 'README.md']);
  assert.equal((await run('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Synthetic fixture'])).code, 0);
  const runner = join(directory, 'synthetic-codex.mjs');
  await writeFile(runner, syntheticSource);
  const requests = [];
  let claimed = false;
  const backend = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}'); requests.push({ path: request.url, body });
    response.setHeader('content-type', 'application/json');
    let value = {};
    if (request.url === '/api/connector/enroll') value = { token: 'synthetic-token', origin, connection: { id: 'synthetic-connection', projectId: 'synthetic-project', project: 'Synthetic project', capabilities: planning ? ['read', 'plan'] : ['read', 'execute'] } };
    else if (request.url === '/api/connector/agent') {
      if (body.action === 'claim') {
        value = { job: claimed ? null : { id: 'synthetic-run', leaseToken: 'synthetic-lease', ticketId: 'synthetic-ticket', revision: 1, body: { title: wait || timeoutMs < 2000 || leaseMs < 2000 ? 'WAIT_FOR_CANCEL' : 'Change README' }, timeoutMs, leaseExpiresAt: Date.now() + leaseMs } };
        claimed = true;
      } else if (body.action === 'renew') value = { leaseExpiresAt: Date.now() + leaseMs, cancelRequested: true };
    } else if (request.url === '/api/connector/mcp') {
      let data = {};
      if (body.params.name === 'list_planning_jobs') data = { jobs: [{ id: 'synthetic-plan-job', status: 'queued' }] };
      if (body.params.name === 'claim_planning_job') data = { job_id: 'synthetic-plan-job', claim_token: 'synthetic-planning-token', lease_expires: new Date(Date.now() + 600000).toISOString(), idea: { id: 'synthetic-idea', revision: 1, title: 'Synthetic idea' } };
      value = { jsonrpc: '2.0', id: body.id, result: { structuredContent: data, isError: false } };
      if (stalePlanning && ['save_plan_and_tickets', 'fail_planning_job'].includes(body.params.name)) value.result = { isError: true, content: [{ type: 'text', text: 'Planning claim expired or invalid' }] };
    }
    response.end(JSON.stringify(value));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const origin = `http://127.0.0.1:${backend.address().port}`;
  t.after(() => new Promise(accept => backend.close(accept)));
  const install = await run(process.execPath, [cli, 'install', '--url', origin, '--workspace', directory, '--code-stdin'], { input: 'synthetic-invite' });
  assert.equal(install.code, 0, install.stderr);
  const config = join(directory, '.agent-task-hub/connection.json');
  return { directory, runner, config, requests };
}
test('synthetic model process produces real Git worktree diff and actual test receipt without changing main workspace', async t => {
  const item = await setup(t);
  await writeFile(join(item.directory, 'README.md'), 'existing uncommitted owner edit\n');
  const result = await run(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once']);
  assert.equal(result.code, 0, result.stderr);
  const complete = item.requests.find(request => request.body.action === 'complete');
  assert.ok(complete, result.stderr);
  assert.match(complete.body.result.summary, /^\[synthetic test runner\]/);
  assert.match(complete.body.result.diff, /actual isolated change/);
  assert.ok(complete.body.result.files.includes('README.md'));
  assert.equal(complete.body.result.tests[0].exitCode, 0);
  assert.match(complete.body.result.tests[0].output, /pass 1/);
  assert.equal(await readFile(join(item.directory, 'README.md'), 'utf8'), 'existing uncommitted owner edit\n');
  const args = JSON.parse(await readFile(join(complete.body.result.worktree, 'synthetic-invocation.json'), 'utf8'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6.1-sol');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(!args.some(argument => argument.includes('dangerously')));
  assert.equal(item.requests.filter(request => request.body.action === 'complete').length, 1);
});
test('synthetic planning validates strict schema and saves exact existing claim contract', async t => {
  const item = await setup(t, { planning: true });
  const result = await run(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once']);
  assert.equal(result.code, 0, result.stderr);
  const saved = item.requests.find(request => request.body.params?.name === 'save_plan_and_tickets');
  assert.ok(saved, result.stderr);
  assert.equal(saved.body.params.arguments.job_id, 'synthetic-plan-job');
  assert.equal(saved.body.params.arguments.claim_token, 'synthetic-planning-token');
  assert.equal(saved.body.params.arguments.tickets.length, 1);
  assert.match(saved.body.params.arguments.plan.assumptions, /synthetic test runner/);
  const args = JSON.parse(await readFile(join(item.directory, 'synthetic-invocation.json'), 'utf8'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
});
test('finite development timeout stops managed process group before reporting failure', async t => {
  const item = await setup(t, { timeoutMs: 1100 });
  const result = await run(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once']);
  assert.equal(result.code, 0, result.stderr);
  const failed = item.requests.find(request => request.body.action === 'fail');
  assert.ok(failed, result.stderr);
  assert.match(failed.body.error, /timed out/);
  assert.equal(item.requests.filter(request => request.body.action === 'complete').length, 0);
  const { readdir } = await import('node:fs/promises');
  const path = join(item.directory, '.agent-task-hub/worktrees');
  const worktree = join(path, (await readdir(path))[0]);
  const pid = Number(await readFile(join(worktree, 'synthetic-child-pid'), 'utf8'));
  try {
    process.kill(pid, 0);
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z', 'Descendant must be dead, even if awaiting system reap');
  } catch (error) { assert.ok(['ESRCH', 'ENOENT'].includes(error.code)); }
});
test('lease expiry cancels managed model before completion and reports stopped failure', async t => {
  const item = await setup(t, { timeoutMs: 10000, leaseMs: 1100 });
  const result = await run(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once']);
  assert.equal(result.code, 0, result.stderr);
  const failed = item.requests.find(request => request.body.action === 'fail');
  assert.ok(failed, result.stderr);
  assert.match(failed.body.error, /lease expired/);
  assert.equal(item.requests.filter(request => request.body.action === 'complete').length, 0);
});
test('machine diagnostics remove raw and masked credential shapes', () => {
  const result = redact('Bearer private-secret; invalid sk-proj-abc****suffix; key private-secret', { token: 'private-secret' });
  assert.ok(!result.includes('private-secret'));
  assert.ok(!result.includes('sk-proj-'));
  assert.equal(redact('', {}), '');
});
test('owner cancellation from lease renewal stops the model and acknowledges failure', async t => {
  const item = await setup(t, { wait: true, timeoutMs: 20000 });
  const result = await run(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once']);
  assert.equal(result.code, 0, result.stderr);
  const renew = item.requests.find(request => request.body.action === 'renew');
  const failed = item.requests.find(request => request.body.action === 'fail');
  assert.ok(renew);
  assert.ok(failed, result.stderr);
  assert.match(failed.body.error, /Owner cancelled/);
  assert.equal(item.requests.filter(request => request.body.action === 'complete').length, 0);
});
test('daemon crash triggers supervisor stop and restart reconciles journal without duplicate model execution', async t => {
  const item = await setup(t, { wait: true, timeoutMs: 30000 });
  const child = spawn(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* Already reaped. */ } });
  const closed = once(child, 'close');
  const journalFile = join(item.directory, '.agent-task-hub/journal.json');
  let journal;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      journal = JSON.parse(await readFile(journalFile, 'utf8'));
      await readFile(join(journal.worktree, 'synthetic-child-pid'), 'utf8');
      if (journal.pid) break;
    } catch { /* Await durable identity and actual model start. */ }
    await new Promise(accept => setTimeout(accept, 30));
  }
  assert.ok(journal?.pid, 'Managed supervisor identity must be durable before crash');
  child.kill('SIGKILL');
  await closed;
  await new Promise(accept => setTimeout(accept, 1500));
  try {
    const stat = await readFile(`/proc/${journal.pid}/stat`, 'utf8');
    assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0], 'Z', 'Supervisor must stop after owning daemon exits');
  } catch (error) { assert.equal(error.code, 'ENOENT'); }
  const restarted = await run(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once']);
  assert.equal(restarted.code, 0, restarted.stderr);
  const failed = item.requests.filter(request => request.body.action === 'fail');
  assert.equal(failed.length, 1);
  assert.match(failed[0].body.error, /restarted.*without duplicate/);
  assert.equal(item.requests.filter(request => request.body.stage === 'agent').length, 1);
  assert.equal(item.requests.filter(request => request.body.action === 'complete').length, 0);
});
test('expired planning claim releases stopped local journal without blocking later daemon restart', async t => {
  const item = await setup(t, { planning: true, stalePlanning: true });
  const result = await run(process.execPath, [cli, 'agent', '--config', item.config, '--test-runner', item.runner, '--once']);
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(readFile(join(item.directory, '.agent-task-hub/journal.json'), 'utf8'), { code: 'ENOENT' });
});
