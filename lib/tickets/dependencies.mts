// Shared Ticket dependency parsing for the claim guard and board recommendations.
// Whole-sentence "no prerequisites" phrasing from planners, e.g. 无、无依赖、无前置依赖、暂无前置任务、none、no dependencies.
// Anything else (including prose that names a Ticket) is resolved as dependency keys and blocks when unresolved.
export const NO_DEPENDENCIES=/^(?:none|n\/a|-|no (?:dependencies|dependency|prerequisites?)|(?:无|暂无|没有|无需|不需要)(?:任何)?(?:前置)?(?:依赖|依赖项|前置任务|前置条件|前置)?(?:项)?)[.。]?$/i;

/** [] means no dependencies; null means an unreadable value or too many keys. */
export function dependencyKeys(raw:unknown):string[]|null {
 if(raw===undefined || raw===null || raw==='' || (typeof raw==='string' && NO_DEPENDENCIES.test(raw.trim())))return [];
 if(typeof raw!=='string')return null;
 const keys=[...new Set(raw.split(/[,，、;；\s]+/).filter(Boolean))];
 return keys.length>100?null:keys;
}

type Candidate={id:string;kind:string;project?:string;planId?:string;logicalKey?:string};
/** Same matching as the claim guard: an exact ID, or a logical key in the same Plan and project. */
export function matchDependency<T extends Candidate>(ticket:Candidate,key:string,rows:readonly T[]):T[] {
 const project=ticket.project||'通用';
 const lookup=(value:string)=>rows.filter(row=>row.kind==='ticket'&&row.id!==ticket.id&&(row.project||'通用')===project
  &&(row.id===value||(row.logicalKey===value&&ticket.planId!==undefined&&row.planId===ticket.planId)));
 const found=lookup(key);
 // Sentence punctuation is optional, but an exact Ticket ID or logical key takes precedence.
 return found.length===0&&/[.。]$/.test(key)?lookup(key.slice(0,-1)):found;
}
