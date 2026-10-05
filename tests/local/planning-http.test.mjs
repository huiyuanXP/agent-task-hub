import test from 'node:test';
import assert from 'node:assert/strict';
import { localFixture } from './fixture.mjs';
import { consumer, secret, seedJob, seedSubscription, waitFor } from './planning-fixture.mjs';

test('one-second native server timer delivers without requests and retains backoff across restart', async t => {
  const target=await consumer(); t.after(()=>target.close()); target.status=503;
  const f=await localFixture({env:{APP_SCHEDULER_INTERVAL_MS:'1000'}}); t.after(()=>f.close());
  await seedSubscription(f.db,f.alice.userId,target.url); await seedJob(f.db,f.alice.userId);
  const row=()=>f.db.prepare('SELECT * FROM planning_deliveries WHERE job_id=\'job\'').first();
  await waitFor(async()=>(await row())?.status==='retrying',3500);
  const first=await row(); assert.equal(first.attempts,1); assert.ok(first.next_attempt_at-Date.now()>25000); assert.ok(first.next_attempt_at-Date.now()<=30000);
  await f.stop(); await f.start(); await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal((await row()).attempts,1); assert.equal((await row()).next_attempt_at,first.next_attempt_at); assert.equal(target.events.length,1);
  target.status=204; await f.db.prepare('UPDATE planning_deliveries SET next_attempt_at=0').run();
  await waitFor(async()=>(await row()).status==='accepted',3500); assert.equal((await row()).attempts,2);
  assert.equal(target.events[0].id,target.events[1].id);
  const job=await f.db.prepare('SELECT * FROM jobs WHERE id=\'job\'').first(); assert.ok(job.wake_deadline-Date.now()>295000); assert.ok(job.wake_deadline-Date.now()<=300000);
});

test('real MCP rejects public callbacks and locally verifies then backfills an app-created Idea',async t=>{
  const target=await consumer(); t.after(()=>target.close());
  const f=await localFixture(); t.after(()=>f.close());
  const request=async(path,body)=>{const r=await fetch(f.origin+path,{method:'POST',headers:{authorization:'Bearer '+f.aliceToken,origin:f.origin,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const idea=await request('/api/records',{kind:'idea',title:'Native local Idea',project:'Local'}); assert.equal(idea.status,201);
  const rpc=url=>request('/mcp',{jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'idea.planning_requested',arguments:{project:'Local'},delivery:{mode:'webhook',url,secret}}});
  assert.ok((await rpc('https://chatgpt.com/never-send')).body.error);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n,0);
  const accepted=await rpc(target.url); assert.ok(accepted.body.result,JSON.stringify(accepted));
  assert.equal(target.challenges.length,1); assert.equal(target.events.length,1); assert.equal(target.events[0].event.data.idea_id,idea.body.id);
  assert.equal((await f.db.prepare('SELECT delivery FROM jobs WHERE idea_id=?').bind(idea.body.id).first()).delivery,'accepted');
  const job=await f.db.prepare('SELECT * FROM jobs WHERE idea_id=?').bind(idea.body.id).first();
  const before=Date.now();const claim=await request('/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'claim_planning_job',arguments:{job_id:job.id}}});
  assert.ok(claim.body.result,JSON.stringify(claim));
  const claimed=await f.db.prepare('SELECT * FROM jobs WHERE id=?').bind(job.id).first();
  assert.equal(claimed.status,'planning');assert.ok(claimed.lease>=before+600000);assert.ok(claimed.lease<=Date.now()+600000);
  const {scheduledPlanning}=await import('../../lib/planning-recovery.mts');await scheduledPlanning(f.db);
  assert.equal((await f.db.prepare('SELECT status FROM jobs WHERE id=?').bind(job.id).first()).status,'planning');assert.equal(target.events.length,1);
});

test('native server SIGTERM drains an inflight timer delivery before closing SQLite',async t=>{
  const target=await consumer();t.after(()=>target.close());
  const f=await localFixture({env:{APP_SCHEDULER_INTERVAL_MS:'1000'}});t.after(()=>f.close());
  let release;target.pause=new Promise(resolve=>{release=resolve;});
  try {
    await seedSubscription(f.db,f.alice.userId,target.url);await seedJob(f.db,f.alice.userId);
    await waitFor(()=>target.events.length===1,3500);
    let stopped=false;const stopping=f.stop().then(()=>{stopped=true;});
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(stopped,false);
    release();await stopping;
    assert.equal((await f.db.prepare('SELECT status FROM planning_deliveries').first()).status,'accepted');
  } finally {release();await f.stop();}
});
