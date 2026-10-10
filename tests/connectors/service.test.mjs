import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/database.mts';
import { inviteConnector, enrollConnector, authenticateConnector, heartbeatConnector, listConnections, connectionDTO, revokeConnector } from '../../lib/connectors/service.mts';
import { handleConnectorMCP } from '../../lib/connectors/mcp.mts';
import { dispatchPlanningTool } from '../../lib/connectors/planning.mts';
import { retryPlanningJob } from '../../lib/planning-recovery.mts';
import { scheduledPlanning } from '../../lib/planning-recovery.mts';
import { createHash } from 'node:crypto';

const origin='http://127.0.0.1:5173';
process.env.APP_ORIGIN=origin;
async function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'hub-connectors-')),file=join(dir,'test.sqlite'),db=openDatabase(file);
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 for(const owner of ['alice','bob'])await db.prepare('INSERT INTO local_users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)').bind(owner,owner,owner,'synthetic-unused',Date.now()).run();
 return {db,file};
}
async function enroll(db,owner='alice',project='Project A',capabilities=['read','submit','plan','execute']) {
 const invitation=await inviteConnector(db,owner,{action:'invite',project,name:'Local client',capabilities});
 const result=await enrollConnector(db,{code:invitation.code,name:'Local client',version:'0.1.0',workspace:'Synthetic repository'});
 const headers=new Headers({host:new URL(origin).host,authorization:`Bearer ${result.token}`,'content-type':'application/json'});
 const principal=await authenticateConnector(db,headers);
 return {...result,invitation,headers,principal};
}
async function rpc(db,connector,method,params={},id=1) {
 const response=await handleConnectorMCP(db,new Request(origin+'/api/connector/mcp',{method:'POST',headers:connector.headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params})}));
 return {status:response.status,...await response.json()};
}
async function call(db,connector,name,args={}) {
 const response=await rpc(db,connector,'tools/call',{name,arguments:args});
 assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.result?.isError,false,JSON.stringify(response));
 return response.result.structuredContent;
}
const draft={title:'Plan title',goal:'Make an actual change',scope:'Only declared project',acceptance:'Tests pass',assumptions:'Synthetic check'};
const tickets=[{key:'first',...draft,dependencies:''}];

test('single-use invitations enroll atomically into stable owner-scoped projects with hashed thirty-day credentials',async t=>{
 const {db,file}=await fixture(t);
 const invitation=await inviteConnector(db,'alice',{action:'invite',project:'Project A',name:'Client',capabilities:['read','submit']});
 assert.ok(invitation.expiresAt-Date.now()>599000);assert.equal(invitation.downloadUrl,origin+'/api/connectors/download');
 const competitor=openDatabase(file);t.after(()=>competitor.close());
 const input={code:invitation.code,name:'Client',version:'0.1.0',workspace:'Repo'};
 const attempts=await Promise.allSettled([enrollConnector(db,input),enrollConnector(competitor,input)]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 const successful=attempts.find(r=>r.status==='fulfilled').value;
 const row=await db.prepare('SELECT * FROM workspace_connections WHERE id=?').bind(successful.connection.id).first();
 assert.notEqual(row.token_hash,successful.token);assert.equal(row.token_hash.length,64);assert.ok(row.token_expires_at-Date.now()>2591999000);
 const same=await inviteConnector(db,'alice',{action:'invite',project:'Project A',name:'Again',capabilities:['read']});assert.equal(same.projectId,invitation.projectId);
 const other=await inviteConnector(db,'bob',{action:'invite',project:'Project A',name:'Other owner',capabilities:['read']});assert.notEqual(other.projectId,invitation.projectId);
 const list=await listConnections(db,'bob');assert.equal(list.connections.length,0);
 assert.ok(!JSON.stringify(await listConnections(db,'alice')).includes(successful.token));
 await assert.rejects(enrollConnector(db,input),e=>e.status===401);
 await assert.rejects(enrollConnector(db,{...input,code:other.code,workspace:'/tmp/arbitrary/repo'}),e=>e.status===400);
 await db.prepare('UPDATE workspace_invitations SET expires_at=0 WHERE connection_id IS NULL').run();
 await assert.rejects(enrollConnector(db,{...input,code:other.code}),e=>e.status===401);
});

test('MCP lifecycle exposes only capabilities; authentication never accepts owner tokens, cross-origin or mixed cookies',async t=>{
 const {db}=await fixture(t),connector=await enroll(db,'alice','Project A',['read']);
 assert.equal((await rpc(db,connector,'initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'}})).result.protocolVersion,'2025-11-25');
 const list=await rpc(db,connector,'tools/list');const names=list.result.tools.map(t=>t.name);
 assert.ok(names.includes('list_tickets'));assert.ok(names.includes('get_idea'));assert.ok(!names.includes('create_idea'));assert.ok(!names.includes('claim_planning_job'));assert.ok(!names.some(n=>/approve|execution|subscribe/.test(n)));
 assert.equal((await rpc(db,connector,'events/subscribe')).error.code,-32601);
 assert.equal((await rpc(db,connector,'tools/call',{name:'create_idea',arguments:{}})).error.code,-32602);
 const wrongOrigin={...connector,headers:new Headers(connector.headers)};wrongOrigin.headers.set('origin','https://foreign.invalid');assert.equal((await rpc(db,wrongOrigin,'ping')).status,403);
 const mixed={...connector,headers:new Headers(connector.headers)};mixed.headers.set('cookie','hub_session=anything');assert.equal((await rpc(db,mixed,'ping')).status,401);
 await db.prepare("INSERT INTO local_tokens(token_hash,owner,kind,expires_at,created_at) VALUES(?,'alice','api',?,?)").bind(createHash('sha256').update('a'.repeat(43)).digest('hex'),Date.now()+600000,Date.now()).run();
 const ownerToken={...connector,headers:new Headers(connector.headers)};ownerToken.headers.set('authorization','Bearer '+'a'.repeat(43));assert.equal((await rpc(db,ownerToken,'ping')).status,401);
 const invalid=await handleConnectorMCP(db,new Request(origin+'/api/connector/mcp',{method:'POST',headers:connector.headers,body:JSON.stringify({jsonrpc:'1.0',method:'ping'})}));assert.equal(invalid.status,400);
 const initialized=await handleConnectorMCP(db,new Request(origin+'/api/connector/mcp',{method:'POST',headers:connector.headers,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})}));assert.equal(initialized.status,202);
});

test('actual scoped submission, competing claim, atomic save, read pagination and foreign linkage are isolated',async t=>{
 const {db,file}=await fixture(t),a=await enroll(db),b=await enroll(db,'alice','Project B'),other=await enroll(db,'bob','Project A');
 const idea=await call(db,a,'create_idea',{request_id:'idea-1',title:'Original idea',text:'Preserved text'});
 assert.deepEqual(await call(db,a,'create_idea',{request_id:'idea-1',title:'Changed retry text',text:'Not overwritten'}),idea);
 assert.equal((await call(db,a,'get_idea',{idea_id:idea.idea_id})).text,'Preserved text');
 for(const foreign of [b,other]){
  assert.equal((await call(db,foreign,'list_planning_jobs')).jobs.length,0);
  assert.equal((await rpc(db,foreign,'tools/call',{name:'get_idea',arguments:{idea_id:idea.idea_id}})).result.isError,true);
  assert.equal((await rpc(db,foreign,'tools/call',{name:'claim_planning_job',arguments:{job_id:idea.job_id}})).result.isError,true);
 }
 const competitor=openDatabase(file);t.after(()=>competitor.close());
 const claims=await Promise.allSettled([dispatchPlanningTool(db,a.principal.owner,'claim_planning_job',{job_id:idea.job_id},a.principal),dispatchPlanningTool(competitor,a.principal.owner,'claim_planning_job',{job_id:idea.job_id},a.principal)]);
 assert.equal(claims.filter(c=>c.status==='fulfilled').length,1);const claim=claims.find(c=>c.status==='fulfilled').value;
 const output=await call(db,a,'save_plan_and_tickets',{job_id:idea.job_id,claim_token:claim.claim_token,plan:draft,tickets});
 assert.deepEqual(await call(db,a,'save_plan_and_tickets',{job_id:idea.job_id,claim_token:claim.claim_token,plan:draft,tickets}),output);
 assert.equal((await db.prepare("SELECT count(*) AS n FROM records WHERE kind IN ('plan','ticket')").first()).n,2);
 assert.equal((await call(db,a,'get_ticket',{ticket_id:output.ticket_ids[0]})).ticket.status,'todo');
 assert.equal((await call(db,a,'get_plan',{plan_id:output.plan_id})).tickets.items.length,1);
 const direct=await call(db,a,'create_ticket',{request_id:'direct-1',...draft});assert.equal((await call(db,a,'get_ticket',{ticket_id:direct.ticket_id})).ticket.budget,'未授权');
 await call(db,b,'create_ticket',{request_id:'direct-b',...draft});
 const first=await call(db,a,'list_tickets',{limit:1});assert.equal(first.items.length,1);assert.ok(first.next_cursor);
 const second=await call(db,a,'list_tickets',{limit:1,cursor:first.next_cursor});assert.equal(second.items.length,1);assert.notEqual(first.items[0].id,second.items[0].id);assert.ok([...first.items,...second.items].every(t=>t.project==='Project A'));
 assert.equal((await rpc(db,b,'tools/call',{name:'list_tickets',arguments:{cursor:first.next_cursor,limit:1}})).result.isError,true);
 assert.equal((await rpc(db,a,'tools/call',{name:'list_tickets',arguments:{project:'Project B'}})).result.isError,true);
 const foreignIdea=await call(db,b,'create_idea',{request_id:'foreign-link',title:'Private B context',text:'Should remain private'});
 const row=await db.prepare('SELECT body FROM records WHERE id=?').bind(direct.ticket_id).first();const body=JSON.parse(row.body);body.ideaId=foreignIdea.idea_id;body.ideaRevision=1;body.planId=output.plan_id;
 await db.prepare('UPDATE records SET body=? WHERE id=?').bind(JSON.stringify(body),direct.ticket_id).run();
 // Move the linked Plan to B: A can still read its Ticket but no foreign Plan/Idea body.
 const planRow=await db.prepare('SELECT body FROM records WHERE id=?').bind(output.plan_id).first();const planBody=JSON.parse(planRow.body);planBody.project='Project B';
 await db.prepare('UPDATE records SET body=? WHERE id=?').bind(JSON.stringify(planBody),output.plan_id).run();
 const detail=await call(db,a,'get_ticket',{ticket_id:direct.ticket_id});assert.equal(detail.plan,null);assert.equal(detail.idea,null);assert.equal(detail.source_idea,null);
 assert.equal((await rpc(db,b,'tools/call',{name:'get_ticket',arguments:{ticket_id:direct.ticket_id}})).result.isError,true);
});

test('stale revisions and expired leases create no partial Plan/Tickets; revoked connections cannot save',async t=>{
 const {db}=await fixture(t),a=await enroll(db);
 for(const condition of ['revision','expiry','revoke']){
  const idea=await call(db,a,'create_idea',{request_id:condition,title:'Guarded idea',text:'Original'});const claim=await call(db,a,'claim_planning_job',{job_id:idea.job_id});
  if(condition==='revision')await db.prepare('UPDATE records SET revision=revision+1 WHERE id=?').bind(idea.idea_id).run();
  if(condition==='expiry')await db.prepare('UPDATE jobs SET lease=0 WHERE id=?').bind(idea.job_id).run();
  if(condition==='revoke')await revokeConnector(db,'alice',{action:'revoke',connectionId:a.connection.id});
  const response=await rpc(db,a,'tools/call',{name:'save_plan_and_tickets',arguments:{job_id:idea.job_id,claim_token:claim.claim_token,plan:draft,tickets}});
  assert.equal(response.status,condition==='revoke'?401:200);if(condition!=='revoke')assert.equal(response.result.isError,true);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM records WHERE kind IN ('plan','ticket')").first()).n,0);
 }
 assert.equal((await rpc(db,a,'ping')).status,401);
 await assert.rejects(authenticateConnector(db,a.headers),e=>e.status===401);
});

test('revocation at the final SQLite mutation blocks a previously authenticated claim and save',async t=>{
 const {db}=await fixture(t),a=await enroll(db);
 const idea=await call(db,a,'create_idea',{request_id:'race-save',title:'Concurrent revoke',text:'Original'}),claim=await call(db,a,'claim_planning_job',{job_id:idea.job_id});
 let revoked=false;
 const racing={...db,batch:async statements=>{if(!revoked){revoked=true;await revokeConnector(db,'alice',{action:'revoke',connectionId:a.connection.id});}return db.batch(statements);}};
 await assert.rejects(dispatchPlanningTool(racing,'alice','save_plan_and_tickets',{job_id:idea.job_id,claim_token:claim.claim_token,plan:draft,tickets},a.principal),e=>e.status===409);
 assert.equal((await db.prepare("SELECT count(*) AS n FROM records WHERE kind IN ('plan','ticket')").first()).n,0);
 const second=await enroll(db),idea2=await call(db,second,'create_idea',{request_id:'race-claim',title:'Revoke before CAS',text:''});
 await revokeConnector(db,'alice',{action:'revoke',connectionId:second.connection.id});
 await assert.rejects(dispatchPlanningTool(db,'alice','claim_planning_job',{job_id:idea2.job_id},second.principal),e=>e.status===409);
});

test('failed planning persists a sanitized visible error and cooldown without losing original idea or retry semantics',async t=>{
 const {db}=await fixture(t),a=await enroll(db),other=await enroll(db);
 const idea=await call(db,a,'create_idea',{request_id:'failure',title:'Keep the idea',text:'Original text'}),claim=await call(db,a,'claim_planning_job',{job_id:idea.job_id});
 assert.equal((await rpc(db,other,'tools/call',{name:'fail_planning_job',arguments:{job_id:idea.job_id,claim_token:claim.claim_token,error:'not mine'}})).result.isError,true);
 const failure=await call(db,a,'fail_planning_job',{job_id:idea.job_id,claim_token:claim.claim_token,error:'Codex authentication failed at /home/private/repo/config using Bearer '+a.token});
 assert.ok(!failure.error.includes(a.token));assert.ok(!failure.error.includes('/home/private'));assert.ok(failure.retry_after-Date.now()>59000);
 const view=await call(db,a,'get_idea',{idea_id:idea.idea_id});assert.equal(view.text,'Original text');assert.equal(view.planning.recovery_reason,'planner_failed');assert.equal(view.planning.retry_allowed,false);assert.equal(view.planning.planner_error,failure.error);
 await scheduledPlanning(db);assert.equal((await db.prepare('SELECT delivery FROM jobs WHERE id=?').bind(idea.job_id).first()).delivery,'failed');
 assert.equal((await rpc(db,a,'tools/call',{name:'claim_planning_job',arguments:{job_id:idea.job_id}})).result.isError,true);
 const stored=await db.prepare('SELECT * FROM jobs WHERE id=?').bind(idea.job_id).first();assert.equal((await retryPlanningJob(idea.job_id,'alice',db)).generation,stored.generation);
 await db.prepare('UPDATE jobs SET retry_after=0,planner_retry_at=0 WHERE id=?').bind(idea.job_id).run();
 const retry=await retryPlanningJob(idea.job_id,'alice',db);assert.equal(retry.generation,stored.generation+1);assert.equal(retry.planner_error,null);
 const next=await call(db,a,'claim_planning_job',{job_id:idea.job_id});assert.notEqual(next.claim_token,claim.claim_token);
});

test('MCP use stays installed while daemon heartbeat derives live, delayed, offline and revoked status',async t=>{
 const {db}=await fixture(t),a=await enroll(db);
 await call(db,a,'list_tickets');let listed=(await listConnections(db,'alice')).connections[0];assert.equal(listed.status,'installed');assert.ok(listed.lastSeen);
 await heartbeatConnector(db,a.principal,{mode:'mcp',version:'0.1.0',agentReady:false});listed=(await listConnections(db,'alice')).connections[0];assert.equal(listed.status,'installed');
 const heartbeat=await heartbeatConnector(db,a.principal,{mode:'agent',version:'0.1.1',agentReady:false,error:'Codex authentication required: sk-live***masked'});assert.equal(heartbeat.connection.status,'online');assert.equal(heartbeat.connection.agentReady,false);assert.equal(heartbeat.connection.agentError,'Codex authentication required: [credential]');
 const details=(await listConnections(db,'alice')).connections[0];assert.ok(details.agentLastSeen);assert.ok(details.mcpLastSeen);assert.ok(details.events.some(e=>e.mode==='agent'));assert.ok(!JSON.stringify(details.events).includes('sk-live'));
 const row=await db.prepare('SELECT c.*,p.name AS project FROM workspace_connections c JOIN workspace_projects p ON p.id=c.project_id WHERE c.id=?').bind(a.connection.id).first();
 assert.equal(connectionDTO(row,row.agent_last_seen+44999).status,'online');assert.equal(connectionDTO(row,row.agent_last_seen+45000).status,'delayed');assert.equal(connectionDTO(row,row.agent_last_seen+90000).status,'offline');
 await heartbeatConnector(db,a.principal,{mode:'agent',version:'0.1.1',agentReady:true});assert.equal((await listConnections(db,'alice')).connections[0].agentError,null);
 await assert.rejects(revokeConnector(db,'bob',{action:'revoke',connectionId:a.connection.id}),e=>e.status===404);
 await revokeConnector(db,'alice',{action:'revoke',connectionId:a.connection.id});assert.equal((await listConnections(db,'alice')).connections[0].status,'revoked');
 await assert.rejects(heartbeatConnector(db,a.principal,{mode:'agent',version:'0.1.1',agentReady:true}),e=>e.status===401);
 const fresh=await enroll(db);await db.prepare('UPDATE workspace_connections SET token_expires_at=0 WHERE id=?').bind(fresh.connection.id).run();await assert.rejects(authenticateConnector(db,fresh.headers),e=>e.status===401);
});

test('owner MCP uses the shared planning domain with existing unscoped claim/save signatures',async t=>{
 const {db}=await fixture(t);
 const idea=await dispatchPlanningTool(db,'alice','create_idea',{request_id:'owner-legacy',title:'Owner plan',text:'Native domain',project:'Owner project'});
 const claim=await dispatchPlanningTool(db,'alice','claim_planning_job',{job_id:idea.job_id});assert.equal(claim.idea.project,'Owner project');
 const output=await dispatchPlanningTool(db,'alice','save_plan_and_tickets',{job_id:idea.job_id,claim_token:claim.claim_token,plan:draft,tickets});
 assert.deepEqual(await dispatchPlanningTool(db,'alice','save_plan_and_tickets',{job_id:idea.job_id,claim_token:'retry-done',plan:draft,tickets}),output);
 assert.equal((await dispatchPlanningTool(db,'alice','list_planning_jobs',{})).jobs[0].status,'done');
});

test('owner sees safe selected runtime while credential fields cannot enter heartbeat metadata',async t=>{
 const {db}=await fixture(t),client=await enroll(db);
 const runtime={profile:'mimo',model:'mimo-v2.6-flash',provider:'mimo'};
 await heartbeatConnector(db,client.principal,{mode:'agent',version:'1.0.0',agentReady:true,runtime});
 const listed=await listConnections(db,'alice');
 assert.deepEqual(listed.connections[0].runtime,runtime);
 await assert.rejects(heartbeatConnector(db,client.principal,{mode:'agent',version:'1.0.0',agentReady:true,runtime:{...runtime,token:'private-secret'}}),error=>error.status===400);
 await assert.rejects(heartbeatConnector(db,client.principal,{mode:'agent',version:'1.0.0',agentReady:true,runtime:{...runtime,profile:'../../private'}}),error=>error.status===400);
 await heartbeatConnector(db,client.principal,{mode:'mcp',version:'1.0.0',agentReady:false});
 assert.deepEqual((await listConnections(db,'alice')).connections[0].runtime,runtime);
 assert.equal((await listConnections(db,'bob')).connections.length,0);
});
