import { createHash, timingSafeEqual } from 'node:crypto';
import type { LocalDatabase, SqlValue } from '../database.mts';
import { authenticateHeaders, AuthError, checkRequestOrigin, configuredOrigin, readCredential } from '../local-auth.mts';
import type { WorkerCredentialRow, WorkerIssuer, WorkerPrincipal } from './worker-types.mts';

export const SQL_NOW = "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export const WORKER_CREDENTIAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function issuerAuthorizationPredicate(issuer: WorkerIssuer): { sql: string; values: SqlValue[] } {
  return { sql: `EXISTS(SELECT 1 FROM local_users u JOIN local_tokens t ON t.owner=u.id
    WHERE u.id=? AND t.owner=? AND t.token_hash=? AND t.expires_at>=? AND t.expires_at>${SQL_NOW})
    AND ?>${SQL_NOW}`,
    values: [issuer.owner, issuer.owner, issuer.issuerTokenHash, issuer.issuerExpiresAt, issuer.issuerExpiresAt] };
}
export function workerAuthorizationPredicate(principal: WorkerPrincipal): { sql: string; values: SqlValue[] } {
  const issuer = issuerAuthorizationPredicate(principal);
  return { sql: `(${issuer.sql}) AND EXISTS(SELECT 1 FROM execution_worker_credentials w
    JOIN execution_runs r ON r.id=w.run_id AND r.owner=w.owner
    WHERE w.credential_id=? AND w.owner=? AND w.actor=? AND w.origin=? AND w.issuer_token_hash=?
      AND w.issuer_expires_at=? AND w.expires_at=? AND w.expires_at>${SQL_NOW} AND w.revoked_at IS NULL
      AND w.verifier=? AND w.run_id=? AND w.project=? AND w.ticket_id=? AND w.ticket_revision=?
      AND w.attempt=? AND w.authorization_id=?
      AND r.ticket_id=w.ticket_id AND r.ticket_revision=w.ticket_revision AND r.attempt=w.attempt
      AND r.authorization_id=w.authorization_id
      AND COALESCE(NULLIF(json_extract(r.ticket_body,'$.project'),''),'通用')=w.project)`,
    values: [...issuer.values, principal.credentialId, principal.owner, principal.actor, principal.origin,
      principal.issuerTokenHash, principal.issuerExpiresAt, principal.expiresAt, principal.verifier,
      principal.runId, principal.project, principal.ticketId, principal.ticketRevision, principal.attempt, principal.authorizationId] };
}
export async function resolveWorkerIssuer(db: LocalDatabase, headers: Headers, method: string, origin = configuredOrigin()): Promise<WorkerIssuer> {
  // Keep native conflict, token-kind, exact Host/Origin and account lifecycle checks.
  const session = await authenticateHeaders(db, headers, method, origin);
  const credential = readCredential(headers);
  if (!session || !credential) throw new AuthError(401, 'Authentication required');
  const issuer = { owner: session.user.userId, actor: session.user.userId, origin,
    issuerTokenHash: sha256(credential.token), issuerExpiresAt: session.expiresAt };
  const predicate = issuerAuthorizationPredicate(issuer);
  const current = await db.prepare(`SELECT 1 AS valid WHERE ${predicate.sql}`).bind(...predicate.values).first();
  if (!current) throw new AuthError(401, 'Authentication required');
  return issuer;
}
export async function authenticateWorkerHeaders(db: LocalDatabase, headers: Headers, method: string, origin = configuredOrigin()): Promise<WorkerPrincipal> {
  if (headers.has('cookie')) throw new AuthError(401, 'Worker bearer authentication required');
  checkRequestOrigin(headers, method, origin, 'bearer');
  const match = /^Bearer athw1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(headers.get('authorization') ?? '');
  if (!match || !WORKER_CREDENTIAL_ID.test(match[1])) throw new AuthError(401, 'Worker bearer authentication required');
  const row = await db.prepare('SELECT * FROM execution_worker_credentials WHERE credential_id=?').bind(match[1]).first<WorkerCredentialRow>();
  const verifier = sha256(match[2]);
  if (!row || !/^[0-9a-f]{64}$/.test(row.verifier) || !timingSafeEqual(Buffer.from(verifier, 'hex'), Buffer.from(row.verifier, 'hex'))) {
    throw new AuthError(401, 'Worker bearer authentication required');
  }
  const principal: WorkerPrincipal = { credentialId: row.credential_id, owner: row.owner, actor: row.actor, origin,
    issuerTokenHash: row.issuer_token_hash, issuerExpiresAt: row.issuer_expires_at, expiresAt: row.expires_at,
    runId: row.run_id, project: row.project, ticketId: row.ticket_id, ticketRevision: row.ticket_revision,
    attempt: row.attempt, authorizationId: row.authorization_id, verifier };
  const predicate = workerAuthorizationPredicate(principal);
  if (!await db.prepare(`SELECT 1 AS valid WHERE ${predicate.sql}`).bind(...predicate.values).first()) {
    throw new AuthError(401, 'Worker bearer authentication required');
  }
  return principal;
}
