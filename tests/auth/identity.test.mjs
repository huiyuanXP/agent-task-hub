import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { parseAccessConfig, createAccessVerifier, readAccessToken, safeAuthReturn, allowsSessionWrite } from '../../lib/access-identity.mts';

const settings = {
  ACCESS_TEAM_DOMAIN: 'https://synthetic-team.cloudflareaccess.com',
  ACCESS_AUDIENCE: 'a'.repeat(64),
  ACCESS_APPLICATION_ORIGIN: 'https://hub.auth.test',
  ACCESS_ALLOWED_EMAILS: JSON.stringify(['a@example.test', 'b@example.test']),
};
const instant = new Date('2024-01-01T00:00:00.000Z');
const epoch = 1704067200;
const pair = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(pair.publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
const claims = { type: 'app', email: 'a@example.test', iss: settings.ACCESS_TEAM_DOMAIN, aud: settings.ACCESS_AUDIENCE, sub: 'subject-a', iat: epoch, exp: epoch + 600 };
const header = { alg: 'RS256', kid: 'synthetic-key', typ: 'JWT' };
const sign = (overrides = {}, protectedHeader = header, key = pair.privateKey) => new SignJWT({ ...claims, ...overrides }).setProtectedHeader(protectedHeader).sign(key);
function verifier(fetcher = async (input) => {
  assert.equal(String(input), 'https://synthetic-team.cloudflareaccess.com/cdn-cgi/access/certs');
  return Response.json({ keys: [jwk] });
}) {
  return createAccessVerifier(parseAccessConfig(settings), fetcher);
}

test('verified human gets only the explicit identity DTO with a stable private owner', async () => {
  const token = await sign({ name: 'Synthetic Member', ignored: 'not a DTO field' });
  assert.deepEqual(await verifier()(token, instant), {
    userId: 'access:b0a46b57b3a36d74bcc02ebf9781abc64395e7d3e656d27d7b0438a579472ec5',
    email: 'a@example.test', displayName: 'Synthetic Member', fullName: 'Synthetic Member',
    issuer: settings.ACCESS_TEAM_DOMAIN, subject: 'subject-a', expiresAt: 1704067800000,
    tokenHash: createHash('sha256').update(token).digest('hex'),
  });
});
test('refresh and email change keep ownership while different subjects have separate owners', async () => {
  const verify = verifier();
  const first = await verify(await sign(), instant);
  const refresh = await verify(await sign({ email: 'B@EXAMPLE.TEST', iat: epoch - 10, exp: epoch + 700 }), instant);
  const other = await verify(await sign({ sub: 'subject-b' }), instant);
  assert.equal(first.userId, 'access:b0a46b57b3a36d74bcc02ebf9781abc64395e7d3e656d27d7b0438a579472ec5');
  assert.equal(refresh.userId, first.userId);
  assert.notEqual(refresh.tokenHash, first.tokenHash);
  assert.notEqual(other.userId, first.userId);
  assert.equal(refresh.email, 'b@example.test');
  assert.equal(first.displayName, 'a@example.test');
  assert.equal(first.fullName, null);
});

const invalidClaims = [
  ['wrong issuer', { iss: 'https://foreign.cloudflareaccess.com' }],
  ['wrong audience', { aud: 'b'.repeat(64) }], ['missing audience', { aud: undefined }],
  ['expired', { exp: epoch }], ['future issuance', { iat: epoch + 1 }],
  ['future not-before', { nbf: epoch + 1 }], ['nonintegral not-before', { nbf: epoch - 0.5 }],
  ['missing issuance', { iat: undefined }], ['missing expiry', { exp: undefined }],
  ['unsafe expiry', { exp: Number.MAX_SAFE_INTEGER }], ['fractional expiry', { exp: epoch + 0.5 }],
  ['string issuance', { iat: String(epoch) }], ['negative issuance', { iat: -1 }],
  ['too long duration', { exp: epoch + 86401 }], ['nonpositive duration', { iat: epoch, exp: epoch }],
  ['missing subject', { sub: undefined }], ['blank subject', { sub: ' ' }],
  ['oversized subject', { sub: 'x'.repeat(1025) }], ['nonstring subject', { sub: 123 }],
  ['service token', { type: 'service' }], ['missing application type', { type: undefined }],
  ['missing email', { email: undefined }], ['unapproved email', { email: 'unapproved@example.test' }],
  ['invalid email', { email: 'a@example.test\n' }], ['array email', { email: ['a@example.test'] }],
];
for (const [name, overrides] of invalidClaims) {
  test(`rejects ${name} despite valid signature`, async () => {
    await assert.rejects(verifier()(await sign(overrides), instant));
  });
}
test('accepts a valid not-before and the maximum 24-hour lifetime', async () => {
  assert.equal((await verifier()(await sign({ exp: epoch + 86400, nbf: epoch }), instant)).expiresAt, 1704153600000);
});
test('rejects signature changes and a signature from an untrusted key', async () => {
  const token = await sign();
  const parts = token.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  await assert.rejects(verifier()(parts.join('.'), instant));
  const wrong = await generateKeyPair('RS256');
  await assert.rejects(verifier()(await sign({}, header, wrong.privateKey), instant));
});
for (const [name, protectedHeader] of [
  ['wrong key', { ...header, kid: 'unknown' }], ['wrong type', { ...header, typ: 'other' }],
  ['missing type', { alg: 'RS256', kid: 'synthetic-key' }], ['wrong algorithm', { ...header, alg: 'PS256' }],
]) {
  test(`rejects ${name}`, async () => {
    const key = protectedHeader.alg === 'PS256' ? (await generateKeyPair('PS256')).privateKey : pair.privateKey;
    await assert.rejects(verifier()(await sign({}, protectedHeader, key), instant));
  });
}
test('ignores token URL hints and reuses the configured JWKS between verified requests', async () => {
  let requests = 0;
  const verify = verifier(async (input) => {
    assert.equal(String(input), 'https://synthetic-team.cloudflareaccess.com/cdn-cgi/access/certs');
    requests++;
    return Response.json({ keys: [jwk] });
  });
  const token = await sign({}, { ...header, jku: 'https://attacker.test/keys', x5u: 'https://attacker.test/cert' });
  assert.equal((await verify(token, instant)).email, 'a@example.test');
  assert.equal((await verify(await sign({ sub: 'subject-b' }), instant)).subject, 'subject-b');
  assert.equal(requests, 1);
});
test('unknown keys fail closed without hammering JWKS during refresh cooldown', async () => {
  let requests = 0;
  const verify = verifier(async () => { requests++; return Response.json({ keys: [jwk] }); });
  await verify(await sign(), instant);
  for (let i = 0; i < 3; i++) await assert.rejects(verify(await sign({}, { ...header, kid: `unknown-${i}` }), instant));
  assert.equal(requests, 1);
});
for (const [name, fetcher] of [
  ['HTTP failure', async () => new Response('unavailable', { status: 503 })],
  ['network failure', async () => { throw new Error('offline'); }],
  ['invalid JWKS', async () => Response.json({ keys: 'invalid' })],
  ['empty JWKS', async () => Response.json({ keys: [] })],
]) test(`rejects provider ${name}`, async () => { await assert.rejects(verifier(fetcher)(await sign(), instant)); });
for (const token of ['', 'bad', 'a.b.c.d', 'a..c', 'a.b.c, a.b.c', 'a'.repeat(16385), `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`]) {
  test(`rejects malformed, unsigned or oversized input (${token.length} chars) before contacting provider`, async () => {
    let requests = 0;
    await assert.rejects(verifier(async () => { requests++; throw new Error('must not fetch'); })(token, instant));
    assert.equal(requests, 0);
  });
}

test('configuration normalizes membership and canonical trailing slashes', () => {
  assert.deepEqual(parseAccessConfig({ ...settings, ACCESS_TEAM_DOMAIN: `${settings.ACCESS_TEAM_DOMAIN}/`, ACCESS_APPLICATION_ORIGIN: `${settings.ACCESS_APPLICATION_ORIGIN}/`, ACCESS_ALLOWED_EMAILS: '[" A@EXAMPLE.TEST ","b@example.test","a@example.test"]' }), {
    teamDomain: settings.ACCESS_TEAM_DOMAIN, audience: settings.ACCESS_AUDIENCE,
    applicationOrigin: settings.ACCESS_APPLICATION_ORIGIN, allowedEmails: ['a@example.test', 'b@example.test'],
  });
});
for (const [key, values] of Object.entries({
  ACCESS_TEAM_DOMAIN: [undefined, '', 'http://synthetic-team.cloudflareaccess.com', 'https://cloudflareaccess.com', 'https://a.b.cloudflareaccess.com', 'https://a.cloudflareaccess.com.attacker.test', 'https://a.cloudflareaccess.com:444', 'https://u:p@a.cloudflareaccess.com', 'https://a.cloudflareaccess.com/path', 'https://a.cloudflareaccess.com?x', 'https://a.cloudflareaccess.com#x', 'https://a.cloudflareaccess.com\\'],
  ACCESS_AUDIENCE: [undefined, '', 'x', 'a'.repeat(65), 'g'.repeat(64)],
  ACCESS_APPLICATION_ORIGIN: [undefined, '', 'http://hub.auth.test', 'https://u:p@hub.auth.test', 'https://hub.auth.test/path', 'https://hub.auth.test?x', 'https://hub.auth.test#x', 'https://hub.auth.test\\'],
  ACCESS_ALLOWED_EMAILS: [undefined, '', '[]', '{}', 'null', '["*"]', '[123]', '["bad"]', '["a@example.test\\n"]', JSON.stringify(Array(1001).fill('a@example.test'))],
})) for (const value of values) test(`rejects invalid configuration ${key}: ${String(value).slice(0, 70)}`, () => { assert.throws(() => parseAccessConfig({ ...settings, [key]: value })); });

const compact = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJl';
for (const [headers, want] of [
  [{}, null], [{ 'oai-authenticated-user-id': 'spoof' }, null],
  [{ 'cf-access-jwt-assertion': compact }, { token: compact, transport: 'assertion' }],
  [{ cookie: `other=value; CF_Authorization=${compact}` }, { token: compact, transport: 'cookie' }],
  [{ authorization: `Bearer ${compact}` }, { token: compact, transport: 'bearer' }],
  [{ authorization: `Bearer ${compact}`, 'cf-access-jwt-assertion': compact }, { token: compact, transport: 'bearer' }],
  [{ cookie: `CF_Authorization=${compact}`, 'cf-access-jwt-assertion': compact }, { token: compact, transport: 'assertion' }],
  [{ cookie: 'other=value', authorization: `Bearer ${compact}`, 'cf-access-jwt-assertion': compact }, { token: compact, transport: 'assertion' }],
]) test(`reads one unambiguous credential (${JSON.stringify(headers)})`, () => { assert.deepEqual(readAccessToken(new Headers(headers)), want); });
for (const headers of [
  { 'cf-access-jwt-assertion': `${compact}, ${compact}` },
  { cookie: `CF_Authorization=${compact}; CF_Authorization=${compact}` },
  { cookie: 'CF_Authorization=' }, { cookie: 'CF_Authorization' },
  { authorization: `Bearer ${compact}, Bearer ${compact}` }, { authorization: 'Basic abc' },
  { authorization: 'Bearer bad' }, { 'cf-access-jwt-assertion': '' },
  { 'cf-access-jwt-assertion': compact, authorization: `Bearer ${compact}A` },
  { 'cf-access-jwt-assertion': compact, cookie: `CF_Authorization=${compact}A` },
  { cookie: `CF_Authorization="${compact}"` }, { cookie: `CF_Authorization=${encodeURIComponent(compact + '=')}` },
  { 'cf-access-jwt-assertion': 'a'.repeat(16385) }, { cookie: `other=${'a'.repeat(32769)}` },
]) test(`rejects malformed/ambiguous credential ${JSON.stringify(headers).slice(0, 130)}`, () => { assert.throws(() => readAccessToken(new Headers(headers))); });

for (const [value, want] of [
  [null, '/'], ['', '/'], ['/', '/'], ['/tickets?state=open#first', '/tickets?state=open#first'],
  ['https://hub.auth.test/tickets', '/tickets'], ['/a/../tickets', '/tickets'],
  ['https://attacker.test/', '/'], ['//attacker.test/', '/'], ['\\\\attacker.test/', '/'],
  ['/%2f%2fattacker.test', '/'], ['/%255c%255cattacker.test', '/'], ['/\\attacker.test', '/'],
  ['/signin-with-chatgpt?return_to=/', '/'], ['/a/../signout-with-chatgpt', '/'],
  ['/%73ignin-with-chatgpt', '/'], ['/api/session', '/'], ['/cdn-cgi/access/logout', '/'], ['/auth/login', '/'],
  ['/x\npath', '/'], ['/%0apath', '/'], ['/%', '/'], ['https://u:p@hub.auth.test/tickets', '/'],
]) test(`normalizes safe auth return ${JSON.stringify(value)}`, () => { assert.equal(safeAuthReturn(value, settings.ACCESS_APPLICATION_ORIGIN), want); });

for (const [name, headers, transport, want] of [
  ['same origin cookie', { origin: settings.ACCESS_APPLICATION_ORIGIN, cookie: 'other=x' }, 'cookie', true],
  ['missing origin cookie', { cookie: 'other=x' }, 'cookie', false],
  ['missing origin assertion', {}, 'assertion', false],
  ['programmatic bearer', {}, 'bearer', true],
  ['bearer with supplied foreign origin', { origin: 'https://attacker.test' }, 'bearer', false],
  ['bearer with cookie and missing origin', { cookie: 'other=x' }, 'bearer', false],
  ['bearer with empty cookie and missing origin', { cookie: '' }, 'bearer', false],
  ['same-origin bearer', { origin: settings.ACCESS_APPLICATION_ORIGIN }, 'bearer', true],
  ['same-site foreign origin', { origin: 'https://sub.hub.auth.test', 'sec-fetch-site': 'same-site' }, 'cookie', false],
  ['cross-site metadata cookie', { origin: settings.ACCESS_APPLICATION_ORIGIN, 'sec-fetch-site': 'cross-site' }, 'cookie', false],
  ['cross-site metadata bearer', { 'sec-fetch-site': 'cross-site' }, 'bearer', false],
  ['null origin bearer', { origin: 'null' }, 'bearer', false],
]) test(`write origin policy: ${name}`, () => {
  assert.equal(allowsSessionWrite(new Request(`${settings.ACCESS_APPLICATION_ORIGIN}/api/records`, { method: 'POST', headers }), settings.ACCESS_APPLICATION_ORIGIN, transport), want);
});

for (const value of ['https:hub.auth.test', 'https:/hub.auth.test', 'https:///hub.auth.test', 'https://hub.auth.test/.']) {
  test(`rejects application origins requiring URL repair: ${value}`, () => {
    assert.throws(() => parseAccessConfig({ ...settings, ACCESS_APPLICATION_ORIGIN: value }));
  });
}
test('a provider redirect never selects a token-controlled or redirected JWKS host', async () => {
  await assert.rejects(verifier(async (_input, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://attacker.test/jwks' } });
  })(await sign(), instant));
});
