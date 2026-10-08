import assert from 'node:assert/strict';
import { planningFixture } from './fixture.mjs';
const secret = 'whsec_' + Buffer.alloc(32, 9).toString('base64');
const url = 'http://127.0.0.1:1/planning-fixture';
const target = { secret, events: [], respond: () => new Response(null, {status:503}) };
const callbacks={[url]:target};
const f = await planningFixture({callbacks,engineHarness:true});
const rows = async (sql,...args) => (await f.db.prepare(sql).bind(...args).all()).results;
const job = async id => (await rows('SELECT * FROM jobs WHERE id=?',id))[0];
const create = async (title, project='A',actor='alice') => { const r=await f.request('/api/records',{kind:'idea',title,project},actor); assert.equal(r.status,201); return 'planning:'+r.body.id+':1'; };
const subscribe = async (callback=url,project='A',actor='alice') => { const r=await f.request('/mcp',{jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'idea.planning_requested',arguments:{project},delivery:{mode:'webhook',url:callback,secret}}},actor); assert.ok(r.body.result,JSON.stringify(r.body)); return r.body.result; };
try {
  const id=await create('Durable retries');
  assert.equal((await job(id)).delivery,'no_subscription');
  await subscribe();
  await f.scheduled();
  assert.equal((await rows("SELECT name FROM sqlite_master WHERE name='planning_deliveries'")).length,1,'Per-target delivery state must be persisted');
  let targets=await rows('SELECT * FROM planning_deliveries WHERE job_id=?',id);
  assert.equal(targets.length,1,'Cron backfills per-target durable state');
  assert.equal(targets[0].attempts,1); assert.equal(targets[0].status,'retrying');
  assert.ok(targets[0].next_attempt_at-Date.now()>25000);
  const original=target.events[0];
  await f.restart();
  await f.db.prepare('UPDATE planning_deliveries SET next_attempt_at=0 WHERE job_id=?').bind(id).run();
  target.respond=()=>new Response(null,{status:204});
  await f.scheduled();
  assert.equal(target.events[1].body,original.body,'Retry survives restart with exact event body');
  assert.equal((await job(id)).delivery,'accepted');
  await f.db.prepare('UPDATE jobs SET wake_deadline=0 WHERE id=?').bind(id).run();
  await f.scheduled();
  assert.equal((await job(id)).generation,1);
  assert.equal((await job(id)).recovery_reason,'consumer_unclaimed');
  assert.notEqual(target.events.at(-1).id,original.id);
  const claim=(await f.rpc('claim_planning_job',{job_id:id})).result.structuredContent;
  await f.scheduled(); assert.equal((await job(id)).status,'planning');
  await f.db.prepare('UPDATE jobs SET lease=0 WHERE id=?').bind(id).run();
  await f.scheduled(); assert.equal((await job(id)).status,'queued');
  assert.equal((await job(id)).recovery_reason,'claim_expired');
  const stale=await f.rpc('save_plan_and_tickets',{job_id:id,claim_token:claim.claim_token,plan:{title:'stale',goal:'g',scope:'s',acceptance:'a'},tickets:[{key:'one',title:'stale',goal:'g',scope:'s',acceptance:'a'}]});
  assert.ok(stale.error); assert.equal((await rows("SELECT * FROM records WHERE kind='plan'")).length,0);
  console.log('PASS: durable signed retry/restart, consumer recovery and expired claim stale-save rejection');
  const orphan=await create('Disconnected planner','No consumer');
  await f.rpc('claim_planning_job',{job_id:orphan});
  await f.db.prepare('UPDATE jobs SET lease=0 WHERE id=?').bind(orphan).run();
  await f.scheduled();
  assert.equal((await job(orphan)).generation,1,'Expired disconnected claim gets a fresh event');
  assert.equal((await job(orphan)).recoveries,0,'No subscription consumes no recovery budget');
  await f.scheduled(); assert.equal((await job(orphan)).generation,1,'Disconnected jobs do not churn generations');


  for(let n=0;n<2;n++) { await f.db.prepare('UPDATE jobs SET wake_deadline=0 WHERE id=?').bind(id).run(); await f.scheduled(); }
  assert.equal((await job(id)).recoveries,3);
  assert.equal((await job(id)).delivery,'failed');
  const exhaustedCount=target.events.length;
  await f.scheduled(); assert.equal(target.events.length,exhaustedCount,'Exhausted job stops automatic wakes');
  assert.equal((await job(id)).recovery_reason,'recovery_exhausted');
  const lateAddress='http://127.0.0.1:1/late-after-exhaustion'; callbacks[lateAddress]={secret,events:[]};
  await subscribe(lateAddress,'A'); await f.scheduled();
  assert.equal(callbacks[lateAddress].events.length,0,'New subscribers do not bypass exhausted automatic recovery');
  await f.rpc('claim_planning_job',{job_id:id});
  await f.db.prepare('UPDATE jobs SET lease=0 WHERE id=?').bind(id).run();
  await f.db.prepare("UPDATE subscriptions SET expires=0 WHERE json_extract(body,'$.args.project')='A'").run();
  await f.scheduled();
  assert.equal((await job(id)).generation,3,'Subscriber loss cannot bypass an already exhausted recovery budget');
  assert.equal((await job(id)).delivery,'failed');


  console.log('PASS: no-subscription budget preservation and three-recovery exhaustion');

  const scenario=async (name,respond) => {
    const address='http://127.0.0.1:1/'+name;
    const callback={secret,events:[],respond}; callbacks[address]=callback;
    await subscribe(address,name);
    const jid=await create(name,name);
    return {jid,callback,address};
  };
  const deliveries=async jid=>rows('SELECT * FROM planning_deliveries WHERE job_id=? ORDER BY id',jid);
  const disconnected=await scenario('accepted-disconnect',()=>new Response(null,{status:204}));
  const originalDisconnect=disconnected.callback.events[0].id;
  const acceptedDeadline=(await job(disconnected.jid)).wake_deadline;
  await f.db.prepare('UPDATE subscriptions SET expires=0 WHERE id=?').bind((await deliveries(disconnected.jid))[0].subscription_id).run();
  await f.scheduled();
  assert.equal((await job(disconnected.jid)).generation,0); assert.equal((await job(disconnected.jid)).wake_deadline,acceptedDeadline);
  await subscribe(disconnected.address,'accepted-disconnect'); await f.scheduled();
  assert.equal(disconnected.callback.events.length,1,'Refresh before accepted wake deadline does not send another notice');
  assert.equal((await job(disconnected.jid)).generation,0);

  await f.db.prepare('UPDATE jobs SET wake_deadline=0 WHERE id=?').bind(disconnected.jid).run();
  await f.db.prepare('UPDATE subscriptions SET expires=0 WHERE id=?').bind((await deliveries(disconnected.jid))[0].subscription_id).run();
  await f.scheduled();
  assert.equal((await job(disconnected.jid)).generation,1,'Unclaimed acceptance with no subscriber preserves a fresh wake for reconnect');
  assert.equal((await job(disconnected.jid)).recoveries,0);
  assert.equal((await job(disconnected.jid)).delivery,'no_subscription');
  await f.scheduled(); assert.equal((await job(disconnected.jid)).generation,1);
  await subscribe(disconnected.address,'accepted-disconnect'); await f.scheduled();
  assert.equal(disconnected.callback.events.length,2); assert.notEqual(disconnected.callback.events[1].id,originalDisconnect);
  console.log('PASS: accepted consumer disappearance while disconnected preserves one budget-free reconnect wake');

  const due=async jid=>f.db.prepare('UPDATE planning_deliveries SET next_attempt_at=0,delivery_lease=0 WHERE job_id=?').bind(jid).run();
  for(const code of [400,401,403,404,413,302,410]) {
    const {jid,callback}=await scenario('http'+code,()=>new Response(null,{status:code,headers:code===302?{location:'https://evil.example/'}:{}}));
    const [d]=await deliveries(jid); assert.equal(d.status,'failed'); assert.equal(d.attempts,1); assert.equal(d.last_http_status,code);
    assert.equal(d.terminal_reason,code===302?'redirect':code===410?'subscription_gone':'permanent_http');
    await due(jid); await f.scheduled(); assert.equal(callback.events.length,1,'Permanent errors are not retried');
    if(code===410) assert.equal((await rows('SELECT id FROM subscriptions WHERE id=?',d.subscription_id)).length,0);
  }
  console.log('PASS: permanent HTTP, redirect rejection and 410 subscription expiry');
  for(const code of [429,503]) {
    const {jid,callback}=await scenario('backoff'+code,()=>new Response(null,{status:code}));
    for(const [attempt,delay] of [[1,30000],[2,60000],[3,120000],[4,240000]]) {
      const [d]=await deliveries(jid); assert.equal(d.attempts,attempt); assert.equal(d.status,'retrying');
      assert.ok(d.next_attempt_at-Date.now()>delay-5000); assert.ok(d.next_attempt_at-Date.now()<=delay);
      await due(jid); await f.scheduled();
    }
    const [last]=await deliveries(jid); assert.equal(last.attempts,5); assert.equal(last.status,'failed'); assert.equal(last.terminal_reason,'attempts_exhausted');
    await due(jid); await f.scheduled(); assert.equal(callback.events.length,5);
    assert.equal(new Set(callback.events.map(e=>e.id)).size,1);
  }
  const timeout=await scenario('timeout',()=>new Promise(resolve=>setTimeout(()=>resolve(new Response(null,{status:204})),8500)));
  assert.equal((await deliveries(timeout.jid))[0].status,'retrying');
  assert.equal((await deliveries(timeout.jid))[0].terminal_reason,'network_or_timeout');
  // Stop this callback from holding up later sweeps.
  timeout.callback.respond=()=>new Response(null,{status:204});
  console.log('PASS: 429/503 backoff and five-attempt ceiling, real eight-second timeout');

  const matching=await scenario('scoping',()=>new Response(null,{status:204}));
  const before=matching.callback.events.length;
  await create('Other project','Other'); await create('Other owner','scoping','bob');
  await f.scheduled(); assert.equal(matching.callback.events.length,before);
  const secondAddress='http://127.0.0.1:1/scoping-second'; callbacks[secondAddress]={secret,events:[],respond:()=>new Response(null,{status:400})};
  await subscribe(secondAddress,'scoping'); await f.scheduled();
  assert.equal((await deliveries(matching.jid)).length,2); assert.equal((await job(matching.jid)).delivery,'partial');
  assert.equal(matching.callback.events.length,before,'Backfill does not resend accepted targets');
  console.log('PASS: exact project/owner isolation, independent multiple targets and partial summary');

  const concurrent=await scenario('concurrent',()=>new Response(null,{status:503}));
  concurrent.callback.respond=async()=>{await new Promise(r=>setTimeout(r,150));return new Response(null,{status:204});};
  await due(concurrent.jid);
  await Promise.all([f.scheduled(),f.scheduled(),f.request('/api/planning',{ideaId:(await job(concurrent.jid)).idea_id}).then(r=>assert.equal(r.status,200))]);
  assert.equal(concurrent.callback.events.length,2,'Competing request/cron sends only one leased retry');
  // Simulate crash after acceptance but before persistence: recovery must duplicate the same event ID.
  await f.db.prepare("UPDATE planning_deliveries SET status='delivering',delivery_token='crashed',delivery_lease=0 WHERE job_id=?").bind(concurrent.jid).run();
  await f.restart(); await f.scheduled();
  assert.equal(concurrent.callback.events.length,3); assert.equal(new Set(concurrent.callback.events.map(e=>e.id)).size,1);
  assert.equal((await deliveries(concurrent.jid))[0].attempts,3);
  console.log('PASS: concurrent delivery CAS and crash/restart at-least-once event identity');

  const staleJob=await scenario('stale',()=>new Response(null,{status:503}));
  const staleIdea=await job(staleJob.jid);
  await f.request('/api/records',{id:staleIdea.idea_id,revision:1,kind:'idea',title:'new revision',project:'Elsewhere'});
  await due(staleJob.jid); await f.scheduled(); assert.equal(staleJob.callback.events.length,1);
  assert.equal((await deliveries(staleJob.jid))[0].terminal_reason,'job_inactive');
  const beforeMetadata=await rows('SELECT * FROM jobs WHERE id=?',staleJob.jid);
  const staleMetadata=await f.engine('metadata',staleJob.jid,staleIdea.owner);
  assert.equal(staleMetadata.status,'superseded'); assert.equal(staleMetadata.retry_allowed,false);
  assert.deepEqual(await rows('SELECT * FROM jobs WHERE id=?',staleJob.jid),beforeMetadata);
  for(const key of ['claim_token','delivery_token','event','owner']) assert.ok(!(key in staleMetadata));
  assert.ok(!JSON.stringify(staleMetadata).includes(secret));

  const complete=await scenario('done',()=>new Response(null,{status:503}));
  const planner=(await f.rpc('claim_planning_job',{job_id:complete.jid})).result.structuredContent;
  const saved=await f.rpc('save_plan_and_tickets',{job_id:complete.jid,claim_token:planner.claim_token,plan:{title:'Plan',goal:'g',scope:'s',acceptance:'a'},tickets:[{key:'one',title:'Ticket',goal:'g',scope:'s',acceptance:'a'}]});
  assert.ok(saved.result); await due(complete.jid); await f.scheduled(); assert.equal(complete.callback.events.length,1); assert.equal((await job(complete.jid)).status,'done');
  const snapshot=await rows('SELECT * FROM jobs ORDER BY id');
  const visible=JSON.stringify((await f.rpc('list_planning_jobs',{})).result);
  const apiVisible=JSON.stringify((await f.request('/api/planning')).body);
  for(const text of [visible,apiVisible]) for(const privateValue of [secret,planner.claim_token,'delivery_token','claim_token',f.callbackOrigin,'http://127.0.0.1:1/']) assert.ok(!text.includes(privateValue));
  assert.deepEqual(await rows('SELECT * FROM jobs ORDER BY id'),snapshot,'Read-only polling cannot mutate jobs');
  console.log('PASS: superseded/done suppression, atomic valid save, metadata privacy and readonly polling');
  const expiredSub=await scenario('expired-sub',()=>new Response(null,{status:503}));
  const subrow=(await deliveries(expiredSub.jid))[0];
  await f.db.prepare('UPDATE subscriptions SET expires=0 WHERE id=?').bind(subrow.subscription_id).run();
  await due(expiredSub.jid); await f.scheduled();
  assert.equal((await job(expiredSub.jid)).delivery,'no_subscription','Expired target summary updates in same tick');
  assert.equal((await deliveries(expiredSub.jid))[0].terminal_reason,'subscription_inactive');
  expiredSub.callback.respond=()=>new Response(null,{status:204});
  await subscribe(expiredSub.address,'expired-sub'); await f.scheduled();
  assert.equal((await deliveries(expiredSub.jid))[0].status,'accepted');
  assert.equal((await deliveries(expiredSub.jid))[0].attempts,2,'Refresh revives inactive target without resetting history');
  console.log('PASS: expired subscription refresh revives durable target');
  await f.db.prepare("UPDATE planning_deliveries SET status='delivering',attempts=5,delivery_lease=0,delivery_token='last-crash' WHERE job_id=?").bind(expiredSub.jid).run();
  await f.db.prepare('UPDATE subscriptions SET expires=0 WHERE id=?').bind(subrow.subscription_id).run();
  await f.scheduled(); await subscribe(expiredSub.address,'expired-sub'); await f.scheduled();
  assert.equal((await deliveries(expiredSub.jid))[0].status,'failed','Refresh after fifth crashed attempt cannot leave a pending spinner');
  assert.equal((await deliveries(expiredSub.jid))[0].terminal_reason,'attempts_exhausted');



  const blocked=await scenario('blocked-response',()=>new Response(null,{status:503}));
  let arrived,release;
  const arrivedPromise=new Promise(resolve=>{arrived=resolve;});
  const releasedPromise=new Promise(resolve=>{release=resolve;});
  blocked.callback.respond=async()=>{arrived();await releasedPromise;return new Response(null,{status:204});};
  await due(blocked.jid); const inFlight=f.scheduled(); await arrivedPromise;
  const holder=(await f.rpc('claim_planning_job',{job_id:blocked.jid})).result.structuredContent;
  const completed=await f.rpc('save_plan_and_tickets',{job_id:blocked.jid,claim_token:holder.claim_token,plan:{title:'race',goal:'g',scope:'s',acceptance:'a'},tickets:[{key:'one',title:'race',goal:'g',scope:'s',acceptance:'a'}]});
  assert.ok(completed.result); release(); await inFlight;
  assert.equal((await job(blocked.jid)).status,'done'); assert.equal((await job(blocked.jid)).wake_deadline,null,'Late callback cannot install a wake on a completed job');
  await f.scheduled(); assert.equal((await deliveries(blocked.jid))[0].status,'stopped');
  console.log('PASS: planner claim/save racing an in-flight callback rejects stale delivery completion');

  for(const kind of ['invalid-secret','invalid-url','oversized']) {
    const unsafe=await scenario(kind,()=>new Response(null,{status:503}));
    const d=(await deliveries(unsafe.jid))[0];
    if(kind==='oversized') {
      const e=JSON.parse((await job(unsafe.jid)).event); e.data.project='x'.repeat(270000);
      await f.db.prepare('UPDATE jobs SET event=? WHERE id=?').bind(JSON.stringify(e),unsafe.jid).run();
      await f.db.prepare("UPDATE subscriptions SET body=json_set(body,'$.args.project',?) WHERE id=?").bind(e.data.project,d.subscription_id).run();
    } else await f.db.prepare('UPDATE subscriptions SET body=json_set(body,?,?) WHERE id=?').bind(kind==='invalid-secret'?'$.secret':'$.url',kind==='invalid-secret'?'bad':'https://evil.example/',d.subscription_id).run();
    await due(unsafe.jid); await f.scheduled();
    const stopped=(await deliveries(unsafe.jid))[0]; assert.equal(stopped.status,'failed');
    assert.equal(stopped.terminal_reason,kind==='oversized'?'event_too_large':'invalid_callback_or_secret');
    assert.equal(unsafe.callback.events.length,1,'Unsafe callbacks/events never leave the native server');
    // Isolate the deliberately malformed fixture from later backlog tests.
    await f.db.prepare('DELETE FROM subscriptions WHERE id=?').bind(d.subscription_id).run();
  }
  console.log('PASS: malformed callback/secret and oversized payload terminate with safe reasons');

  const backlog=[];
  for(let n=0;n<53;n++) backlog.push(await create('Backlog '+n,'Backlog'));
  const backlogAddress='http://127.0.0.1:1/backlog'; callbacks[backlogAddress]={secret,events:[]};
  await subscribe(backlogAddress,'Backlog');
  let prior=callbacks[backlogAddress].events.length;
  assert.ok(prior<=20,'Subscription backfill outbound respects twenty-target cap');
  const discovered=async()=> (await rows("SELECT DISTINCT job_id FROM planning_deliveries WHERE subscription_id IN (SELECT id FROM subscriptions WHERE json_extract(body,'$.args.project')='Backlog')")).length;
  let priorDiscovered=await discovered();
  assert.ok(priorDiscovered<=50,'Subscription backfill discovers at most fifty jobs');
  for(let tick=0;tick<10 && prior<53;tick++) {
    await f.scheduled();
    const delivered=callbacks[backlogAddress].events.length;
    assert.ok(delivered-prior<=20,'Scheduled outbound respects twenty-target cap');
    const count=await discovered();
    assert.ok(count-priorDiscovered<=50,'Each scheduled invocation discovers at most fifty jobs');
    priorDiscovered=count;
    prior=delivered;
  }
  assert.equal(prior,53,'Bounded scans eventually drain persisted backlog without starvation');
  assert.equal(new Set(callbacks[backlogAddress].events.map(e=>e.id)).size,53);
  console.log('PASS: bounded fifty-job discovery and twenty-target scheduled backlog drain');

  const pending=await job(orphan);
  assert.equal((await f.engine('retry',orphan,pending.owner)).generation,pending.generation,'Pending no-subscription manual clicks do not churn events');
  await f.rpc('claim_planning_job',{job_id:orphan});
  const active=await job(orphan);
  assert.equal((await f.engine('retry',orphan,active.owner)).claim_token,active.claim_token,'Manual retry preserves a live planner claim');
  await f.db.prepare('UPDATE jobs SET lease=0 WHERE id=?').bind(orphan).run();
  const expiredBefore=await rows('SELECT * FROM jobs WHERE id=?',orphan);
  const expiredMetadata=await f.engine('metadata',orphan,active.owner);
  assert.equal(expiredMetadata.status,'expired'); assert.equal(expiredMetadata.retry_allowed,true);
  assert.deepEqual(await rows('SELECT * FROM jobs WHERE id=?',orphan),expiredBefore,'Expired metadata is readonly');
  const manual=await Promise.all(Array.from({length:6},()=>f.engine('retry',orphan,active.owner)));
  assert.ok(manual.every(j=>j.generation===active.generation+1),'Concurrent manual retry resets once');
  assert.equal((await job(orphan)).recoveries,0);
  assert.ok((await job(orphan)).retry_after-Date.now()>55000);
  assert.equal((await f.engine('metadata',orphan,active.owner)).retry_allowed,false);
  const exhausted=await job(id);
  const reset=await f.engine('retry',id,exhausted.owner);
  assert.equal(reset.generation,4); assert.equal(reset.recoveries,0); assert.equal(reset.recovery_reason,'manual_retry');
  const failure=await scenario('manual-failure',()=>new Response(null,{status:400}));
  const failureJob=await job(failure.jid);
  await f.engine('retry',failure.jid,failureJob.owner); await f.engine('deliver',failure.jid,failureJob.owner);
  assert.equal((await job(failure.jid)).delivery,'failed');
  assert.equal((await f.engine('metadata',failure.jid,failureJob.owner)).retry_allowed,false,'Cooldown suppresses another failed generation');
  assert.equal((await f.engine('retry',failure.jid,failureJob.owner)).generation,1);
  await f.db.prepare('UPDATE jobs SET retry_after=0 WHERE id=?').bind(failure.jid).run();
  assert.equal((await f.engine('metadata',failure.jid,failureJob.owner)).retry_allowed,true);
  assert.equal((await f.engine('retry',failure.jid,failureJob.owner)).generation,2);
  assert.equal(await f.engine('retry',failure.jid,'foreign-owner'),null);
  assert.equal(await f.engine('retry',staleJob.jid,staleIdea.owner),null);
  const doneJob=await job(complete.jid);
  assert.deepEqual(await f.engine('retry',complete.jid,doneJob.owner),doneJob);
  const acceptedJob=await job(concurrent.jid);
  assert.equal((await f.engine('retry',concurrent.jid,acceptedJob.owner)).generation,acceptedJob.generation,'Accepted events before wake deadline stay stable');
  console.log('PASS: shared native metadata and manual CAS, cooldown, exhaustion reset, owner/current/done guards');

  const ordered=await scenario('due-order',()=>new Response(null,{status:204}));
  for(let n=0;n<20;n++) await create('Ordered '+n,'due-order');
  const orderSubscription=(await deliveries(ordered.jid))[0].subscription_id;
  const dueNow=Date.now();
  await f.db.prepare("UPDATE planning_deliveries SET status='retrying',next_attempt_at=? WHERE subscription_id=?").bind(dueNow-2000,orderSubscription).run();
  await f.db.prepare("UPDATE planning_deliveries SET status='delivering',next_attempt_at=0,delivery_lease=?,delivery_token='crash-order' WHERE job_id=?").bind(dueNow-1000,ordered.jid).run();
  await f.scheduled();
  assert.equal(ordered.callback.events.filter(e=>e.event.data.job_id===ordered.jid).length,1,'Twenty older due targets precede a more recently expired delivery lease');
  await f.scheduled(); assert.equal(ordered.callback.events.filter(e=>e.event.data.job_id===ordered.jid).length,2);
  console.log('PASS: due ordering uses delivery lease expiry when replaying crashed attempts');
} finally { await f.close(); }

await import('./recovery-delivery-review.mjs');
