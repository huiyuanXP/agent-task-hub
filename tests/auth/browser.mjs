// Test-only loopback ingress translates the browser origin to the configured
// HTTPS application origin. Every session/data response comes from the real
// built Worker, D1, and JOSE verifier. No live Access tenant or DNS is contacted.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { chromium } from '../browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from '../browser/network.mjs';
const origin = 'https://hub.example.test', issuer = 'https://browser-team.cloudflareaccess.com', audience = 'b'.repeat(64);
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'browser', alg: 'RS256', use: 'sig' };
const token = (sub, seconds = 600) => new SignJWT({ type: 'app', email: `${sub}@example.test`, name: `${sub === 'alice' ? 'Alice' : 'Bob'} Member` }).setProtectedHeader({ alg: 'RS256', kid: 'browser', typ: 'JWT' }).setIssuer(issuer).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(privateKey);
const alice = await token('alice'), bob = await token('bob');
let current = alice, denyPath, deniedToken, hold = false, releaseHeld, heldCount = 0, restricted, worker, base;
const errors = [], outbound = [], requests = [];
const temporary = mkdtempSync(join(tmpdir(), 'auth-browser-'));
let holdGate;
let holdPaths = ['/api/records', '/api/planning'];
function holdResponses(paths) {
  holdPaths = paths; heldCount = 0;
  holdGate = new Promise(resolve => { releaseHeld = resolve; }); hold = true;
}
async function waitForHeld(count) {
  const deadline = Date.now() + 5000;
  while (heldCount < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(heldCount >= count, 'Real Worker responses reached the delayed ingress boundary');
}
const facade = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, origin).pathname;
    requests.push({ path, method: req.method });
    if (path === '/cdn-cgi/access/logout') {
      // Provider-owned redirect terminus only; local revocation is checked below.
      res.end('Synthetic provider logout boundary'); return;
    }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers(req.headers);
    headers.delete('host'); headers.delete('authorization'); headers.delete('cookie');
    headers.set('cf-access-jwt-assertion', path === '/api/records' && deniedToken ? deniedToken : current);
    if (headers.get('origin') === base) headers.set('origin', origin);
    const response = await worker.dispatchFetch((denyPath === path ? 'https://alternate.example.test' : origin) + req.url, {
      method: req.method, headers, redirect: 'manual', ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (hold && holdPaths.includes(path)) { heldCount++; await holdGate; }
    const outgoing = Object.fromEntries(response.headers);
    delete outgoing['content-encoding']; delete outgoing['content-length'];
    if (outgoing.location?.startsWith(origin)) outgoing.location = base + outgoing.location.slice(origin.length);
    res.writeHead(response.status, outgoing); res.end(body);
  } catch (error) { errors.push(String(error)); res.writeHead(500); res.end('Fixture failed'); }
});
async function api(path, jwt = current, body) {
  const response = await worker.dispatchFetch(origin + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + jwt, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
}
try {
  const config = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
  worker = new Miniflare({ host: '127.0.0.1', port: 0, modulesRoot: 'dist/server',
    modules: [config.main, ...readdirSync('dist/server', { recursive: true }).filter(path => /\.m?js$/.test(path) && path !== config.main)].map(path => ({ type: 'ESModule', path: join('dist/server', path) })),
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    bindings: { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: audience, ACCESS_APPLICATION_ORIGIN: origin, ACCESS_ALLOWED_EMAILS: '["alice@example.test","bob@example.test"]' },
    d1Databases: { DB: '00000000-0000-4000-8000-000000000000' }, d1Persist: join(temporary, 'd1'),
    assets: { directory: 'dist/client', binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false } },
    outboundService: request => { outbound.push(request.url); return request.url === issuer + '/cdn-cgi/access/certs' ? Response.json({ keys: [jwk] }) : new Response('Denied', { status: 403 }); },
  });
  await worker.ready;
  const db = await worker.getD1Database('DB');
  for (const migration of readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) for (const sql of readFileSync(join('drizzle', migration), 'utf8').split('--> statement-breakpoint').filter(sql => sql.trim())) await db.prepare(sql).run();
  const idea = await api('/api/records', alice, { kind: 'idea', title: 'Alice private idea', text: 'Private body', project: 'Alice project' });
  await api('/api/planning', alice, { ideaId: idea.id });
  await api('/api/records', bob, { kind: 'idea', title: 'Bob private idea' });
  await new Promise(resolve => facade.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${facade.address().port}`;
  restricted = await launchRestrictedBrowser(chromium, [base], { viewport: { width: 1440, height: 1000 } });
  restricted.context.on('page', page => page.on('pageerror', error => errors.push(error.stack ?? error.message)));
  const page = await restricted.context.newPage(); page.setDefaultTimeout(7000);
  const identity = name => page.getByLabel('当前账户').getByText(name, { exact: true });
  const refresh = async () => { const done = page.waitForResponse(r => r.url() === base + '/api/session'); await page.getByRole('button', { name: '刷新数据' }).click(); await done; };
  const visibleAlice = async () => { await identity('Alice Member').waitFor(); await page.getByRole('heading', { name: 'Alice private idea', exact: true }).waitFor(); };
  const privateDraft = async () => {
    await page.getByRole('textbox', { name: '快速记录点子' }).fill('Unsaved private capture');
    await page.getByRole('button', { name: '新点子', exact: true }).click();
    await page.getByRole('dialog').getByRole('textbox').first().fill('Unsaved private draft');
  };
  const cleared = async (timeout = 7000) => {
    await page.getByRole('link', { name: '登录', exact: true }).waitFor({ timeout });
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByRole('textbox', { name: '快速记录点子' }).inputValue(), '');
    assert.equal(await page.getByText('Alice Member', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Alice private idea', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /点子收件箱/ }).innerText(), '点子收件箱\n0');
    assert.equal(await page.getByRole('combobox', { name: '项目筛选', exact: true }).inputValue(), '全部项目');
  };
  await page.goto(base, { waitUntil: 'networkidle' });
  await visibleAlice();
  assert.equal(await page.getByLabel('账户缩写').innerText(), 'AM');
  assert.equal(await page.getByText('本地开发身份').count(), 0);
  console.log('PASS: actual verified session renders name and initials');
  const brand = page.getByRole('link', { name: '点子工坊 AGENT TASK HUB' });
  await page.getByRole('textbox', { name: '搜索', exact: true }).fill('private');
  const popupReady = restricted.context.waitForEvent('page'); await brand.click({ modifiers: ['Control'] }); const popup = await popupReady;
  await popup.waitForLoadState('networkidle'); await popup.close();
  assert.equal(await page.getByRole('textbox', { name: '搜索', exact: true }).inputValue(), 'private');
  await brand.click(); await visibleAlice(); assert.equal(await page.getByRole('textbox', { name: '搜索', exact: true }).inputValue(), '');
  console.log('PASS: independent identity preserves normal and modified home navigation');
  await privateDraft(); current = bob;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await identity('Bob Member').waitFor(); await page.getByRole('heading', { name: 'Bob private idea', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await page.getByRole('textbox', { name: '快速记录点子' }).inputValue(), '');
  assert.equal(await page.getByText('Alice private idea', { exact: true }).count(), 0);
  console.log('PASS: account switch discards old rows and unsaved private state');
  current = alice; await refresh(); await visibleAlice();
  await db.prepare('ALTER TABLE auth_revocations RENAME TO unavailable_revocations').run();
  await refresh(); await page.getByRole('alert').waitFor(); await visibleAlice();
  assert.equal(await page.getByRole('link', { name: '登录', exact: true }).count(), 0);
  await db.prepare('ALTER TABLE unavailable_revocations RENAME TO auth_revocations').run();
  console.log('PASS: real storage 503 keeps identity distinct from expired authentication');
  await privateDraft(); current = await token('outsider');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await cleared();
  console.log('PASS: real nonmember 401 clears private rows, draft, capture and account');
  current = alice; await refresh(); await visibleAlice(); await privateDraft(); deniedToken = await token('outsider');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await cleared(); deniedToken = undefined;
  console.log('PASS: real records 401 clears private state even when session succeeds');
  current = alice; await refresh(); await visibleAlice(); await privateDraft(); denyPath = '/api/planning';
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await cleared(); denyPath = undefined;
  console.log('PASS: real data 403 clears private state even when session succeeds');
  current = alice; await refresh(); await visibleAlice(); await privateDraft();
  holdResponses(['/api/planning']); deniedToken = await token('outsider');
  const recordsDenied = page.waitForResponse(r => r.url() === base + '/api/records' && r.status() === 401);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await recordsDenied; await waitForHeld(1);
  await cleared(2000); // Must clear while the successful planning response is still held.
  hold = false; releaseHeld(); deniedToken = undefined;
  await page.waitForLoadState('networkidle'); await cleared();
  console.log('PASS: records 401 clears promptly while sibling planning response remains pending');
  current = alice; await refresh(); await visibleAlice(); await privateDraft();
  holdResponses(['/api/records']); denyPath = '/api/planning';
  const planningDenied = page.waitForResponse(r => r.url() === base + '/api/planning' && r.status() === 403);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await planningDenied; await waitForHeld(1); await cleared(2000);
  hold = false; releaseHeld(); denyPath = undefined;
  await page.waitForLoadState('networkidle'); await cleared();
  console.log('PASS: planning 403 clears promptly while sibling records response remains pending');
  current = alice; await refresh(); await visibleAlice();
  holdResponses(['/api/records']); deniedToken = await token('outsider');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await waitForHeld(1);
  // Keep the old denial held, but let the new account's refresh proceed.
  hold = false; deniedToken = undefined; current = bob;
  await refresh(); await identity('Bob Member').waitFor();
  await page.getByRole('heading', { name: 'Bob private idea', exact: true }).waitFor();
  const staleDenial = page.waitForResponse(r => r.url() === base + '/api/records' && r.status() === 401);
  releaseHeld(); await staleDenial; await page.waitForLoadState('networkidle');
  await identity('Bob Member').waitFor();
  await page.getByRole('heading', { name: 'Bob private idea', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '登录', exact: true }).count(), 0);
  console.log('PASS: delayed old-account denial cannot clear the newer verified account');
  current = await token('alice', 10); await refresh(); await visibleAlice(); await privateDraft();
  holdResponses(['/api/records', '/api/planning']);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitForHeld(2);
  await page.getByRole('link', { name: '登录', exact: true }).waitFor({ timeout: 12000 }); await cleared();
  hold = false; releaseHeld();
  await page.waitForLoadState('networkidle'); await cleared();
  console.log('PASS: deadline expires without refresh and delayed successful responses cannot restore private state');
  current = alice; await refresh(); await visibleAlice();
  const logout = page.waitForResponse(r => r.url() === base + '/signout-with-chatgpt' && r.request().method() === 'POST');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  assert.equal((await logout).status(), 303);
  await page.waitForURL(base + '/cdn-cgi/access/logout');
  const replay = await worker.dispatchFetch(origin + '/api/session', { headers: { authorization: 'Bearer ' + alice } });
  assert.equal(replay.status, 401); await replay.text();
  console.log('PASS: actual same-origin POST logout immediately revokes the browser token');
  assert.deepEqual(errors, []); assert.deepEqual(restricted.errors, []);
  assert.ok(restricted.blocked.every(url => url === 'https://fonts.googleapis.com'));
  assert.ok(outbound.every(url => url === issuer + '/cdn-cgi/access/certs'));
  assert.ok(requests.some(r => r.path === '/api/session'));
  console.log('PASS: no page errors or unexpected outbound requests');
} finally {
  hold = false; releaseHeld?.(); await restricted?.close();
  facade.closeAllConnections(); if (facade.listening) await new Promise(resolve => facade.close(resolve));
  await worker?.dispose(); rmSync(temporary, { recursive: true, force: true });
}
