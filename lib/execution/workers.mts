import type { LocalDatabase } from '../database.mts';
import { boundedId, exactObject, ExecutionError, invalid, positiveInteger } from './errors.mts';
import { issuerAuthorizationPredicate, SQL_NOW, WORKER_CREDENTIAL_ID } from './worker-auth.mts';
import { guardedIssuerDatabase } from './worker-guard.mts';
import type { WorkerCredential, WorkerCredentialRow, WorkerIssuer } from './worker-types.mts';

const deny = (): never => { throw new ExecutionError('AUTHORIZATION_DENIED', 'Worker authorization denied', 403); };
const conflict = (): never => { throw new ExecutionError('REQUEST_CONFLICT', 'Worker request ID already used with different input', 409); };
function credentialId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !WORKER_CREDENTIAL_ID.test(value)) invalid('Invalid Worker credential ID');
}
function requestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) invalid('Invalid request ID');
}
function safe(row: WorkerCredentialRow): WorkerCredential {
  return { credentialId: row.credential_id, runId: row.run_id, project: row.project,
    ticketId: row.ticket_id, ticketRevision: row.ticket_revision, attempt: row.attempt,
    authorizationId: row.authorization_id, label: row.label, createdAt: row.created_at,
    expiresAt: row.expires_at, revokedAt: row.revoked_at };
}
async function assertIssuer(db: LocalDatabase, issuer: WorkerIssuer) {
  const predicate = issuerAuthorizationPredicate(issuer);
  if (!await db.prepare(`SELECT 1 AS valid WHERE ${predicate.sql}`).bind(...predicate.values).first()) deny();
}
function replay(row: WorkerCredentialRow, key: string) {
  if (row.input_key !== key) conflict();
  if (row.revoked_at !== null || row.expires_at <= Date.now()) deny();
  return safe(row);
}
export async function provisionWorker(db: LocalDatabase, issuer: WorkerIssuer, input: unknown): Promise<WorkerCredential> {
  exactObject(input, ['credentialId', 'requestId', 'runId', 'verifier', 'label']);
  credentialId(input.credentialId); requestId(input.requestId); boundedId(input.runId);
  if (typeof input.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(input.verifier)) invalid('Invalid Worker verifier');
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120 || /[\u0000-\u001f\u007f]/.test(input.label)) invalid('Invalid Worker label');
  const args = { credentialId: input.credentialId, requestId: input.requestId, runId: input.runId, verifier: input.verifier, label: input.label };
  issuer = { ...issuer };
  const key = JSON.stringify([args.credentialId, args.requestId, args.runId, args.verifier, args.label,
    issuer.owner, issuer.actor, issuer.origin, issuer.issuerTokenHash, issuer.issuerExpiresAt]);
  await assertIssuer(db, issuer);
  const previous = await db.prepare('SELECT * FROM execution_worker_credentials WHERE owner=? AND request_id=?').bind(issuer.owner, args.requestId).first<WorkerCredentialRow>();
  if (previous) { await assertIssuer(db, issuer); return replay(previous, key); }
  const guarded = guardedIssuerDatabase(db, issuer);
  // Native BEGIN IMMEDIATE serializes capacity checks with insert; no JS pre-count.
  await guarded.batch([guarded.prepare(`INSERT INTO execution_worker_credentials
    (credential_id,owner,actor,origin,issuer_token_hash,issuer_expires_at,run_id,project,ticket_id,ticket_revision,
      attempt,authorization_id,verifier,label,request_id,input_key,created_at,expires_at)
    SELECT ?,r.owner,?,?,?,?,r.id,COALESCE(NULLIF(json_extract(r.ticket_body,'$.project'),''),'通用'),
      r.ticket_id,r.ticket_revision,r.attempt,r.authorization_id,?,?,?,?,${SQL_NOW},MIN(${SQL_NOW}+900000,?)
    FROM execution_runs r WHERE r.id=? AND r.owner=? AND ?>${SQL_NOW}
      AND (SELECT COUNT(*) FROM execution_worker_credentials w JOIN local_tokens t ON t.token_hash=w.issuer_token_hash AND t.owner=w.owner
        JOIN local_users u ON u.id=w.owner WHERE w.owner=? AND w.revoked_at IS NULL AND w.expires_at>${SQL_NOW}
          AND t.expires_at>=w.issuer_expires_at AND t.expires_at>${SQL_NOW})<16
    ON CONFLICT DO NOTHING`).bind(args.credentialId, issuer.actor, issuer.origin, issuer.issuerTokenHash,
      issuer.issuerExpiresAt, args.verifier, args.label, args.requestId, key, issuer.issuerExpiresAt,
      args.runId, issuer.owner, issuer.issuerExpiresAt, issuer.owner)]);
  await assertIssuer(db, issuer);
  const row = await db.prepare('SELECT * FROM execution_worker_credentials WHERE owner=? AND request_id=?').bind(issuer.owner, args.requestId).first<WorkerCredentialRow>();
  if (row) return replay(row, key);
  if (!await db.prepare('SELECT id FROM execution_runs WHERE id=? AND owner=?').bind(args.runId, issuer.owner).first()) {
    throw new ExecutionError('NOT_FOUND', 'Run not found', 404);
  }
  if (await db.prepare('SELECT credential_id FROM execution_worker_credentials WHERE credential_id=?').bind(args.credentialId).first()) conflict();
  return deny();
}
export async function listWorkers(db: LocalDatabase, issuer: WorkerIssuer, input: unknown = {}): Promise<WorkerCredential[]> {
  exactObject(input, ['limit']);
  const limit = input.limit ?? 50; positiveInteger(limit);
  if (limit > 100) invalid('Maximum list limit is 100');
  issuer = { ...issuer };
  await assertIssuer(db, issuer);
  const { results } = await db.prepare('SELECT * FROM execution_worker_credentials WHERE owner=? ORDER BY created_at DESC,credential_id DESC LIMIT ?')
    .bind(issuer.owner, limit).all<WorkerCredentialRow>();
  await assertIssuer(db, issuer);
  return results.map(safe);
}
export async function revokeWorker(db: LocalDatabase, issuer: WorkerIssuer, input: unknown): Promise<WorkerCredential> {
  exactObject(input, ['credentialId', 'requestId']);
  credentialId(input.credentialId); requestId(input.requestId);
  const id = input.credentialId, request = input.requestId;
  issuer = { ...issuer };
  await assertIssuer(db, issuer);
  const guarded = guardedIssuerDatabase(db, issuer);
  // A stable owner revocation request belongs to exactly one credential forever.
  await guarded.batch([guarded.prepare(`UPDATE execution_worker_credentials SET revoked_at=${SQL_NOW},revoke_request_id=?
    WHERE credential_id=? AND owner=? AND revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM execution_worker_credentials WHERE owner=? AND revoke_request_id=?)`)
    .bind(request, id, issuer.owner, issuer.owner, request)]);
  await assertIssuer(db, issuer);
  const row = await db.prepare('SELECT * FROM execution_worker_credentials WHERE credential_id=? AND owner=?').bind(id, issuer.owner).first<WorkerCredentialRow>();
  if (!row) throw new ExecutionError('NOT_FOUND', 'Worker credential not found', 404);
  if (row.revoke_request_id !== request) conflict();
  return safe(row);
}
