import test from 'node:test';
import assert from 'node:assert/strict';
import {readTicketWorkspaceRuns,ticketRequest} from '../../lib/tickets/request.mts';
test('ticket pagination follows all cursors and never uses a global first page',async()=>{
 const urls=[];
 const runs=await readTicketWorkspaceRuns('ticket /special',async url=>{
  urls.push(url);
  return urls.length===1?{runs:[{id:'history'}],nextCursor:'next/page'}:{runs:[{id:'active'}],nextCursor:null};
 });
 assert.deepEqual(runs.map(r=>r.id),['history','active']);
 assert.ok(urls.every(url=>url.includes('ticketId=ticket%20%2Fspecial')));
 assert.match(urls[1],/cursor=next%2Fpage/);
});
test('auth failures clear private state before JSON parsing; 409 preserves error and inputs',async()=>{
 for(const status of [401,403]) {
  let denied=0;
  await assert.rejects(ticketRequest('/api/private',{onAuthenticationDenied:()=>++denied,fetcher:async()=>new Response('not json',{status})}),error=>error.status===status);
  assert.equal(denied,1);
 }
 const body={ticketId:'ticket',revision:1,minutes:17};
 await assert.rejects(ticketRequest('/api/private',{body,onAuthenticationDenied:()=>assert.fail('409 is not logout'),fetcher:async()=>Response.json({error:'scope changed'},{status:409})}),error=>error.status===409&&error.message==='scope changed');
 assert.deepEqual(body,{ticketId:'ticket',revision:1,minutes:17});
});
test('obsolete private response cannot enter the new binding',async()=>{
 await assert.rejects(ticketRequest('/api/private',{isCurrent:()=>false,onAuthenticationDenied:()=>assert.fail('obsolete identity'),fetcher:async()=>Response.json({private:'old'})}),error=>error.status===0);
});
