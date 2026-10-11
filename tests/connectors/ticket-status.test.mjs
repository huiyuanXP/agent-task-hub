import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/database.mts';
import { updateTicketStatus } from '../../lib/tickets/status-update.mts';
import { inviteConnector, enrollConnector, authenticateConnector, revokeConnector } from '../../lib/connectors/service.mts';
import { handleConnectorMCP } from '../../lib/connectors/mcp.mts';
import { prepareWorkspaceRun, decideWorkspaceRun, claimWorkspaceRun, failWorkspaceRun } from '../../lib/workspace-runs/service.mts';
import { createRun, transitionRun } from '../../lib/execution/runs.mts';
import { getOperationCatalog } from '../../lib/execution/catalog.mts';
import { prepareExecution, decideAuthorization } from '../../lib/execution/authorization.mts';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';

process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ticket-status-')), file = join(dir, 'test.sqlite'), db = openDatabase(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const owner of ['alice', 'bob']) await db.prepare('INSERT INTO local_users VALUES(?,?,?,?,?)').bind(owner, owner, owner, 'synthetic-unused', Date.now()).run();
  async function connection(owner = 'alice', project = 'Project A', capabilities = ['read', 'submit', 'execute']) {
    const invitation = await inviteConnector(db, owner, { action: 'invite', project, name: 'Synthetic client', capabilities });
    const installed = await enrollConnector(db, { code: invitation.code, name: 'Synthetic client', version: '1', workspace: 'Synthetic repo' });
    const headers = new Headers({ host: '127.0.0.1:5173', authorization: 'Bearer ' + installed.token, 'content-type': 'application/json' });
    return { ...installed, headers, principal: await authenticateConnector(db, headers) };
  }
  async function ticket(id = 'ticket', owner = 'alice', project = 'Project A', extra = {}) {
    const body = { title: 'Existing contract', project, status: 'todo', goal: 'Keep the goal', budget: '未授权', allowedActions: '仅规划', evidence: 'Existing check', ...extra };
    await db.prepare("INSERT INTO records(id,owner,kind,body,revision,created,updated) VALUES(?,?,'ticket',?,1,?,?)").bind(id, owner, JSON.stringify(body), '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z').run();
    return body;
  }
  const client = await connection(), original = await ticket();
  const input = { ticket_id: 'ticket', expected_revision: 1, request_id: 'status_request', status: 'done', evidence: 'Actual caller test receipt' };
  const history = async () => (await db.prepare("SELECT * FROM records WHERE kind='history' ORDER BY id").all()).results;
  const row = async () => db.prepare("SELECT * FROM records WHERE id='ticket'").first();
  return { db, file, client, connection, ticket, original, input, history, row };
}
const rejects = (promise, status) => assert.rejects(promise, e => e.status === status);
async function rpc(f, client, method, params = {}) {
  const response = await handleConnectorMCP(f.db, new Request(process.env.APP_ORIGIN + '/api/connector/mcp', { method: 'POST', headers: client.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
  return { status: response.status, ...await response.json() };
}

test('status writes preserve standard history, append caller evidence and return stable original result after later edits', async t => {
  const f = await fixture(t), input = { ...f.input };
  const first = await updateTicketStatus(f.db, f.client.principal, input);
  assert.deepEqual(first, { ticket_id: 'ticket', revision: 2, status: 'done' });
  const body = JSON.parse((await f.row()).body);
  assert.deepEqual(body, { ...f.original, status: 'done', evidence: 'Existing check\n\nActual caller test receipt' });
  const history = await f.history(); assert.equal(history.length, 1); assert.equal(history[0].revision, 1);
  const audit = JSON.parse(history[0].body);
  assert.deepEqual(audit.snapshot, f.original); assert.equal(audit.recordId, 'ticket'); assert.equal(audit.recordKind, 'ticket'); assert.equal(audit.previousRevision, 1);
  assert.equal(audit.statusUpdate.connectionId, f.client.principal.id); assert.ok(!history[0].body.includes(f.client.token));
  await updateTicketStatus(f.db, f.client.principal, { ...input, expected_revision: 2, request_id: 'later_request', status: 'todo', evidence: 'Reopened by caller' });
  assert.deepEqual(await updateTicketStatus(f.db, f.client.principal, input), first);
  assert.equal((await f.history()).length, 2); assert.equal((await f.row()).revision, 3);
  await rejects(updateTicketStatus(f.db, f.client.principal, { ...input, evidence: 'Changed receipt' }), 409);
  await rejects(updateTicketStatus(f.db, f.client.principal, { ...input, request_id: 'stale_request' }), 409);
  assert.equal((await f.history()).length, 2);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM workspace_runs').first()).n, 0);
  assert.equal((await f.db.prepare('SELECT count(*) n FROM execution_runs').first()).n, 0);
});

test('native MCP lists status updates only for submit and denies foreign owner/project or removed capability and revoked replays', async t => {
  const f = await fixture(t), foreign = await f.connection('bob'), otherProject = await f.connection('alice', 'Project B');
  for (const capabilities of [['read'], ['plan'], ['execute']]) {
    const client = await f.connection('alice', 'Project A', capabilities);
    assert.equal((await rpc(f, client, 'tools/list')).result.tools.some(tool => tool.name === 'update_ticket_status'), false);
    assert.equal((await rpc(f, client, 'tools/call', { name: 'update_ticket_status', arguments: f.input })).error.code, -32602);
    await rejects(updateTicketStatus(f.db, client.principal, f.input), 403);
  }
  const tool = (await rpc(f, f.client, 'tools/list')).result.tools.find(tool => tool.name === 'update_ticket_status');
  assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool.annotations.idempotentHint, true);
  for (const client of [foreign, otherProject]) await rejects(updateTicketStatus(f.db, client.principal, f.input), 404);
  const updated = await rpc(f, f.client, 'tools/call', { name: 'update_ticket_status', arguments: f.input });
  assert.equal(updated.result.isError, false); assert.deepEqual(Object.keys(updated.result.structuredContent).sort(), ['revision', 'status', 'ticket_id']);
  await f.db.prepare('UPDATE workspace_connections SET capabilities=? WHERE id=?').bind('["read","execute"]', f.client.principal.id).run();
  await rejects(updateTicketStatus(f.db, f.client.principal, f.input), 401);
  await f.db.prepare('UPDATE workspace_connections SET capabilities=? WHERE id=?').bind('["read","submit","execute"]', f.client.principal.id).run();
  await revokeConnector(f.db, 'alice', { action: 'revoke', connectionId: f.client.principal.id });
  await rejects(updateTicketStatus(f.db, f.client.principal, f.input), 401);
  assert.equal((await rpc(f, f.client, 'tools/call', { name: 'update_ticket_status', arguments: f.input })).status, 401);
  assert.equal((await f.history()).length, 1);
});

test('real concurrent database consumers CAS once, replay identically and reject conflicting use of a request_id', async t => {
  const f = await fixture(t), second = openDatabase(f.file); t.after(() => second.close());
  const attempts = await Promise.allSettled([updateTicketStatus(f.db, f.client.principal, f.input), updateTicketStatus(second, f.client.principal, { ...f.input, request_id: 'other_request' })]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.status, 409); assert.equal((await f.history()).length, 1);
  await f.ticket('parallel');
  const same = { ...f.input, ticket_id: 'parallel', request_id: 'parallel_same' };
  const identical = await Promise.all([updateTicketStatus(f.db, f.client.principal, same), updateTicketStatus(second, f.client.principal, same)]);
  assert.deepEqual(identical[0], identical[1]); assert.equal((await f.history()).length, 2);
  await f.ticket('parallel_conflict');
  const conflict = { ...same, ticket_id: 'parallel_conflict', request_id: 'parallel_changed' };
  const changed = await Promise.allSettled([updateTicketStatus(f.db, f.client.principal, conflict), updateTicketStatus(second, f.client.principal, { ...conflict, status: 'error' })]);
  assert.equal(changed.filter(r => r.status === 'fulfilled').length, 1); assert.equal(changed.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await f.history()).length, 3);
});

test('UTF-8 input and combined evidence/body bounds fail without truncation, with valid waiting and done rules', async t => {
  const f = await fixture(t);
  await rejects(updateTicketStatus(f.db, f.client.principal, { ...f.input, evidence: '你'.repeat(4001) }), 413);
  await f.ticket('large', 'alice', 'Project A', { evidence: 'x'.repeat(11999) });
  await rejects(updateTicketStatus(f.db, f.client.principal, { ...f.input, ticket_id: 'large', evidence: 'x' }), 413);
  assert.equal(JSON.parse((await f.db.prepare("SELECT body FROM records WHERE id='large'").first()).body).evidence.length, 11999);
  await f.ticket('body_bound', 'alice', 'Project A', { notes: '你'.repeat(30000) });
  await rejects(updateTicketStatus(f.db, f.client.principal, { ...f.input, ticket_id: 'body_bound' }), 413);
  await f.ticket('empty', 'alice', 'Project A', { evidence: '' });
  await rejects(updateTicketStatus(f.db, f.client.principal, { ...f.input, ticket_id: 'empty', evidence: '' }), 400);
  await rejects(updateTicketStatus(f.db, f.client.principal, { ...f.input, status: 'waiting', evidence: '' }), 400);
  assert.equal((await f.history()).length, 0);
  const waiting = await updateTicketStatus(f.db, f.client.principal, { ...f.input, status: 'waiting', waiting_reason: 'review', evidence: '' });
  assert.equal(waiting.status, 'waiting');
  assert.equal(JSON.parse((await f.row()).body).waitingReason, 'review');
  await updateTicketStatus(f.db, f.client.principal, { ...f.input, ticket_id: 'empty', request_id: 'utf8_boundary', evidence: '你'.repeat(4000) });
  assert.equal(Buffer.byteLength(JSON.parse((await f.db.prepare("SELECT body FROM records WHERE id='empty'").first()).body).evidence), 12000);
  await rejects(updateTicketStatus(f.db, f.client.principal, { ...f.input, owner: 'bob' }), 400);
});

test('workspace active and physical cancellation holds block changes; same-status evidence follows records API semantics', async t => {
  const f = await fixture(t), prepare = id => prepareWorkspaceRun(f.db, 'alice', { ticketId: id, revision: 1, connectionId: f.client.principal.id, requestId: 'run_' + id, timeoutMs: 120000 });
  const run = await prepare('ticket');
  await rejects(updateTicketStatus(f.db, f.client.principal, f.input), 409); assert.equal((await f.history()).length, 0);
  const same = await updateTicketStatus(f.db, f.client.principal, { ...f.input, status: 'todo', evidence: 'Evidence only; no status change' });
  assert.equal(same.revision, 2);
  assert.equal((await f.db.prepare('SELECT state FROM workspace_runs WHERE id=?').bind(run.id).first()).state, 'pending');

  await f.ticket('physical'); const physical = await prepare('physical');
  await decideWorkspaceRun(f.db, 'alice', physical.id, 'approve'); const { job } = await claimWorkspaceRun(f.db, f.client.principal); assert.equal(job.id, physical.id);
  await decideWorkspaceRun(f.db, 'alice', physical.id, 'cancel');
  const input = { ...f.input, ticket_id: 'physical', request_id: 'physical_status' };
  await rejects(updateTicketStatus(f.db, f.client.principal, input), 409); assert.equal((await f.history()).length, 1);
  await failWorkspaceRun(f.db, f.client.principal, physical.id, job.leaseToken, 'Synthetic process ended');
  assert.equal((await updateTicketStatus(f.db, f.client.principal, input)).status, 'done');
  assert.equal((await f.history()).length, 2);
});

test('Docker active state blocks status writes and a revocation immediately before transaction leaves no audit', async t => {
  const f = await fixture(t), context = { owner: 'alice', actor: 'alice' };
  const run = await createRun(f.db, context, { ticketId: 'ticket', expectedRevision: 1, requestId: 'docker_status', authorizationId: 'synthetic_grant', attempt: 1 });
  await rejects(updateTicketStatus(f.db, f.client.principal, f.input), 409); assert.equal((await f.history()).length, 0);
  await transitionRun(f.db, context, { id: run.id, expectedVersion: 1, to: 'cancelled' });
  let revoking = true;
  const racing = { ...f.db, async batch(statements) { if (revoking) { revoking = false; await revokeConnector(f.db, 'alice', { action: 'revoke', connectionId: f.client.principal.id }); } return f.db.batch(statements); } };
  await rejects(updateTicketStatus(racing, f.client.principal, f.input), 401);
  assert.equal((await f.history()).length, 0); assert.equal((await f.row()).revision, 1);
});


test('a real Docker domain permit holds a logically cancelled Ticket and transaction failures roll back history', async t => {
  const f = await fixture(t), owner = { owner: 'alice', actor: 'alice', grantAuthority: 'owner' };
  const { operations } = await getOperationCatalog(f.db, owner, { ticketId: 'ticket', expectedRevision: 1 });
  const prepared = await prepareExecution(f.db, owner, { ticketId: 'ticket', expectedRevision: 1, requestId: 'physical_docker', attempt: 1,
    scope: [{ operationId: operations[0].operationId, definitionHash: operations[0].definitionHash }], budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 60000 });
  await decideAuthorization(f.db, owner, { authorizationId: prepared.authorization.id, decisionId: 'approve', outcome: 'approved' });
  await createDispatchPermit(f.db, owner, prepared.run.id);
  await transitionRun(f.db, owner, { id: prepared.run.id, expectedVersion: 1, to: 'cancelled' });
  await rejects(updateTicketStatus(f.db, f.client.principal, f.input), 409);
  assert.equal((await f.history()).length, 0);
  assert.equal((await f.db.prepare('SELECT closed_at FROM execution_permits').first()).closed_at, null);
  await f.ticket('rollback');
  const broken = { ...f.db, batch(statements) { return f.db.batch([statements[0], f.db.prepare('INSERT INTO missing_table VALUES(1)'), statements[1]]); } };
  await assert.rejects(updateTicketStatus(broken, f.client.principal, { ...f.input, ticket_id: 'rollback', request_id: 'rollback' }), /missing_table/);
  assert.equal((await f.history()).length, 0);
  assert.equal((await f.db.prepare("SELECT revision FROM records WHERE id='rollback'").first()).revision, 1);
});


test('revocation racing a cached receipt read is denied and input is snapshotted before the first await', async t => {
  const f = await fixture(t), input = { ...f.input };
  const pending = updateTicketStatus(f.db, f.client.principal, input);
  input.status = 'error'; input.evidence = 'Mutated after invocation';
  const original = await pending; assert.equal(original.status, 'done');
  assert.equal(JSON.parse((await f.row()).body).evidence, 'Existing check\n\nActual caller test receipt');
  let revoke = true;
  const racing = { ...f.db, prepare(sql) {
    const wrap = statement => ({ bind(...values) { return wrap(statement.bind(...values)); },
      first: async () => { const result = await statement.first(); if (revoke && sql.includes("SELECT body FROM records WHERE id=?") && result) { revoke = false; await revokeConnector(f.db, 'alice', { action: 'revoke', connectionId: f.client.principal.id }); } return result; },
      all: () => statement.all(), run: () => statement.run() });
    return wrap(f.db.prepare(sql));
  } };
  await rejects(updateTicketStatus(racing, f.client.principal, f.input), 401);
  assert.equal((await f.history()).length, 1);
});


test('a matching request committed between receipt lookup and Ticket read still returns its stable result', async t => {
  const f = await fixture(t); let competed = false;
  const racing = { ...f.db, prepare(sql) {
    const wrap = statement => ({ bind(...values) { return wrap(statement.bind(...values)); },
      first: async () => { if (!competed && sql.startsWith('SELECT * FROM records WHERE')) { competed = true; await updateTicketStatus(f.db, f.client.principal, f.input); } return statement.first(); },
      all: () => statement.all(), run: () => statement.run() });
    return wrap(f.db.prepare(sql));
  } };
  assert.deepEqual(await updateTicketStatus(racing, f.client.principal, f.input), { ticket_id: 'ticket', revision: 2, status: 'done' });
  assert.equal((await f.history()).length, 1); assert.equal((await f.row()).revision, 2);
});


test('real expiry during a pre-batch delay or between history and CAS rolls back every write', async t => {
  for (const phase of ['before-batch', 'between-history-and-cas']) {
    const f = await fixture(t);
    if (phase === 'between-history-and-cas') await f.db.prepare(`CREATE TRIGGER status_expiry_delay AFTER INSERT ON records WHEN NEW.kind='history'
      BEGIN SELECT sum(x) FROM (WITH RECURSIVE delay(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM delay WHERE x<5000000) SELECT x FROM delay); END`).run();
    const expires = Date.now() + 250;
    await f.db.prepare('UPDATE workspace_connections SET token_expires_at=? WHERE id=?').bind(expires, f.client.principal.id).run();
    let reached = false;
    const delayed = { ...f.db, async batch(statements) {
      reached = true; assert.ok(Date.now() < expires, 'precheck and preparation completed while credential was live');
      if (phase === 'before-batch') await new Promise(resolve => setTimeout(resolve, Math.max(0, expires - Date.now()) + 30));
      return f.db.batch(statements);
    } };
    await rejects(updateTicketStatus(delayed, f.client.principal, f.input), 401);
    assert.equal(reached, true); assert.ok(Date.now() >= expires, 'real wall clock crossed expiry');
    assert.equal((await f.history()).length, 0, phase + ' must roll back receipt/history');
    assert.equal((await f.row()).revision, 1, phase + ' must preserve revision');
    assert.deepEqual(JSON.parse((await f.row()).body), f.original);
  }
});
