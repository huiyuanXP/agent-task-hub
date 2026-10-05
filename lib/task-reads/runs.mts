import { taskPageBudget } from './bounds.mts';
import type { OperationDefinition } from '../execution/authorization-types.mts';
import { validateScope, validateBudget } from '../execution/authorization-validation.mts';
import { getAuthorization } from '../execution/authorization.mts';
import { ExecutionError, positiveInteger } from '../execution/errors.mts';
import { sha256 } from '../execution/evidence.mts';
import type { ExecutionDatabase } from '../execution/types.mts';
import { decodeCursor, makePage, type CursorContext } from './cursor.mts';
import { safeBody } from './dto.mts';
import { requireRecord } from './queries.mts';
import type { ListInput } from './validation.mts';
export type TrustedRegistry = () => readonly OperationDefinition[];
interface ReadRunRow {
  id: string; created: string; updated: string; source: 'manual' | 'execution'; state: string;
  body: string; record_revision: number | null; ticket_id: string; ticket_revision: number | null;
  authorization_id: string | null; attempt: number | null; version: number | null; evidence: string | null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parsed(value: string): Record<string, unknown> { return object(JSON.parse(value)) ?? {}; }
async function authorizationDTO(db: ExecutionDatabase, owner: string, row: ReadRunRow, registry: TrustedRegistry) {
  if (!row.authorization_id) return null;
  // Check ownership and the complete binding before resolving optional configuration.
  const bound = await db.prepare(`SELECT id FROM execution_authorizations
    WHERE owner=? AND id=? AND run_id=? AND ticket_id=? AND ticket_revision=?`)
    .bind(owner, row.authorization_id, row.id, row.ticket_id, row.ticket_revision).first<{ id: string }>();
  if (!bound) return null;
  let trusted: readonly OperationDefinition[];
  try { trusted = registry(); }
  catch { throw new ExecutionError('CONFIGURATION_UNAVAILABLE', 'Execution configuration unavailable', 503); }
  try {
    const grant = await getAuthorization(db, { owner, actor: owner, registry: trusted }, bound.id);
    if (grant.runId !== row.id || grant.ticketId !== row.ticket_id || grant.ticketRevision !== row.ticket_revision) return null;
    const scope = grant.scope.map(({ operationId, definitionHash }) => ({ operationId, definitionHash }));
    const budget = { timeoutMs: grant.budget.timeoutMs, memoryMb: grant.budget.memoryMb, cpus: grant.budget.cpus, pids: grant.budget.pids };
    try { validateScope(scope); validateBudget(budget); positiveInteger(grant.expiresAt); }
    catch { throw new ExecutionError('STORAGE_UNAVAILABLE', 'Task storage unavailable', 503); }
    return { id: grant.id, run_id: grant.runId, ticket_id: grant.ticketId, ticket_revision: grant.ticketRevision,
      status: grant.status, effective_status: grant.effectiveStatus, expires_at: grant.expiresAt,
      scope, budget };
  } catch (error) {
    if (error instanceof ExecutionError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function stream(value: unknown) {
  const s = object(value);
  return s && hash(s.sha256) && integer(s.bytes) && typeof s.truncated === 'boolean'
    ? { sha256: s.sha256, bytes: s.bytes, truncated: s.truncated } : null;
}
/** Persisted, previously ingested claims only; never expose signing or dispatch authority. */
function evidenceDTO(raw: string | null, owner: string, row: ReadRunRow, contractHash: string) {
  if (!raw) return null;
  const claims = object(parsed(raw).claims);
  if (!claims || claims.owner !== owner || claims.runId !== row.id || claims.ticketId !== row.ticket_id ||
    claims.ticketRevision !== row.ticket_revision || claims.attempt !== row.attempt || claims.authorizationId !== row.authorization_id ||
    claims.contractSha256 !== contractHash || ![1, 2].includes(claims.version as number)) return null;
  const artifacts = Array.isArray(claims.artifacts) ? claims.artifacts.slice(0, 32).flatMap(value => {
    const a = object(value);
    return a && typeof a.path === 'string' && a.path.length <= 256 && hash(a.sha256) && integer(a.bytes)
      ? [{ path: a.path, sha256: a.sha256, bytes: a.bytes }] : [];
  }) : [];
  const common = { version: claims.version, contract_sha256: contractHash, artifacts,
    exit_code: integer(claims.exitCode) ? claims.exitCode : null };
  if (claims.version === 1) {
    if (claims.status !== 'succeeded') return null;
    return { ...common, status: 'succeeded',
      stdout_sha256: hash(claims.stdoutSha256) ? claims.stdoutSha256 : null,
      stderr_sha256: hash(claims.stderrSha256) ? claims.stderrSha256 : null,
      started_at: typeof claims.startedAt === 'string' ? claims.startedAt : null,
      ended_at: typeof claims.endedAt === 'string' ? claims.endedAt : null };
  }
  if (!['result', 'cancel_fence', 'stop'].includes(claims.purpose as string) ||
    !['succeeded', 'command_failed', 'startup_failed', 'timed_out', 'cancelled', 'evidence_unavailable', 'stopped'].includes(claims.status as string)) return null;
  return { ...common, purpose: claims.purpose, status: claims.status,
    started_at: integer(claims.startedAt) ? claims.startedAt : null,
    ended_at: integer(claims.endedAt) ? claims.endedAt : null,
    captured_at: integer(claims.capturedAt) ? claims.capturedAt : null,
    observed_at: integer(claims.observedAt) ? claims.observedAt : null,
    stdout: stream(claims.stdout), stderr: stream(claims.stderr),
    closure: claims.closure === 'removed' || claims.closure === 'never_admitted' ? claims.closure : null };
}
async function runDTO(db: ExecutionDatabase, owner: string, row: ReadRunRow, registry: TrustedRegistry) {
  if (row.source === 'manual') {
    const body = parsed(row.body), contract = object(body.contract);
    return { ...safeBody(body), id: row.id, kind: 'run', revision: row.record_revision, created: row.created, updated: row.updated,
      ticket_id: row.ticket_id, source: 'manual', state: 'snapshot', contract: contract ? safeBody(contract) : null, authorization: null };
  }
  const contractHash = await sha256(row.body);
  // At most three purposes per permit; unique owner/Run permit bounds this collection.
  // Both sides of the join independently match the verified owner and the owned Run/Ticket.
  const receipts = await db.prepare(`SELECT a.receipt FROM backend_attestations a JOIN execution_permits p ON p.id=a.permit_id
    WHERE a.owner=? AND p.owner=? AND p.run_id=? AND p.ticket_id=? AND p.authorization_id=?
    ORDER BY a.purpose LIMIT 3`).bind(owner, owner, row.id, row.ticket_id, row.authorization_id).all<{ receipt: string }>();
  return { id: row.id, source: 'execution', state: row.state, ticket_id: row.ticket_id, ticket_revision: row.ticket_revision,
    attempt: row.attempt, version: row.version, created: row.created, updated: row.updated, contract: safeBody(parsed(row.body)),
    evidence: evidenceDTO(row.evidence, owner, row, contractHash),
    attestations: receipts.results.map(({ receipt }) => evidenceDTO(receipt, owner, row, contractHash)).filter(value => value !== null),
    authorization: await authorizationDTO(db, owner, row, registry) };
}
export async function listTicketRuns(db: ExecutionDatabase, owner: string, input: ListInput, registry: TrustedRegistry, byteBudget = taskPageBudget()) {
  const ticketId = input.filters.ticket_id;
  await requireRecord(db, owner, 'ticket', ticketId);
  const context: CursorContext = { owner, resource: 'ticket_runs', filters: input.filters };
  const cursor = await decodeCursor(input.cursor, context);
  const clauses: string[] = [], params: (string | number)[] = [owner, ticketId, owner, ticketId];
  for (const key of ['source', 'state']) if (key in input.filters) { clauses.push(`${key}=?`); params.push(input.filters[key]); }
  if (cursor) {
    clauses.push('(created<? OR (created=? AND (id<? OR (id=? AND source<?))))');
    params.push(cursor.created, cursor.created, cursor.id, cursor.id, cursor.source!);
  }
  const result = await db.prepare(`SELECT * FROM (
    SELECT id,created,updated,'manual' AS source,'snapshot' AS state,body,revision AS record_revision,
      json_extract(body,'$.ticketId') AS ticket_id,NULL AS ticket_revision,NULL AS authorization_id,NULL AS attempt,NULL AS version,NULL AS evidence
    FROM records WHERE owner=? AND kind='run' AND json_type(body,'$.ticketId')='text' AND json_extract(body,'$.ticketId')=?
    UNION ALL
    SELECT id,created,updated,'execution' AS source,state,ticket_body AS body,NULL AS record_revision,
      ticket_id,ticket_revision,authorization_id,attempt,version,evidence
    FROM execution_runs WHERE owner=? AND ticket_id=?
  ) ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY created DESC,id DESC,source DESC LIMIT ?`)
    .bind(...params, input.limit + 1).all<ReadRunRow>();
  return makePage(result.results, input.limit, context, row => runDTO(db, owner, row, registry), byteBudget);
}
