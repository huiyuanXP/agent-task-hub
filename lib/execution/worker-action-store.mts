import type { LocalDatabase } from '../database.mts';
import type { WorkerPrincipal } from './worker-types.mts';
import type { WorkerActionInput, WorkerActionKind, WorkerActionResult, WorkerActionRow, WorkerLeaseRow, WorkerPredicate } from './worker-lease-types.mts';
import { exactObject, ExecutionError, invalid } from './errors.mts';
import { guardedWorkerDatabase } from './worker-guard.mts';
import { SQL_NOW } from './worker-auth.mts';
import { combineWorkerPredicates, leaseAuthorizationPredicate, leaseDenied } from './worker-lease-auth.mts';

export function workerRequestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) invalid('Invalid Worker request ID');
}
export const workerRequestConflict = (): ExecutionError => new ExecutionError('REQUEST_CONFLICT', 'Worker request ID is bound to another action or input', 409);
export function workerActionKey(lease: WorkerLeaseRow, kind: WorkerActionKind, input: WorkerActionInput): string {
  exactObject(input, ['requestId', 'message']); workerRequestId(input.requestId);
  if (input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 2048)) invalid('Invalid report message');
  return JSON.stringify([kind, lease.run_id, lease.lease_id, lease.generation, input.requestId, input.message ?? null]);
}
export function workerActionResponse(row: WorkerActionRow, kind: WorkerActionKind, key: string): WorkerActionResult {
  if (row.kind !== kind || row.input_key !== key) throw workerRequestConflict();
  return { completed: row.status === 'completed', response: row.response_json === null ? null : JSON.parse(row.response_json) };
}
export async function readWorkerAction(db: LocalDatabase, p: WorkerPrincipal, requestId: string, extra?: WorkerPredicate): Promise<WorkerActionRow | null> {
  workerRequestId(requestId);
  return guardedWorkerDatabase(db, p, extra).prepare('SELECT * FROM execution_worker_actions WHERE credential_id=? AND owner=? AND request_id=?')
    .bind(p.credentialId, p.owner, requestId).first<WorkerActionRow>();
}
/** Reject sensitive backend objects at the final projection boundary. */
export function serializeWorkerActionResponse(value: unknown): string {
  const visit = (item: unknown, depth: number) => {
    if (depth > 12) invalid('Worker action response too deep');
    if (typeof item === 'string' && /ath[wl]1\.[0-9a-f-]{36}\./.test(item)) invalid('Secret-bearing Worker action response');
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); }
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (/^(?:token|leaseToken|secret|verifier|issuerTokenHash|issuer_token_hash|evidence|receipt|signature|ticketBody|envelope)$/i.test(key)) invalid('Unsafe Worker action response');
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > 16384) invalid('Worker action response exceeds limit');
  return json;
}
function actionPredicate(p: WorkerPrincipal, lease: WorkerLeaseRow, extra?: WorkerPredicate) {
  return combineWorkerPredicates(leaseAuthorizationPredicate(p, lease), ...(extra ? [extra] : []));
}
export async function beginWorkerAction(db: LocalDatabase, principal: WorkerPrincipal, lease: WorkerLeaseRow, kind: WorkerActionKind,
  input: WorkerActionInput, extra?: WorkerPredicate): Promise<WorkerActionResult> {
  const p = { ...principal }, l = { ...lease }, args = { ...input }, key = workerActionKey(l, kind, args);
  if (!['start', 'complete', 'cancel'].includes(kind)) invalid('Use the dedicated Worker action service');
  const predicate = actionPredicate(p, l, extra), guarded = guardedWorkerDatabase(db, p, predicate);
  const previous = await readWorkerAction(db, p, args.requestId, predicate);
  if (previous) return workerActionResponse(previous, kind, key);
  await guarded.batch([guarded.prepare(`INSERT INTO execution_worker_actions
    (owner,credential_id,run_id,lease_id,generation,request_id,kind,input_key,status,response_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'pending',NULL,${SQL_NOW},${SQL_NOW}) ON CONFLICT DO NOTHING`)
    .bind(p.owner, p.credentialId, p.runId, l.lease_id, l.generation, args.requestId, kind, key)]);
  const row = await readWorkerAction(db, p, args.requestId, predicate);
  if (!row) throw leaseDenied();
  return workerActionResponse(row, kind, key);
}
export async function finishWorkerAction(db: LocalDatabase, principal: WorkerPrincipal, lease: WorkerLeaseRow, kind: WorkerActionKind,
  input: WorkerActionInput, safeResponse: unknown, extra?: WorkerPredicate): Promise<unknown> {
  const p = { ...principal }, l = { ...lease }, args = { ...input }, key = workerActionKey(l, kind, args);
  const json = serializeWorkerActionResponse(safeResponse);
  if (!['start', 'complete', 'cancel'].includes(kind)) invalid('Use the dedicated Worker action service');
  const predicate = actionPredicate(p, l, extra), guarded = guardedWorkerDatabase(db, p, predicate);
  const previous = await readWorkerAction(db, p, args.requestId, predicate);
  if (!previous) throw new ExecutionError('NOT_FOUND', 'Worker action reservation not found', 404);
  const replay = workerActionResponse(previous, kind, key);
  if (replay.completed) return replay.response;
  await guarded.batch([guarded.prepare(`UPDATE execution_worker_actions SET status='completed',response_json=?,updated_at=${SQL_NOW}
    WHERE credential_id=? AND owner=? AND request_id=? AND kind=? AND input_key=? AND status='pending'`)
    .bind(json, p.credentialId, p.owner, args.requestId, kind, key)]);
  const row = await readWorkerAction(db, p, args.requestId, predicate);
  if (!row) throw leaseDenied();
  const result = workerActionResponse(row, kind, key);
  if (!result.completed) throw leaseDenied();
  return result.response;
}
