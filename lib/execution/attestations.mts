import type { ExecutionDatabase, EvidenceArtifact, EvidenceTrust, RunContext } from './types.mts';
import type { DispatchPermit, PermitRow } from './dispatch-types.mts';
import { canonical, verifyClaims, type Signed } from './transport.mts';
import { sha256 } from './evidence.mts';
import { exactObject, ExecutionError } from './errors.mts';
export interface StreamEvidence { sha256: string; bytes: number; truncated: boolean }
export interface BackendClaims {
  version: 2; purpose: 'result' | 'cancel_fence' | 'stop'; audience: 'control-plane'; keyId: string;
  owner: string; runId: string; ticketId: string; ticketRevision: number; attempt: number; authorizationId: string;
  contractSha256: string; permitId: string; permitSha256: string; operationId: string; definitionHash: string; deadlineMs: number; backendId: string;
  status: 'succeeded' | 'command_failed' | 'startup_failed' | 'timed_out' | 'cancelled' | 'evidence_unavailable' | 'stopped';
  process: { containerId: string; execId: string | null } | null; exitCode: number | null;
  startedAt: number | null; endedAt: number | null; capturedAt: number | null; observedAt: number;
  artifacts: EvidenceArtifact[]; stdout: StreamEvidence | null; stderr: StreamEvidence | null; closure: 'removed' | 'never_admitted' | null;
}
export type BackendAttestation = Signed<BackendClaims>;
const bad = () => new ExecutionError('INVALID_EVIDENCE','Verified bound backend attestation required',409);
function hash(value: unknown) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function stream(value: StreamEvidence | null) {
  if (value === null) return true;
  exactObject(value,['sha256','bytes','truncated']);
  return hash(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= 65536 && typeof value.truncated === 'boolean';
}
/** Historical evidence uses persisted permit authority, never live registry, grant or transport freshness. */
export async function verifyAttestation(receipt: BackendAttestation, permit: DispatchPermit, trust?: EvidenceTrust): Promise<boolean> {
  try {
    if (!trust || canonical(receipt).length > 16000) return false;
    const c = receipt.claims;
    exactObject(c,['version','purpose','audience','keyId','owner','runId','ticketId','ticketRevision','attempt','authorizationId','contractSha256','permitId','permitSha256','operationId','definitionHash','deadlineMs','backendId','status','process','exitCode','startedAt','endedAt','capturedAt','observedAt','artifacts','stdout','stderr','closure']);
    if (Object.keys(c).length !== 28 || c.version !== 2 || c.audience !== 'control-plane' || c.keyId !== trust.keyId ||
      !['result','cancel_fence','stop'].includes(c.purpose) || c.backendId !== 'ath-' + (await sha256(JSON.stringify([permit.owner,permit.runId,permit.attempt]))).slice(0,40) ||
      c.owner !== permit.owner || c.runId !== permit.runId || c.ticketId !== permit.ticketId || c.ticketRevision !== permit.ticketRevision || c.attempt !== permit.attempt ||
      c.authorizationId !== permit.authorizationId || c.contractSha256 !== permit.contractSha256 || c.permitId !== permit.permitId ||
      c.permitSha256 !== await sha256(canonical(permit)) || c.operationId !== permit.operation.operationId || c.definitionHash !== permit.operation.definitionHash || c.deadlineMs !== permit.deadlineMs) return false;
    if (!Number.isSafeInteger(c.observedAt) || c.observedAt < permit.issuedAt || c.observedAt > Date.now()+60000 ||
      ![c.startedAt,c.endedAt,c.capturedAt].every(v => v === null || (Number.isSafeInteger(v) && v >= permit.issuedAt && v <= c.observedAt)) ||
      (c.startedAt !== null && c.endedAt !== null && c.endedAt < c.startedAt) || !stream(c.stdout) || !stream(c.stderr) ||
      (c.exitCode !== null && (!Number.isSafeInteger(c.exitCode) || c.exitCode < 0 || c.exitCode > 255))) return false;
    if (c.process !== null) { exactObject(c.process,['containerId','execId']); if (!hash(c.process.containerId) || (c.process.execId !== null && !hash(c.process.execId))) return false; }
    if (!Array.isArray(c.artifacts) || c.artifacts.length > 32 || new Set(c.artifacts.map(a => a.path)).size !== c.artifacts.length) return false;
    for (const a of c.artifacts) { exactObject(a,['path','sha256','bytes']); const d = permit.operation.artifacts.find(d => d.path === a.path); if (!d || !hash(a.sha256) || !Number.isSafeInteger(a.bytes) || a.bytes < 0 || a.bytes > d.maxBytes) return false; }
    if (c.purpose === 'stop') { if (c.status !== 'stopped' || !['removed','never_admitted'].includes(c.closure!) || (c.closure === 'never_admitted' && (c.process !== null || c.startedAt !== null))) return false; }
    else if (c.closure !== null) return false;
    if (c.purpose === 'cancel_fence' && c.status !== 'cancelled') return false;
    if (c.purpose === 'result') {
      if (!['succeeded','command_failed','startup_failed','timed_out','cancelled','evidence_unavailable'].includes(c.status)) return false;
      if (c.status === 'succeeded' && (c.exitCode !== 0 || !c.process?.execId || c.startedAt === null || c.endedAt === null || c.capturedAt === null ||
        c.startedAt >= permit.deadlineMs || c.endedAt > permit.deadlineMs || c.capturedAt > permit.deadlineMs || c.capturedAt < c.endedAt || !c.stdout || !c.stderr || c.artifacts.length !== permit.operation.artifacts.length)) return false;
      if (c.status === 'startup_failed' && (c.startedAt !== null || c.exitCode !== null)) return false;
      if (c.status === 'command_failed' && (c.startedAt === null || c.exitCode === null || c.exitCode === 0)) return false;
    }
    return await verifyClaims(receipt,trust);
  } catch { return false; }
}
export async function ingestAttestation(db: ExecutionDatabase, context: RunContext, value: unknown): Promise<void> {
  let receipt: BackendAttestation; try { receipt = JSON.parse(canonical(value)); } catch { throw bad(); }
  context = { ...context, evidenceTrust: context.evidenceTrust ? { ...context.evidenceTrust } : undefined };
  const p = await db.prepare('SELECT * FROM execution_permits WHERE id=? AND owner=?').bind(receipt?.claims?.permitId ?? '',context.owner).first<PermitRow>();
  if (!p || !await verifyAttestation(receipt,JSON.parse(p.envelope),context.evidenceTrust)) throw bad();
  const c = receipt.claims, serialized = canonical(receipt), id = await sha256(serialized), now = Date.now();
  const existing = await db.prepare('SELECT id FROM backend_attestations WHERE permit_id=? AND purpose=?').bind(p.id,c.purpose).first<{id:string}>();
  if (existing) { if(existing.id !== id) throw bad(); return; }
  const statements = [db.prepare(`INSERT OR IGNORE INTO backend_attestations(id,permit_id,owner,purpose,receipt,received_at) VALUES (?,?,?,?,?,?)`).bind(id,p.id,context.owner,c.purpose,serialized,now)];
  const retained = 'EXISTS(SELECT 1 FROM backend_attestations WHERE id=?)';
  const update = (state: string, evidence: string | null, from: string) => db.prepare(`UPDATE execution_runs SET state=?,evidence=?,version=version+1,last_actor=?,updated=? WHERE owner=? AND id=? AND state IN (${from}) AND ${retained}`)
    .bind(state,evidence,context.actor,new Date(now).toISOString(),context.owner,c.runId,id);
  if (c.purpose === 'result') {
    if (c.status === 'succeeded') { statements.push(update('running',null,"'queued','waiting'")); statements.push(update('succeeded',serialized,"'running'")); }
    else statements.push(update(c.status === 'cancelled' ? 'cancelled' : 'failed',null,"'queued','running','waiting'"));
  }
  if (c.purpose === 'stop') statements.push(db.prepare(`UPDATE execution_permits SET closed_at=? WHERE id=? AND owner=? AND closed_at IS NULL AND ${retained}`).bind(now,p.id,context.owner,id));
  await db.batch(statements);
  const written = await db.prepare('SELECT id FROM backend_attestations WHERE permit_id=? AND purpose=?').bind(p.id,c.purpose).first<{id:string}>();
  if (written?.id !== id) throw bad();
}
