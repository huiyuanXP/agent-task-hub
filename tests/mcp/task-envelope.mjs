import assert from 'node:assert/strict';
import { prepareExecution } from '../../lib/execution/authorization.mts';
import { getOperationCatalog } from '../../lib/execution/catalog.mts';
import { transitionRun } from '../../lib/execution/runs.mts';
import { consumerFixture } from '../execution/fixtures/consumer.mjs';
const f = await consumerFixture();
const limit = 4 * 1048576, sizes = [];
const rpc = async (name, args) => {
    const reply = await f.api('/mcp', { jsonrpc: '2.0', id: 'i'.repeat(128), method: 'tools/call', params: { name, arguments: args } });
    assert.equal(reply.status, 200);
    assert.equal(reply.data.error, undefined, name + ': ' + JSON.stringify(reply.data.error));
    const bytes = Buffer.byteLength(JSON.stringify(reply.data));
    assert.ok(bytes <= limit, 'complete owner read envelope is finite');
    sizes.push({ name, bytes });
    assert.deepEqual(JSON.parse(reply.data.result.content[0].text), reply.data.result.structuredContent);
    return reply.data.result.structuredContent;
};
const create = async (kind, extra = {}, field = 'notes') => {
    const body = { title: 'Maximum legal ' + kind, ...extra, [field]: '' };
    body[field] = '漢'.repeat(80000 - JSON.stringify(body).length);
    assert.equal(JSON.stringify(body).length, 80000);
    const reply = await f.api('/api/records', { kind, ...body });
    assert.equal(reply.status, 201, JSON.stringify(reply.data));
    return { id: reply.data.id, body };
};
try {
    const idea = await create('idea');
    const plan = await create('plan', { ideaId: idea.id, ideaRevision: 1 });
    const tickets = [];
    for (let i = 0; i < 12; i++) tickets.push(await create('ticket', { planId: plan.id, status: 'todo' }));
    const ticket = tickets[0], runs = [];
    for (let i = 0; i < 12; i++) runs.push(await create('run', { ticketId: ticket.id }));
    const context = { owner: f.owner, actor: f.owner, grantAuthority: 'owner', registry: f.registry };
    const catalog = await getOperationCatalog(f.db, context, { ticketId: ticket.id, expectedRevision: 1 });
    const executions = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
        const result = await prepareExecution(f.db, context, { ticketId: ticket.id, expectedRevision: 1, requestId: 'envelope-' + attempt, attempt,
            scope: [{ operationId: catalog.operations[0].operationId, definitionHash: catalog.operations[0].definitionHash }],
            budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 600000 });
        await transitionRun(f.db, context, { id: result.run.id, expectedVersion: 1, to: 'cancelled' });
        executions.push(result.run.id);
    }
    const detail = await rpc('get_ticket', { ticket_id: ticket.id });
    assert.equal(detail.ticket.notes, ticket.body.notes);
    assert.equal(detail.plan.notes, plan.body.notes);
    assert.equal(detail.idea.notes, idea.body.notes);
    assert.equal(detail.source_idea.notes, idea.body.notes);
    assert.ok(detail.runs.items.length >= 1 && detail.runs.items.length < 12);
    const observed = [...detail.runs.items];
    let cursor = detail.runs.next_cursor;
    while (cursor) {
        const page = await rpc('list_ticket_runs', { ticket_id: ticket.id, limit: 100, cursor });
        assert.ok(page.items.length);
        observed.push(...page.items); cursor = page.next_cursor;
    }
    assert.deepEqual(observed.map(r => r.id).sort(), [...runs.map(r => r.id), ...executions].sort());
    for (const run of observed) {
        assert.equal(run.contract.notes, ticket.body.notes);
        if (run.source === 'manual') assert.equal(run.notes, runs.find(r => r.id === run.id).body.notes);
        else { assert.equal(run.state, 'cancelled'); assert.equal(run.authorization.effective_status, 'pending'); }
    }
    const planDetail = await rpc('get_plan', { plan_id: plan.id });
    assert.equal(planDetail.plan.notes, plan.body.notes);
    const found = [...planDetail.tickets.items];
    cursor = planDetail.tickets.next_cursor;
    while (cursor) {
        const page = await rpc('list_tickets', { plan_id: plan.id, limit: 100, cursor });
        assert.ok(page.items.length); found.push(...page.items); cursor = page.next_cursor;
    }
    assert.deepEqual(found.map(t => t.id).sort(), tickets.map(t => t.id).sort());
    for (const row of found) assert.equal(row.notes, tickets.find(t => t.id === row.id).body.notes);
    const listing = await rpc('list_tickets', { limit: 100 });
    assert.ok(listing.items.length >= 1 && listing.items.length < 12 && listing.next_cursor);
    // Existing planning admission also copies original Idea priority into both
    // Plan and Ticket; exercise that expansion rather than assuming every stored
    // generated record has the manual API's 80,000-unit body bound.
    const expandedIdea = await create('idea', {}, 'priority');
    const job = await f.db.prepare('SELECT id FROM jobs WHERE owner=? AND idea_id=?').bind(f.owner, expandedIdea.id).first();
    const claim = await rpc('claim_planning_job', { job_id: job.id });
    const input = { job_id: job.id, claim_token: claim.claim_token,
        plan: { title: 'Expanded plan', goal: 'Plan', scope: 'Plan', acceptance: 'Plan' },
        tickets: [{ key: 'expanded', title: 'Expanded ticket', goal: 'Work', scope: 'Work', acceptance: 'Work', assumptions: '' }] };
    input.tickets[0].assumptions = '\\'.repeat(Math.floor((180000 - JSON.stringify(input).length) / 2));
    assert.ok(JSON.stringify(input).length >= 179999 && JSON.stringify(input).length <= 180000);
    const saved = await rpc('save_plan_and_tickets', input);
    const expandedTicketId = saved.ticket_ids[0];
    const expandedRuns = [await create('run', { ticketId: expandedTicketId }), await create('run', { ticketId: expandedTicketId })];
    const expanded = await rpc('get_ticket', { ticket_id: expandedTicketId });
    assert.equal(expanded.ticket.assumptions, input.tickets[0].assumptions);
    assert.equal(expanded.plan.priority, expandedIdea.body.priority);
    assert.equal(expanded.idea.priority, expandedIdea.body.priority);
    assert.equal(expanded.source_idea.priority, expandedIdea.body.priority);
    assert.equal(expanded.runs.items.length, 1);
    assert.equal(expanded.runs.items[0].contract.assumptions, input.tickets[0].assumptions);
    const rest = await rpc('list_ticket_runs', { ticket_id: expandedTicketId, cursor: expanded.runs.next_cursor });
    assert.deepEqual([...expanded.runs.items, ...rest.items].map(r => r.id).sort(), expandedRuns.map(r => r.id).sort());
    console.log('Owner aggregate envelope measurements: ' + JSON.stringify(sizes));
    console.log('Actual owner API admits maximum 80000-UTF16-unit records and manual frozen contracts; detail fields remain complete and byte-bounded cursor pages cover every item without duplicates or omissions');
} finally { await f.close(); }
