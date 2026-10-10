import type { LocalDatabase } from '../database.mts';
import type { WorkerPrincipal } from './worker-types.mts';
import type { AuthorizationContext } from './authorization-types.mts';
import type { BackendEnvironment } from './backend-config.mts';
import { configuredRegistry } from './backend-config.mts';
import { guardedWorkerDatabase, type WorkerGuardPredicate } from './worker-guard.mts';
import { resolveExecutionLease, leaseAuthorizationPredicate, executeAuthorizationPredicate } from './worker-lease-auth.mts';
import { beginWorkerAction, finishWorkerAction } from './worker-action-store.mts';
import { handleBackendRequest, reconcileBackend } from './backend-http.mts';
import { getRun } from './runs.mts';
import { permitForRun } from './dispatch.mts';
import { boundedId, exactObject, ExecutionError, invalid } from './errors.mts';

const denied = () => new ExecutionError('AUTHORIZATION_DENIED', 'Action is not permitted by this Worker lease', 403);
function checkInput(value: unknown): { runId: string; requestId: string; leaseToken: string } {
  exactObject(value, ['runId', 'requestId', 'leaseToken']); boundedId(value.runId);
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId) || typeof value.leaseToken !== 'string') invalid('Invalid Worker action');
  return { runId: value.runId, requestId: value.requestId, leaseToken: value.leaseToken };
}
function contextFor(principal: WorkerPrincipal): AuthorizationContext {
  return { owner: principal.owner, actor: principal.actor, executionRunId: principal.runId };
}
function combine(a: WorkerGuardPredicate, b: WorkerGuardPredicate): WorkerGuardPredicate {
  return { sql: `(${a.sql}) AND (${b.sql})`, values: [...a.values, ...b.values] };
}
async function safeResult(db: ReturnType<typeof guardedWorkerDatabase>, principal: WorkerPrincipal, kind: string, requestId: string, backend: unknown) {
  const run = await getRun(db, principal.owner, principal.runId);
  const permit = await permitForRun(db, principal.owner, principal.runId);
  const phase = backend && typeof backend === 'object' && 'phase' in backend && typeof backend.phase === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(backend.phase) ? backend.phase : null;
  return { requestId, kind, run: { id: run.id, state: run.state, version: run.version },
    permit: permit ? { permitId: permit.id, deadlineMs: permit.deadline_ms, cancelRequested: permit.cancel_requested === 1, closedAt: permit.closed_at } : null,
    backend: phase ? { phase } : null };
}
async function backendResponse(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!response.ok) {
    if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' && 'error' in value && typeof value.error === 'string') {
      const known = ['INVALID_INPUT', 'NOT_FOUND', 'REVISION_CONFLICT', 'REQUEST_CONFLICT', 'ACTIVE_RUN', 'TRANSITION_CONFLICT', 'INVALID_EVIDENCE', 'BODY_TOO_LARGE', 'UNSUPPORTED_MEDIA', 'AUTHORIZATION_DENIED', 'DECISION_CONFLICT', 'STORAGE_UNAVAILABLE', 'DISPATCH_CONFLICT', 'CONFIGURATION_UNAVAILABLE', 'RESPONSE_TOO_LARGE'];
      if (known.includes(value.code) && [400,403,404,409,413,415,503].includes(response.status)) throw new ExecutionError(value.code as ExecutionError['code'], value.error, response.status as ExecutionError['status']);
    }
    throw new ExecutionError('STORAGE_UNAVAILABLE', 'Execution backend unavailable', 503);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExecutionError('INVALID_EVIDENCE', 'Invalid backend response', 409);
  return value as Record<string, unknown>;
}
/** Dispatch stays bound to the immutable permit and the current execute generation. */
export async function startExecutionRun(db: LocalDatabase, principal: WorkerPrincipal, value: unknown, env: BackendEnvironment) {
  principal = { ...principal }; const input = checkInput(value);
  const lease = await resolveExecutionLease(db, principal, { runId: input.runId, leaseToken: input.leaseToken });
  if (lease.mode !== 'execute') throw denied();
  const context = { ...contextFor(principal), registry: configuredRegistry(env) };
  const permission = combine(leaseAuthorizationPredicate(principal, lease), await executeAuthorizationPredicate(db, principal, context));
  const action = await beginWorkerAction(db, principal, lease, 'start', { requestId: input.requestId }, permission);
  if (action.completed) return action.response;
  const guarded = guardedWorkerDatabase(db, principal, permission);
  const request = new Request(new URL('/api/execution/dispatch', principal.origin), { method: 'POST', headers: { origin: principal.origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start', runId: principal.runId }) });
  const result = await backendResponse(await handleBackendRequest(guarded, context, request, env));
  const response = await safeResult(guarded, principal, 'start', input.requestId, result.backend);
  return finishWorkerAction(db, principal, lease, 'start', { requestId: input.requestId }, response, permission);
}
/** Completion ingests trusted historical result; an empty/running response is not completion. */
export async function completeExecutionRun(db: LocalDatabase, principal: WorkerPrincipal, value: unknown, env: BackendEnvironment) {
  principal = { ...principal }; const input = checkInput(value);
  const lease = await resolveExecutionLease(db, principal, { runId: input.runId, leaseToken: input.leaseToken });
  const permission = leaseAuthorizationPredicate(principal, lease);
  const guarded = guardedWorkerDatabase(db, principal, permission);
  const permit = await permitForRun(guarded, principal.owner, principal.runId);
  if (!permit) throw new ExecutionError('NOT_FOUND', 'Dispatched Run not found', 404);
  const action = await beginWorkerAction(db, principal, lease, 'complete', { requestId: input.requestId }, permission);
  if (action.completed) return action.response;
  const result = await reconcileBackend(guarded, contextFor(principal), env, principal.runId);
  const retained = await guarded.prepare("SELECT id FROM backend_attestations WHERE owner=? AND permit_id=? AND purpose='result'").bind(principal.owner, permit.id).first();
  if (!retained) throw new ExecutionError('INVALID_EVIDENCE', 'Trusted backend result is not ready', 409);
  const response = await safeResult(guarded, principal, 'complete', input.requestId, result.backend);
  return finishWorkerAction(db, principal, lease, 'complete', { requestId: input.requestId }, response, permission);
}
/** Cancellation persists logical intent and separately reconciles physical receipt closure. */
export async function cancelExecutionRun(db: LocalDatabase, principal: WorkerPrincipal, value: unknown, env: BackendEnvironment) {
  principal = { ...principal }; const input = checkInput(value);
  const lease = await resolveExecutionLease(db, principal, { runId: input.runId, leaseToken: input.leaseToken });
  const permission = leaseAuthorizationPredicate(principal, lease);
  const guarded = guardedWorkerDatabase(db, principal, permission);
  if (lease.mode === 'reconcile' && !await permitForRun(guarded, principal.owner, principal.runId)) throw denied();
  const action = await beginWorkerAction(db, principal, lease, 'cancel', { requestId: input.requestId }, permission);
  if (action.completed) return action.response;
  const request = new Request(new URL('/api/execution/dispatch', principal.origin), { method: 'POST', headers: { origin: principal.origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', runId: principal.runId }) });
  const result = await backendResponse(await handleBackendRequest(guarded, contextFor(principal), request, env));
  const response = await safeResult(guarded, principal, 'cancel', input.requestId, result.backend);
  return finishWorkerAction(db, principal, lease, 'cancel', { requestId: input.requestId }, response, permission);
}
