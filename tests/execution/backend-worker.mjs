// Real built Worker/D1 + loopback Node supervisor + actual Docker, with isolated Access keys.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { chromium } from '../browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from '../browser/network.mjs';
import { freePort } from '../harness.mjs';
import { REGISTERED_OPERATIONS } from '../../lib/execution/registry.mts';
import { signedFetch } from '../../lib/execution/transport.mts';
import { startSupervisor } from '../../runner/server.mjs';
import { cleanupFixture } from './fixtures/cleanup.mjs';
const origin='https://hub.example.test',issuer='https://backend-team.cloudflareaccess.com',audience='c'.repeat(64);
const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk={...await exportJWK(publicKey),kid:'synthetic',alg:'RS256',use:'sig'};
const token=async sub=>new SignJWT({type:'app',email:sub+'@example.test',name:sub}).setProtectedHeader({alg:'RS256',kid:'synthetic',typ:'JWT'}).setIssuer(issuer).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(privateKey);
const alice=await token('alice'),bob=await token('bob');let current=alice,worker,supervisor,browser,base;
const temporary=await mkdtemp(join(tmpdir(),'backend-worker-'));const runnerPort=await freePort(),runnerUrl='http://127.0.0.1:'+runnerPort;
const errors=[],outbound=[],transportFailures=[];let dropCancel=false,heldRunId=null,holdPoll=false,releasePoll=()=>{},pollGate;
async function pair(keyId){const k=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);return {signing:{keyId,privateKey:k.privateKey},trust:{keyId,key:k.publicKey},private:JSON.stringify({keyId,jwk:await crypto.subtle.exportKey('jwk',k.privateKey)}),public:JSON.stringify({keyId,jwk:await crypto.subtle.exportKey('jwk',k.publicKey)})};}
const control=await pair('control'),node=await pair('supervisor'),evidence=await pair('evidence');
const registry=[...REGISTERED_OPERATIONS,{...REGISTERED_OPERATIONS[0],operationId:'large.artifact',label:'Large retained artifact',argv:['node','-e','require("fs").writeFileSync("output/large.bin",Buffer.alloc(1048576,90))'],inputs:[],artifacts:[{path:'output/large.bin',maxBytes:1048576}]},{...REGISTERED_OPERATIONS[0],operationId:'slow.revoke',label:'Revocable operation',argv:['node','-e','process.stdout.write("actual interrupted output");setTimeout(()=>{},60000)'],inputs:[],artifacts:[]}];
const facade=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const headers=new Headers(req.headers);headers.delete('host');headers.delete('authorization');headers.delete('cookie');headers.set('cf-access-jwt-assertion',current);if(headers.get('origin')===base)headers.set('origin',origin);
 const response=await worker.dispatchFetch(origin+req.url,{method:req.method,headers,redirect:'manual',...(chunks.length?{body:Buffer.concat(chunks)}:{})});const bytes=Buffer.from(await response.arrayBuffer());if(holdPoll&&req.method==='GET'&&new URL(req.url,base).pathname==='/api/execution')await pollGate;res.writeHead(response.status,Object.fromEntries(response.headers));res.end(bytes);
}catch{res.writeHead(503);res.end('unavailable');}});
async function api(path,body,jwt=alice){const r=await worker.dispatchFetch(origin+path,{headers:{...(jwt?{authorization:'Bearer '+jwt}:{}),...(body?{'content-type':'application/json',origin}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data};}
try{
 await new Promise(r=>facade.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+facade.address().port;
 const config=JSON.parse(await readFile('dist/server/wrangler.json','utf8'));
 worker=new Miniflare({host:'127.0.0.1',port:0,modulesRoot:'dist/server',modules:[config.main,...(await readdir('dist/server',{recursive:true})).filter(p=>/\.m?js$/.test(p)&&p!==config.main)].map(path=>({type:'ESModule',path:join('dist/server',path)})),compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
  bindings:{ACCESS_TEAM_DOMAIN:issuer,ACCESS_AUDIENCE:audience,ACCESS_APPLICATION_ORIGIN:origin,ACCESS_ALLOWED_EMAILS:'["alice@example.test","bob@example.test"]',EXECUTION_REGISTRY:JSON.stringify(registry),EXECUTION_RUNNER_URL:runnerUrl,EXECUTION_RUNNER_AUDIENCE:'runner',EXECUTION_CHECKPOINT_AUDIENCE:'control',EXECUTION_CONTROL_KEY:control.private,EXECUTION_RUNNER_KEY:node.public,EXECUTION_EVIDENCE_KEY:evidence.public},
  d1Databases:{DB:'00000000-0000-4000-8000-000000000000'},d1Persist:join(temporary,'d1'),assets:{directory:'dist/client',binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:false}},
  outboundService:async request=>{if(request.url===issuer+'/cdn-cgi/access/certs')return Response.json({keys:[jwk]});if(new URL(request.url).origin===runnerUrl&&new URL(request.url).pathname==='/cancel'&&dropCancel){transportFailures.push({path:'/cancel',status:503});return new Response('Synthetic transport outage',{status:503});}if(new URL(request.url).origin===runnerUrl){const body=await request.text();if(heldRunId&&['/cancel','/result'].includes(new URL(request.url).pathname)&&JSON.parse(body).permit?.runId===heldRunId){transportFailures.push({path:new URL(request.url).pathname,status:503,heldRunId});return new Response('Held predecessor stop delivery',{status:503});}return fetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),body,redirect:'error'});}outbound.push(request.url);return new Response('Denied',{status:403});}});
 await worker.ready;const db=await worker.getD1Database('DB');for(const name of (await readdir('drizzle')).filter(n=>n.endsWith('.sql')).sort())for(const sql of (await readFile(join('drizzle',name),'utf8')).split('--> statement-breakpoint').filter(s=>s.trim()))await db.prepare(sql).run();
 const supervisorConfig={registry,root:join(temporary,'supervisor'),port:runnerPort,audience:'runner',controlTrust:control.trust,transportKey:node.signing,evidenceKey:evidence.signing,checkpoint:{baseUrl:base,audience:'control',direction:'runner-to-control',signing:node.signing,trust:control.trust}};supervisor=await startSupervisor(supervisorConfig);
 const owner='access:'+createHash('sha256').update(JSON.stringify([issuer,'alice'])).digest('hex'),now=new Date().toISOString();
 await db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind('ticket-real',owner,'ticket',JSON.stringify({title:'Actual backend Ticket',status:'todo',project:'Synthetic',payload:'😀'.repeat(79900)}),1,now,now).run();
 assert.equal((await api('/api/execution/dispatch',undefined,null)).status,401);
 assert.equal((await api('/api/execution/checkpoint',{permitId:'spoof'},null)).status,401);
 assert.equal((await api('/api/execution/dispatch')).status,200);
 const catalog=await api('/api/authorization?ticketId=ticket-real&expectedRevision=1');assert.equal(catalog.status,200);
 const p=await api('/api/authorization',{action:'prepare',ticketId:'ticket-real',expectedRevision:1,requestId:'actual-backend',attempt:1,scope:catalog.data.operations.slice(0,1).map(({operationId,definitionHash})=>({operationId,definitionHash})),budget:{timeoutMs:30000,memoryMb:256,cpus:1,pids:64},expiresAt:Date.now()+600000});assert.equal(p.status,201);const runId=p.data.run.id;
 assert.equal((await api('/api/execution/dispatch',{action:'start',runId})).status,403);
 assert.equal((await api('/api/authorization',{action:'decide',authorizationId:p.data.authorization.id,decisionId:'approve',outcome:'approved'})).status,200);
 assert.equal((await api('/api/execution/dispatch',{action:'start',runId},bob)).status,404);
 assert.equal((await api('/api/execution/dispatch',{action:'start',runId})).status,202);
 let result;const until=Date.now()+40000;while(Date.now()<until){result=await api('/api/execution/dispatch?runId='+runId);assert.equal(result.status,200,JSON.stringify(result));if(result.data.backend?.receipts.some(r=>r.claims.purpose==='stop'))break;await new Promise(r=>setTimeout(r,200));}
 assert.equal(result.data.run.state,'succeeded',JSON.stringify(result));assert.equal(result.data.run.evidence.claims.version,2);
 const content=await api('/api/execution/dispatch',{action:'content',runId,kind:'artifact',path:'output/result.json'});assert.equal(content.status,200);assert.equal(content.data.title,'Actual backend Ticket');
 assert.equal((await api('/api/execution/dispatch',{action:'content',runId,kind:'artifact',path:'output/result.json'},bob)).status,404);
 assert.equal((await db.prepare('SELECT closed_at FROM execution_permits WHERE run_id=?').bind(runId).first()).closed_at!==null,true);
 console.log('Built Worker + verified Access + signed bidirectional checkpoint + actual Docker success, owner-scoped actual artifact bytes and physical closure passed');
 browser=await launchRestrictedBrowser(chromium,[base]);const page=await browser.context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.getByRole('button',{name:/Ticket 看板/}).click();const panel=page.getByRole('region',{name:'执行授权'});await panel.waitFor();
 await panel.getByText('执行后端已连接',{exact:true}).waitFor({timeout:10000});await panel.getByRole('button',{name:'下载 output/result.json'}).waitFor({timeout:10000});
 const downloaded=page.waitForEvent('download');await panel.getByRole('button',{name:'下载 output/result.json'}).click();const download=await downloaded;const contentStream=await download.createReadStream();const actual=[];for await(const chunk of contentStream)actual.push(chunk);assert.equal(JSON.parse(Buffer.concat(actual).toString()).title,'Actual backend Ticket');
 await panel.getByLabel('执行操作').selectOption('large.artifact');await panel.getByRole('button',{name:'请求执行授权'}).click();await panel.getByText('pending',{exact:true}).waitFor();await panel.getByRole('button',{name:'批准授权'}).click();await panel.getByText('approved',{exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:/Ticket 看板/}).click();await panel.getByText('approved',{exact:true}).waitFor();assert.equal(await panel.getByLabel('执行操作').inputValue(),'large.artifact');await panel.getByRole('button',{name:'启动已批准的执行'}).click();await panel.getByText(/实际结果：succeeded/).waitFor({timeout:40000});
 const uiCancel=await prepareOperation('ticket-ui-cancel','slow.revoke');assert.equal((await api('/api/execution/dispatch',{action:'start',runId:uiCancel.run.id})).status,202);
 await page.reload();await page.getByRole('button',{name:/Ticket 看板/}).click();await panel.getByLabel('授权 Ticket').selectOption('ticket-ui-cancel');await panel.getByText(/Run .* · running ·/).waitFor({timeout:20000});
 dropCancel=true;holdPoll=true;pollGate=new Promise(r=>releasePoll=r);const failedCancel=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/execution/dispatch'&&r.request().method()==='POST'&&r.status()===503);
 await panel.getByRole('button',{name:'取消 Run，允许重新申请'}).click();await failedCancel;await panel.getByText(/Run .* · cancelled ·/).waitFor({timeout:1000});await panel.getByText(/尚未确认物理停止/).waitFor({timeout:1000});assert.ok(transportFailures.length);assert.equal((await api('/api/execution?id='+uiCancel.run.id)).data.run.state,'cancelled');assert.equal((await db.prepare('SELECT cancel_requested,closed_at FROM execution_permits WHERE run_id=?').bind(uiCancel.run.id).first()).cancel_requested,1);
 heldRunId=uiCancel.run.id;holdPoll=false;releasePoll();dropCancel=false;
 console.log('Owner UI retains committed cancellation with stop unconfirmed despite lost transport and held domain polls');
 // Prepare B while A is terminal but its actual stop cannot reach D1. Reload
 // must retain a recovery path without the operator manually addressing A.
 await panel.getByLabel('执行操作').selectOption('ticket.validate.v1');
 await panel.getByRole('button',{name:'请求执行授权'}).click();await panel.getByText('pending',{exact:true}).waitFor();
 await panel.getByRole('button',{name:'批准授权'}).click();await panel.getByText('approved',{exact:true}).waitFor();
 const nextRun=await db.prepare('SELECT id FROM execution_runs WHERE ticket_id=? AND attempt=2').bind('ticket-ui-cancel').first();assert.ok(nextRun);
 await page.reload();await page.getByRole('button',{name:/Ticket 看板/}).click();await panel.getByLabel('授权 Ticket').selectOption('ticket-ui-cancel');await panel.getByText('approved',{exact:true}).waitFor();assert.ok((await panel.innerText()).includes(nextRun.id));
 assert.ok([409,503].includes((await api('/api/execution/dispatch',{action:'start',runId:nextRun.id})).status));
 assert.equal(await db.prepare('SELECT id FROM execution_permits WHERE run_id=?').bind(nextRun.id).first(),null);
 const priorPermit=await db.prepare('SELECT envelope,closed_at FROM execution_permits WHERE run_id=?').bind(uiCancel.run.id).first();assert.equal(priorPermit.closed_at,null);
 const direct={baseUrl:runnerUrl,audience:'runner',direction:'control-to-runner',signing:control.signing,trust:node.trust};let stoppedPrior;
 const stopUntil=Date.now()+20000;while(Date.now()<stopUntil){stoppedPrior=await signedFetch(direct,'/result',{permit:JSON.parse(priorPermit.envelope)});if(stoppedPrior.data.receipts.some(r=>r.claims.purpose==='stop'))break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(stoppedPrior.data.receipts.some(r=>r.claims.purpose==='stop'),'Actual supervisor must retain stop while Worker delivery is held');
 assert.equal((await db.prepare('SELECT closed_at FROM execution_permits WHERE run_id=?').bind(uiCancel.run.id).first()).closed_at,null);
 heldRunId=null;
 const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/execution/dispatch'&&new URL(r.url()).searchParams.get('runId')===nextRun.id&&r.status()===200);
 await panel.getByRole('button',{name:'刷新授权状态'}).click();await refreshed;
 assert.notEqual((await db.prepare('SELECT closed_at FROM execution_permits WHERE run_id=?').bind(uiCancel.run.id).first()).closed_at,null,'Polling B must ingest the occupying predecessor stop');
 await panel.getByRole('button',{name:'启动已批准的执行'}).click();await panel.getByText(/实际结果：succeeded/).waitFor({timeout:40000});
 assert.equal((await api('/api/execution?id='+nextRun.id)).data.run.state,'succeeded');assert.equal((await api('/api/execution?id='+uiCancel.run.id)).data.run.state,'cancelled');
 console.log('Prepared successor survives reload and recovers the predecessor physical reservation only after verified actual stop');
 current=bob;await page.reload();await page.getByRole('button',{name:/Ticket 看板/}).click();assert.equal(await page.getByText(runId,{exact:false}).count(),0);
 await browser.flushNetworkEvidence();assert.deepEqual(browser.errors,[]);assert.deepEqual([...new Set(browser.requestedExternal)].filter(x=>!['https://fonts.googleapis.com','https://fonts.gstatic.com'].includes(x)),[]);assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);
 await mkdir('test-results',{recursive:true});await writeFile('test-results/backend-browser-evidence.json',JSON.stringify({blocked:browser.blocked,requestedExternal:browser.requestedExternal,errors},null,2));
 console.log('Execution UI configured health, verified retained artifact access and account reset passed');
 async function prepareOperation(ticketId,operationId){
  await db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind(ticketId,owner,'ticket',JSON.stringify({title:ticketId,status:'todo'}),1,now,now).run();
  const catalog=await api('/api/authorization?ticketId='+ticketId+'&expectedRevision=1');const selected=catalog.data.operations.find(o=>o.operationId===operationId);
  const prepared=await api('/api/authorization',{action:'prepare',ticketId,expectedRevision:1,requestId:ticketId,attempt:1,scope:[{operationId:selected.operationId,definitionHash:selected.definitionHash}],budget:{timeoutMs:30000,memoryMb:256,cpus:1,pids:64},expiresAt:Date.now()+600000});assert.equal(prepared.status,201);
  assert.equal((await api('/api/authorization',{action:'decide',authorizationId:prepared.data.authorization.id,decisionId:'approve-'+ticketId,outcome:'approved'})).status,200);return prepared.data;
 }
 async function completed(runId){const until=Date.now()+40000;let result;while(Date.now()<until){result=await api('/api/execution/dispatch?runId='+runId);assert.equal(result.status,200);if(result.data.backend?.receipts.some(r=>r.claims.purpose==='stop'))return result.data;await new Promise(r=>setTimeout(r,200));}throw Error('Backend completion deadline: '+JSON.stringify(result));}
 const large=await prepareOperation('ticket-large','large.artifact');assert.equal((await api('/api/execution/dispatch',{action:'start',runId:large.run.id})).status,202);const largeResult=await completed(large.run.id);assert.equal(largeResult.run.state,'succeeded');assert.equal(largeResult.run.evidence.claims.artifacts[0].bytes,1048576);
 await supervisor.close();supervisor=await startSupervisor(supervisorConfig);
 const largeContent=await api('/api/execution/dispatch',{action:'content',runId:large.run.id,kind:'artifact',path:'output/large.bin'});assert.equal(largeContent.status,200);assert.equal(largeContent.data.length,1048576);assert.equal(createHash('sha256').update(largeContent.data).digest('hex'),largeResult.run.evidence.claims.artifacts[0].sha256);
 assert.equal((await api('/api/execution/dispatch',{action:'content',runId:large.run.id,kind:'artifact',path:'output/large.bin'},bob)).status,404);
 console.log('Full1MiB real artifact survives cleanup/restart and verified owner download within base64/reply bounds');
 const slow=await prepareOperation('ticket-revoke','slow.revoke');assert.equal((await api('/api/execution/dispatch',{action:'start',runId:slow.run.id})).status,202);
 const runningUntil=Date.now()+20000;let running;while(Date.now()<runningUntil){running=await api('/api/execution/dispatch?runId='+slow.run.id);if(running.data.run.state==='running')break;await new Promise(r=>setTimeout(r,200));}assert.equal(running.data.run.state,'running');
 assert.equal((await api('/api/authorization',{action:'revoke',authorizationId:slow.authorization.id,decisionId:'revoke-actual'})).status,200);
 assert.equal((await db.prepare('SELECT cancel_requested FROM execution_permits WHERE run_id=?').bind(slow.run.id).first()).cancel_requested,1);
 const stopped=await completed(slow.run.id);assert.equal(stopped.run.state,'cancelled');assert.equal(stopped.run.evidence,null);assert.ok(stopped.backend.receipts.some(r=>r.claims.purpose==='cancel_fence'));assert.ok(stopped.backend.receipts.some(r=>r.claims.purpose==='stop'));assert.equal((await api('/api/execution/dispatch',{action:'content',runId:slow.run.id,kind:'stdout'})).data,'actual interrupted output');
 console.log('Real owner revocation atomically retains cancellation intent and reconciles durable fence plus actual physical stop');
}finally{holdPoll=false;releasePoll();try{if(browser){await browser.flushNetworkEvidence();await mkdir('test-results',{recursive:true});await writeFile('test-results/backend-browser-'+Date.now()+'-evidence.json',JSON.stringify({blocked:browser.blocked,requestedExternal:browser.requestedExternal,errors,transportFailures},null,2));}}finally{try{await browser?.close();}finally{try{await supervisor?.close();}finally{await worker?.dispose();await new Promise(r=>facade.close(r));await cleanupFixture(join(temporary,'supervisor'));await rm(temporary,{recursive:true,force:true});}}}}
