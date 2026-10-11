import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { localFixture } from '../local/fixture.mjs';
import { issueToken } from '../../lib/local-auth.mts';
import { chromium } from '../browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from '../browser/network.mjs';

const evidence = resolve(process.env.PROJECT_CATALOG_EVIDENCE ?? '.local/catalog-evidence');
mkdirSync(evidence, { recursive: true });
const f = await localFixture(), pageErrors = [];
let restricted;
const api = async (path, owner = 'alice', body) => {
  const response = await fetch(f.origin + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${f[owner + 'Token']}`, origin: f.origin, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
};
try {
  await api('/api/records', 'alice', { kind: 'idea', title: 'Original business idea', project: 'Business project' });
  await api('/api/connectors', 'bob', { action: 'invite', project: 'Bob private project', name: 'Bob client', capabilities: ['read'] });
  restricted = await launchRestrictedBrowser(chromium, [f.origin], { viewport: { width: 1440, height: 1000 } });
  const session = async owner => {
    const issued = await issueToken(f.db, f[owner].userId, { kind: 'browser', ttlSeconds: 600 });
    await restricted.context.clearCookies();
    await restricted.context.addCookies([{ name: 'hub_session', value: issued.token, url: f.origin, httpOnly: true, sameSite: 'Strict' }]);
  };
  await session('alice');
  const page = await restricted.context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(f.origin, { waitUntil: 'networkidle' });
  const sidebar = page.locator('.project-list');
  const quickProject = page.getByLabel('点子所属项目');
  const options = selector => page.locator(selector + ' option').evaluateAll(nodes => nodes.map(n => n.value));
  assert.deepEqual(await options('#projects'), ['Business project', '通用']);
  await sidebar.getByRole('button', { name: 'Business project', exact: true }).click();
  await page.getByRole('button', { name: /连接与执行/ }).click();
  assert.equal(await page.getByLabel('关联项目').inputValue(), 'Business project');
  await page.getByLabel('关联项目').fill('Registered without Ticket');
  await page.getByRole('button', { name: '生成安装授权码' }).click();
  await sidebar.getByRole('button', { name: 'Registered without Ticket', exact: true }).waitFor();
  await page.getByRole('button', { name: '隐藏授权码' }).click();
  const records = await api('/api/records'), connections = await api('/api/connectors');
  assert.deepEqual(records.projects, connections.projects);
  assert.equal(records.records.filter(r => r.project === 'Registered without Ticket').length, 0);
  assert.deepEqual(await options('#connector-projects'), await options('#projects'));
  await page.screenshot({ path: resolve(evidence, 'registered-project.png'), fullPage: true });
  console.log('PASS: real connection UI registers a project without business records and updates every project directory immediately');

  await sidebar.getByRole('button', { name: 'Registered without Ticket', exact: true }).click();
  await page.getByRole('button', { name: /点子收件箱/ }).click();
  assert.equal(await quickProject.inputValue(), 'Registered without Ticket');
  assert.deepEqual(await options('[aria-label="项目筛选"]'), ['全部项目', ...records.projects.map(p => p.name)]);
  await page.getByLabel('快速记录点子').fill('Registered project idea');
  await page.screenshot({ path: resolve(evidence, 'quick-capture-project.png'), fullPage: true });
  await page.getByRole('button', { name: '收集点子', exact: true }).click();
  await page.getByRole('heading', { name: 'Registered project idea', exact: true }).waitFor();
  const saved = (await api('/api/records')).records.find(r => r.title === 'Registered project idea');
  assert.equal(saved.project, 'Registered without Ticket');
  const job = await f.db.prepare('SELECT event FROM jobs WHERE owner=? AND idea_id=?').bind(f.alice.userId, saved.id).first();
  assert.equal(JSON.parse(job.event).data.project, 'Registered without Ticket');
  console.log('PASS: selected sidebar project binds the saved idea and its real planning event');

  await quickProject.fill('Explicit free input');
  await page.getByLabel('快速记录点子').fill('Keep my explicit selection');
  await sidebar.getByRole('button', { name: 'Business project', exact: true }).click();
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.waitForLoadState('networkidle');
  assert.equal(await quickProject.inputValue(), 'Explicit free input');
  assert.equal(await page.getByLabel('快速记录点子').inputValue(), 'Keep my explicit selection');
  await page.getByRole('button', { name: '收集点子', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="快速记录点子"]').value === '');
  const explicit = (await api('/api/records')).records.find(r => r.title === 'Keep my explicit selection');
  assert.equal(explicit.project, 'Explicit free input');
  await sidebar.getByRole('button', { name: 'Explicit free input', exact: true }).waitFor();
  await sidebar.getByRole('button', { name: '全部项目', exact: true }).click();
  assert.equal(await quickProject.inputValue(), '通用');
  await page.getByRole('button', { name: '新点子', exact: true }).click();
  const projectField = page.getByRole('dialog').getByLabel('项目', { exact: true });
  assert.equal(await projectField.getAttribute('list'), 'projects');
  assert.equal(await projectField.inputValue(), '通用');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  console.log('PASS: free input and unsaved explicit project survive real data refresh and sidebar changes; all-project view defaults to 通用 and details use the same options');

  await session('bob');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await sidebar.getByRole('button', { name: 'Bob private project', exact: true }).waitFor();
  assert.deepEqual(await options('#projects'), ['Bob private project', '通用']);
  assert.equal(await quickProject.inputValue(), '通用');
  assert.equal(await sidebar.getByRole('button', { name: 'Registered without Ticket', exact: true }).count(), 0);
  await page.screenshot({ path: resolve(evidence, 'owner-isolation.png'), fullPage: true });
  await restricted.context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('link', { name: '登录', exact: true }).waitFor();
  assert.deepEqual(await options('#projects'), []);
  assert.equal(await sidebar.getByRole('button', { name: 'Bob private project', exact: true }).count(), 0);
  console.log('PASS: account switch and session denial clear the previous owner project catalog');
  await restricted.flushNetworkEvidence();
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(restricted.errors, []);
  assert.deepEqual(restricted.requestedExternal, []);
  console.log('PROJECT_CATALOG_BROWSER_EVIDENCE ' + JSON.stringify({ pageErrors, requestedExternalOrigins: restricted.requestedExternal, blockedRequests: restricted.blocked, networkPolicyErrors: restricted.errors }));
} finally {
  await restricted?.close();
  await f.close();
}
