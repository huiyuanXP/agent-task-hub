import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../lib/database.mts';
import { discoverDeliveries, deliverDue } from '../../lib/planning-delivery.mts';
import { recoverPlanningJobs, retryPlanningJob, scheduledPlanning } from '../../lib/planning-recovery.mts';
import { startPlanningScheduler, planningInterval } from '../../scripts/planning-scheduler.mjs';
import { consumer, seedJob, seedSubscription, waitFor } from './planning-fixture.mjs';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'hub-native-planner-')),file=join(dir,'data.sqlite'),db=openDatabase(file),target=await consumer();
  t.after(async()=>{db.close();await target.close();await rm(dir,{recursive:true,force:true});});
  const row=(id='job')=>db.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
  const delivery=(id='job')=>db.prepare('SELECT * FROM planning_deliveries WHERE job_id=?').bind(id).first();
  return {db,file,target,row,delivery};
}

test('disconnected jobs retain recoveries and reconnect backfills only matching owner/project',async t=>{
  const {db,target,row,delivery}=await fixture(t);await seedJob(db,'alice');
  await scheduledPlanning(db);assert.equal((await row()).delivery,'no_subscription');assert.equal(target.events.length,0);
  await db.prepare("UPDATE jobs SET status='planning',lease=0,claim_token='crashed',recoveries=2").run();
  await recoverPlanningJobs(db);assert.equal((await row()).recoveries,2);assert.equal((await row()).generation,1);assert.equal((await row()).claim_token,null);
  await seedSubscription(db,'bob',target.url,'bob');await seedSubscription(db,'alice',target.url,'other',{project:'Other'});
  await scheduledPlanning(db);assert.equal(await delivery(),null);
  await seedSubscription(db,'alice',target.url,'matching',{project:'Local'});await scheduledPlanning(db);
  assert.equal((await delivery()).subscription_id,'matching');assert.equal((await row()).delivery,'accepted');assert.equal(target.events.length,1);
});

test('real failing consumer persists all four backoff bounds then exhausts exactly five attempts',async t=>{
  const {db,target,row,delivery}=await fixture(t);target.status=503;await seedJob(db,'alice');await seedSubscription(db,'alice',target.url);
  await discoverDeliveries(db);
  for (const [attempt,delay] of [[1,30000],[2,60000],[3,120000],[4,240000],[5,null]]) {
    await db.prepare('UPDATE planning_deliveries SET next_attempt_at=0').run();const before=Date.now();await deliverDue(db);
    const value=await delivery();assert.equal(value.attempts,attempt);
    if(delay!==null){assert.equal(value.status,'retrying');assert.ok(value.next_attempt_at>=before+delay);assert.ok(value.next_attempt_at<=Date.now()+delay);}
    else {assert.equal(value.status,'failed');assert.equal(value.terminal_reason,'attempts_exhausted');assert.equal(value.next_attempt_at,null);}
  }
  await deliverDue(db);assert.equal(target.events.length,5);assert.equal(new Set(target.events.map(e=>e.id)).size,1);assert.equal((await row()).delivery,'failed');
});

test('real SQLite lease suppresses competing handles and recovers a crashed delivery',async t=>{
  const {db,file,target,delivery}=await fixture(t);await seedJob(db,'alice');await seedSubscription(db,'alice',target.url);await discoverDeliveries(db);
  const competitor=openDatabase(file);t.after(()=>competitor.close());
  let release;target.pause=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const pending=deliverDue(db);await waitFor(()=>target.events.length===1);
  const claimed=await delivery();assert.equal(claimed.attempts,1);assert.ok(claimed.delivery_lease-Date.now()>29000);assert.ok(claimed.delivery_lease-Date.now()<=30000);
  await deliverDue(competitor);assert.equal(target.events.length,1);release();await pending;
  await db.prepare("UPDATE planning_deliveries SET status='delivering',attempts=1,delivery_lease=0,delivery_token='dead-process'").run();
  await deliverDue(competitor);assert.equal((await delivery()).attempts,2);assert.equal((await delivery()).status,'accepted');assert.equal(target.events.length,2);
});

test('owner, revision and current generation guards reject stale results and manual retry bypasses neither cooldown nor automatic budget',async t=>{
  const {db,target,row,delivery}=await fixture(t);await seedJob(db,'alice');await seedSubscription(db,'alice',target.url);await discoverDeliveries(db);
  assert.equal(await retryPlanningJob('job','bob',db),null);
  let release;target.pause=new Promise(resolve=>{release=resolve;});t.after(()=>release());const pending=deliverDue(db);await waitFor(()=>target.events.length===1);
  await db.prepare('UPDATE records SET revision=2').run();release();await pending;
  assert.notEqual((await delivery()).status,'accepted');assert.equal((await row()).wake_deadline,null);assert.equal(await retryPlanningJob('job','alice',db),null);
  await deliverDue(db);assert.equal((await delivery()).terminal_reason,'job_inactive');
  await seedJob(db,'alice','recover');
  for(let i=1;i<=3;i++){await db.prepare("UPDATE jobs SET status='planning',lease=0,claim_token=? WHERE id='recover'").bind('token-'+i).run();await recoverPlanningJobs(db);assert.equal((await row('recover')).recoveries,i);assert.equal((await row('recover')).generation,i);}
  await db.prepare("UPDATE jobs SET status='planning',lease=0,claim_token='last' WHERE id='recover'").run();await recoverPlanningJobs(db);
  assert.equal((await row('recover')).recovery_reason,'recovery_exhausted');assert.equal((await row('recover')).generation,3);
  const manual=await retryPlanningJob('recover','alice',db);assert.equal(manual.generation,4);assert.equal(manual.recoveries,0);assert.ok(manual.retry_after-Date.now()>59000);assert.ok(manual.retry_after-Date.now()<=60000);
  await db.prepare("UPDATE jobs SET delivery='failed' WHERE id='recover'").run();assert.equal((await retryPlanningJob('recover','alice',db)).generation,4);
});

test('discovery handles fifty jobs and delivery handles twenty outbound targets per sweep',async t=>{
  const {db,target}=await fixture(t);await seedSubscription(db,'alice',target.url);
  for(let i=0;i<51;i++)await seedJob(db,'alice','job-'+String(i).padStart(3,'0'));
  await discoverDeliveries(db);assert.equal((await db.prepare('SELECT count(*) AS n FROM planning_deliveries').first()).n,50);
  await discoverDeliveries(db);assert.equal((await db.prepare('SELECT count(*) AS n FROM planning_deliveries').first()).n,51);
  await deliverDue(db);assert.equal(target.events.length,20);
  await db.prepare("UPDATE planning_deliveries SET status='pending',attempts=0,next_attempt_at=0").run();
  await db.prepare('DELETE FROM subscriptions').run();await deliverDue(db);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM planning_deliveries WHERE status='stopped'").first()).n,50);
  assert.equal(target.events.length,20);await deliverDue(db);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM planning_deliveries WHERE status='stopped'").first()).n,51);
  assert.equal(target.events.length,20);
  await db.prepare("UPDATE jobs SET status='planning',lease=0,claim_token='expired'").run();
  await recoverPlanningJobs(db);assert.equal((await db.prepare('SELECT count(*) AS n FROM jobs WHERE generation=1').first()).n,50);
  await recoverPlanningJobs(db);assert.equal((await db.prepare('SELECT count(*) AS n FROM jobs WHERE generation=1').first()).n,51);
});

test('process timer skips overlapping sweeps and stop drains real inflight HTTP before returning',async t=>{
  const {db,target,delivery}=await fixture(t);await seedSubscription(db,'alice',target.url);await seedJob(db,'alice');
  let release;target.pause=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const scheduler=startPlanningScheduler(db,20);
  try {
    await waitFor(()=>target.events.length===1);await seedJob(db,'alice','second');await new Promise(resolve=>setTimeout(resolve,100));assert.equal(target.events.length,1);
    let stopped=false;const draining=scheduler.stop().then(()=>{stopped=true;});await new Promise(resolve=>setTimeout(resolve,50));assert.equal(stopped,false);
    release();await draining;assert.equal((await delivery()).status,'accepted');await new Promise(resolve=>setTimeout(resolve,60));assert.equal(target.events.length,1);
  } finally {release();await scheduler.stop();}
});

test('disabled timer performs no maintenance and interval validation rejects invalid configuration',async t=>{
  const {db,target}=await fixture(t);await seedSubscription(db,'alice',target.url);await seedJob(db,'alice');
  const scheduler=startPlanningScheduler(db,0);await new Promise(resolve=>setTimeout(resolve,60));await scheduler.stop();assert.equal(target.events.length,0);
  assert.equal(planningInterval(undefined),60000);assert.equal(planningInterval('1000'),1000);assert.equal(planningInterval('0'),0);
  for(const value of ['','-1','1.5','abc','Infinity','2147483648'])assert.throws(()=>planningInterval(value));
});

test('independent Node processes share delivery leases and a killed process recovers its persisted attempt',async t=>{
  const {spawn}=await import('node:child_process');const {once}=await import('node:events');
  const {db,file,target,delivery}=await fixture(t);await seedJob(db,'alice');await seedSubscription(db,'alice',target.url);await discoverDeliveries(db);
  const children=[];
  const launch=()=>{const child=spawn(process.execPath,['--experimental-strip-types','tests/local/planner-child.mjs',file],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);children.push(child);return {child,done:once(child,'exit').then(([code])=>{assert.equal(code,0,output);})};};
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}});
  let release;target.pause=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const first=launch();first.done.catch(()=>{});await waitFor(()=>target.events.length===1);
  const competitor=launch();await competitor.done;assert.equal(target.events.length,1);assert.equal((await delivery()).attempts,1);
  const exited=once(first.child,'exit');first.child.kill('SIGKILL');await exited;assert.equal((await delivery()).status,'delivering');release();target.pause=undefined;
  await db.prepare('UPDATE planning_deliveries SET delivery_lease=0').run();const replacement=launch();await replacement.done;
  assert.equal((await delivery()).status,'accepted');assert.equal((await delivery()).attempts,2);assert.equal(target.events.length,2);
});
