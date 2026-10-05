import type { ExecutionDatabase } from './types.mts';
import type { AuthorizationContext } from './authorization-types.mts';
import type { DispatchPermit, PermitRow } from './dispatch-types.mts';
import { assertAuthorization, getAuthorization } from './authorization.mts';
import { getRun } from './runs.mts';
import { snapshotContext } from './catalog.mts';
import { boundedId, ExecutionError } from './errors.mts';
import { sha256 } from './evidence.mts';
import { MAX_PERMIT_BYTES } from './registry.mts';
import { canonical } from './transport.mts';
export async function permitForRun(db: ExecutionDatabase, owner: string, runId: string): Promise<PermitRow | null> {
  return db.prepare('SELECT * FROM execution_permits WHERE owner=? AND run_id=?').bind(owner,runId).first<PermitRow>();
}
/** Physical stop intent is independent of the absorbing logical Run state. */
export async function requestPermitCancellation(db: ExecutionDatabase, owner: string, runId: string): Promise<PermitRow | null> {
  await getRun(db, owner, runId);
  await db.prepare('UPDATE execution_permits SET cancel_requested=1 WHERE owner=? AND run_id=? AND closed_at IS NULL').bind(owner,runId).run();
  return permitForRun(db,owner,runId);
}
/** INSERT SELECT is the start-authority linearization; the partial unique index reserves the physical Ticket. */
export async function createDispatchPermit(db: ExecutionDatabase, context: AuthorizationContext, runId: string): Promise<DispatchPermit> {
  boundedId(runId); context = snapshotContext(context);
  const run = await getRun(db, context.owner, runId);
  const previous = await permitForRun(db, context.owner, runId);
  if (previous) return JSON.parse(previous.envelope);
  const grant = await getAuthorization(db, context, run.authorizationId);
  await assertAuthorization(db, context, { authorizationId: grant.id, runId, scope: grant.scope, budget: grant.budget });
  const now = context.now!;
  const permit: DispatchPermit = { version: 1, permitId: crypto.randomUUID(), owner: context.owner, runId, ticketId: run.ticketId, ticketRevision: run.ticketRevision,
    attempt: run.attempt, authorizationId: grant.id, contractSha256: await sha256(run.ticketBody), ticketBody: run.ticketBody, operation: grant.operations[0], budget: grant.budget,
    issuedAt: now, deadlineMs: Math.min(grant.expiresAt, now + grant.budget.timeoutMs), expiresAt: grant.expiresAt };
  const envelope = canonical(permit);
  if(new TextEncoder().encode(envelope).length > MAX_PERMIT_BYTES - 64) throw new ExecutionError('INVALID_INPUT','Dispatch envelope exceeds bounded transport',400);
  await db.batch([db.prepare(`INSERT OR IGNORE INTO execution_permits(id,owner,run_id,ticket_id,authorization_id,envelope,envelope_hash,created_at,deadline_ms)
    SELECT ?,r.owner,r.id,r.ticket_id,a.id,?,?,?,? FROM execution_runs r JOIN execution_authorizations a ON a.id=r.authorization_id
    JOIN records t ON t.owner=r.owner AND t.id=r.ticket_id AND t.kind='ticket'
    WHERE r.id=? AND r.owner=? AND r.state IN ('queued','waiting') AND a.status='approved' AND a.expires_at>?
      AND a.scope=? AND a.budget=? AND a.operations=? AND a.run_id=r.id AND a.owner=r.owner AND a.ticket_revision=r.ticket_revision
      AND t.revision=r.ticket_revision AND t.body=r.ticket_body AND r.ticket_body=?
      AND NOT EXISTS(SELECT 1 FROM execution_permits p WHERE p.owner=r.owner AND p.ticket_id=r.ticket_id AND p.closed_at IS NULL)`)
    .bind(permit.permitId,envelope,await sha256(envelope),now,permit.deadlineMs,runId,context.owner,now,JSON.stringify(grant.scope),JSON.stringify(grant.budget),JSON.stringify(grant.operations),run.ticketBody)]);
  const result = await permitForRun(db,context.owner,runId);
  if (!result) throw new ExecutionError('DISPATCH_CONFLICT','Start authority changed or Ticket remains physically reserved',409);
  return JSON.parse(result.envelope);
}
/** Service-only limited checkpoint: caller authenticates transport before resolving this persisted binding. */
export async function checkpointPermit(db: ExecutionDatabase, input: DispatchPermit | { permitId: string; permitSha256: string }, now = Date.now()) {
  const permitId = input.permitId;
  const hash = 'permitSha256' in input ? input.permitSha256 : await sha256(canonical(input));
  const row = await db.prepare(`SELECT p.*,a.status AS authorization_status,a.expires_at,r.state AS run_state,t.revision AS current_revision,t.body AS current_body
    FROM execution_permits p JOIN execution_authorizations a ON a.id=p.authorization_id JOIN execution_runs r ON r.id=p.run_id
    LEFT JOIN records t ON t.owner=p.owner AND t.id=p.ticket_id AND t.kind='ticket' WHERE p.id=? AND p.envelope_hash=?`)
    .bind(permitId,hash).first<PermitRow & { authorization_status: string; expires_at: number; run_state: string; current_revision: number; current_body: string }>();
  if (!row) return { allowed: false, deadlineMs: null };
  const permit = JSON.parse(row.envelope) as DispatchPermit;
  const allowed = !row.cancel_requested && row.closed_at === null && row.authorization_status === 'approved' && now < row.deadline_ms && now < row.expires_at &&
    ['queued','running','waiting'].includes(row.run_state) && row.current_revision === permit.ticketRevision && row.current_body === permit.ticketBody;
  return { allowed, deadlineMs: row.deadline_ms };
}
