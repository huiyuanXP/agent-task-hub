import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { localFixture } from './fixture.mjs';
test('native HTTP local login, real records/MCP, owner isolation, CSRF, restart and logout',async()=>{
 const f=await localFixture();try{
 const request=(path,body,headers={})=>fetch(f.origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{...(body===undefined?{}:{'Content-Type':'application/json',origin:f.origin}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await request('/api/records')).status,401);
 assert.equal((await request('/api/records',undefined,{'x-user-id':f.alice.userId})).status,401);
 assert.equal((await request('/api/auth/login',{username:'alice',password:'incorrect'})).status,401);
 const login=await request('/api/auth/login',{username:'alice',password:'synthetic-password'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);
 const session=await (await request('/api/session',undefined,{cookie})).json();assert.equal(session.mode,'local');assert.deepEqual(session.user,f.alice);assert.ok(!JSON.stringify(session).includes('token'));
 assert.equal((await request('/api/records',{kind:'idea',title:'Owned local idea',text:'synthetic',project:'Local'},{cookie,origin:'https://evil.invalid'})).status,403);
 const create=await request('/api/records',{kind:'idea',title:'Owned local idea',text:'synthetic',project:'Local'},{cookie});assert.equal(create.status,201,await create.text());
 const own=await (await request('/api/records',undefined,{cookie})).json();assert.match(JSON.stringify(own),/Owned local idea/);
 const other=await (await request('/api/records',undefined,{authorization:`Bearer ${f.bobToken}`})).json();assert.ok(!JSON.stringify(other).includes('Owned local idea'));
 const mcp=await request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'},{authorization:`Bearer ${f.aliceToken}`});assert.equal(mcp.status,200);assert.ok((await mcp.json()).result.tools.length>0);
 assert.equal((await request('/api/session',undefined,{cookie,authorization:`Bearer ${f.aliceToken}`})).status,401);
 assert.equal((await fetch(f.origin+'/api/records',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 const invalidHostStatus=await new Promise((resolve,reject)=>{const req=httpRequest(f.origin+'/api/session',{headers:{cookie,host:'evil.invalid'}},response=>{response.resume();resolve(response.statusCode);});req.on('error',reject);req.end();});assert.equal(invalidHostStatus,403);
 const withoutOrigin=await fetch(f.origin+'/mcp',{method:'POST',headers:{authorization:`Bearer ${f.aliceToken}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})});assert.equal(withoutOrigin.status,200);
 await f.db.prepare("UPDATE local_tokens SET expires_at=0 WHERE owner=? AND kind='api'").bind(f.bob.userId).run();
 assert.equal((await request('/api/session',undefined,{authorization:`Bearer ${f.bobToken}`})).status,401);
 await f.stop();await f.start();assert.match(JSON.stringify(await (await request('/api/records',undefined,{cookie})).json()),/Owned local idea/);
 assert.equal((await request('/api/auth/logout',{}, {cookie})).status,200);assert.equal((await request('/api/records',undefined,{cookie})).status,401);
 assert.equal((await request('/signin')).status,200);
 }finally{await f.close();}
});

test('signed checkpoint HTTP remains independent of browser credentials and rejects replays',async()=>{
 const { signRequest,verifyReply,canonical }=await import('../../lib/execution/transport.mts');
 const { sha256 }=await import('../../lib/execution/evidence.mts');
 const { getOperationCatalog }=await import('../../lib/execution/catalog.mts');
 const { prepareExecution,decideAuthorization }=await import('../../lib/execution/authorization.mts');
 const { createDispatchPermit }=await import('../../lib/execution/dispatch.mts');
 const keys=async keyId=>{const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);return {signing:{keyId,privateKey:pair.privateKey},trust:{keyId,key:pair.publicKey},private:JSON.stringify({keyId,jwk:await crypto.subtle.exportKey('jwk',pair.privateKey)}),public:JSON.stringify({keyId,jwk:await crypto.subtle.exportKey('jwk',pair.publicKey)})};};
 const control=await keys('local-control'),runner=await keys('local-runner');
 const f=await localFixture({env:{EXECUTION_CONTROL_KEY:control.private,EXECUTION_RUNNER_KEY:runner.public,EXECUTION_CHECKPOINT_AUDIENCE:'control'}});try{
 const context={owner:f.alice.userId,actor:f.alice.userId,grantAuthority:'owner'};
 const now=new Date().toISOString();await f.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)').bind('ticket-1',f.alice.userId,'ticket','{"title":"Synthetic frozen contract","status":"todo"}',1,now,now).run();
 const {operations}=await getOperationCatalog(f.db,context,{ticketId:'ticket-1',expectedRevision:1});
 const prepared=await prepareExecution(f.db,context,{ticketId:'ticket-1',expectedRevision:1,requestId:'local-checkpoint',attempt:1,scope:[{operationId:operations[0].operationId,definitionHash:operations[0].definitionHash}],budget:{timeoutMs:30000,memoryMb:256,cpus:1,pids:64},expiresAt:Date.now()+60000});
 await decideAuthorization(f.db,context,{authorizationId:prepared.authorization.id,decisionId:'approve',outcome:'approved'});
 const permit=await createDispatchPermit(f.db,context,prepared.run.id);
 const body=canonical({permitId:permit.permitId,permitSha256:await sha256(canonical(permit)),deadlineMs:permit.deadlineMs});
 const call=headers=>fetch(f.origin+'/api/execution/checkpoint',{method:'POST',headers,body});
 assert.equal((await call({authorization:`Bearer ${f.aliceToken}`})).status,401);
 const signed=await signRequest(runner.signing,{direction:'runner-to-control',audience:'control',method:'POST',path:'/api/execution/checkpoint',body});
 const headers={'x-execution-signature':JSON.stringify(signed)};
 const response=await call(headers);const text=await response.text();assert.equal(response.status,200,text);assert.equal(JSON.parse(text).allowed,true);
 assert.ok(await verifyReply(JSON.parse(response.headers.get('x-execution-signature')),control.trust,signed,200,text));
 assert.equal((await call(headers)).status,401);
 }finally{await f.close();}
});

test('development server uses the same real local account boundary',async()=>{
 const f=await localFixture({dev:true});try{
 assert.equal((await fetch(f.origin+'/api/records',{headers:{'x-user-id':f.alice.userId}})).status,401);
 const response=await fetch(f.origin+'/api/auth/login',{method:'POST',headers:{origin:f.origin,'Content-Type':'application/json'},body:JSON.stringify({username:'alice',password:'synthetic-password'})});
 assert.equal(response.status,200,await response.clone().text());
 const cookie=response.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(f.origin+'/api/records',{headers:{cookie}})).status,200);
 }finally{await f.close();}
});
