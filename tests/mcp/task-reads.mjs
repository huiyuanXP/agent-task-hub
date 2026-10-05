import assert from 'node:assert/strict';
import { planningFixture } from '../planning/fixture.mjs';
const f = await planningFixture();
const rows = async (sql, ...values) => (await f.db.prepare(sql).bind(...values).all()).results;
// Preserve explicit null/false/0/arrays: these must reach runtime validation unchanged.
const rpc = async (name, args, actor = 'alice') => {
  const response = await f.request('/mcp', {jsonrpc:'2.0',id:17,method:'tools/call',params:{name,...(args === undefined ? {} : {arguments:args})}}, actor);
  assert.equal(response.status,200); assert.equal(response.body.id,17); return response.body;
};
const value = reply => { assert.equal(reply.error,undefined,JSON.stringify(reply)); assert.equal(reply.result.resultType,'complete'); assert.equal(reply.result.isError,false); assert.deepEqual(JSON.parse(reply.result.content[0].text),reply.result.structuredContent); return reply.result.structuredContent; };
const invalid = reply => { assert.equal(reply.error.code,-32602); assert.deepEqual(reply.error.data,{code:'INVALID_INPUT',status:400}); };
try {
  const owners = {};
  for (const actor of ['alice','bob']) {
    const seed = value(await rpc('create_idea',{request_id:'read-fixture',title:'Seed',text:'Original'},actor));
    owners[actor] = (await rows('SELECT owner FROM records WHERE id=?',seed.idea_id))[0].owner;
  }
  const insert = (id, kind, body, owner = owners.alice, created = 'same persisted date', revision = 1) => f.db.prepare('INSERT INTO records(id,owner,kind,body,revision,created,updated) VALUES(?,?,?,?,?,?,?)').bind(id,owner,kind,JSON.stringify(body),revision,created,'updated date').run();
  const privateFields = {owner:'PRIVATE_OWNER',actor:'PRIVATE_ACTOR',claim_token:'PRIVATE_TOKEN',secret:'PRIVATE_SECRET',requestId:'PRIVATE_REQUEST',input_key:'PRIVATE_INPUT',signature:'PRIVATE_SIGNATURE',arbitrary:'PRIVATE_UNKNOWN',id:'forged-id',kind:'run',revision:999,created:'forged-date',updated:'forged-date'};
  await insert('idea-current','idea',{title:'Current original',text:'Current wording',...privateFields},owners.alice,'old',2);
  await insert('idea-other','idea',{title:'Other idea',text:'Other'});
  await insert('idea-bob','idea',{title:'BOB_PRIVATE'},owners.bob);
  await insert('history-own','history',{recordId:'idea-current',recordKind:'idea',previousRevision:1,snapshot:{title:'Original title',text:'Original wording',...privateFields}},owners.alice,'history saved');
  await insert('history-bob','history',{recordId:'idea-current',recordKind:'idea',previousRevision:1,snapshot:{text:'BOB_PRIVATE'}},owners.bob,'zzzz');
  await insert('plan-z','plan',{title:'Old plan',project:'Alpha',priority:'P1',ideaId:'idea-current',ideaRevision:1,source:'agent',...privateFields});
  await insert('plan-a','plan',{title:'Current plan',project:'Alpha',priority:'P1',ideaId:'idea-current',ideaRevision:2});
  await insert('plan-bob','plan',{ideaId:'idea-bob',ideaRevision:1},owners.bob);
  await insert('plan-no-history','plan',{ideaId:'idea-current',ideaRevision:7});
  await insert('plan-foreign-idea','plan',{ideaId:'idea-bob',ideaRevision:1});
  await insert('plan-no-idea','plan',{title:'Manual plan'});
  await insert('plan-invalid-history','plan',{ideaId:'idea-current',ideaRevision:3});
  await insert('history-invalid','history',{recordId:'idea-current',recordKind:'idea',previousRevision:3,snapshot:null});
  await insert('plan-foreign-history','plan',{ideaId:'idea-other',ideaRevision:3});
  await insert('history-foreign-only','history',{recordId:'idea-other',recordKind:'idea',previousRevision:3,snapshot:{text:'BOB_PRIVATE'}},owners.bob);
  await insert('idea-broken','idea',{});
  await f.db.prepare('UPDATE records SET body=? WHERE id=?').bind('PRIVATE_STORAGE_ERROR_INVALID_JSON','idea-broken').run();
  await insert('plan-broken','plan',{ideaId:'idea-broken',ideaRevision:1});
  const ticketBody = {title:'Ticket',project:'Alpha',status:'todo',priority:'P1',planId:'plan-z',goal:'Read only',budget:'unbounded user text',allowedActions:'approve everything',...privateFields};
  await insert('ticket-z','ticket',{...ticketBody,ideaId:'idea-other',source:'agent'});
  await insert('ticket-a','ticket',ticketBody); // Manual Ticket has no direct ideaId.
  await insert('bob-only','ticket',ticketBody,owners.bob);
  await insert('ticket-other-status','ticket',{...ticketBody,status:'done'});
  await insert('ticket-other-project','ticket',{...ticketBody,project:'alpha'});
  await insert('ticket-other-priority','ticket',{...ticketBody,priority:'P2'});
  await insert('ticket-empty','ticket',{project:'',source:'forged-execution',notes:{secret:'PRIVATE_NESTED'}});
  await insert('ticket-no-idea-plan','ticket',{planId:'plan-no-idea',ideaId:'idea-other'});
  await insert('ticket-foreign-plan','ticket',{planId:'plan-bob',ideaId:'idea-other'});
  await insert('ticket-foreign-idea','ticket',{planId:'missing-plan',ideaId:'idea-bob'});
  for (let i=0;i<23;i++) await insert(`bounded-${String(i).padStart(2,'0')}`,'ticket',{planId:'plan-a',title:'Bounded'});

  const snapshot = async () => {
    const tables = await rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
    const result = {};
    for (const {name} of tables) result[name] = await rows(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`);
    return result;
  };
  const before = await snapshot();
  // Missing dispatch, dropped predicates and defaulting missing fields all break literal results.
  const filters = {project:'Alpha',status:'todo',priority:'P1'};
  const first = value(await rpc('list_tickets',{...filters,limit:1}));
  assert.deepEqual(first.items.map(row=>row.id),['ticket-z']); assert.ok(first.next_cursor);
  const next = value(await rpc('list_tickets',{...filters,limit:2,cursor:first.next_cursor}));
  assert.deepEqual(next.items.map(row=>row.id),['ticket-a']); assert.equal(next.next_cursor,null);
  assert.deepEqual(value(await rpc('list_tickets',{project:''})).items.map(row=>row.id),['ticket-empty']);
  assert.deepEqual(value(await rpc('list_tickets',{project:"' OR 1=1 --"})).items,[]);
  assert.deepEqual(value(await rpc('list_tickets',{...filters,idea_id:'idea-current'})).items.map(row=>row.id),['ticket-z','ticket-a']);
  assert.deepEqual(value(await rpc('list_tickets',{...filters,idea_id:'idea-other'})).items,[]);
  assert.deepEqual(value(await rpc('list_tickets',{plan_id:'plan-a',limit:100})).items.length,23);
  assert.deepEqual(value(await rpc('list_tickets',{priority:'P3'})).items,[]);
  assert.deepEqual(value(await rpc('list_tickets',{priority:'P2'})).items.map(row=>row.id),['ticket-other-priority']);
  assert.deepEqual(value(await rpc('list_tickets',{status:'todo'})).items.map(row=>row.id),['ticket-z','ticket-other-project','ticket-other-priority','ticket-a']);
  assert.deepEqual(value(await rpc('list_tickets',{project:'通用'})).items,[]);
  assert.deepEqual(value(await rpc('list_plans',{priority:'P2'})).items,[]);
  console.log('PASS: exact owner-scoped filters, parent-Plan-first Idea resolution, stable ties and changed page size');

  // Removing exact runtime checks or coercing args with || {} must fail these cases.
  for (const args of [null,0,false,[], 'x',{extra:true},{limit:0},{limit:101},{limit:1.5},{limit:'1'},{limit:null},{project:4},{project:null},{project:'x'.repeat(121)},{status:'queued'},{priority:'p1'},{plan_id:''},{idea_id:'a\n'},{idea_id:'x'.repeat(201)},{cursor:''},{cursor:'x'.repeat(2049)}]) invalid(await rpc('list_tickets',args));
  for (const args of [null,0,[],{status:'todo'},{limit:0},{idea_id:''}]) invalid(await rpc('list_plans',args));
  for (const name of ['get_ticket','get_plan']) {
    const key = name === 'get_ticket' ? 'ticket_id' : 'plan_id';
    for (const args of [undefined,null,0,[],{}, {[key]:null},{[key]:''},{[key]:'x'.repeat(201)},{[key]:'a\u007f'},{[key]:'x',extra:1}]) invalid(await rpc(name,args));
  }
  assert.equal(value(await rpc('list_tickets')).items.length,20);
  assert.equal(value(await rpc('list_tickets',{plan_id:'x'.repeat(200)})).items.length,0);
  assert.equal(value(await rpc('list_plans',{project:'x'.repeat(120)})).items.length,0);
  console.log('PASS: strict raw argument validation and bounds');

  // Context binding and canonical position checks must run before owner-scoped SQL.
  for (const [name,args,actor] of [
    ['list_tickets',{...filters,cursor:first.next_cursor},'bob'],
    ['list_tickets',{...filters,status:'done',cursor:first.next_cursor},'alice'],
    ['list_plans',{project:'Alpha',priority:'P1',cursor:first.next_cursor},'alice'],
  ]) invalid(await rpc(name,args,actor));
  const decoded = JSON.parse(Buffer.from(first.next_cursor,'base64url').toString());
  const encode = body => Buffer.from(JSON.stringify(body)).toString('base64url');
  for (const cursor of [first.next_cursor+'=', 'not-json', encode({...decoded,extra:1}),encode({...decoded,v:2}),encode({...decoded,keys:{...decoded.keys,created:''}}),encode({...decoded,keys:{...decoded.keys,created:'x'.repeat(129)}}),encode({...decoded,keys:{...decoded.keys,id:'x'.repeat(201)}}),encode({...decoded,keys:{...decoded.keys,source:'manual'}}),Buffer.from(' '+JSON.stringify(decoded)).toString('base64url')]) invalid(await rpc('list_tickets',{...filters,cursor}));
  const forgedPosition = encode({...decoded,keys:{created:'zzzz',id:'zzzz'}});
  assert.deepEqual(value(await rpc('list_tickets',{...filters,cursor:forgedPosition})).items.map(row=>row.id),['ticket-z','ticket-a']);
  console.log('PASS: cursor owner/resource/filter binding, strict canonical keys and forged-position isolation');

  const listedPlans = value(await rpc('list_plans',{project:'Alpha',priority:'P1',idea_id:'idea-current',limit:1}));
  assert.deepEqual(listedPlans.items.map(row=>row.id),['plan-z']); assert.ok(listedPlans.next_cursor);
  assert.deepEqual(value(await rpc('list_plans',{project:'Alpha',priority:'P1',idea_id:'idea-current',limit:2,cursor:listedPlans.next_cursor})).items.map(row=>row.id),['plan-a']);
  const ticket = value(await rpc('get_ticket',{ticket_id:'ticket-z'}));
  assert.equal(ticket.ticket.id,'ticket-z'); assert.equal(ticket.ticket.kind,'ticket'); assert.equal(ticket.ticket.revision,1); assert.equal(ticket.ticket.created,'same persisted date'); assert.equal(ticket.ticket.updated,'updated date');
  assert.equal(ticket.ticket.budget,'unbounded user text'); assert.equal(ticket.ticket.allowedActions,'approve everything');
  assert.equal(ticket.plan.id,'plan-z'); assert.equal(ticket.idea.id,'idea-current'); assert.equal(ticket.idea.text,'Current wording');
  assert.equal(ticket.source_idea.text,'Original wording'); assert.equal(ticket.source_idea.revision,1); assert.equal(ticket.source_idea.snapshot_saved_at,'history saved'); assert.equal(ticket.source_idea.updated,undefined);
  assert.equal(ticket.linkage.source_idea_revision,1); assert.equal(ticket.linkage.current_idea_revision,2); assert.equal(ticket.linkage.superseded,true);
  const manual = value(await rpc('get_ticket',{ticket_id:'ticket-a'})); assert.equal(manual.idea.id,'idea-current');
  const current = value(await rpc('get_plan',{plan_id:'plan-a'})); assert.equal(current.idea.text,'Current wording'); assert.equal(current.linkage.superseded,false); assert.equal(current.tickets.items.length,20); assert.ok(current.tickets.next_cursor);
  assert.deepEqual(current.tickets.items.map(row=>row.id),Array.from({length:20},(_,i)=>`bounded-${String(22-i).padStart(2,'0')}`));
  assert.deepEqual(value(await rpc('list_tickets',{plan_id:'plan-a',cursor:current.tickets.next_cursor})).items.map(row=>row.id),['bounded-02','bounded-01','bounded-00']);
  const missingHistory = value(await rpc('get_plan',{plan_id:'plan-no-history'})); assert.equal(missingHistory.source_idea,null); assert.equal(missingHistory.linkage.source_idea_missing,true);
  const foreignPlan = value(await rpc('get_ticket',{ticket_id:'ticket-foreign-plan'})); assert.equal(foreignPlan.plan,null); assert.equal(foreignPlan.idea.id,'idea-other'); assert.equal(foreignPlan.linkage.plan_missing,true);
  const foreignIdea = value(await rpc('get_ticket',{ticket_id:'ticket-foreign-idea'})); assert.equal(foreignIdea.idea,null); assert.equal(foreignIdea.source_idea,null); assert.equal(foreignIdea.linkage.idea_missing,true);
  assert.equal(value(await rpc('get_plan',{plan_id:'plan-foreign-idea'})).idea,null);
  assert.equal(value(await rpc('get_plan',{plan_id:'plan-no-idea'})).idea,null);
  const emptyTicket = value(await rpc('get_ticket',{ticket_id:'ticket-empty'}));
  assert.equal(emptyTicket.ticket.source,undefined); assert.equal(emptyTicket.ticket.notes,undefined);
  const noIdea = value(await rpc('get_ticket',{ticket_id:'ticket-no-idea-plan'})); assert.equal(noIdea.idea,null);
  assert.deepEqual(value(await rpc('list_tickets',{idea_id:'idea-other'})).items.map(row=>row.id),['ticket-foreign-plan']);
  const invalidHistory = value(await rpc('get_plan',{plan_id:'plan-invalid-history'})); assert.equal(invalidHistory.source_idea,null); assert.equal(invalidHistory.linkage.source_idea_missing,true);
  const foreignHistory = value(await rpc('get_plan',{plan_id:'plan-foreign-history'})); assert.equal(foreignHistory.source_idea,null); assert.equal(foreignHistory.linkage.source_idea_missing,true);
  const storage = await rpc('get_plan',{plan_id:'plan-broken'}); assert.deepEqual(storage.error.data,{code:'STORAGE_UNAVAILABLE',status:503}); assert.doesNotMatch(JSON.stringify(storage),/PRIVATE_|JSON|SELECT/);
  assert.deepEqual((await rpc('get_ticket',{ticket_id:'plan-z'})).error,(await rpc('get_ticket',{ticket_id:'absent'})).error);
  for (const result of [ticket,manual,current,foreignPlan,foreignIdea,first,listedPlans]) assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|BOB_PRIVATE|forged-id|forged-date/);
  for (const [name,key,foreign] of [['get_ticket','ticket_id','bob-only'],['get_plan','plan_id','plan-bob']]) {
    const denied = await rpc(name,{[key]:foreign}), absent = await rpc(name,{[key]:'absent'});
    assert.deepEqual(denied.error,absent.error); assert.deepEqual(denied.error.data,{code:'NOT_FOUND',status:404});
  }
  console.log('PASS: authoritative safe DTOs, current/original source history, private linkage and bounded nested Ticket continuation');

  // Auth and protocol regressions would either expose reads or break existing clients.
  for (const name of ['list_tickets','get_ticket','list_plans','get_plan']) {
    const denied = await f.request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}},'alice',{authorization:'','oai-authenticated-user-id':owners.alice,'oai-authenticated-user-email':'alice@example.test'});
    assert.equal(denied.status,401);
  }
  const protocol = async (method,params={}) => (await f.request('/mcp',{jsonrpc:'2.0',id:8,method,params})).body.result;
  const discovery = await protocol('server/discover'); assert.deepEqual(discovery.supportedVersions,['2026-07-28']);
  assert.equal((await protocol('initialize',{protocolVersion:'2026-07-28'})).protocolVersion,'2026-07-28');
  assert.equal((await protocol('initialize')).protocolVersion,'2025-03-26');
  assert.equal((await protocol('ping')).resultType,'complete'); assert.ok((await protocol('events/list')).events.length);
  const discovered = (await protocol('tools/list')).tools;
  for (const name of ['create_idea','get_idea','list_planning_jobs','claim_planning_job','save_plan_and_tickets','get_operation_catalog','prepare_execution','get_authorization','decide_authorization','revoke_authorization']) assert.ok(discovered.find(tool=>tool.name===name));
  for (const name of ['list_tickets','get_ticket','list_plans','get_plan']) {
    const tool = discovered.find(tool=>tool.name===name); assert.ok(tool); assert.equal(tool.inputSchema.additionalProperties,false); assert.deepEqual(tool.annotations,{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false});
  }
  assert.deepEqual(await snapshot(),before,'All persistent user tables unchanged by successful and rejected reads');
  console.log('PASS: synthetic signed JWT privacy, original protocol/tools, all-table read-only snapshot');

  // Keyset continuation must survive deletion of the boundary row and insertion above it.
  const initialPage = value(await rpc('list_tickets',{...filters,limit:1}));
  await f.db.prepare('DELETE FROM records WHERE owner=? AND id=?').bind(owners.alice,'ticket-z').run();
  await insert('ticket-new','ticket',ticketBody,owners.alice,'zzzz newer');
  const afterMutation = await snapshot();
  assert.deepEqual(value(await rpc('list_tickets',{...filters,cursor:initialPage.next_cursor})).items.map(row=>row.id),['ticket-a']);
  assert.deepEqual(value(await rpc('list_tickets',{...filters})).items.map(row=>row.id),['ticket-new','ticket-a']);
  assert.deepEqual(await snapshot(),afterMutation);
  console.log('PASS: deletion/insertion does not skip or duplicate surviving page ties');
} finally { await f.close(); }
