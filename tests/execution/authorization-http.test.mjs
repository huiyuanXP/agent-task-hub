import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAuthorizationRequest } from '../../lib/execution/authorization-http.mts';
import { dispatchExecutionTool, executionTools } from '../../lib/execution/mcp.mts';
import { fixture, context } from './sqlite.mjs';
const origin = 'http://127.0.0.1:5197';
const owner = { ...context, grantAuthority: 'owner' };
const budget = { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 };
const post = (body, headers = {}) => new Request(origin + '/api/authorization', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = query => new Request(origin + '/api/authorization' + query);
test('authorization HTTP/MCP catalog, prepare, approve, read and revoke share exact persisted decisions', async t => {
  const { db } = fixture(t);
  const response = await handleAuthorizationRequest(db, owner, get('?ticketId=ticket-1&expectedRevision=1'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const catalog = await response.json();
  const input = { ticketId: 'ticket-1', expectedRevision: 1, requestId: 'http-1', attempt: 1, scope: catalog.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget, expiresAt: Date.now() + 60000 };
  const created = await handleAuthorizationRequest(db, owner, post({ action: 'prepare', ...input })); assert.equal(created.status, 201);
  const { authorization: auth } = await created.json();
  const approved = await dispatchExecutionTool(db, owner, 'decide_authorization', { authorizationId: auth.id, decisionId: 'approve-http', outcome: 'approved' });
  assert.equal(approved.effectiveStatus, 'approved');
  const read = await handleAuthorizationRequest(db, owner, get('?id=' + auth.id)); assert.equal((await read.json()).authorization.effectiveStatus, 'approved');
  const revoked = await handleAuthorizationRequest(db, owner, post({ action: 'revoke', authorizationId: auth.id, decisionId: 'revoke-http' })); assert.equal(revoked.status, 200);
  assert.equal((await dispatchExecutionTool(db, owner, 'get_authorization', { authorizationId: auth.id })).effectiveStatus, 'revoked');
  assert.ok(executionTools.some(tool => tool.name === 'get_operation_catalog'));
  assert.equal(await dispatchExecutionTool(db, owner, 'unknown_tool', {}), undefined);
});
test('HTTP enforces owner identity, same-origin, strict bodies/query and bounded JSON', async t => {
  const { db } = fixture(t);
  assert.equal((await handleAuthorizationRequest(db, null, get('?id=x'))).status, 401);
  assert.equal((await handleAuthorizationRequest(db, owner, post({}, { origin: 'https://foreign.test' }))).status, 403);
  for (const body of ['{', 'null', '[]', {}, { action: 'approve', owner: 'foreign' }, { action: 'revoke', authorizationId: 'x', decisionId: 'x', scope: [] }, { action: 'decide', authorizationId: 'x', decisionId: 'x', outcome: 'approved', grantAuthority: 'owner' }]) {
    assert.equal((await handleAuthorizationRequest(db, owner, post(body))).status, 400);
  }
  for (const query of ['', '?id=x&id=y', '?ticketId=x', '?ticketId=x&expectedRevision=NaN', '?id=x&owner=y', '?id=x&ticketId=y']) assert.equal((await handleAuthorizationRequest(db, owner, get(query))).status, 400);
  assert.equal((await handleAuthorizationRequest(db, owner, post('x', { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await handleAuthorizationRequest(db, owner, post('界'.repeat(6000)))).status, 413);
  assert.equal((await handleAuthorizationRequest(db, owner, post('{}', { 'content-length': 'invalid' }))).status, 400);
  assert.equal((await handleAuthorizationRequest(db, owner, post('{}', { 'content-length': '20000' }))).status, 413);
});
test('MCP runtime validation rejects invented authority, malformed arguments, widened approval and lease grant attempts', async t => {
  const { db } = fixture(t);
  for (const args of [null, [], 'x', { ticketId: 'ticket-1', expectedRevision: '1' }, { ticketId: 'ticket-1', expectedRevision: 1, owner: 'foreign' }]) await assert.rejects(dispatchExecutionTool(db, owner, 'get_operation_catalog', args));
  await assert.rejects(dispatchExecutionTool(db, owner, 'decide_authorization', { authorizationId: 'x', decisionId: 'x', outcome: 'approved', budget }));
  const catalog = await dispatchExecutionTool(db, owner, 'get_operation_catalog', { ticketId: 'ticket-1', expectedRevision: 1 });
  const result = await dispatchExecutionTool(db, owner, 'prepare_execution', { ticketId: 'ticket-1', expectedRevision: 1, requestId: 'mcp-1', attempt: 1, scope: [{ operationId: catalog.operations[0].operationId, definitionHash: catalog.operations[0].definitionHash }], budget, expiresAt: Date.now() + 60000 });
  await assert.rejects(dispatchExecutionTool(db, context, 'decide_authorization', { authorizationId: result.authorization.id, decisionId: 'lease-decision', outcome: 'approved' }), error => error.code === 'AUTHORIZATION_DENIED');
  await assert.rejects(dispatchExecutionTool(db, { ...owner, owner: 'foreign' }, 'get_authorization', { authorizationId: result.authorization.id }), error => error.code === 'NOT_FOUND');
});
test('MCP unexpected real storage failures expose a generic unavailable error and roll back', async t => {
  const { db, sqlite } = fixture(t);
  const catalog = await dispatchExecutionTool(db, owner, 'get_operation_catalog', { ticketId: 'ticket-1', expectedRevision: 1 });
  sqlite.exec("CREATE TRIGGER storage_fault BEFORE INSERT ON execution_authorizations BEGIN SELECT RAISE(ABORT,'private provider detail must not escape'); END");
  await assert.rejects(dispatchExecutionTool(db, owner, 'prepare_execution', { ticketId: 'ticket-1', expectedRevision: 1, requestId: 'failure-1', attempt: 1, scope: catalog.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget, expiresAt: Date.now() + 60000 }), error => {
    assert.equal(error.code, 'STORAGE_UNAVAILABLE'); assert.equal(error.status, 503); assert.equal(error.message, 'Execution storage unavailable'); return true;
  });
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM execution_runs').get().n, 0);
});
