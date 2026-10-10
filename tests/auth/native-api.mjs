// Real native accounts, SQLite and authenticated application handlers.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { localFixture } from '../local/fixture.mjs';
import { issueToken } from '../../lib/local-auth.mts';
const f=await localFixture(), origin=f.origin, db=f.db;
const alice=f.aliceToken,bob=f.bobToken,owner=actor=>f[actor].userId;
const spoof={'x-user-id':'forged','oai-authenticated-user-id':'forged'};
async function request(path,{jwt=alice,method,body,headers={}}={}){
 const response=await fetch(origin+path,{method:method??(body===undefined?'GET':'POST'),redirect:'manual',headers:{...(jwt?{authorization:'Bearer '+jwt}:{}),...(body===undefined?{}:{'content-type':'application/json',origin}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await response.text();let json;try{json=JSON.parse(text);}catch{}return {status:response.status,headers:response.headers,json,text};
}
async function expect(status,path,options){const result=await request(path,options);assert.equal(result.status,status,`${path}: ${result.text}`);return result;}
try {
 for(const path of ['/api/session','/api/records','/api/planning','/api/execution','/api/authorization','/mcp'])await expect(401,path,{jwt:null,headers:spoof});
 const session=await expect(200,'/api/session');assert.deepEqual(session.json.user,f.alice);assert.equal(session.json.mode,'local');assert.match(session.headers.get('cache-control'),/no-store/);
 assert.equal((await expect(200,'/api/session',{headers:spoof})).json.user.userId,f.alice.userId);
 for(const token of ['invalid',randomBytes(32).toString('base64url'),alice.slice(1),alice+'A'])await expect(401,'/api/session',{jwt:token});
  const create = (jwt, title) => expect(201, '/api/records', { jwt, body: { kind: 'ticket', status: 'todo', title } });
  const [a, b] = await Promise.all([create(alice, 'Alice private'), create(bob, 'Bob private')]);
  for (let i = 0; i < 8; i++) {
    const results = await Promise.all([request('/api/records'), request('/api/records', { jwt: bob }), request('/api/session', { jwt: bob }), request('/')]);
    assert.deepEqual(results[0].json.records.map(row => row.id), [a.json.id]);
    assert.deepEqual(results[1].json.records.map(row => row.id), [b.json.id]);
    assert.equal(results[2].json.user.userId, owner('bob')); assert.equal(results[3].status, 200);
  }
  await expect(404, '/api/records', { jwt: bob, body: { id: a.json.id, kind: 'ticket', status: 'todo', title: 'steal', revision: 1 } });
  const idea = await expect(201, '/api/records', { body: { kind: 'idea', title: 'Private idea', text: 'Planning only' } });
  await expect(200, '/api/planning', { body: { ideaId: idea.json.id } });
  assert.equal((await expect(200, '/api/planning')).json.jobs.length, 1);
  assert.equal((await expect(200, '/api/planning', { jwt: bob })).json.jobs.length, 0);
  const rpc = (name, args = {}, options = {}) => request('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ...options });
  assert.equal((await rpc('get_idea', { idea_id: idea.json.id })).json.result.structuredContent.title, 'Private idea');
  const catalog = (await expect(200, `/api/authorization?ticketId=${a.json.id}&expectedRevision=1`)).json;
  const input = { ticketId: a.json.id, expectedRevision: 1, requestId: 'auth-test', attempt: 1, scope: catalog.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 600000 };
  const prepared = (await expect(201, '/api/authorization', { body: { action: 'prepare', ...input } })).json;
  assert.equal(prepared.authorization.effectiveStatus, 'pending');
  await expect(404, '/api/authorization?id=' + prepared.authorization.id, { jwt: bob });
  await expect(404, '/api/execution?id=' + prepared.run.id, { jwt: bob });
  await expect(200, '/api/execution?id=' + prepared.run.id);
  // Authentication alone must not approve a Run.
  assert.equal((await db.prepare('SELECT status FROM execution_authorizations WHERE id=?').bind(prepared.authorization.id).first()).status, 'pending');

 const login=await expect(200,'/api/auth/login',{jwt:null,body:{username:'alice',password:'synthetic-password'}});
 const cookie={cookie:login.headers.get('set-cookie').split(';')[0]};
 await expect(200,'/api/session',{jwt:null,headers:cookie});
 await expect(401,'/api/session',{headers:cookie});
 const message={jsonrpc:'2.0',id:2,method:'tools/list'};
 await expect(403,'/mcp',{jwt:null,body:message,headers:{...cookie,origin:''}});
 await expect(403,'/mcp',{body:message,headers:{origin:'https://foreign.invalid'}});
 const bare=await fetch(origin+'/mcp',{method:'POST',headers:{authorization:'Bearer '+alice,'content-type':'application/json'},body:JSON.stringify(message)});assert.equal(bare.status,200);await bare.text();
 await expect(403,'/api/records',{jwt:null,body:{kind:'idea',title:'Missing Origin'},headers:{...cookie,origin:''}});
 await expect(405,'/api/auth/logout');
 await expect(403,'/api/auth/logout',{jwt:null,body:{},headers:{...cookie,origin:'https://foreign.invalid'}});
 await db.prepare("CREATE TRIGGER revoke_fault BEFORE DELETE ON local_tokens BEGIN SELECT RAISE(ABORT,'private storage detail'); END").run();
 const failed=await expect(503,'/api/auth/logout',{jwt:null,body:{},headers:cookie});assert.equal(failed.headers.get('set-cookie'),null);assert.ok(!failed.text.includes('private storage detail'));await expect(200,'/api/session',{jwt:null,headers:cookie});
 await db.prepare('DROP TRIGGER revoke_fault').run();
 await expect(200,'/api/auth/logout',{jwt:null,body:{},headers:cookie});await expect(401,'/api/session',{jwt:null,headers:cookie});await expect(200,'/api/session',{jwt:bob});
 const short=await issueToken(db,f.bob.userId,{kind:'api',ttlSeconds:60,now:Date.now()-59000});await expect(200,'/api/session',{jwt:short.token});
 await new Promise(resolve=>setTimeout(resolve,1100));await expect(401,'/api/session',{jwt:short.token});
 await f.stop();await f.start();await expect(200,'/api/session');
 console.log('PASS: real accounts, concurrent ownership, protected API/MCP/authorization, safe sessions, origin, logout rollback/revocation, expiry and persistent restart');
}finally{await f.close();}
