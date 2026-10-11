// Actual built native server, two independent clients, fresh accounts/SQLite and
// an owned signed loopback peer. This suite does not assert Docker execution.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { localFixture, fixtureEnvironment } from '../local/fixture.mjs';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';
import { configuredRegistry } from '../../lib/execution/backend-config.mts';
import { workerBackendFixture } from './fixtures/worker-backend.mjs';

const peer = await workerBackendFixture();
let f;
const children = new Set();
const machine = '/api/execution/worker-mcp';
const hash = value => createHash('sha256').update(value).digest('hex');
const bearer = token => ({ authorization: `Bearer ${token}` });
const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const tools = ['get_execution_run', 'list_execution_runs', 'claim_execution_run', 'start_execution_run', 'renew_execution_run', 'report_execution_run', 'complete_execution_run', 'cancel_execution_run'];
async function request(path, body, token = f.aliceToken) {
  const response = await fetch(f.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...bearer(token), ...(body === undefined ? {} : { origin: f.origin, 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 1024 * 1024);
  return { status: response.status, json: JSON.parse(text), text };
}
async function api(status, path, body, token) {
  const response = await request(path, body, token); assert.equal(response.status, status, `Unexpected native HTTP status at ${path}`); return response.json;
}
const rpcBody = (name, args = {}) => ({ jsonrpc: '2.0', id: '租约🌈"\\', method: 'tools/call', params: { name, arguments: args } });
async function rpc(worker, name, args = {}) {
  const response = await request(machine, rpcBody(name, args), worker.token);
  assert.equal(response.status, 200); return response;
}
function result(response) {
  assert.ok(response.json.result, `Expected RPC success: ${response.json.error?.data?.code ?? response.status}`);
  assert.deepEqual(JSON.parse(response.json.result.content[0].text), response.json.result.structuredContent);
  return response.json.result.structuredContent;
}
function rejected(response, status, code) {
  assert.equal(response.json.error.data.status, status); if (code) assert.equal(response.json.error.data.code, code);
}
function safe(response, worker, lease) {
  for (const secret of [worker.secret, worker.body.verifier, f.aliceToken, hash(f.aliceToken), f.alice.userId, ...(lease ? [lease.secret, lease.token, lease.input.verifier] : [])]) assert.ok(!response.text.includes(secret), 'Private data leaked from native Worker action');
  for (const key of ['owner', 'actor', 'evidence', 'signature', 'receipts', 'ticketBody', 'envelope', 'leaseToken', 'verifier']) assert.ok(!new RegExp(`"${key}"\\s*:`).test(response.text), `Private response field: ${key}`);
}
async function prepared(ticketId = randomUUID(), expiresAt = Date.now() + 600000) {
  const now = new Date().toISOString();
  await f.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind(ticketId, f.alice.userId, 'ticket', JSON.stringify({ title: 'Native synthetic lease', status: 'todo', project: 'Synthetic' }), 1, now, now).run();
  const catalog = await api(200, `/api/authorization?ticketId=${ticketId}&expectedRevision=1`);
  const prepared = await api(201, '/api/authorization', { action: 'prepare', ticketId, expectedRevision: 1, requestId: randomUUID(), attempt: 1, scope: catalog.operations.slice(0, 1).map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt });
  await api(200, '/api/authorization', { action: 'decide', authorizationId: prepared.authorization.id, decisionId: randomUUID(), outcome: 'approved' });
  return prepared.run;
}
async function worker(run) {
  const secret = randomBytes(32).toString('base64url');
  const body = { action: 'provision', runId: run.id, credentialId: randomUUID(), requestId: randomUUID(), verifier: hash(secret), label: 'Native synthetic lease Worker' };
  const credential = (await api(201, '/api/execution/workers', body)).worker;
  return { secret, body, credential, token: `athw1.${credential.credentialId}.${secret}` };
}
function claimInput(run, mode = 'execute') {
  const secret = randomBytes(32).toString('base64url');
  return { secret, input: { runId: run.id, requestId: randomUUID(), leaseId: randomUUID(), verifier: hash(secret), mode } };
}
function leased(claim, value) { return { ...claim, lease: value, token: `athl1.${value.leaseId}.${value.generation}.${claim.secret}` }; }
const action = (run, lease, requestId = randomUUID()) => ({ runId: run.id, requestId, leaseToken: lease.token });
async function claim(w, run, mode = 'execute') {
  const c = claimInput(run, mode); return leased(c, result(await rpc(w, 'claim_execution_run', c.input)));
}
async function disconnectAfterHeaders(worker, body) {
  return new Promise((resolve, reject) => {
    let disconnected = false;
    const req = httpRequest(new URL(machine, f.origin), { method: 'POST', headers: { ...bearer(worker.token), origin: f.origin, 'content-type': 'application/json' } }, res => {
      if (res.statusCode !== 200) { res.destroy(); req.destroy(); reject(new Error('Native lost-reply HTTP status')); return; }
      disconnected = true;
      res.on('error', error => { if (error.code !== 'ECONNRESET' && error.code !== 'ERR_STREAM_DESTROYED') reject(error); });
      res.destroy(); req.destroy(); resolve();
    });
    req.on('error', error => { if (!disconnected || (error.code !== 'ECONNRESET' && error.code !== 'ERR_STREAM_DESTROYED')) reject(error); });
    req.end(JSON.stringify(body));
  });
}
async function childClaim(w, input) {
  // Send synthetic credentials over stdin, never process arguments or inherited
  // account environment. Each process performs its own real HTTP request.
  const code = "let text='';for await(const c of process.stdin)text+=c;const i=JSON.parse(text);const r=await fetch(i.origin+i.path,{method:'POST',headers:{authorization:'Bearer '+i.token,origin:i.origin,'content-type':'application/json'},body:JSON.stringify(i.body)});process.stdout.write(JSON.stringify({status:r.status,json:await r.json()}));";
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: fixtureEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let output = '', stderr = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  child.stdin.end(JSON.stringify({ origin: f.origin, path: machine, token: w.token, body: rpcBody('claim_execution_run', input) }));
  const [exitCode] = await exited; children.delete(child);
  assert.equal(exitCode, 0, `Owned client process failed: ${stderr}`); return JSON.parse(output);
}

try {
  f = await localFixture({ env: peer.env });
  const run = await prepared(), workers = await Promise.all([worker(run), worker(run)]), claims = [claimInput(run), claimInput(run)];
  const discovery = await request(machine, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, workers[0].token);
  assert.deepEqual(discovery.json.result.tools.map(tool => tool.name).sort(), tools.slice().sort());
  rejected(await rpc(workers[0], 'prepare_execution', {}), 403, 'AUTHORIZATION_DENIED');
  const races = await Promise.all(workers.map((w, index) => childClaim(w, claims[index].input)));
  assert.ok(races.every(response => response.status === 200));
  const winner = races.findIndex(response => response.json.result), loser = 1 - winner;
  assert.ok(winner >= 0); assert.equal(races.filter(response => response.json.result).length, 1);
  rejected(races[loser], 403, 'AUTHORIZATION_DENIED');
  let l = leased(claims[winner], races[winner].json.result.structuredContent), w = workers[winner];
  assert.equal(l.lease.generation, 1); assert.ok(l.lease.expiresAt <= l.lease.createdAt + 6000);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_worker_leases WHERE run_id=?').bind(run.id).first()).n, 1);
  rejected(await rpc(w, 'claim_execution_run', { ...l.input, leaseId: randomUUID() }), 409, 'REQUEST_CONFLICT');

  const startInput = action(run, l);
  await disconnectAfterHeaders(w, rpcBody('start_execution_run', startInput));
  const persisted = await f.db.prepare('SELECT id,deadline_ms FROM execution_permits WHERE run_id=?').bind(run.id).first();
  const startedResponse = await rpc(w, 'start_execution_run', startInput), started = result(startedResponse);
  assert.equal(started.permit.permitId, persisted.id); assert.equal(started.permit.deadlineMs, persisted.deadline_ms);
  assert.equal(peer.requests.filter(row => row.path === '/start' && row.permit.runId === run.id).length, 1); safe(startedResponse, w, l);
  const renewInput = action(run, l);
  await disconnectAfterHeaders(w, rpcBody('renew_execution_run', renewInput));
  const persistedRenew = await f.db.prepare('SELECT expires_at FROM execution_worker_leases WHERE lease_id=?').bind(l.lease.leaseId).first();
  const renewedResponse = await rpc(w, 'renew_execution_run', renewInput), renewed = result(renewedResponse);
  assert.equal(renewed.expiresAt, persistedRenew.expires_at); safe(renewedResponse, w, l);
  l.lease = renewed;
  rejected(await rpc(w, 'report_execution_run', { ...renewInput, message: 'same request different kind' }), 409, 'REQUEST_CONFLICT');
  const reportInput = { ...action(run, l), message: '界'.repeat(2048) };
  const report = await rpc(w, 'report_execution_run', reportInput); result(report); safe(report, w, l);
  rejected(await rpc(w, 'report_execution_run', { ...reportInput, message: 'changed' }), 409, 'REQUEST_CONFLICT');
  rejected(await rpc(w, 'report_execution_run', { ...action(run, l), message: '界'.repeat(2049) }), 400, 'INVALID_INPUT');
  for (const extra of [{ state: 'succeeded' }, { evidence: {} }, { trust: {} }, { grantAuthority: 'owner' }]) rejected(await rpc(w, 'report_execution_run', { ...action(run, l), message: 'spoof', ...extra }), 400, 'INVALID_INPUT');
  rejected(await rpc(w, 'complete_execution_run', action(run, l)), 409, 'INVALID_EVIDENCE');
  const originalDeadline = persisted.deadline_ms;
  await delay(l.lease.expiresAt - Date.now() + 40);
  const next = await claim(workers[loser], run);
  assert.equal(next.lease.generation, 2);
  for (const name of ['start_execution_run', 'renew_execution_run', 'report_execution_run', 'complete_execution_run', 'cancel_execution_run']) rejected(await rpc(w, name, { ...action(run, l, name === 'start_execution_run' ? startInput.requestId : randomUUID()), ...(name === 'report_execution_run' ? { message: 'stale' } : {}) }), 403, 'AUTHORIZATION_DENIED');
  const oldClaimReplay = result(await rpc(w, 'claim_execution_run', l.input));
  assert.deepEqual(oldClaimReplay, races[winner].json.result.structuredContent, 'Claim replay returns its original metadata without reviving authority');
  assert.ok(oldClaimReplay.expiresAt < Date.now());
  assert.equal((await f.db.prepare('SELECT expires_at FROM execution_worker_leases WHERE lease_id=?').bind(l.lease.leaseId).first()).expires_at, persistedRenew.expires_at);
  assert.equal((await f.db.prepare('SELECT max(generation) AS n FROM execution_worker_leases WHERE run_id=?').bind(run.id).first()).n, 2);
  const nextStart = result(await rpc(workers[loser], 'start_execution_run', action(run, next)));
  assert.equal(nextStart.permit.permitId, persisted.id); assert.equal(nextStart.permit.deadlineMs, originalDeadline);
  peer.setResult(run.id, { phase: 'stopped', purposes: ['result', 'stop'] });
  const completion = await rpc(workers[loser], 'complete_execution_run', action(run, next)), complete = result(completion);
  assert.equal(complete.run.state, 'succeeded'); assert.ok(complete.permit.closedAt !== null); safe(completion, workers[loser], next);
  rejected(await rpc(workers[loser], 'report_execution_run', { ...action(run, next), message: 'terminal report' }), 403, 'AUTHORIZATION_DENIED');
  console.log('Native leases: two independent client processes, one winner, six-second generation takeover, stale-cache denial, fixed permit/deadline, safe reports and signed result/stop PASS');

  // Disconnect the claim response itself, then replay client-persisted ID/secret/input.
  const lostRun = await prepared(), lostWorker = await worker(lostRun), lostClaim = claimInput(lostRun);
  await disconnectAfterHeaders(lostWorker, rpcBody('claim_execution_run', lostClaim.input));
  const persistedClaim = await f.db.prepare('SELECT lease_id,generation,created_at,expires_at FROM execution_worker_leases WHERE lease_id=?').bind(lostClaim.input.leaseId).first();
  const lostLeaseResponse = await rpc(lostWorker, 'claim_execution_run', lostClaim.input), lostLease = leased(lostClaim, result(lostLeaseResponse));
  assert.equal(lostLease.lease.leaseId, persistedClaim.lease_id); assert.equal(lostLease.lease.generation, persistedClaim.generation);
  assert.equal(lostLease.lease.createdAt, persistedClaim.created_at); assert.equal(lostLease.lease.expiresAt, persistedClaim.expires_at); safe(lostLeaseResponse, lostWorker, lostLease);
  await f.stop(); await f.start();
  assert.deepEqual(result(await rpc(lostWorker, 'claim_execution_run', lostClaim.input)), lostLease.lease);

  for (const invalidation of ['revoke', 'revision', 'expiry']) {
    const expiresAt = Date.now() + (invalidation === 'expiry' ? 2500 : 600000);
    const currentRun = await prepared(randomUUID(), expiresAt), currentWorker = await worker(currentRun), currentLease = await claim(currentWorker, currentRun);
    if (invalidation === 'revoke') await api(200, '/api/authorization', { action: 'revoke', authorizationId: currentRun.authorizationId, decisionId: randomUUID() });
    else if (invalidation === 'revision') await api(200, '/api/records', { id: currentRun.ticketId, kind: 'ticket', revision: 1, title: 'Changed live Ticket', status: 'todo', project: 'Synthetic' });
    else { assert.ok(currentLease.lease.expiresAt <= expiresAt); await delay(expiresAt - Date.now() + 40); }
    rejected(await rpc(currentWorker, 'renew_execution_run', action(currentRun, currentLease)), 403, 'AUTHORIZATION_DENIED');
    rejected(await rpc(currentWorker, 'start_execution_run', action(currentRun, currentLease)), 403, 'AUTHORIZATION_DENIED');
    const fresh = claimInput(currentRun);
    rejected(await rpc(currentWorker, 'claim_execution_run', fresh.input), 403, 'AUTHORIZATION_DENIED');
    assert.equal(await f.db.prepare('SELECT id FROM execution_permits WHERE run_id=?').bind(currentRun.id).first(), null);
  }

  const historical = await prepared(), historicalWorker = await worker(historical);
  const permit = await createDispatchPermit(f.db, { owner: f.alice.userId, actor: f.alice.userId, grantAuthority: 'owner', registry: configuredRegistry(peer.env) }, historical.id);
  await api(200, '/api/authorization', { action: 'revoke', authorizationId: historical.authorizationId, decisionId: randomUUID() });
  const recovery = await claim(historicalWorker, historical, 'reconcile');
  for (const name of ['start_execution_run', 'renew_execution_run', 'report_execution_run']) rejected(await rpc(historicalWorker, name, { ...action(historical, recovery), ...(name === 'report_execution_run' ? { message: 'historical report' } : {}) }), 403, 'AUTHORIZATION_DENIED');
  peer.setResult(historical.id, { phase: 'cancel_pending', purposes: ['cancel_fence'], cancelPurposes: ['cancel_fence'] });
  const cancelled = result(await rpc(historicalWorker, 'cancel_execution_run', action(historical, recovery)));
  assert.equal(cancelled.run.state, 'cancelled'); assert.equal(cancelled.permit.closedAt, null); assert.equal(cancelled.permit.cancelRequested, true);
  peer.setResult(historical.id, { phase: 'stopped', purposes: ['cancel_fence', 'stop'], cancelPurposes: ['cancel_fence', 'stop'] });
  const stopped = result(await rpc(historicalWorker, 'cancel_execution_run', action(historical, recovery)));
  assert.ok(stopped.permit.closedAt !== null); assert.equal(stopped.permit.permitId, permit.permitId); assert.equal(stopped.permit.deadlineMs, permit.deadlineMs);
  const noPermitRun = await prepared(), noPermitWorker = await worker(noPermitRun);
  rejected(await rpc(noPermitWorker, 'claim_execution_run', claimInput(noPermitRun, 'reconcile').input), 403, 'AUTHORIZATION_DENIED');
  console.log('Native leases: claim/renew reply disconnect and restart stability, live approval/revision fences, natural approval expiry, historical reconcile cancellation and distinct signed fence/stop PASS');

  const delayed = await prepared(), delayedWorker = await worker(delayed), delayedLease = await claim(delayedWorker, delayed);
  const delayedStart = result(await rpc(delayedWorker, 'start_execution_run', action(delayed, delayedLease)));
  peer.setResult(delayed.id, { phase: 'stopped', purposes: ['result', 'stop'] });
  const hold = peer.holdNext('/result', delayed.id), delayedInput = action(delayed, delayedLease);
  const pending = rpc(delayedWorker, 'complete_execution_run', delayedInput);
  await hold.entered;
  await api(200, '/api/execution/workers', { action: 'revoke', credentialId: delayedWorker.credential.credentialId, requestId: randomUUID() });
  hold.release(); rejected(await pending, 403, 'AUTHORIZATION_DENIED');
  assert.equal((await f.db.prepare('SELECT state FROM execution_runs WHERE id=?').bind(delayed.id).first()).state, 'queued');
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM backend_attestations WHERE permit_id=?').bind(delayedStart.permit.permitId).first()).n, 0);
  assert.equal((await f.db.prepare('SELECT status FROM execution_worker_actions WHERE request_id=?').bind(delayedInput.requestId).first()).status, 'pending');
  const ownerRecovered = await api(200, `/api/execution/dispatch?runId=${delayed.id}`);
  assert.equal(ownerRecovered.run.state, 'succeeded');
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_worker_checks').first()).n, 0);
  assert.deepEqual(peer.errors, []);
  console.log('Native actions: mid-response Worker revocation blocks signed receipt ingestion and completion; existing owner recovery consumes the same persisted permit PASS');
} finally {
  for (const child of children) child.kill('SIGKILL');
  try { await f?.close(); } finally { await peer.close(); }
}
