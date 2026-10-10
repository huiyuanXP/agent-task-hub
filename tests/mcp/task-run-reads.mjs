import assert from 'node:assert/strict';
import { snapshotTables } from '../local/snapshot.mjs';
import { planningFixture } from '../planning/fixture.mjs';
import { prepareExecution, decideAuthorization, revokeAuthorization } from '../../lib/execution/authorization.mts';
import { getOperationCatalog, REGISTERED_OPERATIONS } from '../../lib/execution/catalog.mts';
import { transitionRun } from '../../lib/execution/runs.mts';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';
import { ingestAttestation } from '../../lib/execution/attestations.mts';
import { sha256, receiptSigningPayload } from '../../lib/execution/evidence.mts';
import { canonical, signClaims } from '../../lib/execution/transport.mts';
const budget = { timeoutMs:30000, memoryMb:256, cpus:1, pids:64 };
const privateFields = { owner:'PRIVATE_OWNER',actor:'PRIVATE_ACTOR',signature:'PRIVATE_SIGNATURE',secret:'PRIVATE_SECRET',requestId:'PRIVATE_REQUEST',input_key:'PRIVATE_INPUT',token:'PRIVATE_TOKEN',arbitrary:{secret:'PRIVATE_NESTED'} };
const value = reply => { assert.equal(reply.error,undefined,JSON.stringify(reply)); assert.equal(reply.result.resultType,'complete'); assert.equal(reply.result.isError,false); assert.deepEqual(JSON.parse(reply.result.content[0].text),reply.result.structuredContent); return reply.result.structuredContent; };
const invalid = reply => { assert.equal(reply.error.code,-32602); assert.deepEqual(reply.error.data,{code:'INVALID_INPUT',status:400}); };
async function setup(options) {
  const f = await planningFixture(options);
  const rows = async (sql,...params) => (await f.db.prepare(sql).bind(...params).all()).results;
  const rpc = async (name,args,actor='alice') => {
    const r = await f.request('/mcp',{jsonrpc:'2.0',id:73,method:'tools/call',params:{name,...(args===undefined?{}:{arguments:args})}},actor);
    assert.equal(r.status,200); assert.equal(r.body.id,73); return r.body;
  };
  const owners = {};
  for (const actor of ['alice','bob']) { const seed=value(await rpc('create_idea',{request_id:'run-read-seed',title:'Seed',text:'Synthetic'},actor)); owners[actor]=(await rows('SELECT owner FROM records WHERE id=?',seed.idea_id))[0].owner; }
  const insert = (id,kind,body,owner=owners.alice,created='same persisted date') => f.db.prepare('INSERT INTO records(id,owner,kind,body,revision,created,updated) VALUES(?,?,?,?,1,?,?)').bind(id,owner,kind,JSON.stringify(body),created,'updated date').run();
  const snapshot=async()=>snapshotTables(f.file);
  const context = (actor='alice',extra={}) => ({owner:owners[actor],actor:owners[actor],grantAuthority:'owner',...extra});
  const prepared = async (id,extra={}) => {
    const ctx=context('alice',extra), now=ctx.now??Date.now();
    const catalog=await getOperationCatalog(f.db,ctx,{ticketId:id,expectedRevision:1});
    return prepareExecution(f.db,ctx,{ticketId:id,expectedRevision:1,requestId:id,attempt:1,scope:catalog.operations.map(({operationId,definitionHash})=>({operationId,definitionHash})),budget,expiresAt:now+3600000});
  };
  const rawRun = (id,ticketId,owner=owners.alice,extra={}) => {
    const row={id,owner,actor:'PRIVATE_ACTOR',ticket_id:ticketId,ticket_revision:1,ticket_body:JSON.stringify({title:'Frozen real',...privateFields}),request_id:id,authorization_id:'absent',attempt:1,input_key:'PRIVATE_INPUT',state:'failed',last_actor:'PRIVATE_ACTOR',created:'same persisted date',updated:'updated date',...extra};
    return f.db.prepare(`INSERT INTO execution_runs(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)).run();
  };
  return {...f,rows,rpc,owners,insert,snapshot,context,prepared,rawRun};
}
const f=await setup();
try {
  await f.insert('ticket','ticket',{title:'Original',...privateFields}); await f.insert('foreign','ticket',{title:'BOB_PRIVATE'},f.owners.bob);
  await f.insert('same-id','run',{ticketId:'ticket',ticketRevision:1,status:'done',evidence:'User reported success',source:'execution',contract:{title:'Frozen manual',budget:'unlimited user prose',...privateFields},...privateFields});
  await f.rawRun('same-id','ticket'); await f.rawRun('foreign-run','ticket',f.owners.bob);
  await f.insert('foreign-manual','run',{ticketId:'ticket',notes:'BOB_PRIVATE'},f.owners.bob);
  await f.rawRun('owned-cross-link','foreign');
  for(let i=0;i<22;i++) await f.insert(`manual-${String(i).padStart(2,'0')}`,'run',{ticketId:'ticket',status:'done'});
  await f.insert('{"x":1}','ticket',{}); await f.insert('typed-good','run',{ticketId:'{"x":1}'}); await f.insert('typed-bad','run',{ticketId:{x:1}});
  await f.insert('7','ticket',{}); await f.insert('numeric-bad','run',{ticketId:7});
  // RED: the actual native server currently has no fifth tool or Run page.
  const before=await f.snapshot();
  const first=value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',limit:1}));
  assert.deepEqual(first.items.map(r=>[r.id,r.source,r.state]),[['same-id','manual','snapshot']]); assert.ok(first.next_cursor);
  const second=value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',limit:2,cursor:first.next_cursor}));
  assert.deepEqual(second.items.map(r=>[r.id,r.source]),[['same-id','execution'],['manual-21','manual']]);
  let all=[...first.items,...second.items],cursor=second.next_cursor;
  while(cursor) {const page=value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',limit:3,cursor})); all.push(...page.items);cursor=page.next_cursor;}
  assert.equal(all.length,24); assert.equal(new Set(all.map(r=>r.id+':'+r.source)).size,24);
  assert.deepEqual(value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',source:'execution'})).items.map(r=>r.id),['same-id']);
  assert.equal(value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',source:'manual',state:'succeeded'})).items.length,0);
  assert.equal(value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',state:'snapshot'})).items.length,20);
  assert.equal(value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',state:'failed'})).items[0].id,'same-id');
  assert.deepEqual(value(await f.rpc('list_ticket_runs',{ticket_id:'{"x":1}'})).items.map(r=>r.id),['typed-good']);
  assert.deepEqual(value(await f.rpc('list_ticket_runs',{ticket_id:'7'})).items,[]);
  const detail=value(await f.rpc('get_ticket',{ticket_id:'ticket'})); assert.equal(detail.runs.items.length,20); assert.ok(detail.runs.next_cursor);
  assert.equal(value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',cursor:detail.runs.next_cursor})).items.length,4);
  assert.equal(first.items[0].contract.title,'Frozen manual'); assert.equal(first.items[0].status,'done'); assert.equal(first.items[0].evidence,'User reported success'); assert.equal(first.items[0].authorization,null);
  assert.equal(second.items[0].contract.title,'Frozen real'); assert.equal(second.items[0].authorization,null);
  assert.doesNotMatch(JSON.stringify(all),/PRIVATE_|BOB_PRIVATE/);
  assert.deepEqual((await f.rpc('list_ticket_runs',{ticket_id:'foreign'})).error,(await f.rpc('list_ticket_runs',{ticket_id:'absent'})).error);
  assert.deepEqual((await f.rpc('list_ticket_runs',{ticket_id:'foreign'})).error.data,{code:'NOT_FOUND',status:404});
  for(const args of [undefined,null,false,0,[],{}, {ticket_id:'ticket',extra:1},{ticket_id:''},{ticket_id:'x'.repeat(201)},{ticket_id:'a\n'}, {ticket_id:'ticket',source:'Execution'},{ticket_id:'ticket',state:'done'},{ticket_id:'ticket',limit:0},{ticket_id:'ticket',limit:101},{ticket_id:'ticket',limit:1.5},{ticket_id:'ticket',cursor:'x'.repeat(2049)}]) invalid(await f.rpc('list_ticket_runs',args));
  for(const args of [{ticket_id:'7',cursor:first.next_cursor},{ticket_id:'ticket',source:'manual',cursor:first.next_cursor},{ticket_id:'ticket',state:'failed',cursor:first.next_cursor}]) invalid(await f.rpc('list_ticket_runs',args));
  const decoded=JSON.parse(Buffer.from(first.next_cursor,'base64url')); const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  for(const keys of [{created:'same persisted date',id:'same-id'},{...decoded.keys,source:'other'},{...decoded.keys,extra:1}]) invalid(await f.rpc('list_ticket_runs',{ticket_id:'ticket',cursor:encode({...decoded,keys})}));
  invalid(await f.rpc('list_tickets',{cursor:first.next_cursor}));
  invalid(await f.rpc('list_ticket_runs',{ticket_id:'foreign',cursor:first.next_cursor},'bob'));
  assert.equal(value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',cursor:encode({...decoded,keys:{created:'zzzz',id:'zzzz',source:'manual'}})})).items.length,20);
  const denied=await f.request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_ticket_runs',arguments:{ticket_id:'ticket'}}},'alice',{authorization:'','oai-authenticated-user-id':f.owners.alice}); assert.equal(denied.status,401);
  const tools=(await f.request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'})).body.result.tools;
  const tool=tools.find(t=>t.name==='list_ticket_runs'); assert.deepEqual(tool.annotations,{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:false}); assert.deepEqual(tool.inputSchema.required,['ticket_id']);assert.equal(tool.inputSchema.additionalProperties,false);
  assert.deepEqual(await f.snapshot(),before);
  const boundary=first.next_cursor;
  await f.db.prepare('DELETE FROM records WHERE id=? AND owner=?').bind('same-id',f.owners.alice).run();
  await f.insert('new-manual','run',{ticketId:'ticket'},f.owners.alice,'zzzz newer');
  const afterMutation=await f.snapshot();
  assert.deepEqual(value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',cursor:boundary,limit:1})).items.map(r=>[r.id,r.source]),[['same-id','execution']]);
  assert.equal(value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',limit:1})).items[0].id,'new-manual');
  assert.deepEqual(await f.snapshot(),afterMutation);
  console.log('PASS: merged same-ID/source keysets, strict filters/types/cursors, root privacy, bounded detail and readonly all-table snapshot');

  // Model-only preparations and signed receipt ingestion never dispatch or start a process.
  const cases={};
  for(const name of ['pending','approved','expired','revoked','rejected','stale_revision','stale_definition','v1','v2','failed','cancelled']) {
    await f.insert(name,'ticket',{title:'Frozen '+name,...privateFields});
    const extra=name==='expired'?{now:Date.now()-7200000}:name==='stale_definition'?{registry:[{...REGISTERED_OPERATIONS[0],image:'node@sha256:'+'b'.repeat(64)}]}:{};
    cases[name]=await f.prepared(name,extra);
    if(name!=='pending') await decideAuthorization(f.db,f.context('alice',extra),{authorizationId:cases[name].authorization.id,decisionId:'approve-'+name,outcome:name==='rejected'?'rejected':'approved'});
    if(name==='revoked') await revokeAuthorization(f.db,f.context(),{authorizationId:cases[name].authorization.id,decisionId:'revoke'});
  }
  await f.db.prepare('UPDATE records SET revision=2,body=? WHERE id=?').bind(JSON.stringify({title:'Current edited'}),'stale_revision').run();
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
  const trust={keyId:'test-evidence',key:pair.publicKey};
  const r1=cases.v1.run;
  const claims={version:1,keyId:trust.keyId,owner:r1.owner,runId:r1.id,ticketId:r1.ticketId,ticketRevision:1,attempt:1,authorizationId:r1.authorizationId,contractSha256:await sha256(r1.ticketBody),status:'succeeded',backendId:'synthetic-model-only',exitCode:0,artifacts:[{path:'output/result.json',sha256:await sha256('{}'),bytes:2}],stdoutSha256:await sha256(''),stderrSha256:await sha256(''),startedAt:r1.created,endedAt:new Date().toISOString()};
  const signature=Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,receiptSigningPayload(claims))).toString('hex');
  await transitionRun(f.db,f.context(),{id:r1.id,expectedVersion:1,to:'running'});
  await transitionRun(f.db,{...f.context(),evidenceTrust:trust},{id:r1.id,expectedVersion:2,to:'succeeded',evidence:{claims,signature}});
  for(const name of ['v2','failed','cancelled']) {
    const run=cases[name].run,permit=await createDispatchPermit(f.db,f.context(),run.id);
    if(name==='cancelled') await transitionRun(f.db,f.context(),{id:run.id,expectedVersion:1,to:'cancelled'});
    for(const purpose of ['result',...(name==='cancelled'?['cancel_fence','stop']:[])]) {
      const c={version:2,purpose,audience:'control-plane',keyId:trust.keyId,owner:run.owner,runId:run.id,ticketId:run.ticketId,ticketRevision:1,attempt:1,authorizationId:run.authorizationId,contractSha256:await sha256(run.ticketBody),permitId:permit.permitId,permitSha256:await sha256(canonical(permit)),operationId:permit.operation.operationId,definitionHash:permit.operation.definitionHash,deadlineMs:permit.deadlineMs,backendId:'ath-'+(await sha256(JSON.stringify([run.owner,run.id,1]))).slice(0,40),status:purpose==='stop'?'stopped':purpose==='cancel_fence'?'cancelled':name==='v2'?'succeeded':'startup_failed',process:name==='v2'?{containerId:'c'.repeat(64),execId:'e'.repeat(64)}:null,exitCode:name==='v2'?0:null,startedAt:name==='v2'?permit.issuedAt:null,endedAt:name==='v2'?permit.issuedAt:null,capturedAt:name==='v2'?permit.issuedAt:null,observedAt:Date.now(),artifacts:name==='v2'?[{path:'output/result.json',sha256:await sha256('{}'),bytes:2}]:[],stdout:name==='v2'?{sha256:await sha256(''),bytes:0,truncated:false}:null,stderr:name==='v2'?{sha256:await sha256(''),bytes:0,truncated:false}:null,closure:purpose==='stop'?'never_admitted':null};
      await ingestAttestation(f.db,{...f.context(),evidenceTrust:trust},await signClaims({keyId:trust.keyId,privateKey:pair.privateKey},c));
    }
  }
  await f.rawRun('mismatch-grant','ticket',f.owners.alice,{authorization_id:cases.approved.authorization.id});
  await f.rawRun('foreign-grant','ticket',f.owners.bob,{authorization_id:cases.approved.authorization.id});
  await f.rawRun('bob-owned','foreign',f.owners.bob,{authorization_id:cases.approved.authorization.id});
  // Synthetic corrupt links must not make a permit or receipt from another owner/Ticket visible.
  for(const [id,pOwner,pTicket,aOwner] of [['wrong-owner',f.owners.bob,'ticket',f.owners.alice],['wrong-ticket',f.owners.alice,'foreign',f.owners.alice],['wrong-receipt-owner',f.owners.alice,'ticket',f.owners.bob]]) {
    await f.rawRun(id,'ticket');
    await f.db.prepare('INSERT INTO execution_permits(id,owner,run_id,ticket_id,authorization_id,envelope,envelope_hash,created_at,deadline_ms,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,pOwner,id,pTicket,'absent','{}','PRIVATE_HASH',1,2,3).run();
    const claims={version:2,purpose:'result',owner:f.owners.alice,runId:id,ticketId:'ticket',ticketRevision:1,attempt:1,authorizationId:'absent',contractSha256:await sha256(JSON.stringify({title:'Frozen real',...privateFields})),status:'startup_failed',artifacts:[],secret:'PRIVATE_SECRET'};
    await f.db.prepare('INSERT INTO backend_attestations(id,permit_id,owner,purpose,receipt,received_at) VALUES(?,?,?,?,?,?)').bind(id,id,aOwner,'result',JSON.stringify({claims,signature:'PRIVATE_SIGNATURE'}),1).run();
  }
  // An expired persisted grant may contain extra fields; projection must allowlist nested values too.
  await f.insert('dirty-grant','ticket',{});
  await f.rawRun('dirty-run','dirty-grant',f.owners.alice,{state:'queued',authorization_id:'dirty-auth'});
  await f.db.prepare(`INSERT INTO execution_authorizations(id,owner,actor,run_id,ticket_id,ticket_revision,scope,budget,operations,expires_at,request_id,input_key,created_at,updated_at,last_decision_id,last_actor,decision_key)
    VALUES(?,?,?,?,?,1,?,?,?,?,?,?,1,1,?,?,?)`).bind('dirty-auth',f.owners.alice,'PRIVATE_ACTOR','dirty-run','dirty-grant',JSON.stringify([{operationId:{secret:'PRIVATE_SCOPE'},definitionHash:'a'.repeat(64),secret:'PRIVATE_SCOPE_EXTRA'}]),JSON.stringify({...budget,timeoutMs:{secret:'PRIVATE_BUDGET'},secret:'PRIVATE_BUDGET_EXTRA'}),'[{}]',2,'dirty-run','PRIVATE_INPUT','dirty-decision','PRIVATE_ACTOR','PRIVATE_DECISION').run();
  // SQLite affinity permits TEXT/REAL and nonpositive expiry values with a lower created_at.
  // Use valid bound grants so only expiry projection distinguishes these corrupt rows.
  const malformedExpiries = ['PRIVATE_MALFORMED_EXPIRY', 1.5, Number.MAX_SAFE_INTEGER + 1, 0, -1];
  for (const [i, expiresAt] of malformedExpiries.entries()) {
    const ticketId = `expiry-ticket-${i}`, runId = `expiry-run-${i}`, authorizationId = `expiry-auth-${i}`;
    await f.insert(ticketId, 'ticket', {});
    await f.rawRun(runId, ticketId, f.owners.alice, { state: 'queued', authorization_id: authorizationId });
    const catalog = await getOperationCatalog(f.db, f.context(), { ticketId, expectedRevision: 1 });
    const scope = catalog.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash }));
    await f.db.prepare(`INSERT INTO execution_authorizations(id,owner,actor,run_id,ticket_id,ticket_revision,scope,budget,operations,expires_at,request_id,input_key,created_at,updated_at,last_decision_id,last_actor,decision_key)
      VALUES(?,?,?,?,?,1,?,?,?,?,?,?,-2,-2,?,?,?)`).bind(authorizationId, f.owners.alice, 'PRIVATE_ACTOR', runId, ticketId,
      JSON.stringify(scope), JSON.stringify(budget), JSON.stringify(catalog.operations), expiresAt, runId, 'PRIVATE_INPUT',
      `expiry-decision-${i}`, 'PRIVATE_ACTOR', 'PRIVATE_DECISION').run();
  }
  const beforeAuth=await f.snapshot();
  for(const name of ['pending','approved','expired','revoked','rejected','stale_revision','stale_definition']) {
    const run=value(await f.rpc('list_ticket_runs',{ticket_id:name})).items[0];
    assert.equal(run.authorization.effective_status,name); assert.equal(run.authorization.id,cases[name].authorization.id);
    assert.equal(run.authorization.expires_at,cases[name].authorization.expiresAt);
    assert.deepEqual(Object.keys(run.authorization).sort(),['budget','effective_status','expires_at','id','run_id','scope','status','ticket_id','ticket_revision']);
    assert.deepEqual(run.authorization.budget,budget); assert.equal(run.contract.title,'Frozen '+name); assert.equal(run.ticket_revision,1);
    assert.doesNotMatch(JSON.stringify(run),/PRIVATE_|argv|inputs|decisions|input_key/);
  }
  const changedDetail=value(await f.rpc('get_ticket',{ticket_id:'stale_revision'}));
  assert.equal(changedDetail.ticket.title,'Current edited');assert.equal(changedDetail.runs.items[0].contract.title,'Frozen stale_revision');assert.equal(changedDetail.runs.items[0].authorization.effective_status,'stale_revision');
  for(const name of ['v1','v2']) {
    const run=value(await f.rpc('list_ticket_runs',{ticket_id:name})).items[0]; assert.equal(run.state,'succeeded'); assert.equal(run.version,3);assert.equal(run.attempt,1);assert.equal(run.evidence.version,name==='v1'?1:2);assert.equal(run.evidence.status,'succeeded');assert.equal(run.evidence.artifacts[0].path,'output/result.json');
    assert.doesNotMatch(JSON.stringify(run),/signature|keyId|permitId|permitSha256|process|containerId|execId|PRIVATE_/);
  }
  const failed=value(await f.rpc('list_ticket_runs',{ticket_id:'failed'})).items[0];assert.equal(failed.state,'failed');assert.equal(failed.evidence,null);assert.equal(failed.attestations[0].status,'startup_failed');
  const cancelled=value(await f.rpc('list_ticket_runs',{ticket_id:'cancelled'})).items[0];assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.evidence,null);assert.deepEqual(cancelled.attestations.map(a=>a.purpose).sort(),['cancel_fence','result','stop']);assert.equal(cancelled.attestations.find(a=>a.purpose==='stop').closure,'never_admitted');
  assert.doesNotMatch(JSON.stringify([failed,cancelled]),/signature|permit|process|PRIVATE_/);
  assert.equal(value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',source:'execution'})).items.find(r=>r.id==='mismatch-grant').authorization,null);
  const bobRuns=value(await f.rpc('list_ticket_runs',{ticket_id:'foreign'},'bob')).items;
  assert.deepEqual(bobRuns.map(r=>r.id),['bob-owned']);assert.equal(bobRuns[0].authorization,null);
  const linked=value(await f.rpc('list_ticket_runs',{ticket_id:'ticket',source:'execution'})).items;
  for(const id of ['wrong-owner','wrong-ticket','wrong-receipt-owner']) assert.deepEqual(linked.find(r=>r.id===id).attestations,[]);
  const dirty=await f.rpc('list_ticket_runs',{ticket_id:'dirty-grant'});
  assert.deepEqual(dirty.error?.data,{code:'STORAGE_UNAVAILABLE',status:503});assert.doesNotMatch(JSON.stringify(dirty),/PRIVATE_/);
  const expiryResponses = [];
  for (const [i] of malformedExpiries.entries()) {
    for (const name of ['list_ticket_runs', 'get_ticket']) {
      const reply = await f.rpc(name, { ticket_id: `expiry-ticket-${i}` });
      expiryResponses.push({ name, i, error: reply.error, leaksMarker: /PRIVATE_MALFORMED_EXPIRY/.test(JSON.stringify(reply)) });
    }
  }
  assert.deepEqual(await f.snapshot(), beforeAuth, 'Malformed expiry reads also leave every user table unchanged');
  assert.deepEqual(expiryResponses, malformedExpiries.flatMap((_, i) => ['list_ticket_runs', 'get_ticket'].map(name => ({
    name, i, error: { code: -32602, message: 'Task storage unavailable', data: { code: 'STORAGE_UNAVAILABLE', status: 503 } }, leaksMarker: false,
  }))));
  assert.deepEqual(await f.snapshot(),beforeAuth);
  console.log('PASS: actual effective grant states, frozen contracts, crypto-signed v1/v2 evidence and failed/cancel/stop history remain readonly');
} finally {await f.close();}

// A custom trusted registry must be forwarded, and malformed configuration is lazy.
for(const malformed of [false,true]) {
  const registry=[{...REGISTERED_OPERATIONS[0],operationId:'fixture.custom.v1',argv:['node','-e','/* PRIVATE_COMMAND never executed */'],inputs:[],artifacts:[]}];
  const f=await setup({executionRegistry:malformed?'PRIVATE_BAD_JSON':JSON.stringify(registry)});
  try {
    await f.insert('bound','ticket',{title:'Bound'});const prepared=await f.prepared('bound',{registry});
    await f.insert('unbound','ticket',{});await f.insert('manual','run',{ticketId:'unbound'});await f.rawRun('unbound-run','unbound');
    await f.rawRun('mismatch','unbound',f.owners.alice,{authorization_id:prepared.authorization.id});
    const before=await f.snapshot();
    const reply=await f.rpc('list_ticket_runs',{ticket_id:'bound'});
    if(malformed) { assert.deepEqual(reply.error.data,{code:'CONFIGURATION_UNAVAILABLE',status:503});assert.doesNotMatch(JSON.stringify(reply),/PRIVATE_|JSON|registry/); }
    else assert.equal(value(reply).items[0].authorization.effective_status,'pending');
    for(const [name,args] of [['list_tickets',{}],['list_plans',{}],['get_ticket',{ticket_id:'unbound'}],['list_ticket_runs',{ticket_id:'unbound'}]]) value(await f.rpc(name,args));
    assert.deepEqual(await f.snapshot(),before);
  } finally {await f.close();}
}
console.log('PASS: custom current registry and sanitized lazy configuration failure preserve unrelated reads');
