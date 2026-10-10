import test from 'node:test';
import assert from 'node:assert/strict';
import {localFixture} from './fixture.mjs';
import {claimWorkspaceRun} from '../../lib/workspace-runs/service.mts';
test('real HTTP manual moves preserve history/revision and cannot overwrite pending development',async()=>{
 const f=await localFixture();try{
  const owner=f.alice.userId,now=Date.now();
  const call=async(path,body)=>{
   const response=await fetch(f.origin+path,{headers:{authorization:'Bearer '+f.aliceToken,...(body?{'Content-Type':'application/json',origin:f.origin}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
   return {status:response.status,json:await response.json()};
  };
  await f.db.prepare('INSERT INTO workspace_projects VALUES(?,?,?,?)').bind('move-project',owner,'Move test',now).run();
  await f.db.prepare("INSERT INTO workspace_connections(id,owner,project_id,name,workspace,version,capabilities,token_hash,token_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").bind('move-connection',owner,'move-project','Move workspace','synthetic-repo','1','["execute"]','synthetic',now+86400000,now).run();
  const create=await call('/api/records',{kind:'ticket',title:'Synthetic move contract',project:'Move test',status:'todo',notes:'Keep input'});
  assert.equal(create.status,201);const id=create.json.id;
  const body={id,kind:'ticket',title:'Synthetic move contract',project:'Move test',status:'waiting',waitingReason:'external',notes:'Keep input',revision:1};
  const moved=await call('/api/records',body);assert.equal(moved.status,200);assert.equal(moved.json.revision,2);
  const prepared=await call('/api/workspace-runs',{action:'prepare',ticketId:id,revision:2,connectionId:'move-connection',requestId:'http-move-prepare',timeoutMs:120000});
  assert.equal(prepared.status,200,JSON.stringify(prepared));assert.equal(prepared.json.run.state,'pending');
  assert.equal((await claimWorkspaceRun(f.db,{id:'move-connection',owner,projectId:'move-project',project:'Move test',capabilities:['execute']})).job,null,'pending is not claimable');
  const history=async()=>(await f.db.prepare("SELECT count(*) AS n FROM records WHERE owner=? AND kind='history'").bind(owner).first()).n;
  assert.equal(await history(),1);
  const blocked=await call('/api/records',{...body,revision:2,status:'todo'});assert.equal(blocked.status,409);
  assert.equal(await history(),1);const stored=await f.db.prepare('SELECT body,revision FROM records WHERE id=? AND owner=?').bind(id,owner).first();
  assert.equal(stored.revision,2);assert.equal(JSON.parse(stored.body).status,'waiting');assert.equal(JSON.parse(stored.body).notes,'Keep input');
  assert.equal((await call('/api/workspace-runs',{action:'cancel',runId:prepared.json.run.id})).status,200);
  const retried=await call('/api/records',{...body,revision:2,status:'todo'});assert.equal(retried.status,200);assert.equal(retried.json.revision,3);assert.equal(await history(),2);
 }finally{await f.close();}
});
