// Contract regressions: actual authenticated Worker routes, not internal helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planningFixture } from './fixture.mjs';
const secret = 'whsec_' + Buffer.alloc(32, 17).toString('base64');
const callbacks = {};
const f = await planningFixture({ callbacks });
const job = id => f.db.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
const create = async (project, actor = 'alice') => {
  const response = await f.request('/api/records', { kind: 'idea', title: project, project }, actor);
  assert.equal(response.status, 201); return { idea: response.body, id: `planning:${response.body.id}:1` };
};
const subscription = async (project, method = 'events/subscribe', actor = 'alice') => {
  const url = 'https://chatgpt.com/lifecycle-' + project;
  callbacks[url] ??= { secret, events: [] };
  const response = await f.request('/mcp', { jsonrpc: '2.0', id: 1, method, params: { name: 'idea.planning_requested', arguments: { project }, delivery: { mode: 'webhook', url, secret } } }, actor);
  assert.ok(response.body.result, JSON.stringify(response.body));
  return { ...response.body.result, target: callbacks[url] };
};
const publicJob = async id => (await f.request('/api/planning')).body.jobs.find(j => j.id === id);
const noSecrets = value => {
  const text = JSON.stringify(value);
  for (const field of ['claim_token', 'delivery_token', 'eventId', 'previousSecret', 'secret-marker', secret, 'https://chatgpt.com/lifecycle-']) assert.ok(!text.includes(field), `Private field leaked: ${field}`);
};
try {
  await test('subscribe and refresh immediately backfill exact owner/project with bounded discovery and outbound', async () => {
    const {id} = await create('backfill'); await create('other-project'); await create('backfill', 'bob');
    const sub = await subscription('backfill');
    assert.equal(sub.target.events.length, 1, 'Subscribe must wake existing no-subscription job immediately');
    assert.equal(sub.target.events[0].event.data.job_id, id);
    await subscription('backfill'); assert.equal(sub.target.events.length, 1, 'Refresh retains accepted event identity');
    await f.db.prepare('UPDATE subscriptions SET expires=0 WHERE id=?').bind(sub.id).run();
    const pending = await create('backfill');
    await subscription('backfill'); assert.equal(sub.target.events.length, 2, 'Refresh immediately discovers disconnected backlog');
    assert.equal(sub.target.events[1].event.data.job_id, pending.id);
    for (let i = 0; i < 61; i++) await create('bounded');
    const bounded = await subscription('bounded');
    assert.equal(bounded.target.events.length, 20, 'At most twenty outbound callbacks in subscription request');
    const count = await f.db.prepare('SELECT count(*) AS n FROM planning_deliveries WHERE subscription_id=?').bind(bounded.id).first();
    assert.ok(count.n >= 20 && count.n <= 50, 'At most fifty discovered jobs in subscription request');
  });
  await test('subscription runtime shape validation fails before verification or persistence', async () => {
    const url = 'https://chatgpt.com/lifecycle-invalid';
    callbacks[url] = { secret, events: [] };
    const valid = { name: 'idea.planning_requested', arguments: { project: 'invalid' }, delivery: { mode: 'webhook', url, secret } };
    const before = await f.db.prepare('SELECT count(*) AS n FROM subscriptions').first();
    for (const params of [
      {...valid, arguments: []}, {...valid, arguments: null}, {...valid, arguments: {project: 'x'.repeat(121)}},
      {...valid, ttlMs: '60000'}, {...valid, ttlMs: {}}, {...valid, delivery: {...valid.delivery, url: {}}},
      {...valid, delivery: {...valid.delivery, secret: null}},
    ]) {
      const response = await f.request('/mcp', {jsonrpc:'2.0', id:1, method:'events/subscribe', params});
      assert.ok(response.body.error, 'Invalid subscription must keep the RPC error envelope');
      assert.deepEqual(await f.db.prepare('SELECT count(*) AS n FROM subscriptions').first(), before);
    }
    assert.equal(callbacks[url].events.length,0);
  });
  await test('manual retry validates runtime shape, origin, owner, active lease and initial current-revision insertion', async () => {
    const {idea, id} = await create('manual-active');
    for (const body of [null, [], {}, {ideaId: null}, {ideaId: 7}, {ideaId: []}, {ideaId: {}}, {ideaId: ''}, {ideaId: ' '.repeat(3)}, {ideaId: idea.id, extra: true}]) {
      const response = await f.request('/api/planning', body);
      assert.equal(response.status, 400, `Invalid shape: ${JSON.stringify(body)}`);
    }
    assert.equal((await f.request('/api/planning', {ideaId: idea.id}, 'alice', {origin:'https://foreign.example.test'})).status,403);
    assert.equal((await f.request('/api/planning', {ideaId: idea.id}, 'bob')).status,404);
    const claimed = (await f.rpc('claim_planning_job', {job_id: id})).result.structuredContent;
    const before = await job(id);
    const response = await f.request('/api/planning', {ideaId: idea.id});
    assert.equal(response.status,200); assert.equal(response.body.job.status,'planning');
    assert.equal(response.body.job.lease_expires, before.lease); assert.equal(response.body.job.retry_allowed,false);
    assert.equal((await job(id)).claim_token,claimed.claim_token); assert.equal((await job(id)).generation,0);
    noSecrets(response.body);
    // A legacy Idea with no job creates exactly one current revision job.
    await f.db.prepare('DELETE FROM jobs WHERE id=?').bind(id).run();
    await Promise.all([f.request('/api/planning',{ideaId:idea.id}),f.request('/api/planning',{ideaId:idea.id})]);
    assert.equal((await job(id)).idea_revision,1);
    assert.equal((await f.db.prepare('SELECT count(*) AS n FROM jobs WHERE idea_id=?').bind(idea.id).first()).n,1);
  });
  await test('manual expired and failed retries reset once with sixty-second cooldown and current revision CAS', async () => {
    const {idea,id} = await create('manual-expired');
    await f.rpc('claim_planning_job',{job_id:id});
    await f.db.prepare('UPDATE jobs SET lease=0 WHERE id=?').bind(id).run();
    const visible = await publicJob(id); assert.equal(visible.status,'expired'); assert.equal(visible.retry_allowed,true);
    const replies = await Promise.all(Array.from({length:6},()=>f.request('/api/planning',{ideaId:idea.id})));
    for (const reply of replies) { assert.equal(reply.status,200); noSecrets(reply.body); }
    let stored = await job(id); assert.equal(stored.generation,1,'Concurrent manual retries reset one generation');
    assert.ok(stored.retry_after > Date.now() + 55000); assert.equal(stored.recovery_reason,'manual_retry');
    await f.db.prepare("UPDATE jobs SET delivery='failed',recovery_reason='recovery_exhausted' WHERE id=?").bind(id).run();
    const blocked = await f.request('/api/planning',{ideaId:idea.id}); assert.equal(blocked.body.job.retry_allowed,false);
    assert.equal((await job(id)).generation,1,'Cooldown prevents repeated failed resets');
    await f.db.prepare('UPDATE jobs SET retry_after=0 WHERE id=?').bind(id).run();
    const retried = await f.request('/api/planning',{ideaId:idea.id}); assert.equal(retried.body.job.generation,2); assert.equal(retried.body.job.recoveries,0);
    await f.request('/api/records',{...idea,kind:'idea',title:'Revised',revision:1});
    const afterEdit = await f.request('/api/planning',{ideaId:idea.id});
    assert.equal(afterEdit.body.job.idea_revision,2); assert.equal((await job(id)).generation,2);
  });
  await test('owner readonly API/MCP/Idea metadata exposes backoff/permanent/expired state without tokens or read mutation', async () => {
    const sub = await subscription('metadata'); sub.target.respond = () => new Response(null,{status:503});
    const {idea,id} = await create('metadata');
    const expected = await job(id);
    const routes = [await publicJob(id),(await f.rpc('list_planning_jobs')).result.structuredContent.jobs.find(j=>j.id===id), (await f.request('/api/records')).body.records.find(r=>r.id===idea.id).planning, (await f.rpc('get_idea',{idea_id:idea.id})).result.structuredContent.planning];
    for (const metadata of routes) {
      assert.equal(metadata.delivery,'retrying'); assert.equal(metadata.attempt_total,1); assert.ok(metadata.next_retry_at>Date.now());
      assert.equal(metadata.targets[0].last_http_status,503); assert.equal(metadata.retry_allowed,false); noSecrets(metadata);
    }
    assert.deepEqual(await job(id),expected,'Readonly polling does not alter job');
    sub.target.respond = () => new Response(null,{status:400});
    await f.db.prepare('UPDATE planning_deliveries SET next_attempt_at=0 WHERE job_id=?').bind(id).run();
    await f.scheduled();
    const failed = await publicJob(id); assert.equal(failed.delivery,'failed'); assert.equal(failed.retry_allowed,true); assert.equal(failed.targets[0].reason,'permanent_http');
    await f.rpc('claim_planning_job',{job_id:id}); await f.db.prepare("UPDATE jobs SET lease=0,claim_token='secret-marker' WHERE id=?").bind(id).run();
    assert.equal((await publicJob(id)).status,'expired'); noSecrets((await f.request('/api/planning')).body); noSecrets((await f.rpc('list_planning_jobs')).result);
  });
  await test('unsubscribe immediately marks only owner pending targets inactive without callback', async () => {
    const sub = await subscription('unsubscribe'); sub.target.respond = () => new Response(null,{status:503});
    const {id} = await create('unsubscribe'); assert.equal(sub.target.events.length,1);
    await subscription('unsubscribe','events/unsubscribe');
    const metadata = await publicJob(id);
    assert.equal(metadata.delivery,'no_subscription'); assert.equal(metadata.targets[0].reason,'subscription_inactive');
    assert.equal(metadata.targets[0].status,'stopped'); assert.equal(sub.target.events.length,1); noSecrets(metadata);
  });
} finally { await f.close(); }
