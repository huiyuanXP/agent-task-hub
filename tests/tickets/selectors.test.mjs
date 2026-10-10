import test from 'node:test';
import assert from 'node:assert/strict';
import {sortTickets,filterTickets,resolveTicketAction,ticketExecutionContext} from '../../lib/tickets/selectors.mts';
const row=(id,extra={})=>({id,kind:'ticket',revision:2,title:id,project:'test',status:'todo',created:'2026-01-01T00:00:00Z',updated:'2026-01-01T00:00:00Z',...extra});
test('priority directions keep unknown values last and use created descending then ID',()=>{
 const rows=[row('unknown',{priority:'P9'}),row('p3',{priority:'P3'}),row('b',{priority:'P1'}),row('a',{priority:'P1'}),row('new',{priority:'P1',created:'2026-01-02'}),row('bad',{priority:'P1',created:'invalid'}),row('p0',{priority:'P0'}),row('p2',{priority:'P2'})];
 assert.deepEqual(sortTickets(rows,{field:'priority',direction:'asc'}).map(r=>r.id),['p0','new','a','b','bad','p2','p3','unknown']);
 assert.deepEqual(sortTickets(rows,{field:'priority',direction:'desc'}).map(r=>r.id),['p3','p2','new','a','b','bad','p0','unknown']);
 assert.equal(rows[0].id,'unknown');
});
test('persisted time directions put invalid times last, equal time only uses ID, default created desc',()=>{
 const rows=[row('b',{priority:'P0'}),row('a',{priority:'P3'}),row('new',{created:'2026-01-02',updated:'2026-01-02'}),row('invalid',{created:'broken',updated:''})];
 for(const field of ['created','updated']) {
  assert.deepEqual(sortTickets(rows,{field,direction:'asc'}).map(r=>r.id),['a','b','new','invalid']);
  assert.deepEqual(sortTickets(rows,{field,direction:'desc'}).map(r=>r.id),['new','a','b','invalid']);
 }
 assert.deepEqual(sortTickets(rows).map(r=>r.id),['new','a','b','invalid']);
 assert.deepEqual(filterTickets([...rows,row('other',{project:'other'}),row('idea',{kind:'idea'})],{project:'test',query:'a'}).map(r=>r.id),['a','invalid']);
});
const workspace=(id,revision,state,extra={})=>({id,ticketId:'ticket',revision,project:'test',state,...extra});
const docker=(id,revision,state)=>({id,ticketId:'ticket',ticketRevision:revision,ticketBody:'{"project":"test"}',state});
test('actions use exact revision review; old active Run blocks replacement; done never reopens',()=>{
 const ticket=row('ticket');
 assert.deepEqual(resolveTicketAction(ticket,'running'),{type:'open-execution',ticketId:'ticket',revision:2});
 assert.equal(resolveTicketAction(ticket,'todo').type,'no-op');
 assert.equal(resolveTicketAction(ticket,null).type,'no-op');
 assert.equal(resolveTicketAction(ticket,'unknown').type,'no-op');
 assert.deepEqual(resolveTicketAction(ticket,'waiting'),{type:'open-status',status:'waiting'});
 assert.equal(resolveTicketAction(ticket,'done',[workspace('old',1,'review')]).type,'open-active');
 assert.equal(resolveTicketAction(ticket,'done',[workspace('other',2,'review',{project:'other'})]).type,'open-active');
 assert.deepEqual(resolveTicketAction(ticket,'done',[workspace('current',2,'review')]),{type:'open-review',runId:'current'});
 assert.equal(resolveTicketAction(ticket,'done',[],[docker('d',2,'succeeded')]).type,'completed-info');
 for(const target of ['todo','running','waiting','error'])assert.equal(resolveTicketAction(row('ticket',{status:'done'}),target,[workspace('current',2,'review')]).type,'completed-info');
 const context=ticketExecutionContext(ticket,[workspace('old',1,'running'),workspace('recent',2,'failed')],[docker('old-d',1,'queued')]);
 assert.equal(context.currentWorkspace.length,1);assert.equal(context.historicalWorkspace.length,1);
 assert.equal(context.activeWorkspace.id,'old');assert.equal(context.activeDocker.id,'old-d');
});
