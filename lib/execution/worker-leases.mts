import type { LocalDatabase } from '../database.mts';
import type { ExecutionDatabase, ExecutionStatement } from './types.mts';
import type { AuthorizationContext } from './authorization-types.mts';
import type { WorkerPrincipal } from './worker-types.mts';
import type { WorkerLease, WorkerPredicate, WorkerReport, WorkerActionKind } from './worker-lease-types.mts';
import { boundedId, exactObject, invalid } from './errors.mts';
import { SQL_NOW, WORKER_CREDENTIAL_ID } from './worker-auth.mts';
import { guardedWorkerDatabase } from './worker-guard.mts';
import { combineWorkerPredicates, executeAuthorizationPredicate, leaseAuthorizationPredicate, leaseDenied,
  reconcileAuthorizationPredicate, resolveExecutionLease } from './worker-lease-auth.mts';
import { readWorkerAction, workerActionKey, workerActionResponse, workerRequestConflict, workerRequestId } from './worker-action-store.mts';

function requestBinding(p: WorkerPrincipal, requestId: string, kind: WorkerActionKind, key: string): WorkerPredicate {
  return { sql: `NOT EXISTS(SELECT 1 FROM execution_worker_actions WHERE credential_id=? AND request_id=? AND (kind<>? OR input_key<>?))`,
    values: [p.credentialId, requestId, kind, key] };
}
function expiryCap(p: WorkerPrincipal, mode: 'execute' | 'reconcile'): WorkerPredicate {
  if (mode === 'reconcile') return { sql: `MIN(${SQL_NOW}+6000,?,?)`, values: [p.expiresAt, p.issuerExpiresAt] };
  return { sql: `MIN(${SQL_NOW}+6000,?,?,(SELECT expires_at FROM execution_authorizations WHERE id=? AND owner=?),
    COALESCE((SELECT deadline_ms FROM execution_permits WHERE owner=? AND run_id=?),9007199254740991))`,
    values: [p.expiresAt, p.issuerExpiresAt, p.authorizationId, p.owner, p.owner, p.runId] };
}
const safeLeaseSQL = "json_object('leaseId',lease_id,'runId',run_id,'generation',generation,'mode',mode,'createdAt',created_at,'expiresAt',expires_at)";
function leaseReceipt(db: ExecutionDatabase, p: WorkerPrincipal, requestId: string, kind: 'claim' | 'renew', key: string, leaseId: string): ExecutionStatement {
  return db.prepare(`INSERT INTO execution_worker_actions
    (owner,credential_id,run_id,lease_id,generation,request_id,kind,input_key,status,response_json,created_at,updated_at)
    SELECT owner,credential_id,run_id,lease_id,generation,?,?,?,'completed',${safeLeaseSQL},${SQL_NOW},${SQL_NOW}
    FROM execution_worker_leases WHERE lease_id=? AND credential_id=? AND owner=? ${kind === 'claim' ? 'AND input_key=?' : ''}
    ON CONFLICT DO NOTHING`).bind(requestId, kind, key, leaseId, p.credentialId, p.owner, ...(kind === 'claim' ? [key] : []));
}
async function completedResponse(db: LocalDatabase, p: WorkerPrincipal, requestId: string, kind: WorkerActionKind, key: string, predicate?: WorkerPredicate): Promise<unknown | null> {
  const row = await readWorkerAction(db, p, requestId, predicate);
  if (!row) return null;
  const result = workerActionResponse(row, kind, key);
  if (!result.completed) throw leaseDenied();
  return result.response;
}
export async function claimExecutionRun(db: LocalDatabase, principal: WorkerPrincipal, input: unknown, context: AuthorizationContext): Promise<WorkerLease> {
  exactObject(input, ['runId', 'requestId', 'leaseId', 'verifier', 'mode']);
  boundedId(input.runId); workerRequestId(input.requestId);
  if (input.runId !== principal.runId) throw leaseDenied();
  if (typeof input.leaseId !== 'string' || !WORKER_CREDENTIAL_ID.test(input.leaseId)) invalid('Invalid execution lease ID');
  if (typeof input.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(input.verifier)) invalid('Invalid execution lease verifier');
  if (input.mode !== 'execute' && input.mode !== 'reconcile') invalid('Invalid execution lease mode');
  const p = { ...principal }, args = { runId: input.runId, requestId: input.requestId, leaseId: input.leaseId, verifier: input.verifier, mode: input.mode as 'execute' | 'reconcile' };
  const key = JSON.stringify(['claim', args.runId, args.requestId, args.leaseId, args.verifier, args.mode]);
  // Replaying a committed claim returns its original metadata, even if its lease has expired.
  const previous = await completedResponse(db, p, args.requestId, 'claim', key);
  if (previous) return previous as WorkerLease;
  const authority = args.mode === 'execute' ? await executeAuthorizationPredicate(db, p, context) : reconcileAuthorizationPredicate(p);
  const candidate: WorkerPredicate = { sql: `NOT EXISTS(SELECT 1 FROM execution_worker_leases WHERE credential_id=? AND request_id=?)
    OR EXISTS(SELECT 1 FROM execution_worker_leases WHERE credential_id=? AND request_id=? AND input_key=? AND expires_at>${SQL_NOW})`,
    values: [p.credentialId, args.requestId, p.credentialId, args.requestId, key] };
  const predicate = combineWorkerPredicates(authority, requestBinding(p, args.requestId, 'claim', key), candidate);
  const guarded = guardedWorkerDatabase(db, p, predicate), cap = expiryCap(p, args.mode);
  try {
    await guarded.batch([
      guarded.prepare(`INSERT INTO execution_worker_leases
        (lease_id,owner,credential_id,run_id,generation,mode,verifier,request_id,input_key,created_at,expires_at,renewed_at)
        SELECT ?,r.owner,?,r.id,COALESCE((SELECT MAX(generation) FROM execution_worker_leases WHERE run_id=r.id),0)+1,
          ?,?,?,?,${SQL_NOW},${cap.sql},${SQL_NOW} FROM execution_runs r
        WHERE r.id=? AND r.owner=? AND ${cap.sql}>${SQL_NOW}
          AND NOT EXISTS(SELECT 1 FROM execution_worker_leases WHERE run_id=r.id AND expires_at>${SQL_NOW})
          AND NOT EXISTS(SELECT 1 FROM execution_worker_actions WHERE credential_id=? AND request_id=?)
        ON CONFLICT DO NOTHING`).bind(args.leaseId, p.credentialId, args.mode, args.verifier, args.requestId, key,
          ...cap.values, p.runId, p.owner, ...cap.values, p.credentialId, args.requestId),
      leaseReceipt(guarded, p, args.requestId, 'claim', key, args.leaseId),
    ]);
  } catch (error) {
    const raced = await completedResponse(db, p, args.requestId, 'claim', key);
    if (raced) return raced as WorkerLease;
    throw error;
  }
  const response = await completedResponse(db, p, args.requestId, 'claim', key);
  if (response) return response as WorkerLease;
  if (await guardedWorkerDatabase(db, p).prepare('SELECT lease_id FROM execution_worker_leases WHERE lease_id=?').bind(args.leaseId).first()) throw workerRequestConflict();
  throw leaseDenied();
}
function leasedInput(principal: WorkerPrincipal, input: unknown, report: boolean) {
  exactObject(input, report ? ['runId', 'requestId', 'leaseToken', 'message'] : ['runId', 'requestId', 'leaseToken']);
  boundedId(input.runId); workerRequestId(input.requestId);
  if (input.runId !== principal.runId) throw leaseDenied();
  if (typeof input.leaseToken !== 'string') invalid('Invalid execution lease token');
  if (report && (typeof input.message !== 'string' || input.message.length > 2048)) invalid('Invalid report message');
  return { runId: input.runId, requestId: input.requestId, leaseToken: input.leaseToken, message: report ? input.message as string : undefined };
}
export async function renewExecutionRun(db: LocalDatabase, principal: WorkerPrincipal, input: unknown, context: AuthorizationContext): Promise<WorkerLease> {
  const p = { ...principal }, args = leasedInput(p, input, false);
  const lease = await resolveExecutionLease(db, p, { runId: args.runId, leaseToken: args.leaseToken });
  if (lease.mode !== 'execute') throw leaseDenied();
  const key = workerActionKey(lease, 'renew', { requestId: args.requestId });
  const authority = await executeAuthorizationPredicate(db, p, context), cap = expiryCap(p, 'execute');
  const withinDeadline: WorkerPredicate = { sql: `EXISTS(SELECT 1 FROM execution_worker_leases WHERE lease_id=? AND expires_at<=${cap.sql})`,
    values: [lease.lease_id, ...cap.values] };
  const core = combineWorkerPredicates(leaseAuthorizationPredicate(p, lease), authority, withinDeadline);
  const predicate = combineWorkerPredicates(core, requestBinding(p, args.requestId, 'renew', key));
  const previous = await completedResponse(db, p, args.requestId, 'renew', key, core);
  if (previous) return previous as WorkerLease;
  const guarded = guardedWorkerDatabase(db, p, predicate);
  try {
    await guarded.batch([
      guarded.prepare(`UPDATE execution_worker_leases SET expires_at=${cap.sql},renewed_at=${SQL_NOW}
        WHERE lease_id=? AND credential_id=? AND owner=? AND expires_at<=${cap.sql}
        AND NOT EXISTS(SELECT 1 FROM execution_worker_actions WHERE credential_id=? AND request_id=?)`)
        .bind(...cap.values, lease.lease_id, p.credentialId, p.owner, ...cap.values, p.credentialId, args.requestId),
      leaseReceipt(guarded, p, args.requestId, 'renew', key, lease.lease_id),
    ]);
  } catch (error) {
    const raced = await completedResponse(db, p, args.requestId, 'renew', key, combineWorkerPredicates(leaseAuthorizationPredicate(p, lease), authority));
    if (raced) return raced as WorkerLease;
    throw error;
  }
  const response = await completedResponse(db, p, args.requestId, 'renew', key, core);
  if (!response) throw leaseDenied();
  return response as WorkerLease;
}
export async function reportExecutionRun(db: LocalDatabase, principal: WorkerPrincipal, input: unknown, context: AuthorizationContext): Promise<WorkerReport> {
  const p = { ...principal }, args = leasedInput(p, input, true);
  const lease = await resolveExecutionLease(db, p, { runId: args.runId, leaseToken: args.leaseToken });
  if (lease.mode !== 'execute') throw leaseDenied();
  const key = workerActionKey(lease, 'report', { requestId: args.requestId, message: args.message });
  const core = combineWorkerPredicates(leaseAuthorizationPredicate(p, lease), await executeAuthorizationPredicate(db, p, context));
  const predicate = combineWorkerPredicates(core, requestBinding(p, args.requestId, 'report', key));
  const previous = await completedResponse(db, p, args.requestId, 'report', key, core);
  if (previous) return previous as WorkerReport;
  const guarded = guardedWorkerDatabase(db, p, predicate);
  try {
    await guarded.batch([guarded.prepare(`INSERT INTO execution_worker_actions
      (owner,credential_id,run_id,lease_id,generation,request_id,kind,input_key,status,response_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'report',?,'completed',json_object('runId',?,'leaseId',?,'generation',?,'message',?,'reportedAt',${SQL_NOW}),${SQL_NOW},${SQL_NOW})
      ON CONFLICT DO NOTHING`).bind(p.owner, p.credentialId, p.runId, lease.lease_id, lease.generation, args.requestId, key,
        p.runId, lease.lease_id, lease.generation, args.message!)]);
  } catch (error) {
    const raced = await completedResponse(db, p, args.requestId, 'report', key, combineWorkerPredicates(leaseAuthorizationPredicate(p, lease), await executeAuthorizationPredicate(db, p, context)));
    if (raced) return raced as WorkerReport;
    throw error;
  }
  const response = await completedResponse(db, p, args.requestId, 'report', key, core);
  if (!response) throw leaseDenied();
  return response as WorkerReport;
}
