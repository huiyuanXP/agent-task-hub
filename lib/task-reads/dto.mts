import type { RecordRow } from '../types';
const bodyFields = ['title', 'text', 'project', 'priority', 'status', 'goal', 'scope', 'acceptance', 'dependencies', 'queue', 'budget', 'allowedActions', 'assumptions', 'category', 'cadence', 'waitingReason', 'evidence', 'notes', 'ideaId', 'ideaRevision', 'planId', 'ticketId', 'ticketRevision', 'source', 'logicalKey'] as const;
export function recordBody(row: Pick<RecordRow, 'body'>): Record<string, unknown> {
  const body: unknown = JSON.parse(row.body);
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}
/** Known body fields contain user data only; metadata always comes from the row. */
export function safeBody(body: Record<string, unknown>): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  for (const key of bodyFields) {
    const value = body[key];
    if (key === 'source') { if (value === 'manual' || value === 'agent') safe[key] = value; }
    else if (key === 'ideaRevision' || key === 'ticketRevision') { if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) safe[key] = value; }
    else if (typeof value === 'string') safe[key] = value;
  }
  return safe;
}
export function recordDTO(row: RecordRow) {
  return { ...safeBody(recordBody(row)), id: row.id, kind: row.kind, revision: row.revision, created: row.created, updated: row.updated };
}
export function historyDTO(row: RecordRow, id: string, revision: number) {
  const snapshot = recordBody(row).snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return { ...safeBody(snapshot as Record<string, unknown>), id, revision, snapshot_saved_at: row.created };
}
