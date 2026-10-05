import { createServer } from 'node:http';
import { openJournal } from './journal.mjs';
import { registryConfiguration } from './registry.mjs';
import { createExecutor } from './executor.mjs';
import { ReplayWindow, signReply, verifyRequest } from '../lib/execution/transport.mts';
import { request as dockerRequest } from './docker.mjs';
import { MAX_PERMIT_BYTES } from '../lib/execution/registry.mts';
import { exactObject } from '../lib/execution/errors.mts';
export async function startSupervisor(config) {
  const registry=registryConfiguration(config.registry,config.sourceRoots);
  if(!config.controlTrust||!config.transportKey||!config.evidenceKey||!config.checkpoint||typeof config.audience!=='string')throw Error('Supervisor signing configuration required');
  const journal=await openJournal(config.root);let executor;
  try{executor=await createExecutor(journal,config,registry);}catch(e){await journal.release();throw e;}
  const replay=new ReplayWindow();let active=0;
  const server=createServer(async(req,res)=>{
    let request;
    async function respond(status,data){const body=JSON.stringify(data);const headers={'content-type':'application/json','cache-control':'no-store'};if(request)headers['x-execution-signature']=JSON.stringify(await signReply(config.transportKey,request,status,body));res.writeHead(status,headers);res.end(body);}
    if(++active>32){active--;await respond(503,{error:'Request capacity unavailable'});return;}
    try{
      if(req.method!=='POST'||!['/health','/start','/result','/cancel','/content'].includes(req.url)){await respond(404,{error:'Unknown endpoint'});return;}
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_PERMIT_BYTES)throw Object.assign(Error('Request size exceeded'),{status:413});chunks.push(chunk);}
      const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      let signed;try{signed=JSON.parse(req.headers['x-execution-signature']??'null');}catch{signed=null;}
      if(!await verifyRequest(signed,config.controlTrust,{direction:'control-to-runner',audience:config.audience,method:req.method,path:req.url,body})||!replay.accept(signed.claims.nonce,signed.claims.expiresAt)){await respond(401,{error:'Transport authentication required'});return;}
      request=signed;journal.assertAvailable();const payload=JSON.parse(body);exactObject(payload,req.url==='/health'?[]:req.url==='/content'?['permit','kind','path']:['permit']);
      if(req.url==='/health'){await dockerRequest('GET','/info',{timeoutMs:1500});await respond(200,{configured:true,backend:'local-docker',registryVersion:1});return;}
      const action=req.url.slice(1);const value=action==='content'?await executor.content(payload.permit,payload.kind,payload.path):await executor[action](payload.permit);
      await respond(action==='start'?202:200,value);
    }catch(error){await respond(error.status??400,{error:error.status===503?'Execution unavailable':'Execution request rejected'});}finally{active--;}
  });
  server.requestTimeout=5000;server.headersTimeout=5000;server.timeout=5000;server.maxConnections=64;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port??0,'127.0.0.1',resolve);});}catch(error){try{await executor.close();}finally{await journal.release();}throw error;}
  let closed=false;
  return {url:`http://127.0.0.1:${server.address().port}`,async close(){if(closed)return;closed=true;await new Promise(r=>server.close(r));try{await executor.close();}finally{await journal.release();}}};
}
