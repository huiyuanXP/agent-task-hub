import type { LocalDatabase } from '../database.mts';
import type { ConnectorPrincipal,OwnerAction,PrepareInput } from './types.mts';
import { claimWorkspaceRun,completeWorkspaceRun,decideWorkspaceRun,eventWorkspaceRun,failWorkspaceRun,getWorkspaceRun,listWorkspaceRuns,prepareWorkspaceRun,renewWorkspaceRun } from './service.mts';
import { integer,invalid,object,text,WorkspaceError } from './validation.mts';

const headers={'Cache-Control':'no-store'};
export async function readWorkspaceBody(request:Request,max=16384):Promise<unknown> {
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new WorkspaceError(415,'JSON required','UNSUPPORTED_MEDIA');
 const length=request.headers.get('content-length');
 if(length!==null){if(!/^\d+$/.test(length))invalid('Invalid Content-Length');if(Number(length)>max)throw new WorkspaceError(413,'Request body too large','BODY_TOO_LARGE');}
 if(!request.body)invalid('JSON body required');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try {while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw new WorkspaceError(413,'Request body too large','BODY_TOO_LARGE');}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{invalid('Malformed JSON');}
}
export function workspaceErrorResponse(error:unknown):Response {
 if(error instanceof WorkspaceError)return Response.json({error:error.message,code:error.code},{status:error.status,headers});
 console.error('Workspace Run storage unavailable');return Response.json({error:'Workspace Run storage unavailable'},{status:503,headers});
}
function queryNumber(value:string|null,min:number,max:number,label:string) {
 if(value===null || !/^\d+$/.test(value))invalid(`Invalid ${label}`);const result=Number(value);integer(result,min,max,label);return result;
}
/** Trusted browser identity remains separate from the machine adapter below. */
export async function handleWorkspaceRequest(db:LocalDatabase,owner:string|null,request:Request):Promise<Response> {
 if(!owner)return Response.json({error:'Authentication required'},{status:401,headers});
 try {
  if(request.method==='GET'){
   const query=new URL(request.url).searchParams,keys=[...query.keys()];
   if(new Set(keys).size!==keys.length || keys.some(key=>!['runId','ticketId','limit','cursor','eventAfter','eventLimit'].includes(key)))invalid('Invalid query');
   const eventAfter=query.has('eventAfter')?queryNumber(query.get('eventAfter'),0,Number.MAX_SAFE_INTEGER,'event cursor'):0;
   const eventLimit=query.has('eventLimit')?queryNumber(query.get('eventLimit'),1,500,'event limit'):200;
   if(query.has('runId')){
    if(keys.some(key=>!['runId','eventAfter','eventLimit'].includes(key)))invalid('Run ID cannot be combined with list filters');
    return Response.json({run:await getWorkspaceRun(db,owner,query.get('runId')!,eventAfter,eventLimit)},{headers});
   }
   return Response.json(await listWorkspaceRuns(db,owner,{...(query.has('ticketId')?{ticketId:query.get('ticketId')!}:{}),
    ...(query.has('limit')?{limit:queryNumber(query.get('limit'),1,100,'limit')}:{}),...(query.has('cursor')?{cursor:query.get('cursor')!}:{}),eventAfter,eventLimit}),{headers});
  }
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405,headers:{...headers,Allow:'GET, POST'}});
  if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid request origin'},{status:403,headers});
  const input=await readWorkspaceBody(request);object(input,['action','ticketId','revision','connectionId','requestId','timeoutMs','runId']);
  if(input.action==='prepare'){
   object(input,['action','ticketId','revision','connectionId','requestId','timeoutMs']);const copied={...input};delete copied.action;
   return Response.json({run:await prepareWorkspaceRun(db,owner,copied as unknown as PrepareInput)},{headers});
  }
  object(input,['action','runId']);text(input.runId);
  if(typeof input.action!=='string' || !['approve','reject','cancel','accept','rework'].includes(input.action))invalid('Unknown owner action');
  return Response.json({run:await decideWorkspaceRun(db,owner,input.runId,input.action as OwnerAction)},{headers});
 }catch(error){return workspaceErrorResponse(error);}
}
export async function handleWorkspaceAgentRequest(db:LocalDatabase,principal:ConnectorPrincipal,request:Request):Promise<Response> {
 try {
  if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405,headers:{...headers,Allow:'POST'}});
  const input=await readWorkspaceBody(request,1048576);object(input,['action','runId','leaseToken','eventId','stage','message','result','error']);
  if(input.action==='claim'){object(input,['action']);return Response.json(await claimWorkspaceRun(db,principal),{headers});}
  text(input.runId);text(input.leaseToken,200,'lease token');
  if(input.action==='renew'){
   object(input,['action','runId','leaseToken']);return Response.json(await renewWorkspaceRun(db,principal,input.runId,input.leaseToken),{headers});
  }
  if(input.action==='event'){
   object(input,['action','runId','leaseToken','eventId','stage','message']);
   return Response.json(await eventWorkspaceRun(db,principal,input.runId,input.leaseToken,{eventId:input.eventId as string,stage:input.stage as string,message:input.message as string}),{headers});
  }
  if(input.action==='complete'){
   object(input,['action','runId','leaseToken','result']);return Response.json(await completeWorkspaceRun(db,principal,input.runId,input.leaseToken,input.result),{headers});
  }
  if(input.action==='fail'){
   object(input,['action','runId','leaseToken','error']);return Response.json(await failWorkspaceRun(db,principal,input.runId,input.leaseToken,input.error as string),{headers});
  }
  invalid('Unknown machine action');
 }catch(error){return workspaceErrorResponse(error);}
}
