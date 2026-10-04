import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { loopbackUrl } from '../harness.mjs';

const dev = loopbackUrl(process.env.TEST_DEV_URL).origin;
const preview = loopbackUrl(process.env.TEST_PREVIEW_URL).origin;
const out = process.env.TEST_ARTIFACT_DIR;
const moduleUrl = new URL(process.env.TEST_PLAYWRIGHT_MODULE);
assert.equal(moduleUrl.protocol, 'file:', 'Playwright must use the separately locked local package');
const { chromium } = await import(moduleUrl.href);
const fixture = JSON.parse(await readFile(join(out, 'fixtures.json'), 'utf8'));
const errors = [], checks = [], blocked = [];
let browser, page;
function ok(name) { checks.push(name); console.log('PASS:', name); }
async function evidence(status, error) {
  await writeFile(join(out, 'browser-evidence.json'), JSON.stringify({ status, checks, pageErrors: errors, blockedExternalRequests: blocked, ...(error ? { error: error.message } : {}) }, null, 2) + '\n');
}
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.on('page', current => current.on('pageerror', error => errors.push(error.message)));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'http:' && [dev, preview].includes(url.origin)) return route.continue();
    blocked.push(url.origin);
    return route.abort();
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.protocol === 'ws:' && [dev, preview].includes(url.origin.replace(/^ws:/, 'http:'))) return socket.connectToServer();
    blocked.push(url.origin);
    socket.close();
  });
  page = await context.newPage();
  await page.goto(dev + '/signin-with-chatgpt?return_to=/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '收集点子', exact: true }).waitFor();
  await page.getByRole('heading', { name: fixture.ideaTitle, exact: true }).waitFor();
  ok('Signed-in UI hydrates and loads persisted API records');

  const browserTitle = 'Regression browser synthetic idea ' + Date.now();
  await page.getByRole('textbox', { name: '快速记录点子' }).fill(browserTitle);
  const saved = page.waitForResponse(response => response.url() === dev + '/api/records' && response.request().method() === 'POST' && response.status() === 201);
  const planned = page.waitForResponse(response => response.url() === dev + '/api/planning' && response.request().method() === 'GET' && response.status() === 200);
  await page.getByRole('button', { name: '收集点子', exact: true }).click();
  const [savedResponse, planningResponse] = await Promise.all([saved, planned]);
  const created = await savedResponse.json();
  assert.ok((await planningResponse.json()).jobs.some(job => job.idea_id === created.id && job.status === 'queued' && job.delivery === 'no_subscription'));
  await page.getByRole('heading', { name: browserTitle, exact: true }).waitFor();
  await page.locator('article').filter({ has: page.getByRole('heading', { name: browserTitle, exact: true }) }).getByText('已排队 · 待连接插件', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="快速记录点子"]').value === '');
  assert.equal(await page.getByRole('textbox', { name: '快速记录点子' }).inputValue(), '');
  ok('Browser captures idea, creates planning request and updates UI');

  await page.getByRole('button', { name: '规划工作台', exact: false }).click();
  await page.getByRole('heading', { name: fixture.planTitle, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Ticket 看板', exact: false }).click();
  await page.getByRole('heading', { name: fixture.ticketTitle, exact: true }).waitFor();
  await page.getByRole('button', { name: '执行记录', exact: false }).click();
  await page.getByRole('heading', { name: fixture.runTitle, exact: true }).waitFor();
  await page.getByText('查看冻结的任务约定', { exact: true }).click();
  const frozen = page.locator('details[open]');
  assert.match(await frozen.innerText(), /Validate snapshot/);
  assert.match(await frozen.innerText(), /Loopback only/);
  assert.match(await frozen.innerText(), /Snapshot is immutable/);
  ok('Plan, Ticket board and frozen Run evidence views render');

  const brand = page.getByRole('link', { name: '点子工坊 AGENT TASK HUB' });
  await page.getByRole('button', { name: 'Ticket 看板', exact: false }).click();
  await page.getByRole('textbox', { name: '搜索', exact: true }).fill(fixture.ticketTitle);
  await page.getByRole('combobox', { name: '项目筛选', exact: true }).selectOption(fixture.project);
  await page.getByRole('combobox', { name: '状态筛选', exact: true }).selectOption('done');
  await page.getByRole('heading', { name: 'Ticket 看板', exact: true }).waitFor();
  const popupPromise = context.waitForEvent('page');
  await brand.click({ modifiers: ['Control'] });
  const popup = await popupPromise;
  await popup.waitForLoadState('networkidle');
  await popup.close();
  assert.equal(await page.getByRole('textbox', { name: '搜索', exact: true }).inputValue(), fixture.ticketTitle);
  assert.equal(await page.getByRole('combobox', { name: '项目筛选', exact: true }).inputValue(), fixture.project);
  assert.equal(await page.getByRole('combobox', { name: '状态筛选', exact: true }).inputValue(), 'done');
  await page.getByRole('heading', { name: 'Ticket 看板', exact: true }).waitFor();
  ok('Modified brand navigation opens home while preserving current workspace filters');

  const refreshed = page.waitForResponse(response => response.url() === dev + '/api/records' && response.request().method() === 'GET' && response.status() === 200);
  await brand.click();
  await refreshed;
  await page.getByRole('button', { name: '收集点子', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '搜索', exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('combobox', { name: '项目筛选', exact: true }).inputValue(), '全部项目');
  assert.equal(await page.getByRole('combobox', { name: '状态筛选', exact: true }).count(), 0);
  await page.getByRole('heading', { name: browserTitle, exact: true }).waitFor();
  ok('Normal brand navigation restores inbox and clears workspace filters');
  await page.screenshot({ path: join(out, 'dev-ui.png'), fullPage: true });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: browserTitle, exact: true }).waitFor();
  ok('Synthetic records persist across browser reload');
  await page.goto(preview + '/', { waitUntil: 'networkidle' });
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /登录/);
  ok('Built preview hydrates and displays anonymous API auth failure');
  assert.deepEqual(errors, [], 'Browser JavaScript errors');
  assert.ok(blocked.every(origin => origin === 'https://fonts.googleapis.com'), 'Unexpected external browser request');
  ok('Remote requests blocked; UI remains usable with system fonts');
  await evidence('passed');
} catch (error) {
  await evidence('failed', error);
  if (page) await page.screenshot({ path: join(out, 'browser-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await browser?.close(); }
