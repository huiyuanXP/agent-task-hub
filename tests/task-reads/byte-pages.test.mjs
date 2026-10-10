import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../execution/sqlite.mjs';
import { listRecords, getPlan } from '../../lib/task-reads/queries.mts';
import { listTicketRuns } from '../../lib/task-reads/runs.mts';
import { dispatchTaskReadTool } from '../../lib/task-reads/mcp.mts';
import { encodeCursor } from '../../lib/task-reads/cursor.mts';
import { boundedMCPResponse, MAX_MCP_RESPONSE_BYTES, taskResultBytes } from '../../lib/task-reads/bounds.mts';
import { inviteConnector, enrollConnector } from '../../lib/connectors/service.mts';
import { handleConnectorMCP } from '../../lib/connectors/mcp.mts';
const text = '中🙂"\\\n'.repeat(80);
function insert(sqlite, id, kind, body, owner = 'owner-a') {
  sqlite.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').run(id, owner, kind, JSON.stringify(body), 1, 'same', 'same');
}
function snapshot(sqlite) {
  return sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, sqlite.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()]);
}
const oversized = error => error.code === 'RESPONSE_TOO_LARGE' && error.status === 413;
test('byte budget counts UTF-8, JSON escaping, text content and structuredContent together', () => {
  const value = { items: [{ notes: text }], next_cursor: null };
  const result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
  assert.equal(taskResultBytes(value), Buffer.byteLength(JSON.stringify(result), 'utf8'));
  assert.ok(taskResultBytes(value) > Buffer.byteLength(JSON.stringify(value), 'utf8') * 2);
});
test('full MCP response admits exactly 4 MiB and rejects one byte beyond it', async () => {
  const value = { x: 'x'.repeat(MAX_MCP_RESPONSE_BYTES - 8) };
  const response = boundedMCPResponse(value);
  assert.equal((await response.arrayBuffer()).byteLength, MAX_MCP_RESPONSE_BYTES);
  assert.throws(() => boundedMCPResponse({ x: value.x + 'x' }), oversized);
});
for (const kind of ['ticket', 'plan']) test(`${kind} pages stop at bytes and continuation never skips or repeats projected rows`, async t => {
  const { db, sqlite } = fixture(t);
  for (let i = 0; i < 7; i++) insert(sqlite, `${kind}-byte-${i}`, kind, { project: 'A', notes: text });
  insert(sqlite, 'foreign-project', kind, { project: 'B', notes: 'secret project' });
  insert(sqlite, 'foreign-owner', kind, { project: 'A', notes: 'secret owner' }, 'owner-b');
  const before = snapshot(sqlite), input = { filters: {}, limit: 100 }, options = { project: 'A' };
  const full = await listRecords(db, 'owner-a', kind, input, options);
  const context = { owner: 'owner-a', resource: kind === 'ticket' ? 'tickets' : 'plans', filters: { project: 'A' } };
  const row = full.items[0], next_cursor = await encodeCursor({ created: row.created, id: row.id }, context);
  const byteBudget = taskResultBytes({ items: [row], next_cursor });
  let page = await listRecords(db, 'owner-a', kind, input, { ...options, byteBudget });
  assert.equal(page.items.length, 1); assert.ok(page.next_cursor); assert.ok(taskResultBytes(page) <= byteBudget);
  const seen = [...page.items];
  while (page.next_cursor) {
    page = await listRecords(db, 'owner-a', kind, { ...input, limit: 3, cursor: page.next_cursor }, { ...options, byteBudget });
    assert.ok(page.items.length > 0); assert.ok(taskResultBytes(page) <= byteBudget); seen.push(...page.items);
  }
  assert.deepEqual(seen, full.items); assert.equal(new Set(seen.map(item => item.id)).size, 7);
  await assert.rejects(listRecords(db, 'owner-a', kind, { ...input, cursor: next_cursor }, { project: 'B', byteBudget }), { code: 'INVALID_INPUT' });
  await assert.rejects(listRecords(db, 'owner-b', kind, { ...input, cursor: next_cursor }, { project: 'A', byteBudget }), { code: 'INVALID_INPUT' });
  assert.deepEqual(snapshot(sqlite), before);
});
test('oversized single item fails with a bounded typed error instead of an unadvanceable empty page', async t => {
  const { db, sqlite } = fixture(t); insert(sqlite, 'oversized', 'ticket', { project: 'A', notes: text });
  const before = snapshot(sqlite);
  await assert.rejects(listRecords(db, 'owner-a', 'ticket', { filters: {}, limit: 20 }, { project: 'A', byteBudget: 200 }), oversized);
  assert.deepEqual(snapshot(sqlite), before);
});
test('manual Run byte continuation keeps source keys, frozen context and project isolation', async t => {
  const { db, sqlite } = fixture(t);
  for (let i = 0; i < 5; i++) insert(sqlite, `manual-${i}`, 'run', { ticketId: 'ticket-1', notes: text, contract: { notes: text } });
  const input = { filters: { ticket_id: 'ticket-1', source: 'manual' }, limit: 100 };
  const full = await listTicketRuns(db, 'owner-a', input, () => [], { project: '通用' });
  const first = full.items[0], context = { owner: 'owner-a', resource: 'ticket_runs', filters: { ...input.filters, project: '通用' } };
  const cursor = await encodeCursor({ created: first.created, id: first.id, source: 'manual' }, context);
  const byteBudget = taskResultBytes({ items: [first], next_cursor: cursor });
  const before = snapshot(sqlite); let page = await listTicketRuns(db, 'owner-a', input, () => [], { project: '通用', byteBudget }), seen = [...page.items];
  assert.equal(page.items.length, 1);
  while (page.next_cursor) { page = await listTicketRuns(db, 'owner-a', { ...input, cursor: page.next_cursor }, () => [], { project: '通用', byteBudget }); assert.ok(taskResultBytes(page) <= byteBudget); seen.push(...page.items); }
  assert.deepEqual(seen, full.items); assert.deepEqual(snapshot(sqlite), before);
});
test('Plan detail charges parent and duplicated Idea context before paging linked Tickets', async t => {
  const { db, sqlite } = fixture(t);
  insert(sqlite, 'idea', 'idea', { project: 'A', text });
  insert(sqlite, 'plan', 'plan', { project: 'A', ideaId: 'idea', ideaRevision: 1, notes: text });
  for (let i = 0; i < 5; i++) insert(sqlite, `ticket-byte-${i}`, 'ticket', { project: 'A', planId: 'plan', notes: text });
  const full = await getPlan(db, 'owner-a', 'plan', { project: 'A' });
  const { tickets, ...base } = full, row = tickets.items[0];
  const cursor = await encodeCursor({ created: row.created, id: row.id }, { owner: 'owner-a', resource: 'tickets', filters: { plan_id: 'plan', project: 'A' } });
  const byteBudget = taskResultBytes({ ...base, tickets: { items: [row], next_cursor: cursor } });
  const before = snapshot(sqlite);
  const detail = await dispatchTaskReadTool(db, 'owner-a', 'get_plan', { plan_id: 'plan' }, () => [], { project: 'A', byteBudget });
  assert.equal(detail.tickets.items.length, 1); assert.ok(taskResultBytes(detail) <= byteBudget);
  const remaining = await listRecords(db, 'owner-a', 'ticket', { filters: { plan_id: 'plan' }, limit: 100, cursor: detail.tickets.next_cursor }, { project: 'A' });
  assert.deepEqual([...detail.tickets.items, ...remaining.items], tickets.items); assert.deepEqual(detail.idea, full.idea);
  await assert.rejects(dispatchTaskReadTool(db, 'owner-a', 'get_plan', { plan_id: 'plan' }, () => [], { project: 'A', byteBudget: 200 }), oversized);
  assert.deepEqual(snapshot(sqlite), before);
});
test('Ticket detail budgets linked context and nested Run page within the same dual envelope', async t => {
  const { db, sqlite } = fixture(t);
  sqlite.prepare('UPDATE records SET body=? WHERE id=?').run(JSON.stringify({ title: 'Ticket', notes: text }), 'ticket-1');
  for (let i = 0; i < 5; i++) insert(sqlite, `run-${i}`, 'run', { ticketId: 'ticket-1', notes: text, contract: { notes: text } });
  const args = { ticket_id: 'ticket-1' };
  const full = await dispatchTaskReadTool(db, 'owner-a', 'get_ticket', args, () => [], { project: '通用' });
  const { runs, ...base } = full, row = runs.items[0];
  const cursor = await encodeCursor({ created: row.created, id: row.id, source: row.source }, { owner: 'owner-a', resource: 'ticket_runs', filters: { ticket_id: 'ticket-1', project: '通用' } });
  const byteBudget = taskResultBytes({ ...base, runs: { items: [row], next_cursor: cursor } });
  const before = snapshot(sqlite);
  const detail = await dispatchTaskReadTool(db, 'owner-a', 'get_ticket', args, () => [], { project: '通用', byteBudget });
  assert.equal(detail.runs.items.length, 1); assert.ok(taskResultBytes(detail) <= byteBudget); assert.deepEqual(detail.ticket, full.ticket);
  const remaining = await listTicketRuns(db, 'owner-a', { filters: { ticket_id: 'ticket-1' }, limit: 100, cursor: detail.runs.next_cursor }, () => [], { project: '通用' });
  assert.deepEqual([...detail.runs.items, ...remaining.items], runs.items);
  assert.deepEqual(snapshot(sqlite), before);
});
test('caller arguments cannot supply byte budgets or override a trusted project', async t => {
  const { db } = fixture(t);
  await assert.rejects(dispatchTaskReadTool(db, 'owner-a', 'list_tickets', { byteBudget: 99999999 }, () => [], { project: 'A' }), { code: 'INVALID_INPUT' });
  await assert.rejects(dispatchTaskReadTool(db, 'owner-a', 'list_tickets', { project: 'B' }, () => [], { project: 'A' }), { code: 'AUTHORIZATION_DENIED' });
});
test('project connector produces real bounded dual envelopes and preserves cursor project binding', async t => {
  const { db, sqlite } = fixture(t); process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
  await db.prepare('INSERT INTO local_users VALUES(?,?,?,?,?)').bind('owner-a', 'alice', 'Alice', 'synthetic-unused', Date.now()).run();
  const enroll = async project => {
    const invitation = await inviteConnector(db, 'owner-a', { action: 'invite', project, name: 'Byte fixture', capabilities: ['read'] });
    return enrollConnector(db, { code: invitation.code, name: 'Byte fixture', version: '1', workspace: 'Synthetic repository' });
  };
  const a = await enroll('A'), b = await enroll('B');
  for (let i = 0; i < 8; i++) insert(sqlite, `large-${i}`, 'ticket', { project: 'A', notes: '中🙂"\\\n'.repeat(30000) });
  insert(sqlite, 'hidden-b', 'ticket', { project: 'B', notes: 'hidden' });
  const call = async (connector, args) => handleConnectorMCP(db, new Request(process.env.APP_ORIGIN + '/api/connector/mcp', { method: 'POST', headers: { host: '127.0.0.1:5173', authorization: 'Bearer ' + connector.token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: '中🙂', method: 'tools/call', params: { name: 'list_tickets', arguments: args } }) }));
  const response = await call(a, { limit: 100 }), bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength <= MAX_MCP_RESPONSE_BYTES);
  const result = JSON.parse(Buffer.from(bytes).toString()).result;
  assert.equal(result.isError, false); assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(result.structuredContent.items.length > 0 && result.structuredContent.items.length < 8);
  assert.ok(result.structuredContent.next_cursor);
  const cross = await (await call(b, { cursor: result.structuredContent.next_cursor })).json(); assert.equal(cross.result.isError, true);
});
