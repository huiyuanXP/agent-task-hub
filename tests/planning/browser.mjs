// Real Chromium -> loopback ingress -> authenticated native server and fresh SQLite.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { planningFixture } from './fixture.mjs';
import { chromium } from '../browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from '../browser/network.mjs';
const f = await planningFixture();
const {issueToken}=await import('../../lib/local-auth.mts');
const browserSession=await issueToken(f.db,f.alice.userId,{kind:'browser'});
let base, restricted;
const errors = [];
const facade = createServer(async (req,res) => {
  try {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const headers=new Headers(req.headers); headers.delete('host'); headers.delete('authorization'); headers.delete('cookie');
    if(headers.get('origin')===base) headers.set('origin',f.origin);
    headers.set('cookie','hub_session='+browserSession.token);
    const response=await fetch(f.origin+req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
    const body=Buffer.from(await response.arrayBuffer()); const outgoing=Object.fromEntries(response.headers);
    delete outgoing['content-encoding']; delete outgoing['content-length'];
    res.writeHead(response.status,outgoing); res.end(body);
  } catch(error) { errors.push(String(error)); res.writeHead(500); res.end('Fixture failure'); }
});
try {
  const create=async title => { const r=await f.request('/api/records',{kind:'idea',title,project:'browser'}); assert.equal(r.status,201); return {idea:{...r.body,title},id:`planning:${r.body.id}:1`}; };
  const active=await create('Active planner lease'), expired=await create('Expired planner lease'), permanent=await create('Permanent callback failure'), backoff=await create('Delivery backoff'), fallback=await create('Missing job recovery');
  for(const j of [active,expired]) await f.rpc('claim_planning_job',{job_id:j.id});
  await f.db.prepare('UPDATE jobs SET lease=0 WHERE id=?').bind(expired.id).run();
  await f.db.prepare("UPDATE jobs SET delivery='failed',recovery_reason='recovery_exhausted' WHERE id=?").bind(permanent.id).run();
  await f.db.prepare("UPDATE jobs SET delivery='retrying' WHERE id=?").bind(backoff.id).run();
  const owner=(await f.db.prepare('SELECT owner FROM jobs WHERE id=?').bind(backoff.id).first()).owner;
  await f.db.prepare("INSERT INTO planning_deliveries(id,job_id,owner,subscription_id,generation,event_id,status,attempts,next_attempt_at,last_http_status,terminal_reason,created_at,updated_at) VALUES(?,?,?,'browser-sub',0,'browser-event','retrying',2,?,503,'temporary_http',?,?)").bind('browser-target',backoff.id,owner,Date.now()+120000,Date.now(),Date.now()).run();
  await f.db.prepare("INSERT INTO planning_deliveries(id,job_id,owner,subscription_id,generation,event_id,status,attempts,last_http_status,terminal_reason,created_at,updated_at) VALUES(?,?,?,'browser-permanent-sub',0,'browser-permanent-event','failed',1,400,'permanent_http',?,?)").bind('browser-permanent-target',permanent.id,owner,Date.now(),Date.now()).run();
  // Historical body with a missing authoritative job must retain a usable action.
  await f.db.prepare("UPDATE records SET body=json_set(body,'$.planningStatus','planning') WHERE id=?").bind(fallback.idea.id).run();
  await f.db.prepare('DELETE FROM jobs WHERE id=?').bind(fallback.id).run();
  await new Promise(resolve=>facade.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${facade.address().port}`;
  restricted=await launchRestrictedBrowser(chromium,[base],{viewport:{width:1440,height:1100}});
  const page=await restricted.context.newPage(); page.setDefaultTimeout(3000); page.on('pageerror',e=>errors.push(e.stack??e.message));
  await page.goto(base,{waitUntil:'networkidle'});
  const card=title=>page.locator('article').filter({has:page.getByRole('heading',{name:title,exact:true})});
  const failures=[];
  const check=async(name,fn)=>{try{await fn(); console.log('PASS: '+name);}catch(e){failures.push({name,error:String(e)}); console.error('FAIL: '+name+' '+String(e));}};
  await check('active lease displays deadline and countdown then expires with usable retry',async()=>{
    const c=card(active.idea.title); await c.getByText('规划详情',{exact:true}).click(); await c.getByText(/租约到期/).waitFor();
    assert.equal(await c.getByRole('button',{name:'Agent 正在处理'}).isDisabled(),true);
    await f.db.prepare('UPDATE jobs SET lease=? WHERE id=?').bind(Date.now()+10000,active.id).run();
    const refreshed=page.waitForResponse(r=>r.url()===base+'/api/planning'&&r.request().method()==='GET');
    await page.getByRole('button',{name:'刷新数据'}).click(); await refreshed;
    const countdown=c.getByText(/剩余 (?:10|[1-9]) 秒/); await countdown.waitFor(); const before=await countdown.innerText();
    await page.waitForTimeout(1200); assert.notEqual(await countdown.innerText(),before,'Lease countdown advances without mutation');
    await c.getByText(/规划租约已过期/).waitFor({timeout:12000});
    assert.equal(await c.getByRole('button',{name:'重试规划'}).isEnabled(),true);
  });
  await check('expired planner retry calls real route and refreshes recovered state',async()=>{
    const c=card(expired.idea.title); await c.getByText(/规划租约已过期/).waitFor();
    const done=page.waitForResponse(r=>r.url()===base+'/api/planning'&&r.request().method()==='POST');
    await c.getByRole('button',{name:'重试规划'}).click(); assert.equal((await done).status(),200);
    await c.getByText(/等待项目 Agent/).waitFor();
    await c.getByText(/^重试冷却：/).waitFor();
    assert.equal(await c.getByRole('button',{name:'等待重试冷却'}).isDisabled(),true);
    const row=await f.db.prepare('SELECT generation,retry_after FROM jobs WHERE id=?').bind(expired.id).first(); assert.equal(row.generation,1); assert.ok(row.retry_after>Date.now());
  });
  await check('permanent reason and exhausted recovery visible with eligible action',async()=>{
    const c=card(permanent.idea.title); await c.getByText(/recovery_exhausted/).waitFor(); await c.getByText(/^原因：.*permanent_http/).waitFor();
    assert.equal(await c.getByRole('button',{name:'重试规划'}).isEnabled(),true);
  });
  await check('backoff displays authoritative next retry and sanitized target reason',async()=>{
    const c=card(backoff.idea.title); await c.getByText('规划详情',{exact:true}).click(); await c.getByText(/下次投递/).waitFor(); await c.getByText(/^原因：.*temporary_http/).waitFor();
    assert.equal(await c.getByRole('button',{name:'等待自动重试'}).isDisabled(),true);
  });
  await check('missing metadata preserves manual recovery action',async()=>{
    const c=card(fallback.idea.title); assert.equal(await c.getByRole('button',{name:'请求 Agent'}).isEnabled(),true);
  });
  await restricted.flushNetworkEvidence(); assert.deepEqual(errors,[]); assert.deepEqual(restricted.errors,[]);
  assert.deepEqual(restricted.requestedExternal,[]);
  console.log('PLANNING_BROWSER_EVIDENCE '+JSON.stringify({failures,pageErrors:errors,networkPolicyErrors:restricted.errors,blocked:restricted.blocked}));
  assert.deepEqual(failures,[],'Chromium recovery contract failures');
} finally { await restricted?.close(); facade.closeAllConnections(); if(facade.listening) await new Promise(resolve=>facade.close(resolve)); await f.close(); }
