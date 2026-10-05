import assert from 'node:assert/strict';
import { planningFixture } from './fixture.mjs';
const fixture = await planningFixture();
const {db, request, rpc} = fixture;
const rows = async (query, ...values) => (await db.prepare(query).bind(...values).all()).results;
const save = async (body, expected = 201, actor = 'alice') => { const result = await request('/api/records', body, actor); assert.equal(result.status, expected, JSON.stringify(result.body)); return result.body; };
try {
  const original = {kind:'idea', title:'Original revision', text:'Keep the original wording', project:'First project', priority:'P2'};
  // Without runtime project validation these requests corrupt event/subscription matching.
  for (const project of [{team:'bad'}, ['bad'], 7, null, 'x'.repeat(121)]) {
    const before = await rows('SELECT id FROM records');
    await save({...original, project},400);
    assert.deepEqual(await rows('SELECT id FROM records'), before);
    assert.equal((await rows('SELECT id FROM jobs')).length,0);
  }

  const created = await save(original);
  for (const project of [{team:'bad'}, ['bad'], 7, null, 'x'.repeat(121)]) {
    await save({...original,id:created.id,revision:1,project},400);
    assert.equal((await rows('SELECT revision FROM records WHERE id=?',created.id))[0].revision,1);
    assert.equal((await rows("SELECT id FROM records WHERE kind='history'")).length,0);
    assert.equal((await rows('SELECT id FROM jobs')).length,1);
  }
  console.log('PASS: invalid create/update project returns 400 without records/history/jobs changes');
  const oldJob = 'planning:' + created.id + ':1';
  const claimed = (await rpc('claim_planning_job',{job_id:oldJob})).result.structuredContent;
  assert.ok(claimed.claim_token);
  const changed = {...original,id:created.id,revision:1,title:'Updated revision',project:'Updated project',priority:'P1'};
  await save(changed,200);
  const jobs = await rows('SELECT * FROM jobs WHERE idea_id=? ORDER BY idea_revision',created.id);
  assert.equal(jobs.length,2); assert.equal(jobs[1].idea_revision,2);
  assert.equal(jobs[1].status,'queued'); assert.equal(jobs[1].delivery,'no_subscription');
  const event=JSON.parse(jobs[1].event);
  assert.deepEqual(event.data,{idea_id:created.id,idea_revision:2,job_id:'planning:'+created.id+':2',project:'Updated project'});
  assert.equal(event.eventId,'evt_planning:'+created.id+':2');
  await save(changed,409);
  assert.equal((await rows('SELECT id FROM jobs WHERE idea_id=?',created.id)).length,2);
  const history=await rows("SELECT body FROM records WHERE kind='history' AND json_extract(body,'$.recordId')=?",created.id);
  assert.equal(history.length,1); assert.deepEqual(JSON.parse(history[0].body).snapshot,{title:'Original revision',text:'Keep the original wording',project:'First project',priority:'P2'});
  const stale=await rpc('save_plan_and_tickets',{job_id:oldJob,claim_token:claimed.claim_token,plan:{title:'Stale',goal:'Old goal',scope:'Old scope',acceptance:'Old acceptance'},tickets:[{key:'old',title:'Old ticket',goal:'Old goal',scope:'Old scope',acceptance:'Old acceptance'}]});
  assert.ok(stale.error); assert.equal((await rows("SELECT id FROM records WHERE kind='plan' AND json_extract(body,'$.ideaId')=?",created.id)).length,0);
  await save({...changed,revision:2,title:'Foreign update'},404,'bob');
  console.log('PASS: automatic current revision event, idempotent conflict/history, stale planner and owner protection');

  const competing=await Promise.all(Array.from({length:6},(_,i)=>request('/api/records',{...changed,revision:2,title:'Concurrent '+i})));
  assert.equal(competing.filter(r=>r.status===200).length,1); assert.equal(competing.filter(r=>r.status===409).length,5);
  const winner=competing.findIndex(r=>r.status===200);
  const record=(await rows('SELECT body,revision FROM records WHERE id=?',created.id))[0];
  assert.equal(record.revision,3); assert.equal(JSON.parse(record.body).title,'Concurrent '+winner);
  assert.equal((await rows('SELECT id FROM jobs WHERE idea_id=? AND idea_revision=3',created.id)).length,1);
  assert.equal((await rows("SELECT id FROM records WHERE kind='history' AND json_extract(body,'$.recordId')=?",created.id)).length,2);
  console.log('PASS: six simultaneous edits produce one revision, one history and one job');

  const rollback=await save({...original,title:'Rollback idea'});
  await db.prepare(`CREATE TRIGGER fail_revision_job BEFORE INSERT ON jobs WHEN NEW.idea_id='${rollback.id}' AND NEW.idea_revision=2 BEGIN SELECT RAISE(ABORT,'synthetic outbox storage failure'); END`).run();
  await save({...original,id:rollback.id,revision:1,title:'Must not commit'},503);
  const retained=(await rows('SELECT body,revision FROM records WHERE id=?',rollback.id))[0];
  assert.equal(retained.revision,1); assert.equal(JSON.parse(retained.body).title,'Rollback idea');
  assert.equal((await rows("SELECT id FROM records WHERE kind='history' AND json_extract(body,'$.recordId')=?",rollback.id)).length,0);
  assert.equal((await rows('SELECT id FROM jobs WHERE idea_id=?',rollback.id)).length,1);
  await db.prepare('DROP TRIGGER fail_revision_job').run();
  console.log('PASS: failed job insertion rolls back idea revision and history atomically');
} finally { await fixture.close(); }
