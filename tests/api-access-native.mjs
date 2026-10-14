// Real OpenAI-compatible API Call acceptance: node --experimental-strip-types tests/api-access-native.mjs
// Requires a built app, API_ACCESS_PROFILE (default "mimo") resolving to a Codex
// profile with base_url/env_key/model, and that key variable set in this shell.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { localFixture, fixtureEnvironment } from './local/fixture.mjs';
import { codexMetadata } from '../connector/codex-config.mjs';
import { tool } from '../connector/common.mjs';
import { chromium } from './browser/node_modules/playwright/index.mjs';
import { launchRestrictedBrowser } from './browser/network.mjs';

const profile = process.env.API_ACCESS_PROFILE || 'mimo';
const metadata = await codexMetadata({ profile });
if (!metadata.envKey || !process.env[metadata.envKey]) { console.log(`SKIP: profile ${profile} key variable ${metadata.envKey || '(none)'} is not set`); process.exit(0); }
const key = process.env[metadata.envKey];
const directory = await mkdtemp(join(tmpdir(), 'hub-api-access-')), children = new Set();
const redact = value => String(value).split(key).join('[redacted]');
let fixture, browser, agent;
function launch(args, options = {}) {
  const child = spawn(process.execPath, args, { cwd: directory, env: { ...fixtureEnvironment(), HOME: process.env.HOME, [metadata.envKey]: key }, detached: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const closed = new Promise(accept => child.once('close', code => { children.delete(child); accept({ code, stdout, stderr }); }));
  child.stdin.end(options.input ?? '');
  return { child, closed };
}
async function command(args, options) { const result = await launch(args, options).closed; assert.equal(result.code, 0, redact(result.stderr)); return result; }
async function owner(path, body) {
  const response = await fetch(fixture.origin + path, { headers: { authorization: 'Bearer ' + fixture.aliceToken, origin: fixture.origin, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  assert.equal(response.ok, true, `${path} ${response.status}`); return response.json();
}
async function waitFor(callback, message, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await callback(); if (value) return value; await new Promise(accept => setTimeout(accept, 1000)); }
  throw Error(message);
}
try {
  fixture = await localFixture();
  const project = join(directory, 'project'); await mkdir(project);
  const git = (...args) => command(['-e', `require('child_process').execFileSync('git',${JSON.stringify(args)},{cwd:${JSON.stringify(project)}})`]);
  await writeFile(join(project, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(join(project, 'README.md'), '# Fixture\n`sum(a, b)` in sum.mjs should return the sum of two numbers.\n');
  await git('init', '-q'); await git('add', '.'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture baseline');
  const invitation = await owner('/api/connectors', { action: 'invite', project: 'API access acceptance', name: 'API Call Agent', capabilities: ['read', 'submit', 'plan', 'execute'] });
  await command([join(import.meta.dirname, '../connector/cli.mjs'), 'install', '--url', fixture.origin, '--workspace', project, '--code-stdin', '--name', 'API Call Agent', '--access', 'api', '--api-profile', profile], { input: invitation.code + '\n' });
  const config = JSON.parse(await readFile(join(project, '.agent-task-hub/connection.json'), 'utf8'));
  assert.ok(!JSON.stringify(config).includes(key));
  const doctor = await command([config.runtime, 'doctor', '--config', config.file]);
  assert.match(doctor.stdout, /Access: API Call \(OpenAI-compatible\)/); assert.match(doctor.stdout, /Agent: ready/);
  console.log('PASS: installed API Call access is ready against the real endpoint; key not stored');

  const idea = await tool(config, 'create_idea', { request_id: 'api-access-idea', title: 'Fix sum', text: 'sum() in sum.mjs subtracts instead of adding. Plan exactly one Ticket to fix it and add a node:test test.' });
  await command([config.runtime, 'agent', '--config', config.file, '--once'], { cwd: project });
  const job = (await tool(config, 'list_planning_jobs')).jobs.find(entry => entry.id === idea.job_id);
  assert.equal(job?.status, 'done', 'Real API planning did not finish: ' + redact(job?.planner_error || job?.status));
  const ticket = (await tool(config, 'get_ticket', { ticket_id: JSON.parse(job.result).ticket_ids[0] })).ticket;
  console.log('PASS: real API planning saved a Plan and Ticket:', ticket.title);

  const prepared = await owner('/api/workspace-runs', { action: 'prepare', ticketId: ticket.id, revision: ticket.revision, connectionId: config.connectionId, requestId: 'api-access-development', timeoutMs: 900000 });
  await owner('/api/workspace-runs', { action: 'approve', runId: prepared.run.id });
  agent = launch([config.runtime, 'agent', '--config', config.file], { cwd: project });
  let lastState;
  agent.child.stderr.on('data', data => process.stderr.write('AGENT: ' + redact(data)));
  const run = await waitFor(async () => {
    const current = (await owner('/api/workspace-runs?runId=' + encodeURIComponent(prepared.run.id))).run;
    if (current.state !== lastState) { lastState = current.state; console.log('RUN state:', current.state, (current.events || []).slice(-3).map(event => `${event.stage}: ${event.message}`).join(' | ')); }
    if (current.state === 'failed') throw Error('API development failed: ' + current.error);
    return current.state === 'review' ? current : null;
  }, 'API development did not reach review', Number(process.env.API_ACCESS_DEV_TIMEOUT_MS || 900000));
  assert.ok(run.result.files.includes('sum.mjs')); assert.ok(run.result.tests.every(test => test.exitCode === 0));
  assert.equal(await readFile(join(project, 'sum.mjs'), 'utf8'), 'export const sum = (a, b) => a - b;\n');
  console.log('PASS: real API development delivered a worktree diff with passing receipts:', run.result.files.join(', '), '|', run.result.tests.map(test => test.command).join('; '));

  browser = await launchRestrictedBrowser(chromium, [fixture.origin], { viewport: { width: 1440, height: 1000 } });
  const page = await browser.context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(fixture.origin + '/signin?return_to=/'); await page.getByLabel('用户名').fill('alice'); await page.getByLabel('密码').fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click(); await page.getByRole('button', { name: '连接与执行', exact: false }).click();
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'API Call Agent', exact: true }) });
  await card.getByText(/接入方式：API Call（OpenAI 兼容）/).waitFor(); await card.getByText('开发 Agent：可用', { exact: true }).waitFor();
  console.log('PASS: connection page shows API Call access and ready status:', (await card.getByText(/接入方式/).innerText()));
  console.log('VERIFIED_API_ACCESS', JSON.stringify({ profile, model: metadata.model, runId: run.id, files: run.result.files, tests: run.result.tests.map(({ command, exitCode }) => ({ command, exitCode })) }));
} finally {
  if (agent) { try { process.kill(-agent.child.pid, 'SIGTERM'); } catch { /* exited */ } await Promise.race([agent.closed, new Promise(accept => setTimeout(accept, 3000))]); }
  for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }
  await browser?.close(); await fixture?.close(); await rm(directory, { recursive: true, force: true });
}
