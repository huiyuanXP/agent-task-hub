import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../../lib/database.mts';
import {ticketStatusWriteGuard} from '../../lib/tickets/record-write.mts';
import {prepareWorkspaceRun,decideWorkspaceRun,claimWorkspaceRun,failWorkspaceRun} from '../../lib/workspace-runs/service.mts';
async function fixture(t) {
 const db=openDatabase(':memory:');t.after(()=>db.close());const now=Date.now();
 await db.prepare('INSERT INTO local_users VALUES(?,?,?,?,?)').bind('alice','alice','Alice','synthetic',now).run();
 await db.prepare('INSERT INTO workspace_projects VALUES(?,?,?,?)').bind('project','alice','test',now).run();
 await db.prepare("INSERT INTO workspace_connections(id,owner,project_id,name,workspace,version,capabilities,token_hash,token_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind('connection','alice','project','connection','test-repo','1','["execute"]','synthetic',now+86400000,now).run();
 await db.prepare("INSERT INTO records VALUES(?,?,'ticket',?,1,?,?)").bind('ticket','alice',JSON.stringify({title:'Synthetic',status:'todo',project:'test'}),new Date(now).toISOString(),new Date(now).toISOString()).run();
 const prepare=()=>prepareWorkspaceRun(db,'alice',{ticketId:'ticket',revision:1,connectionId:'connection',requestId:'prepare',timeoutMs:120000});
 const move=()=>db.batch([
  db.prepare(`INSERT INTO records SELECT 'history','alice','history','{"title":"previous","recordId":"ticket"}',1,'now','now' WHERE EXISTS(SELECT 1 FROM records WHERE id='ticket' AND owner='alice' AND revision=1 AND ${ticketStatusWriteGuard})`),
  db.prepare(`UPDATE records SET body=json_set(body,'$.status','waiting','$.waitingReason','external'),revision=revision+1 WHERE id='ticket' AND owner='alice' AND revision=1 AND ${ticketStatusWriteGuard}`)
 ]);
 const principal={id:'connection',owner:'alice',projectId:'project',project:'test',capabilities:['execute']};
 return {db,prepare,move,principal};
}
test('prepare wins status move: transaction writes neither history nor revision',async t=>{
 const f=await fixture(t);await f.prepare();
 assert.deepEqual((await f.move()).map(r=>r.meta.changes),[0,0]);
 assert.equal((await f.db.prepare("SELECT revision FROM records WHERE id='ticket'").first()).revision,1);
});
test('status move wins prepare: old revision cannot freeze stale contract',async t=>{
 const f=await fixture(t);assert.deepEqual((await f.move()).map(r=>r.meta.changes),[1,1]);
 await assert.rejects(f.prepare(),error=>error.status===409);
 assert.equal((await f.db.prepare("SELECT count(*) AS n FROM workspace_runs").first()).n,0);
});
test('cancelled process preserves physical hold until Agent acknowledges stop',async t=>{
 const f=await fixture(t),run=await f.prepare();await decideWorkspaceRun(f.db,'alice',run.id,'approve');
 const {job}=await claimWorkspaceRun(f.db,f.principal);assert.ok(job);
 await decideWorkspaceRun(f.db,'alice',run.id,'cancel');
 assert.deepEqual((await f.move()).map(r=>r.meta.changes),[0,0]);
 await failWorkspaceRun(f.db,f.principal,run.id,job.leaseToken,'Process stopped');
 assert.deepEqual((await f.move()).map(r=>r.meta.changes),[1,1]);
});

test('Docker queued Run and cancelled signed-backend reservation both guard manual status',async t=>{
 const {createRun,transitionRun}=await import('../../lib/execution/runs.mts');
 const f=await fixture(t),context={owner:'alice',actor:'alice'};
 const run=await createRun(f.db,context,{ticketId:'ticket',expectedRevision:1,requestId:'docker',authorizationId:'synthetic-authorization',attempt:1});
 assert.deepEqual((await f.move()).map(r=>r.meta.changes),[0,0]);
 // Synthetic reservation tests storage occupancy only, never dispatches or grants authority.
 const now=Date.now();
 await f.db.prepare("INSERT INTO execution_permits(id,owner,run_id,ticket_id,authorization_id,envelope,envelope_hash,created_at,deadline_ms) VALUES(?,?,?,?,?,?,?,?,?)").bind('synthetic-permit','alice',run.id,'ticket',run.authorizationId,'{}','synthetic',now,now+120000).run();
 await transitionRun(f.db,context,{id:run.id,expectedVersion:run.version,to:'cancelled'});
 assert.deepEqual((await f.move()).map(r=>r.meta.changes),[0,0]);
 await f.db.prepare("UPDATE execution_permits SET closed_at=? WHERE id='synthetic-permit'").bind(now).run();
 assert.deepEqual((await f.move()).map(r=>r.meta.changes),[1,1]);
});
test('simultaneous preparation and status transaction produce only one winning contract',async t=>{
 const f=await fixture(t);
 const [prepared,moved]=await Promise.allSettled([f.prepare(),f.move()]);
 const movedCount=moved.status==='fulfilled'?moved.value[1].meta.changes:0;
 assert.equal(Number(prepared.status==='fulfilled')+movedCount,1);
 const records=await f.db.prepare("SELECT revision FROM records WHERE id='ticket'").first();
 assert.equal(records.revision,movedCount?2:1);
 const history=await f.db.prepare("SELECT count(*) AS n FROM records WHERE kind='history'").first();
 assert.equal(history.n,movedCount);
});
