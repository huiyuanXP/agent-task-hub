import { errors as joseErrors } from 'jose';
import type { ChatGPTUser } from '../app/chatgpt-auth';
import { allowsSessionWrite, createAccessVerifier, parseAccessConfig, readAccessToken, safeAuthReturn } from './access-identity.mts';
import { runWithAuthentication, type AuthenticationContext } from './auth-context';

class ProviderUnavailable extends Error {}
// Only the external fetch boundary becomes an availability error. Malformed
// credentials and failed signatures/claims remain authentication failures.
const providerFetch: typeof fetch = async (input, init) => {
  try { return await fetch(input, init); }
  catch { throw new ProviderUnavailable(); }
};
const unavailableCodes = new Set(['ERR_JOSE_GENERIC', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID', 'ERR_JWK_INVALID']);

const cache = new Map<string, ReturnType<typeof createAccessVerifier>>();
const noStore = { 'Cache-Control': 'private, no-store' };
const failure = (status: number) => Response.json({ error: status === 503 ? 'Authentication unavailable' : status === 403 ? 'Request origin rejected' : 'Authentication required' }, { status, headers: noStore });
const redirect = (location: string, status = 302, headers = {}) => new Response(null, { status, headers: { ...noStore, Location: location, ...headers } });

function sitesUser(headers: Headers): ChatGPTUser | null {
  const userId = headers.get('oai-authenticated-user-id');
  const email = headers.get('oai-authenticated-user-email');
  if (!userId || !email) return null;
  let fullName = null;
  if (headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try { fullName = decodeURIComponent(headers.get('oai-authenticated-user-full-name') ?? '') || null; } catch { /* Optional display name. */ }
  }
  return { userId, email, fullName, displayName: fullName ?? email };
}
function isPrefetch(headers: Headers): boolean {
  return headers.has('next-router-prefetch') || headers.get('x-middleware-prefetch') === '1' ||
    ['purpose', 'sec-purpose'].some(name => headers.get(name)?.split(/[;,]/).some(value => value.trim().toLowerCase() === 'prefetch'));
}

export async function authenticateRequest(
  request: Request,
  env: Cloudflare.Env,
  dispatch: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // Capture only for explicitly trusted modes, then strip all incoming Sites
  // identity headers before the application can observe the request.
  const development = import.meta.env.DEV && import.meta.env.SITES_MOCK_AUTH && !env.AUTH_MODE &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const trusted = env.AUTH_MODE === 'trusted-sites' && env.AUTH_TRUST_SITES_HEADERS === '1';
  const localUser = development || trusted ? sitesUser(headers) : null;
  for (const name of [...headers.keys()]) if (name.startsWith('oai-authenticated-user-')) headers.delete(name);
  const cleanRequest = new Request(request, { headers });
  if (development || trusted) {
    const context: AuthenticationContext = { mode: development ? 'development' : 'trusted-sites', user: localUser, expiresAt: null };
    return runWithAuthentication(context, () => dispatch(cleanRequest));
  }
  if (env.AUTH_MODE && env.AUTH_MODE !== 'access') return failure(503);
  let config;
  try { config = parseAccessConfig(env); } catch { return failure(503); }
  if (url.origin !== config.applicationOrigin) return failure(403);

  if (url.pathname === '/signin-with-chatgpt') {
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...noStore, Allow: 'GET' } });
    if (isPrefetch(headers)) return new Response(null, { status: 204, headers: noStore });
    // Access protects this configured application URL and owns the entire login
    // and callback flow. No application callback or undocumented provider query.
    return redirect(config.applicationOrigin + safeAuthReturn(url.searchParams.get('return_to'), config.applicationOrigin));
  }
  if (url.pathname === '/signout-with-chatgpt' && request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...noStore, Allow: 'POST' } });
  }
  let credential;
  let identity;
  try {
    credential = readAccessToken(headers);
    if (credential) {
      const key = JSON.stringify(config);
      let verify = cache.get(key);
      if (!verify) {
        verify = createAccessVerifier(config, providerFetch);
        if (cache.size >= 8) cache.delete(cache.keys().next().value!);
        cache.set(key, verify);
      }
      identity = await verify(credential.token);
    }
  } catch (error) {
    return failure(error instanceof ProviderUnavailable ||
      (error instanceof joseErrors.JOSEError && unavailableCodes.has(error.code)) ? 503 : 401);
  }
  if (!identity || !credential) {
    if ((request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/') && url.pathname !== '/mcp' && !url.pathname.startsWith('/cdn-cgi/')) {
      return redirect('/signin-with-chatgpt?return_to=' + encodeURIComponent(safeAuthReturn(url.pathname + url.search, config.applicationOrigin)));
    }
    return failure(401);
  }
  const db = env.DB;
  if (!db) return failure(503);
  try {
    const revoked = await db.prepare('SELECT token_hash FROM auth_revocations WHERE token_hash=?').bind(identity.tokenHash).first();
    if (revoked) return failure(401);
  } catch { return failure(503); }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !allowsSessionWrite(request, config.applicationOrigin, credential.transport)) return failure(403);
  if (url.pathname === '/signout-with-chatgpt') {
    // Logout always requires an explicit same-origin browser intent, even for
    // Bearer callers. Prefetch must not write a tombstone or clear a cookie.
    if (headers.get('origin') !== config.applicationOrigin) return failure(403);
    if (isPrefetch(headers)) return new Response(null, { status: 204, headers: noStore });
    try {
      const now = Date.now();
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO auth_revocations (token_hash,owner,expires_at,created_at) VALUES (?,?,?,?)').bind(identity.tokenHash, identity.userId, identity.expiresAt, now),
        db.prepare('DELETE FROM auth_revocations WHERE expires_at<=?').bind(now),
      ]);
    } catch { return failure(503); }
    return redirect(config.applicationOrigin + '/cdn-cgi/access/logout', 303, {
      'Set-Cookie': 'CF_Authorization=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    });
  }
  const { userId, email, displayName, fullName, expiresAt, tokenHash } = identity;
  return runWithAuthentication({ mode: 'access', user: { userId, email, displayName, fullName }, expiresAt, tokenHash }, () => dispatch(cleanRequest));
}
