import test from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { fixture } from './sqlite.mjs';
import { authorized } from './fixtures/authorization.mjs';
import { getOperationCatalog } from '../../lib/execution/catalog.mts';
import { prepareExecution, decideAuthorization } from '../../lib/execution/authorization.mts';
import { getRun, transitionRun } from '../../lib/execution/runs.mts';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';
import { canonical, signClaims, signReply, signRequest, verifyRequest, verifyReply } from '../../lib/execution/transport.mts';
import { sha256 } from '../../lib/execution/evidence.mts';
const api=await import('../../lib/execution/backend-http.mts').catch(()=>({}));
async function keys(id){const k=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);return {signing:{keyId:id,privateKey:k.privateKey},trust:{keyId:id,key:k.publicKey},private:JSON.stringify({keyId:id,jwk:await crypto.subtle.exportKey('jwk',k.privateKey)}),public:JSON.stringify({keyId:id,jwk:await crypto.subtle.exportKey('jwk',k.publicKey)})};}
test('checkpoint verifies narrow service authority before DB lookup, rejects unsigned identity and signs nonce-bound reply',async t=>{
  assert.equal(typeof api.handleCheckpoint,'function');const {db}=fixture(t);const {owner,run}=await authorized(db);const permit=await createDispatchPermit(db,owner,run.id);const node=await keys('node'),worker=await keys('worker');
  const env={DB:db,EXECUTION_CONTROL_KEY:worker.private,EXECUTION_RUNNER_KEY:node.public,EXECUTION_CHECKPOINT_AUDIENCE:'control'};
  let lookups=0;env.DB={...db,prepare(...args){lookups++;return db.prepare(...args);}};
  const body=canonical({permitId:permit.permitId,permitSha256:await sha256(canonical(permit)),deadlineMs:permit.deadlineMs});
  const url='http://127.0.0.1/api/execution/checkpoint';
  const unsigned=await api.handleCheckpoint(new Request(url,{method:'POST',headers:{'oai-authenticated-user-id':owner.owner},body}),env);assert.equal(unsigned.status,401);assert.equal(lookups,0);
  const signed=await signRequest(node.signing,{direction:'runner-to-control',audience:'control',method:'POST',path:'/api/execution/checkpoint',body});
  const request=()=>new Request(url,{method:'POST',headers:{'x-execution-signature':JSON.stringify(signed)},body});
  const response=await api.handleCheckpoint(request(),env);assert.equal(response.status,200);const text=await response.text();assert.equal(JSON.parse(text).allowed,true);
  assert.equal(await verifyReply(JSON.parse(response.headers.get('x-execution-signature')),worker.trust,signed,200,text),true);
  assert.equal((await api.handleCheckpoint(request(),env)).status,401);
});
test('missing configuration is distinct unavailable and never changes queued Run',async t=>{
  assert.equal(typeof api.handleBackendRequest,'function');const {db}=fixture(t);const {owner,run}=await authorized(db);
  const request=new Request('http://127.0.0.1/api/execution/dispatch',{method:'POST',headers:{origin:'http://127.0.0.1','content-type':'application/json'},body:JSON.stringify({action:'start',runId:run.id})});
  assert.equal((await api.handleBackendRequest(db,owner,request,{})).status,503);
  assert.equal((await db.prepare('SELECT state FROM execution_runs WHERE id=?').bind(run.id).first()).state,'queued');
  assert.equal((await api.handleBackendRequest(db,null,request,{})).status,401);
});
test('owner cancellation persists the outbox even when signing configuration or registry is unavailable',async t=>{
 for(const env of [{},{EXECUTION_REGISTRY:'not-json'}]){
  const {db}=fixture(t);const {owner,run}=await authorized(db);const permit=await createDispatchPermit(db,owner,run.id);const request=new Request('http://127.0.0.1/api/execution/dispatch',{method:'POST',headers:{origin:'http://127.0.0.1','content-type':'application/json'},body:JSON.stringify({action:'cancel',runId:run.id})});const response=await api.handleBackendRequest(db,owner,request,env);assert.equal(response.status,503);
  assert.equal((await db.prepare('SELECT state FROM execution_runs WHERE id=?').bind(run.id).first()).state,'cancelled');const row=await db.prepare('SELECT cancel_requested,closed_at FROM execution_permits WHERE id=?').bind(permit.permitId).first();assert.equal(row.cancel_requested,1);assert.equal(row.closed_at,null);
 }
});

// Fresh SQLite and synthetic signing keys exercise the real signed transport.
// This fixture is a protocol peer, not a Docker execution claim.
async function backend(t, handler) {
  const control = await keys('control'), runner = await keys('runner'), evidence = await keys('evidence');
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const signed = JSON.parse(request.headers['x-execution-signature']);
      assert.equal(await verifyRequest(signed, control.trust, { direction: 'control-to-runner', audience: 'runner', method: 'POST', path: request.url, body }), true);
      requests.push({ path: request.url, ...JSON.parse(body) });
      const result = await handler(request.url, JSON.parse(body), evidence.signing);
      const text = canonical(result.data);
      response.writeHead(result.status, { 'content-type': 'application/json', 'x-execution-signature': JSON.stringify(await signReply(runner.signing, signed, result.status, text)) });
      response.end(text);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { requests, env: { EXECUTION_RUNNER_URL: 'http://127.0.0.1:' + server.address().port, EXECUTION_RUNNER_AUDIENCE: 'runner', EXECUTION_CONTROL_KEY: control.private, EXECUTION_RUNNER_KEY: runner.public, EXECUTION_EVIDENCE_KEY: evidence.public } };
}
async function attestation(permit, signing, purpose = 'result') {
  return signClaims(signing, {
    version: 2, purpose, audience: 'control-plane', keyId: signing.keyId,
    owner: permit.owner, runId: permit.runId, ticketId: permit.ticketId, ticketRevision: permit.ticketRevision,
    attempt: permit.attempt, authorizationId: permit.authorizationId, contractSha256: permit.contractSha256,
    permitId: permit.permitId, permitSha256: await sha256(canonical(permit)), operationId: permit.operation.operationId,
    definitionHash: permit.operation.definitionHash, deadlineMs: permit.deadlineMs,
    backendId: 'ath-' + (await sha256(JSON.stringify([permit.owner, permit.runId, permit.attempt]))).slice(0, 40),
    status: purpose === 'result' ? 'startup_failed' : purpose === 'stop' ? 'stopped' : 'cancelled',
    process: null, exitCode: null, startedAt: null, endedAt: null, capturedAt: null, observedAt: Date.now(),
    artifacts: [], stdout: null, stderr: null, closure: purpose === 'stop' ? 'never_admitted' : null,
  });
}
async function secondRun(db, sqlite, owner) {
  const now = new Date().toISOString();
  sqlite.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').run('ticket-2', owner.owner, 'ticket', '{"title":"Second ticket","status":"todo"}', 1, now, now);
  const { operations } = await getOperationCatalog(db, owner, { ticketId: 'ticket-2', expectedRevision: 1 });
  const prepared = await prepareExecution(db, owner, { ticketId: 'ticket-2', expectedRevision: 1, requestId: 'second-permit', attempt: 1, scope: [{ operationId: operations[0].operationId, definitionHash: operations[0].definitionHash }], budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 60000 });
  await decideAuthorization(db, owner, { authorizationId: prepared.authorization.id, decisionId: 'approve-second', outcome: 'approved' });
  return prepared.run;
}
function executionSnapshot(sqlite) {
  return ['execution_runs', 'execution_permits', 'backend_attestations'].map(table => sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY id').all());
}
for (const path of ['/result', '/cancel']) for (const purpose of ['result', 'cancel_fence', 'stop']) {
  test(`reconcile ${path} rejects a trusted foreign ${purpose} receipt before ingesting any receipt`, async t => {
    const { db, sqlite } = fixture(t); const { owner, run } = await authorized(db);
    const permit = await createDispatchPermit(db, owner, run.id);
    const other = await secondRun(db, sqlite, owner); const foreign = await createDispatchPermit(db, owner, other.id);
    if (path === '/cancel') sqlite.prepare('UPDATE execution_permits SET cancel_requested=1 WHERE id=?').run(permit.permitId);
    const peer = await backend(t, async (_path, _input, signing) => ({ status: 200, data: { phase: 'stopped', receipts: [await attestation(permit, signing), await attestation(foreign, signing, purpose)] } }));
    const before = executionSnapshot(sqlite);
    await assert.rejects(api.reconcileBackend(db, owner, peer.env, run.id), { code: 'INVALID_EVIDENCE', status: 409 });
    assert.deepEqual(executionSnapshot(sqlite), before);
    assert.equal(peer.requests.length, 1); assert.equal(peer.requests[0].path, path);
    assert.equal(peer.requests[0].permit.permitId, permit.permitId);
  });
}
test('matching result and stop receipts retain terminal evidence and release only their own reservation', async t => {
  const { db, sqlite } = fixture(t); const { owner, run } = await authorized(db); const permit = await createDispatchPermit(db, owner, run.id);
  const other = await secondRun(db, sqlite, owner); const foreign = await createDispatchPermit(db, owner, other.id);
  const peer = await backend(t, async (_path, _input, signing) => ({ status: 200, data: { phase: 'stopped', receipts: [await attestation(permit, signing), await attestation(permit, signing, 'stop')] } }));
  const result = await api.reconcileBackend(db, { ...owner, executionRunId: run.id }, peer.env, run.id);
  assert.equal(result.run.state, 'failed'); assert.equal(result.backend.receipts.length, 2);
  assert.notEqual(sqlite.prepare('SELECT closed_at FROM execution_permits WHERE id=?').get(permit.permitId).closed_at, null);
  assert.equal(sqlite.prepare('SELECT closed_at FROM execution_permits WHERE id=?').get(foreign.permitId).closed_at, null);
  assert.equal((await getRun(db, owner.owner, other.id)).state, 'queued');
});
test('server-bound Run context rejects foreign reconcile and HTTP actions without reads, writes or transport', async t => {
  const { db, sqlite } = fixture(t); const { owner, run } = await authorized(db); const other = await secondRun(db, sqlite, owner);
  const scoped = { ...owner, executionRunId: run.id }; let reads = 0;
  const observed = { ...db, prepare(sql) { reads++; return db.prepare(sql); } };
  const before = executionSnapshot(sqlite);
  await assert.rejects(api.reconcileBackend(observed, scoped, {}, other.id), { code: 'NOT_FOUND', status: 404 });
  const url = 'http://127.0.0.1/api/execution/dispatch';
  for (const action of ['start', 'cancel', 'content']) {
    const response = await api.handleBackendRequest(observed, scoped, new Request(url, { method: 'POST', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, body: JSON.stringify({ action, runId: other.id, ...(action === 'content' ? { kind: 'stdout' } : {}) }) }), {});
    assert.equal(response.status, 404); assert.equal((await response.json()).code, 'NOT_FOUND');
  }
  const response = await api.handleBackendRequest(observed, scoped, new Request(url + '?runId=' + other.id), {});
  assert.equal(response.status, 404); assert.equal(reads, 0); assert.deepEqual(executionSnapshot(sqlite), before);
});
test('Run-scoped successor cannot reconcile its predecessor; owner recovery still closes retained occupation', async t => {
  const { db, sqlite } = fixture(t); const { owner, run } = await authorized(db); const permit = await createDispatchPermit(db, owner, run.id);
  await transitionRun(db, owner, { id: run.id, expectedVersion: run.version, to: 'cancelled' });
  const { operations } = await getOperationCatalog(db, owner, { ticketId: run.ticketId, expectedRevision: 1 });
  const next = await prepareExecution(db, owner, { ticketId: run.ticketId, expectedRevision: 1, requestId: 'successor', attempt: 2, scope: [{ operationId: operations[0].operationId, definitionHash: operations[0].definitionHash }], budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 60000 });
  let stop;
  const peer = await backend(t, async (_path, _input, signing) => ({ status: 200, data: { phase: 'stopped', receipts: [stop ??= await attestation(permit, signing, 'stop')] } }));
  const before = executionSnapshot(sqlite);
  const scoped = await api.reconcileBackend(db, { ...owner, executionRunId: next.run.id }, peer.env, next.run.id);
  assert.equal(scoped.backend, null); assert.equal(peer.requests.length, 0); assert.deepEqual(executionSnapshot(sqlite), before);
  const recovered = await api.reconcileBackend(db, owner, peer.env, next.run.id);
  assert.equal(recovered.backend, null); assert.equal(peer.requests.length, 2);
  assert.ok(peer.requests.every(request => request.permit.runId === run.id));
  assert.notEqual(sqlite.prepare('SELECT closed_at FROM execution_permits WHERE id=?').get(permit.permitId).closed_at, null);
  assert.equal((await getRun(db, owner.owner, run.id)).state, 'cancelled');
  assert.equal((await getRun(db, owner.owner, next.run.id)).state, 'queued');
});
