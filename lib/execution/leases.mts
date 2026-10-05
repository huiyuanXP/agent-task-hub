import type { ExecutionDatabase } from './types.mts';
import type { AuthorizationContext } from './authorization-types.mts';
import type { WorkerPrincipal, LeaseRow, ClaimInput, LeaseInput } from './worker-types.mts';
import type { BackendEnvironment } from './backend-config.mts';
import { configuredRegistry } from './backend-config.mts';
import { getAuthorization } from './authorization.mts';
import { getRun } from './runs.mts';
import { permitForRun } from './dispatch.mts';
import { handleBackendRequest, reconcileBackend } from './backend-http.mts';
import { exactObject, boundedId, invalid, ExecutionError } from './errors.mts';
import { sha256 } from './evidence.mts';
import { canonical } from './transport.mts';
import { assertWorkerCurrent, verifier } from './workers.mts';
import { credentialGuard, leaseGuard, combine, checkGuard, guardedDatabase, SQL_NOW, denied, type SqlGuard } from './worker-guard.mts';
export const LEASE_MS = 6000;
const conflict = () => new ExecutionError('LEASE_CONFLICT', 'Lease unavailable or superseded', 409);
const publicLease = (l: LeaseRow) => ({ leaseId: l.id, runId: l.run_id, credentialId: l.credential_id, workerId: l.principal_id, generation: l.generation, mode: l.mode, expiresAt: l.expires_at });
function scope(p: WorkerPrincipal, runId: unknown) { boundedId(runId); if (runId !== p.runId)
    throw denied(); }
function context(p: WorkerPrincipal, extra: Partial<AuthorizationContext> = {}): AuthorizationContext { return { owner: p.owner, actor: p.actor, ...extra, executionRunId: p.runId, grantAuthority: undefined }; }
async function executeGuard(db: ExecutionDatabase, p: WorkerPrincipal, extra: Partial<AuthorizationContext>): Promise<SqlGuard> {
    const grant = await getAuthorization(db, context(p, extra), p.authorizationId);
    if (grant.effectiveStatus !== 'approved')
        throw denied();
    return { sql: `EXISTS(SELECT 1 FROM execution_runs r JOIN execution_authorizations a ON a.id=r.authorization_id AND a.owner=r.owner
  JOIN records t ON t.owner=r.owner AND t.id=r.ticket_id AND t.kind='ticket'
  WHERE r.id=? AND r.owner=? AND a.status='approved' AND a.expires_at>${SQL_NOW} AND a.run_id=r.id
    AND a.ticket_revision=r.ticket_revision AND a.scope=? AND a.budget=? AND a.operations=?
    AND t.revision=r.ticket_revision AND t.body=r.ticket_body)`, values: [p.runId, p.owner, JSON.stringify(grant.scope), JSON.stringify(grant.budget), JSON.stringify(grant.operations)] };
}
const historical = (p: WorkerPrincipal): SqlGuard => ({ sql: 'EXISTS(SELECT 1 FROM execution_permits WHERE owner=? AND run_id=? AND authorization_id=?)', values: [p.owner, p.runId, p.authorizationId] });
export async function claimExecution(db: ExecutionDatabase, p: WorkerPrincipal, input: ClaimInput, extra: Partial<AuthorizationContext> = {}) {
    exactObject(input, ['runId', 'requestId', 'leaseId', 'verifier', 'mode']);
    scope(p, input.runId);
    boundedId(input.requestId);
    boundedId(input.leaseId);
    verifier(input.verifier);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.leaseId) || !['execute', 'reconcile'].includes(input.mode))
        invalid();
    input = { ...input };
    await assertWorkerCurrent(db, p);
    const actionGuard = input.mode === 'execute' ? await executeGuard(db, p, extra) : historical(p);
    const guard = combine(credentialGuard(p), actionGuard);
    const key = await sha256(canonical(input));
    const previous = await db.prepare('SELECT * FROM execution_leases WHERE credential_id=? AND request_id=?').bind(p.credentialId, input.requestId).first<LeaseRow>();
    if (previous) {
        if (previous.input_key !== key)
            throw new ExecutionError('IDEMPOTENCY_CONFLICT', 'Claim request changed', 409);
        await checkGuard(db, combine(leaseGuard(p, previous), actionGuard));
        return publicLease(previous);
    }
    const now = Date.now();
    const guarded = guardedDatabase(db, guard);
    await guarded.batch([db.prepare(`INSERT OR IGNORE INTO execution_leases(id,owner,run_id,credential_id,principal_id,generation,mode,verifier,request_id,input_key,created_at,expires_at)
  SELECT ?,?,?,?,?,COALESCE((SELECT MAX(generation) FROM execution_leases WHERE owner=? AND run_id=?),0)+1,?,?,?,?,?,MIN(?,(SELECT expires_at FROM execution_worker_credentials WHERE id=?))
  WHERE NOT EXISTS(SELECT 1 FROM execution_leases WHERE owner=? AND run_id=? AND expires_at>${SQL_NOW})
  AND (SELECT COUNT(*) FROM execution_leases WHERE credential_id=?)<256 AND (SELECT COUNT(*) FROM execution_leases WHERE owner=?)<4096`)
            .bind(input.leaseId, p.owner, p.runId, p.credentialId, p.actor, p.owner, p.runId, input.mode, input.verifier, input.requestId, key, now, now + LEASE_MS, p.credentialId, p.owner, p.runId, p.credentialId, p.owner)]);
    const row = await db.prepare('SELECT * FROM execution_leases WHERE credential_id=? AND request_id=?').bind(p.credentialId, input.requestId).first<LeaseRow>();
    if (!row || row.input_key !== key)
        throw conflict();
    await checkGuard(db, leaseGuard(p, row));
    return publicLease(row);
}
async function authority(db: ExecutionDatabase, p: WorkerPrincipal, input: LeaseInput, action: string, extra: Partial<AuthorizationContext> = {}) {
    scope(p, input.runId);
    boundedId(input.requestId);
    if (typeof input.leaseToken !== 'string' || input.leaseToken.length > 256)
        invalid();
    const match = /^athl1\.([a-zA-Z0-9_-]{1,128})\.([1-9][0-9]{0,8})\.([a-zA-Z0-9_-]{43})$/.exec(input.leaseToken);
    if (!match || !/[AEIMQUYcgkosw048]$/.test(match[3]))
        throw denied();
    await assertWorkerCurrent(db, p);
    const row = await db.prepare('SELECT * FROM execution_leases WHERE id=?').bind(match[1]).first<LeaseRow>();
    if (!row || row.generation !== Number(match[2]) || row.verifier !== await sha256(match[3]))
        throw denied();
    if (row.mode === 'reconcile' && !['complete', 'cancel'].includes(action))
        throw denied();
    let guard = leaseGuard(p, row);
    if (['start', 'renew'].includes(action))
        guard = combine(guard, await executeGuard(db, p, extra));
    if (action === 'report')
        guard = combine(guard, { sql: "EXISTS(SELECT 1 FROM execution_runs WHERE owner=? AND id=? AND state IN ('queued','running','waiting'))", values: [p.owner, p.runId] });
    if (row.mode === 'reconcile')
        guard = combine(guard, historical(p));
    await checkGuard(db, guard);
    return { row, guard, db: guardedDatabase(db, guard) };
}
interface ActionRow {
    input_key: string;
    response: string | null;
}
async function begin(db: ExecutionDatabase, l: LeaseRow, input: LeaseInput, action: string, extra: Record<string, unknown> = {}) {
    // Secrets are excluded even from irreversible hashes of public request bindings.
    const key = await sha256(canonical({ runId: input.runId, requestId: input.requestId, leaseId: l.id, generation: l.generation, action, ...extra }));
    await db.prepare(`INSERT OR IGNORE INTO execution_worker_actions(lease_id,request_id,input_key,action,created_at)
  SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM execution_worker_actions WHERE lease_id=?)<256`).bind(l.id, input.requestId, key, action, Date.now(), l.id).run();
    const row = await db.prepare('SELECT input_key,response FROM execution_worker_actions WHERE lease_id=? AND request_id=?').bind(l.id, input.requestId).first<ActionRow>();
    if (!row || row.input_key !== key)
        throw new ExecutionError('IDEMPOTENCY_CONFLICT', 'Action request changed or limit reached', 409);
    return row.response === null ? null : JSON.parse(row.response);
}
async function finish(db: ExecutionDatabase, l: LeaseRow, requestId: string, response: unknown) {
    const encoded = canonical(response);
    if (new TextEncoder().encode(encoded).length > 524288)
        throw new ExecutionError('BODY_TOO_LARGE', 'Result exceeds bound', 413);
    await db.prepare('UPDATE execution_worker_actions SET response=? WHERE lease_id=? AND request_id=? AND response IS NULL').bind(encoded, l.id, requestId).run();
    const row = await db.prepare('SELECT response FROM execution_worker_actions WHERE lease_id=? AND request_id=?').bind(l.id, requestId).first<{
        response: string;
    }>();
    return JSON.parse(row!.response);
}
export async function renewExecution(db: ExecutionDatabase, p: WorkerPrincipal, input: LeaseInput, extra: Partial<AuthorizationContext> = {}) {
    exactObject(input, ['runId', 'leaseToken', 'requestId']);
    input = { ...input };
    const auth = await authority(db, p, input, 'renew', extra);
    const old = await begin(auth.db, auth.row, input, 'renew');
    if (old)
        return old;
    // One transaction records the exact returned expiry and updates the lease. Retry
    // therefore cannot extend authority twice after losing the first response.
    const expires = Math.min(Date.now() + LEASE_MS, p.expiresAt);
    const response = { ...publicLease(auth.row), expiresAt: expires };
    await auth.db.batch([
        db.prepare('UPDATE execution_worker_actions SET response=? WHERE lease_id=? AND request_id=? AND response IS NULL').bind(canonical(response), auth.row.id, input.requestId),
        db.prepare("UPDATE execution_leases SET expires_at=json_extract((SELECT response FROM execution_worker_actions WHERE lease_id=? AND request_id=?),'$.expiresAt') WHERE id=?").bind(auth.row.id, input.requestId, auth.row.id)
    ]);
    return JSON.parse((await db.prepare('SELECT response FROM execution_worker_actions WHERE lease_id=? AND request_id=?').bind(auth.row.id, input.requestId).first<{
        response: string;
    }>())!.response);
}
export async function reportExecution(db: ExecutionDatabase, p: WorkerPrincipal, input: LeaseInput & {
    message: string;
}) {
    exactObject(input, ['runId', 'leaseToken', 'requestId', 'message']);
    if (typeof input.message !== 'string' || input.message.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.message))
        invalid('Invalid progress');
    input = { ...input };
    const auth = await authority(db, p, input, 'report');
    const old = await begin(auth.db, auth.row, input, 'report', { message: input.message });
    if (old)
        return old;
    return finish(auth.db, auth.row, input.requestId, { accepted: true, requestId: input.requestId, message: input.message });
}
async function backendAction(db: ExecutionDatabase, p: WorkerPrincipal, input: LeaseInput, env: BackendEnvironment, action: 'start' | 'complete' | 'cancel') {
    exactObject(input, ['runId', 'leaseToken', 'requestId']);
    input = { ...input };
    const extra = action === 'start' ? { registry: configuredRegistry(env) } : {};
    const auth = await authority(db, p, input, action, extra);
    const old = await begin(auth.db, auth.row, input, action);
    if (old)
        return old;
    let result;
    if (action === 'complete') {
        result = await reconcileBackend(auth.db, context(p), env, p.runId);
        if (!result.backend?.receipts.some(r => r.claims.purpose === 'result'))
            throw new ExecutionError('INVALID_EVIDENCE', 'Trusted backend result not ready', 409);
    }
    else {
        const response = await handleBackendRequest(auth.db, context(p, extra), new Request('http://worker.local/api/execution/dispatch', { method: 'POST', headers: { origin: 'http://worker.local', 'content-type': 'application/json' }, body: JSON.stringify({ action, runId: p.runId }) }), env);
        if (!response.ok) {
            const e = await response.json() as {
                code?: string;
            };
            if (e.code === 'WORKER_AUTHORITY_EXPIRED')
                throw denied();
            throw new ExecutionError('DISPATCH_CONFLICT', 'Backend action unavailable', response.status === 503 ? 503 : 409);
        }
        result = await response.json();
    }
    return finish(auth.db, auth.row, input.requestId, result);
}
export const startExecution = (db: ExecutionDatabase, p: WorkerPrincipal, input: LeaseInput, env: BackendEnvironment) => backendAction(db, p, input, env, 'start');
export const completeExecution = (db: ExecutionDatabase, p: WorkerPrincipal, input: LeaseInput, env: BackendEnvironment) => backendAction(db, p, input, env, 'complete');
export const cancelExecution = (db: ExecutionDatabase, p: WorkerPrincipal, input: LeaseInput, env: BackendEnvironment) => backendAction(db, p, input, env, 'cancel');
/** Query is side-effect-free: historical reconciliation is an explicit leased write. */
export async function getExecutionRun(db: ExecutionDatabase, p: WorkerPrincipal, runId: string) { scope(p, runId); await assertWorkerCurrent(db, p); return { run: await getRun(db, p.owner, runId), permit: await permitForRun(db, p.owner, runId).then(r => r ? { permitId: r.id, deadlineMs: r.deadline_ms, cancelRequested: !!r.cancel_requested, closedAt: r.closed_at } : null) }; }
