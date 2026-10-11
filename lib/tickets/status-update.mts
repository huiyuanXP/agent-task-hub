import { createHash } from 'node:crypto';
import type { LocalDatabase } from '../database.mts';
import type { RecordBody, RecordRow } from '../types';
import { AuthError } from '../local-auth.mts';
import { connectorInput, type ConnectorPrincipal } from '../connectors/service.mts';
import { ticketStatusWriteGuard } from './record-write.mts';

const statuses = ['todo', 'running', 'waiting', 'done', 'error'];
const reasons = ['clarification', 'approval', 'review', 'external', 'recovery'];
export const ticketEvidenceBytes = 12000;
export const ticketStatusTool = {
  name: 'update_ticket_status',
  description: 'Update a Ticket in this connector’s project using revision CAS and a stable request_id. Evidence is appended caller-reported text, never proof of a Run or permission to execute. Active or physically held Runs block status changes.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    ticket_id: { type: 'string', minLength: 1, maxLength: 200 },
    expected_revision: { type: 'integer', minimum: 1 },
    request_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' },
    status: { type: 'string', enum: statuses },
    evidence: { type: 'string', maxLength: ticketEvidenceBytes, description: 'Append evidence; combined saved evidence must fit 12000 UTF-8 bytes. Empty is allowed except when done has no existing evidence.' },
    waiting_reason: { type: 'string', enum: reasons },
  }, required: ['ticket_id', 'expected_revision', 'request_id', 'status', 'evidence'] },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
};
interface StatusResult { ticket_id: string; revision: number; status: string }
interface Receipt { connectionId: string; projectId: string; inputKey: string; result: StatusResult }
function boundedText(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string') throw new AuthError(400, `Invalid ${name}`);
  if (Buffer.byteLength(value, 'utf8') > max) throw new AuthError(413, `${name} exceeds ${max} UTF-8 bytes; existing evidence was not changed`);
}

export async function updateTicketStatus(db: LocalDatabase, principal: ConnectorPrincipal, args: unknown): Promise<StatusResult> {
  principal = { ...principal, capabilities: [...principal.capabilities] };
  if (!principal.capabilities.includes('submit')) throw new AuthError(403, 'Connector capability denied');
  connectorInput(args, ['ticket_id', 'expected_revision', 'request_id', 'status', 'evidence', 'waiting_reason']);
  const input = { ...args };
  boundedText(input.ticket_id, 'ticket_id', 800);
  if (!input.ticket_id || input.ticket_id.length > 200 || /[\u0000-\u001f\u007f]/.test(input.ticket_id)) throw new AuthError(400, 'Invalid ticket_id');
  if (!Number.isSafeInteger(input.expected_revision) || (input.expected_revision as number) < 1 || (input.expected_revision as number) >= Number.MAX_SAFE_INTEGER) throw new AuthError(400, 'Invalid expected_revision');
  if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.request_id)) throw new AuthError(400, 'Invalid request_id');
  if (!statuses.includes(input.status as string)) throw new AuthError(400, 'Invalid status');
  boundedText(input.evidence, 'evidence', ticketEvidenceBytes);
  if (input.waiting_reason !== undefined && (!reasons.includes(input.waiting_reason as string) || input.status !== 'waiting')) throw new AuthError(400, 'Invalid waiting_reason');
  const inputKey = createHash('sha256').update(JSON.stringify([input.ticket_id, input.expected_revision, input.status, input.evidence, input.waiting_reason ?? null])).digest('hex');
  const auditId = 'connector-status:' + createHash('sha256').update(JSON.stringify([principal.owner, principal.id, input.request_id])).digest('hex');
  const credential = `EXISTS(SELECT 1 FROM workspace_connections c JOIN workspace_projects p ON p.id=c.project_id AND p.owner=c.owner
    WHERE c.id=? AND c.owner=? AND c.project_id=? AND p.name=? AND c.revoked_at IS NULL AND c.token_expires_at>(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
    AND EXISTS(SELECT 1 FROM json_each(c.capabilities) WHERE value='submit'))`;
  const credentialParams = () => [principal.id, principal.owner, principal.projectId, principal.project];
  const live = async () => {
    if (!await db.prepare(`SELECT 1 WHERE ${credential}`).bind(...credentialParams()).first()) throw new AuthError(401, 'Connector credential expired, revoked or capability removed');
  };
  const replay = async (): Promise<StatusResult | null> => {
    const row = await db.prepare("SELECT body FROM records WHERE id=? AND owner=? AND kind='history'").bind(auditId, principal.owner).first<{ body: string }>();
    if (!row) return null;
    const receipt = (JSON.parse(row.body) as { statusUpdate: Receipt }).statusUpdate;
    if (receipt.connectionId !== principal.id || receipt.projectId !== principal.projectId) throw new AuthError(403, 'Status request belongs to a different connector project');
    if (receipt.inputKey !== inputKey) throw new AuthError(409, 'request_id already binds different Ticket status input; use the original input or a new request_id');
    return receipt.result;
  };
  await live();
  const previous = await replay();
  if (previous) { await live(); return previous; }
  const project = "COALESCE(NULLIF(json_extract(records.body,'$.project'),''),'通用')=?";
  const old = await db.prepare(`SELECT * FROM records WHERE id=? AND owner=? AND kind='ticket' AND ${project}`)
    .bind(input.ticket_id, principal.owner, principal.project).first<RecordRow>();
  if (!old) throw new AuthError(404, 'Ticket not found');
  if (old.revision !== input.expected_revision) {
    // A matching retry may have committed after the first receipt lookup.
    const concurrent = await replay();
    if (concurrent) { await live(); return concurrent; }
    throw new AuthError(409, 'Ticket revision conflict; refresh the Ticket and preserve your proposed status/evidence');
  }
  const original = JSON.parse(old.body) as RecordBody;
  if (original.evidence !== undefined && typeof original.evidence !== 'string') throw new AuthError(409, 'Stored Ticket evidence is invalid; no evidence was replaced');
  const appended = !!input.evidence.trim();
  const evidence = appended ? [original.evidence || '', input.evidence].filter(Boolean).join('\n\n') : original.evidence || '';
  boundedText(evidence, 'Combined evidence', ticketEvidenceBytes);
  if (input.status === 'done' && !evidence.trim()) throw new AuthError(400, 'Evidence is required before marking a Ticket done');
  const body = { ...original, status: input.status as string, evidence };
  if (input.status === 'waiting') {
    const reason = input.waiting_reason ?? original.waitingReason;
    if (!reasons.includes(reason as string)) throw new AuthError(400, 'A valid waiting_reason is required for waiting');
    body.waitingReason = reason as RecordBody['waitingReason'];
  }
  const serialized = JSON.stringify(body);
  boundedText(serialized, 'Ticket body', 80000);
  const now = new Date().toISOString();
  const result = { ticket_id: old.id, revision: old.revision + 1, status: body.status };
  const history = JSON.stringify({ title: original.title, recordId: old.id, recordKind: 'ticket', previousRevision: old.revision, snapshot: original,
    statusUpdate: { connectionId: principal.id, projectId: principal.projectId, requestId: input.request_id, inputKey, result } });
  const guard = original.status !== body.status ? ` AND ${ticketStatusWriteGuard}` : '';
  const match = `id=? AND owner=? AND kind='ticket' AND revision=? AND ${project} AND ${credential}${guard}`;
  const matchParams = [old.id, principal.owner, old.revision, principal.project, ...credentialParams()];
  try { await db.batch([
    db.prepare(`INSERT INTO records(id,owner,kind,body,revision,created,updated) SELECT ?,?,'history',?,1,?,?
      WHERE NOT EXISTS(SELECT 1 FROM records WHERE id=?) AND EXISTS(SELECT 1 FROM records WHERE ${match})`)
      .bind(auditId, principal.owner, history, now, now, auditId, ...matchParams),
    db.prepare(`UPDATE records SET body=?,revision=revision+1,updated=? WHERE ${match}
      AND EXISTS(SELECT 1 FROM records audit WHERE audit.id=? AND audit.owner=records.owner AND audit.kind='history'
        AND json_extract(audit.body,'$.statusUpdate.inputKey')=?)`)
      .bind(serialized, now, ...matchParams, auditId, inputKey),
    // Re-evaluate current SQLite time after both writes. A failed assertion aborts
    // the batch, so expiry between history and CAS cannot leave a partial receipt.
    db.prepare(`SELECT CASE WHEN ${credential} THEN 1 ELSE json('ticket_status_credential_expired') END`).bind(...credentialParams()),
  ]); } catch (error) { await live(); throw error; }
  await live();
  const saved = await replay();
  if (saved) { await live(); return saved; }
  throw new AuthError(409, 'Ticket revision or active/physical Run changed; preserve your proposed status/evidence and refresh');
}
