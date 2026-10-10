import { sha256 } from './evidence.mts';
import type { EvidenceTrust } from './types.mts';
export interface SigningKey { keyId: string; privateKey: CryptoKey }
export interface Signed<T> { claims: T; signature: string }
export interface TransportBinding { direction: 'control-to-runner' | 'runner-to-control'; audience: string; method: string; path: string; body: string }
export interface TransportClaims {
  version: 1; purpose: 'request' | 'reply'; direction: TransportBinding['direction']; audience: string; keyId: string;
  method: string; path: string; nonce: string; issuedAt: number; expiresAt: number; bodySha256: string;
  requestSha256: string | null; status: number | null;
}
/** Recursive key ordering is shared by Worker and Node; arrays retain semantic order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  throw Error('Unsupported canonical value');
}
export function signingBytes(value: unknown): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(canonical(value)); }
export async function signClaims<T>(key: SigningKey, claims: T): Promise<Signed<T>> {
  const frozen = JSON.parse(canonical(claims)) as T;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, signingBytes(frozen)));
  if (signature.length !== 64) throw Error('Raw P256 signature required');
  return { claims: frozen, signature: Array.from(signature, b => b.toString(16).padStart(2, '0')).join('') };
}
export async function verifyClaims<T>(signed: Signed<T>, trust: EvidenceTrust): Promise<boolean> {
  try {
    if (!signed || Object.keys(signed).sort().join() !== 'claims,signature' || typeof signed.signature !== 'string' || !/^[a-f0-9]{128}$/.test(signed.signature) ||
      trust.key.type !== 'public' || trust.key.algorithm.name !== 'ECDSA' || (trust.key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256') return false;
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, trust.key, Uint8Array.from(signed.signature.match(/../g)!, h => parseInt(h,16)), signingBytes(signed.claims));
  } catch { return false; }
}
export async function signRequest(key: SigningKey, binding: TransportBinding, now = Date.now()): Promise<Signed<TransportClaims>> {
  binding = { ...binding };
  return signClaims(key, { version: 1, purpose: 'request', direction: binding.direction, audience: binding.audience, keyId: key.keyId,
    method: binding.method, path: binding.path, nonce: crypto.randomUUID(), issuedAt: now, expiresAt: now + 10000,
    bodySha256: await sha256(binding.body), requestSha256: null, status: null });
}
function fresh(c: TransportClaims, trust: EvidenceTrust, now: number) {
  return Object.keys(c).sort().join() === ['version','purpose','direction','audience','keyId','method','path','nonce','issuedAt','expiresAt','bodySha256','requestSha256','status'].sort().join() &&
    c.version === 1 && c.keyId === trust.keyId && typeof c.nonce === 'string' && /^[a-f0-9-]{36}$/.test(c.nonce) &&
    Number.isSafeInteger(c.issuedAt) && Number.isSafeInteger(c.expiresAt) && c.issuedAt <= now + 1000 && c.expiresAt > now && c.expiresAt - c.issuedAt > 0 && c.expiresAt - c.issuedAt <= 10000;
}
export async function verifyRequest(signed: Signed<TransportClaims>, trust: EvidenceTrust, binding: TransportBinding, now = Date.now()): Promise<boolean> {
  try {
    signed = JSON.parse(canonical(signed)); binding = { ...binding };
    const c = signed.claims;
    return fresh(c, trust, now) && c.purpose === 'request' && c.direction === binding.direction && c.audience === binding.audience &&
      c.method === binding.method && c.path === binding.path && c.requestSha256 === null && c.status === null && c.bodySha256 === await sha256(binding.body) && await verifyClaims(signed, trust);
  } catch { return false; }
}
export async function signReply(key: SigningKey, request: Signed<TransportClaims>, status: number, body: string, now = Date.now()): Promise<Signed<TransportClaims>> {
  request = JSON.parse(canonical(request));
  return signClaims(key, { ...request.claims, purpose: 'reply', keyId: key.keyId, direction: request.claims.direction === 'control-to-runner' ? 'runner-to-control' : 'control-to-runner',
    issuedAt: now, expiresAt: now + 10000, bodySha256: await sha256(body), requestSha256: await sha256(canonical(request)), status });
}
export async function verifyReply(signed: Signed<TransportClaims>, trust: EvidenceTrust, request: Signed<TransportClaims>, status: number, body: string, now = Date.now()): Promise<boolean> {
  try {
    signed = JSON.parse(canonical(signed)); request = JSON.parse(canonical(request)); const c = signed.claims, r = request.claims;
    return fresh(c, trust, now) && c.purpose === 'reply' && c.direction === (r.direction === 'control-to-runner' ? 'runner-to-control' : 'control-to-runner') &&
      c.audience === r.audience && c.method === r.method && c.path === r.path && c.nonce === r.nonce && c.status === status &&
      c.requestSha256 === await sha256(canonical(request)) && c.bodySha256 === await sha256(body) && await verifyClaims(signed, trust);
  } catch { return false; }
}
export class ReplayWindow {
  private entries = new Map<string, number>();
  private capacity: number;
  constructor(capacity = 1024) { this.capacity = capacity; }
  accept(nonce: string, expiresAt: number, now = Date.now()): boolean {
    for (const [id, expiry] of this.entries) if (expiry <= now) this.entries.delete(id);
    if (expiresAt <= now || this.entries.has(nonce) || this.entries.size >= this.capacity) return false;
    this.entries.set(nonce, expiresAt); return true;
  }
}
export async function boundedText(response: Response, limit = 262144): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw Error('Response byte limit'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export interface TransportConfiguration { baseUrl: string; audience: string; direction: TransportBinding['direction']; signing: SigningKey; trust: EvidenceTrust }
export async function signedFetch(config: TransportConfiguration, path: string, payload: unknown, maxBytes = 262144): Promise<{ status: number; data: unknown }> {
  const base = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !/^\/[a-z0-9/-]+$/.test(path)) throw Error('Invalid fixed transport URL');
  const body = canonical(payload); const request = await signRequest(config.signing, { direction: config.direction, audience: config.audience, method: 'POST', path, body });
  const response = await fetch(new URL(path, base), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3000), headers: { 'content-type': 'application/json', 'x-execution-signature': JSON.stringify(request) }, body });
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw Error('Execution redirects are forbidden'); }
  const text = await boundedText(response, maxBytes);
  const signed = JSON.parse(response.headers.get('x-execution-signature') ?? 'null');
  if (!await verifyReply(signed, config.trust, request, response.status, text)) throw Error('Untrusted execution response');
  return { status: response.status, data: JSON.parse(text) };
}
