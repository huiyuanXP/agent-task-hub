// Owned synthetic protocol peer. It verifies real P256 transport and signs real
// bound receipts, but does not execute containers or claim Docker evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, KeyObject, sign } from 'node:crypto';
import { canonical, signReply, verifyRequest } from '../../../lib/execution/transport.mts';

const digest = value => createHash('sha256').update(value).digest('hex');
async function keyPair(keyId) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    signing: { keyId, privateKey: keys.privateKey }, trust: { keyId, key: keys.publicKey },
    private: JSON.stringify({ keyId, jwk: await crypto.subtle.exportKey('jwk', keys.privateKey) }),
    public: JSON.stringify({ keyId, jwk: await crypto.subtle.exportKey('jwk', keys.publicKey) }),
  };
}

export async function workerBackendFixture(options = {}) {
  const [control, runner, evidence] = await Promise.all(['synthetic-control', 'synthetic-runner', 'synthetic-evidence'].map(keyPair));
  const requests = [], errors = [], permits = new Map(), results = new Map(), receipts = new Map(), holds = new Set(), nonces = new Set();
  let closed = false;
  async function receipt(permit, purpose = 'result', overrides = {}) {
    const startedAt = permit.issuedAt + 1, endedAt = startedAt + 1;
    const claims = {
      version: 2, purpose, audience: 'control-plane', keyId: evidence.signing.keyId,
      owner: permit.owner, runId: permit.runId, ticketId: permit.ticketId, ticketRevision: permit.ticketRevision,
      attempt: permit.attempt, authorizationId: permit.authorizationId, contractSha256: permit.contractSha256,
      permitId: permit.permitId, permitSha256: digest(canonical(permit)), operationId: permit.operation.operationId,
      definitionHash: permit.operation.definitionHash, deadlineMs: permit.deadlineMs,
      backendId: 'ath-' + digest(JSON.stringify([permit.owner, permit.runId, permit.attempt])).slice(0, 40),
      status: purpose === 'result' ? 'succeeded' : purpose === 'cancel_fence' ? 'cancelled' : 'stopped',
      process: { containerId: digest('synthetic-container-' + permit.permitId), execId: digest('synthetic-exec-' + permit.permitId) },
      exitCode: purpose === 'result' ? 0 : null, startedAt, endedAt, capturedAt: endedAt,
      observedAt: Math.max(Date.now(), endedAt),
      artifacts: purpose === 'result' ? permit.operation.artifacts.map(item => ({ path: item.path, bytes: Math.min(2, item.maxBytes), sha256: digest('{}') })) : [],
      stdout: { sha256: digest(''), bytes: 0, truncated: false }, stderr: { sha256: digest(''), bytes: 0, truncated: false },
      closure: purpose === 'stop' ? 'removed' : null, ...overrides,
    };
    // Sign independently through node:crypto's interoperable IEEE-P1363 format.
    return { claims, signature: sign('sha256', Buffer.from(canonical(claims)), { key: KeyObject.from(evidence.signing.privateKey), dsaEncoding: 'ieee-p1363' }).toString('hex') };
  }
  async function retainedReceipt(permit, purpose, overrides = {}) {
    const key = canonical([permit.permitId, purpose, overrides]);
    if (!receipts.has(key)) receipts.set(key, await receipt(permit, purpose, overrides));
    return receipts.get(key);
  }
  function holdNext(path, runId) {
    let entered, release;
    const hold = { path, runId, entered: new Promise(resolve => { entered = resolve; }), gate: new Promise(resolve => { release = resolve; }) };
    hold.enter = entered;
    hold.release = () => { release(); holds.delete(hold); };
    holds.add(hold);
    return { entered: hold.entered, release: hold.release };
  }
  async function responseFor(path, permit) {
    if (path === '/health') return { status: 200, data: { status: 'synthetic-ready' } };
    assert.ok(permit && typeof permit.permitId === 'string', 'Protocol request requires a bound permit');
    const previous = permits.get(permit.runId);
    if (previous) assert.equal(canonical(previous), canonical(permit), 'Retries must retain exact permit and deadline');
    else permits.set(permit.runId, structuredClone(permit));
    if (path === '/start') return { status: 202, data: { phase: 'accepted', receipts: [] } };
    const state = results.get(permit.runId) ?? {};
    if (path === '/result' && state.status === 404) return { status: 404, data: { error: 'Synthetic result not yet admitted' } };
    let purposes = state.purposes ?? [];
    if (path === '/cancel' && !state.cancelPurposes) purposes = ['cancel_fence'];
    else if (path === '/cancel') purposes = state.cancelPurposes;
    const signedReceipts = state.receipts ?? await Promise.all(purposes.map(purpose => retainedReceipt(permit, purpose, state.overrides?.[purpose])));
    return { status: state.status ?? 200, data: { phase: state.phase ?? (path === '/cancel' ? 'cancel_pending' : 'running'), receipts: signedReceipts } };
  }
  const server = createServer(async (req, res) => {
    try {
      let body = '', bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024, 'Fixture request bound'); body += chunk; }
      const signed = JSON.parse(req.headers['x-execution-signature'] ?? 'null');
      assert.equal(await verifyRequest(signed, control.trust, { direction: 'control-to-runner', audience: 'synthetic-runner', method: 'POST', path: req.url, body }), true, 'Untrusted fixture request');
      assert.ok(!nonces.has(signed.claims.nonce), 'Transport nonce replay'); nonces.add(signed.claims.nonce);
      const input = JSON.parse(body);
      const record = { path: req.url, ...input };
      requests.push(record);
      const hold = [...holds].find(item => item.path === req.url && (!item.runId || item.runId === input.permit?.runId));
      if (hold) { hold.enter(record); await hold.gate; }
      const reply = options.handler ? await options.handler(req.url, input, { receipt, requests, permits, results }) : await responseFor(req.url, input.permit);
      const text = canonical(reply.data);
      res.writeHead(reply.status, { 'content-type': 'application/json', 'x-execution-signature': JSON.stringify(await signReply(runner.signing, signed, reply.status, text)) });
      res.end(text);
    } catch (error) {
      errors.push(error);
      if (!res.destroyed) { res.writeHead(500); res.end('Synthetic protocol fixture failed'); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...(options.registry ? { EXECUTION_REGISTRY: JSON.stringify(options.registry) } : {}),
    EXECUTION_RUNNER_URL: origin, EXECUTION_RUNNER_AUDIENCE: 'synthetic-runner', EXECUTION_CHECKPOINT_AUDIENCE: 'synthetic-control',
    EXECUTION_CONTROL_KEY: control.private, EXECUTION_RUNNER_KEY: runner.public, EXECUTION_EVIDENCE_KEY: evidence.public,
  };
  async function close() {
    if (closed) return; closed = true;
    for (const hold of [...holds]) hold.release();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return { origin, env, requests, errors, permits, receipt, holdNext, setResult(runId, state) { results.set(runId, structuredClone(state)); }, close };
}
