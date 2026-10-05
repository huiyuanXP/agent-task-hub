import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../lib/database.mts';
import { createAccount, login, issueToken, validateToken, revokeToken, resetPassword, authenticateHeaders, safeReturnPath } from '../../lib/local-auth.mts';
const origin='http://127.0.0.1:5173';
test('local account validation, hashed passwords/tokens, expiry, revocation and reset',async()=>{
 const db=openDatabase(':memory:');try{
 const user=await createAccount(db,{username:'Alice',displayName:'Alice',password:'synthetic-password'});assert.equal(user.username,'alice');
 await assert.rejects(createAccount(db,{username:'alice',displayName:'Other',password:'synthetic-password'}));
 for(const values of [{username:'a b'},{displayName:''},{password:'short'},{password:'a'.repeat(257)}])await assert.rejects(createAccount(db,{username:'other',displayName:'Other',password:'synthetic-password',...values}));
 const session=await login(db,{username:'ALICE',password:'synthetic-password'});assert.equal(session.user.userId,user.userId);
 const rows=await db.prepare('SELECT * FROM local_tokens').all();assert.ok(!JSON.stringify(rows).includes(session.token));
 const accounts=await db.prepare('SELECT * FROM local_users').all();assert.ok(!JSON.stringify(accounts).includes('synthetic-password'));
 const token=await issueToken(db,user.userId,{kind:'api',ttlSeconds:60,now:1000});assert.equal((await validateToken(db,token.token,60999)).user.userId,user.userId);assert.equal(await validateToken(db,token.token,61000),null);
 for(const ttlSeconds of [null,0,59,NaN,Infinity,7776001,'60'])await assert.rejects(issueToken(db,user.userId,{kind:'api',ttlSeconds}));
 await revokeToken(db,session.token);assert.equal(await validateToken(db,session.token),null);
 const next=await issueToken(db,user.userId,{kind:'api'});await resetPassword(db,'alice','replacement-password');assert.equal(await validateToken(db,next.token),null);
 await assert.rejects(login(db,{username:'alice',password:'synthetic-password'}));
 assert.equal((await login(db,{username:'alice',password:'replacement-password'})).user.userId,user.userId);
 }finally{db.close();}
});
test('unknown accounts and wrong passwords throttle, credentials cannot spoof owner or bypass CSRF/Host',async()=>{
 const db=openDatabase(':memory:');try{
 const user=await createAccount(db,{username:'alice',displayName:'Alice',password:'synthetic-password'});const browser=await login(db,{username:'alice',password:'synthetic-password'});const api=await issueToken(db,user.userId,{kind:'api'});
 const request=(headers={},method='GET')=>authenticateHeaders(db,new Headers({host:'127.0.0.1:5173',...headers}),method,origin);
 assert.equal(await request({'x-user-id':user.userId}),null);
 assert.equal((await request({authorization:`Bearer ${api.token}`})).user.userId,user.userId);
 await assert.rejects(request({cookie:`hub_session=${browser.token}`},'POST'),e=>e.status===403);
 assert.ok(await request({cookie:`hub_session=${browser.token}`,origin},'POST'));
 await assert.rejects(request({authorization:`Bearer ${api.token}`,origin:'https://evil.invalid'},'POST'),e=>e.status===403);
 await assert.rejects(request({authorization:`Bearer ${api.token}`,host:'evil.invalid'}),e=>e.status===403);
 await assert.rejects(request({authorization:`Bearer ${api.token}`,cookie:`hub_session=${browser.token}`}),e=>e.status===401);
 for(let i=0;i<5;i++)await assert.rejects(login(db,{username:'missing',password:'wrong-password'}),e=>e.status===401);
 await assert.rejects(login(db,{username:'missing',password:'wrong-password'}),e=>e.status===429);
 assert.equal(safeReturnPath('//evil.invalid'),'/');assert.equal(safeReturnPath('/\\evil.invalid'),'/');assert.equal(safeReturnPath('/?view=plans'),'/?view=plans');
 }finally{db.close();}
});
