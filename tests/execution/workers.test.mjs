import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/database.mts';
import { createAccount, issueToken, resetPassword, revokeToken } from '../../lib/local-auth.mts';
import { createRun } from '../../lib/execution/runs.mts';
import { authenticateWorkerHeaders, resolveWorkerIssuer, workerAuthorizationPredicate } from '../../lib/execution/worker-auth.mts';
import { listWorkers, provisionWorker, revokeWorker } from '../../lib/execution/workers.mts';
const origin = 'http://127.0.0.1:5173';
const digest = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error.code === expected;
const authStatus = expected => error => error.status === expected;
function headers(token, overrides = {}) {
  return new Headers({ host: new URL(origin).host, authorization: 'Bearer ' + token, ...overrides });
}
function args(runId, overrides = {}) {
  const secret = randomBytes(32).toString('base64url'), credentialId = randomUUID();
  return { input: { credentialId, requestId: randomUUID(), runId, verifier: digest(secret), label: 'Synthetic test worker', ...overrides },
    token: 'athw1.' + credentialId + '.' + secret, secret };
}
async function fixture(t, tokenOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'execution-workers-')), path = join(dir, 'test.sqlite');
  const db = openDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const user = await createAccount(db, { username: 'test-owner', displayName: 'Synthetic owner', password: 'Synthetic-password-2026' });
  const issued = await issueToken(db, user.userId, { kind: 'api', ...tokenOptions });
  const issuer = await resolveWorkerIssuer(db, headers(issued.token), 'POST', origin);
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').bind('ticket-a', user.userId, 'ticket',
    JSON.stringify({ title: 'Synthetic test ticket', project: '测试项目' }), 3, now, now).run();
  const run = await createRun(db, { owner: user.userId, actor: user.userId }, {
    ticketId: 'ticket-a', expectedRevision: 3, requestId: 'synthetic-run', authorizationId: 'synthetic-permit', attempt: 2 });
  return { db, issuer, issued, user, run, path };
}
test('real local issuer freezes Run binding, bounded lifetime, and secret-free projections', async t => {
  const f = await fixture(t), a = args(f.run.id);
  const worker = await provisionWorker(f.db, f.issuer, a.input);
  assert.equal(worker.project, '测试项目'); assert.equal(worker.ticketRevision, 3); assert.equal(worker.attempt, 2);
  assert.equal(worker.authorizationId, 'synthetic-permit');
  assert.ok(worker.expiresAt <= worker.createdAt + 900000); assert.ok(worker.expiresAt <= f.issued.expiresAt);
  const principal = await authenticateWorkerHeaders(f.db, headers(a.token), 'POST', origin);
  assert.equal(principal.owner, f.user.userId); assert.equal(principal.issuerTokenHash, digest(f.issued.token));
  for (const result of [worker, await listWorkers(f.db, f.issuer), await revokeWorker(f.db, f.issuer, { credentialId: a.input.credentialId, requestId: 'revoke-safe' })]) {
    const serialized = JSON.stringify(result);
    for (const hidden of [a.secret, a.input.verifier, digest(f.issued.token), 'issuerTokenHash', 'verifier', 'input_key', 'issuer_token_hash']) assert.ok(!serialized.includes(hidden));
  }
  await assert.rejects(authenticateWorkerHeaders(f.db, headers(a.token), 'POST', origin), authStatus(401));
});
test('stable provision replay requires identical body and original issuer; revoked credential never revives', async t => {
  const f = await fixture(t), a = args(f.run.id);
  const first = await provisionWorker(f.db, f.issuer, a.input);
  assert.deepEqual(await provisionWorker(f.db, f.issuer, { ...a.input }), first);
  for (const change of [{ label: 'Changed' }, { credentialId: randomUUID() }, { verifier: '0'.repeat(64) }]) {
    await assert.rejects(provisionWorker(f.db, f.issuer, { ...a.input, ...change }), code('REQUEST_CONFLICT'));
  }
  const replacement = await issueToken(f.db, f.user.userId, { kind: 'api' });
  const anotherIssuer = await resolveWorkerIssuer(f.db, headers(replacement.token), 'POST', origin);
  await assert.rejects(provisionWorker(f.db, anotherIssuer, a.input), code('REQUEST_CONFLICT'));
  await revokeWorker(f.db, f.issuer, { credentialId: a.input.credentialId, requestId: 'revoke-one' });
  await assert.rejects(provisionWorker(f.db, f.issuer, a.input), code('AUTHORIZATION_DENIED'));
});
test('strict payload schema rejects spoofed identity/project, invalid verifier and ambiguous IDs', async t => {
  const f = await fixture(t), a = args(f.run.id);
  for (const extra of ['owner', 'actor', 'project', 'expiresAt', 'issuerTokenHash', 'ticketRevision', 'secret']) {
    await assert.rejects(provisionWorker(f.db, f.issuer, { ...a.input, [extra]: 'spoof' }), code('INVALID_INPUT'));
  }
  for (const change of [{ credentialId: 'uuid.with.dots' }, { credentialId: a.input.credentialId.toUpperCase() }, { verifier: 'g'.repeat(64) }, { verifier: 'a'.repeat(63) }, { label: ' ' }]) {
    await assert.rejects(provisionWorker(f.db, f.issuer, { ...a.input, ...change }), code('INVALID_INPUT'));
  }
  await assert.rejects(provisionWorker(f.db, f.issuer, { ...a.input, runId: 'foreign-run' }), code('NOT_FOUND'));
  await assert.rejects(listWorkers(f.db, f.issuer, { limit: 101 }), code('INVALID_INPUT'));
  await assert.rejects(listWorkers(f.db, f.issuer, { owner: 'spoof' }), code('INVALID_INPUT'));
});
test('native two-handle concurrent provision never exceeds sixteen active credentials', async t => {
  const f = await fixture(t), second = openDatabase(f.path); t.after(() => second.close());
  const attempts = Array.from({ length: 30 }, (_, i) => provisionWorker(i % 2 ? f.db : second, f.issuer, args(f.run.id).input));
  const outcomes = await Promise.allSettled(attempts);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 16);
  for (const rejected of outcomes.filter(x => x.status === 'rejected')) assert.equal(rejected.reason.code, 'AUTHORIZATION_DENIED');
  assert.equal((await listWorkers(f.db, f.issuer, { limit: 100 })).length, 16);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM execution_worker_checks').first()).count, 0);
  const first = (await listWorkers(f.db, f.issuer))[0];
  await revokeWorker(f.db, f.issuer, { credentialId: first.credentialId, requestId: 'capacity-release' });
  await provisionWorker(second, f.issuer, args(f.run.id).input);
});
test('revocation replays one owner-bound request and denies rebinding', async t => {
  const f = await fixture(t), a = args(f.run.id), b = args(f.run.id);
  await provisionWorker(f.db, f.issuer, a.input); await provisionWorker(f.db, f.issuer, b.input);
  const input = { credentialId: a.input.credentialId, requestId: 'stable-revoke' };
  const first = await revokeWorker(f.db, f.issuer, input);
  assert.deepEqual(await revokeWorker(f.db, f.issuer, input), first);
  await assert.rejects(revokeWorker(f.db, f.issuer, { ...input, requestId: 'changed-revoke' }), code('REQUEST_CONFLICT'));
  await assert.rejects(revokeWorker(f.db, f.issuer, { ...input, credentialId: b.input.credentialId }), code('REQUEST_CONFLICT'));
  await assert.rejects(revokeWorker(f.db, f.issuer, { ...input, credentialId: randomUUID() }), code('NOT_FOUND'));
});
test('local token revoke and password reset invalidate first machine read and owner management immediately', async t => {
  const f = await fixture(t), a = args(f.run.id);
  await provisionWorker(f.db, f.issuer, a.input); await revokeToken(f.db, f.issued.token);
  await assert.rejects(authenticateWorkerHeaders(f.db, headers(a.token), 'GET', origin), authStatus(401));
  await assert.rejects(listWorkers(f.db, f.issuer), code('AUTHORIZATION_DENIED'));
  const next = await issueToken(f.db, f.user.userId, { kind: 'api' });
  const issuer = await resolveWorkerIssuer(f.db, headers(next.token), 'POST', origin), b = args(f.run.id);
  await provisionWorker(f.db, issuer, b.input);
  await resetPassword(f.db, 'test-owner', 'Replacement-synthetic-password-2026');
  await assert.rejects(authenticateWorkerHeaders(f.db, headers(b.token), 'GET', origin), authStatus(401));
  await assert.rejects(provisionWorker(f.db, issuer, args(f.run.id).input), code('AUTHORIZATION_DENIED'));
});
test('natural issuer expiry caps Worker lifetime and cannot resurrect provision replay', async t => {
  const f = await fixture(t, { ttlSeconds: 60, now: Date.now() - 59000 }), a = args(f.run.id);
  const worker = await provisionWorker(f.db, f.issuer, a.input);
  assert.equal(worker.expiresAt, f.issued.expiresAt);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, f.issued.expiresAt - Date.now() + 30)));
  await assert.rejects(authenticateWorkerHeaders(f.db, headers(a.token), 'GET', origin), authStatus(401));
  await assert.rejects(provisionWorker(f.db, f.issuer, a.input), code('AUTHORIZATION_DENIED'));
});
test('machine parser rejects all cookies, local and connector namespaces, wrong secrets, exact Host/Origin violations', async t => {
  const f = await fixture(t), a = args(f.run.id); await provisionWorker(f.db, f.issuer, a.input);
  for (const override of [{ cookie: 'unrelated=value' }, { cookie: '' }, { cookie: 'hub_session=' + f.issued.token }]) {
    await assert.rejects(authenticateWorkerHeaders(f.db, headers(a.token, override), 'POST', origin), authStatus(401));
  }
  for (const token of [f.issued.token, 'athc1.' + randomBytes(32).toString('base64url'), a.token + '.extra', a.token.replace('athw1.', 'athw2.'), 'athw1.' + a.input.credentialId + '.' + randomBytes(32).toString('base64url')]) {
    await assert.rejects(authenticateWorkerHeaders(f.db, headers(token), 'GET', origin), authStatus(401));
  }
  for (const override of [{ host: 'localhost:5173' }, { host: '127.0.0.1:5173.evil' }, { origin: origin + '/' }, { origin: 'http://localhost:5173' }]) {
    await assert.rejects(authenticateWorkerHeaders(f.db, headers(a.token, override), 'POST', origin), authStatus(403));
  }
  const other = 'http://localhost:5173';
  await assert.rejects(authenticateWorkerHeaders(f.db, new Headers({ host: 'localhost:5173', authorization: 'Bearer ' + a.token }), 'GET', other), authStatus(401));
});
test('owner parser retains cookie/bearer conflict, kind, and native browser origin semantics', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveWorkerIssuer(f.db, headers(f.issued.token, { cookie: 'hub_session=' + f.issued.token }), 'GET', origin), authStatus(401));
  await assert.rejects(resolveWorkerIssuer(f.db, new Headers({ host: '127.0.0.1:5173', cookie: 'hub_session=' + f.issued.token }), 'GET', origin), authStatus(401));
  const browser = await issueToken(f.db, f.user.userId, { kind: 'browser' });
  const cookie = new Headers({ host: '127.0.0.1:5173', cookie: 'hub_session=' + browser.token });
  await resolveWorkerIssuer(f.db, cookie, 'GET', origin);
  await assert.rejects(resolveWorkerIssuer(f.db, cookie, 'POST', origin), authStatus(403));
  cookie.set('origin', origin); await resolveWorkerIssuer(f.db, cookie, 'POST', origin);
  await assert.rejects(resolveWorkerIssuer(f.db, headers(browser.token), 'GET', origin), authStatus(401));
});
test('SQLite enforces immutable lifetime/history and frozen principal checks reject every changed binding', async t => {
  const f = await fixture(t), a = args(f.run.id); await provisionWorker(f.db, f.issuer, a.input);
  const p = await authenticateWorkerHeaders(f.db, headers(a.token), 'GET', origin);
  for (const field of ['owner', 'actor', 'origin', 'issuerTokenHash', 'runId', 'project', 'ticketId', 'authorizationId', 'verifier', 'credentialId']) {
    const predicate = workerAuthorizationPredicate({ ...p, [field]: 'changed' });
    assert.equal(await f.db.prepare('SELECT 1 WHERE ' + predicate.sql).bind(...predicate.values).first(), null);
  }
  for (const field of ['issuerExpiresAt', 'expiresAt', 'ticketRevision', 'attempt']) {
    const predicate = workerAuthorizationPredicate({ ...p, [field]: p[field] + 1 });
    assert.equal(await f.db.prepare('SELECT 1 WHERE ' + predicate.sql).bind(...predicate.values).first(), null);
  }
  for (const sql of [
    'UPDATE execution_worker_credentials SET expires_at=expires_at+1 WHERE credential_id=?',
    'UPDATE execution_worker_credentials SET project=\'spoof\' WHERE credential_id=?',
    'DELETE FROM execution_worker_credentials WHERE credential_id=?',
  ]) await assert.rejects(f.db.prepare(sql).bind(a.input.credentialId).run(), /Immutable Worker/);
  await assert.rejects(f.db.prepare('INSERT INTO execution_worker_checks(id,valid) VALUES(?,?)').bind('invalid-check', 0).run(), /execution_worker_authorized/);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS count FROM execution_worker_checks').first()).count, 0);
});

test('expired credential remains denied with a still-valid issuer; SQLite rejects malformed verifier and overlong lifetime', async t => {
  const f = await fixture(t), original = args(f.run.id); await provisionWorker(f.db, f.issuer, original.input);
  const expired = args(f.run.id), createdAt = Date.now() - 900001, expiresAt = Date.now() - 1;
  const key = JSON.stringify([expired.input.credentialId, expired.input.requestId, expired.input.runId, expired.input.verifier,
    expired.input.label, f.issuer.owner, f.issuer.actor, f.issuer.origin, f.issuer.issuerTokenHash, f.issuer.issuerExpiresAt]);
  const insert = (id, request, verifier, created, expires, inputKey) => f.db.prepare(`INSERT INTO execution_worker_credentials
    (credential_id,owner,actor,origin,issuer_token_hash,issuer_expires_at,run_id,project,ticket_id,ticket_revision,attempt,
      authorization_id,verifier,label,request_id,input_key,created_at,expires_at)
    SELECT ?,owner,actor,origin,issuer_token_hash,issuer_expires_at,run_id,project,ticket_id,ticket_revision,attempt,
      authorization_id,?,label,?,?,?,? FROM execution_worker_credentials WHERE credential_id=?`)
    .bind(id, verifier, request, inputKey, created, expires, original.input.credentialId).run();
  await insert(expired.input.credentialId, expired.input.requestId, expired.input.verifier, createdAt, expiresAt, key);
  await assert.rejects(authenticateWorkerHeaders(f.db, headers(expired.token), 'GET', origin), authStatus(401));
  await assert.rejects(provisionWorker(f.db, f.issuer, expired.input), code('AUTHORIZATION_DENIED'));
  await resolveWorkerIssuer(f.db, headers(f.issued.token), 'GET', origin);
  await assert.rejects(insert(randomUUID(), randomUUID(), 'G'.repeat(64), Date.now(), Date.now() + 500, 'bad-verifier'), /CHECK constraint failed/);
  const now = Date.now();
  await assert.rejects(insert(randomUUID(), randomUUID(), 'a'.repeat(64), now, now + 900001, 'bad-ttl'), /CHECK constraint failed/);
});

test('foreign owner cannot view, replay, or revoke another owner credential', async t => {
  const f = await fixture(t), a = args(f.run.id); await provisionWorker(f.db, f.issuer, a.input);
  const user = await createAccount(f.db, { username: 'other-owner', displayName: 'Synthetic other', password: 'Synthetic-other-password' });
  const issued = await issueToken(f.db, user.userId, { kind: 'api' });
  const issuer = await resolveWorkerIssuer(f.db, headers(issued.token), 'POST', origin);
  assert.deepEqual(await listWorkers(f.db, issuer), []);
  await assert.rejects(provisionWorker(f.db, issuer, args(f.run.id).input), code('NOT_FOUND'));
  await assert.rejects(revokeWorker(f.db, issuer, { credentialId: a.input.credentialId, requestId: 'foreign-revoke' }), code('NOT_FOUND'));
  await authenticateWorkerHeaders(f.db, headers(a.token), 'GET', origin);
});

test('issuer revocation between replay read and return is rejected', async t => {
  const f = await fixture(t), a = args(f.run.id); await provisionWorker(f.db, f.issuer, a.input);
  let intercepted = false;
  const racing = {
    ...f.db,
    prepare(sql) {
      const statement = f.db.prepare(sql);
      if (!sql.includes('SELECT * FROM execution_worker_credentials WHERE owner=? AND request_id=?')) return statement;
      const wrap = raw => ({
        bind(...values) { return wrap(raw.bind(...values)); },
        async first() { const row = await raw.first(); if (!intercepted) { intercepted = true; await revokeToken(f.db, f.issued.token); } return row; },
        all: () => raw.all(), run: () => raw.run(),
      });
      return wrap(statement);
    },
  };
  await assert.rejects(provisionWorker(racing, f.issuer, a.input), code('AUTHORIZATION_DENIED'));
  assert.equal(intercepted, true);
});
