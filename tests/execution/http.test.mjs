import test from 'node:test';
import assert from 'node:assert/strict';
import { handleExecutionRequest } from '../../lib/execution/http.mts';
import { fixture, context, input } from './sqlite.mjs';
const origin = 'http://127.0.0.1:5197';
function write(body, headers = {}, path = '/api/execution') {
  return new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
// Removing auth/origin/schema limits or exposing arbitrary transitions breaks
// these observable HTTP responses against actual database state.
test('HTTP requires authentication and same-origin writes', async t => {
  const { db } = fixture(t);
  assert.equal((await handleExecutionRequest(db, null, new Request(origin + '/api/execution'))).status, 401);
  assert.equal((await handleExecutionRequest(db, context, write({ action: 'create', ...input }, { origin: 'https://foreign.example' }))).status, 403);
  const missing = write({ action: 'create', ...input }); missing.headers.delete('origin');
  assert.equal((await handleExecutionRequest(db, context, missing)).status, 403);
});
test('HTTP create/read/list/cancel uses server identity and frozen execution source', async t => {
  const { db, body } = fixture(t);
  const created = await handleExecutionRequest(db, context, write({ action: 'create', ...input }));
  assert.equal(created.status, 201);
  const { run } = await created.json();
  assert.equal(run.owner, 'owner-a'); assert.equal(run.actor, 'actor-a'); assert.equal(run.ticketBody, body);
  const read = await handleExecutionRequest(db, context, new Request(origin + '/api/execution?id=' + run.id));
  assert.equal((await read.json()).run.id, run.id); assert.equal(read.headers.get('cache-control'), 'no-store');
  const list = await handleExecutionRequest(db, context, new Request(origin + '/api/execution?state=queued&limit=1'));
  assert.equal((await list.json()).runs.length, 1);
  const cancelled = await handleExecutionRequest(db, context, write({ action: 'cancel', id: run.id, expectedVersion: 1 }));
  assert.equal((await cancelled.json()).run.state, 'cancelled');
});
test('HTTP maps revision/retry conflicts and foreign ownership explicitly', async t => {
  const { db } = fixture(t);
  assert.equal((await handleExecutionRequest(db, context, write({ action: 'create', ...input, expectedRevision: 2 }))).status, 409);
  const created = await handleExecutionRequest(db, context, write({ action: 'create', ...input }));
  const { run } = await created.json();
  assert.equal((await handleExecutionRequest(db, { owner: 'other', actor: 'other' }, new Request(origin + '/api/execution?id=' + run.id))).status, 404);
  assert.equal((await handleExecutionRequest(db, context, write({ action: 'create', ...input, attempt: 2 }))).status, 409);
});
test('HTTP rejects malformed JSON, arrays, null, unknown fields and transition/success actions', async t => {
  const { db } = fixture(t);
  for (const body of ['{', 'null', '[]', '"string"', '{}', { action: 'create', ...input, owner: 'other' },
    { action: 'create', ...input, state: 'running' }, { action: 'transition', to: 'succeeded', evidence: {} },
    { action: 'cancel', id: 'run', expectedVersion: 1, to: 'succeeded' }]) {
    assert.equal((await handleExecutionRequest(db, context, write(body))).status, 400);
  }
  assert.equal((await handleExecutionRequest(db, context, write('x', { 'content-type': 'text/plain' }))).status, 415);
});
test('HTTP body limit works with and without Content-Length and counts UTF-8 bytes', async t => {
  const { db } = fixture(t);
  assert.equal((await handleExecutionRequest(db, context, write('x', { 'content-length': '16385' }))).status, 413);
  assert.equal((await handleExecutionRequest(db, context, write('x'.repeat(16385)))).status, 413);
  assert.equal((await handleExecutionRequest(db, context, write('"' + '界'.repeat(5500) + '"'))).status, 413);
  assert.equal((await handleExecutionRequest(db, context, write('{}', { 'content-length': 'wrong' }))).status, 400);
});
test('HTTP rejects extra, repeated and malformed query fields and unsupported methods', async t => {
  const { db } = fixture(t);
  for (const query of ['?owner=other', '?id=a&id=b', '?id=a&state=queued', '?limit=NaN', '?limit=1.5', '?state=done', '?limit=101']) {
    assert.equal((await handleExecutionRequest(db, context, new Request(origin + '/api/execution' + query))).status, 400);
  }
  assert.equal((await handleExecutionRequest(db, context, new Request(origin + '/api/execution', { method: 'DELETE' }))).status, 405);
});
