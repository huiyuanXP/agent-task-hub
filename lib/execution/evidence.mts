import type { EvidenceClaims, LegacyExecutionEvidence, EvidenceTrust, Run } from './types.mts';

const encoder = new TextEncoder();
const hashPattern = /^[a-f0-9]{64}$/;
const claimsKeys = ['version', 'keyId', 'owner', 'runId', 'ticketId', 'ticketRevision', 'attempt', 'authorizationId', 'contractSha256', 'status', 'backendId', 'exitCode', 'artifacts', 'stdoutSha256', 'stderrSha256', 'startedAt', 'endedAt'];
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function identifier(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function digest(value: unknown): value is string { return typeof value === 'string' && hashPattern.test(value); }
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
/** Validate every signed field before serializing or retaining evidence. */
export function isExecutionEvidence(value: unknown): value is LegacyExecutionEvidence {
  if (!object(value, ['claims', 'signature']) || typeof value.signature !== 'string' || !/^[a-f0-9]{128}$/.test(value.signature) || !object(value.claims, claimsKeys)) return false;
  const c = value.claims;
  if (c.version !== 1 || c.status !== 'succeeded' || c.exitCode !== 0 ||
      !['keyId', 'owner', 'runId', 'ticketId', 'authorizationId', 'backendId'].every(key => identifier(c[key], key === 'owner' ? 256 : 200)) ||
      !positive(c.ticketRevision) || !positive(c.attempt) ||
      !digest(c.contractSha256) || !digest(c.stdoutSha256) || !digest(c.stderrSha256) ||
      !timestamp(c.startedAt) || !timestamp(c.endedAt) || c.startedAt > c.endedAt ||
      !Array.isArray(c.artifacts) || c.artifacts.length > 32) return false;
  return c.artifacts.every(artifact => object(artifact, ['path', 'sha256', 'bytes']) &&
    typeof artifact.path === 'string' && artifact.path.length > 0 && artifact.path.length <= 256 &&
    !artifact.path.startsWith('/') && !artifact.path.includes('\\') && !/[\u0000-\u001f\u007f:]/.test(artifact.path) &&
    artifact.path.split('/').every(part => part !== '' && part !== '.' && part !== '..') &&
    digest(artifact.sha256) && typeof artifact.bytes === 'number' && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0);
}
/** UTF-8 JSON in this field order; ECDSA P-256/SHA-256, raw 64-byte signature hex. */
export function receiptSigningPayload(c: EvidenceClaims): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify({
    version: c.version, keyId: c.keyId, owner: c.owner, runId: c.runId,
    ticketId: c.ticketId, ticketRevision: c.ticketRevision, attempt: c.attempt,
    authorizationId: c.authorizationId, contractSha256: c.contractSha256,
    status: c.status, backendId: c.backendId, exitCode: c.exitCode,
    artifacts: c.artifacts.map(a => ({ path: a.path, sha256: a.sha256, bytes: a.bytes })),
    stdoutSha256: c.stdoutSha256, stderrSha256: c.stderrSha256,
    startedAt: c.startedAt, endedAt: c.endedAt,
  }));
}
export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Only a configured backend key can attest success; UI/MCP claims are insufficient. */
export async function verifyRunEvidence(run: Run, evidence: unknown, trust?: EvidenceTrust): Promise<boolean> {
  if (!trust || !isExecutionEvidence(evidence) || JSON.stringify(evidence).length > 16000) return false;
  const c = evidence.claims;
  if (c.keyId !== trust.keyId || c.owner !== run.owner || c.runId !== run.id || c.ticketId !== run.ticketId ||
      c.ticketRevision !== run.ticketRevision || c.attempt !== run.attempt || c.authorizationId !== run.authorizationId ||
      c.contractSha256 !== await sha256(run.ticketBody) || c.startedAt < run.created || Date.parse(c.endedAt) > Date.now() + 60000) return false;
  if (trust.key.type !== 'public' || trust.key.algorithm.name !== 'ECDSA' ||
      (trust.key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' || !trust.key.usages.includes('verify')) return false;
  try {
    const signature = Uint8Array.from(evidence.signature.match(/../g)!, hex => parseInt(hex, 16));
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, trust.key, signature, receiptSigningPayload(c));
  } catch { return false; }
}
