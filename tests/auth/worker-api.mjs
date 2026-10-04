// Real built Vinext/workerd/D1. Only the external, synthetic JWKS is mocked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const origin = 'https://hub.example.test';
const issuer = 'https://synthetic-team.cloudflareaccess.com';
const audience = 'a'.repeat(64);
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'synthetic', alg: 'RS256', use: 'sig' };
const now = Math.floor(Date.now() / 1000);
const owner = sub => 'access:' + createHash('sha256').update(JSON.stringify([issuer, sub])).digest('hex');
const token = (sub = 'alice', overrides = {}, key = privateKey) => new SignJWT({ type: 'app', email: `${sub}@example.test`, name: sub, iss: issuer, aud: audience, sub, iat: now, exp: now + 600, ...overrides }).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'synthetic' }).sign(key);
const alice = await token(); const bob = await token('bob');
const settings = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: audience, ACCESS_APPLICATION_ORIGIN: origin, ACCESS_ALLOWED_EMAILS: '["alice@example.test","bob@example.test"]' };
const spoof = { 'oai-authenticated-user-id': 'forged', 'oai-authenticated-user-email': 'forged@example.test' };
const temporary = mkdtempSync(join(tmpdir(), 'auth-worker-'));
let worker; let db; let outage = false; let outbound = 0; const unexpectedOutbound = [];
const config = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
async function start(bindings = settings) {
  if (worker) await worker.dispose();
  worker = new Miniflare({ host: '127.0.0.1', port: 0, modulesRoot: 'dist/server',
    modules: [config.main, ...readdirSync('dist/server', { recursive: true }).filter(path => /\.m?js$/.test(path) && path !== config.main)].map(path => ({ type: 'ESModule', path: join('dist/server', path) })),
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    bindings, d1Databases: { DB: '00000000-0000-4000-8000-000000000000' }, d1Persist: join(temporary, 'd1'),
    outboundService: async request => {
      outbound++;
      if (request.url !== issuer + '/cdn-cgi/access/certs') { unexpectedOutbound.push(request.url); return new Response('Denied', { status: 403 }); }
      return outage ? new Response('Unavailable', { status: 503 }) : Response.json({ keys: [jwk] });
    },
  });
  await worker.ready; db = await worker.getD1Database('DB');
}
async function request(path, { jwt = alice, method, body, headers = {}, urlOrigin = origin } = {}) {
  const response = await worker.dispatchFetch(urlOrigin + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'manual', headers: { ...(jwt ? { authorization: 'Bearer ' + jwt } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', origin }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, headers: response.headers, json, text };
}
async function expect(status, path, options) { const result = await request(path, options); assert.equal(result.status, status, `${path}: expected ${status}, got ${result.status}`); return result; }
try {
  await start();
  for (const migration of readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) for (const statement of readFileSync(join('drizzle', migration), 'utf8').split('--> statement-breakpoint').filter(sql => sql.trim())) await db.prepare(statement).run();
  const failures = [];
  for (const [label, options, status] of [['anonymous', { jwt: null }, 401], ['forged Sites identity rejected', { jwt: null, headers: spoof }, 401], ['verified Access owner admitted', {}, 200]]) {
    const response = await request('/api/records', options);
    console.log(`${label}: expected ${status}, actual ${response.status}`);
    if (response.status !== status) failures.push(label);
  }
  assert.deepEqual(failures, [], 'built Worker identity boundary regressions');
  const session = await expect(200, '/api/session');
  assert.deepEqual(session.json, { user: { userId: owner('alice'), email: 'alice@example.test', displayName: 'alice', fullName: 'alice' }, mode: 'access', expiresAt: (now + 600) * 1000 });
  assert.match(session.headers.get('cache-control'), /no-store/);
  assert.equal((await expect(200, '/api/session', { headers: spoof })).json.user.userId, owner('alice'));
  for (const path of ['/api/session', '/api/records', '/api/planning', '/api/execution', '/api/authorization', '/mcp']) await expect(401, path, { jwt: null, headers: spoof });
  const ui = await expect(302, '/?view=tickets', { jwt: null });
  assert.equal(ui.headers.get('location'), '/signin-with-chatgpt?return_to=%2F%3Fview%3Dtickets');
  for (const invalid of [await token('alice', { aud: 'b'.repeat(64) }), await token('alice', { iss: 'https://wrong.cloudflareaccess.com' }), await token('alice', { exp: now - 1, iat: now - 100 }), await token('alice', { iat: now + 100 }), await token('alice', { nbf: now + 100 }), await token('alice', { type: 'service' }), await token('outsider'), await token('alice', {}, (await generateKeyPair('RS256')).privateKey), await new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(new Uint8Array(32)), 'invalid']) await expect(401, '/api/session', { jwt: invalid });
  await expect(200, '/api/session', { jwt: null, headers: { 'cf-access-jwt-assertion': alice } });
  await expect(401, '/api/session', { headers: { 'cf-access-jwt-assertion': bob } });
  await expect(403, '/api/session', { urlOrigin: 'https://alternate.example.test' });
  const create = (jwt, title) => expect(201, '/api/records', { jwt, body: { kind: 'ticket', status: 'todo', title } });
  const [a, b] = await Promise.all([create(alice, 'Alice private'), create(bob, 'Bob private')]);
  for (let i = 0; i < 8; i++) {
    const results = await Promise.all([request('/api/records'), request('/api/records', { jwt: bob }), request('/api/session', { jwt: bob }), request('/')]);
    assert.deepEqual(results[0].json.records.map(row => row.id), [a.json.id]);
    assert.deepEqual(results[1].json.records.map(row => row.id), [b.json.id]);
    assert.equal(results[2].json.user.userId, owner('bob')); assert.equal(results[3].status, 200);
  }
  await expect(404, '/api/records', { jwt: bob, body: { id: a.json.id, kind: 'ticket', status: 'todo', title: 'steal', revision: 1 } });
  const idea = await expect(201, '/api/records', { body: { kind: 'idea', title: 'Private idea', text: 'Planning only' } });
  await expect(200, '/api/planning', { body: { ideaId: idea.json.id } });
  assert.equal((await expect(200, '/api/planning')).json.jobs.length, 1);
  assert.equal((await expect(200, '/api/planning', { jwt: bob })).json.jobs.length, 0);
  const rpc = (name, args = {}, options = {}) => request('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ...options });
  assert.equal((await rpc('get_idea', { idea_id: idea.json.id })).json.result.structuredContent.title, 'Private idea');
  const catalog = (await expect(200, `/api/authorization?ticketId=${a.json.id}&expectedRevision=1`)).json;
  const input = { ticketId: a.json.id, expectedRevision: 1, requestId: 'auth-test', attempt: 1, scope: catalog.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 600000 };
  const prepared = (await expect(201, '/api/authorization', { body: { action: 'prepare', ...input } })).json;
  assert.equal(prepared.authorization.effectiveStatus, 'pending');
  await expect(404, '/api/authorization?id=' + prepared.authorization.id, { jwt: bob });
  await expect(404, '/api/execution?id=' + prepared.run.id, { jwt: bob });
  await expect(200, '/api/execution?id=' + prepared.run.id);
  // Authentication alone must not approve a Run.
  assert.equal((await db.prepare('SELECT status FROM execution_authorizations WHERE id=?').bind(prepared.authorization.id).first()).status, 'pending');
  const cookie = { cookie: 'CF_Authorization=' + alice };
  await expect(200, '/api/session', { jwt: null, headers: cookie });
  const message = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  await expect(403, '/mcp', { jwt: null, body: message, headers: { ...cookie, origin: '' } });
  await expect(403, '/mcp', { body: message, headers: { origin: 'https://foreign.example' } });
  await expect(403, '/mcp', { body: message, headers: { 'sec-fetch-site': 'cross-site' } });
  // Explicit bearer (including a matching ingress assertion) may omit Origin.
  const bare = await worker.dispatchFetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + alice, 'cf-access-jwt-assertion': alice, 'content-type': 'application/json' }, body: JSON.stringify(message) });
  assert.equal(bare.status, 200); await bare.text();
  const cookieBearer = await worker.dispatchFetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + alice, cookie: 'unrelated=1', 'content-type': 'application/json' }, body: JSON.stringify(message) });
  assert.equal(cookieBearer.status, 403); await cookieBearer.text();
  await expect(403, '/api/records', { body: { kind: 'idea', title: 'Missing Origin' }, headers: { origin: '' } });
  await expect(405, '/signin-with-chatgpt', { method: 'POST', headers: { origin } });
  await expect(204, '/signin-with-chatgpt', { headers: { 'next-router-prefetch': '1' } });
  await expect(405, '/signout-with-chatgpt');
  await expect(403, '/signout-with-chatgpt', { method: 'POST' });
  await expect(403, '/signout-with-chatgpt', { method: 'POST', headers: { origin: 'https://foreign.example' } });
  await expect(204, '/signout-with-chatgpt', { method: 'POST', headers: { origin, purpose: 'prefetch' } });
  await expect(200, '/api/session');
  const login = await expect(302, '/signin-with-chatgpt?return_to=%2F%3Fview%3Dtickets', { jwt: null });
  const loginUrl = new URL(login.headers.get('location'));
  assert.equal(loginUrl.href, origin + '/?view=tickets');
  for (const target of ['https://evil.example', '//evil.example', '/%2f%2fevil.example', '/api/session', '/signout-with-chatgpt']) {
    const response = await expect(302, '/signin-with-chatgpt?return_to=' + encodeURIComponent(target), { jwt: null });
    assert.equal(response.headers.get('location'), origin + '/');
  }
  // A storage failure cannot appear to sign out successfully or leak SQL details.
  await db.prepare("CREATE TRIGGER revoke_fault BEFORE INSERT ON auth_revocations BEGIN SELECT RAISE(ABORT,'private storage detail'); END").run();
  const failedLogout = await expect(503, '/signout-with-chatgpt', { method: 'POST', headers: { origin } });
  assert.equal(failedLogout.headers.get('set-cookie'), null);
  assert.equal(failedLogout.text.includes('private storage detail'), false);
  await expect(200, '/api/session');
  await db.prepare('DROP TRIGGER revoke_fault').run();
  await db.prepare('INSERT INTO auth_revocations VALUES (?,?,?,?)').bind('expired-tombstone', owner('bob'), Date.now() - 1, Date.now() - 100).run();
  const logout = await expect(303, '/signout-with-chatgpt?return_to=https://evil.example', { jwt: null, method: 'POST', headers: { ...cookie, origin } });
  assert.equal(logout.headers.get('location'), origin + '/cdn-cgi/access/logout');
  assert.match(logout.headers.get('cache-control'), /no-store/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=0']) assert.ok(logout.headers.get('set-cookie').includes(flag));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM auth_revocations').first()).n, 1);
  for (const headers of [{ authorization: 'Bearer ' + alice }, cookie, { 'cf-access-jwt-assertion': alice }]) await expect(401, '/api/session', { jwt: null, headers });
  await expect(200, '/api/session', { jwt: bob });
  const renewed = await token('alice', { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120 });
  await expect(200, '/api/session', { jwt: renewed });
  const shortExpiry = Math.floor(Date.now() / 1000) + 2;
  const short = await token('bob', { iat: shortExpiry - 2, exp: shortExpiry });
  await expect(200, '/api/session', { jwt: short });
  await new Promise(resolve => setTimeout(resolve, Math.max(0, shortExpiry * 1000 - Date.now()) + 30));
  await expect(401, '/api/session', { jwt: short });
  console.log('PASS: verified owner isolation, protected API/UI/MCP/Run/authorization, session, CSRF, redirects and immediate logout revocation');
  // Fresh isolate removes the JWKS cache, modeling first-contact provider outage.
  outage = true; await start(); await expect(401, '/api/session', { jwt: bob }); outage = false;
  await start({}); await expect(503, '/api/records', { jwt: null, headers: spoof });
  await start({ AUTH_TRUST_SITES_HEADERS: '1' }); await expect(503, '/api/records', { jwt: null, headers: spoof });
  await start({ AUTH_MODE: 'trusted-sites' }); await expect(503, '/api/records', { jwt: null, headers: spoof });
  await start({ AUTH_MODE: 'unknown', ...settings }); await expect(503, '/api/records');
  await start({ AUTH_MODE: 'trusted-sites', AUTH_TRUST_SITES_HEADERS: '1' });
  assert.equal((await expect(200, '/api/session', { jwt: null, headers: spoof })).json.user.userId, 'forged');
  await expect(401, '/api/session', { jwt: null });
  await start(settings); await expect(401, '/api/session', { jwt: null, headers: { cookie: '__sites_local_auth=1', ...spoof } });
  assert.ok(outbound > 0); assert.deepEqual(unexpectedOutbound, []);
  console.log('PASS: provider outage, fail-closed defaults, explicit trusted Sites fixture and production mock-cookie rejection');
} finally { try { if (worker) await worker.dispose(); } finally { rmSync(temporary, { recursive: true, force: true }); } }
