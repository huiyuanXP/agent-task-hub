import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/database.mts';
import { createAccount, issueToken, revokeToken } from '../../lib/local-auth.mts';
import { resolveWorkerIssuer, authenticateWorkerHeaders } from '../../lib/execution/worker-auth.mts';
import { provisionWorker } from '../../lib/execution/workers.mts';
import { getOperationCatalog } from '../../lib/execution/catalog.mts';
import { prepareExecution, decideAuthorization, revokeAuthorization } from '../../lib/execution/authorization.mts';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';
import { transitionRun } from '../../lib/execution/runs.mts';
import { claimExecutionRun, renewExecutionRun, reportExecutionRun } from '../../lib/execution/worker-leases.mts';
import { resolveExecutionLease, leaseAuthorizationPredicate } from '../../lib/execution/worker-lease-auth.mts';
import { beginWorkerAction, finishWorkerAction } from '../../lib/execution/worker-action-store.mts';
const origin = 'http://127.0.0.1:5173';
const hash = value => createHash('sha256').update(value).digest('hex');
const code = expected => error => error.code === expected;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function claimInput(runId, overrides = {}) {
  const secret = randomBytes(32).toString('base64url');
  return { input: { runId, requestId: randomUUID(), leaseId: randomUUID(), verifier: hash(secret), mode: 'execute', ...overrides }, secret };
}
function action(runId, lease, secret, requestId = randomUUID(), extras = {}) {
  return { runId, requestId, leaseToken: 'athl1.' + lease.leaseId + '.' + lease.generation + '.' + secret, ...extras };
}
async function fixture(t, { grantTtl = 120000, budgetMs = 30000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-leases-')), path = join(directory, 'test.sqlite');
  const db = openDatabase(path); t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const user = await createAccount(db, { username: 'lease-owner', displayName: 'Synthetic lease owner', password: 'Lease-fixture-password-2026' });
  const token = await issueToken(db, user.userId, { kind: 'api' });
  const issuer = await resolveWorkerIssuer(db, new Headers({ host: '127.0.0.1:5173', authorization: 'Bearer ' + token.token }), 'POST', origin);
  const context = { owner: user.userId, actor: user.userId, grantAuthority: 'owner' }, now = new Date().toISOString();
  await db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').bind('lease-ticket', user.userId, 'ticket',
    JSON.stringify({ title: 'Lease fixture', project: '租约项目', status: 'todo' }), 1, now, now).run();
  const { operations } = await getOperationCatalog(db, context, { ticketId: 'lease-ticket', expectedRevision: 1 });
  const prepared = await prepareExecution(db, context, { ticketId: 'lease-ticket', expectedRevision: 1, requestId: randomUUID(), attempt: 1,
    scope: [{ operationId: operations[0].operationId, definitionHash: operations[0].definitionHash }],
    budget: { timeoutMs: budgetMs, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + grantTtl });
  await decideAuthorization(db, context, { authorizationId: prepared.authorization.id, decisionId: randomUUID(), outcome: 'approved' });
  async function worker() {
    const secret = randomBytes(32).toString('base64url'), credentialId = randomUUID();
    await provisionWorker(db, issuer, { credentialId, requestId: randomUUID(), runId: prepared.run.id, verifier: hash(secret), label: 'Lease test' });
    return authenticateWorkerHeaders(db, new Headers({ host: '127.0.0.1:5173', authorization: 'Bearer athw1.' + credentialId + '.' + secret }), 'POST', origin);
  }
  return { db, path, user, token, issuer, context, run: prepared.run, authorization: prepared.authorization, worker, p: await worker() };
}
test('claim freezes six-second metadata, stores only verifier, and replays original response', async t => {
  const f = await fixture(t), a = claimInput(f.run.id);
  const first = await claimExecutionRun(f.db, f.p, a.input, f.context);
  assert.equal(first.generation, 1); assert.equal(first.mode, 'execute'); assert.equal(first.expiresAt, first.createdAt + 6000);
  assert.deepEqual(await claimExecutionRun(f.db, f.p, a.input, f.context), first);
  const row = await resolveExecutionLease(f.db, f.p, { runId: f.run.id, leaseToken: action(f.run.id, first, a.secret).leaseToken });
  assert.equal(row.verifier, hash(a.secret)); assert.equal(row.credential_id, f.p.credentialId);
  const ledger = await f.db.prepare('SELECT * FROM execution_worker_actions').all();
  assert.equal(ledger.results.length, 1); assert.equal(ledger.results[0].status, 'completed');
  for (const text of [JSON.stringify(first), ledger.results[0].input_key, ledger.results[0].response_json]) assert.ok(!text.includes(a.secret));
  assert.ok(!JSON.stringify(first).includes('verifier'));
  await assert.rejects(claimExecutionRun(f.db, f.p, { ...a.input, mode: 'reconcile' }, f.context), code('REQUEST_CONFLICT'));
  await assert.rejects(claimExecutionRun(f.db, f.p, { ...a.input, verifier: '0'.repeat(64) }, f.context), code('REQUEST_CONFLICT'));
  await assert.rejects(claimExecutionRun(f.db, f.p, { ...a.input, requestId: randomUUID() }, f.context), code('REQUEST_CONFLICT'));
});
test('two native handles and credentials have one claim winner; real expiry takeover fences old generation while replay remains immutable', async t => {
  const f = await fixture(t), db2 = openDatabase(f.path), p2 = await f.worker(); t.after(() => db2.close());
  const a = claimInput(f.run.id), b = claimInput(f.run.id);
  const outcomes = await Promise.allSettled([claimExecutionRun(f.db, f.p, a.input, f.context), claimExecutionRun(db2, p2, b.input, f.context)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.code, 'AUTHORIZATION_DENIED');
  const winnerIndex = outcomes.findIndex(x => x.status === 'fulfilled'), winner = outcomes[winnerIndex].value;
  const p = winnerIndex === 0 ? f.p : p2, original = winnerIndex === 0 ? a : b, nextP = winnerIndex === 0 ? p2 : f.p;
  const token = action(f.run.id, winner, original.secret);
  await sleep(Math.max(0, winner.expiresAt - Date.now() + 30));
  await assert.rejects(resolveExecutionLease(f.db, p, { runId: f.run.id, leaseToken: token.leaseToken }), code('AUTHORIZATION_DENIED'));
  const nextArgs = claimInput(f.run.id), next = await claimExecutionRun(db2, nextP, nextArgs.input, f.context);
  assert.equal(next.generation, 2);
  assert.deepEqual(await claimExecutionRun(f.db, p, original.input, f.context), winner);
  await assert.rejects(renewExecutionRun(f.db, p, token, f.context), code('AUTHORIZATION_DENIED'));
  await assert.rejects(reportExecutionRun(f.db, p, { ...token, message: 'late' }, f.context), code('AUTHORIZATION_DENIED'));
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM execution_worker_checks').first()).n, 0);
});
test('renewal response replays exact expiry and claim replay retains original expiry after multiple renewals', async t => {
  const f = await fixture(t), a = claimInput(f.run.id), initial = await claimExecutionRun(f.db, f.p, a.input, f.context);
  const input = action(f.run.id, initial, a.secret);
  await sleep(30);
  const first = await renewExecutionRun(f.db, f.p, input, f.context);
  assert.ok(first.expiresAt > initial.expiresAt);
  await sleep(30);
  const later = await renewExecutionRun(f.db, f.p, { ...input, requestId: randomUUID() }, f.context);
  assert.ok(later.expiresAt > first.expiresAt);
  assert.deepEqual(await renewExecutionRun(f.db, f.p, input, f.context), first);
  assert.deepEqual(await claimExecutionRun(f.db, f.p, a.input, f.context), initial);
  await assert.rejects(renewExecutionRun(f.db, f.p, { ...input, requestId: a.input.requestId }, f.context), code('REQUEST_CONFLICT'));
  const stored = await f.db.prepare('SELECT input_key,response_json FROM execution_worker_actions').all();
  for (const row of stored.results) assert.ok(!JSON.stringify(row).includes(input.leaseToken));
});
test('report stores bounded message only, leaves Run state unchanged, and rejects changed bodies and unknown state/evidence', async t => {
  const f = await fixture(t), a = claimInput(f.run.id), lease = await claimExecutionRun(f.db, f.p, a.input, f.context);
  const input = action(f.run.id, lease, a.secret, randomUUID(), { message: '开始检查 🧪' });
  const response = await reportExecutionRun(f.db, f.p, input, f.context);
  assert.equal(response.message, input.message); assert.deepEqual(await reportExecutionRun(f.db, f.p, input, f.context), response);
  assert.equal((await f.db.prepare('SELECT state FROM execution_runs WHERE id=?').bind(f.run.id).first()).state, 'queued');
  await assert.rejects(reportExecutionRun(f.db, f.p, { ...input, message: 'changed' }, f.context), code('REQUEST_CONFLICT'));
  for (const bad of [{ state: 'succeeded' }, { evidence: {} }, { owner: f.user.userId }]) {
    await assert.rejects(reportExecutionRun(f.db, f.p, { ...input, ...bad }, f.context), code('INVALID_INPUT'));
  }
  await assert.rejects(reportExecutionRun(f.db, f.p, { ...input, requestId: randomUUID(), message: 'x'.repeat(2049) }, f.context), code('INVALID_INPUT'));
  await assert.rejects(renewExecutionRun(f.db, f.p, { ...input, message: undefined }, f.context), code('INVALID_INPUT'));
  await assert.rejects(claimExecutionRun(f.db, f.p, { ...a.input, requestId: input.requestId }, f.context), code('REQUEST_CONFLICT'));
  await transitionRun(f.db, f.context, { id: f.run.id, expectedVersion: 1, to: 'failed' });
  await assert.rejects(reportExecutionRun(f.db, f.p, { ...input, requestId: randomUUID() }, f.context), code('AUTHORIZATION_DENIED'));
});
test('execute requires live approved grant, current revision/body, registry, and active Run', async t => {
  const f = await fixture(t), a = claimInput(f.run.id);
  const badRegistry = { ...f.context, registry: [{ operationId: 'ticket.validate.v1', label: 'Different definition', image: 'node@sha256:' + '0'.repeat(64), scriptVersion: 1 }] };
  await assert.rejects(claimExecutionRun(f.db, f.p, a.input, badRegistry), code('AUTHORIZATION_DENIED'));
  await f.db.prepare("UPDATE records SET body=json_set(body,'$.title','Changed without revision') WHERE id=? AND owner=?").bind(f.run.ticketId, f.p.owner).run();
  await assert.rejects(claimExecutionRun(f.db, f.p, a.input, f.context), code('AUTHORIZATION_DENIED'));
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM execution_worker_leases').first()).n, 0);
});
test('approval revocation during native claim/renew transactions rolls back lease and receipt together', async t => {
  const f = await fixture(t), a = claimInput(f.run.id);
  let raced = false;
  const race = {
    ...f.db,
    async batch(statements) {
      if (!raced) { raced = true; await revokeAuthorization(f.db, f.context, { authorizationId: f.run.authorizationId, decisionId: 'claim-race' }); }
      return f.db.batch(statements);
    },
  };
  await assert.rejects(claimExecutionRun(race, f.p, a.input, f.context), code('AUTHORIZATION_DENIED'));
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM execution_worker_leases').first()).n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM execution_worker_actions').first()).n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM execution_worker_checks').first()).n, 0);
  const g = await fixture(t), b = claimInput(g.run.id), lease = await claimExecutionRun(g.db, g.p, b.input, g.context);
  let renewedRace = false;
  const renewalRace = {
    ...g.db,
    async batch(statements) {
      if (!renewedRace) { renewedRace = true; await revokeAuthorization(g.db, g.context, { authorizationId: g.run.authorizationId, decisionId: 'renew-race' }); }
      return g.db.batch(statements);
    },
  };
  await assert.rejects(renewExecutionRun(renewalRace, g.p, action(g.run.id, lease, b.secret), g.context), code('AUTHORIZATION_DENIED'));
  assert.equal((await g.db.prepare('SELECT expires_at FROM execution_worker_leases').first()).expires_at, lease.expiresAt);
  assert.equal((await g.db.prepare('SELECT COUNT(*) n FROM execution_worker_actions').first()).n, 1);
  assert.equal((await g.db.prepare('SELECT COUNT(*) n FROM execution_worker_checks').first()).n, 0);
});
test('reconcile requires a persisted owned permit and survives revoked approval or malformed current registry without new dispatch, renewal, or report', async t => {
  const f = await fixture(t), a = claimInput(f.run.id, { mode: 'reconcile' });
  await assert.rejects(claimExecutionRun(f.db, f.p, a.input, f.context), code('AUTHORIZATION_DENIED'));
  const permit = await createDispatchPermit(f.db, f.context, f.run.id);
  await revokeAuthorization(f.db, f.context, { authorizationId: f.run.authorizationId, decisionId: 'reconcile-revoke' });
  const brokenContext = { ...f.context, registry: [] };
  const lease = await claimExecutionRun(f.db, f.p, a.input, brokenContext);
  const input = action(f.run.id, lease, a.secret), row = await resolveExecutionLease(f.db, f.p, { runId: f.run.id, leaseToken: input.leaseToken });
  assert.equal(row.mode, 'reconcile');
  await assert.rejects(renewExecutionRun(f.db, f.p, input, brokenContext), code('AUTHORIZATION_DENIED'));
  await assert.rejects(reportExecutionRun(f.db, f.p, { ...input, message: 'Forbidden' }, brokenContext), code('AUTHORIZATION_DENIED'));
  const pending = await beginWorkerAction(f.db, f.p, row, 'complete', { requestId: input.requestId });
  assert.deepEqual(pending, { completed: false, response: null });
  const response = { runId: f.run.id, permitId: permit.permitId, state: 'failed', physicalClosed: false };
  assert.deepEqual(await finishWorkerAction(f.db, f.p, row, 'complete', { requestId: input.requestId }, response), response);
  assert.deepEqual(await beginWorkerAction(f.db, f.p, row, 'complete', { requestId: input.requestId }), { completed: true, response });
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM execution_permits').first()).n, 1);
});
test('pending backend action reservations recover, immutable completed response wins, and request IDs cannot switch kind or lease', async t => {
  const f = await fixture(t), a = claimInput(f.run.id), lease = await claimExecutionRun(f.db, f.p, a.input, f.context);
  const token = action(f.run.id, lease, a.secret), row = await resolveExecutionLease(f.db, f.p, { runId: f.run.id, leaseToken: token.leaseToken });
  const input = { requestId: randomUUID() };
  assert.deepEqual(await beginWorkerAction(f.db, f.p, row, 'start', input), { completed: false, response: null });
  assert.deepEqual(await beginWorkerAction(f.db, f.p, row, 'start', input), { completed: false, response: null });
  await assert.rejects(beginWorkerAction(f.db, f.p, row, 'cancel', input), code('REQUEST_CONFLICT'));
  await assert.rejects(beginWorkerAction(f.db, f.p, row, 'start', { requestId: a.input.requestId }), code('REQUEST_CONFLICT'));
  const response = { runId: f.run.id, state: 'running' };
  assert.deepEqual(await finishWorkerAction(f.db, f.p, row, 'start', input, response), response);
  assert.deepEqual(await finishWorkerAction(f.db, f.p, row, 'start', input, { state: 'changed' }), response);
  await assert.rejects(f.db.prepare("UPDATE execution_worker_actions SET response_json='{}' WHERE request_id=?").bind(input.requestId).run(), /Immutable Worker action/);
  await assert.rejects(f.db.prepare('DELETE FROM execution_worker_actions WHERE request_id=?').bind(input.requestId).run(), /Immutable Worker action/);
  for (const unsafe of [{ evidence: {} }, { leaseToken: token.leaseToken }, { message: token.leaseToken }, { huge: '汉'.repeat(6000) }]) {
    await assert.rejects(finishWorkerAction(f.db, f.p, row, 'start', input, unsafe), code('INVALID_INPUT'));
  }
});
test('lease parser strictly rejects foreign binding, cookie/local namespace, modified generation, secret, and extra fields', async t => {
  const f = await fixture(t), a = claimInput(f.run.id), lease = await claimExecutionRun(f.db, f.p, a.input, f.context);
  const input = action(f.run.id, lease, a.secret);
  for (const token of [f.token.token, 'athw1.' + a.input.leaseId + '.' + a.secret, input.leaseToken + '.extra',
    input.leaseToken.replace('.1.', '.01.'), input.leaseToken.replace('.1.', '.2.'), input.leaseToken.replace(a.secret, randomBytes(32).toString('base64url'))]) {
    await assert.rejects(resolveExecutionLease(f.db, f.p, { runId: f.run.id, leaseToken: token }), code('AUTHORIZATION_DENIED'));
  }
  await assert.rejects(resolveExecutionLease(f.db, f.p, { runId: 'foreign-run', leaseToken: input.leaseToken }), code('AUTHORIZATION_DENIED'));
  await assert.rejects(resolveExecutionLease(f.db, await f.worker(), { runId: f.run.id, leaseToken: input.leaseToken }), code('AUTHORIZATION_DENIED'));
  await assert.rejects(resolveExecutionLease(f.db, f.p, input), code('INVALID_INPUT'));
  await assert.rejects(claimExecutionRun(f.db, f.p, { ...a.input, state: 'running' }, f.context), code('INVALID_INPUT'));
  await revokeToken(f.db, f.token.token);
  await assert.rejects(resolveExecutionLease(f.db, f.p, { runId: f.run.id, leaseToken: input.leaseToken }), code('AUTHORIZATION_DENIED'));
});
test('claim and renewal are capped by real approval and persisted permit deadline without changing the permit', async t => {
  const f = await fixture(t, { grantTtl: 2500 }), a = claimInput(f.run.id), lease = await claimExecutionRun(f.db, f.p, a.input, f.context);
  assert.equal(lease.expiresAt, f.authorization.expiresAt);
  await sleep(20);
  const renewed = await renewExecutionRun(f.db, f.p, action(f.run.id, lease, a.secret), f.context);
  assert.equal(renewed.expiresAt, f.authorization.expiresAt);
  const g = await fixture(t, { budgetMs: 1000 }), b = claimInput(g.run.id), original = await claimExecutionRun(g.db, g.p, b.input, g.context);
  const permit = await createDispatchPermit(g.db, g.context, g.run.id);
  assert.ok(original.expiresAt > permit.deadlineMs);
  await assert.rejects(renewExecutionRun(g.db, g.p, action(g.run.id, original, b.secret), g.context), code('AUTHORIZATION_DENIED'));
  assert.equal((await g.db.prepare('SELECT deadline_ms FROM execution_permits').first()).deadline_ms, permit.deadlineMs);
  const h = await fixture(t, { budgetMs: 1000 }), permitBefore = await createDispatchPermit(h.db, h.context, h.run.id);
  const c = claimInput(h.run.id), capped = await claimExecutionRun(h.db, h.p, c.input, h.context);
  assert.equal(capped.expiresAt, permitBefore.deadlineMs);
});
test('SQLite rejects lease verifier/lifetime tampering, zero-residue checks, and passed principal snapshots cannot rebind', async t => {
  const f = await fixture(t), a = claimInput(f.run.id), lease = await claimExecutionRun(f.db, f.p, a.input, f.context);
  const row = await resolveExecutionLease(f.db, f.p, { runId: f.run.id, leaseToken: action(f.run.id, lease, a.secret).leaseToken });
  for (const sql of [
    "UPDATE execution_worker_leases SET mode='reconcile' WHERE lease_id=?",
    "UPDATE execution_worker_leases SET verifier='" + '0'.repeat(64) + "' WHERE lease_id=?",
    'UPDATE execution_worker_leases SET expires_at=expires_at-1 WHERE lease_id=?',
    'UPDATE execution_worker_leases SET expires_at=renewed_at+6001 WHERE lease_id=?',
    'DELETE FROM execution_worker_leases WHERE lease_id=?',
  ]) await assert.rejects(f.db.prepare(sql).bind(lease.leaseId).run(), /Immutable Worker|CHECK constraint failed/);
  for (const changed of [{ ...row, owner: 'other' }, { ...row, credential_id: 'other' }, { ...row, run_id: 'other' }, { ...row, generation: 2 }]) {
    const predicate = leaseAuthorizationPredicate(f.p, changed);
    assert.equal(await f.db.prepare('SELECT 1 WHERE ' + predicate.sql).bind(...predicate.values).first(), null);
  }
  assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM execution_worker_checks').first()).n, 0);
});
