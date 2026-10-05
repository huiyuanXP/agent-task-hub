import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture, context } from './sqlite.mjs';
import { authorized } from './fixtures/authorization.mjs';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';
import { getRun, transitionRun } from '../../lib/execution/runs.mts';
import { canonical, signClaims } from '../../lib/execution/transport.mts';
import { sha256 } from '../../lib/execution/evidence.mts';
const api = await import('../../lib/execution/attestations.mts').catch(() => ({}));
async function receipt(permit, purpose = 'result', overrides = {}) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign','verify']);
  const startedAt = permit.issuedAt + 1; const endedAt = startedAt + 1;
  const claims = { version: 2, purpose, audience: 'control-plane', keyId: 'evidence', owner: permit.owner, runId: permit.runId, ticketId: permit.ticketId,
    ticketRevision: permit.ticketRevision, attempt: permit.attempt, authorizationId: permit.authorizationId, contractSha256: permit.contractSha256,
    permitId: permit.permitId, permitSha256: await sha256(canonical(permit)), operationId: permit.operation.operationId, definitionHash: permit.operation.definitionHash,
    deadlineMs: permit.deadlineMs, backendId: 'ath-' + createHash('sha256').update(JSON.stringify([permit.owner,permit.runId,permit.attempt])).digest('hex').slice(0,40), status: purpose === 'result' ? 'succeeded' : 'stopped',
    process: { containerId: 'c'.repeat(64), execId: 'e'.repeat(64) }, exitCode: 0, startedAt, endedAt, capturedAt: endedAt, observedAt: Date.now(),
    artifacts: purpose === 'result' ? [{ path: 'output/result.json', bytes: 2, sha256: await sha256('{}') }] : [],
    stdout: { sha256: await sha256(''), bytes: 0, truncated: false }, stderr: { sha256: await sha256(''), bytes: 0, truncated: false },
    closure: purpose === 'stop' ? 'removed' : null, ...overrides };
  return { signed: await signClaims({ keyId: 'evidence', privateKey: keys.privateKey }, claims), trust: { keyId: 'evidence', key: keys.publicKey }, keys };
}
test('verified v2 success arriving before running ack uses legal edges and retains exact bounded receipt', async t => {
  assert.equal(typeof api.ingestAttestation,'function'); const { db, sqlite } = fixture(t); const { owner, run } = await authorized(db); const p = await createDispatchPermit(db,owner,run.id);
  const { signed, trust } = await receipt(p);
  await api.ingestAttestation(db, { ...owner, evidenceTrust: trust }, signed);
  const saved = await getRun(db,owner.owner,run.id); assert.equal(saved.state,'succeeded'); assert.equal(saved.version,3); assert.deepEqual(saved.evidence,signed);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM backend_attestations').get().n,1);
  assert.equal(sqlite.prepare('SELECT closed_at FROM execution_permits').get().closed_at,null);
  await api.ingestAttestation(db, { ...owner,evidenceTrust:trust },signed); assert.equal((await getRun(db,owner.owner,run.id)).version,3);
});
test('startup failure has no fake start or success evidence; terminal Run keeps late history and only bound stop releases reservation', async t => {
  assert.equal(typeof api.ingestAttestation,'function'); const { db, sqlite } = fixture(t); const { owner,run } = await authorized(db); const p = await createDispatchPermit(db,owner,run.id);
  await transitionRun(db,owner,{ id:run.id,expectedVersion:1,to:'cancelled' });
  const failed = await receipt(p,'result',{ status:'startup_failed',process:null,exitCode:null,startedAt:null,endedAt:null,capturedAt:null,artifacts:[],stdout:null,stderr:null });
  await api.ingestAttestation(db,{...owner,evidenceTrust:failed.trust},failed.signed);
  assert.equal((await getRun(db,owner.owner,run.id)).state,'cancelled'); assert.equal((await getRun(db,owner.owner,run.id)).evidence,null);
  const fence = await receipt(p,'cancel_fence',{status:'cancelled',closure:null}); await api.ingestAttestation(db,{...owner,evidenceTrust:fence.trust},fence.signed);
  assert.equal(sqlite.prepare('SELECT closed_at FROM execution_permits').get().closed_at,null);
  const stop = await receipt(p,'stop',{ observedAt:p.deadlineMs+100, closure:'removed' });
  await api.ingestAttestation(db,{...owner,evidenceTrust:stop.trust},stop.signed);
  assert.notEqual(sqlite.prepare('SELECT closed_at FROM execution_permits').get().closed_at,null);
  assert.throws(()=>sqlite.exec("UPDATE backend_attestations SET purpose='stop'"));
});
test('v2 purpose/audience/permit/operation/deadline and declared artifact binding reject signed mismatches', async t => {
  assert.equal(typeof api.ingestAttestation,'function'); const { db } = fixture(t); const { owner,run } = await authorized(db); const p = await createDispatchPermit(db,owner,run.id);
  for (const change of [{backendId:'ath-'+'f'.repeat(40)}, {audience:'guest'}, {permitId:'wrong'}, {permitSha256:'b'.repeat(64)}, {definitionHash:'c'.repeat(64)}, {endedAt:p.deadlineMs+1}, {capturedAt:p.deadlineMs+1}, {artifacts:[]}, {purpose:'stop',closure:null}, {exitCode:1}]) {
    const {signed,trust}=await receipt(p,'result',change); await assert.rejects(api.ingestAttestation(db,{...owner,evidenceTrust:trust},signed));
  }
  assert.equal((await getRun(db,context.owner,run.id)).state,'queued');
});
test('physical cancellation remains available for every absorbing terminal Run without rewriting history',async t=>{
 const dispatch=await import('../../lib/execution/dispatch.mts');assert.equal(typeof dispatch.requestPermitCancellation,'function');
 for(const terminal of ['succeeded','failed','cancelled']){
  const {db}=fixture(t);const {owner,run}=await authorized(db);const p=await createDispatchPermit(db,owner,run.id);
  if(terminal==='succeeded'){const result=await receipt(p);await api.ingestAttestation(db,{...owner,evidenceTrust:result.trust},result.signed);}else await transitionRun(db,owner,{id:run.id,expectedVersion:1,to:terminal});
  const before=await getRun(db,owner.owner,run.id);await assert.rejects(dispatch.requestPermitCancellation(db,'foreign-owner',run.id));
  for(let retry=0;retry<2;retry++){const intent=await dispatch.requestPermitCancellation(db,owner.owner,run.id);assert.equal(intent.cancel_requested,1);assert.equal(intent.closed_at,null);assert.deepEqual(await getRun(db,owner.owner,run.id),before);}
  const stop=await receipt(p,'stop');await api.ingestAttestation(db,{...owner,evidenceTrust:stop.trust},stop.signed);assert.notEqual((await dispatch.permitForRun(db,owner.owner,run.id)).closed_at,null);assert.deepEqual(await getRun(db,owner.owner,run.id),before);
 }
});
