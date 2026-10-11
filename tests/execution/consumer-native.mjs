// Real consumer CLI processes against an owned native Next/SQLite fixture and a
// cryptographically verified synthetic loopback peer; no Docker execution claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localFixture, fixtureEnvironment } from '../local/fixture.mjs';
import { issueToken, revokeToken } from '../../lib/local-auth.mts';
import { workerBackendFixture } from './fixtures/worker-backend.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const children = new Set(), proxies = new Set();
let processCount = 0, disconnectCount = 0;
const peer = await workerBackendFixture();
let f, tokenFile;
async function until(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timed out waiting for owned fixture: ${label}`);
}
async function api(path, body, token = f.aliceToken) {
  const response = await fetch(f.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { origin: f.origin, 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assert.ok(Buffer.byteLength(text) <= 1024 * 1024);
  return { status: response.status, json: JSON.parse(text) };
}
async function prepared(expiresAt = Date.now() + 600000) {
  const ticketId = randomUUID(), now = new Date().toISOString();
  await f.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind(ticketId, f.alice.userId, 'ticket', JSON.stringify({ title: 'Synthetic native consumer', status: 'todo', project: 'Synthetic' }), 1, now, now).run();
  const catalog = await api(`/api/authorization?ticketId=${ticketId}&expectedRevision=1`); assert.equal(catalog.status, 200);
  const p = await api('/api/authorization', { action: 'prepare', ticketId, expectedRevision: 1, requestId: randomUUID(), attempt: 1, scope: catalog.json.operations.slice(0, 1).map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt });
  assert.equal(p.status, 201);
  assert.equal((await api('/api/authorization', { action: 'decide', authorizationId: p.json.authorization.id, decisionId: randomUUID(), outcome: 'approved' })).status, 200);
  return p.json.run;
}
function journal(directory) { return JSON.parse(readFileSync(join(directory, 'journal.json'), 'utf8')); }
function privacy(directory, ownerToken = f.aliceToken) {
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'journal.json')).mode & 0o777, 0o600);
  const value = journal(directory), text = JSON.stringify(value);
  assert.equal(value.version, 1); assert.ok(!text.includes(ownerToken), 'Bootstrap issuer token must not be retained in journal');
  return value;
}
function cli(command, run, directory, { endpoint = `${f.origin}/api/execution/worker-mcp`, token = tokenFile, fd = false, extra = [] } = {}) {
  const args = ['--experimental-strip-types', 'runner/consumer.mjs', command, '--endpoint', endpoint, '--run-id', run.id, '--state-dir', directory];
  const stdio = ['ignore', 'pipe', 'pipe'];
  let descriptor;
  if (command !== 'run') {
    if (fd) { descriptor = openSync(token, 'r'); stdio.push(descriptor); args.push('--token-fd', '3'); }
    else args.push('--token-file', token);
  }
  args.push(...extra);
  const child = spawn(process.execPath, args, { env: fixtureEnvironment(), stdio });
  processCount++;
  if (descriptor !== undefined) closeSync(descriptor);
  children.add(child);
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit').then(([code, signal]) => { children.delete(child); return { code, signal, stdout, stderr }; });
  const handle = { child, exited, result: null };
  exited.then(value => { handle.result = value; }); return handle;
}
async function finished(process, status, code = 0) {
  let deadline;
  const value = await Promise.race([process.exited, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`Owned CLI exceeded test bound: ${status}`)), 15000); })]).finally(() => clearTimeout(deadline));
  const safeReason = (() => { try { const reason = JSON.parse(value.stdout.trim()).reason; return typeof reason === 'string' && /^[A-Z_]+$/.test(reason) ? reason : 'NONE'; } catch { return 'NONE'; } })();
  assert.equal(value.code, code, `Unexpected CLI exit for ${status}: ${safeReason}`);
  const lines = value.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'CLI stdout must contain one safe JSON result');
  const output = JSON.parse(lines[0]); assert.equal(output.status, status);
  assert.ok(!value.stdout.includes(f.aliceToken) && !value.stderr.includes(f.aliceToken));
  return { ...value, output };
}
async function nativeWorkerRead(directory) {
  const w = journal(directory).data.worker;
  return api('/api/execution/worker-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_execution_runs', arguments: {} } }, `athw1.${w.credentialId}.${w.secret}`);
}
async function killed(process) {
  assert.equal(process.child.kill('SIGKILL'), true);
  assert.equal((await process.exited).signal, 'SIGKILL');
}
async function failed(process) {
  const value = await process.exited;
  assert.equal(value.code, 1); assert.equal(value.stdout, '');
  const error = JSON.parse(value.stderr.trim().split('\n').at(-1));
  assert.equal(error.error, 'Consumer operation failed');
  assert.ok(!value.stderr.includes(f.aliceToken));
  return error;
}
async function permitRow(run) {
  return f.db.prepare('SELECT * FROM execution_permits WHERE run_id=?').bind(run.id).first();
}
async function faultProxy(directory, droppedKinds = []) {
  // This proxy can reach only this fixture's two native worker routes. Native
  // Host/Origin are supplied by this owned test boundary, never by the caller.
  const native = new URL(f.origin), remaining = new Set(droppedKinds), requests = [], dropped = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.ok(['/api/execution/workers', '/api/execution/worker-mcp'].includes(req.url));
      let bytes = 0, raw = '';
      for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 16384); raw += chunk; }
      const body = JSON.parse(raw), input = body.params?.arguments ?? body;
      const kind = body.action ?? (body.method === 'tools/call' ? body.params.name.replace('_execution_run', '') : body.method);
      const state = privacy(directory).data;
      if (kind === 'provision') {
        assert.equal(input.credentialId, state.worker.credentialId); assert.equal(input.requestId, state.worker.requestId);
        assert.equal(input.verifier, hash(state.worker.secret));
      } else if (kind === 'revoke') assert.equal(input.requestId, state.revoke.requestId);
      else if (kind === 'claim') {
        assert.equal(input.leaseId, state.lease.leaseId); assert.equal(input.requestId, state.lease.requestId);
        assert.equal(input.verifier, hash(state.lease.secret)); assert.equal(input.mode, state.lease.mode);
      } else if (['start', 'renew', 'report', 'complete', 'cancel'].includes(kind)) {
        const action = state.actions[kind];
        assert.equal(input.requestId, action.requestId); assert.equal(action.completed, false);
        assert.equal(input.leaseToken, `athl1.${action.leaseId}.${action.generation}.${state.lease.secret}`);
      }
      if (Object.hasOwn(input, 'runId')) assert.equal(input.runId, journal(directory).runId);
      const record = { kind, requestId: input.requestId, at: Date.now(), inputHash: hash(JSON.stringify(input)), response: null };
      requests.push(record);
      const reply = await new Promise((resolve, reject) => {
        const upstream = httpRequest(new URL(req.url, native), { method: 'POST', headers: { host: native.host, origin: native.origin, authorization: req.headers.authorization, 'content-type': 'application/json' } }, response => {
          let text = '', size = 0;
          response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { response.destroy(); reject(new Error('Owned response bound')); } else text += chunk; });
          response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode, text, type: response.headers['content-type'] }));
        });
        upstream.on('error', reject); upstream.end(raw);
      });
      let parsed;
      try { parsed = reply.status === 204 && reply.text === '' ? {} : JSON.parse(reply.text); }
      catch { throw new Error(`Owned upstream ${kind} status ${reply.status} content-type ${reply.type}`); }
      record.response = body.method ? parsed.result?.structuredContent : parsed.worker;
      record.status = reply.status; record.code = parsed.error?.data?.code;
      if (proxy.delayMs) await new Promise(resolve => setTimeout(resolve, proxy.delayMs));
      if (remaining.has(kind) && reply.status < 300 && (body.action || parsed.result)) {
        remaining.delete(kind); dropped.push(record); disconnectCount++;
        // Deliver real headers, then break the socket before any JSON body.
        res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reply.text) });
        res.flushHeaders(); setImmediate(() => res.destroy());
      } else { res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(reply.text); }
    } catch (error) { errors.push(error); if (!res.destroyed) { res.writeHead(500); res.end('{}'); } }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const proxy = { endpoint: `http://127.0.0.1:${server.address().port}/api/execution/worker-mcp`, requests, dropped, errors, delayMs: 0,
    async close() { proxies.delete(proxy); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
  proxies.add(proxy); return proxy;
}
async function bootstrap(run, directory, options = {}) { return finished(cli('bootstrap', run, directory, options), 'bootstrapped'); }
async function started(run) { return until(() => peer.requests.find(value => value.path === '/start' && value.permit?.runId === run.id), 'real backend start'); }

try {
  f = await localFixture({ env: peer.env });
  tokenFile = join(f.dir, 'synthetic-issuer.token'); writeFileSync(tokenFile, f.aliceToken + '\n', { mode: 0o600 }); chmodSync(tokenFile, 0o600);
  const run = await prepared(), directory = join(f.dir, 'consumer-normal');
  await finished(cli('bootstrap', run, directory), 'bootstrapped');
  const bootstrapped = privacy(directory);
  assert.equal(bootstrapped.runId, run.id); assert.equal(bootstrapped.endpoint, `${f.origin}/api/execution/worker-mcp`);
  assert.equal(hash(bootstrapped.data.worker.secret), bootstrapped.data.worker.verifier);
  const credential = await f.db.prepare('SELECT credential_id,expires_at FROM execution_worker_credentials WHERE run_id=?').bind(run.id).first();
  assert.equal(credential.credential_id, bootstrapped.data.worker.credentialId); assert.equal(credential.expires_at, bootstrapped.data.worker.issued.expiresAt);
  peer.setResult(run.id, { phase: 'stopped', purposes: ['result', 'stop'] });
  const closed = await finished(cli('run', run, directory), 'closed');
  assert.equal(closed.output.runId, run.id);
  assert.equal((await f.db.prepare('SELECT state FROM execution_runs WHERE id=?').bind(run.id).first()).state, 'succeeded');
  const permit = await f.db.prepare('SELECT id,closed_at,deadline_ms FROM execution_permits WHERE run_id=?').bind(run.id).first();
  assert.ok(permit.closed_at !== null); assert.equal(closed.output.permitId, permit.id);
  assert.deepEqual((await f.db.prepare('SELECT purpose FROM backend_attestations WHERE permit_id=? ORDER BY purpose').bind(permit.id).all()).results.map(row => row.purpose), ['result', 'stop']);
  const completedJournal = privacy(directory); assert.equal(completedJournal.data.done, true);
  for (const secret of [completedJournal.data.worker.secret, completedJournal.data.lease.secret]) assert.ok(!closed.stdout.includes(secret) && !closed.stderr.includes(secret), 'CLI result leaked private runtime secret');
  await finished(cli('revoke', run, directory, { fd: true }), 'revoked');
  const revoked = await f.db.prepare('SELECT revoked_at FROM execution_worker_credentials WHERE credential_id=?').bind(credential.credential_id).first();
  assert.ok(revoked.revoked_at !== null); assert.equal((await nativeWorkerRead(directory)).status, 401);
  await finished(cli('revoke', run, directory), 'revoked');
  assert.equal((await f.db.prepare('SELECT revoked_at FROM execution_worker_credentials WHERE credential_id=?').bind(credential.credential_id).first()).revoked_at, revoked.revoked_at);

  const lossRun = await prepared(), lossDirectory = join(f.dir, 'consumer-response-loss');
  const loss = await faultProxy(lossDirectory, ['provision', 'claim', 'start', 'report', 'renew', 'complete', 'revoke']);
  const lossOptions = { endpoint: loss.endpoint };
  await failed(cli('bootstrap', lossRun, lossDirectory, lossOptions));
  assert.equal(journal(lossDirectory).data.worker.issued, null);
  const provisionReply = loss.dropped.find(item => item.kind === 'provision').response;
  await bootstrap(lossRun, lossDirectory, lossOptions);
  assert.deepEqual(journal(lossDirectory).data.worker.issued, provisionReply);
  const reportMessage = 'Synthetic report 🌈 "quoted" \\ persisted before transport';
  let active = cli('run', lossRun, lossDirectory, { ...lossOptions, extra: ['--message', reportMessage] });
  for (const kind of ['claim', 'start', 'report', 'renew']) {
    await until(() => {
      if (loss.errors.length) throw new Error(`Proxy invariant failed: ${loss.errors[0].message.startsWith('Owned upstream') ? loss.errors[0].message : loss.errors[0].stack.split('\n').filter(line => line.trim().startsWith('at ')).join(' ')}`);
      if (active.result) throw new Error(`Consumer exited before ${kind} reply disconnect: ${active.result.code}; ${active.result.stderr.trim().split('\n').at(-1)}`);
      return loss.dropped.find(item => item.kind === kind);
    }, `lost ${kind} reply`);
    await killed(active);
    const state = privacy(lossDirectory).data;
    if (kind === 'claim') assert.equal(state.lease.grant, null);
    else assert.equal(state.actions[kind].completed, false);
    if (kind === 'report') assert.equal(state.actions.report.message, reportMessage);
    active = cli('run', lossRun, lossDirectory, { ...lossOptions, ...(['claim', 'start'].includes(kind) ? { extra: ['--message', reportMessage] } : {}) });
  }
  await until(() => journal(lossDirectory).data.actions.renew.completed, 'renew replay journal acknowledgement');
  const originalPermit = await permitRow(lossRun);
  peer.setResult(lossRun.id, { phase: 'stopped', purposes: ['result', 'stop'] });
  await until(() => loss.dropped.find(item => item.kind === 'complete'), 'lost complete reply');
  await killed(active);
  assert.equal(journal(lossDirectory).data.actions.complete.completed, false);
  await finished(cli('run', lossRun, lossDirectory, lossOptions), 'closed');
  assert.equal(journal(lossDirectory).data.actions.complete.completed, true);
  const recoveredPermit = await permitRow(lossRun);
  assert.equal(recoveredPermit.id, originalPermit.id); assert.equal(recoveredPermit.deadline_ms, originalPermit.deadline_ms);
  assert.equal(peer.requests.filter(item => item.path === '/start' && item.permit.runId === lossRun.id).length, 1);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_worker_credentials WHERE run_id=?').bind(lossRun.id).first()).n, 1);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_worker_leases WHERE run_id=?').bind(lossRun.id).first()).n, 1);
  await failed(cli('revoke', lossRun, lossDirectory, lossOptions));
  assert.ok(journal(lossDirectory).data.revoke.requestId); assert.ok(!journal(lossDirectory).data.worker.revoked);
  await finished(cli('revoke', lossRun, lossDirectory, lossOptions), 'revoked');
  assert.deepEqual(loss.dropped.map(item => item.kind), ['provision', 'claim', 'start', 'report', 'renew', 'complete', 'revoke']);
  for (const dropped of loss.dropped) {
    const retries = loss.requests.filter(item => item.kind === dropped.kind && item.requestId === dropped.requestId);
    assert.ok(retries.length >= 2, `Persisted ${dropped.kind} request was not replayed`);
    for (const retry of retries) { assert.equal(retry.inputHash, dropped.inputHash); if (retry.response) assert.deepEqual(retry.response, dropped.response); }
  }
  assert.equal(loss.errors.length, 0); await loss.close();

  // Real elapsed time exercises periodic renewal; live kernel flock must reject
  // a second independent consumer before it sends another machine request.
  const timerRun = await prepared(), timerDirectory = join(f.dir, 'consumer-timer-sigterm');
  const timerProxy = await faultProxy(timerDirectory), timerOptions = { endpoint: timerProxy.endpoint };
  await bootstrap(timerRun, timerDirectory, timerOptions);
  const slowResult = peer.holdNext('/result', timerRun.id);
  const timerProcess = cli('run', timerRun, timerDirectory, timerOptions);
  await started(timerRun);
  await slowResult.entered;
  const slowRelease = setTimeout(() => slowResult.release(), 4800);
  const timerStarted = Date.now(), firstLease = journal(timerDirectory).data.lease.grant;
  await until(() => {
    const renewals = timerProxy.requests.filter(item => item.kind === 'renew' && item.response);
    return Date.now() - timerStarted > 6200 && new Set(renewals.map(item => item.requestId)).size >= 3;
  }, 'real 2-second renewal over six seconds', 11000);
  clearTimeout(slowRelease); slowResult.release();
  const renewed = journal(timerDirectory).data.lease.grant;
  assert.equal(renewed.generation, firstLease.generation); assert.ok(renewed.expiresAt > firstLease.expiresAt);
  const renewalReceipts = timerProxy.requests.filter(item => item.kind === 'renew' && item.response);
  assert.ok(renewalReceipts[0].at - timerStarted < 2700, 'Renewal waited for the delayed main backend result');
  for (const receipt of renewalReceipts) {
    const ledger = await f.db.prepare('SELECT response_json,status FROM execution_worker_actions WHERE request_id=?').bind(receipt.requestId).first();
    assert.equal(ledger.status, 'completed'); assert.deepEqual(JSON.parse(ledger.response_json), receipt.response);
  }
  const countBeforeLock = timerProxy.requests.length;
  await failed(cli('run', timerRun, timerDirectory, timerOptions));
  // Existing process may renew during this interval; the losing process never
  // initializes, claims or creates a second lease.
  assert.equal(timerProxy.requests.filter(item => item.kind === 'initialize').length, 1);
  assert.ok(timerProxy.requests.length >= countBeforeLock);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_worker_leases WHERE run_id=?').bind(timerRun.id).first()).n, 1);
  peer.setResult(timerRun.id, { phase: 'cancel_pending', purposes: [], cancelPurposes: ['cancel_fence', 'stop'] });
  assert.equal(timerProcess.child.kill('SIGTERM'), true);
  const signalResult = await timerProcess.exited;
  if (signalResult.code !== 0) {
    const state = journal(timerDirectory).data, row = await permitRow(timerRun);
    throw new Error(`Native stop diagnostics ${JSON.stringify({ result: JSON.parse(signalResult.stdout).reason, stopping: state.stopping, done: state.done, reconcileRequested: state.reconcileRequested, leaseMode: state.lease.mode, leaseRemaining: state.lease.grant.expiresAt - Date.now(), actions: Object.fromEntries(Object.entries(state.actions).map(([kind, action]) => [kind, action.completed])), permitClosed: row.closed_at !== null, requests: timerProxy.requests.map(item => ({ kind: item.kind, code: item.code, status: item.status, hasResponse: Boolean(item.response) })), backend: peer.requests.filter(item => item.permit?.runId === timerRun.id).map(item => item.path) })}`);
  }
  await finished(timerProcess, 'closed');
  assert.equal(journal(timerDirectory).data.stopping, true);
  assert.equal((await f.db.prepare('SELECT state FROM execution_runs WHERE id=?').bind(timerRun.id).first()).state, 'cancelled');
  assert.ok((await permitRow(timerRun)).closed_at !== null);
  assert.equal(timerProxy.errors.length, 0); await timerProxy.close();

  const interruptRun = await prepared(), interruptDirectory = join(f.dir, 'consumer-sigint');
  await bootstrap(interruptRun, interruptDirectory);
  const interruptProcess = cli('run', interruptRun, interruptDirectory);
  await started(interruptRun);
  peer.setResult(interruptRun.id, { phase: 'cancel_pending', purposes: [], cancelPurposes: ['cancel_fence', 'stop'] });
  assert.equal(interruptProcess.child.kill('SIGINT'), true);
  await finished(interruptProcess, 'closed');
  assert.equal(journal(interruptDirectory).data.stopping, true);
  assert.equal((await f.db.prepare('SELECT state FROM execution_runs WHERE id=?').bind(interruptRun.id).first()).state, 'cancelled');
  assert.ok((await permitRow(interruptRun)).closed_at !== null);

  const fenceRun = await prepared(), fenceDirectory = join(f.dir, 'consumer-fence-only');
  const fenceProxy = await faultProxy(fenceDirectory), fenceOptions = { endpoint: fenceProxy.endpoint };
  await bootstrap(fenceRun, fenceDirectory, fenceOptions);
  const fenceProcess = cli('run', fenceRun, fenceDirectory, fenceOptions);
  await started(fenceRun); const signalledAt = Date.now();
  assert.equal(fenceProcess.child.kill('SIGTERM'), true);
  const unclosed = await finished(fenceProcess, 'recovery_required', 2);
  assert.equal(unclosed.output.reason, 'STOP_NOT_CONFIRMED'); assert.ok(Date.now() - signalledAt < 10000);
  const fencedPermit = await permitRow(fenceRun);
  assert.equal(fencedPermit.cancel_requested, 1); assert.equal(fencedPermit.closed_at, null);
  assert.equal(journal(fenceDirectory).data.stopping, true); assert.equal(journal(fenceDirectory).data.done, false);
  assert.ok(Object.values(journal(fenceDirectory).data.actions).some(action => !action.completed));
  assert.ok(fenceProxy.requests.every(item => item.at <= signalledAt + 6500), 'Cleanup sent another request beyond its global deadline');
  peer.setResult(fenceRun.id, { phase: 'stopped', purposes: ['stop'], cancelPurposes: ['cancel_fence', 'stop'] });
  await finished(cli('run', fenceRun, fenceDirectory, { ...fenceOptions, extra: ['--mode', 'reconcile'] }), 'closed');
  assert.ok((await permitRow(fenceRun)).closed_at !== null);
  assert.equal((await permitRow(fenceRun)).deadline_ms, fencedPermit.deadline_ms);
  assert.equal(fenceProxy.errors.length, 0); await fenceProxy.close();

  // Several individually valid 2.4-second responses share one six-second stop
  // budget. A cancellation request may never reach the server in that budget;
  // the CLI must retain intent and report recovery rather than invent a fence.
  const slowRun = await prepared(), slowDirectory = join(f.dir, 'consumer-slow-action-cleanup');
  const slowProxy = await faultProxy(slowDirectory), slowOptions = { endpoint: slowProxy.endpoint };
  await bootstrap(slowRun, slowDirectory, slowOptions);
  const slowProcess = cli('run', slowRun, slowDirectory, slowOptions);
  await started(slowRun); const slowPermit = await permitRow(slowRun);
  slowProxy.delayMs = 2400;
  const slowSignal = Date.now(); assert.equal(slowProcess.child.kill('SIGTERM'), true);
  await until(() => journal(slowDirectory).data.stopping, 'signal persisted during active action', 2000);
  const slowOutcome = await finished(slowProcess, 'recovery_required', 2);
  assert.equal(slowOutcome.output.reason, 'STOP_NOT_CONFIRMED'); assert.ok(Date.now() - slowSignal < 8000);
  assert.ok(slowProxy.requests.every(item => item.at <= slowSignal + 6500));
  assert.equal(journal(slowDirectory).data.done, false); assert.equal((await permitRow(slowRun)).closed_at, null);
  assert.ok(Object.values(journal(slowDirectory).data.actions).some(action => !action.completed));
  peer.setResult(slowRun.id, { phase: 'stopped', purposes: ['result', 'stop'], cancelPurposes: ['cancel_fence', 'stop'] });
  const slowRecovered = await api(`/api/execution/dispatch?runId=${slowRun.id}`);
  assert.equal(slowRecovered.status, 200); assert.ok((await permitRow(slowRun)).closed_at !== null);
  assert.equal((await permitRow(slowRun)).deadline_ms, slowPermit.deadline_ms);
  assert.equal(slowProxy.errors.length, 0); await slowProxy.close();

  // A synthetic persisted journal timestamp exercises the actual CLI's fixed
  // 60-second boundary without claiming sixty seconds of wall-clock waiting.
  const pollRun = await prepared(), pollDirectory = join(f.dir, 'consumer-persisted-poll-bound');
  await bootstrap(pollRun, pollDirectory);
  const pollProcess = cli('run', pollRun, pollDirectory);
  await started(pollRun); await killed(pollProcess);
  const pollJournal = journal(pollDirectory);
  pollJournal.data.startedAt = Date.now() - 60001;
  writeFileSync(join(pollDirectory, 'journal.json'), JSON.stringify(pollJournal), { mode: 0o600 });
  const startsBeforePoll = peer.requests.filter(item => item.path === '/start' && item.permit.runId === pollRun.id).length;
  peer.setResult(pollRun.id, { phase: 'cancel_pending', purposes: [], cancelPurposes: ['cancel_fence', 'stop'] });
  await finished(cli('run', pollRun, pollDirectory), 'closed');
  assert.equal(peer.requests.filter(item => item.path === '/start' && item.permit.runId === pollRun.id).length, startsBeforePoll);
  assert.equal(journal(pollDirectory).data.startedAt, pollJournal.data.startedAt); assert.equal(journal(pollDirectory).data.stopping, true);

  for (const invalidation of ['worker-revoke', 'issuer-revoke', 'natural-expiry']) {
    const invalidRun = await prepared(), invalidDirectory = join(f.dir, `consumer-${invalidation}`);
    let issuer = null, issuerFile = tokenFile;
    if (invalidation !== 'worker-revoke') {
      issuer = await issueToken(f.db, f.alice.userId, { kind: 'api', ttlSeconds: 60, ...(invalidation === 'natural-expiry' ? { now: Date.now() - 54000 } : {}) });
      issuerFile = join(f.dir, `synthetic-${invalidation}.token`); writeFileSync(issuerFile, issuer.token + '\n', { mode: 0o600 });
    }
    await bootstrap(invalidRun, invalidDirectory, { token: issuerFile });
    const invalidProcess = cli('run', invalidRun, invalidDirectory);
    await started(invalidRun);
    const beforeInvalidation = await permitRow(invalidRun), privateState = privacy(invalidDirectory, issuer?.token ?? f.aliceToken).data;
    if (invalidation === 'worker-revoke') assert.equal((await api('/api/execution/workers', { action: 'revoke', credentialId: privateState.worker.credentialId, requestId: randomUUID() })).status, 200);
    else if (invalidation === 'issuer-revoke') await revokeToken(f.db, issuer.token);
    const invalidResult = await finished(invalidProcess, 'recovery_required', 2);
    assert.equal(invalidResult.output.reason, 'WORKER_AUTHORIZATION_LOST');
    assert.equal(journal(invalidDirectory).data.done, false); assert.equal((await nativeWorkerRead(invalidDirectory)).status, 401);
    if (issuer) { assert.ok(!invalidResult.stdout.includes(issuer.token) && !invalidResult.stderr.includes(issuer.token)); }
    if (invalidation === 'natural-expiry') {
      assert.ok(Date.now() >= issuer.expiresAt);
      assert.equal(privateState.worker.issued.expiresAt, issuer.expiresAt);
    }
    assert.equal((await permitRow(invalidRun)).closed_at, null);
    peer.setResult(invalidRun.id, { phase: 'stopped', purposes: ['result', 'stop'] });
    const restored = await api(`/api/execution/dispatch?runId=${invalidRun.id}`);
    assert.equal(restored.status, 200); assert.equal(restored.json.run.state, 'succeeded');
    const restoredPermit = await permitRow(invalidRun);
    assert.equal(restoredPermit.id, beforeInvalidation.id); assert.equal(restoredPermit.deadline_ms, beforeInvalidation.deadline_ms); assert.ok(restoredPermit.closed_at !== null);
  }

  const unusedRun = await prepared(), unusedDirectory = join(f.dir, 'consumer-invalid-arguments');
  await failed(cli('bootstrap', unusedRun, unusedDirectory, { extra: ['--owner', f.alice.userId] }));
  await failed(cli('bootstrap', unusedRun, unusedDirectory, { extra: ['--project', 'Synthetic'] }));
  const publicToken = join(f.dir, 'synthetic-public.token'); writeFileSync(publicToken, f.aliceToken, { mode: 0o644 }); chmodSync(publicToken, 0o644);
  await failed(cli('bootstrap', unusedRun, unusedDirectory, { token: publicToken }));
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_worker_credentials WHERE run_id=?').bind(unusedRun.id).first()).n, 0);
  await failed(cli('run', unusedRun, timerDirectory));

  const handshakeRun = await prepared(), handshakeDirectory = join(f.dir, 'consumer-slow-handshake');
  const handshakeProxy = await faultProxy(handshakeDirectory), handshakeOptions = { endpoint: handshakeProxy.endpoint };
  await bootstrap(handshakeRun, handshakeDirectory, handshakeOptions);
  handshakeProxy.delayMs = 2400;
  const handshakeProcess = cli('run', handshakeRun, handshakeDirectory, handshakeOptions);
  await until(() => handshakeProxy.requests.find(item => item.kind === 'initialize'), 'slow native handshake');
  const handshakeSignal = Date.now(); assert.equal(handshakeProcess.child.kill('SIGTERM'), true);
  await until(() => journal(handshakeDirectory).data.stopping, 'signal persisted while handshake still pending', 2000);
  const handshakeResult = await finished(handshakeProcess, 'recovery_required', 2);
  assert.equal(handshakeResult.output.reason, 'STOP_NOT_CONFIRMED'); assert.ok(Date.now() - handshakeSignal < 8000);
  assert.ok(handshakeProxy.requests.every(item => item.at <= handshakeSignal + 6500));
  assert.ok(!handshakeProxy.requests.some(item => item.kind === 'claim' || item.kind === 'start'));
  assert.equal(await permitRow(handshakeRun), null);
  assert.equal(journal(handshakeDirectory).data.done, false);
  assert.equal(handshakeProxy.errors.length, 0); await handshakeProxy.close();
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_worker_checks').first()).n, 0);
  assert.equal(peer.errors.length, 0);
  console.log(`Consumer native: ${processCount} independent CLI processes, ${disconnectCount} real TCP reply disconnects, persisted request replay and trusted result+stop closure PASS`);
} finally {
  const terminated = [...children].map(child => { const done = once(child, 'exit'); child.kill('SIGKILL'); return done; });
  await Promise.allSettled(terminated);
  for (const proxy of proxies) await proxy.close();
  try { await f?.close(); } finally { await peer.close(); }
}
