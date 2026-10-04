import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as service from '../../lib/execution/authorization.mts';
import { getOperationCatalog, REGISTERED_OPERATIONS } from '../../lib/execution/catalog.mts';
import { fixture, context, sqliteAdapter } from './sqlite.mjs';
const owner = { ...context, grantAuthority: 'owner', now: 1800000000000 };
const budget = { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 };
async function prepared(db, overrides = {}) {
  const catalog = await getOperationCatalog(db, owner, { ticketId: 'ticket-1', expectedRevision: 1 });
  return service.prepareExecution(db, owner, { ticketId: 'ticket-1', expectedRevision: 1, requestId: 'prepare-1', attempt: 1,
    scope: catalog.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget, expiresAt: owner.now + 60000, ...overrides });
}
const decision = (id, outcome = 'approved', decisionId = 'decision-1') => ({ authorizationId: id, decisionId, outcome });
const code = expected => error => error.code === expected;
// Removing body/hash binding or replacing the real command with a placeholder fails these artifact assertions.
test('catalog binds frozen UTF-8 input, pinned image and real fixed Node artifact command', async t => {
  const { db, body } = fixture(t);
  const catalog = await getOperationCatalog(db, owner, { ticketId: 'ticket-1', expectedRevision: 1 });
  assert.equal(catalog.operations.length, 1);
  const operation = catalog.operations[0];
  assert.equal(operation.image, 'node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c');
  assert.equal(operation.inputs[0].path, 'input/ticket.json');
  assert.equal(operation.inputs[0].sha256, (await import('node:crypto')).createHash('sha256').update(body).digest('hex'));
  assert.equal(operation.policy.network, 'none'); assert.deepEqual(operation.policy.credentials, []);
  const cwd = mkdtempSync(join(tmpdir(), 'authorization-command-')); t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'input')); writeFileSync(join(cwd, 'input/ticket.json'), body);
  const result = spawnSync(process.execPath, operation.argv.slice(1), { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'output/result.json'), 'utf8')).ticketSha256, operation.inputs[0].sha256);
  writeFileSync(join(cwd, 'input/ticket.json'), '{}');
  assert.notEqual(spawnSync(process.execPath, operation.argv.slice(1), { cwd }).status, 0);
  await assert.rejects(getOperationCatalog(db, { ...owner, owner: 'foreign' }, { ticketId: 'ticket-1', expectedRevision: 1 }), code('NOT_FOUND'));
});
test('prepare freezes exact Run and pending grant atomically with input-sensitive retries', async t => {
  const { db, sqlite, body } = fixture(t); const result = await prepared(db);
  assert.equal(result.run.ticketBody, body); assert.equal(result.authorization.runId, result.run.id);
  assert.equal(result.authorization.id, result.run.authorizationId); assert.equal(result.authorization.effectiveStatus, 'pending');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM authorization_audit').get().n, 1);
  assert.equal((await prepared(db)).run.id, result.run.id);
  await assert.rejects(prepared(db, { budget: { ...budget, timeoutMs: 1000 } }), code('REQUEST_CONFLICT'));
  sqlite.prepare('UPDATE records SET revision=2,body=? WHERE id=?').run('{"title":"Changed"}', 'ticket-1');
  const retry = await preparedRetry(db, result.authorization); assert.equal(retry.run.id, result.run.id); assert.equal(retry.authorization.effectiveStatus, 'stale_revision');
});
async function preparedRetry(db, auth) { return service.prepareExecution(db, owner, { ticketId: 'ticket-1', expectedRevision: 1, requestId: 'prepare-1', attempt: 1, scope: auth.scope, budget, expiresAt: owner.now + 60000 }); }
test('failed grant insert rolls back Run; races return one Run and grant', async t => {
  const { db, sqlite, path } = fixture(t);
  sqlite.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON execution_authorizations BEGIN SELECT RAISE(ABORT,'injected storage failure'); END");
  await assert.rejects(prepared(db));
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM execution_runs').get().n, 0);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM execution_authorizations').get().n, 0);
  sqlite.exec('DROP TRIGGER fail_grant');
  const second = new DatabaseSync(path); t.after(() => second.close());
  const results = await Promise.all([prepared(db), prepared(db), prepared(sqliteAdapter(second))]);
  assert.equal(new Set(results.map(r => r.run.id)).size, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM execution_authorizations').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM authorization_audit').get().n, 1);
});
test('approval, duplicate/conflicting decisions, owner authority and immutable audit linkage', async t => {
  const { db, sqlite } = fixture(t); const { run, authorization: auth } = await prepared(db);
  const requested = { authorizationId: auth.id, runId: run.id, scope: auth.scope, budget };
  await assert.rejects(service.assertAuthorization(db, owner, requested), code('AUTHORIZATION_DENIED'));
  await assert.rejects(service.decideAuthorization(db, context, decision(auth.id)), code('AUTHORIZATION_DENIED'));
  await assert.rejects(service.decideAuthorization(db, { ...owner, owner: 'foreign' }, decision(auth.id)), code('NOT_FOUND'));
  const approved = await service.decideAuthorization(db, owner, decision(auth.id)); assert.equal(approved.effectiveStatus, 'approved');
  assert.equal((await service.decideAuthorization(db, owner, decision(auth.id))).effectiveStatus, 'approved');
  await assert.rejects(service.decideAuthorization(db, owner, decision(auth.id, 'rejected')), code('DECISION_CONFLICT'));
  await assert.rejects(service.decideAuthorization(db, owner, decision(auth.id, 'approved', 'other')), code('DECISION_CONFLICT'));
  assert.equal((await service.assertAuthorization(db, owner, requested)).id, auth.id);
  const audit = sqlite.prepare('SELECT * FROM authorization_audit ORDER BY rowid').all();
  assert.equal(audit.length, 2); assert.equal(audit[1].decision_id, 'decision-1'); assert.equal(audit[1].actor, 'actor-a'); assert.equal(audit[1].run_id, run.id);
  assert.deepEqual(JSON.parse(audit[1].scope), auth.scope); assert.deepEqual(JSON.parse(audit[1].budget), budget);
  assert.throws(() => sqlite.exec("UPDATE authorization_audit SET actor='forged'")); assert.throws(() => sqlite.exec('DELETE FROM authorization_audit'));
  assert.throws(() => sqlite.exec("UPDATE execution_authorizations SET scope='[]'"));
});
test('exclusive expiry, stale revision/definition, widened scope/budget and wrong Run are denied', async t => {
  const { db, sqlite } = fixture(t); const { run, authorization: auth } = await prepared(db);
  await service.decideAuthorization(db, owner, decision(auth.id));
  const requested = { authorizationId: auth.id, runId: run.id, scope: auth.scope, budget };
  await service.assertAuthorization(db, { ...owner, now: auth.expiresAt - 1 }, requested);
  await assert.rejects(service.assertAuthorization(db, { ...owner, now: auth.expiresAt }, requested), code('AUTHORIZATION_DENIED'));
  assert.equal((await service.getAuthorization(db, { ...owner, now: auth.expiresAt }, auth.id)).effectiveStatus, 'expired');
  for (const change of [{ runId: 'wrong' }, { scope: [...auth.scope, ...auth.scope] }, { scope: [{ ...auth.scope[0], definitionHash: 'a'.repeat(64) }] }, { budget: { ...budget, cpus: 2 } }]) {
    await assert.rejects(service.assertAuthorization(db, owner, { ...requested, ...change }));
  }
  // A real changed descriptor is injected at the trusted registry boundary, never by the caller.
  const changed = { ...owner, registry: [{ ...REGISTERED_OPERATIONS[0], image: 'node@sha256:' + 'a'.repeat(64) }] };
  assert.equal((await service.getAuthorization(db, changed, auth.id)).effectiveStatus, 'stale_definition');
  sqlite.prepare('UPDATE records SET revision=2 WHERE id=?').run('ticket-1');
  assert.equal((await service.getAuthorization(db, owner, auth.id)).effectiveStatus, 'stale_revision');
});
test('revocation is audited/idempotent and blocks effective authority; rejection never approves', async t => {
  const { db, sqlite } = fixture(t); const { authorization: auth } = await prepared(db);
  await service.decideAuthorization(db, owner, decision(auth.id));
  const revoke = { authorizationId: auth.id, decisionId: 'revoke-1' };
  assert.equal((await service.revokeAuthorization(db, owner, revoke)).effectiveStatus, 'revoked');
  await service.revokeAuthorization(db, owner, revoke);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM authorization_audit').get().n, 3);
  await assert.rejects(service.revokeAuthorization(db, owner, { ...revoke, decisionId: 'other' }), code('DECISION_CONFLICT'));
});
test('approval race records exactly one opposing decision and request validation is strict', async t => {
  const { db, sqlite, path } = fixture(t); const { authorization: auth } = await prepared(db);
  const second = new DatabaseSync(path); t.after(() => second.close());
  const results = await Promise.allSettled([service.decideAuthorization(db, owner, decision(auth.id)), service.decideAuthorization(sqliteAdapter(second), owner, decision(auth.id, 'rejected', 'reject-1'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM authorization_audit').get().n, 2);
  for (const value of [null, [], {}, { timeoutMs: 0, memoryMb: 256, cpus: 1, pids: 64 }, { ...budget, cpus: Infinity }, { ...budget, extra: 1 }, { ...budget, timeoutMs: 30001 }]) {
    await assert.rejects(prepared(db, { requestId: 'bad', budget: value }));
  }
});
test('scope key order is normalized; caller mutation cannot change frozen request or grant', async t => {
  const { db } = fixture(t);
  const catalog = await getOperationCatalog(db, owner, { ticketId: 'ticket-1', expectedRevision: 1 });
  const scope = [{ definitionHash: catalog.operations[0].definitionHash, operationId: catalog.operations[0].operationId }];
  const payload = { ticketId: 'ticket-1', expectedRevision: 1, requestId: 'prepare-1', attempt: 1, scope, budget: { ...budget }, expiresAt: owner.now + 60000 };
  const promise = service.prepareExecution(db, owner, payload);
  scope[0].operationId = 'forged'; payload.budget.timeoutMs = 1;
  const result = await promise; assert.equal(result.authorization.scope[0].operationId, 'ticket.validate.v1'); assert.equal(result.authorization.budget.timeoutMs, 30000);
  assert.equal((await preparedRetry(db, result.authorization)).run.id, result.run.id);
});
test('audit insert failure rolls approval back and owner-wide decision IDs cannot cross grants', async t => {
  const { db, sqlite } = fixture(t); const { authorization: auth } = await prepared(db);
  sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON authorization_audit WHEN NEW.kind='approved' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
  await assert.rejects(service.decideAuthorization(db, owner, decision(auth.id)));
  assert.equal((await service.getAuthorization(db, owner, auth.id)).status, 'pending');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM authorization_audit').get().n, 1);
  sqlite.exec('DROP TRIGGER fail_audit');
  await service.decideAuthorization(db, owner, decision(auth.id, 'rejected'));
  assert.equal((await service.getAuthorization(db, owner, auth.id)).effectiveStatus, 'rejected');
  sqlite.prepare('INSERT INTO records SELECT ?,owner,kind,body,revision,created,updated FROM records WHERE id=?').run('ticket-2', 'ticket-1');
  const catalog = await getOperationCatalog(db, owner, { ticketId: 'ticket-2', expectedRevision: 1 });
  const second = await service.requestAuthorization(db, owner, { ticketId: 'ticket-2', expectedRevision: 1, requestId: 'second-request', attempt: 1, scope: [{ operationId: catalog.operations[0].operationId, definitionHash: catalog.operations[0].definitionHash }], budget, expiresAt: owner.now + 60000 });
  await assert.rejects(service.decideAuthorization(db, owner, decision(second.authorization.id)), code('DECISION_CONFLICT'));
  assert.equal((await service.getAuthorization(db, owner, second.authorization.id)).status, 'pending');
});
test('cancelled Run cannot exercise its still-recorded approved grant', async t => {
  const { db } = fixture(t); const { authorization: auth, run } = await prepared(db);
  await service.decideAuthorization(db, owner, decision(auth.id));
  await (await import('../../lib/execution/runs.mts')).transitionRun(db, owner, { id: run.id, expectedVersion: 1, to: 'cancelled' });
  await assert.rejects(service.assertAuthorization(db, owner, { authorizationId: auth.id, runId: run.id, scope: auth.scope, budget }), code('AUTHORIZATION_DENIED'));
});
