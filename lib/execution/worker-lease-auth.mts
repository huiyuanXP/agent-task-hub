import { createHash, timingSafeEqual } from 'node:crypto';
import type { LocalDatabase } from '../database.mts';
import type { AuthorizationContext } from './authorization-types.mts';
import type { WorkerPrincipal } from './worker-types.mts';
import type { WorkerLease, WorkerLeaseRow, WorkerPredicate } from './worker-lease-types.mts';
import { boundedId, exactObject, ExecutionError, invalid } from './errors.mts';
import { guardedWorkerDatabase } from './worker-guard.mts';
import { SQL_NOW, WORKER_CREDENTIAL_ID } from './worker-auth.mts';
import { getAuthorization, assertAuthorization } from './authorization.mts';
import { snapshotContext } from './catalog.mts';

export const LEASE_TTL_MS = 6000;
export const leaseDenied = (): ExecutionError => new ExecutionError('AUTHORIZATION_DENIED', 'Execution lease is no longer authorized', 403);
export function combineWorkerPredicates(...predicates: WorkerPredicate[]): WorkerPredicate {
  return { sql: predicates.map(p => '(' + p.sql + ')').join(' AND ') || '1', values: predicates.flatMap(p => p.values) };
}
export function safeExecutionLease(row: WorkerLeaseRow): WorkerLease {
  return { leaseId: row.lease_id, runId: row.run_id, generation: row.generation, mode: row.mode,
    createdAt: row.created_at, expiresAt: row.expires_at };
}
export function leaseAuthorizationPredicate(principal: WorkerPrincipal, row: WorkerLeaseRow): WorkerPredicate {
  return { sql: `EXISTS(SELECT 1 FROM execution_worker_leases l WHERE l.lease_id=? AND l.owner=? AND l.credential_id=?
    AND l.run_id=? AND l.generation=? AND l.mode=? AND l.verifier=? AND l.created_at=? AND l.expires_at>${SQL_NOW}
    AND l.generation=(SELECT MAX(generation) FROM execution_worker_leases WHERE run_id=l.run_id))
    AND ?=? AND ?=? AND ?=?`,
    values: [row.lease_id, principal.owner, principal.credentialId, principal.runId, row.generation, row.mode,
      row.verifier, row.created_at, row.owner, principal.owner, row.credential_id, principal.credentialId, row.run_id, principal.runId] };
}
export async function resolveExecutionLease(db: LocalDatabase, principal: WorkerPrincipal, input: { runId: string; leaseToken: string }): Promise<WorkerLeaseRow> {
  exactObject(input, ['runId', 'leaseToken']); boundedId(input.runId);
  if (input.runId !== principal.runId) throw leaseDenied();
  const token = input.leaseToken, p = { ...principal }, runId = input.runId;
  if (typeof token !== 'string') invalid('Invalid execution lease token');
  const match = /^athl1\.([0-9a-f-]{36})\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match || !WORKER_CREDENTIAL_ID.test(match[1]) || !Number.isSafeInteger(Number(match[2]))) throw leaseDenied();
  const guarded = guardedWorkerDatabase(db, p);
  const row = await guarded.prepare('SELECT * FROM execution_worker_leases WHERE lease_id=? AND run_id=? AND credential_id=? AND owner=?')
    .bind(match[1], runId, p.credentialId, p.owner).first<WorkerLeaseRow>();
  const verifier = createHash('sha256').update(match[3]).digest('hex');
  if (!row || row.generation !== Number(match[2]) || !/^[0-9a-f]{64}$/.test(row.verifier) ||
    !timingSafeEqual(Buffer.from(row.verifier, 'hex'), Buffer.from(verifier, 'hex'))) throw leaseDenied();
  const frozen = { ...row };
  await guardedWorkerDatabase(db, p, leaseAuthorizationPredicate(p, frozen)).prepare('SELECT 1').first();
  return frozen;
}
export function reconcileAuthorizationPredicate(p: WorkerPrincipal): WorkerPredicate {
  return { sql: `EXISTS(SELECT 1 FROM execution_permits d JOIN execution_runs r ON r.id=d.run_id AND r.owner=d.owner
    WHERE d.owner=? AND d.run_id=? AND d.ticket_id=? AND d.authorization_id=?
      AND r.ticket_revision=? AND r.attempt=? AND r.authorization_id=d.authorization_id)`,
    values: [p.owner, p.runId, p.ticketId, p.authorizationId, p.ticketRevision, p.attempt] };
}
/** Registry validation happens in JS; SQLite rechecks the exact immutable grant and live Ticket at each write. */
export async function executeAuthorizationPredicate(db: LocalDatabase, p: WorkerPrincipal, context: AuthorizationContext): Promise<WorkerPredicate> {
  const trusted = snapshotContext({ ...context, owner: p.owner, actor: p.actor, executionRunId: p.runId, now: Date.now() });
  const guarded = guardedWorkerDatabase(db, p);
  const grant = await getAuthorization(guarded, trusted, p.authorizationId);
  await assertAuthorization(guarded, trusted, { authorizationId: p.authorizationId, runId: p.runId, scope: grant.scope, budget: grant.budget });
  return { sql: `EXISTS(SELECT 1 FROM execution_authorizations a JOIN execution_runs r ON r.id=a.run_id AND r.owner=a.owner
    JOIN records t ON t.id=r.ticket_id AND t.owner=r.owner AND t.kind='ticket'
    WHERE a.id=? AND a.owner=? AND a.run_id=? AND a.status='approved' AND a.expires_at>${SQL_NOW}
      AND a.ticket_id=? AND a.ticket_revision=? AND r.authorization_id=a.id AND r.attempt=?
      AND r.state IN ('queued','running','waiting') AND t.revision=r.ticket_revision AND t.body=r.ticket_body
      AND a.scope=? AND a.budget=? AND a.operations=?
      AND NOT EXISTS(SELECT 1 FROM execution_permits d WHERE d.owner=r.owner AND d.run_id=r.id
        AND (d.cancel_requested=1 OR d.closed_at IS NOT NULL OR d.deadline_ms<=${SQL_NOW})))`,
    values: [p.authorizationId, p.owner, p.runId, p.ticketId, p.ticketRevision, p.attempt,
      JSON.stringify(grant.scope), JSON.stringify(grant.budget), JSON.stringify(grant.operations)] };
}
