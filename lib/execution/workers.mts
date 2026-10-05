import type { ExecutionDatabase } from './types.mts';
import type { WorkerIssuer, WorkerConfiguration, WorkerPrincipal, WorkerRow, ProvisionWorkerInput } from './worker-types.mts';
import { boundedId, exactObject, ExecutionError, invalid } from './errors.mts';
import { sha256 } from './evidence.mts';
import { canonical } from './transport.mts';
import { getRun } from './runs.mts';
import { credentialGuard, checkGuard, SQL_NOW, denied } from './worker-guard.mts';
export const MAX_WORKER_LIFETIME = 900000;
export function verifier(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    invalid('Invalid verifier'); }
function owner(context: WorkerIssuer) { if (context.grantAuthority !== 'owner')
    throw denied(); boundedId(context.owner, 256); boundedId(context.actor, 256); }
function publicWorker(r: WorkerRow) { return { credentialId: r.id, issuedBy: r.issued_by, workerId: r.principal_id, runId: r.run_id, ticketId: r.ticket_id, ticketRevision: r.ticket_revision, attempt: r.attempt, authorizationId: r.authorization_id, label: r.label, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, revokedBy: r.revoked_by }; }
function compatible(r: WorkerRow, c: WorkerConfiguration) {
    return r.mode === c.mode && r.origin === c.origin && (c.mode === 'trusted-sites' || (r.issuer === c.issuer && r.audience === c.audience && c.allowedEmails?.includes(r.email)));
}
export async function provisionWorker(db: ExecutionDatabase, context: WorkerIssuer, input: ProvisionWorkerInput) {
    owner(context);
    exactObject(input, ['credentialId', 'requestId', 'runId', 'verifier', 'label']);
    boundedId(input.credentialId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.credentialId))
        invalid();
    boundedId(input.requestId);
    boundedId(input.runId);
    verifier(input.verifier);
    if (typeof input.label !== 'string' || input.label.length > 120 || /[\x00-\x1f\x7f]/.test(input.label))
        invalid('Invalid worker label');
    input = { ...input };
    context = { ...context };
    const key = await sha256(canonical(input));
    const run = await getRun(db, context.owner, input.runId);
    const now = Date.now();
    const expires = Math.min(now + MAX_WORKER_LIFETIME, context.expiresAt ?? now + MAX_WORKER_LIFETIME);
    if (expires <= now || (context.mode === 'access' && (!context.tokenHash || !context.issuer || !context.audience || !context.allowedEmails?.includes(context.email))))
        throw denied();
    const previous = await db.prepare('SELECT * FROM execution_worker_credentials WHERE owner=? AND request_id=?').bind(context.owner, input.requestId).first<WorkerRow>();
    if (previous) {
        if (previous.input_key !== key)
            throw new ExecutionError('IDEMPOTENCY_CONFLICT', 'Provision request changed', 409);
        if (!compatible(previous, context) || previous.revoked_at !== null || previous.expires_at <= now)
            throw denied();
        if (previous.token_hash !== (context.tokenHash ?? null))
            throw denied();
        await assertWorkerCurrent(db, principal(previous, context));
        return publicWorker(previous);
    }
    await db.batch([
        db.prepare(`INSERT OR IGNORE INTO execution_worker_credentials
   (id,owner,issued_by,principal_id,run_id,ticket_id,ticket_revision,attempt,authorization_id,verifier,label,request_id,input_key,mode,origin,issuer,audience,email,token_hash,created_at,expires_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
   WHERE (SELECT COUNT(*) FROM execution_worker_credentials WHERE owner=?)<256
   AND (SELECT COUNT(*) FROM execution_worker_credentials WHERE owner=? AND revoked_at IS NULL AND expires_at>${SQL_NOW})<32
   AND (SELECT COUNT(*) FROM execution_worker_credentials WHERE owner=? AND run_id=? AND revoked_at IS NULL AND expires_at>${SQL_NOW})<4
   AND ?>${SQL_NOW} AND NOT EXISTS(SELECT 1 FROM auth_revocations WHERE token_hash=?)`)
            .bind(input.credentialId, context.owner, context.actor, 'worker:' + crypto.randomUUID(), run.id, run.ticketId, run.ticketRevision, run.attempt, run.authorizationId, input.verifier, input.label, input.requestId, key, context.mode, context.origin, context.issuer ?? null, context.audience ?? null, context.email, context.tokenHash ?? null, now, expires, context.owner, context.owner, context.owner, run.id, expires, context.tokenHash ?? null)
    ]);
    const row = await db.prepare('SELECT * FROM execution_worker_credentials WHERE owner=? AND request_id=?').bind(context.owner, input.requestId).first<WorkerRow>();
    if (!row || row.input_key !== key)
        throw new ExecutionError('DELEGATION_CONFLICT', 'Delegation changed or finite issuance limit reached', 409);
    return publicWorker(row);
}
function principal(r: WorkerRow, configuration: WorkerConfiguration): WorkerPrincipal { return { kind: 'execution_worker', user: null, owner: r.owner, actor: r.principal_id, credentialId: r.id, runId: r.run_id, ticketId: r.ticket_id, ticketRevision: r.ticket_revision, attempt: r.attempt, authorizationId: r.authorization_id, expiresAt: r.expires_at, configuration: { ...configuration, allowedEmails: configuration.allowedEmails ? [...configuration.allowedEmails] : undefined } }; }
export async function assertWorkerCurrent(db: ExecutionDatabase, p: WorkerPrincipal) {
    const row = await db.prepare('SELECT * FROM execution_worker_credentials WHERE id=?').bind(p.credentialId).first<WorkerRow>();
    if (!row || !compatible(row, p.configuration))
        throw denied();
    await checkGuard(db, credentialGuard(p));
}
export async function authenticateWorker(db: ExecutionDatabase, token: string, config: WorkerConfiguration): Promise<WorkerPrincipal> {
    const match = /^athw1\.([a-zA-Z0-9_-]{1,128})\.([a-zA-Z0-9_-]{43})$/.exec(token);
    if (!match || !/[AEIMQUYcgkosw048]$/.test(match[2]))
        throw denied();
    const row = await db.prepare('SELECT * FROM execution_worker_credentials WHERE id=?').bind(match[1]).first<WorkerRow>();
    if (!row || row.verifier !== await sha256(match[2]) || !compatible(row, config))
        throw denied();
    const p = principal(row, config);
    await assertWorkerCurrent(db, p);
    return p;
}
export async function listWorkers(db: ExecutionDatabase, context: WorkerIssuer) { owner(context); return (await db.prepare('SELECT * FROM execution_worker_credentials WHERE owner=? ORDER BY created_at DESC LIMIT 256').bind(context.owner).all<WorkerRow>()).results.map(publicWorker); }
export async function revokeWorker(db: ExecutionDatabase, context: WorkerIssuer, input: {
    credentialId: string;
    requestId: string;
}) {
    owner(context);
    exactObject(input, ['credentialId', 'requestId']);
    boundedId(input.credentialId);
    boundedId(input.requestId);
    await db.prepare(`UPDATE execution_worker_credentials SET revoked_at=?,revoked_by=?,revoke_request_id=? WHERE id=? AND owner=? AND revoked_at IS NULL`).bind(Date.now(), context.actor, input.requestId, input.credentialId, context.owner).run();
    const row = await db.prepare('SELECT * FROM execution_worker_credentials WHERE id=? AND owner=?').bind(input.credentialId, context.owner).first<WorkerRow>();
    if (!row)
        throw new ExecutionError('NOT_FOUND', 'Delegation not found', 404);
    if (row.revoke_request_id !== input.requestId)
        throw new ExecutionError('IDEMPOTENCY_CONFLICT', 'Revocation request changed', 409);
    return publicWorker(row);
}
