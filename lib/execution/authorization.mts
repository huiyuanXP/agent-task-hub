import type { ExecutionDatabase } from './types.mts';
import type { Authorization, AuthorizationContext, AuthorizationRow, AssertAuthorizationInput, DecisionInput, EffectiveAuthorizationStatus, PrepareExecutionInput, PreparedExecution, RevokeInput } from './authorization-types.mts';
import { boundedId, exactObject, ExecutionError } from './errors.mts';
import { descriptorsForBody, getOperationCatalog, snapshotContext } from './catalog.mts';
import { snapshotPrepare, validateBudget, validatePrepare, validateScope } from './authorization-validation.mts';
import { getRun } from './runs.mts';
const conflict = () => new ExecutionError('DECISION_CONFLICT', 'Decision ID or authorization state conflicts', 409);
const denied = (status: string) => new ExecutionError('AUTHORIZATION_DENIED', `Authorization is ${status}`, 403);
async function rowFor(db: ExecutionDatabase, owner: string, id: string): Promise<AuthorizationRow> {
  const row = await db.prepare('SELECT * FROM execution_authorizations WHERE owner=? AND id=?').bind(owner, id).first<AuthorizationRow>();
  if (!row) throw new ExecutionError('NOT_FOUND', 'Authorization not found', 404);
  return row;
}
async function present(db: ExecutionDatabase, context: AuthorizationContext, row: AuthorizationRow): Promise<Authorization> {
  const scope = JSON.parse(row.scope), budget = JSON.parse(row.budget), operations = JSON.parse(row.operations);
  let effectiveStatus: EffectiveAuthorizationStatus = row.status;
  if (row.status === 'pending' || row.status === 'approved') {
    const ticket = await db.prepare("SELECT revision,body FROM records WHERE owner=? AND id=? AND kind='ticket'").bind(context.owner, row.ticket_id).first<{ revision: number; body: string }>();
    if (!ticket || ticket.revision !== row.ticket_revision) effectiveStatus = 'stale_revision';
    else if (context.now! >= row.expires_at) effectiveStatus = 'expired';
    else {
      const current = await descriptorsForBody(ticket.body, context);
      if (JSON.stringify(current.map(({ operationId, definitionHash }) => ({ operationId, definitionHash }))) !== row.scope) effectiveStatus = 'stale_definition';
    }
  }
  const { results } = await db.prepare('SELECT * FROM authorization_audit WHERE owner=? AND authorization_id=? ORDER BY at,rowid').bind(context.owner, row.id).all<{
    decision_id: string; owner: string; actor: string; kind: 'requested' | 'approved' | 'rejected' | 'revoked'; authorization_id: string; run_id: string; at: number; scope: string; budget: string;
  }>();
  return { id: row.id, owner: row.owner, actor: row.actor, runId: row.run_id, ticketId: row.ticket_id, ticketRevision: row.ticket_revision,
    scope, budget, operations, expiresAt: row.expires_at, status: row.status, effectiveStatus, createdAt: row.created_at,
    decisions: results.map(a => ({ decisionId: a.decision_id, owner: a.owner, actor: a.actor, kind: a.kind, authorizationId: a.authorization_id, runId: a.run_id, at: a.at, scope: JSON.parse(a.scope), budget: JSON.parse(a.budget) })) };
}
export async function getAuthorization(db: ExecutionDatabase, context: AuthorizationContext, id: string): Promise<Authorization> {
  boundedId(id); context = snapshotContext(context); return present(db, context, await rowFor(db, context.owner, id));
}
/** One transaction reserves the queued Run and pending grant, or rolls both back. */
export async function prepareExecution(db: ExecutionDatabase, context: AuthorizationContext, input: PrepareExecutionInput): Promise<PreparedExecution> {
  validatePrepare(input); context = snapshotContext(context);
  input = snapshotPrepare(input);
  const inputKey = JSON.stringify([input.ticketId, input.expectedRevision, input.requestId, input.attempt, input.scope, input.budget, input.expiresAt, context.actor]);
  const existing = await db.prepare('SELECT * FROM execution_authorizations WHERE owner=? AND request_id=?').bind(context.owner, input.requestId).first<AuthorizationRow>();
  const resultFor = async (row: AuthorizationRow) => {
    if (row.input_key !== inputKey) throw new ExecutionError('REQUEST_CONFLICT', 'Request ID already used with different input', 409);
    return { run: await getRun(db, context.owner, row.run_id), authorization: await present(db, context, row) };
  };
  if (existing) return resultFor(existing);
  if (input.expiresAt <= context.now! || input.expiresAt > context.now! + 86400000) throw denied('invalid expiry (maximum 24 hours)');
  const catalog = await getOperationCatalog(db, context, { ticketId: input.ticketId, expectedRevision: input.expectedRevision });
  if (JSON.stringify(catalog.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash }))) !== JSON.stringify(input.scope)) throw denied('scope differs from current catalog');
  const ticket = await db.prepare("SELECT body FROM records WHERE id=? AND owner=? AND kind='ticket' AND revision=?").bind(input.ticketId, context.owner, input.expectedRevision).first<{ body: string }>();
  if (!ticket) throw new ExecutionError('REVISION_CONFLICT', 'Ticket revision changed', 409);
  // Recompute against the exact body used by INSERT SELECT, covering concurrent edits.
  const operations = await descriptorsForBody(ticket.body, context);
  if (JSON.stringify(operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash }))) !== JSON.stringify(input.scope)) throw new ExecutionError('REVISION_CONFLICT', 'Ticket definition changed', 409);
  const id = crypto.randomUUID(), runId = crypto.randomUUID(), now = new Date(context.now!).toISOString();
  const runInputKey = JSON.stringify([input.ticketId, input.expectedRevision, input.requestId, id, input.attempt, context.actor]);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO execution_runs
      (id,owner,actor,ticket_id,ticket_revision,ticket_body,request_id,authorization_id,attempt,input_key,last_actor,created,updated)
      SELECT ?,owner,?,id,revision,body,?,?,?,?,?,?,? FROM records
      WHERE id=? AND owner=? AND kind='ticket' AND revision=? AND body=?
      AND NOT EXISTS(SELECT 1 FROM execution_runs WHERE owner=? AND ticket_id=? AND state IN ('queued','running','waiting'))`)
      .bind(runId, context.actor, input.requestId, id, input.attempt, runInputKey, context.actor, now, now,
        input.ticketId, context.owner, input.expectedRevision, ticket.body, context.owner, input.ticketId),
    db.prepare(`INSERT INTO execution_authorizations
      (id,owner,actor,run_id,ticket_id,ticket_revision,scope,budget,operations,expires_at,request_id,input_key,created_at,updated_at,last_decision_id,last_actor,decision_key)
      SELECT ?,owner,actor,id,ticket_id,ticket_revision,?,?,?,?,?,?,?,?,?,?,? FROM execution_runs WHERE id=? AND authorization_id=?`)
      .bind(id, JSON.stringify(input.scope), JSON.stringify(input.budget), JSON.stringify(operations), input.expiresAt, input.requestId, inputKey,
        context.now!, context.now!, 'request:' + id, context.actor, inputKey, runId, id),
  ]);
  const row = await db.prepare('SELECT * FROM execution_authorizations WHERE owner=? AND request_id=?').bind(context.owner, input.requestId).first<AuthorizationRow>();
  if (row) return resultFor(row);
  const reserved = await db.prepare('SELECT id FROM execution_runs WHERE owner=? AND request_id=?').bind(context.owner, input.requestId).first();
  if (reserved) throw new ExecutionError('REQUEST_CONFLICT', 'Request ID reserved by another Run', 409);
  const current = await db.prepare("SELECT revision,body FROM records WHERE owner=? AND id=? AND kind='ticket'").bind(context.owner, input.ticketId).first<{ revision: number; body: string }>();
  if (!current) throw new ExecutionError('NOT_FOUND', 'Ticket not found', 404);
  if (current.revision !== input.expectedRevision || current.body !== ticket.body) throw new ExecutionError('REVISION_CONFLICT', 'Ticket revision changed', 409);
  throw new ExecutionError('ACTIVE_RUN', 'Ticket already has an active execution Run', 409);
}
/** Requests always use atomic preparation; attaching a grant to an arbitrary Run is forbidden. */
export const requestAuthorization = prepareExecution;
async function decide(db: ExecutionDatabase, context: AuthorizationContext, input: RevokeInput, outcome: 'approved' | 'rejected' | 'revoked'): Promise<Authorization> {
  boundedId(input.authorizationId); boundedId(input.decisionId, 128);
  context = snapshotContext(context); input = { ...input };
  if (context.grantAuthority !== 'owner') throw denied('owner grant authority required');
  const row = await rowFor(db, context.owner, input.authorizationId);
  const decisionKey = JSON.stringify([input.authorizationId, input.decisionId, outcome, context.actor]);
  const existing = await db.prepare('SELECT decision_key FROM authorization_audit WHERE owner=? AND decision_id=?').bind(context.owner, input.decisionId).first<{ decision_key: string }>();
  if (existing) { if (existing.decision_key !== decisionKey) throw conflict(); return getAuthorization(db, context, input.authorizationId); }
  if ((outcome === 'revoked' && !['pending', 'approved'].includes(row.status)) || (outcome !== 'revoked' && row.status !== 'pending')) throw conflict();
  if (outcome !== 'revoked') {
    const effective = await present(db, context, row);
    if (effective.effectiveStatus !== 'pending') throw denied(effective.effectiveStatus);
  }
  try {
    const changed = await db.prepare(`UPDATE execution_authorizations SET status=?,last_decision_id=?,last_actor=?,decision_key=?,updated_at=?
      WHERE id=? AND owner=? AND status=?
      AND (?='revoked' OR (expires_at>? AND EXISTS(SELECT 1 FROM records r JOIN execution_runs e ON e.id=execution_authorizations.run_id
        WHERE r.id=execution_authorizations.ticket_id AND r.owner=execution_authorizations.owner AND r.kind='ticket'
        AND r.revision=execution_authorizations.ticket_revision AND r.body=e.ticket_body)))`)
      .bind(outcome, input.decisionId, context.actor, decisionKey, context.now!, input.authorizationId, context.owner, row.status, outcome, context.now!).run();
    if (!changed.meta.changes) {
      const raced = await db.prepare('SELECT decision_key FROM authorization_audit WHERE owner=? AND decision_id=?').bind(context.owner, input.decisionId).first<{ decision_key: string }>();
      if (!raced || raced.decision_key !== decisionKey) throw conflict();
    }
  } catch (error) {
    // A duplicate owner-wide decision ID races atomically with the audit trigger.
    const raced = await db.prepare('SELECT decision_key FROM authorization_audit WHERE owner=? AND decision_id=?').bind(context.owner, input.decisionId).first<{ decision_key: string }>();
    if (!raced) throw error;
    if (raced.decision_key !== decisionKey) throw conflict();
  }
  return getAuthorization(db, context, input.authorizationId);
}
export async function decideAuthorization(db: ExecutionDatabase, context: AuthorizationContext, input: DecisionInput): Promise<Authorization> {
  exactObject(input, ['authorizationId', 'decisionId', 'outcome']);
  if (input.outcome !== 'approved' && input.outcome !== 'rejected') throw conflict();
  return decide(db, context, input, input.outcome);
}
export async function revokeAuthorization(db: ExecutionDatabase, context: AuthorizationContext, input: RevokeInput): Promise<Authorization> {
  exactObject(input, ['authorizationId', 'decisionId']); return decide(db, context, input, 'revoked');
}
/** Live start/renewal check. Historical signed-result reconciliation uses the persisted permit deadline, not a new start grant. */
export async function assertAuthorization(db: ExecutionDatabase, context: AuthorizationContext, input: AssertAuthorizationInput): Promise<Authorization> {
  exactObject(input, ['authorizationId', 'runId', 'scope', 'budget']); boundedId(input.authorizationId); boundedId(input.runId); validateScope(input.scope); validateBudget(input.budget);
  input = { ...input, scope: input.scope.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget: { ...input.budget } }; context = snapshotContext(context);
  const authorization = await getAuthorization(db, context, input.authorizationId);
  if (authorization.effectiveStatus !== 'approved') throw denied(authorization.effectiveStatus);
  const run = await getRun(db, context.owner, authorization.runId);
  if (!['queued', 'running', 'waiting'].includes(run.state)) throw denied('Run is terminal');
  if (authorization.runId !== input.runId || JSON.stringify(authorization.scope) !== JSON.stringify(input.scope)) throw denied('binding or operation scope differs');
  for (const key of ['timeoutMs', 'memoryMb', 'cpus', 'pids'] as const) if (input.budget[key] > authorization.budget[key]) throw denied('requested budget enlarged');
  return authorization;
}
