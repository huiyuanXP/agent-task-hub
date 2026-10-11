import type { Row } from '../types.ts';
import type { WorkspaceRun } from '../workspace-runs/types.mts';
import type { Run } from '../execution/types.mts';

export type TicketStatus = 'todo'|'running'|'waiting'|'done'|'error';
export type TicketSort = { field:'priority'|'created'|'updated'; direction:'asc'|'desc' };
export const defaultTicketSort:TicketSort={field:'created',direction:'desc'};
const idOrder=(a:Row,b:Row)=>a.id<b.id?-1:a.id>b.id?1:0;
function timeOrder(a:string,b:string,direction:'asc'|'desc') {
 const left=Date.parse(a),right=Date.parse(b),lv=Number.isFinite(left),rv=Number.isFinite(right);
 if(lv!==rv)return lv?-1:1;if(!lv)return 0;
 return (left-right)*(direction==='asc'?1:-1);
}
export function sortTickets(rows:readonly Row[],sort:TicketSort=defaultTicketSort):Row[] {
 return [...rows].sort((a,b)=>{
  if(sort.field!=='priority')return timeOrder(a[sort.field],b[sort.field],sort.direction)||idOrder(a,b);
  const ranks=['P0','P1','P2','P3'],left=ranks.indexOf(a.priority??''),right=ranks.indexOf(b.priority??'');
  if((left<0)!==(right<0))return left<0?1:-1;
  return (left>=0 && right>=0?(left-right)*(sort.direction==='asc'?1:-1):0)||timeOrder(a.created,b.created,'desc')||idOrder(a,b);
 });
}
export function filterTickets(rows:readonly Row[],input:{project?:string;query?:string;status?:string}={}):Row[] {
 const query=input.query?.trim().toLocaleLowerCase()??'';
 return rows.filter(row=>row.kind==='ticket' && (!input.project||input.project==='全部项目'||(row.project||'通用')===input.project)
  && (!input.status||input.status==='all'||input.status==='全部状态'||row.status===input.status)
  && (!query||[row.title,row.text,row.goal,row.project,row.id,row.planId,row.ideaId,row.scope,row.notes].some(value=>value?.toLocaleLowerCase().includes(query))));
}
export const isActiveWorkspaceRun=(run:Pick<WorkspaceRun,'state'>)=>['pending','approved','running','review'].includes(run.state);
export const isActiveDockerRun=(run:Pick<Run,'state'>)=>['queued','running','waiting'].includes(run.state);
export function ticketExecutionContext(ticket:Row,workspaceRuns:readonly WorkspaceRun[],dockerRuns:readonly Run[]) {
 const same=(id:string,revision:number,project:string)=>id===ticket.id&&revision===ticket.revision&&project===(ticket.project||'通用');
 const currentWorkspace=workspaceRuns.filter(r=>same(r.ticketId,r.revision,r.project));
 const currentDocker=dockerRuns.filter(r=>same(r.ticketId,r.ticketRevision,JSON.parse(r.ticketBody).project||'通用'));
 return {currentWorkspace,currentDocker,
  historicalWorkspace:workspaceRuns.filter(r=>r.ticketId===ticket.id&&!currentWorkspace.includes(r)),
  historicalDocker:dockerRuns.filter(r=>r.ticketId===ticket.id&&!currentDocker.includes(r)),
  // An old-revision active Run still occupies the Ticket; never offer a replacement.
  activeWorkspace:workspaceRuns.find(r=>r.ticketId===ticket.id&&isActiveWorkspaceRun(r))??null,
  activeDocker:dockerRuns.find(r=>r.ticketId===ticket.id&&isActiveDockerRun(r))??null};
}
export type TicketAction =
 |{type:'no-op'}|{type:'completed-info';reason:string}|{type:'open-execution';ticketId:string;revision:number}
 |{type:'open-review';runId:string}|{type:'open-status';status:'todo'|'waiting'|'error'}
 |{type:'open-active';backend:'workspace'|'docker';runId:string;reason:string};
export function resolveTicketAction(ticket:Row,target:string|null,workspaceRuns:readonly WorkspaceRun[]=[],dockerRuns:readonly Run[]=[]):TicketAction {
 if(!target||!['todo','running','waiting','done','error'].includes(target)||target===ticket.status)return {type:'no-op'};
 if(ticket.status==='done')return {type:'completed-info',reason:'此 Ticket 已完成；查看完成证据，返工请使用已有明确入口。'};
 const context=ticketExecutionContext(ticket,workspaceRuns,dockerRuns);
 const review=context.currentWorkspace.find(r=>r.state==='review');
 if(target==='done'&&review)return {type:'open-review',runId:review.id};
 if(context.activeWorkspace)return {type:'open-active',backend:'workspace',runId:context.activeWorkspace.id,reason:'此 Ticket 有活动开发 Run，请使用其批准、取消或验收操作。'};
 if(context.activeDocker)return {type:'open-active',backend:'docker',runId:context.activeDocker.id,reason:'此 Ticket 有活动 Docker Run，请查看授权与实际停止状态。'};
 if(target==='running')return {type:'open-execution',ticketId:ticket.id,revision:ticket.revision};
 if(target==='done')return {type:'completed-info',reason:'当前修订没有待验收的开发结果；Docker 成功和手工记录不代表开发已验收。'};
 return {type:'open-status',status:target as 'todo'|'waiting'|'error'};
}
