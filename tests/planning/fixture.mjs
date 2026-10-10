// Native Next HTTP, authoritative SQLite and real loopback HMAC consumers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { localFixture } from '../local/fixture.mjs';
import { planningMetadata, retryPlanningJob, scheduledPlanning } from '../../lib/planning-recovery.mts';
import { discoverDeliveries, deliverDue } from '../../lib/planning-delivery.mts';

export async function planningFixture({executionRegistry,callbacks={},engineHarness=false}={}) {
  const errors=[], gates=new Map();
  const consumer=createServer(async(req,res)=>{
    try {
      const target=callbacks['http://127.0.0.1:1'+req.url];
      assert.ok(target,'Only registered loopback consumers receive events');
      let body='';for await(const chunk of req)body+=chunk;
      const id=req.headers['webhook-id'],timestamp=req.headers['webhook-timestamp'];
      const expected='v1,'+createHmac('sha256',Buffer.from(target.secret.slice(6),'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
      assert.ok(req.headers['webhook-signature'].split(' ').includes(expected),'Real callback HMAC');
      const event=JSON.parse(body);
      let response;
      if(event.type==='verification')response=Response.json({challenge:event.challenge});
      else {
        target.events.push({event,id,body,subscription:req.headers['x-mcp-subscription-id']});
        response=target.respond?await target.respond(event,new Request(callbackOrigin+req.url,{method:req.method,headers:req.headers,body})):new Response(null,{status:204});
      }
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){if(error.code==='ERR_ASSERTION')errors.push(error);res.destroy();}
  });
  await new Promise(resolve=>consumer.listen(0,'127.0.0.1',resolve));
  const callbackOrigin=`http://127.0.0.1:${consumer.address().port}`;
  let f;
  try{f=await localFixture({env:executionRegistry===undefined?{}:{EXECUTION_REGISTRY:executionRegistry}});}catch(error){consumer.closeAllConnections();await new Promise(resolve=>consumer.close(resolve));throw error;}
  const tokens={alice:f.aliceToken,bob:f.bobToken};
  const dispatch=(path,init={},actor='alice')=>fetch(f.origin+path,{...init,headers:{authorization:'Bearer '+tokens[actor],...Object.fromEntries(new Headers(init.headers))},redirect:'manual'});
  const request=async(path,body,actor='alice',headers={})=>{
    if(body?.params?.delivery && callbacks[body.params.delivery.url]) {
      body=structuredClone(body);body.params.delivery.url=callbackOrigin+new URL(body.params.delivery.url).pathname;
    }
    const response=await dispatch(path,{method:body===undefined?'GET':'POST',headers:{origin:f.origin,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})},actor);
    return {status:response.status,body:await response.json()};
  };
  const rpc=async(name,args,actor='alice')=>{const response=await request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args??{}}},actor);assert.equal(response.status,200);return response.body;};
  function delayedDatabase(db,gate){
    function statement(inner){return new Proxy(inner,{get(target,key){
      if(key==='bind')return(...args)=>statement(target.bind(...args));
      if(key==='all')return async(...args)=>{const result=await target.all(...args);if(!gate.paused&&result.results.some(row=>'delivery_token'in row&&'attempts'in row)){gate.paused=true;await gate.released;}return result;};
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});}
    return new Proxy(db,{get(target,key){if(key==='prepare')return query=>statement(target.prepare(query));const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  }
  return {...f,callbackOrigin,dispatch,request,rpc,scheduled:()=>scheduledPlanning(f.db),restart:async()=>{await f.stop();await f.start();},
    engine:async(operation,id,owner)=>{
      assert.ok(engineHarness,'Direct domain access must be explicitly enabled');
      if(operation==='pause-state')return {paused:gates.get(id)?.paused??false};
      if(operation==='resume'){gates.get(id)?.release();return {};}
      if(operation==='delayed-due'){
        const gate={paused:false};gate.released=new Promise(resolve=>{gate.release=resolve;});gates.set(id,gate);
        try{await deliverDue(delayedDatabase(f.db,gate),owner,id);return {};}finally{gates.delete(id);}
      }
      if(operation==='due'){await deliverDue(f.db,owner,id);return {};}
      if(operation==='deliver'){await discoverDeliveries(f.db,owner,id);await deliverDue(f.db,owner,id);return {};}
      if(operation==='retry')return retryPlanningJob(id,owner,f.db);
      const job=await f.db.prepare('SELECT * FROM jobs WHERE id=? AND owner=?').bind(id,owner).first();return job?planningMetadata(job,f.db):null;
    },close:async()=>{for(const gate of gates.values())gate.release();await f.close();consumer.closeAllConnections();await new Promise(resolve=>consumer.close(resolve));assert.deepEqual(errors,[],'Loopback consumer assertions');}};
}
