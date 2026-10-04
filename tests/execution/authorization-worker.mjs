// Actual built Worker + fresh D1 and configured/bundled Chromium; loopback only.
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const base = 'http://127.0.0.1:5197';
let temporary, worker, browser;
const identity = { 'oai-authenticated-user-id': 'owner-local', 'oai-authenticated-user-email': 'owner-local@example.test' };
async function request(path, body, headers = {}) {
  const response = await fetch(base + path, { headers: { ...identity, ...(body === undefined ? {} : { origin: base, 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  let json; try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}
try {
  const tooling = process.env.EXECUTION_PLAYWRIGHT_MODULE ?? 'playwright';
  const moduleSpecifier = isAbsolute(tooling) || tooling.startsWith('.') ? pathToFileURL(resolve(tooling)).href : tooling;
  let chromium;
  try {
    ({ chromium } = await import(moduleSpecifier));
    if (typeof chromium?.launch !== 'function') throw Error('Module does not export Playwright chromium');
  } catch (cause) {
    throw new Error('Browser acceptance prerequisites unavailable: cannot load Playwright. Install Playwright 1.58.2 outside the repository, then set EXECUTION_PLAYWRIGHT_MODULE to its index.mjs path (or make import("playwright") resolvable). See docs/EXECUTION.md.', { cause });
  }
  try {
    if (process.env.EXECUTION_CHROMIUM_PATH) accessSync(process.env.EXECUTION_CHROMIUM_PATH, constants.X_OK);
    browser = await chromium.launch({ ...(process.env.EXECUTION_CHROMIUM_PATH ? { executablePath: process.env.EXECUTION_CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (cause) {
    throw new Error('Browser acceptance prerequisites unavailable: cannot launch Chromium. Install the Playwright Chromium browser using its CLI, or set EXECUTION_CHROMIUM_PATH to an installed executable. See docs/EXECUTION.md.', { cause });
  }
  // Resolve and launch browser prerequisites before creating any Worker/D1 state.
  temporary = mkdtempSync(join(tmpdir(), 'authorization-worker-'));
  const config = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
  worker = new Miniflare({ host: '127.0.0.1', port: 5197, modulesRoot: 'dist/server',
    modules: [config.main, ...readdirSync('dist/server', { recursive: true }).filter(path => /\.m?js$/.test(path) && path !== config.main)].map(path => ({ type: 'ESModule', path: join('dist/server', path) })),
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    d1Databases: { DB: '00000000-0000-4000-8000-000000000000' }, d1Persist: join(temporary, 'd1'),
    assets: { directory: 'dist/client', binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false } },
  });
  const db = await worker.getD1Database('DB');
  for (const migration of readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) for (const statement of readFileSync(join('drizzle', migration), 'utf8').split('--> statement-breakpoint').filter(sql => sql.trim())) await db.prepare(statement).run();
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind('ticket-local', 'owner-local', 'ticket', '{"title":"Browser authorization Ticket","status":"todo","project":"Synthetic"}', 1, now, now).run();
  await worker.ready;
  console.log('Worker/D1 ready; reading catalog');
  const catalog = await request('/api/authorization?ticketId=ticket-local&expectedRevision=1');
  assert.equal(catalog.status, 200, JSON.stringify(catalog));
  const input = { ticketId: 'ticket-local', expectedRevision: 1, requestId: 'worker-request', attempt: 1, scope: catalog.json.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 600000 };
  console.log('Catalog verified; preparing concurrent requests');
  const races = await Promise.all(Array.from({ length: 6 }, () => request('/api/authorization', { action: 'prepare', ...input })));
  assert.ok(races.every(r => r.status === 201), JSON.stringify(races)); assert.equal(new Set(races.map(r => r.json.run.id)).size, 1);
  const { authorization, run } = races[0].json;
  const count = async table => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
  assert.equal(await count('execution_authorizations'), 1); assert.equal(await count('execution_runs'), 1); assert.equal(await count('authorization_audit'), 1);
  assert.equal((await request('/api/authorization', { action: 'prepare', ...input, budget: { ...input.budget, timeoutMs: 1000 } })).status, 409);
  assert.equal((await request('/api/authorization?id=' + authorization.id, undefined, { 'oai-authenticated-user-id': 'foreign' })).status, 404);
  assert.equal((await request('/api/authorization', { action: 'decide', authorizationId: authorization.id, decisionId: 'forged', outcome: 'approved' }, { origin: 'https://foreign.test' })).status, 403);
  const rpc = async (name, args, headers) => request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers);
  const tools = await request('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  for (const name of ['create_idea', 'list_planning_jobs', 'get_idea', 'claim_planning_job', 'save_plan_and_tickets', 'get_operation_catalog', 'prepare_execution']) assert.ok(tools.json.result.tools.some(tool => tool.name === name));
  await db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind('idea-local', 'owner-local', 'idea', '{"title":"Synthetic planning regression","text":"Planning still works","project":"Synthetic"}', 1, now, now).run();
  const idea = await rpc('get_idea', { idea_id: 'idea-local' }); assert.equal(idea.json.result.structuredContent.title, 'Synthetic planning regression');
  const jobs = await rpc('list_planning_jobs', {}); assert.deepEqual(jobs.json.result.structuredContent.jobs, []);
  const approval = await rpc('decide_authorization', { authorizationId: authorization.id, decisionId: 'worker-approve', outcome: 'approved' });
  assert.equal(approval.json.result.structuredContent.effectiveStatus, 'approved');
  const replay = await rpc('decide_authorization', { authorizationId: authorization.id, decisionId: 'worker-approve', outcome: 'rejected' }); assert.equal(replay.json.error.data.code, 'DECISION_CONFLICT');
  const forged = await rpc('get_authorization', { authorizationId: authorization.id, grantAuthority: 'owner' }); assert.equal(forged.json.error.data.code, 'INVALID_INPUT');
  assert.equal((await rpc('revoke_authorization', { authorizationId: authorization.id, decisionId: 'cross-site' }, { origin: 'https://foreign.test' })).status, 403);
  await request('/api/execution', { action: 'cancel', id: run.id, expectedVersion: run.version });
  await db.prepare("CREATE TRIGGER storage_fault BEFORE INSERT ON execution_authorizations WHEN NEW.request_id='storage-failure' BEGIN SELECT RAISE(ABORT,'private provider detail must not escape'); END").run();
  const unavailable = await rpc('prepare_execution', { ...input, requestId: 'storage-failure', attempt: 2 });
  assert.equal(unavailable.json.error.data.status, 503); assert.equal(unavailable.json.error.data.code, 'STORAGE_UNAVAILABLE');
  assert.equal(unavailable.json.error.message, 'Execution storage unavailable');
  assert.equal(await count('execution_runs'), 1); assert.equal(await count('execution_authorizations'), 1);
  await db.prepare('DROP TRIGGER storage_fault').run();
  console.log('Worker/D1: catalog, concurrent atomic preparation, retries/conflicts, scope validation, same-origin, preserved planning tools, HTTP/MCP owner decisions and generic storage rollback passed');
  const page = await browser.newPage({ extraHTTPHeaders: identity });
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('button', { name: /Ticket 看板/ }).click();
  const panel = page.getByRole('region', { name: '执行授权' }); await panel.waitFor();
  await panel.getByRole('button', { name: '请求执行授权' }).click();
  await panel.getByText('pending', { exact: true }).waitFor();
  await page.reload(); await page.getByRole('button', { name: /Ticket 看板/ }).click();
  await panel.getByText('pending', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '批准授权' }).click(); await panel.getByText('approved', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '撤销授权' }).click(); await panel.getByText('revoked', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '取消 Run，允许重新申请' }).click();
  await panel.getByRole('button', { name: '请求执行授权' }).click(); await panel.getByText('pending', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '拒绝授权' }).click(); await panel.getByText('rejected', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '取消 Run，允许重新申请' }).click();
  assert.deepEqual(errors, []);
  assert.equal(await count('execution_runs'), 3); assert.equal(await count('execution_authorizations'), 3); assert.equal(await count('authorization_audit'), 7);
  if (process.env.EXECUTION_BROWSER_SCREENSHOT) await page.screenshot({ path: resolve(process.env.EXECUTION_BROWSER_SCREENSHOT), fullPage: true });
  console.log('Chromium UI: real catalog selection, persisted reload, pending → approve → revoke → cancel → new pending → reject → cancel passed; no page errors');
} finally {
  try { if (browser) await browser.close(); }
  finally {
    try { if (worker) await worker.dispose(); }
    finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
  }
}
