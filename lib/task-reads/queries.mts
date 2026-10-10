import type { ExecutionDatabase } from '../execution/types.mts';
import type { RecordRow } from '../types';
import { ExecutionError } from '../execution/errors.mts';
import { decodeCursor, makePage, type CursorContext } from './cursor.mts';
import { historyDTO, recordBody, recordDTO } from './dto.mts';
import { nestedPageBudget, type TaskReadOptions } from './bounds.mts';
import type { ListInput } from './validation.mts';
export async function ownedRecord(db: ExecutionDatabase, owner: string, kind: string, id: unknown, project?: string): Promise<RecordRow | null> {
  if (typeof id !== 'string' || !id) return null;
  return db.prepare(`SELECT * FROM records WHERE owner=? AND kind=? AND id=? ${project === undefined ? '' : "AND COALESCE(NULLIF(json_extract(body,'$.project'),''),'通用')=?"}`).bind(owner, kind, id, ...(project === undefined ? [] : [project])).first<RecordRow>();
}
export async function requireRecord(db: ExecutionDatabase, owner: string, kind: 'ticket' | 'plan', id: string, project?: string): Promise<RecordRow> {
  const row = await ownedRecord(db, owner, kind, id, project);
  if (!row) throw new ExecutionError('NOT_FOUND', kind === 'ticket' ? 'Ticket not found' : 'Plan not found', 404);
  return row;
}
export async function listRecords(db: ExecutionDatabase, owner: string, kind: 'ticket' | 'plan', input: ListInput, options: TaskReadOptions = {}) {
  const { project, byteBudget } = options;
  const context: CursorContext = { owner, resource: kind === 'ticket' ? 'tickets' : 'plans', filters: {...input.filters, ...(project === undefined ? {} : {project})} };
  const cursor = await decodeCursor(input.cursor, context);
  const clauses = ['r.owner=?', 'r.kind=?'];
  const params: (string | number)[] = [owner, kind];
  if (project !== undefined) { clauses.push("COALESCE(NULLIF(json_extract(r.body,'$.project'),''),'通用')=?"); params.push(project); }
  for (const [key, field] of [['project', 'project'], ['status', 'status'], ['priority', 'priority'], ['plan_id', 'planId']] as const) {
    if (key === 'project' && project !== undefined) continue;
    if (key in input.filters) { clauses.push(`json_type(r.body,'$.${field}')='text' AND json_extract(r.body,'$.${field}')=?`); params.push(input.filters[key]); }
  }
  if ('idea_id' in input.filters) {
    // An owned Plan wins even when its Idea is missing. COALESCE would wrongly fall back.
    if (kind === 'ticket') {
      clauses.push(`CASE WHEN json_type(r.body,'$.planId')='text' AND EXISTS(SELECT 1 FROM records p WHERE p.owner=? AND p.kind='plan' AND p.id=json_extract(r.body,'$.planId'))
        THEN (SELECT json_extract(p.body,'$.ideaId') FROM records p WHERE p.owner=? AND p.kind='plan' AND p.id=json_extract(r.body,'$.planId') AND json_type(p.body,'$.ideaId')='text')
        ELSE CASE WHEN json_type(r.body,'$.ideaId')='text' THEN json_extract(r.body,'$.ideaId') END END = ?`);
      params.push(owner, owner, input.filters.idea_id);
    } else { clauses.push("json_type(r.body,'$.ideaId')='text' AND json_extract(r.body,'$.ideaId')=?"); params.push(input.filters.idea_id); }
  }
  if (cursor) { clauses.push('(r.created < ? OR (r.created = ? AND r.id < ?))'); params.push(cursor.created, cursor.created, cursor.id); }
  const result = await db.prepare(`SELECT r.* FROM records r WHERE ${clauses.join(' AND ')} ORDER BY r.created DESC,r.id DESC LIMIT ?`).bind(...params, input.limit + 1).all<RecordRow>();
  return makePage(result.results, input.limit, context, recordDTO, byteBudget);
}
async function ideaContext(db: ExecutionDatabase, owner: string, body: Record<string, unknown>, project?: string) {
  const ideaId = typeof body.ideaId === 'string' && body.ideaId ? body.ideaId : null;
  const sourceRevision = typeof body.ideaRevision === 'number' && Number.isSafeInteger(body.ideaRevision) && body.ideaRevision > 0 ? body.ideaRevision : null;
  const idea = await ownedRecord(db, owner, 'idea', ideaId, project);
  let sourceIdea: ReturnType<typeof recordDTO> | ReturnType<typeof historyDTO> | null = null;
  if (idea && sourceRevision !== null) {
    if (idea.revision === sourceRevision) sourceIdea = recordDTO(idea);
    else {
      const history = await db.prepare(`SELECT * FROM records WHERE owner=? AND kind='history'
        AND json_type(body,'$.recordId')='text' AND json_extract(body,'$.recordId')=?
        AND json_type(body,'$.recordKind')='text' AND json_extract(body,'$.recordKind')='idea'
        AND json_extract(body,'$.previousRevision')=? ORDER BY created DESC,id DESC LIMIT 1`).bind(owner, idea.id, sourceRevision).first<RecordRow>();
      if (history) {
        const snapshot = historyDTO(history, idea.id, sourceRevision);
        if (project === undefined || ((snapshot as Record<string, unknown> | null)?.project || '通用') === project) sourceIdea = snapshot;
      }
    }
  }
  return { idea: idea ? recordDTO(idea) : null, source_idea: sourceIdea,
    linkage: { source_idea_revision: sourceRevision, current_idea_revision: idea?.revision ?? null,
      superseded: idea !== null && sourceRevision !== null && idea.revision !== sourceRevision,
      idea_missing: ideaId !== null && idea === null, source_idea_missing: sourceRevision !== null && sourceIdea === null } };
}
/** Owned current Ticket and the original Idea revision that informed its Plan. */
export async function getTicket(db: ExecutionDatabase, owner: string, id: string, project?: string) {
  const ticket = await requireRecord(db, owner, 'ticket', id, project);
  const body = recordBody(ticket);
  const plan = await ownedRecord(db, owner, 'plan', body.planId, project);
  const context = await ideaContext(db, owner, plan ? recordBody(plan) : body, project);
  return { ticket: recordDTO(ticket), plan: plan ? recordDTO(plan) : null, ...context,
    linkage: { ...context.linkage, plan_missing: typeof body.planId === 'string' && !!body.planId && plan === null } };
}
export async function getPlan(db: ExecutionDatabase, owner: string, id: string, options: TaskReadOptions = {}) {
  const { project, byteBudget } = options;
  const plan = await requireRecord(db, owner, 'plan', id, project);
  const base = { plan: recordDTO(plan), ...await ideaContext(db, owner, recordBody(plan), project) };
  return { ...base, tickets: await listRecords(db, owner, 'ticket', { filters: { plan_id: id }, limit: 20 },
    { project, byteBudget: nestedPageBudget(base, 'tickets', byteBudget) }) };
}
