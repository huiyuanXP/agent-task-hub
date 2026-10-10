/** Shared response handling. Inspect identity failures before parsing any private payload. */
export class TicketRequestError extends Error {
 status:number;
 constructor(status:number,message:string){super(message);this.status=status;}
}
export async function ticketResponse(url:string,options:{body?:unknown;onAuthenticationDenied:()=>void;isCurrent?:()=>boolean;fetcher?:typeof fetch}):Promise<Response> {
 const response=await (options.fetcher??fetch)(url,{cache:'no-store',...(options.body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(options.body)})});
 if(options.isCurrent&&!options.isCurrent())throw new TicketRequestError(0,'请求已失效');
 if(response.status===401||response.status===403){
  if(typeof sessionStorage!=='undefined')for(const key of Object.keys(sessionStorage))if(key.startsWith('execution-request:')||key.startsWith('execution-decision:'))sessionStorage.removeItem(key);
  options.onAuthenticationDenied();throw new TicketRequestError(response.status,'登录已失效或无权访问');}
 return response;
}
export async function ticketRequest<T>(url:string,options:Parameters<typeof ticketResponse>[1]):Promise<T> {
 const response=await ticketResponse(url,options);
 const value=await response.json() as T&{error?:string};
 if(!response.ok)throw new TicketRequestError(response.status,value.error||'执行请求失败');
 return value;
}
export async function readTicketWorkspaceRuns<T>(ticketId:string,request:<V>(url:string)=>Promise<V>):Promise<T[]> {
 const runs:T[]=[],seen=new Set<string>();let cursor:string|null=null;
 do {
  const page: {runs:T[];nextCursor:string|null}=await request('/api/workspace-runs?ticketId='+encodeURIComponent(ticketId)+'&limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  runs.push(...page.runs);cursor=page.nextCursor;
  if(cursor){if(seen.has(cursor))throw Error('执行分页游标重复，请刷新');seen.add(cursor);}
 }while(cursor);
 return runs;
}
