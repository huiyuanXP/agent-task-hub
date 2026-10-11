import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { localFixture, fixtureEnvironment } from '../local/fixture.mjs';
import { chromium } from '../browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from '../browser/network.mjs';

const directory = await mkdtemp(join(tmpdir(), 'hub-status-native-'));
const evidenceDirectory = resolve(process.env.TICKET_STATUS_EVIDENCE_DIR ?? '.local/status-evidence');
await mkdir(evidenceDirectory, { recursive: true });
let fixture, mcp, browser, page, browserEvidence, status = 'failed'; const pageErrors = []; const checks = [], secrets = [], observedErrors = [];
const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), String(text));
const pass = text => { checks.push(text); console.log('PASS:', text); };
async function command(executable, args, options = {}) {
  const child = spawn(executable, args, { env: fixtureEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.end(options.input ?? '');
  const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
  assert.equal(code, 0, redact(stderr)); return { stdout, stderr };
}
async function owner(path, body, name = 'alice') {
  const response = await fetch(fixture.origin + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + fixture[name + 'Token'], origin: fixture.origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
}
async function install(project, capabilities = ['read', 'submit', 'execute'], name = 'alice') {
  const invitation = await owner('/api/connectors', { action: 'invite', project, name: 'Native status test', capabilities }, name);
  secrets.push(invitation.code);
  const workspace = join(directory, 'workspace-' + secrets.length); await mkdir(workspace);
  await command('git', ['init', '--quiet', workspace]);
  await command(process.execPath, [resolve('connector/cli.mjs'), 'install', '--url', fixture.origin, '--workspace', workspace, '--code-stdin'], { input: invitation.code + '\n' });
  const file = join(workspace, '.agent-task-hub/connection.json'), config = JSON.parse(await readFile(file, 'utf8')); secrets.push(config.token);
  return { ...config, file };
}
function stdio(config) {
  const child = spawn(process.execPath, [config.runtime, 'mcp', '--config', config.file], { cwd: config.workspace, env: fixtureEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let sequence = 0, stderr = '';
  child.stderr.on('data', chunk => stderr += chunk);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const result = JSON.parse(line), waiting = pending.get(result.id); if (waiting) { pending.delete(result.id); clearTimeout(waiting.timer); waiting.accept(result); } });
  const closed = new Promise(accept => child.once('close', accept));
  return {
    async rpc(method, params = {}) {
      const id = ++sequence;
      return new Promise((accept, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('STDIO timed out: ' + method + ' ' + redact(stderr))); }, 15000);
        pending.set(id, { accept, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async close() { child.stdin.end(); await closed; lines.close(); for (const { timer } of pending.values()) clearTimeout(timer); },
  };
}
async function machine(config, name, args) {
  const response = await fetch(fixture.origin + '/api/connector/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return { httpStatus: response.status, ...await response.json() };
}
const update = input => mcp.rpc('tools/call', { name: 'update_ticket_status', arguments: input });
const result = response => { assert.equal(response.error, undefined); assert.equal(response.result.isError, false, JSON.stringify(response)); return response.result.structuredContent; };
const error = (response, expected) => { assert.equal(response.result.isError, true); assert.equal(response.result.structuredContent.error.status, expected); observedErrors.push({ transport: response.httpStatus === undefined ? 'stdio' : 'http', expectedStatus: expected, response }); };
const history = async id => (await fixture.db.prepare("SELECT body,revision FROM records WHERE kind='history' AND json_extract(body,'$.recordId')=? ORDER BY id").bind(id).all()).results;
async function ticket(title = 'Native status Ticket', project = 'Project A', extra = {}) {
  return owner('/api/records', { kind: 'ticket', title, project, status: 'todo', goal: 'Keep contract', scope: 'Existing declared scope', allowedActions: '仅规划', budget: '未授权', evidence: 'Previous receipt', ...extra });
}
try {
  fixture = await localFixture(); secrets.push(fixture.aliceToken, fixture.bobToken);
  const client = await install('Project A'), readonly = await install('Project A', ['read']), foreign = await install('Project A', ['submit'], 'bob'), other = await install('Project B', ['submit']);
  mcp = stdio(client);
  assert.equal((await mcp.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'native-status', version: '1' } })).result.protocolVersion, '2025-11-25');
  const tools = (await mcp.rpc('tools/list')).result.tools;
  assert.ok(tools.some(tool => tool.name === 'update_ticket_status'));
  assert.equal(tools.some(tool => /approve|accept|revoke/.test(tool.name)), false);
  const created = await ticket();
  browser = await launchRestrictedBrowser(chromium, [fixture.origin], { viewport: { width: 1440, height: 1050 } });
  page = await browser.context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(fixture.origin + '/signin?return_to=/', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('用户名').fill('alice'); await page.getByLabel('密码').fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '收集点子', exact: true }).waitFor();
  await page.getByRole('button', { name: /Ticket 看板/ }).click();
  const card = page.locator('[data-ticket-id="' + created.id + '"]');
  await card.waitFor(); assert.equal(await card.getAttribute('data-current-state'), 'todo');
  await page.screenshot({ path: join(evidenceDirectory, 'native-before-status.png'), fullPage: true });
  const actual = await command(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict';assert.equal(7*6,42);console.log('7*6=42 verified');"]);
  const input = { ticket_id: created.id, expected_revision: 1, request_id: 'native_status', status: 'done', evidence: 'Actual Node arithmetic check: ' + actual.stdout.trim() };
  const first = result(await update(input)); assert.deepEqual(first, { ticket_id: created.id, revision: 2, status: 'done' });
  const after = (await owner('/api/records')).records.find(r => r.id === created.id);
  assert.equal(after.evidence, 'Previous receipt\n\nActual Node arithmetic check: 7*6=42 verified'); assert.equal(after.goal, 'Keep contract'); assert.equal(after.allowedActions, '仅规划');
  const audit = await history(created.id); assert.equal(audit.length, 1); assert.equal(audit[0].revision, 1);
  await writeFile(join(evidenceDirectory, 'history-sample.json'), JSON.stringify({ revision: audit[0].revision, body: JSON.parse(audit[0].body) }, null, 2));
  assert.equal(JSON.parse(audit[0].body).snapshot.status, 'todo'); assert.equal(JSON.parse(audit[0].body).previousRevision, 1);
  assert.ok(!JSON.stringify(first).includes(client.token));
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Ticket 看板/ }).click();
  await page.locator('[data-board-target="done"]').locator('[data-ticket-id="' + created.id + '"]').waitFor();
  assert.equal(await card.getAttribute('data-current-state'), 'done');
  assert.equal(await page.locator('[data-board-target="todo"]').locator('[data-ticket-id="' + created.id + '"]').count(), 0);
  await page.screenshot({ path: join(evidenceDirectory, 'native-after-status.png'), fullPage: true });
  await card.getByRole('button', { name: '查看详情：Native status Ticket', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.locator('input,textarea,select').count(), 0);
  await dialog.getByText('Keep contract', { exact: true }).waitFor();
  await dialog.getByText('Existing declared scope', { exact: true }).waitFor();
  await dialog.getByText('Previous receipt\n\nActual Node arithmetic check: 7*6=42 verified', { exact: true }).waitFor();
  await dialog.getByText('手工跟进状态：已完成', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidenceDirectory, 'native-status-details.png'), fullPage: true });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await browser.flushNetworkEvidence();
  browserEvidence = { pageErrors, requestedExternalOrigins: browser.requestedExternal, networkPolicyErrors: browser.errors, blockedRequests: browser.blocked };
  assert.deepEqual(pageErrors, []); assert.deepEqual(browser.requestedExternal, []); assert.deepEqual(browser.errors, []);
  pass('real Chromium reload after native MCP write moves the Ticket to done and shows appended evidence plus unchanged goal/scope in read-only details');
  pass('installed native STDIO discovers submit-only status tool, writes real CAS history and appends the actual caller Node receipt without creating execution');
  for (const config of [foreign, other]) error(await machine(config, 'update_ticket_status', input), 404);
  assert.equal((await machine(readonly, 'update_ticket_status', input)).error.code, -32602);
  assert.equal((await fetch(fixture.origin + '/api/connector/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + fixture.aliceToken, 'content-type': 'application/json' }, body: '{}' })).status, 401);
  pass('real native endpoint denies owner token, read-only connector and cross-owner/project writes');
  assert.deepEqual(result(await update(input)), first);
  await owner('/api/records', { ...after, title: 'Owner updated title', id: after.id, kind: 'ticket', revision: after.revision });
  assert.deepEqual(result(await update(input)), first);
  error(await update({ ...input, evidence: 'Changed retry' }), 409);
  error(await update({ ...input, request_id: 'native_stale_revision' }), 409);
  assert.equal((await history(created.id)).length, 2);
  pass('idempotent replay returns original revision after later owner edit; changed parameters return semantic 409 without new history');

  const concurrent = await ticket('Concurrent STDIO Ticket');
  const same = { ...input, ticket_id: concurrent.id, request_id: 'native_concurrent' };
  const sameResults = await Promise.all([update(same), machine(client, 'update_ticket_status', same)]);
  assert.deepEqual(result(sameResults[0]), result(sameResults[1])); assert.equal((await history(concurrent.id)).length, 1);
  const competing = await ticket('Competing STDIO Ticket');
  const compete = { ...input, ticket_id: competing.id, request_id: 'native_compete' };
  const collisions = await Promise.all([update(compete), machine(client, 'update_ticket_status', { ...compete, request_id: 'native_compete_other' })]);
  assert.equal(collisions.filter(r => !r.result.isError).length, 1); error(collisions.find(r => r.result.isError), 409); assert.equal((await history(competing.id)).length, 1);
  const changed = await ticket('Changed input concurrent Ticket');
  const changedRequest = { ...input, ticket_id: changed.id, request_id: 'native_same_id_changed' };
  const changedInputs = await Promise.all([update(changedRequest), machine(client, 'update_ticket_status', { ...changedRequest, status: 'error' })]);
  assert.equal(changedInputs.filter(r => !r.result.isError).length, 1); error(changedInputs.find(r => r.result.isError), 409);
  assert.equal((await history(changed.id)).length, 1);
  pass('simultaneous real STDIO and HTTP retries return one stable receipt; competing revisions and changed inputs on the same request ID produce one CAS winner');

  const bounded = await ticket('Bounded UTF8 Ticket', 'Project A', { evidence: 'x'.repeat(11999) });
  const bound = { ...input, ticket_id: bounded.id, request_id: 'native_bounded' };
  error(await update({ ...bound, evidence: '你'.repeat(4001) }), 413);
  error(await update({ ...bound, evidence: 'x' }), 413);
  assert.equal((await history(bounded.id)).length, 0);
  assert.equal((await owner('/api/records')).records.find(r => r.id === bounded.id).evidence.length, 11999);
  pass('real STDIO rejects input and combined UTF8 overflow with semantic 413 and preserves all previous evidence');

  const held = await ticket('Active Run Ticket');
  const prepared = await owner('/api/workspace-runs', { action: 'prepare', ticketId: held.id, revision: 1, connectionId: client.connectionId, requestId: 'native_active', timeoutMs: 120000 });
  error(await update({ ...input, ticket_id: held.id, request_id: 'native_active_status' }), 409);
  const old = (await owner('/api/records')).records.find(r => r.id === held.id);
  const apiWrite = await fetch(fixture.origin + '/api/records', { method: 'POST', headers: { authorization: 'Bearer ' + fixture.aliceToken, origin: fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...old, kind: 'ticket', status: 'done', evidence: 'Caller result' }) });
  assert.equal(apiWrite.status, 409); assert.equal((await history(held.id)).length, 0);
  assert.equal((await owner('/api/workspace-runs?runId=' + prepared.run.id)).run.state, 'pending');
  pass('active Run blocks MCP and owner records API identically with 409 and no history or Run mutation');

  await fixture.db.prepare('UPDATE workspace_connections SET capabilities=? WHERE id=?').bind('["read","execute"]', client.connectionId).run();
  assert.equal((await update(input)).error.code, -32602);
  await fixture.db.prepare('UPDATE workspace_connections SET capabilities=? WHERE id=?').bind('["read","submit","execute"]', client.connectionId).run();
  await owner('/api/connectors', { action: 'revoke', connectionId: client.connectionId });
  assert.equal((await machine(client, 'update_ticket_status', input)).httpStatus, 401);
  assert.ok((await update(input)).error);
  assert.equal((await history(created.id)).length, 2);
  assert.equal((await fixture.db.prepare('SELECT count(*) n FROM execution_runs').first()).n, 0);
  pass('removed capability and revoked installed credential deny historical replay; only explicit test preparation created a pending workspace Run');
  status = 'passed';
} catch (failure) {
  await writeFile(join(evidenceDirectory, 'native-failure.txt'), redact(failure.stack ?? failure)); throw failure;
} finally {
  await writeFile(join(evidenceDirectory, 'protocol-errors.json'), JSON.stringify(observedErrors, null, 2));
  await writeFile(join(evidenceDirectory, 'native-evidence.json'), JSON.stringify({ status, checks, source: 'real installed native CLI/STDIO/loopback HTTP/fresh SQLite; actual Node check; no model or provider credentials', realModel: false, browserEvidence }, null, 2));
  await mcp?.close(); await browser?.close(); await fixture?.close(); await rm(directory, { recursive: true, force: true });
}
