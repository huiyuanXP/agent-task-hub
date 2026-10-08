// Native server, real verified local account identity and isolated SQLite; no dispatcher mocks.
import assert from 'node:assert/strict';
import { planningFixture } from '../planning/fixture.mjs';
for (const executionRegistry of ['{broken-json','null','[]']) {
  const fixture = await planningFixture({ executionRegistry });
  try {
    const created = await fixture.rpc('create_idea', { request_id: 'registry-isolation', title: 'Planning remains available', text: 'Synthetic planning contract' });
    assert.equal(created.error, undefined, JSON.stringify(created));
    const { idea_id: ideaId, job_id: jobId } = created.result.structuredContent;
    assert.equal((await fixture.rpc('get_idea', { idea_id: ideaId })).result.structuredContent.title, 'Planning remains available');
    assert.ok((await fixture.rpc('get_idea', { idea_id: ideaId }, 'bob')).error);
    const claim = await fixture.rpc('claim_planning_job', { job_id: jobId });
    assert.equal(claim.error, undefined, JSON.stringify(claim));
    const saved = await fixture.rpc('save_plan_and_tickets', { job_id: jobId, claim_token: claim.result.structuredContent.claim_token,
      plan: { title: 'Actual plan', goal: 'Preserve planning', scope: 'Execution config isolation', acceptance: 'Saved in SQLite' },
      tickets: [{ key: 'one', title: 'Actual ticket', goal: 'Verify boundaries', scope: 'Synthetic', acceptance: 'Execution rejects invalid config' }] });
    assert.equal(saved.error, undefined, JSON.stringify(saved));
    const ticket = await fixture.db.prepare("SELECT id,revision FROM records WHERE kind='ticket'").first();
    assert.ok(ticket);
    const unavailable = await fixture.rpc('get_operation_catalog', { ticketId: ticket.id, expectedRevision: ticket.revision });
    assert.deepEqual(unavailable.error.data, { code: 'CONFIGURATION_UNAVAILABLE', status: 503 });
    assert.equal((await fixture.rpc('list_planning_jobs', {})).error, undefined);
    console.log('PASS: invalid execution registry '+JSON.stringify(executionRegistry)+' preserves authenticated planning create/read/claim/save and isolates execution503');
  } finally { await fixture.close(); }
}
