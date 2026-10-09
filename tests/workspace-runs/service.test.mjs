import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../../lib/database.mts';
import { claimWorkspaceRun,completeWorkspaceRun,decideWorkspaceRun,eventWorkspaceRun,failWorkspaceRun,getWorkspaceRun,listWorkspaceRuns,prepareWorkspaceRun,renewWorkspaceRun } from '../../lib/workspace-runs/service.mts';
import { handleWorkspaceAgentRequest,handleWorkspaceRequest } from '../../lib/workspace-runs/http.mts';

async function fixture(t,{file=false}={}) {
 const dir=mkdtempSync(join(tmpdir(),'hub-workspace-service-')),db=openDatabase(file?join(dir,'db.sqlite'):':memory:');
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 await db.prepare('INSERT INTO local_users VALUES(?,?,?,?,?)').bind('alice','alice','Alice','synthetic-unusable-hash',now).run();
 await db.prepare('INSERT INTO local_users VALUES(?,?,?,?,?)').bind('bob','bob','Bob','synthetic-unusable-hash',now).run();
 await db.prepare('INSERT INTO workspace_projects VALUES(?,?,?,?)').bind('project','alice','test',now).run();
 await db.prepare('INSERT INTO workspace_projects VALUES(?,?,?,?)').bind('other-project','alice','other',now).run();
 for(const [id,project] of [['connection','project'],['connection2','project'],['other-connection','other-project']])
  await db.prepare(`INSERT INTO workspace_connections(id,owner,project_id,name,workspace,version,capabilities,token_hash,token_expires_at,created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(id,'alice',project,id,'test-repository','1','["read","execute"]',id+'-synthetic-hash',now+86400000,now).run();
 const principal={id:'connection',owner:'alice',projectId:'project',project:'test',capabilities:['read','execute']};
 async function ticket(id='ticket',body={}){
  const raw=JSON.stringify({title:'Implement addition',project:'test',status:'todo',...body});
  await db.prepare('INSERT INTO records(id,owner,kind,body,revision,created,updated) VALUES(?,?,\'ticket\',?,1,?,?)').bind(id,'alice',raw,new Date(now).toISOString(),new Date(now).toISOString()).run();return raw;
 }
 await ticket();
 const prepare=(changes={})=>prepareWorkspaceRun(db,'alice',{ticketId:'ticket',revision:1,connectionId:'connection',requestId:'request',timeoutMs:120000,...changes});
 async function running(changes={}){const run=await prepare(changes);await decideWorkspaceRun(db,'alice',run.id,'approve');const {job}=await claimWorkspaceRun(db,principal);assert.ok(job);return {run,job};}
 return {db,dir,principal,ticket,prepare,running,get now(){return now;},advance(ms){now+=ms;}};
}
const conflict=promise=>assert.rejects(promise,error=>error.status===409);

function actualEvidence(dir) {
 const git=(...args)=>{const result=spawnSync('git',args,{cwd:dir,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};
 git('init','--quiet');writeFileSync(join(dir,'sum.mjs'),'export const sum=(a,b)=>a-b;\n');
 git('add','sum.mjs');git('-c','user.email=synthetic@example.invalid','-c','user.name=Synthetic','commit','--quiet','-m','Fixture baseline');
 writeFileSync(join(dir,'sum.mjs'),'export const sum=(a,b)=>a+b;\n');
 const result=spawnSync(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; assert.equal(sum(2,3),5); console.log('addition assertion passed')"],{cwd:dir,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 return {summary:'Corrected addition and checked its output',diff:git('diff','--','sum.mjs'),files:['sum.mjs'],
  tests:[{command:'node --input-type=module -e <addition assertion>',exitCode:result.status,output:result.stdout+result.stderr}],worktree:dir};
}

test('preparation freezes revision, scope and timeout; identical retries remain stable after edits',async t=>{
 const f=await fixture(t),run=await f.prepare();assert.equal(run.state,'pending');assert.equal((await claimWorkspaceRun(f.db,f.principal)).job,null);
 await f.db.prepare("UPDATE records SET revision=2,body=json_set(body,'$.title','Edited') WHERE id='ticket'").run();
 assert.equal((await f.prepare()).id,run.id);await conflict(f.prepare({timeoutMs:200000}));await conflict(decideWorkspaceRun(f.db,'alice',run.id,'approve'));
 const frozen=await f.db.prepare('SELECT ticket_body,ticket_revision,workspace,operation FROM workspace_runs WHERE id=?').bind(run.id).first();
 assert.equal(JSON.parse(frozen.ticket_body).title,'Implement addition');assert.equal(frozen.ticket_revision,1);assert.equal(frozen.workspace,'test-repository');
 assert.equal(frozen.operation,'workspace.develop.v1');
 await assert.rejects(f.db.prepare('UPDATE workspace_runs SET timeout_ms=9999,version=version+1 WHERE id=?').bind(run.id).run(),/Immutable/);
});

test('two database consumers cannot prepare or claim the same Ticket twice; one connector runs one process',async t=>{
 const f=await fixture(t,{file:true}),other=openDatabase(join(f.dir,'db.sqlite'));t.after(()=>other.close());
 const attempts=await Promise.allSettled([f.prepare(),prepareWorkspaceRun(other,'alice',{ticketId:'ticket',revision:1,connectionId:'connection2',requestId:'competing',timeoutMs:120000})]);
 assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1);
 const run=attempts.find(item=>item.status==='fulfilled').value;await decideWorkspaceRun(f.db,'alice',run.id,'approve');
 const identity={...f.principal,id:run.connectionId};
 const claims=await Promise.all([claimWorkspaceRun(f.db,identity),claimWorkspaceRun(other,identity)]);assert.equal(claims.filter(item=>item.job).length,1);
 await f.ticket('second');const second=await f.prepare({ticketId:'second',requestId:'second',connectionId:run.connectionId});await decideWorkspaceRun(f.db,'alice',second.id,'approve');
 assert.equal((await claimWorkspaceRun(f.db,identity)).job,null);
});

test('owner and machine actions are separate; foreign projects and missing execute capability are denied',async t=>{
 const f=await fixture(t),run=await f.prepare();
 const request=body=>new Request('http://localhost/api/connector/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await handleWorkspaceAgentRequest(f.db,f.principal,request({action:'approve',runId:run.id}))).status,400);
 await assert.rejects(claimWorkspaceRun(f.db,{...f.principal,capabilities:['read']}),error=>error.status===403);
 await decideWorkspaceRun(f.db,'alice',run.id,'approve');
 assert.equal((await claimWorkspaceRun(f.db,{...f.principal,id:'other-connection',projectId:'other-project',project:'other'})).job,null);
 await assert.rejects(getWorkspaceRun(f.db,'bob',run.id),error=>error.status===404);
 await assert.rejects(decideWorkspaceRun(f.db,'bob',run.id,'approve'),error=>error.status===404);
});

test('ordered events deduplicate exact retries, reject changed content and reject cancelled credentials',async t=>{
 const f=await fixture(t),{job}=await f.running(),event={eventId:'daemon-1',stage:'workspace',message:'Created isolated worktree'};
 const first=await eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,event),retry=await eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,event);
 assert.equal(first.event.sequence,retry.event.sequence);assert.equal(first.event.sequence,4);
 await conflict(eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,{...event,message:'Other content'}));
 const second=await eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,{eventId:'daemon-2',stage:'agent',message:'Working'});assert.equal(second.event.sequence,5);
 const page=await getWorkspaceRun(f.db,'alice',job.id,0,2);assert.equal(page.events.length,2);assert.equal(page.eventsCursor,2);
 const tail=await getWorkspaceRun(f.db,'alice',job.id,page.eventsCursor,500);assert.deepEqual(tail.events.map(item=>item.sequence),[3,4,5]);
 await decideWorkspaceRun(f.db,'alice',job.id,'cancel');await conflict(eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,event));
});

test('real diff and subprocess test receipts produce review; only owner acceptance changes Ticket with history',async t=>{
 const f=await fixture(t),{job}=await f.running(),result=actualEvidence(f.dir);
 for(const invalid of [{...result,diff:''},{...result,files:[]},{...result,tests:[]},{...result,tests:[{command:'node test',exitCode:1,output:'failed'}]}])
  await assert.rejects(completeWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,invalid),error=>error.status===400);
 const complete=await completeWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,result);assert.equal(complete.run.state,'review');
 assert.equal((await completeWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,result)).run.id,job.id);
 await conflict(completeWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,{...result,summary:'Changed receipt'}));
 assert.equal((await f.db.prepare("SELECT json_extract(body,'$.status') AS status FROM records WHERE id='ticket'").first()).status,'todo');
 const accepted=await decideWorkspaceRun(f.db,'alice',job.id,'accept');assert.equal(accepted.state,'succeeded');
 const ticket=await f.db.prepare("SELECT revision,json_extract(body,'$.status') AS status FROM records WHERE id='ticket'").first();assert.deepEqual({...ticket},{revision:2,status:'done'});
 const history=await f.db.prepare("SELECT body FROM records WHERE kind='history'").first();assert.equal(JSON.parse(history.body).previousRevision,1);assert.equal(JSON.parse(history.body).snapshot.status,'todo');
 assert.equal((await decideWorkspaceRun(f.db,'alice',job.id,'accept')).state,'succeeded');
 await assert.rejects(f.db.prepare('UPDATE workspace_runs SET result=?,version=version+1 WHERE id=?').bind('{}',job.id).run(),/Immutable/);
});

test('rework creates an idempotent fresh pending attempt and retains previous evidence',async t=>{
 const f=await fixture(t),{job}=await f.running(),result=actualEvidence(f.dir);await completeWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,result);
 const next=await decideWorkspaceRun(f.db,'alice',job.id,'rework');assert.notEqual(next.id,job.id);assert.equal(next.state,'pending');
 assert.equal((await decideWorkspaceRun(f.db,'alice',job.id,'rework')).id,next.id);
 const prior=await getWorkspaceRun(f.db,'alice',job.id);assert.equal(prior.state,'cancelled');assert.deepEqual(prior.result,result);
 assert.equal((await claimWorkspaceRun(f.db,f.principal)).job,null);
});

test('cancellation retains physical occupancy across server restart until stopped-process acknowledgement',async t=>{
 const f=await fixture(t,{file:true}),{job}=await f.running();await decideWorkspaceRun(f.db,'alice',job.id,'cancel');
 const next=await decideWorkspaceRun(f.db,'alice',job.id,'rework');await decideWorkspaceRun(f.db,'alice',next.id,'approve');
 const restarted=openDatabase(join(f.dir,'db.sqlite'));t.after(()=>restarted.close());
 assert.equal((await claimWorkspaceRun(restarted,f.principal)).job,null);
 assert.equal((await renewWorkspaceRun(restarted,f.principal,job.id,job.leaseToken)).cancelRequested,true);
 const stopped=await failWorkspaceRun(restarted,f.principal,job.id,job.leaseToken,'Process group stopped');assert.equal(stopped.run.state,'cancelled');
 assert.equal((await claimWorkspaceRun(restarted,f.principal)).job.id,next.id);
 await conflict(completeWorkspaceRun(restarted,f.principal,job.id,job.leaseToken,actualEvidence(f.dir)));
});

test('lease loss never requeues a started Run and retains occupancy until finite hard deadline',async t=>{
 const f=await fixture(t),{job}=await f.running();f.advance(30000);
 assert.equal((await renewWorkspaceRun(f.db,f.principal,job.id,job.leaseToken)).cancelRequested,true);
 const old=await getWorkspaceRun(f.db,'alice',job.id);assert.equal(old.state,'failed');assert.equal(old.error,'Agent lease expired');
 const next=await decideWorkspaceRun(f.db,'alice',job.id,'rework');await decideWorkspaceRun(f.db,'alice',next.id,'approve');
 assert.equal((await claimWorkspaceRun(f.db,f.principal)).job,null);f.advance(90000);
 const claimed=await claimWorkspaceRun(f.db,f.principal);assert.equal(claimed.job.id,next.id);
 await conflict(eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,{eventId:'late',stage:'agent',message:'Late'}));
});

test('renewal is bounded by hard deadline and timeout stops authority at equality',async t=>{
 const f=await fixture(t),{job}=await f.running({timeoutMs:40000});f.advance(20000);
 const renewed=await renewWorkspaceRun(f.db,f.principal,job.id,job.leaseToken);assert.equal(renewed.leaseExpiresAt,f.now+20000);
 f.advance(20000);assert.equal((await renewWorkspaceRun(f.db,f.principal,job.id,job.leaseToken)).cancelRequested,true);
 const run=await getWorkspaceRun(f.db,'alice',job.id);assert.equal(run.state,'failed');assert.equal(run.error,'Execution timeout');
});

test('revocation and changed Ticket revision fence all consequential worker writes and owner acceptance',async t=>{
 const f=await fixture(t),{job}=await f.running(),result=actualEvidence(f.dir);
 await f.db.prepare("UPDATE records SET revision=2,body=json_set(body,'$.title','New scope') WHERE id='ticket'").run();
 await conflict(completeWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,result));
 await conflict(eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,{eventId:'stale',stage:'checks',message:'Checked'}));
 assert.equal((await renewWorkspaceRun(f.db,f.principal,job.id,job.leaseToken)).cancelRequested,true);
 // The worker may acknowledge stopping an invalidated revision without gaining completion permission.
 await failWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,'Stopped stale revision');
 const next=await decideWorkspaceRun(f.db,'alice',job.id,'rework');await decideWorkspaceRun(f.db,'alice',next.id,'approve');const claimed=(await claimWorkspaceRun(f.db,f.principal)).job;
 await completeWorkspaceRun(f.db,f.principal,claimed.id,claimed.leaseToken,result);
 await f.db.prepare("UPDATE workspace_connections SET revoked_at=? WHERE id='connection'").bind(f.now).run();
 await conflict(decideWorkspaceRun(f.db,'alice',next.id,'accept'));
 await conflict(completeWorkspaceRun(f.db,f.principal,claimed.id,claimed.leaseToken,result));
 assert.equal((await claimWorkspaceRun(f.db,f.principal)).job,null);
});

test('dependent development waits until same-project Plan logical dependency is done',async t=>{
 const f=await fixture(t);await f.db.prepare("UPDATE records SET body=json_set(body,'$.dependencies','T1。','$.planId','plan') WHERE id='ticket'").run();
 await f.ticket('dependency',{logicalKey:'T1',planId:'plan'});
 const run=await f.prepare();await decideWorkspaceRun(f.db,'alice',run.id,'approve');assert.equal((await claimWorkspaceRun(f.db,f.principal)).job,null);
 const waiting=await getWorkspaceRun(f.db,'alice',run.id);assert.equal(waiting.events.at(-1).stage,'waiting');
 await f.db.prepare("UPDATE records SET body=json_set(body,'$.status','done') WHERE id='dependency'").run();assert.equal((await claimWorkspaceRun(f.db,f.principal)).job.id,run.id);
});

test('planner prerequisite sentences allow Chinese none phrases and fulfilled logical key lists',async t=>{
 for(const dependencies of ['无。','无依赖。','none.','T1。','T1、T2。','T3、T4、T5。','T1、T2.'])await t.test(dependencies,async t=>{
  const f=await fixture(t);await f.db.prepare("UPDATE records SET body=json_set(body,'$.dependencies',?,'$.planId','plan') WHERE id='ticket'").bind(dependencies).run();
  for(const key of ['T1','T2','T3','T4','T5'])await f.ticket(`dependency-${key}`,{logicalKey:key,planId:'plan',status:'done'});
  const {run,job}=await f.running();assert.equal(job.id,run.id);assert.equal((await getWorkspaceRun(f.db,'alice',run.id)).state,'running');
 });
});

test('unknown prerequisite prose and logical keys outside the owner, project or Plan remain blocked',async t=>{
 for(const [name,dependencies,body,owner] of [
  ['unknown prose','等待 T1 完成。',{},'alice'],
  ['other Plan','T1。',{planId:'other-plan'},'alice'],
  ['other project','T1。',{project:'other'},'alice'],
  ['other owner','T1。',{},'bob'],
 ])await t.test(name,async t=>{
  const f=await fixture(t);await f.db.prepare("UPDATE records SET body=json_set(body,'$.dependencies',?,'$.planId','plan') WHERE id='ticket'").bind(dependencies).run();
  await f.ticket('dependency',{logicalKey:'T1',planId:'plan',status:'done',...body});
  await f.db.prepare("UPDATE records SET owner=? WHERE id='dependency'").bind(owner).run();
  const run=await f.prepare();await decideWorkspaceRun(f.db,'alice',run.id,'approve');assert.equal((await claimWorkspaceRun(f.db,f.principal)).job,null);
  const waiting=await getWorkspaceRun(f.db,'alice',run.id);assert.equal(waiting.state,'approved');assert.equal(waiting.events.at(-1).stage,'waiting');
 });
});

test('dependency IDs retain internal periods and exact terminal-period IDs take precedence',async t=>{
 const f=await fixture(t);await f.db.prepare("UPDATE records SET body=json_set(body,'$.dependencies','dependency.v1., dependency.v2.') WHERE id='ticket'").run();
 await f.ticket('dependency.v1',{status:'done'});await f.ticket('dependency.v1.');await f.ticket('dependency.v2',{status:'done'});
 const run=await f.prepare();await decideWorkspaceRun(f.db,'alice',run.id,'approve');assert.equal((await claimWorkspaceRun(f.db,f.principal)).job,null);
 await f.db.prepare("UPDATE records SET body=json_set(body,'$.status','done') WHERE id='dependency.v1.'").run();
 assert.equal((await claimWorkspaceRun(f.db,f.principal)).job.id,run.id);
});

test('list pagination is bounded and context-bound; HTTP validates body, origin, schema and ownership',async t=>{
 const f=await fixture(t),run=await f.prepare();await decideWorkspaceRun(f.db,'alice',run.id,'reject');
 const next=await f.prepare({requestId:'another'});assert.equal(next.state,'pending');
 const page=await listWorkspaceRuns(f.db,'alice',{ticketId:'ticket',limit:1});assert.equal(page.runs.length,1);assert.ok(page.nextCursor);
 const tail=await listWorkspaceRuns(f.db,'alice',{ticketId:'ticket',limit:1,cursor:page.nextCursor});assert.equal(tail.runs.length,1);assert.notEqual(page.runs[0].id,tail.runs[0].id);
 await assert.rejects(listWorkspaceRuns(f.db,'bob',{ticketId:'ticket',cursor:page.nextCursor}),error=>error.status===400);
 const ownerRequest=(body,extra={})=>new Request('http://localhost/api/workspace-runs',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost',...extra},body:JSON.stringify(body)});
 assert.equal((await handleWorkspaceRequest(f.db,null,ownerRequest({}))).status,401);
 assert.equal((await handleWorkspaceRequest(f.db,'alice',ownerRequest({action:'approve',runId:next.id},{origin:'http://elsewhere'}))).status,403);
 assert.equal((await handleWorkspaceRequest(f.db,'alice',ownerRequest({action:'approve',runId:next.id,owner:'bob'}))).status,400);
 assert.equal((await handleWorkspaceRequest(f.db,'alice',new Request('http://localhost/api/workspace-runs?limit=101'))).status,400);
 assert.equal((await handleWorkspaceRequest(f.db,'alice',new Request('http://localhost/api/workspace-runs?ticketId=ticket&ticketId=ticket'))).status,400);
 assert.equal((await handleWorkspaceRequest(f.db,'alice',ownerRequest({action:'approve',runId:next.id}))).status,200);
 const huge=new Request('http://localhost/api/connector/agent',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(1048577)});
 assert.equal((await handleWorkspaceAgentRequest(f.db,f.principal,huge)).status,413);
 const machine=new Request('http://localhost/api/connector/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'claim'})});
 const response=await handleWorkspaceAgentRequest(f.db,f.principal,machine);assert.equal(response.status,200);const wire=await response.json();
 assert.deepEqual(Object.keys(wire.job).sort(),['body','id','leaseExpiresAt','leaseToken','revision','ticketId','timeoutMs']);assert.equal(wire.job.body.project,'test');
 assert.equal(response.headers.get('cache-control'),'no-store');
});

test('concurrent event, completion and owner-acceptance retries retain one immutable receipt and one history',async t=>{
 const f=await fixture(t,{file:true}),{job}=await f.running(),second=openDatabase(join(f.dir,'db.sqlite'));t.after(()=>second.close());
 const event={eventId:'race-event',stage:'checking',message:'Executed checks'};
 const reports=await Promise.all([eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,event),eventWorkspaceRun(second,f.principal,job.id,job.leaseToken,event)]);
 assert.equal(reports[0].event.sequence,reports[1].event.sequence);
 await assert.rejects(eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,{...event,eventId:'state:100'}),error=>error.status===400);
 const result=actualEvidence(f.dir),completions=await Promise.all([completeWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,result),completeWorkspaceRun(second,f.principal,job.id,job.leaseToken,result)]);
 assert.equal(completions[0].run.state,'review');assert.equal(completions[1].run.state,'review');
 const accepted=await Promise.all([decideWorkspaceRun(f.db,'alice',job.id,'accept'),decideWorkspaceRun(second,'alice',job.id,'accept')]);
 assert.equal(accepted.every(run=>run.state==='succeeded'),true);
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind='history'").first()).count,1);
 assert.equal((await f.db.prepare("SELECT COUNT(*) AS count FROM workspace_run_decisions WHERE action='accept'").first()).count,1);
});

test('result inputs are copied before asynchronous storage and machine credentials remain bound to one connector',async t=>{
 const f=await fixture(t),{job}=await f.running(),result=actualEvidence(f.dir),original=structuredClone(result);
 await conflict(completeWorkspaceRun(f.db,{...f.principal,id:'connection2'},job.id,job.leaseToken,result));
 const pending=completeWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,result);result.summary='caller changed summary';result.tests[0].exitCode=7;
 const delivered=await pending;assert.deepEqual(delivered.run.result,original);
});

test('progress messages redact bearer credentials and quiet successful subprocess output remains valid',async t=>{
 const f=await fixture(t),{job}=await f.running();
 const event=await eventWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,{eventId:'redacted',stage:'agent',message:'Header Bearer synthetic-private-token'});
 assert.equal(event.event.message,'Header Bearer [redacted]');
 const result=actualEvidence(f.dir);result.summary='Corrected addition.\n\nChecked the actual output.';const quiet=spawnSync(process.execPath,['-e','require("node:assert/strict").equal(2+3,5)'],{cwd:f.dir,encoding:'utf8'});
 assert.equal(quiet.status,0);assert.equal(quiet.stdout+quiet.stderr,'');result.tests=[{command:'node -e <quiet assertion>',exitCode:quiet.status,output:quiet.stdout+quiet.stderr}];
 assert.equal((await completeWorkspaceRun(f.db,f.principal,job.id,job.leaseToken,result)).run.state,'review');
});
