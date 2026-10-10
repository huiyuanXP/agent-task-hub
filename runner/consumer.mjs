import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openConsumerState, readLocalApiToken } from './consumer-state.mjs';
import { createConsumerTransport } from './consumer-transport.mjs';

export const RENEW_INTERVAL_MS = 2000;
export const MAX_POLL_MS = 60000;
const CLEANUP_MS = 6000;
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const initialData = () => ({ worker: null, lease: null, actions: {}, startedAt: null, stopping: false, done: false, reconcileRequested: false, last: null, revoke: null });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeError = reason => Object.assign(Error('Consumer operation could not complete'), { reason });

export function parseConsumerArguments(argv) {
  const [command, ...args] = argv;
  if (!['bootstrap', 'run', 'revoke'].includes(command)) throw safeError('INVALID_ARGUMENTS');
  const values = {};
  const allowed = ['endpoint', 'run-id', 'state-dir', 'token-file', 'token-fd', 'label', 'mode', 'message'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2), value = args[i + 1];
    if (!args[i]?.startsWith('--') || !allowed.includes(key) || Object.hasOwn(values, key) || typeof value !== 'string' || value.startsWith('--')) throw safeError('INVALID_ARGUMENTS');
    values[key] = value;
  }
  const { endpoint, 'run-id': runId, 'state-dir': root } = values;
  if (!endpoint || typeof runId !== 'string' || !runId || runId.length > 200 || typeof root !== 'string' || !root.startsWith('/')) throw safeError('INVALID_ARGUMENTS');
  if (command === 'run' && ['token-file', 'token-fd', 'label'].some(key => Object.hasOwn(values, key))) throw safeError('INVALID_ARGUMENTS');
  if (command !== 'run' && ['mode', 'message'].some(key => Object.hasOwn(values, key))) throw safeError('INVALID_ARGUMENTS');
  if (command !== 'bootstrap' && Object.hasOwn(values, 'label')) throw safeError('INVALID_ARGUMENTS');
  if (command !== 'run' && Boolean(values['token-file']) === Boolean(values['token-fd'])) throw safeError('INVALID_ARGUMENTS');
  if (values['token-file'] && !values['token-file'].startsWith('/')) throw safeError('INVALID_ARGUMENTS');
  if (values['token-fd'] && (!/^[0-9]+$/.test(values['token-fd']) || !Number.isSafeInteger(Number(values['token-fd'])) || Number(values['token-fd']) < 3)) throw safeError('INVALID_ARGUMENTS');
  const label = values.label ?? 'Local Run consumer', mode = values.mode ?? 'execute';
  if (!label.trim() || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label) || !['execute', 'reconcile'].includes(mode) || (values.message !== undefined && values.message.length > 2048)) throw safeError('INVALID_ARGUMENTS');
  return { command, endpoint, runId, root, mode, label, message: values.message,
    ...(values['token-file'] ? { tokenFile: values['token-file'] } : {}), ...(values['token-fd'] ? { tokenFd: Number(values['token-fd']) } : {}) };
}

function validateData(data) {
  const keys = Object.keys(initialData());
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(data, key)) || !data.actions || typeof data.actions !== 'object' || Array.isArray(data.actions) || !['stopping', 'done', 'reconcileRequested'].every(key => typeof data[key] === 'boolean') || (data.startedAt !== null && (!Number.isSafeInteger(data.startedAt) || data.startedAt <= 0))) throw safeError('INVALID_JOURNAL');
  if (data.worker !== null && (!data.worker || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.worker.credentialId) || !/^[A-Za-z0-9_-]{43}$/.test(data.worker.secret) || hash(data.worker.secret) !== data.worker.verifier || typeof data.worker.requestId !== 'string' || typeof data.worker.label !== 'string')) throw safeError('INVALID_JOURNAL');
  if (data.lease !== null && (!data.lease || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.lease.leaseId) || !/^[A-Za-z0-9_-]{43}$/.test(data.lease.secret) || !['execute', 'reconcile'].includes(data.lease.mode) || typeof data.lease.requestId !== 'string')) throw safeError('INVALID_JOURNAL');
}
function workerToken(data) {
  if (!data.worker?.issued || data.worker.revoked) throw safeError('WORKER_NOT_BOOTSTRAPPED');
  return `athw1.${data.worker.credentialId}.${data.worker.secret}`;
}
function leaseToken(lease) { return `athl1.${lease.leaseId}.${lease.grant.generation}.${lease.secret}`; }
function currentLease(data) { return data.lease?.grant && data.lease.grant.expiresAt > Date.now() ? data.lease : null; }
function validateGrant(grant, lease, runId) {
  if (!grant || grant.leaseId !== lease.leaseId || grant.runId !== runId || grant.mode !== lease.mode || !Number.isSafeInteger(grant.generation) || grant.generation < 1 || !Number.isSafeInteger(grant.createdAt) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < grant.createdAt) throw safeError('INVALID_RESPONSE');
}
function output(command, runId, status, run, reason) {
  return { command, runId, status, ...(run ? { state: run.state, permitId: run.permit?.permitId ?? null, closedAt: run.permit?.closedAt ?? null } : {}), ...(reason ? { reason } : {}) };
}
const transient = error => ['NETWORK', 'TIMEOUT', 'ABORTED', 'network', 'timeout', 'aborted', 'cancelled'].includes(error?.kind) || error?.status === 503;
const authorizationDenied = error => [401, 403].includes(error?.status) || error?.domainCode === 'AUTHORIZATION_DENIED';

export async function runConsumer(options, { onReady } = {}) {
  const transport = createConsumerTransport({ endpoint: options.endpoint });
  const journal = await openConsumerState({ root: options.root, endpoint: transport.endpoint, runId: options.runId, initialData: initialData() });
  let stopRequested = false, cleanupDeadline = null, cleanupTimer = null, stopPersistence = null, renewTimer = null, renewInFlight = null, renewalFailure = null;
  const activeRequests = new Set();
  function beginCleanup() {
    if (cleanupDeadline !== null) return;
    cleanupDeadline = Date.now() + CLEANUP_MS;
    cleanupTimer = setTimeout(() => { for (const controller of activeRequests) controller.abort(); }, CLEANUP_MS);
  }
  const requestStop = () => {
    stopRequested = true; beginCleanup();
    stopPersistence = journal.update(data => { data.stopping = true; }).catch(error => { renewalFailure = error; });
  };
  async function operation(fn) {
    if (cleanupDeadline !== null && Date.now() >= cleanupDeadline) throw safeError('CLEANUP_EXPIRED');
    const controller = new AbortController(); activeRequests.add(controller);
    try {
      return await fn(controller.signal);
    } catch (error) {
      if (cleanupDeadline !== null && Date.now() >= cleanupDeadline) throw safeError('CLEANUP_EXPIRED');
      throw error;
    } finally { activeRequests.delete(controller); }
  }
  const rpc = (token, name, args) => operation(signal => transport.callTool(token, name, args, { signal }));
  try {
    validateData(journal.snapshot().data);
    if (options.command === 'bootstrap') {
      const ownerToken = await readLocalApiToken(options.tokenFile ? { tokenFile: options.tokenFile } : { tokenFd: options.tokenFd });
      await journal.update(data => {
        if (data.worker) {
          if (data.worker.label !== options.label || data.worker.revoked) throw safeError('JOURNAL_CONFLICT');
          return;
        }
        const value = secret(); data.worker = { credentialId: randomUUID(), secret: value, verifier: hash(value), requestId: randomUUID(), label: options.label, issued: null };
      });
      const worker = journal.snapshot().data.worker;
      const issued = await transport.provisionWorker(ownerToken, { credentialId: worker.credentialId, requestId: worker.requestId, runId: options.runId, verifier: worker.verifier, label: worker.label });
      if (issued.credentialId !== worker.credentialId || issued.runId !== options.runId || !Number.isSafeInteger(issued.expiresAt) || issued.revokedAt !== null) throw safeError('INVALID_RESPONSE');
      await journal.update(data => { data.worker.issued = issued; });
      return { exitCode: 0, result: output('bootstrap', options.runId, 'bootstrapped') };
    }
    if (options.command === 'revoke') {
      const ownerToken = await readLocalApiToken(options.tokenFile ? { tokenFile: options.tokenFile } : { tokenFd: options.tokenFd });
      await journal.update(data => { if (!data.worker) throw safeError('WORKER_NOT_BOOTSTRAPPED'); data.revoke ??= { requestId: randomUUID() }; });
      const data = journal.snapshot().data;
      const revoked = await transport.revokeWorker(ownerToken, { credentialId: data.worker.credentialId, requestId: data.revoke.requestId });
      if (revoked.credentialId !== data.worker.credentialId || revoked.runId !== options.runId || !Number.isSafeInteger(revoked.revokedAt)) throw safeError('INVALID_RESPONSE');
      await journal.update(data => { data.worker.revoked = true; });
      return { exitCode: 0, result: output('revoke', options.runId, 'revoked') };
    }
    process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop);
    const token = workerToken(journal.snapshot().data);
    try { await operation(signal => transport.initialize(token, { signal })); }
    catch (error) {
      if (error.reason === 'CLEANUP_EXPIRED') return { exitCode: 2, result: output('run', options.runId, 'recovery_required', null, 'STOP_NOT_CONFIRMED') };
      if (authorizationDenied(error)) return { exitCode: 2, result: output('run', options.runId, 'recovery_required', null, 'WORKER_AUTHORIZATION_LOST') };
      throw error;
    }
    await journal.update(data => { data.startedAt ??= Date.now(); if (options.mode === 'reconcile') data.reconcileRequested = true; });
    await onReady?.();
    async function readRun() {
      const value = await rpc(token, 'get_execution_run', { runId: options.runId });
      if (!value?.run || value.run.id !== options.runId) throw safeError('INVALID_RESPONSE');
      return value.run;
    }
    async function acquire(mode) {
      let data = journal.snapshot().data, lease = data.lease;
      if (currentLease(data)) return lease;
      if (!lease || lease.mode !== mode || (lease.grant && lease.grant.expiresAt <= Date.now())) {
        await journal.update(state => { state.lease = { leaseId: randomUUID(), secret: secret(), requestId: randomUUID(), mode, grant: null }; });
        lease = journal.snapshot().data.lease;
      }
      const grant = await rpc(token, 'claim_execution_run', { runId: options.runId, requestId: lease.requestId, leaseId: lease.leaseId, verifier: hash(lease.secret), mode: lease.mode });
      validateGrant(grant, lease, options.runId);
      await journal.update(state => { state.lease.grant = grant; });
      return grant.expiresAt > Date.now() ? journal.snapshot().data.lease : null;
    }
    async function action(kind, { repeat = false, message } = {}) {
      const lease = currentLease(journal.snapshot().data);
      if (!lease) throw safeError('LEASE_EXPIRED');
      await journal.update(data => {
        const old = data.actions[kind];
        if (!old || old.leaseId !== lease.leaseId || old.generation !== lease.grant.generation || (repeat && old.completed)) data.actions[kind] = { requestId: randomUUID(), leaseId: lease.leaseId, generation: lease.grant.generation, completed: false, ...(message === undefined ? {} : { message }) };
      });
      const saved = journal.snapshot().data.actions[kind];
      if (saved.completed) return saved.response;
      const value = await rpc(token, `${kind}_execution_run`, { runId: options.runId, requestId: saved.requestId, leaseToken: leaseToken(lease), ...(saved.message === undefined ? {} : { message: saved.message }) });
      if (kind === 'renew') validateGrant(value, lease, options.runId);
      await journal.update(data => {
        if (data.lease?.leaseId !== lease.leaseId || data.lease?.grant?.generation !== lease.grant.generation || data.actions[kind]?.requestId !== saved.requestId) throw safeError('LEASE_REPLACED');
        data.actions[kind].completed = true; data.actions[kind].response = value;
        if (kind === 'renew') data.lease.grant = value;
        else data.last = value;
      });
      return value;
    }
    renewTimer = setInterval(() => {
      let data;
      try { data = journal.snapshot().data; } catch (error) { renewalFailure = error; return; }
      const lease = currentLease(data);
      if (stopRequested || renewInFlight || !lease || lease.mode !== 'execute' || data.reconcileRequested || data.stopping) return;
      renewInFlight = action('renew', { repeat: true }).catch(async error => {
        if (authorizationDenied(error)) await journal.update(state => { state.reconcileRequested = true; });
        else if (!transient(error) && !['LEASE_EXPIRED', 'LEASE_REPLACED', 'CLEANUP_EXPIRED'].includes(error.reason)) renewalFailure = error;
      }).catch(error => { renewalFailure = error; }).finally(() => { renewInFlight = null; });
    }, RENEW_INTERVAL_MS);
    let run = null;
    for (;;) {
      journal.assertAvailable();
      if (renewalFailure) throw renewalFailure;
      if (stopRequested || journal.snapshot().data.stopping || Date.now() - journal.snapshot().data.startedAt >= MAX_POLL_MS) {
        beginCleanup();
        await journal.update(data => { data.stopping = true; });
      }
      if (cleanupDeadline !== null && Date.now() >= cleanupDeadline) return { exitCode: 2, result: output('run', options.runId, 'recovery_required', run, 'STOP_NOT_CONFIRMED') };
      try {
        run = await readRun();
        if (stopRequested || Date.now() - journal.snapshot().data.startedAt >= MAX_POLL_MS) {
          beginCleanup();
          await journal.update(data => { data.stopping = true; });
        }
        if (run.permit?.closedAt !== null && run.permit?.closedAt !== undefined) {
          const data = journal.snapshot().data, lease = currentLease(data);
          if (data.stopping && ['queued', 'running', 'waiting'].includes(run.state)) {
            if (!lease) await acquire('reconcile');
            await action('cancel');
            run = await readRun();
          }
          for (const kind of ['complete', 'cancel']) {
            const saved = data.actions[kind];
            if (lease && saved && !saved.completed && saved.leaseId === lease.leaseId && saved.generation === lease.grant.generation) {
              try { await action(kind); }
              catch (error) {
                // Physical closure is already independently confirmed. A stop
                // without a result must not fabricate a completion receipt.
                if (error.domainCode !== 'INVALID_EVIDENCE' && !transient(error) && error.reason !== 'CLEANUP_EXPIRED') throw error;
              }
            }
          }
          await journal.update(data => { data.done = true; });
          return { exitCode: 0, result: output('run', options.runId, 'closed', run) };
        }
        const terminal = ['succeeded', 'failed', 'cancelled'].includes(run.state);
        let data = journal.snapshot().data;
        if (terminal || run.permit?.cancelRequested) await journal.update(state => { state.reconcileRequested = true; });
        data = journal.snapshot().data;
        const wantedMode = data.reconcileRequested ? 'reconcile' : 'execute';
        if (wantedMode === 'reconcile' && !run.permit) return { exitCode: 2, result: output('run', options.runId, 'recovery_required', run, 'HISTORICAL_PERMIT_REQUIRED') };
        let lease = currentLease(data);
        if (lease && lease.mode !== wantedMode) { await pause(Math.min(RENEW_INTERVAL_MS, lease.grant.expiresAt - Date.now() + 5)); continue; }
        lease = await acquire(wantedMode);
        if (!lease) continue;
        if (journal.snapshot().data.stopping) {
          await action('cancel');
        } else if (lease.mode === 'execute') {
          const pendingStart = journal.snapshot().data.actions.start;
          if (!run.permit || (pendingStart && !pendingStart.completed && pendingStart.leaseId === lease.leaseId && pendingStart.generation === lease.grant.generation)) await action('start');
          const pendingReport = journal.snapshot().data.actions.report;
          if (options.message !== undefined || (pendingReport && !pendingReport.completed && pendingReport.leaseId === lease.leaseId && pendingReport.generation === lease.grant.generation)) await action('report', { message: options.message });
        }
        try { await action('complete', { repeat: true }); }
        catch (error) { if (error.domainCode !== 'INVALID_EVIDENCE') throw error; }
        run = await readRun();
        if (run.permit?.closedAt !== null && run.permit?.closedAt !== undefined) continue;
      } catch (error) {
        if (error.reason === 'CLEANUP_EXPIRED') return { exitCode: 2, result: output('run', options.runId, 'recovery_required', run, 'STOP_NOT_CONFIRMED') };
        if (authorizationDenied(error)) {
          try { run = await readRun(); }
          catch (probe) {
            if (probe.reason === 'CLEANUP_EXPIRED') return { exitCode: 2, result: output('run', options.runId, 'recovery_required', run, 'STOP_NOT_CONFIRMED') };
            if (authorizationDenied(probe)) return { exitCode: 2, result: output('run', options.runId, 'recovery_required', run, 'WORKER_AUTHORIZATION_LOST') };
            throw probe;
          }
          if (!run.permit) return { exitCode: 2, result: output('run', options.runId, 'recovery_required', run, 'EXECUTE_AUTHORIZATION_LOST') };
          await journal.update(data => { data.reconcileRequested = true; });
        } else if (!['LEASE_EXPIRED', 'LEASE_REPLACED'].includes(error.reason) && !transient(error) && error.domainCode !== 'INVALID_EVIDENCE') throw error;
      }
      await pause(Math.min(RENEW_INTERVAL_MS, cleanupDeadline === null ? RENEW_INTERVAL_MS : Math.max(1, cleanupDeadline - Date.now())));
    }
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    await renewInFlight;
    await stopPersistence;
    if (cleanupTimer) clearTimeout(cleanupTimer);
    process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop);
    await journal.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const value = await runConsumer(parseConsumerArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(value.result) + '\n'); process.exitCode = value.exitCode;
  } catch (error) {
    const known = ['INVALID_ARGUMENTS', 'INVALID_JOURNAL', 'JOURNAL_CONFLICT', 'WORKER_NOT_BOOTSTRAPPED', 'INVALID_RESPONSE'];
    process.stderr.write(JSON.stringify({ error: 'Consumer operation failed', reason: known.includes(error?.reason) ? error.reason : 'OPERATION_UNAVAILABLE' }) + '\n');
    process.exitCode = 1;
  }
}
