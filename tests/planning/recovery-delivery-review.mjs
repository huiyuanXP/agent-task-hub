import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planningFixture } from './fixture.mjs';

async function setup() {
  const secret = 'whsec_' + Buffer.alloc(32, 17).toString('base64');
  const url = 'http://127.0.0.1:1/delivery-review';
  const callback = {secret, events: [], respond: () => new Response(null, {status: 503})};
  const f = await planningFixture({callbacks: {[url]: callback}, engineHarness: true});
  const rows = async (sql, ...args) => (await f.db.prepare(sql).bind(...args).all()).results;
  const create = async (title, actor = 'alice') => {
    const sub = await f.request('/mcp', {jsonrpc: '2.0', id: 1, method: 'events/subscribe', params: {
      name: 'idea.planning_requested', arguments: {project: 'Review'}, delivery: {mode: 'webhook', url, secret},
    }}, actor);
    assert.ok(sub.body.result);
    const response = await f.request('/api/records', {kind: 'idea', title, project: 'Review'}, actor);
    assert.equal(response.status, 201);
    return (await rows('SELECT * FROM jobs WHERE idea_id=?', response.body.id))[0];
  };
  const addInvalid = async (job, count, prefix, offset = 0) => {
    const template = (await rows('SELECT * FROM planning_deliveries WHERE job_id=?', job.id))[0];
    await f.db.batch(Array.from({length: count}, (_, i) => f.db.prepare(`
      INSERT INTO planning_deliveries(id,owner,job_id,subscription_id,generation,event_id,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'retrying',1,0,0,?)
    `).bind(`${prefix}:${String(i + offset).padStart(3, '0')}`, job.owner, job.id, `${prefix}:missing:${i + offset}`,
      i % 2 ? job.generation : job.generation + 99, template.event_id, i + offset)));
  };
  return {f, rows, create, addInvalid, callback};
}

await test('request maintenance leaves other jobs and owners untouched', async () => {
  const {f, rows, create, addInvalid} = await setup();
  try {
    const own = await create('Scoped request');
    const sibling = await create('Other job');
    const foreign = await create('Other owner', 'bob');
    await addInvalid(own, 1, 'own');
    await addInvalid(sibling, 1, 'sibling');
    await addInvalid(foreign, 1, 'foreign');
    const before = await rows("SELECT * FROM planning_deliveries WHERE id LIKE 'sibling:%' OR id LIKE 'foreign:%' ORDER BY id");
    const response = await f.request('/api/planning', {ideaId: own.idea_id});
    assert.equal(response.status, 200);
    assert.equal((await rows("SELECT status FROM planning_deliveries WHERE id='own:000'"))[0].status, 'stopped');
    assert.deepEqual(await rows("SELECT * FROM planning_deliveries WHERE id LIKE 'sibling:%' OR id LIKE 'foreign:%' ORDER BY id"), before,
      'One authenticated job request must not maintain another job or owner');
    await f.engine('due', undefined, own.owner);
    assert.equal((await rows("SELECT status FROM planning_deliveries WHERE id='sibling:000'"))[0].status, 'stopped');
    assert.deepEqual((await rows("SELECT * FROM planning_deliveries WHERE id='foreign:000'"))[0], before.find(row => row.id === 'foreign:000'),
      'Owner-scoped maintenance may process sibling jobs but never a foreign owner');

  } finally { await f.close(); }
});

await test('scheduled housekeeping invalidates at most fifty targets total and continues in stable order', async () => {
  const {f, rows, create, addInvalid, callback} = await setup();
  try {
    const job = await create('Housekeeping backlog');
    const foreign = await create('Foreign housekeeping backlog', 'bob');
    await addInvalid(job, 37, 'cleanup');
    await addInvalid(foreign, 36, 'cleanup', 37);
    await f.db.prepare("UPDATE planning_deliveries SET attempts=5 WHERE id>='cleanup:050' AND id LIKE 'cleanup:%'").run();
    const callbacksBefore = callback.events.length;
    await f.scheduled();
    const first = await rows("SELECT id FROM planning_deliveries WHERE id LIKE 'cleanup:%' AND status='stopped' ORDER BY id");
    assert.equal(first.length, 50, 'A tick shares one fifty-target budget across both invalidation reasons');
    assert.deepEqual(first.map(row => row.id), Array.from({length: 50}, (_, i) => `cleanup:${String(i).padStart(3, '0')}`));
    assert.equal(callback.events.length, callbacksBefore, 'Invalid rows left for later ticks cannot send');
    const remaining = await rows("SELECT status,attempts,delivery_token FROM planning_deliveries WHERE id LIKE 'cleanup:%' AND status<>'stopped'");
    assert.equal(remaining.length, 23);
    assert.ok(remaining.every(row => row.status === 'retrying' && row.attempts === 5 && row.delivery_token === null),
      'Acquisition guards suppress invalid rows without consuming attempts while cleanup is deferred');

    await f.scheduled();
    assert.equal((await rows("SELECT id FROM planning_deliveries WHERE id LIKE 'cleanup:%' AND status='stopped'")).length, 73);
    assert.equal(callback.events.length, callbacksBefore);
  } finally { await f.close(); }
});

for (const boundary of ['backoff', 'exhaustion']) await test(`delayed competing acquisition uses its actual attempt for ${boundary}`, async () => {
  const {f, rows, create, callback} = await setup();
  try {
    const job = await create('Delayed acquisition');
    const due = () => f.db.prepare('UPDATE planning_deliveries SET next_attempt_at=0 WHERE job_id=?').bind(job.id).run();
    const deliver = async () => {
      const response = await f.request('/api/planning', {ideaId: job.idea_id});
      assert.equal(response.status, 200);
    };
    if (boundary === 'exhaustion') for (let i = 0; i < 2; i++) { await due(); await deliver(); }
    await due();
    const paused = f.engine('delayed-due', job.id, job.owner);
    try {
      let ready = false;
      for (let n = 0; n < 100; n++) {
        if ((await f.engine('pause-state', job.id, job.owner)).paused) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(ready, 'Delayed native query selected its due target before the competing attempt');
      await deliver();
      await due();
    } finally { await f.engine('resume', job.id, job.owner); await paused; }
    const target = (await rows('SELECT * FROM planning_deliveries WHERE job_id=?', job.id))[0];
    if (boundary === 'backoff') {
      assert.equal(target.attempts, 3); assert.equal(callback.events.length, 3);
      assert.equal(target.status, 'retrying');
      assert.ok(target.next_attempt_at - Date.now() > 115000, 'Actual attempt three requires 120-second backoff');
      assert.ok(target.next_attempt_at - Date.now() <= 120000);
    } else {
      assert.equal(target.attempts, 5); assert.equal(callback.events.length, 5);
      assert.equal(target.status, 'failed', 'Actual attempt five must immediately exhaust retries');
      assert.equal(target.terminal_reason, 'attempts_exhausted'); assert.equal(target.next_attempt_at, null);
    }
    assert.equal(new Set(callback.events.map(event => event.id)).size, 1);
  } finally { await f.close(); }
});
