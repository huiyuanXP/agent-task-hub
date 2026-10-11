import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/database.mts';
import { createAccount, issueToken, revokeToken } from '../../lib/local-auth.mts';
import { getOperationCatalog } from '../../lib/execution/catalog.mts';
import { prepareExecution, decideAuthorization, revokeAuthorization } from '../../lib/execution/authorization.mts';
import { getRun, transitionRun } from '../../lib/execution/runs.mts';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';
import { reconcileBackend } from '../../lib/execution/backend-http.mts';
import { configuredRegistry } from '../../lib/execution/backend-config.mts';
import { provisionWorker, revokeWorker } from '../../lib/execution/workers.mts';
import { resolveWorkerIssuer, authenticateWorkerHeaders } from '../../lib/execution/worker-auth.mts';
import { claimExecutionRun, renewExecutionRun, reportExecutionRun } from '../../lib/execution/worker-leases.mts';
import { startExecutionRun, completeExecutionRun, cancelExecutionRun } from '../../lib/execution/worker-actions.mts';
import { workerBackendFixture } from './fixtures/worker-backend.mjs';

const origin = 'http://127.0.0.1:5173';
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (code, status) => value => value.code === code && value.status === status;
const denied = error('AUTHORIZATION_DENIED', 403);
const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
async function fixture(t, peerOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-actions-'));
  const db = openDatabase(join(directory, 'data.sqlite'));
  const peer = await workerBackendFixture(peerOptions);
  t.after(async () => { try { await peer.close(); assert.deepEqual(peer.errors, []); } finally { db.close(); rmSync(directory, { recursive: true, force: true }); } });
  const user = await createAccount(db, { username: 'synthetic', displayName: 'Synthetic Actions', password: 'synthetic-password' });
  const issuerToken = await issueToken(db, user.userId, { kind: 'api' });
  const headers = new Headers({ host: new URL(origin).host, authorization: `Bearer ${issuerToken.token}` });
  const issuer = await resolveWorkerIssuer(db, headers, 'POST', origin);
  const owner = { owner: user.userId, actor: user.userId, grantAuthority: 'owner', registry: configuredRegistry(peer.env) };
  async function prepare(ticketId = randomUUID(), attempt = 1, reuse = false) {
    if (!reuse) { const now = new Date().toISOString(); await db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind(ticketId, user.userId, 'ticket', JSON.stringify({ title: 'Synthetic Actions', project: 'Synthetic' }), 1, now, now).run(); }
    const { operations } = await getOperationCatalog(db, owner, { ticketId, expectedRevision: 1 });
    const prepared = await prepareExecution(db, owner, { ticketId, expectedRevision: 1, requestId: randomUUID(), attempt, scope: [{ operationId: operations[0].operationId, definitionHash: operations[0].definitionHash }], budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 600000 });
    await decideAuthorization(db, owner, { authorizationId: prepared.authorization.id, decisionId: randomUUID(), outcome: 'approved' });
    return prepared.run;
  }
  async function worker(run) {
    const secret = randomBytes(32).toString('base64url');
    const credential = await provisionWorker(db, issuer, { credentialId: randomUUID(), requestId: randomUUID(), runId: run.id, verifier: hash(secret), label: 'Synthetic action Worker' });
    const principal = await authenticateWorkerHeaders(db, new Headers({ host: new URL(origin).host, authorization: `Bearer athw1.${credential.credentialId}.${secret}` }), 'POST', origin);
    return { principal, credential, secret };
  }
  async function claim(w, mode = 'execute') {
    const secret = randomBytes(32).toString('base64url');
    const input = { runId: w.principal.runId, requestId: randomUUID(), leaseId: randomUUID(), verifier: hash(secret), mode };
    const lease = await claimExecutionRun(db, w.principal, input, { ...owner, executionRunId: w.principal.runId });
    return { lease, secret, input, token: `athl1.${lease.leaseId}.${lease.generation}.${secret}` };
  }
  const run = await prepare(), w = await worker(run);
  const noChecks = async () => assert.equal((await db.prepare('SELECT count(*) AS n FROM execution_worker_checks').first()).n, 0);
  return { db, peer, owner, user, issuer, issuerToken: issuerToken.token, prepare, worker, claim, run, w, noChecks };
}
const actionInput = (run, lease, requestId = randomUUID()) => ({ runId: run.id, requestId, leaseToken: lease.token });
async function domainSnapshot(db) {
  return Promise.all(['execution_runs', 'execution_permits', 'backend_attestations'].map(async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results));
}
function safe(value, f, l) {
  const json = JSON.stringify(value);
  for (const secret of [f.issuerToken, f.w.secret, l.secret, l.token, f.w.principal.verifier, f.w.principal.issuerTokenHash, f.user.userId]) assert.ok(!json.includes(secret), 'Private data escaped safe action response');
  assert.ok(Buffer.byteLength(json) <= 16384);
  for (const key of ['owner', 'actor', 'evidence', 'signature', 'receipt', 'receipts', 'ticketBody', 'envelope', 'verifier', 'leaseToken']) assert.ok(!new RegExp(`"${key}"\\s*:`).test(json), `Private field escaped: ${key}`);
}

test('start persists one immutable permit and safe receipt; completed replay performs no external operation', async t => {
  const f = await fixture(t), l = await f.claim(f.w), input = actionInput(f.run, l);
  const first = await startExecutionRun(f.db, f.w.principal, input, f.peer.env);
  assert.equal(first.kind, 'start'); assert.equal(first.run.id, f.run.id); assert.equal(first.backend.phase, 'accepted');
  const saved = await f.db.prepare('SELECT envelope,deadline_ms FROM execution_permits WHERE run_id=?').bind(f.run.id).first();
  const replay = await startExecutionRun(f.db, f.w.principal, input, f.peer.env);
  assert.deepEqual(replay, first); assert.equal(f.peer.requests.filter(row => row.path === '/start').length, 1);
  assert.equal(first.permit.deadlineMs, saved.deadline_ms); safe(first, f, l);
  const ledger = await f.db.prepare('SELECT * FROM execution_worker_actions WHERE credential_id=? AND request_id=?').bind(f.w.credential.credentialId, input.requestId).first();
  assert.equal(ledger.status, 'completed'); assert.deepEqual(JSON.parse(ledger.response_json), first);
  assert.ok(!ledger.input_key.includes(l.token) && !ledger.input_key.includes(l.secret));
  await assert.rejects(f.db.prepare("UPDATE execution_worker_actions SET response_json='{}' WHERE credential_id=? AND request_id=?").bind(f.w.credential.credentialId, input.requestId).run());
  await assert.rejects(cancelExecutionRun(f.db, f.w.principal, input, f.peer.env), error('REQUEST_CONFLICT', 409));
  await f.noChecks();
});

test('a signed backend outage leaves a pending start that retries the same persisted permit and deadline', async t => {
  let attempts = 0;
  const f = await fixture(t, { async handler(path) {
    assert.equal(path, '/start');
    return ++attempts === 1 ? { status: 503, data: { error: 'Synthetic unavailable backend' } } : { status: 202, data: { phase: 'accepted', receipts: [] } };
  } });
  const l = await f.claim(f.w), input = actionInput(f.run, l);
  await assert.rejects(startExecutionRun(f.db, f.w.principal, input, f.peer.env), error('DISPATCH_CONFLICT', 409));
  const before = await f.db.prepare('SELECT * FROM execution_permits WHERE run_id=?').bind(f.run.id).first();
  assert.ok(before); assert.equal(before.closed_at, null);
  assert.equal((await f.db.prepare('SELECT status FROM execution_worker_actions WHERE request_id=?').bind(input.requestId).first()).status, 'pending');
  const retried = await startExecutionRun(f.db, f.w.principal, input, f.peer.env);
  assert.equal(retried.permit.permitId, before.id); assert.equal(retried.permit.deadlineMs, before.deadline_ms);
  assert.deepEqual(f.peer.requests[0].permit, f.peer.requests[1].permit);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_permits').first()).n, 1);
  assert.deepEqual(await startExecutionRun(f.db, f.w.principal, input, f.peer.env), retried); assert.equal(attempts, 2);
  safe(retried, f, l); await f.noChecks();
});

test('running/result-not-ready is typed INVALID_EVIDENCE; same pending completion later consumes signed result and stop', async t => {
  const f = await fixture(t), l = await f.claim(f.w);
  const started = await startExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env);
  const input = actionInput(f.run, l);
  await assert.rejects(completeExecutionRun(f.db, f.w.principal, input, f.peer.env), error('INVALID_EVIDENCE', 409));
  const pending = await f.db.prepare('SELECT status,response_json FROM execution_worker_actions WHERE request_id=?').bind(input.requestId).first();
  assert.equal(pending.status, 'pending'); assert.equal(pending.response_json, null);
  assert.equal((await f.db.prepare('SELECT closed_at FROM execution_permits WHERE run_id=?').bind(f.run.id).first()).closed_at, null);
  f.peer.setResult(f.run.id, { phase: 'stopped', purposes: ['result', 'stop'] });
  const completed = await completeExecutionRun(f.db, f.w.principal, input, f.peer.env);
  assert.equal(completed.run.state, 'succeeded'); assert.ok(completed.permit.closedAt !== null);
  assert.equal(completed.permit.permitId, started.permit.permitId); assert.equal(completed.permit.deadlineMs, started.permit.deadlineMs);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM backend_attestations').first()).n, 2);
  const count = f.peer.requests.length;
  assert.deepEqual(await completeExecutionRun(f.db, f.w.principal, input, f.peer.env), completed);
  assert.equal(f.peer.requests.length, count); safe(completed, f, l); await f.noChecks();
});

test('cancel fence preserves logical cancellation with physical stop unconfirmed; a later signed stop closes only the reservation', async t => {
  const f = await fixture(t), l = await f.claim(f.w);
  const start = await startExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env);
  const input = actionInput(f.run, l);
  const cancelled = await cancelExecutionRun(f.db, f.w.principal, input, f.peer.env);
  assert.equal(cancelled.run.state, 'cancelled'); assert.equal(cancelled.permit.cancelRequested, true); assert.equal(cancelled.permit.closedAt, null);
  assert.deepEqual((await f.db.prepare('SELECT purpose FROM backend_attestations').all()).results.map(row => row.purpose), ['cancel_fence']);
  f.peer.setResult(f.run.id, { phase: 'stopped', purposes: ['cancel_fence', 'stop'], cancelPurposes: ['cancel_fence', 'stop'] });
  const stopped = await cancelExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env);
  assert.equal(stopped.run.state, 'cancelled'); assert.ok(stopped.permit.closedAt !== null);
  assert.equal(stopped.permit.permitId, start.permit.permitId); assert.equal(stopped.permit.deadlineMs, start.permit.deadlineMs);
  assert.deepEqual(await cancelExecutionRun(f.db, f.w.principal, input, f.peer.env), cancelled, 'Completed reply is an immutable historical snapshot');
  assert.equal((await getRun(f.db, f.user.userId, f.run.id)).evidence, null);
  safe(stopped, f, l); await f.noChecks();
});

test('a mixed group containing a signed foreign owner, Run or permit is rejected before any receipt ingestion', async t => {
  const f = await fixture(t), l = await f.claim(f.w);
  await startExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env);
  const permit = f.peer.permits.get(f.run.id);
  const valid = await f.peer.receipt(permit);
  for (const purpose of ['result', 'cancel_fence', 'stop']) for (const changed of [{ owner: randomUUID() }, { runId: randomUUID() }, { permitId: randomUUID() }]) {
    const foreign = await f.peer.receipt(permit, purpose, changed);
    f.peer.setResult(f.run.id, { phase: 'stopped', receipts: [valid, foreign] });
    const before = await domainSnapshot(f.db);
    await assert.rejects(completeExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env), error('INVALID_EVIDENCE', 409));
    assert.deepEqual(await domainSnapshot(f.db), before);
  }
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM backend_attestations').first()).n, 0); await f.noChecks();
});

test('historical reconcile lease survives approval revocation and never grants start, renew or report authority', async t => {
  const f = await fixture(t);
  const permit = await createDispatchPermit(f.db, f.owner, f.run.id);
  await revokeAuthorization(f.db, f.owner, { authorizationId: f.run.authorizationId, decisionId: randomUUID() });
  await assert.rejects(f.claim(f.w), denied);
  const l = await f.claim(f.w, 'reconcile');
  assert.equal(l.lease.mode, 'reconcile');
  await assert.rejects(startExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env), denied);
  await assert.rejects(renewExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.owner), denied);
  await assert.rejects(reportExecutionRun(f.db, f.w.principal, { ...actionInput(f.run, l), message: 'historical report' }, f.owner), denied);
  f.peer.setResult(f.run.id, { phase: 'stopped', purposes: ['result', 'stop'], cancelPurposes: ['cancel_fence'] });
  const completed = await completeExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env);
  assert.equal(completed.permit.permitId, permit.permitId); assert.equal(completed.permit.deadlineMs, permit.deadlineMs);
  assert.ok(completed.permit.closedAt !== null); safe(completed, f, l); await f.noChecks();
});

test('Worker successor cannot recover a foreign predecessor reservation; original owner recovery remains available', async t => {
  const f = await fixture(t), l = await f.claim(f.w);
  await startExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env);
  const oldPermit = f.peer.permits.get(f.run.id);
  await transitionRun(f.db, f.owner, { id: f.run.id, expectedVersion: 1, to: 'cancelled' });
  const successor = await f.prepare(f.run.ticketId, 2, true), w = await f.worker(successor), nextLease = await f.claim(w);
  const before = await domainSnapshot(f.db), requestCount = f.peer.requests.length;
  await assert.rejects(startExecutionRun(f.db, w.principal, actionInput(successor, nextLease), f.peer.env), error('DISPATCH_CONFLICT', 409));
  assert.equal(f.peer.requests.length, requestCount); assert.deepEqual(await domainSnapshot(f.db), before);
  assert.equal(await f.db.prepare('SELECT id FROM execution_permits WHERE run_id=?').bind(successor.id).first(), null);
  f.peer.setResult(f.run.id, { phase: 'stopped', purposes: ['stop'], cancelPurposes: ['cancel_fence', 'stop'] });
  await reconcileBackend(f.db, f.owner, f.peer.env, successor.id);
  assert.ok((await f.db.prepare('SELECT closed_at FROM execution_permits WHERE id=?').bind(oldPermit.permitId).first()).closed_at !== null);
  assert.equal((await getRun(f.db, f.user.userId, successor.id)).state, 'queued'); await f.noChecks();
});

test('unknown state/evidence/trust fields and foreign Run cannot be supplied to consequential actions', async t => {
  const f = await fixture(t), l = await f.claim(f.w);
  for (const invoke of [startExecutionRun, completeExecutionRun, cancelExecutionRun]) {
    for (const extra of [{ state: 'succeeded' }, { evidence: {} }, { trust: {} }, { owner: f.user.userId }, { grantAuthority: 'owner' }]) await assert.rejects(invoke(f.db, f.w.principal, { ...actionInput(f.run, l), ...extra }, f.peer.env), error('INVALID_INPUT', 400));
    await assert.rejects(invoke(f.db, f.w.principal, { ...actionInput(f.run, l), runId: randomUUID() }, f.peer.env), denied);
  }
  assert.equal(f.peer.requests.length, 0); await f.noChecks();
});

for (const invalidation of ['worker', 'issuer', 'lease']) test(`a signed backend reply arriving after ${invalidation} invalidation cannot commit result or action completion`, async t => {
  const f = await fixture(t), l = await f.claim(f.w);
  await startExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env);
  f.peer.setResult(f.run.id, { phase: 'stopped', purposes: ['result', 'stop'] });
  if (invalidation === 'lease') await delay(l.lease.expiresAt - Date.now() - 1200);
  const hold = f.peer.holdNext('/result', f.run.id), input = actionInput(f.run, l);
  const completing = completeExecutionRun(f.db, f.w.principal, input, f.peer.env);
  // Attach rejection immediately while the test mutates the authenticated fixture.
  const rejected = assert.rejects(completing, denied);
  await hold.entered;
  const before = await domainSnapshot(f.db);
  if (invalidation === 'worker') await revokeWorker(f.db, f.issuer, { credentialId: f.w.credential.credentialId, requestId: randomUUID() });
  else if (invalidation === 'issuer') await revokeToken(f.db, f.issuerToken);
  else await delay(l.lease.expiresAt - Date.now() + 30);
  hold.release(); await rejected;
  assert.deepEqual(await domainSnapshot(f.db), before);
  const pending = await f.db.prepare('SELECT status,response_json FROM execution_worker_actions WHERE request_id=?').bind(input.requestId).first();
  assert.equal(pending.status, 'pending'); assert.equal(pending.response_json, null);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM backend_attestations').first()).n, 0);
  await f.noChecks();
  // The persisted permit remains available to the trusted original owner path.
  await reconcileBackend(f.db, f.owner, f.peer.env, f.run.id);
  assert.equal((await getRun(f.db, f.user.userId, f.run.id)).state, 'succeeded');
  assert.ok((await f.db.prepare('SELECT closed_at FROM execution_permits WHERE run_id=?').bind(f.run.id).first()).closed_at !== null);
});

test('registry drift blocks new execute claims and renewal without affecting the historical permit', async t => {
  const f = await fixture(t), l = await f.claim(f.w);
  const started = await startExecutionRun(f.db, f.w.principal, actionInput(f.run, l), f.peer.env);
  const changedRegistry = configuredRegistry(f.peer.env).map(operation => ({ ...operation, label: 'Changed definition' }));
  const changedContext = { ...f.owner, registry: changedRegistry };
  await assert.rejects(renewExecutionRun(f.db, f.w.principal, actionInput(f.run, l), changedContext), denied);
  const other = await f.worker(f.run), secret = randomBytes(32).toString('base64url');
  await assert.rejects(claimExecutionRun(f.db, other.principal, { runId: f.run.id, requestId: randomUUID(), leaseId: randomUUID(), verifier: hash(secret), mode: 'execute' }, changedContext), denied);
  assert.equal((await f.db.prepare('SELECT deadline_ms FROM execution_permits WHERE run_id=?').bind(f.run.id).first()).deadline_ms, started.permit.deadlineMs);
  await f.noChecks();
});
