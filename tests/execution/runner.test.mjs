import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { operationDescriptor, REGISTERED_OPERATIONS } from '../../lib/execution/catalog.mts';
import { sha256 } from '../../lib/execution/evidence.mts';
import { signReply, verifyRequest, signedFetch } from '../../lib/execution/transport.mts';
import { verifyAttestation } from '../../lib/execution/attestations.mts';
import { cleanupFixture } from './fixtures/cleanup.mjs';
const api = await import('../../runner/server.mjs').catch(() => ({}));
async function keys(keyId) { const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']); return {signing:{keyId,privateKey:pair.privateKey},trust:{keyId,key:pair.publicKey}}; }
async function harness(t,registry,sourceRoots={}) {
  const root=await mkdtemp(join(tmpdir(),'execution-runner-')); const worker=await keys('control'),node=await keys('node'),evidence=await keys('evidence');
  let allowed=true;
  const checkpoint=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;const signed=JSON.parse(req.headers['x-execution-signature']??'null');
    const ok=await verifyRequest(signed,node.trust,{direction:'runner-to-control',audience:'control',method:req.method,path:req.url,body});
    if(!ok){res.writeHead(401);res.end();return;} const data=JSON.stringify({allowed,deadlineMs:JSON.parse(body).deadlineMs});
    res.writeHead(200,{'x-execution-signature':JSON.stringify(await signReply(worker.signing,signed,200,data))});res.end(data);});
  await new Promise(r=>checkpoint.listen(0,'127.0.0.1',r));
  const config={root,registry,sourceRoots,controlTrust:worker.trust,transportKey:node.signing,evidenceKey:evidence.signing,audience:'runner',checkpoint:{baseUrl:`http://127.0.0.1:${checkpoint.address().port}`,audience:'control',direction:'runner-to-control',signing:node.signing,trust:worker.trust}};
  const server=await api.startSupervisor(config);
  t.after(async()=>{if(!t.passed){await mkdir('test-results',{recursive:true});const summaries=[];for(const name of await readdir(join(root,'journal'))){if(!name.endsWith('.json'))continue;const j=JSON.parse(await readFile(join(root,'journal',name),'utf8'));summaries.push({backendId:j.backendId,phase:j.phase,failure:j.failure,receipts:j.receipts});}await writeFile('test-results/runner-failure-'+Date.now()+'.log',JSON.stringify(summaries,null,2));}await server.close();await new Promise(r=>checkpoint.close(r));await cleanupFixture(root);await rm(root,{recursive:true,force:true});});
  const client={baseUrl:server.url,audience:'runner',direction:'control-to-runner',signing:worker.signing,trust:node.trust};
  return {server,client,evidence,config,revoke(){allowed=false;},async outage(){await new Promise(r=>checkpoint.close(r));}};
}
async function permit(definition=REGISTERED_OPERATIONS[0],timeoutMs=30000) {
  const ticketBody='{"title":"Actual runner"}',issuedAt=Date.now();
  return {version:1,permitId:crypto.randomUUID(),owner:'synthetic-owner',runId:crypto.randomUUID(),ticketId:'ticket',ticketRevision:1,attempt:1,authorizationId:crypto.randomUUID(),contractSha256:await sha256(ticketBody),ticketBody,operation:await operationDescriptor(ticketBody,definition),budget:{timeoutMs,memoryMb:256,cpus:1,pids:64},issuedAt,deadlineMs:issuedAt+timeoutMs,expiresAt:issuedAt+60000};
}
async function poll(client,p) {let last;const until=Date.now()+40000;while(Date.now()<until){const r=await signedFetch(client,'/result',{permit:p});last=r;if(r.data.receipts?.some(r=>r.claims.purpose==='stop'))return r.data;await new Promise(r=>setTimeout(r,100));}throw Error('Result poll deadline: '+JSON.stringify(last));}
test('actual authenticated supervisor dispatch is asynchronous, idempotent, retains verified bytes and rejects unsigned requests',async t=>{
  assert.equal(typeof api.startSupervisor,'function');const h=await harness(t);const p=await permit();
  const unsigned=await fetch(h.server.url+'/start',{method:'POST',body:JSON.stringify({permit:p})});assert.equal(unsigned.status,401);
  const start=await signedFetch(h.client,'/start',{permit:p});assert.equal(start.status,202);assert.match(start.data.backendId,/^ath-/);
  const again=await signedFetch(h.client,'/start',{permit:p});assert.equal(again.data.backendId,start.data.backendId);
  const final=await poll(h.client,p);const result=final.receipts.find(r=>r.claims.purpose==='result');assert.equal(result.claims.status,'succeeded');assert.equal(await verifyAttestation(result,p,h.evidence.trust),true);
  const content=await signedFetch(h.client,'/content',{permit:p,kind:'artifact',path:'output/result.json'},2097152);
  const bytes=Buffer.from(content.data.base64,'base64');assert.equal(JSON.parse(bytes.toString()).title,'Actual runner');assert.equal(await sha256(bytes.toString()),result.claims.artifacts[0].sha256);
  assert.equal((await signedFetch(h.client,'/content',{permit:p,kind:'artifact',path:'../../etc/passwd'})).status,400);
  assert.equal((await signedFetch(h.client,'/start',{permit:{...p,ticketId:'changed'}})).status,409);
  await h.server.close();const recovered=await api.startSupervisor(h.config);h.server.close=()=>recovered.close();h.client.baseUrl=recovered.url;
  assert.equal((await signedFetch(h.client,'/result',{permit:p})).data.receipts.find(r=>r.claims.purpose==='result').signature,result.signature);
  assert.equal((await signedFetch(h.client,'/content',{permit:p,kind:'artifact',path:'output/result.json'},2097152)).data.base64,content.data.base64);
  await rm(join(h.config.root,'state',start.data.backendId,'artifacts.json'));
  assert.equal((await signedFetch(h.client,'/content',{permit:p,kind:'artifact',path:'output/result.json'},2097152)).status,503);
  assert.equal((await signedFetch(h.client,'/result',{permit:p})).data.receipts.find(r=>r.claims.purpose==='result').signature,result.signature);
});
test('durable cancellation before delayed admission permanently fences identity and attests never admitted',async t=>{
  assert.equal(typeof api.startSupervisor,'function');const h=await harness(t);const p=await permit();
  const cancelled=await signedFetch(h.client,'/cancel',{permit:p});assert.equal(cancelled.status,200);
  assert.equal((await signedFetch(h.client,'/start',{permit:p})).status,409);
  const final=await poll(h.client,p);assert.equal(final.receipts.find(r=>r.claims.purpose==='stop').claims.closure,'never_admitted');
});
test('registered nonzero, unavailable pinned image and slow command produce truthful different outcomes',async t=>{
  assert.equal(typeof api.startSupervisor,'function');const defs=[
    {...REGISTERED_OPERATIONS[0],operationId:'nonzero',argv:['node','-e','process.stdout.write("real failure");process.exit(7)'],inputs:[],artifacts:[]},
    {...REGISTERED_OPERATIONS[0],operationId:'missing',image:'node@sha256:'+'f'.repeat(64)},
    {...REGISTERED_OPERATIONS[0],operationId:'slow',argv:['node','-e','setTimeout(()=>{},60000)'],inputs:[],artifacts:[]}];
  const h=await harness(t,defs);
  for(const [definition,expected,timeout] of [[defs[0],'command_failed',30000],[defs[1],'startup_failed',30000],[defs[2],'timed_out',30000]]){
    const p=await permit(definition,timeout);assert.equal((await signedFetch(h.client,'/start',{permit:p})).status,202);const result=(await poll(h.client,p)).receipts.find(r=>r.claims.purpose==='result');
    assert.equal(result.claims.status,expected);assert.equal(await verifyAttestation(result,p,h.evidence.trust),true);
    if(expected==='timed_out')assert.notEqual(result.claims.startedAt,null,'Registered slow command must actually start');if(expected==='startup_failed'){assert.equal(result.claims.startedAt,null);assert.equal(result.claims.exitCode,null);}if(expected==='command_failed')assert.equal(result.claims.exitCode,7);
  }
});
test('expired setup uncertainty stays physically pending until the guardian removes late resources and polling reconciles closure',async t=>{
 const h=await harness(t);await h.server.close();const p=await permit(REGISTERED_OPERATIONS[0],500);
 const disk=await import('../../runner/state.mjs'),work=await import('../../runner/workspaces.mjs'),docker=await import('../../runner/docker.mjs');
 const w=await work.createWorkspace(join(h.config.root,'state'),{owner:p.owner,runId:p.runId,attempt:p.attempt,deadlineMs:p.deadlineMs},{...p.operation.policy,ceilings:p.budget});
 await disk.withWorkspace(w,async(state,save)=>{state.state='importing';state.creates.volume='intent';state.creates.importer='intent';await save();});
 const job={version:1,backendId:w.id,permit:p,phase:'setup',fenced:false,cancelReason:null,workspace:w,process:null,startedAt:null,endedAt:null,capturedAt:null,exitCode:null,stdout:null,stderr:null,artifacts:[],receipts:[]};
 await disk.atomicWrite(join(h.config.root,'journal'),w.id+'.json',Buffer.from(JSON.stringify(job)));
 await new Promise(r=>setTimeout(r,Math.max(0,p.deadlineMs-Date.now()+10)));
 const recovered=await api.startSupervisor(h.config);h.server.close=()=>recovered.close();h.client.baseUrl=recovered.url;
 const pending=(await signedFetch(h.client,'/result',{permit:p})).data;assert.equal(pending.receipts.some(r=>r.claims.purpose==='stop'),false);
 const result=pending.receipts.find(r=>r.claims.purpose==='result');assert.equal(result.claims.status,'timed_out');assert.equal(result.claims.startedAt,null);assert.equal(result.claims.deadlineMs,p.deadlineMs);
 const state=await work.inspectWorkspace(w);await docker.request('POST','/volumes/create',{body:{Name:state.volumeName,Labels:docker.labels(state)}});
 const created=await docker.request('POST',`/containers/create?name=${state.importerName}`,{body:docker.containerConfig(state,true),timeoutMs:20000});const observed=await docker.inspectContainer(created.Id);if(observed)assert.equal(observed.State.Running,false);
 const until=Date.now()+8000;while(Date.now()<until&&(await work.inspectWorkspace(w)).state!=='removed')await new Promise(r=>setTimeout(r,100));assert.equal((await work.inspectWorkspace(w)).state,'removed');
 const final=await poll(h.client,p);assert.equal(pending.phase,'cleanup_pending');assert.equal(final.phase,'closed');assert.equal(final.receipts.find(r=>r.claims.purpose==='stop').claims.closure,'removed');assert.equal(await docker.inspectContainer(created.Id),null);
});
test('uncertain exec recovery never infers success from an unstarted exec or repeats a fast completed exec',async t=>{
 for(const didStart of [false,true]){
  const h=await harness(t);await h.server.close();const p=await permit();
  const disk=await import('../../runner/state.mjs'),work=await import('../../runner/workspaces.mjs'),docker=await import('../../runner/docker.mjs');
  const w=await work.createWorkspace(join(h.config.root,'state'),{owner:p.owner,runId:p.runId,attempt:p.attempt,deadlineMs:p.deadlineMs},{...p.operation.policy,ceilings:p.budget});
  const source=join(h.config.root,'source');await mkdir(join(source,'input'),{recursive:true});await writeFile(join(source,'input/ticket.json'),p.ticketBody);
  await work.importInputs(w,source,p.operation.inputs);const container=await work.startWorkspace(w);const exec=await work.createExecution(w,p.operation.argv);
  if(didStart)await work.startExecution(w,exec.id);
  const observed=await docker.inspectExec(exec.id);assert.equal(observed.Running,false);assert.equal(observed.ExitCode,didStart?0:null);
  const job={version:1,backendId:w.id,permit:p,phase:'start_intent',fenced:false,cancelReason:null,workspace:w,process:{containerId:container.containerId,execId:exec.id},startedAt:null,endedAt:null,capturedAt:null,exitCode:null,stdout:null,stderr:null,artifacts:[],receipts:[]};
  await disk.atomicWrite(join(h.config.root,'journal'),w.id+'.json',Buffer.from(JSON.stringify(job)));
  const recovered=await api.startSupervisor(h.config);h.server.close=()=>recovered.close();h.client.baseUrl=recovered.url;
  const final=await poll(h.client,p);const result=final.receipts.find(r=>r.claims.purpose==='result');assert.equal(result.claims.status,'evidence_unavailable');assert.equal(result.claims.startedAt,null);assert.equal(result.claims.exitCode,null);assert.equal(result.claims.process.execId,exec.id);
  assert.equal((await signedFetch(h.client,'/start',{permit:p})).status,409);assert.equal(await docker.inspectContainer(container.containerId),null);
 }
});
test('fresh checkpoint gates execution and running denial cancels within bounded grace without renewing deadline',async t=>{
 const definition={...REGISTERED_OPERATIONS[0],operationId:'checkpoint.slow',argv:['node','-e','setTimeout(()=>{},60000)'],inputs:[],artifacts:[]};
 const h=await harness(t,[definition]);const p=await permit(definition);assert.equal((await signedFetch(h.client,'/start',{permit:p})).status,202);
 const until=Date.now()+20000;let running;while(Date.now()<until){running=await signedFetch(h.client,'/result',{permit:p});if(running.data.phase==='running')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(running.data.phase,'running');const revokedAt=Date.now();h.revoke();const result=(await poll(h.client,p)).receipts.find(r=>r.claims.purpose==='result');assert.equal(result.claims.status,'cancelled');assert.equal(result.claims.deadlineMs,p.deadlineMs);assert.ok(Date.now()-revokedAt<10000);assert.notEqual(result.claims.startedAt,null);
 const next=await permit(definition);assert.equal((await signedFetch(h.client,'/start',{permit:next})).status,202);const denied=(await poll(h.client,next)).receipts.find(r=>r.claims.purpose==='result');assert.equal(denied.claims.status,'startup_failed');assert.equal(denied.claims.startedAt,null);
});
test('no-output registered success retains bounded real streams and still scans the full output tree for unsafe files',async t=>{
 const definitions=[{...REGISTERED_OPERATIONS[0],operationId:'bounded.streams',argv:['node','-e','process.stdout.write("x".repeat(100000));process.stderr.write("actual stderr")'],inputs:[],artifacts:[]},
 {...REGISTERED_OPERATIONS[0],operationId:'unsafe.output',argv:['node','-e','require("fs").symlinkSync("/etc/passwd","output/link")'],inputs:[],artifacts:[]}];
 const h=await harness(t,definitions);
 const p=await permit(definitions[0]);await signedFetch(h.client,'/start',{permit:p});const result=(await poll(h.client,p)).receipts.find(r=>r.claims.purpose==='result');assert.equal(result.claims.status,'succeeded');assert.equal(result.claims.stdout.bytes,65536);assert.equal(result.claims.stdout.truncated,true);
 const content=await signedFetch(h.client,'/content',{permit:p,kind:'stdout'});assert.equal(Buffer.from(content.data.base64,'base64').toString(),'x'.repeat(65536));
 const unsafe=await permit(definitions[1]);await signedFetch(h.client,'/start',{permit:unsafe});assert.equal((await poll(h.client,unsafe)).receipts.find(r=>r.claims.purpose==='result').claims.status,'evidence_unavailable');
});
test('concurrent changed payload cannot reuse an accepted owner Run attempt',async t=>{
 const h=await harness(t);const p=await permit();const responses=await Promise.all([signedFetch(h.client,'/start',{permit:p}),signedFetch(h.client,'/start',{permit:{...p,ticketId:'changed'}})]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[202,409]);const accepted=responses[0].status===202?p:{...p,ticketId:'changed'};await poll(h.client,accepted);
});
test('private static assets map to fixed public inputs; modified actual bytes fail before registered execution',async t=>{
 const source=await mkdtemp(join(tmpdir(),'private-static-'));await mkdir(join(source,'assets'));await writeFile(join(source,'assets/proof.txt'),'proof');
 const definition={...REGISTERED_OPERATIONS[0],operationId:'static.assets',argv:['node','-e','const f=require("fs");f.writeFileSync("output/proof.txt",f.readFileSync("input/assets/proof.txt"))'],inputs:[{path:'input/assets/proof.txt',bytes:5,sha256:await sha256('proof')}],artifacts:[{path:'output/proof.txt',maxBytes:32}]};
 const h=await harness(t,[definition],{[definition.operationId]:source});t.after(()=>rm(source,{recursive:true,force:true}));
 const p=await permit(definition);await signedFetch(h.client,'/start',{permit:p});const good=(await poll(h.client,p)).receipts.find(r=>r.claims.purpose==='result');assert.equal(good.claims.status,'succeeded');assert.equal(JSON.stringify(good).includes(source),false);
 assert.equal(Buffer.from((await signedFetch(h.client,'/content',{permit:p,kind:'artifact',path:'output/proof.txt'})).data.base64,'base64').toString(),'proof');
 await writeFile(join(source,'assets/proof.txt'),'drift');const changed=await permit(definition);await signedFetch(h.client,'/start',{permit:changed});const bad=(await poll(h.client,changed)).receipts.find(r=>r.claims.purpose==='result');assert.equal(bad.claims.status,'startup_failed');assert.equal(bad.claims.startedAt,null);assert.equal(bad.claims.process,null);
});
test('real checkpoint transport outage stops a running process within grace and preserves original deadline',async t=>{
 const definition={...REGISTERED_OPERATIONS[0],operationId:'outage.slow',argv:['node','-e','process.stdout.write("retained before interruption");process.stderr.write("interrupted stderr");setTimeout(()=>{},60000)'],inputs:[],artifacts:[]};const h=await harness(t,[definition]);const p=await permit(definition);
 await signedFetch(h.client,'/start',{permit:p});let result;const until=Date.now()+20000;while(Date.now()<until){result=await signedFetch(h.client,'/result',{permit:p});if(result.data.phase==='running')break;await new Promise(r=>setTimeout(r,100));}assert.equal(result.data.phase,'running');
 const lostAt=Date.now();await h.outage();const receipt=(await poll(h.client,p)).receipts.find(r=>r.claims.purpose==='result');assert.equal(receipt.claims.status,'cancelled');assert.ok(Date.now()-lostAt<10000);assert.equal(receipt.claims.deadlineMs,p.deadlineMs);assert.equal(receipt.claims.stdout?.bytes,28);assert.equal(receipt.claims.stderr?.bytes,18);assert.equal(Buffer.from((await signedFetch(h.client,'/content',{permit:p,kind:'stdout'})).data.base64,'base64').toString(),'retained before interruption');
});
test('SIGKILL supervisor leaves an independent deadline watchdog and restart cannot repeat the accepted process',async t=>{
 const {fork}=await import('node:child_process');const definition={...REGISTERED_OPERATIONS[0],operationId:'crash.slow',argv:['node','-e','setTimeout(()=>{},60000)'],inputs:[],artifacts:[]};const h=await harness(t,[definition]);await h.server.close();
 const exportKey=async(key,keyId)=>({keyId,jwk:await crypto.subtle.exportKey('jwk',key)});
 const file=join(h.config.root,'child.json');await writeFile(file,JSON.stringify({root:h.config.root,port:0,audience:h.config.audience,registry:[definition],sourceRoots:{},controlUrl:h.config.checkpoint.baseUrl,checkpointAudience:'control',controlPublic:await exportKey(h.config.controlTrust.key,h.config.controlTrust.keyId),transportPrivate:await exportKey(h.config.transportKey.privateKey,h.config.transportKey.keyId),evidencePrivate:await exportKey(h.config.evidenceKey.privateKey,h.config.evidenceKey.keyId)}),{mode:0o600});
 const child=fork(new URL('./fixtures/supervisor-child.mjs',import.meta.url),[file],{execArgv:['--experimental-strip-types'],env:{PATH:'/usr/bin:/bin'},stdio:['ignore','ignore','inherit','ipc']});t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 h.client.baseUrl=await new Promise((resolve,reject)=>{child.once('message',m=>resolve(m.url));child.once('error',reject);child.once('exit',()=>reject(Error('Supervisor child exited')));});
 const p=await permit(definition);await signedFetch(h.client,'/start',{permit:p});let observed;const until=Date.now()+20000;while(Date.now()<until){observed=await signedFetch(h.client,'/result',{permit:p});if(observed.data.phase==='running')break;await new Promise(r=>setTimeout(r,100));}assert.equal(observed.data.phase,'running');
 const disk=await import('../../runner/state.mjs'),docker=await import('../../runner/docker.mjs');const job=JSON.parse((await disk.safeRead(join(h.config.root,'journal',observed.data.backendId+'.json'))).toString());const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited;
 const deadline=p.deadlineMs+6000;while(Date.now()<deadline&&await docker.inspectContainer(job.process.containerId))await new Promise(r=>setTimeout(r,100));assert.equal(await docker.inspectContainer(job.process.containerId),null);
 const recovered=await api.startSupervisor(h.config);h.server.close=()=>recovered.close();h.client.baseUrl=recovered.url;const result=(await poll(h.client,p)).receipts.find(r=>r.claims.purpose==='result');assert.equal(result.claims.status,'timed_out');assert.equal(result.claims.deadlineMs,p.deadlineMs);assert.equal(result.claims.process.execId,job.process.execId);assert.equal((await signedFetch(h.client,'/start',{permit:p})).status,409);
});
test('registered escaped argv remains executable across the Docker JSON boundary',async t=>{
 const definition={...REGISTERED_OPERATIONS[0],operationId:'escaped.argv',argv:['node','-e','process.stdout.write(process.argv[1].length.toString())','\u0001'.repeat(16000)],inputs:[],artifacts:[]};
 const h=await harness(t,[definition]);const p=await permit(definition);await signedFetch(h.client,'/start',{permit:p});const result=(await poll(h.client,p)).receipts.find(r=>r.claims.purpose==='result');assert.equal(result.claims.status,'succeeded');assert.equal(Buffer.from((await signedFetch(h.client,'/content',{permit:p,kind:'stdout'})).data.base64,'base64').toString(),'16000');
});
test('result receipts cannot escape before durable journal persistence completes',async t=>{
 const h=await harness(t);await h.server.close();const {openJournal}=await import('../../runner/journal.mjs'),{createExecutor}=await import('../../runner/executor.mjs'),{registryConfiguration}=await import('../../runner/registry.mjs');const journal=await openJournal(h.config.root);const executor=await createExecutor(journal,h.config,registryConfiguration());
 let release;const gate=new Promise(r=>release=r);let entered;const held=new Promise(r=>entered=r);const original=journal.save;let intercepted=false;
 journal.save=async job=>{if(!intercepted&&job.receipts.some(r=>r.claims.purpose==='result')){intercepted=true;entered();await gate;}return original(job);};
 try{const p=await permit();await executor.start(p);await held;let exposed=false;const reading=executor.result(p).then(value=>{exposed=true;return value;});await new Promise(r=>setTimeout(r,100));try{assert.equal(exposed,false,'Uncommitted receipt must not be externally readable');}finally{release();}const value=await reading;assert.equal(value.receipts.find(r=>r.claims.purpose==='result').claims.status,'succeeded');}finally{release();await executor.close();await journal.release();}
});
test('failed listen releases the supervisor journal lock for a corrected retry',async t=>{
 const h=await harness(t);const root=await mkdtemp(join(tmpdir(),'execution-listen-'));t.after(()=>rm(root,{recursive:true,force:true}));const port=Number(new URL(h.server.url).port);
 await assert.rejects(api.startSupervisor({...h.config,root,port}),{code:'EADDRINUSE'});
 const retry=await api.startSupervisor({...h.config,root,port:0});await retry.close();
});
test('Docker stream deadline during durable start acknowledgement fails cleanly with actual cleanup',async t=>{
 const h=await harness(t);const p=await permit();const work=await import('../../runner/workspaces.mjs'),docker=await import('../../runner/docker.mjs');
 const w=await work.createWorkspace(join(h.config.root,'state'),{owner:p.owner,runId:p.runId,attempt:p.attempt,deadlineMs:p.deadlineMs},{...p.operation.policy,ceilings:p.budget});const source=join(h.config.root,'delayed-ack-input');await mkdir(join(source,'input'),{recursive:true});await writeFile(join(source,'input/ticket.json'),p.ticketBody);await work.importInputs(w,source,p.operation.inputs);const container=await work.startWorkspace(w);const exec=await work.createExecution(w,['node','-e','setTimeout(()=>{},1000)']);let acknowledged=false;
 await assert.rejects(docker.startExec(exec.id,{timeoutMs:100,maxLogBytes:65536,onStarted:async()=>{acknowledged=true;await new Promise(r=>setTimeout(r,500));}}));assert.equal(acknowledged,true);assert.equal((await work.cleanupWorkspace(w)).state,'removed');assert.equal(await docker.inspectContainer(container.containerId),null);
});
