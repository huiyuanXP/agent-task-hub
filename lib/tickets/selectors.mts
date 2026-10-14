import type { Row } from '../types.ts';
import type { WorkspaceRun } from '../workspace-runs/types.mts';
import type { Run } from '../execution/types.mts';
import { dependencyKeys, matchDependency } from './dependencies.mts';

export type TicketStatus = 'todo'|'running'|'waiting'|'done'|'error';
export type TicketSort = { field:'recommended'|'priority'|'created'|'updated'; direction:'asc'|'desc' };
export const defaultTicketSort:TicketSort={field:'created',direction:'desc'};
const idOrder=(a:Row,b:Row)=>a.id<b.id?-1:a.id>b.id?1:0;
function timeOrder(a:string,b:string,direction:'asc'|'desc') {
 const left=Date.parse(a),right=Date.parse(b),lv=Number.isFinite(left),rv=Number.isFinite(right);
 if(lv!==rv)return lv?-1:1;if(!lv)return 0;
 return (left-right)*(direction==='asc'?1:-1);
}
const priorityRank=(row:Row)=>{const rank=['P0','P1','P2','P3'].indexOf(row.priority??'');return rank<0?4:rank;};
export function sortTickets(rows:readonly Row[],sort:TicketSort=defaultTicketSort,readiness?:ReadonlyMap<string,Readiness>):Row[] {
 if(sort.field==='recommended'){
  const ready=readiness??new Map();
  const rank=(row:Row)=>ready.get(row.id)??{tier:5,blockers:[],unlocks:0};
  return [...rows].sort((a,b)=>{const left=rank(a),right=rank(b);
   return left.tier-right.tier||left.blockers.length-right.blockers.length||right.unlocks-left.unlocks||priorityRank(a)-priorityRank(b)
    ||timeOrder(a.created,b.created,'asc')||idOrder(a,b);});
 }
 const field=sort.field;
 return [...rows].sort((a,b)=>{
  if(field!=='priority')return timeOrder(a[field],b[field],sort.direction)||idOrder(a,b);
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
// Board column derived from the persisted status and the Ticket's real Runs:
// an approved/claimed/delivered development Run or an active Docker Run is in progress,
// the latest current-revision Run failing is an error. Persisted done always wins.
export type BoardState={status:TicketStatus;tag?:string};
export function boardState(ticket:Row,workspaceRuns:readonly WorkspaceRun[],dockerRuns:readonly Run[]):BoardState {
 const persisted=(ticket.status||'todo') as TicketStatus;
 if(persisted==='done')return {status:'done'};
 const runs=workspaceRuns.filter(run=>run.ticketId===ticket.id).sort((a,b)=>b.createdAt-a.createdAt);
 const active=runs.find(run=>isActiveWorkspaceRun(run));
 if(active?.state==='approved')return {status:'running',tag:'已批准，等待 Agent 领取'};
 if(active?.state==='running')return {status:'running',tag:'Agent 开发中'};
 if(active?.state==='review')return {status:'running',tag:'待验收'};
 if(dockerRuns.some(run=>run.ticketId===ticket.id&&isActiveDockerRun(run)))return {status:'running',tag:'Docker 操作运行中'};
 if(active?.state==='pending')return {status:persisted,tag:'开发申请待批准'};
 if(runs[0]?.state==='failed'&&runs[0].revision===ticket.revision)return {status:'error',tag:'开发失败：'+(runs[0].error||'查看执行记录')};
 return {status:persisted};
}
// Deterministic recommendation: tier first, then fewer unmet dependencies, more
// Tickets unblocked, higher priority, older first and ID. No model input is used.
export type Readiness={tier:number;label:string;blockers:string[];unlocks:number};
export function ticketReadiness(tickets:readonly Row[],states:ReadonlyMap<string,BoardState>):Map<string,Readiness> {
 const all=tickets.filter(row=>row.kind==='ticket'),statusOf=(row:Row)=>states.get(row.id)?.status??row.status??'todo';
 const required=new Map<string,string[]>(),unlocks=new Map<string,number>();
 for(const ticket of all){
  const keys=dependencyKeys(ticket.dependencies),blockers:string[]=[];
  if(keys===null)blockers.push('依赖无法识别');
  else for(const key of keys){
   const found=matchDependency(ticket,key,all);
   if(found.length!==1){blockers.push(key+'（未找到）');continue;}
   if(statusOf(found[0])!=='done'){blockers.push(found[0].logicalKey||key);if(statusOf(ticket)!=='done')unlocks.set(found[0].id,(unlocks.get(found[0].id)??0)+1);}
  }
  required.set(ticket.id,blockers);
 }
 return new Map(all.map(ticket=>{
  const status=statusOf(ticket),blockers=required.get(ticket.id)??[],count=unlocks.get(ticket.id)??0;
  const value=status==='done'?{tier:5,label:'已完成',blockers:[]}:status==='running'?{tier:1,label:'进行中',blockers:[]}
   :blockers.length?{tier:3,label:'等待前置：'+blockers.join('、'),blockers}:status==='waiting'?{tier:2,label:'等待处理',blockers}
   :{tier:0,label:'可执行',blockers};
  return [ticket.id,{...value,unlocks:count}];
 }));
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
 if(!target||!['todo','running','waiting','done','error'].includes(target))return {type:'no-op'};
 if(ticket.status==='done')return target==='done'?{type:'no-op'}:{type:'completed-info',reason:'此 Ticket 已完成；查看完成证据，返工请使用已有明确入口。'};
 const context=ticketExecutionContext(ticket,workspaceRuns,dockerRuns);
 const review=context.currentWorkspace.find(r=>r.state==='review');
 if(target==='done'&&review)return {type:'open-review',runId:review.id};
 if(context.activeWorkspace)return {type:'open-active',backend:'workspace',runId:context.activeWorkspace.id,reason:'此 Ticket 有活动开发 Run，请使用其批准、取消或验收操作。'};
 if(context.activeDocker)return {type:'open-active',backend:'docker',runId:context.activeDocker.id,reason:'此 Ticket 有活动 Docker Run，请查看授权与实际停止状态。'};
 if(target===ticket.status)return {type:'no-op'};
 if(target==='running')return {type:'open-execution',ticketId:ticket.id,revision:ticket.revision};
 if(target==='done')return {type:'completed-info',reason:'当前修订没有待验收的开发结果；Docker 成功和手工记录不代表开发已验收。'};
 return {type:'open-status',status:target as 'todo'|'waiting'|'error'};
}
