// Built native Next server, owned loopback HTTP and fresh synthetic SQLite only.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { localFixture } from '../local/fixture.mjs';
import { issueToken, revokeToken, resetPassword } from '../../lib/local-auth.mts';
import { createDispatchPermit, requestPermitCancellation } from '../../lib/execution/dispatch.mts';

const f = await localFixture();
const management = '/api/execution/workers', machine = '/api/execution/worker-mcp';
const hash = value => createHash('sha256').update(value).digest('hex');
const bearer = token => ({ authorization: `Bearer ${token}` });
const maxResponse = 1024 * 1024;
async function request(path, { token = f.aliceToken, body, method, headers = {} } = {}) {
  if (headers.host) return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, f.origin), { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { ...(token ? bearer(token) : {}), ...(body === undefined ? {} : { origin: f.origin, 'content-type': 'application/json' }), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null, text, cache: res.headers['cache-control'] }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const response = await fetch(f.origin + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(token ? bearer(token) : {}), ...(body === undefined ? {} : { origin: f.origin, 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= maxResponse, `Response exceeded 1 MiB at ${path}`);
  return { status: response.status, json: text ? JSON.parse(text) : null, text, cache: response.headers.get('cache-control') };
}
async function expect(status, path, options) {
  const result = await request(path, options);
  assert.equal(result.status, status, `Unexpected HTTP status at ${path}: ${result.status}`);
  return result;
}
const rpcBody = (method, params = {}, id = 'native-界🌈"\\') => ({ jsonrpc: '2.0', id, method, params });
const rpc = (token, method, params = {}, headers = {}) => request(machine, { token, body: rpcBody(method, params), headers });
const call = (token, name, args = {}) => rpc(token, 'tools/call', { name, arguments: args });
function deniedRPC(response, status = 403) {
  assert.equal(response.status, 200);
  assert.equal(response.json.error.data.status, status);
  assert.equal(response.json.error.data.code, status === 403 ? 'AUTHORIZATION_DENIED' : 'INVALID_INPUT');
}
async function createRun(ticketId, owner, contract, token, authorized = false) {
  const now = new Date().toISOString();
  await f.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind(ticketId, owner, 'ticket', JSON.stringify(contract), 1, now, now).run();
  if (authorized) {
    const catalog = (await expect(200, `/api/authorization?ticketId=${ticketId}&expectedRevision=1`, { token })).json;
    const prepared = (await expect(201, '/api/authorization', { token, body: { action: 'prepare', ticketId, expectedRevision: 1, requestId: `create-${ticketId}`, attempt: 1, scope: catalog.operations.map(({ operationId, definitionHash }) => ({ operationId, definitionHash })), budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 600000 } })).json;
    await expect(200, '/api/authorization', { token, body: { action: 'decide', authorizationId: prepared.authorization.id, decisionId: `approve-${ticketId}`, outcome: 'approved' } });
    return prepared.run;
  }
  return (await expect(201, '/api/execution', { token, body: { action: 'create', ticketId, expectedRevision: 1, requestId: `create-${ticketId}`, authorizationId: `authorization-${ticketId}`, attempt: 1 } })).json.run;
}
function provisionInput(runId, label = 'Synthetic native Worker') {
  const secret = randomBytes(32).toString('base64url');
  const body = { action: 'provision', credentialId: randomUUID(), requestId: randomUUID(), runId, verifier: hash(secret), label };
  return { body, secret, token: `athw1.${body.credentialId}.${secret}` };
}
async function provision(runId, issuerToken = f.aliceToken) {
  const result = provisionInput(runId);
  result.worker = (await expect(201, management, { token: issuerToken, body: result.body })).json.worker;
  return result;
}
function noPrivate(response, worker, issuerToken = f.aliceToken, owner = f.alice.userId) {
  for (const value of [worker.secret, worker.body.verifier, worker.body.requestId, hash(issuerToken), issuerToken, owner]) assert.ok(!response.text.includes(value), 'Private credential or principal escaped');
  for (const key of ['issuerTokenHash', 'issuer_token_hash', 'issuerExpiresAt', 'issuer_expires_at', 'verifier', 'secret', 'input_key', 'request_id', 'revoke_request_id', 'owner', 'actor', 'lastActor', 'evidence']) {
    assert.ok(!new RegExp(`"${key}"\\s*:`).test(response.text), `Private field escaped: ${key}`);
  }
  assert.match(response.cache, /no-store/);
}
async function chunkedOversize(token) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(machine, f.origin), { method: 'POST', headers: { ...bearer(token), origin: f.origin, 'content-type': 'application/json' } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), text }));
    });
    req.on('error', reject);
    // No Content-Length: the parser must enforce the cumulative stream size.
    req.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{"padding":"');
    req.write('界'.repeat(3000)); req.write('界'.repeat(3000)); req.end('"}}');
  });
}
async function disconnectAfterHeaders(expectedStatus, body) {
  return new Promise((resolve, reject) => {
    let disconnected = false;
    const req = httpRequest(new URL(management, f.origin), { method: 'POST', headers: { ...bearer(f.aliceToken), origin: f.origin, 'content-type': 'application/json' } }, res => {
      if (res.statusCode !== expectedStatus) {
        res.destroy(); req.destroy(); reject(new Error(`Unexpected disconnect response status: ${res.statusCode}`)); return;
      }
      // Receiving headers establishes the committed response. Disconnect the owned
      // loopback socket without consuming or parsing any response JSON bytes.
      disconnected = true;
      res.on('error', error => { if (error.code !== 'ECONNRESET' && error.code !== 'ERR_STREAM_DESTROYED') reject(error); });
      res.destroy(); req.destroy(); resolve();
    });
    req.on('error', error => {
      if (!disconnected || (error.code !== 'ECONNRESET' && error.code !== 'ERR_STREAM_DESTROYED')) reject(error);
    });
    req.end(JSON.stringify(body));
  });
}

try {
  const contract = { title: '冻结界🌈"\\\n', scope: '界🌈"\\\n'.repeat(7600), project: 'Synthetic-A', status: 'todo' };
  const assigned = await createRun('worker-assigned', f.alice.userId, contract, f.aliceToken, true);
  // Create the existing native domain permit; never dispatch or start a backend.
  const permit = await createDispatchPermit(f.db, { owner: f.alice.userId, actor: f.alice.userId, grantAuthority: 'owner' }, assigned.id);
  const otherProject = await createRun('worker-other-project', f.alice.userId, { title: 'Private other project', project: 'Synthetic-B' }, f.aliceToken);
  const foreign = await createRun('worker-bob', f.bob.userId, { title: 'Private Bob contract', project: 'Bob-Private' }, f.bobToken);
  const browser = await issueToken(f.db, f.alice.userId, { kind: 'browser' });
  const cookie = { cookie: `hub_session=${browser.token}` };
  await expect(200, management, { token: null, headers: cookie });
  await expect(403, management, { token: null, body: provisionInput(assigned.id).body, headers: { ...cookie, origin: '' } });
  for (const spoof of [{ owner: f.bob.userId }, { actor: f.bob.userId }, { project: 'Bob-Private' }, { issuerTokenHash: hash(f.bobToken) }, { expiresAt: Date.now() + 1e9 }]) {
    await expect(400, management, { body: { ...provisionInput(assigned.id).body, ...spoof } });
  }
  await expect(404, management, { token: f.bobToken, body: provisionInput(assigned.id).body });
  await expect(404, management, { body: provisionInput(foreign.id).body });
  await expect(403, management, { body: provisionInput(assigned.id).body, headers: { origin: 'https://foreign.invalid' } });
  await expect(403, management, { headers: { host: 'foreign.invalid' } });
  await expect(401, management, { headers: cookie });

  // Lose the owned loopback connection after headers, before reading reply JSON.
  const worker = provisionInput(assigned.id);
  await disconnectAfterHeaders(201, worker.body);
  const persisted = await f.db.prepare('SELECT created_at,expires_at FROM execution_worker_credentials WHERE credential_id=?').bind(worker.body.credentialId).first();
  const replay = await expect(201, management, { body: worker.body });
  worker.worker = replay.json.worker;
  assert.equal(worker.worker.credentialId, worker.body.credentialId);
  assert.equal(worker.worker.createdAt, persisted.created_at); assert.equal(worker.worker.expiresAt, persisted.expires_at);
  assert.ok(worker.worker.expiresAt <= worker.worker.createdAt + 900000);
  assert.equal(worker.worker.project, 'Synthetic-A');
  noPrivate(replay, worker);
  await expect(409, management, { body: { ...worker.body, label: 'changed retry' } });
  const secondIssuer = await issueToken(f.db, f.alice.userId, { kind: 'api' });
  await expect(409, management, { token: secondIssuer.token, body: worker.body });
  const listed = await expect(200, management);
  assert.deepEqual(listed.json.workers.map(item => item.credentialId), [worker.body.credentialId]); noPrivate(listed, worker);
  assert.deepEqual((await expect(200, management, { token: f.bobToken })).json.workers, []);

  const invitation = (await expect(201, '/api/connectors', { body: { action: 'invite', project: 'Synthetic-A', name: 'Synthetic connector', capabilities: ['read'] } })).json;
  const connection = (await expect(201, '/api/connector/enroll', { token: null, body: { code: invitation.code, name: 'Synthetic connector', version: 'synthetic-1', workspace: 'Synthetic Workspace' } })).json;
  for (const method of ['initialize', 'discover', 'tools/list', 'tools/call']) {
    const params = method === 'tools/call' ? { name: 'list_execution_runs', arguments: {} } : {};
    for (const token of [f.aliceToken, connection.token, null]) assert.equal((await rpc(token, method, params)).status, 401);
    assert.equal((await rpc(null, method, params, cookie)).status, 401);
    assert.equal((await rpc(worker.token, method, params, cookie)).status, 401);
  }
  for (const path of ['/api/session', '/api/records', '/api/execution', management]) await expect(401, path, { token: worker.token });
  await expect(401, '/mcp', { token: worker.token, body: rpcBody('tools/list') });
  await expect(401, '/api/connector/mcp', { token: worker.token, body: rpcBody('tools/list') });
  assert.equal((await rpc(worker.token, 'tools/list', {}, { cookie: 'unrelated=1' })).status, 401);
  assert.equal((await rpc(worker.token, 'tools/list', {}, { host: 'foreign.invalid' })).status, 403);
  assert.equal((await rpc(worker.token, 'tools/list', {}, { origin: 'https://foreign.invalid' })).status, 403);
  await expect(405, machine, { token: worker.token });
  await expect(401, machine, { token: f.aliceToken });
  const initialized = await rpc(worker.token, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Synthetic', version: '1' } });
  assert.equal(initialized.json.result.serverInfo.name, 'agent-task-hub-worker'); noPrivate(initialized, worker);
  for (const method of ['discover', 'tools/list']) {
    const response = await rpc(worker.token, method);
    assert.deepEqual(response.json.result.tools.map(tool => tool.name), ['get_execution_run', 'list_execution_runs']); noPrivate(response, worker);
  }
  for (const name of ['claim_execution_run', 'start_execution_run', 'renew_execution_run', 'report_execution_run', 'complete_execution_run', 'cancel_execution_run', 'renew_execution_lease', 'release_execution_lease', 'reconcile_execution_run', 'create_execution_run', 'prepare_execution', 'decide_authorization', 'delete_record']) deniedRPC(await call(worker.token, name, { runId: assigned.id }));
  const list = await call(worker.token, 'list_execution_runs');
  assert.deepEqual(list.json.result.structuredContent.runs.map(run => run.id), [assigned.id]); noPrivate(list, worker);
  assert.deepEqual(JSON.parse(list.json.result.content[0].text), list.json.result.structuredContent);
  const read = await call(worker.token, 'get_execution_run', { runId: assigned.id });
  assert.equal(read.json.id, 'native-界🌈"\\');
  assert.deepEqual(read.json.result.structuredContent.run.contract, contract);
  assert.deepEqual(read.json.result.structuredContent.run.permit, { permitId: permit.permitId, deadlineMs: permit.deadlineMs, cancelRequested: false, closedAt: null });
  assert.deepEqual(JSON.parse(read.json.result.content[0].text), read.json.result.structuredContent); noPrivate(read, worker);
  await requestPermitCancellation(f.db, f.alice.userId, assigned.id);
  const closedAt = Date.now();
  await f.db.prepare('UPDATE execution_permits SET closed_at=? WHERE id=?').bind(closedAt, permit.permitId).run();
  const closed = await call(worker.token, 'get_execution_run', { runId: assigned.id });
  assert.deepEqual(closed.json.result.structuredContent.run.permit, { permitId: permit.permitId, deadlineMs: permit.deadlineMs, cancelRequested: true, closedAt });
  noPrivate(closed, worker);
  for (const runId of [foreign.id, otherProject.id, 'missing-run']) {
    const rejected = await call(worker.token, 'get_execution_run', { runId }); deniedRPC(rejected);
    assert.ok(!rejected.text.includes('Private Bob') && !rejected.text.includes('Bob-Private') && !rejected.text.includes('Private other project'));
  }
  deniedRPC(await call(worker.token, 'list_execution_runs', { project: 'Synthetic-B' }), 400);
  const chunked = await chunkedOversize(worker.token);
  assert.ok(Buffer.byteLength(chunked.text) < maxResponse);
  assert.equal(chunked.json.error.data.status, 413); assert.equal(chunked.json.error.data.code, 'BODY_TOO_LARGE');
  console.log('Native Worker: principal separation, exact discovery, hidden-tool rejection, frozen Unicode dual envelope, privacy and chunked body bounds PASS');

  await f.stop(); await f.start();
  const afterRestart = await expect(201, management, { body: worker.body });
  assert.deepEqual(afterRestart.json.worker, worker.worker);
  assert.equal((await call(worker.token, 'list_execution_runs')).json.result.structuredContent.runs[0].id, assigned.id);
  const revoke = { action: 'revoke', credentialId: worker.body.credentialId, requestId: randomUUID() };
  await disconnectAfterHeaders(200, revoke);
  const persistedRevoke = await f.db.prepare('SELECT revoked_at FROM execution_worker_credentials WHERE credential_id=?').bind(worker.body.credentialId).first();
  const firstRevoke = await expect(200, management, { body: revoke });
  const secondRevoke = await expect(200, management, { body: revoke });
  assert.deepEqual(firstRevoke.json, secondRevoke.json);
  assert.equal(firstRevoke.json.worker.revokedAt, persistedRevoke.revoked_at);
  assert.equal((await call(worker.token, 'list_execution_runs')).status, 401);
  await expect(403, management, { body: worker.body });
  await expect(409, management, { body: { ...revoke, requestId: randomUUID() } });
  noPrivate(firstRevoke, worker);

  for (const lifecycle of ['logout', 'revoke', 'reset', 'expiry']) {
    const issuer = await issueToken(f.db, f.alice.userId, { kind: lifecycle === 'logout' ? 'browser' : 'api' });
    const descendant = provisionInput(assigned.id);
    const options = lifecycle === 'logout' ? { token: null, headers: { cookie: `hub_session=${issuer.token}` } } : { token: issuer.token };
    descendant.worker = (await expect(201, management, { ...options, body: descendant.body })).json.worker;
    assert.equal((await call(descendant.token, 'list_execution_runs')).status, 200);
    if (lifecycle === 'logout') await expect(200, '/api/auth/logout', { ...options, body: {} });
    else if (lifecycle === 'revoke') await revokeToken(f.db, issuer.token);
    else if (lifecycle === 'reset') await resetPassword(f.db, 'alice', 'another-synthetic-password');
    else await f.db.prepare('UPDATE local_tokens SET expires_at=? WHERE token_hash=?').bind(Date.now() - 1, hash(issuer.token)).run();
    assert.equal((await call(descendant.token, 'list_execution_runs')).status, 401, `Worker survived issuer ${lifecycle}`);
  }

  // Natural SQLite clock expiry uses an actual short-lived synthetic issuer.
  const naturalIssuer = await issueToken(f.db, f.alice.userId, { kind: 'api', ttlSeconds: 60, now: Date.now() - 57500 });
  const natural = await provision(assigned.id, naturalIssuer.token);
  assert.equal(natural.worker.expiresAt, naturalIssuer.expiresAt);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, naturalIssuer.expiresAt - Date.now()) + 30));
  assert.equal((await call(natural.token, 'list_execution_runs')).status, 401);
  await expect(401, management, { token: naturalIssuer.token });

  // Seed a historical synthetic Worker with a real still-current issuer; no credential expiry edits or trigger bypass.
  const currentIssuer = await issueToken(f.db, f.alice.userId, { kind: 'api' });
  const current = await provision(assigned.id, currentIssuer.token);
  const old = await f.db.prepare('SELECT * FROM execution_worker_credentials WHERE credential_id=?').bind(current.body.credentialId).first();
  const expired = { ...old, credential_id: randomUUID(), request_id: randomUUID(), created_at: Date.now() - 1000, expires_at: Date.now() + 2000 };
  const keys = Object.keys(expired);
  await f.db.prepare(`INSERT INTO execution_worker_credentials (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).bind(...keys.map(key => expired[key])).run();
  assert.equal((await call(`athw1.${expired.credential_id}.${current.secret}`, 'list_execution_runs')).status, 200);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, expired.expires_at - Date.now()) + 30));
  assert.equal((await call(`athw1.${expired.credential_id}.${current.secret}`, 'list_execution_runs')).status, 401);
  assert.equal((await call(current.token, 'list_execution_runs')).status, 200);
  await expect(200, management, { token: currentIssuer.token });
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM execution_worker_checks').first()).n, 0);
  console.log('Native Worker: loopback disconnect before provision/revoke JSON, issuer-bound replay, durable restart, logout/revoke/reset/natural issuer expiry and independent natural Worker expiry PASS');
} finally { await f.close(); }
