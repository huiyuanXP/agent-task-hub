import type { CreateRunInput, ExecutionDatabase, ListRunFilters, Run, RunContext, RunRow, RunState, TransitionRunInput } from './types.mts';
import { boundedId, exactObject, ExecutionError, invalid, positiveInteger } from './errors.mts';
import { isExecutionEvidence, receiptSigningPayload, verifyRunEvidence } from './evidence.mts';

const states: readonly RunState[] = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'];
const edges: Record<RunState, readonly RunState[]> = {
  queued: ['running', 'waiting', 'failed', 'cancelled'],
  running: ['waiting', 'succeeded', 'failed', 'cancelled'],
  waiting: ['queued', 'running', 'failed', 'cancelled'], succeeded: [], failed: [], cancelled: [],
};
function runFromRow(row: RunRow): Run {
  return { id: row.id, owner: row.owner, actor: row.actor, ticketId: row.ticket_id,
    ticketRevision: row.ticket_revision, ticketBody: row.ticket_body, requestId: row.request_id,
    authorizationId: row.authorization_id, attempt: row.attempt, source: row.source,
    state: row.state, version: row.version, evidence: row.evidence ? JSON.parse(row.evidence) : null,
    lastActor: row.last_actor, created: row.created, updated: row.updated };
}
function checkContext(context: RunContext): void { boundedId(context.owner, 256); boundedId(context.actor, 256); }
function checkCreate(input: CreateRunInput): void {
  exactObject(input, ['ticketId', 'expectedRevision', 'requestId', 'authorizationId', 'attempt']);
  boundedId(input.ticketId); boundedId(input.authorizationId); positiveInteger(input.expectedRevision); positiveInteger(input.attempt);
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId)) invalid('Invalid request ID');
}
function sameRequest(row: RunRow, inputKey: string): Run {
  if (row.input_key !== inputKey) throw new ExecutionError('REQUEST_CONFLICT', 'Request ID already used with different input', 409);
  return runFromRow(row);
}
/** A frozen queued model is data, never an effective grant or a dispatch. */
export async function createRun(db: ExecutionDatabase, context: RunContext, input: CreateRunInput): Promise<Run> {
  checkContext(context); checkCreate(input);
  context = { ...context }; input = { ...input };
  const inputKey = JSON.stringify([input.ticketId, input.expectedRevision, input.requestId, input.authorizationId, input.attempt, context.actor]);
  const existing = await db.prepare('SELECT * FROM execution_runs WHERE owner=? AND request_id=?').bind(context.owner, input.requestId).first<RunRow>();
  if (existing) return sameRequest(existing, inputKey);
  const id = crypto.randomUUID(), now = new Date().toISOString();
  // Freeze the current body in the same statement that checks owner/revision and
  // active uniqueness. UNIQUE indexes also guard competing connection inserts.
  await db.prepare(`INSERT OR IGNORE INTO execution_runs
    (id,owner,actor,ticket_id,ticket_revision,ticket_body,request_id,authorization_id,attempt,input_key,last_actor,created,updated)
    SELECT ?,owner,?,id,revision,body,?,?,?,?,?, ?,? FROM records
    WHERE id=? AND owner=? AND kind='ticket' AND revision=?
      AND length(body)<=80000 AND json_valid(body) AND json_type(body)='object'
      AND NOT EXISTS(SELECT 1 FROM execution_runs WHERE owner=? AND ticket_id=? AND state IN ('queued','running','waiting'))`)
    .bind(id, context.actor, input.requestId, input.authorizationId, input.attempt, inputKey, context.actor, now, now,
      input.ticketId, context.owner, input.expectedRevision, context.owner, input.ticketId).run();
  const result = await db.prepare('SELECT * FROM execution_runs WHERE owner=? AND request_id=?').bind(context.owner, input.requestId).first<RunRow>();
  if (result) return sameRequest(result, inputKey);
  const ticket = await db.prepare("SELECT revision,body FROM records WHERE id=? AND owner=? AND kind='ticket'").bind(input.ticketId, context.owner).first<{ revision: number; body: string }>();
  if (!ticket) throw new ExecutionError('NOT_FOUND', 'Ticket not found', 404);
  if (ticket.revision !== input.expectedRevision) throw new ExecutionError('REVISION_CONFLICT', 'Ticket revision changed', 409);
  if ([...ticket.body].length > 80000) invalid('Ticket contract too large');
  try { const body: unknown = JSON.parse(ticket.body); if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Invalid Ticket contract'); } catch { invalid('Invalid Ticket contract'); }
  throw new ExecutionError('ACTIVE_RUN', 'Ticket already has an active execution Run', 409);
}
export async function getRun(db: ExecutionDatabase, owner: string, id: string): Promise<Run> {
  boundedId(owner, 256); boundedId(id);
  const row = await db.prepare('SELECT * FROM execution_runs WHERE owner=? AND id=?').bind(owner, id).first<RunRow>();
  if (!row) throw new ExecutionError('NOT_FOUND', 'Run not found', 404);
  return runFromRow(row);
}
export async function listRuns(db: ExecutionDatabase, owner: string, filters: ListRunFilters = {}): Promise<Run[]> {
  boundedId(owner, 256); exactObject(filters, ['ticketId', 'state', 'limit']);
  const clauses = ['owner=?']; const values: (string | number)[] = [owner];
  if (filters.ticketId !== undefined) { boundedId(filters.ticketId); clauses.push('ticket_id=?'); values.push(filters.ticketId); }
  if (filters.state !== undefined) { if (typeof filters.state !== 'string' || !states.includes(filters.state as RunState)) invalid('Invalid state'); clauses.push('state=?'); values.push(filters.state); }
  const limit = filters.limit ?? 50; positiveInteger(limit); if (limit > 100) invalid('Maximum list limit is 100');
  const { results } = await db.prepare(`SELECT * FROM execution_runs WHERE ${clauses.join(' AND ')} ORDER BY created DESC,id DESC LIMIT ?`).bind(...values, limit).all<RunRow>();
  return results.map(runFromRow);
}
/** Backend-only lifecycle method. The public route can only request cancellation. */
export async function transitionRun(db: ExecutionDatabase, context: RunContext, input: TransitionRunInput): Promise<Run> {
  checkContext(context); exactObject(input, ['id', 'expectedVersion', 'to', 'evidence']);
  boundedId(input.id); positiveInteger(input.expectedVersion); if (!states.includes(input.to)) invalid('Invalid state');
  const evidenceProvided = input.evidence !== undefined;
  // Snapshot validated fields before any await; callers cannot mutate a receipt
  // between signature verification and the durable write.
  input = { ...input, evidence: isExecutionEvidence(input.evidence)
    ? { claims: JSON.parse(new TextDecoder().decode(receiptSigningPayload(input.evidence.claims))), signature: input.evidence.signature }
    : undefined };
  context = { ...context, evidenceTrust: context.evidenceTrust ? { ...context.evidenceTrust } : undefined };
  const run = await getRun(db, context.owner, input.id);
  if (run.version !== input.expectedVersion || !edges[run.state].includes(input.to)) throw new ExecutionError('TRANSITION_CONFLICT', 'Run state or version changed', 409);
  if (input.to === 'succeeded') {
    if (!await verifyRunEvidence(run, input.evidence, context.evidenceTrust)) throw new ExecutionError('INVALID_EVIDENCE', 'Verified backend evidence required', 409);
  } else if (evidenceProvided) invalid('Evidence is only accepted for success');
  const result = await db.prepare('UPDATE execution_runs SET state=?,version=version+1,evidence=?,last_actor=?,updated=? WHERE id=? AND owner=? AND version=? AND state=?')
    .bind(input.to, input.to === 'succeeded' ? JSON.stringify(input.evidence) : null, context.actor, new Date().toISOString(), input.id, context.owner, input.expectedVersion, run.state).run();
  if (!result.meta.changes) throw new ExecutionError('TRANSITION_CONFLICT', 'Run state or version changed', 409);
  return getRun(db, context.owner, input.id);
}
