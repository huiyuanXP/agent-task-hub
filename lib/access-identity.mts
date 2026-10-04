import { createRemoteJWKSet, customFetch, jwtVerify, errors as joseErrors } from 'jose';

export class AccessProviderUnavailable extends Error {
  constructor() { super('Access provider unavailable'); }
}

export interface AccessEnvironment {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_APPLICATION_ORIGIN?: string;
  ACCESS_ALLOWED_EMAILS?: string;
}

export interface AccessConfig {
  teamDomain: string;
  audience: string;
  applicationOrigin: string;
  allowedEmails: readonly string[];
}

export interface AccessIdentity {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
  issuer: string;
  subject: string;
  expiresAt: number;
  tokenHash: string;
}

// Bound parsing work independently of the provider and upstream header limits.
const MAX_TOKEN_LENGTH = 16384;
const MAX_COOKIE_LENGTH = 32768;
const MAX_MEMBERS = 1000;
const MAX_LIFETIME_SECONDS = 86400;
const CONTROLS = /[\u0000-\u001f\u007f]/;

function invalid(): never {
  // Keep token contents and provider details out of application error messages.
  throw new Error('Invalid Access identity or configuration');
}

function emailAddress(value: unknown, trim = false): string {
  if (typeof value !== 'string' || CONTROLS.test(value)) return invalid();
  const email = (trim ? value.trim() : value).toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) || email.includes('*')) return invalid();
  return email;
}

function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || CONTROLS.test(value) || value.includes('\\') || value.trim() !== value) return invalid();
  if (!/^https:\/\/[^/?#]+\/?$/.test(value)) return invalid();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return invalid();
  // Also reject empty query/fragment markers which URL.search/hash omit.
  if (value.includes('?') || value.includes('#')) return invalid();
  return url.origin;
}

export function parseAccessConfig(settings: AccessEnvironment): AccessConfig {
  const teamDomain = origin(settings.ACCESS_TEAM_DOMAIN);
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com\/?$/.test(settings.ACCESS_TEAM_DOMAIN ?? '') || new URL(teamDomain).port) return invalid();
  const audience = settings.ACCESS_AUDIENCE;
  if (typeof audience !== 'string' || !/^[a-fA-F0-9]{64}$/.test(audience)) return invalid();
  const applicationOrigin = origin(settings.ACCESS_APPLICATION_ORIGIN);
  const rawMembers = settings.ACCESS_ALLOWED_EMAILS;
  if (typeof rawMembers !== 'string' || rawMembers.length > 262144) return invalid();
  const members: unknown = JSON.parse(rawMembers);
  if (!Array.isArray(members) || members.length === 0 || members.length > MAX_MEMBERS) return invalid();
  const allowedEmails = [...new Set(members.map((member) => emailAddress(member, true)))];
  return { teamDomain, audience, applicationOrigin, allowedEmails };
}

function compactToken(token: string): string {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return invalid();
  for (const segment of token.split('.')) {
    // Unused base64url padding bits must be zero. Otherwise identical signature
    // bytes can have different compact strings and bypass token-hash revocation.
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    if (segment.length % 4 === 1 || btoa(atob(base64)).replace(/=+$/, '') !== base64) return invalid();
  }
  return token;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function numericDate(value: unknown): value is number {
  // Millisecond expiry must also be safely representable for revocation storage.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value * 1000);
}

export function createAccessVerifier(config: AccessConfig, fetcher?: typeof fetch): (token: string, now?: Date) => Promise<AccessIdentity> {
  // Capture a validated copy, so mutable caller settings cannot change the issuer
  // or membership after the JWKS endpoint has been selected.
  const trusted = parseAccessConfig({
    ACCESS_TEAM_DOMAIN: config.teamDomain,
    ACCESS_AUDIENCE: config.audience,
    ACCESS_APPLICATION_ORIGIN: config.applicationOrigin,
    ACCESS_ALLOWED_EMAILS: JSON.stringify(config.allowedEmails),
  });
  const members = new Set(trusted.allowedEmails);
  const jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', trusted.teamDomain), {
    timeoutDuration: 5000,
    cacheMaxAge: 300000,
    cooldownDuration: 60000,
    ...(fetcher ? { [customFetch]: fetcher } : {}),
  });
  const resolveKey: (...args: Parameters<typeof jwks>) => ReturnType<typeof jwks> = async (...args) => {
    try { return await jwks(...args); }
    catch (error) {
      // No matching key describes a credential the provider does not recognize.
      // Preserve JOSE's candidate iteration for normal key rotation. All other
      // retrieval/import failures describe unusable provider material, including
      // WebCrypto DataError/TypeError that are not JOSEError subclasses.
      if (error instanceof joseErrors.JWKSNoMatchingKey || error instanceof joseErrors.JWKSMultipleMatchingKeys) throw error;
      throw new AccessProviderUnavailable();
    }
  };
  return async (token, now = new Date()) => {
    compactToken(token);
    if (!Number.isFinite(now.getTime())) return invalid();
    const { payload, protectedHeader } = await jwtVerify(token, resolveKey, {
      algorithms: ['RS256'], issuer: trusted.teamDomain, audience: trusted.audience,
      typ: 'JWT', requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat', 'email', 'type'],
      clockTolerance: 0, currentDate: now,
    });
    const { iss, sub, iat, exp, nbf } = payload;
    if (protectedHeader.typ !== 'JWT' || payload.type !== 'app' || iss !== trusted.teamDomain ||
        typeof sub !== 'string' || !sub.trim() || sub.length > 1024 || CONTROLS.test(sub) ||
        !numericDate(iat) || !numericDate(exp) || (nbf !== undefined && !numericDate(nbf)) ||
        iat > Math.floor(now.getTime() / 1000) || exp <= iat || exp - iat > MAX_LIFETIME_SECONDS) return invalid();
    const email = emailAddress(payload.email);
    if (!members.has(email)) return invalid();
    const fullName = typeof payload.name === 'string' && payload.name.trim() && payload.name.length <= 256 && !CONTROLS.test(payload.name)
      ? payload.name.trim() : null;
    return {
      userId: `access:${await sha256(JSON.stringify([iss, sub]))}`,
      displayName: fullName ?? email, email, fullName,
      issuer: iss, subject: sub, expiresAt: exp * 1000, tokenHash: await sha256(token),
    };
  };
}

export function readAccessToken(headers: Headers): { token: string; transport: 'assertion' | 'cookie' | 'bearer' } | null {
  const assertion = headers.get('cf-access-jwt-assertion');
  const authorization = headers.get('authorization');
  const cookies = headers.get('cookie');
  let cookie: string | null = null;
  let bearer: string | null = null;
  if (assertion !== null) compactToken(assertion);
  if (authorization !== null) {
    if (authorization.length > MAX_TOKEN_LENGTH + 7) return invalid();
    const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(authorization);
    if (!match) return invalid();
    bearer = compactToken(match[1]);
  }
  if (cookies !== null) {
    if (cookies.length > MAX_COOKIE_LENGTH) return invalid();
    for (const part of cookies.split(';')) {
      const entry = part.trim();
      const separator = entry.indexOf('=');
      const name = separator === -1 ? entry : entry.slice(0, separator).trim();
      if (name !== 'CF_Authorization') continue;
      if (cookie !== null || separator === -1) return invalid();
      cookie = compactToken(entry.slice(separator + 1));
    }
  }
  const tokens = [assertion, cookie, bearer].filter((value): value is string => value !== null);
  if (!tokens.length) return null;
  if (tokens.some((token) => token !== tokens[0])) return invalid();
  // A matching assertion is normal at Access ingress for explicit API clients.
  // Any Cookie header still forces origin checks in allowsSessionWrite.
  if (bearer !== null && cookies === null) return { token: bearer, transport: 'bearer' };
  if (assertion !== null) return { token: assertion, transport: 'assertion' };
  if (cookie !== null) return { token: cookie, transport: 'cookie' };
  return { token: bearer!, transport: 'bearer' };
}

const AUTH_PATH = /^\/(?:signin-with-chatgpt|signout-with-chatgpt|api\/session|cdn-cgi\/access|auth)(?:\/|$)/i;

export function safeAuthReturn(value: string | null, applicationOrigin: string): string {
  if (!value || value.length > 4096) return '/';
  try {
    const expected = origin(applicationOrigin);
    let candidate = value;
    let result = '';
    // Validate every decoded form to prevent encoded separators and dot segments
    // from becoming an external/reserved destination in a subsequent redirect.
    for (let depth = 0; depth < 6; depth++) {
      if (CONTROLS.test(candidate) || candidate.includes('\\') || candidate.startsWith('//') || candidate.trim() !== candidate) return '/';
      if (!candidate.startsWith('/') && !candidate.startsWith(`${expected}/`)) return '/';
      const url = new URL(candidate, expected);
      if (url.origin !== expected || url.username || url.password || url.pathname.startsWith('//') || AUTH_PATH.test(url.pathname)) return '/';
      if (depth === 0) result = `${url.pathname}${url.search}${url.hash}`;
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return result;
      candidate = decoded;
    }
  } catch {
    return '/';
  }
  return '/';
}

/** Call only after verifying the credential returned by readAccessToken. */
export function allowsSessionWrite(request: Request, applicationOrigin: string, transport: string): boolean {
  if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') return false;
  const supplied = request.headers.get('origin');
  if (supplied !== null) return supplied === applicationOrigin;
  return transport === 'bearer' && !request.headers.has('cookie');
}
