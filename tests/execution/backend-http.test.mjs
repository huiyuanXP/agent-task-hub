import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './sqlite.mjs';
import { authorized } from './fixtures/authorization.mjs';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';
import { canonical, signRequest, verifyReply } from '../../lib/execution/transport.mts';
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
