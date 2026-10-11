await requireDocker();
import { requireDocker } from './prerequisites.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { localFixture, fixtureEnvironment } from '../local/fixture.mjs';
import { freePort } from '../harness.mjs';
import { REGISTERED_OPERATIONS } from '../../lib/execution/registry.mts';
import { signedFetch } from '../../lib/execution/transport.mts';
import { verifyAttestation } from '../../lib/execution/attestations.mts';
import { startSupervisor } from '../../runner/server.mjs';
import { inspectExec, inspectContainer } from '../../runner/docker.mjs';
import { cleanupFixture } from './fixtures/cleanup.mjs';

// Actual consumer CLI + owned native Next/SQLite + signed supervisor + real Docker.
// The prerequisite above fails before any fixture, credential or resource exists.
const temporary = await mkdtemp(join(tmpdir(), 'ath-consumer-docker-'));
const supervisorRoot = join(temporary, 'supervisor');
const children = new Set(), contexts = [];
let f, supervisor, cleanupPromise;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const project = 'Synthetic consumer Docker';
async function ephemeralP256(keyId) {
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    signing: { keyId, privateKey: key.privateKey }, trust: { keyId, key: key.publicKey },
    private: JSON.stringify({ keyId, jwk: await webcrypto.subtle.exportKey('jwk', key.privateKey) }),
    public: JSON.stringify({ keyId, jwk: await webcrypto.subtle.exportKey('jwk', key.publicKey) }),
  };
}
async function boundedWait(check, label, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw Error('Owned consumer Docker fixture timed out: ' + label);
}
async function api(path, body, token = f.aliceToken) {
  const response = await fetch(f.origin + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { origin: f.origin, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length <= 1024 * 1024, 'Native fixture reply must stay bounded');
  return { status: response.status, bytes, headers: response.headers };
}
async function jsonApi(path, body, expected = 200) {
  const response = await api(path, body);
  assert.equal(response.status, expected, 'Unexpected native API status: ' + path);
  return JSON.parse(response.bytes.toString('utf8'));
}
async function prepare(operationId, title) {
  const ticket = await jsonApi('/api/records', { kind: 'ticket', title, status: 'todo', project, scope: 'Frozen 中文🌈"\\\n input' }, 201);
  const catalog = await jsonApi('/api/authorization?ticketId=' + encodeURIComponent(ticket.id) + '&expectedRevision=1');
  const selected = catalog.operations.find(operation => operation.operationId === operationId);
  assert.ok(selected, 'Fixture operation must be available in native catalog');
  const prepared = await jsonApi('/api/authorization', {
    action: 'prepare', ticketId: ticket.id, expectedRevision: 1, requestId: randomUUID(), attempt: 1,
    scope: [{ operationId: selected.operationId, definitionHash: selected.definitionHash }],
    budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 600000,
  }, 201);
  await jsonApi('/api/authorization', { action: 'decide', authorizationId: prepared.authorization.id, decisionId: randomUUID(), outcome: 'approved' });
  assert.equal(await permitRow(prepared.run.id), null, 'Preparation must not dispatch a backend');
  return prepared.run;
}
async function permitRow(runId) {
  return f.db.prepare('SELECT id,envelope,deadline_ms,cancel_requested,closed_at FROM execution_permits WHERE run_id=?').bind(runId).first();
}
async function journal(directory) { return JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8')); }
function cli(command, run, directory, extra = [], timeoutMs = 45000) {
  const args = ['--experimental-strip-types', 'runner/consumer.mjs', command, '--endpoint', f.origin + '/api/execution/worker-mcp', '--run-id', run.id, '--state-dir', directory];
  if (command !== 'run') args.push('--token-file', join(temporary, 'owner.token'));
  args.push(...extra);
  const child = spawn(process.execPath, args, { env: fixtureEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '', forced = false, killTimer;
  for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]]) {
    stream.on('data', chunk => { append(chunk.toString()); if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65536) child.kill('SIGKILL'); });
  }
  const timer = setTimeout(() => {
    forced = true; child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 8000);
  }, timeoutMs);
  const closed = once(child, 'close').then(([code, signal]) => {
    clearTimeout(timer); clearTimeout(killTimer); children.delete(child);
    return { code, signal, stdout, stderr, forced };
  });
  return { child, closed };
}
async function finished(process, status, { recovery = false } = {}) {
  const value = await process.closed;
  assert.equal(value.forced, false, 'Consumer CLI exceeded the fixture deadline');
  assert.equal(value.signal, null, 'Consumer CLI must handle its signal and exit normally');
  assert.ok(!value.stdout.includes(f.aliceToken) && !value.stderr.includes(f.aliceToken), 'CLI must not disclose the owner credential');
  const lines = value.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'CLI stdout must contain one JSON result');
  const output = JSON.parse(lines[0]);
  if (recovery && value.code === 2) {
    assert.equal(output.status, 'recovery_required');
    assert.equal(output.reason, 'STOP_NOT_CONFIRMED');
    assert.equal(output.closedAt, null, 'Unconfirmed physical stop must not be reported closed');
  } else {
    assert.equal(value.code, 0, 'Consumer CLI operation must complete');
    assert.equal(output.status, status);
  }
  return { ...value, output };
}
async function bootstrap(run, name) {
  const directory = join(temporary, name);
  await finished(cli('bootstrap', run, directory), 'bootstrapped');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'journal.json'))).mode & 0o777, 0o600);
  const saved = await journal(directory);
  assert.ok(!JSON.stringify(saved).includes(f.aliceToken), 'Issuer token must not be persisted in consumer journal');
  assert.equal(saved.data.worker.issued.runId, run.id);
  assert.equal(saved.data.worker.issued.project, project);
  contexts.push({ run, directory, credentialId: saved.data.worker.credentialId });
  return directory;
}
async function revoke(run, directory) {
  const before = await journal(directory);
  await finished(cli('revoke', run, directory), 'revoked');
  const after = await journal(directory);
  assert.equal(after.data.worker.revoked, true);
  const worker = before.data.worker;
  const denied = await api('/api/execution/worker-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_execution_run', arguments: { runId: run.id } } }, 'athw1.' + worker.credentialId + '.' + worker.secret);
  assert.equal(denied.status, 401, 'Native worker credential must be revoked');
}
async function verifiedClosure(run, before, trust, purposes, expectedState) {
  const current = await permitRow(run.id), permit = JSON.parse(current.envelope);
  assert.equal(current.id, before.id);
  assert.equal(current.envelope, before.envelope);
  assert.equal(current.deadline_ms, before.deadline_ms, 'Consumer renew/reconcile must not move the permit deadline');
  assert.equal(permit.deadlineMs, current.deadline_ms);
  assert.ok(Number.isSafeInteger(current.closed_at), 'Trusted physical stop must close the native permit');
  const domain = (await jsonApi('/api/execution?id=' + encodeURIComponent(run.id))).run;
  assert.equal(domain.state, expectedState);
  const rows = (await f.db.prepare('SELECT purpose,receipt FROM backend_attestations WHERE permit_id=? ORDER BY purpose').bind(current.id).all()).results;
  for (const purpose of purposes) assert.ok(rows.some(row => row.purpose === purpose), 'Native storage must retain signed ' + purpose);
  const receipts = rows.map(row => JSON.parse(row.receipt));
  for (const receipt of receipts) {
    assert.equal(await verifyAttestation(receipt, permit, trust), true, 'Receipt must verify against ephemeral evidence key and immutable native permit');
    assert.equal(receipt.claims.deadlineMs, before.deadline_ms);
    assert.equal(receipt.claims.runId, run.id);
  }
  const stop = receipts.find(receipt => receipt.claims.purpose === 'stop');
  assert.equal(stop.claims.closure, 'removed', 'A never-admitted stop cannot stand in for actual Docker closure');
  const result = receipts.find(receipt => receipt.claims.purpose === 'result');
  assert.ok(result?.claims.process?.containerId && result.claims.process.execId, 'Actual Docker process IDs must be retained');
  assert.ok(Number.isSafeInteger(result.claims.startedAt), 'Actual exec start must be observed');
  assert.equal(await inspectContainer(result.claims.process.containerId), null, 'Owned Docker container must physically be absent after stop');
  return { current, permit, domain, receipts, result };
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const failures = [];
    for (const child of [...children]) {
      child.kill('SIGTERM');
      try {
        const exit = once(child, 'close'); let timer;
        try {
          await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]);
          if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
        } finally { clearTimeout(timer); }
      } catch (error) { failures.push(error); }
    }
    try { await supervisor?.close(); } catch (error) { failures.push(error); }
    try { await cleanupFixture(supervisorRoot); } catch (error) { failures.push(error); }
    if (failures.length) {
      await f?.stop(); f?.db.close();
      console.error('Owned cleanup obligations retained at: ' + supervisorRoot + (f ? ' and ' + f.dir : ''));
      throw new AggregateError(failures, 'Consumer Docker fixture cleanup incomplete; retained roots require guarded recovery');
    }
    await f?.close();
    await rm(temporary, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
const onInt = () => { cleanup().then(() => process.exit(130), () => process.exit(1)); };
const onTerm = () => { cleanup().then(() => process.exit(143), () => process.exit(1)); };
process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
try {
  const control = await ephemeralP256('consumer-control'), node = await ephemeralP256('consumer-supervisor'), evidence = await ephemeralP256('consumer-evidence');
  const runnerPort = await freePort(), runnerUrl = 'http://127.0.0.1:' + runnerPort;
  const registry = [...REGISTERED_OPERATIONS, {
    ...REGISTERED_OPERATIONS[0], operationId: 'slow.run', label: 'Synthetic fixed consumer cancellation',
    argv: ['node', '-e', 'process.stdout.write("actual consumer SIGTERM output");setTimeout(()=>{},60000)'], inputs: [], artifacts: [],
  }];
  assert.equal(registry[0].operationId, 'ticket.validate.v1');
  assert.ok(registry.every(operation => operation.image === REGISTERED_OPERATIONS[0].image));
  f = await localFixture({ manageSignals: false, env: {
    EXECUTION_REGISTRY: JSON.stringify(registry), EXECUTION_RUNNER_URL: runnerUrl,
    EXECUTION_RUNNER_AUDIENCE: 'runner', EXECUTION_CHECKPOINT_AUDIENCE: 'control',
    EXECUTION_CONTROL_KEY: control.private, EXECUTION_RUNNER_KEY: node.public, EXECUTION_EVIDENCE_KEY: evidence.public,
  } });
  await writeFile(join(temporary, 'owner.token'), f.aliceToken + '\n', { mode: 0o600, flag: 'wx' });
  supervisor = await startSupervisor({
    registry, root: supervisorRoot, port: runnerPort, audience: 'runner', controlTrust: control.trust,
    transportKey: node.signing, evidenceKey: evidence.signing,
    checkpoint: { baseUrl: f.origin, audience: 'control', direction: 'runner-to-control', signing: node.signing, trust: control.trust },
  });
  assert.equal((await jsonApi('/api/execution/dispatch')).backend, 'local-docker');
  const direct = { baseUrl: runnerUrl, audience: 'runner', direction: 'control-to-runner', signing: control.signing, trust: node.trust };

  const title = 'Actual consumer frozen 中文🌈"\\';
  const normal = await prepare('ticket.validate.v1', title), normalDirectory = await bootstrap(normal, 'consumer-normal');
  const normalProcess = cli('run', normal, normalDirectory);
  const initialNormalPermit = await boundedWait(() => permitRow(normal.id), 'normal native permit');
  const normalOutput = await finished(normalProcess, 'closed');
  const closed = await verifiedClosure(normal, initialNormalPermit, evidence.trust, ['result', 'stop'], 'succeeded');
  assert.equal(normalOutput.output.permitId, closed.current.id);
  assert.equal(normalOutput.output.closedAt, closed.current.closed_at);
  assert.equal(closed.result.claims.exitCode, 0);
  assert.equal(closed.result.claims.status, 'succeeded');
  assert.equal(closed.permit.operation.operationId, 'ticket.validate.v1');
  assert.equal(closed.permit.operation.image, REGISTERED_OPERATIONS[0].image);
  const actual = await api('/api/execution/dispatch', { action: 'content', runId: normal.id, kind: 'artifact', path: 'output/result.json' });
  assert.equal(actual.status, 200);
  const artifact = closed.result.claims.artifacts.find(item => item.path === 'output/result.json');
  assert.ok(artifact);
  assert.equal(actual.bytes.length, artifact.bytes);
  assert.equal(hash(actual.bytes), artifact.sha256);
  assert.equal(actual.headers.get('x-content-sha256'), artifact.sha256);
  assert.deepEqual(JSON.parse(actual.bytes.toString('utf8')), { ok: true, ticketSha256: closed.permit.contractSha256, title });
  const supervisorResult = await signedFetch(direct, '/result', { permit: closed.permit });
  assert.equal(supervisorResult.status, 200);
  assert.equal(supervisorResult.data.phase, 'closed');
  assert.ok(supervisorResult.data.receipts.some(receipt => receipt.claims.purpose === 'result') && supervisorResult.data.receipts.some(receipt => receipt.claims.purpose === 'stop'));
  await revoke(normal, normalDirectory);
  console.log('Consumer real Docker: CLI bootstrap/run/revoke, pinned ticket.validate.v1, actual signed result+removed stop, verified artifact bytes/hash and stable permit deadline PASS');

  const slow = await prepare('slow.run', 'Actual consumer SIGTERM'), slowDirectory = await bootstrap(slow, 'consumer-sigterm');
  const slowProcess = cli('run', slow, slowDirectory);
  const initialSlowPermit = await boundedWait(() => permitRow(slow.id), 'slow native permit');
  await boundedWait(async () => {
    const response = await signedFetch(direct, '/result', { permit: JSON.parse(initialSlowPermit.envelope) });
    if (response.status !== 200 || response.data.phase !== 'running') return false;
    const job = JSON.parse(await readFile(join(supervisorRoot, 'journal', response.data.backendId + '.json'), 'utf8'));
    const execution = await inspectExec(job.process.execId);
    return execution.Running === true && Number.isInteger(execution.Pid) && execution.Pid > 0;
  }, 'actual running owned Docker exec');
  const reconcileUntil = Date.now() + 40000;
  assert.equal(slowProcess.child.kill('SIGTERM'), true);
  let stopped = await finished(slowProcess, 'closed', { recovery: true });
  while (stopped.code === 2 && Date.now() < reconcileUntil) {
    const retained = await journal(slowDirectory);
    assert.equal(retained.data.stopping, true, 'SIGTERM recovery must retain stop obligation');
    assert.ok(retained.data.actions.cancel, 'SIGTERM recovery must retain its cancellation request');
    stopped = await finished(cli('run', slow, slowDirectory, ['--mode', 'reconcile'], Math.max(1, reconcileUntil - Date.now())), 'closed', { recovery: true });
  }
  assert.equal(stopped.code, 0, 'Worker journal reconciliation must confirm physical closure within 40 seconds');
  const cancelled = await verifiedClosure(slow, initialSlowPermit, evidence.trust, ['cancel_fence', 'result', 'stop'], 'cancelled');
  assert.equal(cancelled.current.cancel_requested, 1);
  assert.equal(cancelled.domain.evidence, null, 'Cancellation must not fabricate accepted success evidence');
  assert.equal(stopped.output.state, 'cancelled');
  assert.equal(stopped.output.closedAt, cancelled.current.closed_at);
  const finalJournal = await journal(slowDirectory);
  assert.equal(finalJournal.data.done, true);
  assert.ok(finalJournal.data.actions.cancel.completed, 'The persisted Worker cancellation action must reconcile to completion');
  const interruptedOutput = await api('/api/execution/dispatch', { action: 'content', runId: slow.id, kind: 'stdout' });
  assert.equal(interruptedOutput.status, 200);
  assert.equal(interruptedOutput.bytes.toString('utf8'), 'actual consumer SIGTERM output');
  assert.equal(interruptedOutput.bytes.length, cancelled.result.claims.stdout.bytes);
  assert.equal(hash(interruptedOutput.bytes), cancelled.result.claims.stdout.sha256);
  await revoke(slow, slowDirectory);
  for (const context of contexts) {
    const saved = await journal(context.directory);
    for (const secret of [saved.data.worker.secret, saved.data.lease.secret]) {
      assert.ok(!normalOutput.stdout.includes(secret) && !stopped.stdout.includes(secret), 'CLI summary must not reveal retained Worker/lease secrets');
    }
  }
  console.log('Consumer real Docker: actual running CLI SIGTERM, same-journal Worker reconcile, signed cancel_fence+result+removed stop, domain cancelled, actual stdout and stable deadline PASS');
} finally {
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  await cleanup();
}
