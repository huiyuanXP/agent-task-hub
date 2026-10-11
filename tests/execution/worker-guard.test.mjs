import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/database.mts';
import { createAccount, issueToken, revokeToken } from '../../lib/local-auth.mts';
import { createRun } from '../../lib/execution/runs.mts';
import { provisionWorker, revokeWorker } from '../../lib/execution/workers.mts';
import { resolveWorkerIssuer, authenticateWorkerHeaders } from '../../lib/execution/worker-auth.mts';
import { guardedIssuerDatabase, guardedWorkerDatabase } from '../../lib/execution/worker-guard.mts';

const origin = 'http://127.0.0.1:5173';
const denied = error => error.status === 403 && error.code === 'AUTHORIZATION_DENIED';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-guard-'));
  const file = join(directory, 'data.sqlite');
  const db = openDatabase(file);
  const other = openDatabase(file);
  t.after(() => { other.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = await createAccount(db, { username: 'guard', displayName: 'Synthetic Guard', password: 'synthetic-password' });
  const token = await issueToken(db, owner.userId, { kind: 'api' });
  const issuer = await resolveWorkerIssuer(db, new Headers({ host: new URL(origin).host, authorization: `Bearer ${token.token}` }), 'POST', origin);
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind('guard-ticket', owner.userId, 'ticket', JSON.stringify({ title: 'Guard fixture', project: 'Synthetic' }), 1, now, now).run();
  const run = await createRun(db, { owner: owner.userId, actor: owner.userId }, { ticketId: 'guard-ticket', expectedRevision: 1, requestId: 'guard-run', authorizationId: 'synthetic-authorization', attempt: 1 });
  const secret = randomBytes(32).toString('base64url');
  const worker = await provisionWorker(db, issuer, { credentialId: randomUUID(), requestId: 'guard-worker', runId: run.id, verifier: hash(secret), label: 'Synthetic guard' });
  const principal = await authenticateWorkerHeaders(db, new Headers({ host: new URL(origin).host, authorization: `Bearer athw1.${worker.credentialId}.${secret}` }), 'POST', origin);
  await db.prepare('CREATE TABLE guard_domain(id TEXT PRIMARY KEY, value INTEGER NOT NULL)').run();
  await db.prepare('INSERT INTO guard_domain VALUES (?,?)').bind('counter', 0).run();
  const value = async () => (await db.prepare('SELECT value FROM guard_domain WHERE id=?').bind('counter').first()).value;
  const noChecks = async () => assert.equal((await db.prepare('SELECT count(*) AS n FROM execution_worker_checks').first()).n, 0);
  return { db, other, issuer, principal, worker, token: token.token, value, noChecks };
}

test('native prepare/bind/run and same-wrapper batch preserve result ordering and leave no check rows', async t => {
  const f = await fixture(t), guarded = guardedWorkerDatabase(f.db, f.principal);
  const update = guarded.prepare('UPDATE guard_domain SET value=value+? WHERE id=?');
  assert.equal((await update.bind(2, 'counter').run()).meta.changes, 1);
  const results = await guarded.batch([update.bind(3, 'counter'), guarded.prepare('INSERT INTO guard_domain VALUES (?,?)').bind('second', 9)]);
  assert.deepEqual(results.map(result => result.meta.changes), [1, 1]);
  assert.equal(await f.value(), 5);
  assert.equal((await guarded.prepare('SELECT value FROM guard_domain WHERE id=?').bind('second').first()).value, 9);
  assert.equal((await guarded.prepare('SELECT id FROM guard_domain').all()).results.length, 2);
  await f.noChecks();
});

test('concurrent wrappers on the native handle serialize complete guarded transactions', async t => {
  const f = await fixture(t);
  const wrappers = Array.from({ length: 12 }, (_, n) => n % 2 ? guardedIssuerDatabase(f.db, f.issuer) : guardedWorkerDatabase(f.db, f.principal));
  await Promise.all(wrappers.map(db => db.prepare('UPDATE guard_domain SET value=value+1 WHERE id=?').bind('counter').run()));
  assert.equal(await f.value(), 12);
  await f.noChecks();
});

test('raw, foreign-wrapper and mixed-handle statements cannot enter a guarded transaction', async t => {
  const f = await fixture(t), guarded = guardedWorkerDatabase(f.db, f.principal);
  const sql = 'UPDATE guard_domain SET value=value+1 WHERE id=?';
  for (const foreign of [f.db.prepare(sql).bind('counter'), guardedWorkerDatabase(f.db, f.principal).prepare(sql).bind('counter'), guardedWorkerDatabase(f.other, f.principal).prepare(sql).bind('counter')]) {
    await assert.rejects(guarded.batch([guarded.prepare(sql).bind('counter'), foreign]), denied);
  }
  assert.equal(await f.value(), 0);
  await f.noChecks();
});

test('revocation immediately before an already prepared mutation denies it without changing the domain', async t => {
  const f = await fixture(t), guarded = guardedWorkerDatabase(f.db, f.principal);
  const prepared = guarded.prepare('UPDATE guard_domain SET value=99 WHERE id=?').bind('counter');
  await revokeWorker(f.db, f.issuer, { credentialId: f.worker.credentialId, requestId: 'guard-revoke' });
  await assert.rejects(prepared.run(), denied);
  await assert.rejects(guarded.prepare('SELECT value FROM guard_domain').first(), denied);
  assert.equal(await f.value(), 0);
  await f.noChecks();
});

for (const lifecycle of ['revoke', 'expire']) test(`issuer ${lifecycle} after initial authentication denies prepared issuer and worker writes`, async t => {
  const f = await fixture(t);
  const issuerWrite = guardedIssuerDatabase(f.db, f.issuer).prepare('UPDATE guard_domain SET value=1 WHERE id=?').bind('counter');
  const workerWrite = guardedWorkerDatabase(f.db, f.principal).prepare('UPDATE guard_domain SET value=2 WHERE id=?').bind('counter');
  if (lifecycle === 'revoke') await revokeToken(f.db, f.token);
  else await f.db.prepare('UPDATE local_tokens SET expires_at=? WHERE token_hash=?').bind(Date.now() - 1, f.issuer.issuerTokenHash).run();
  await assert.rejects(issuerWrite.run(), denied);
  await assert.rejects(workerWrite.run(), denied);
  assert.equal(await f.value(), 0);
  await f.noChecks();
});

for (const invalidation of ['worker', 'issuer']) test(`post-check rolls back ${invalidation} invalidation and every domain write in the same native transaction`, async t => {
  const f = await fixture(t), guarded = guardedWorkerDatabase(f.db, f.principal);
  const invalidate = invalidation === 'worker'
    ? guarded.prepare('UPDATE execution_worker_credentials SET revoked_at=?,revoke_request_id=? WHERE credential_id=?').bind(Date.now(), 'in-transaction-revoke', f.worker.credentialId)
    : guarded.prepare('DELETE FROM local_tokens WHERE token_hash=?').bind(f.issuer.issuerTokenHash);
  await assert.rejects(guarded.batch([invalidate, guarded.prepare('UPDATE guard_domain SET value=9 WHERE id=?').bind('counter')]), denied);
  assert.equal(await f.value(), 0);
  assert.equal((await f.db.prepare('SELECT revoked_at FROM execution_worker_credentials WHERE credential_id=?').bind(f.worker.credentialId).first()).revoked_at, null);
  assert.ok(await f.db.prepare('SELECT token_hash FROM local_tokens WHERE token_hash=?').bind(f.issuer.issuerTokenHash).first());
  await f.noChecks();
});

test('a later native SQL constraint failure rolls back multiple mutations and authorization checks', async t => {
  const f = await fixture(t), guarded = guardedWorkerDatabase(f.db, f.principal);
  await assert.rejects(guarded.batch([
    guarded.prepare('UPDATE guard_domain SET value=7 WHERE id=?').bind('counter'),
    guarded.prepare('INSERT INTO guard_domain VALUES (?,?)').bind('new', 3),
    guarded.prepare('INSERT INTO guard_domain VALUES (?,?)').bind('counter', 5),
  ]), /UNIQUE constraint failed/);
  assert.equal(await f.value(), 0);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM guard_domain').first()).n, 1);
  await f.noChecks();
});

test('first/all cannot write through RETURNING, writable CTEs or leading SQL comments', async t => {
  const f = await fixture(t), guarded = guardedWorkerDatabase(f.db, f.principal);
  for (const sql of ["UPDATE guard_domain SET value=1 RETURNING value", "WITH changed AS (SELECT 1) UPDATE guard_domain SET value=2 RETURNING value", "/* SELECT */ UPDATE guard_domain SET value=3 RETURNING value"]) {
    await assert.rejects(guarded.prepare(sql).first(), denied);
    await assert.rejects(guarded.prepare(sql).all(), denied);
  }
  assert.equal(await f.value(), 0);
  await f.noChecks();
});
