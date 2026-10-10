import type { LocalDatabase } from '../database.mts';
import { AuthError } from '../local-auth.mts';
import { ExecutionError } from '../execution/errors.mts';
import { taskReadTools, dispatchTaskReadTool } from '../task-reads/mcp.mts';
import type { TrustedRegistry } from '../task-reads/runs.mts';
import { authenticateConnector, connectorInput, recordConnectorUse, type ConnectorPrincipal } from './service.mts';
import { boundedMCPResponse as connectorResponse } from '../task-reads/bounds.mts';
import { connectorJSON } from './http.mts';
import { planningTools, connectorWriteTools, dispatchPlanningTool } from './planning.mts';

function permitted(principal:ConnectorPrincipal,name:string) {
 const caps=name==='create_idea'||name==='create_ticket'?['submit']:name==='get_idea'||name==='list_planning_jobs'?['read','plan']:taskReadTools.some(t=>t.name===name)?['read']:['plan'];
 return caps.some(cap=>principal.capabilities.includes(cap));
}
export function scopedConnectorTools(principal:ConnectorPrincipal) {
 return [...planningTools,...connectorWriteTools,...taskReadTools].filter(tool=>permitted(principal,tool.name));
}
export async function handleConnectorMCP(db:LocalDatabase,req:Request,registry:TrustedRegistry=()=>[]) {
 let id:string|number|null=null;
 const rpcError=(code:number,message:string,status=200)=>connectorResponse({jsonrpc:'2.0',id,error:{code,message}},status);
 try {
  const principal=await authenticateConnector(db,req.headers);
  const rpc=await connectorJSON(req);
  connectorInput(rpc,['jsonrpc','id','method','params']);
  if(rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string'||(rpc.id!==undefined&&rpc.id!==null&&typeof rpc.id!=='string'&&typeof rpc.id!=='number'))return rpcError(-32600,'Invalid JSON-RPC request',400);
  id=rpc.id as string|number|null??null;
  const params=rpc.params??{};connectorInput(params,['name','arguments','protocolVersion','capabilities','clientInfo']);
  const respond=(result:unknown)=>connectorResponse({jsonrpc:'2.0',id,result});
  if(rpc.method==='notifications/initialized')return new Response(null,{status:202,headers:{'Cache-Control':'private, no-store'}});
  if(rpc.method==='initialize')return respond({protocolVersion:params.protocolVersion==='2026-07-28'?'2026-07-28':params.protocolVersion==='2025-11-25'?'2025-11-25':'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'agent-task-hub-connector',version:'0.1.0'}});
  if(rpc.method==='ping')return respond({});
  if(rpc.method==='tools/list')return respond({tools:scopedConnectorTools(principal)});
  if(rpc.method!=='tools/call')return rpcError(-32601,'Method not found');
  if(typeof params.name!=='string'||!scopedConnectorTools(principal).some(t=>t.name===params.name))return rpcError(-32602,'Tool unavailable for this connector');
  await recordConnectorUse(db,principal);
  try {
   let result=await dispatchPlanningTool(db,principal.owner,params.name,params.arguments,principal);
   if(result===undefined)result=await dispatchTaskReadTool(db,principal.owner,params.name,params.arguments,registry,{project:principal.project});
   if(result===undefined)return rpcError(-32602,'Unknown tool');
   return respond({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});
  }catch(error){
   if(error instanceof AuthError&&error.status===401)return rpcError(-32001,error.message,401);
   const message=error instanceof AuthError||error instanceof ExecutionError?error.message:'Connector tool unavailable';
   return respond({content:[{type:'text',text:message}],isError:true});
  }
 }catch(error){
  if(error instanceof AuthError)return rpcError(error.status===401?-32001:-32602,error.message,error.status);
  return rpcError(-32603,'Connector service unavailable',503);
 }
}
