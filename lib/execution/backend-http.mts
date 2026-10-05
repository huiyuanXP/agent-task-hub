import type { ExecutionDatabase } from './types.mts';
import type { AuthorizationContext } from './authorization-types.mts';
import type { DispatchPermit } from './dispatch-types.mts';
import type { BackendAttestation } from './attestations.mts';
import { backendConfiguration, importSigning, importTrust, configuredRegistry, assertDistinctKeyMaterial, type BackendEnvironment } from './backend-config.mts';
import { boundedText, ReplayWindow, signReply, signedFetch, verifyRequest, type Signed, type TransportClaims } from './transport.mts';
import { checkpointPermit, createDispatchPermit, permitForRun, requestPermitCancellation } from './dispatch.mts';
import { ingestAttestation } from './attestations.mts';
import { getRun, transitionRun } from './runs.mts';
import { readBody } from './http.mts';
import { boundedId, exactObject, ExecutionError, invalid } from './errors.mts';
const headers={'Cache-Control':'private, no-store'};
const replay=new ReplayWindow(4096);
/** This endpoint is an independent service principal, never an owner authentication bypass. */
export async function handleCheckpoint(request:Request,env:BackendEnvironment):Promise<Response>{
  if(request.method!=='POST'||new URL(request.url).pathname!=='/api/execution/checkpoint'||new URL(request.url).search)return Response.json({error:'Not found'},{status:404,headers});
  let signing,trust;try{assertDistinctKeyMaterial(env.EXECUTION_CONTROL_KEY,env.EXECUTION_RUNNER_KEY);[signing,trust]=await Promise.all([importSigning(env.EXECUTION_CONTROL_KEY),importTrust(env.EXECUTION_RUNNER_KEY)]);if(!env.EXECUTION_CHECKPOINT_AUDIENCE)throw Error();}catch{return Response.json({error:'Execution unavailable'},{status:503,headers});}
  let signed:Signed<TransportClaims>,body:string;
  try{body=await boundedText(new Response(request.body),16384);signed=JSON.parse(request.headers.get('x-execution-signature')??'null');
    if(!await verifyRequest(signed,trust,{direction:'runner-to-control',audience:env.EXECUTION_CHECKPOINT_AUDIENCE!,method:'POST',path:'/api/execution/checkpoint',body})||!replay.accept(signed.claims.nonce,signed.claims.expiresAt))throw Error();
  }catch{return Response.json({error:'Service authentication required'},{status:401,headers});}
  let status=200,data:unknown;
  try{const input=JSON.parse(body);exactObject(input,['permitId','permitSha256','deadlineMs']);boundedId(input.permitId);if(typeof input.permitSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.permitSha256))invalid();
    if(!env.DB)throw Error();data=await checkpointPermit(env.DB,{permitId:input.permitId,permitSha256:input.permitSha256});
  }catch{status=503;data={error:'Checkpoint unavailable'};}
  const text=JSON.stringify(data);return new Response(text,{status,headers:{...headers,'Content-Type':'application/json','x-execution-signature':JSON.stringify(await signReply(signing,signed,status,text))}});
}
export async function reconcileBackend(db:ExecutionDatabase,context:AuthorizationContext,env:BackendEnvironment,runId:string){
  const run=await getRun(db,context.owner,runId);const p=await permitForRun(db,context.owner,runId);
  if(!p)return {run,backend:null};
  const config=await backendConfiguration(env),permit=JSON.parse(p.envelope) as DispatchPermit;
  if(p.cancel_requested&&!p.closed_at){const cancel=await signedFetch(config.transport,'/cancel',{permit});if(cancel.status!==200)throw Error('Cancellation transport unavailable');for(const receipt of (cancel.data as {receipts:BackendAttestation[]}).receipts)await ingestAttestation(db,{...context,evidenceTrust:config.evidenceTrust},receipt);}
  const response=await signedFetch(config.transport,'/result',{permit});
  if(response.status===404)return {run:await getRun(db,context.owner,runId),backend:{phase:'dispatch_pending',receipts:[]}};
  if(response.status!==200)throw Error('Backend unavailable');
  const result=response.data as {backendId:string;phase:string;receipts:BackendAttestation[]};
  if(!Array.isArray(result.receipts)||result.receipts.length>3)throw Error('Invalid backend result');
  for(const receipt of result.receipts)await ingestAttestation(db,{...context,evidenceTrust:config.evidenceTrust},receipt);
  if(result.phase==='running'){
    const current=await getRun(db,context.owner,runId);if(['queued','waiting'].includes(current.state)){try{await transitionRun(db,context,{id:runId,expectedVersion:current.version,to:'running'});}catch(error){if(!(error instanceof ExecutionError)||error.code!=='TRANSITION_CONFLICT')throw error;}}
  }
  return {run:await getRun(db,context.owner,runId),backend:result};
}
export async function handleBackendRequest(db:ExecutionDatabase,context:AuthorizationContext|null,request:Request,env:BackendEnvironment):Promise<Response>{
  if(!context)return Response.json({error:'Authentication required'},{status:401,headers});
  try{
    if(request.method==='GET'){
      configuredRegistry(env);const config=await backendConfiguration(env);
      const q=new URL(request.url).searchParams;if([...q.keys()].length===0){const result=await signedFetch(config.transport,'/health',{});if(result.status!==200)throw Error();return Response.json(result.data,{headers});}
      if([...q.keys()].length!==1||!q.has('runId'))invalid();return Response.json(await reconcileBackend(db,context,env,q.get('runId')!),{headers});
    }
    if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405,headers});
    if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid request origin'},{status:403,headers});
    const input=await readBody(request);exactObject(input,['action','runId','kind','path']);boundedId(input.runId);
    if(input.action==='start'){
      exactObject(input,['action','runId']);context={...context,registry:configuredRegistry(env)};const config=await backendConfiguration(env);const permit=await createDispatchPermit(db,context,input.runId);
      // A retry keeps the immutable permit/deadline; a persisted cancel intent
      // sends a fence instead of attempting another start.
      const row=await permitForRun(db,context.owner,input.runId);if(row?.cancel_requested)return Response.json(await reconcileBackend(db,context,env,input.runId),{headers});
      const result=await signedFetch(config.transport,'/start',{permit});if(result.status!==202)throw new ExecutionError('DISPATCH_CONFLICT','Backend rejected the persisted dispatch',409);
      return Response.json({run:await getRun(db,context.owner,input.runId),backend:result.data},{status:202,headers});
    }
    if(input.action==='cancel'){
      exactObject(input,['action','runId']);const run=await getRun(db,context.owner,input.runId);if(['queued','running','waiting'].includes(run.state))await transitionRun(db,context,{id:run.id,expectedVersion:run.version,to:'cancelled'});
      await requestPermitCancellation(db,context.owner,input.runId);
      return Response.json(await reconcileBackend(db,context,env,input.runId),{headers});
    }
    if(input.action==='content'){
      const config=await backendConfiguration(env);
      const p=await permitForRun(db,context.owner,input.runId);if(!p)throw new ExecutionError('NOT_FOUND','Dispatched Run not found',404);
      await reconcileBackend(db,context,env,input.runId);
      const row=await db.prepare("SELECT receipt FROM backend_attestations WHERE permit_id=? AND owner=? AND purpose='result'").bind(p.id,context.owner).first<{receipt:string}>();
      if(!row)throw new ExecutionError('NOT_FOUND','Trusted result unavailable',404);
      const receipt=JSON.parse(row.receipt) as BackendAttestation;const c=receipt.claims;let expected;
      if(input.kind==='stdout'||input.kind==='stderr'){if(input.path!==undefined)invalid();expected=c[input.kind];}
      else if(input.kind==='artifact'&&typeof input.path==='string')expected=c.artifacts.find(a=>a.path===input.path);
      else invalid();
      if(!expected)throw new ExecutionError('NOT_FOUND','Declared retained content unavailable',404);
      const result=await signedFetch(config.transport,'/content',{permit:JSON.parse(p.envelope),kind:input.kind,...(input.path!==undefined?{path:input.path}:{})},1500000);
      if(result.status!==200)throw Error('Retained content unavailable');const data=result.data as {base64:string};
      const bytes=Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0));const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      if(bytes.length!==expected.bytes||digest!==expected.sha256)throw Error('Content verification failed');
      return new Response(bytes,{headers:{...headers,'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="execution-result.bin"','X-Content-SHA256':digest}});
    }
    invalid('Unknown execution action');
  }catch(error){if(error instanceof ExecutionError)return Response.json({error:error.message,code:error.code},{status:error.status,headers});return Response.json({error:'Execution backend unavailable'},{status:503,headers});}
}
