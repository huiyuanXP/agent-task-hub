import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createConsumerTransport, ConsumerTransportError, WORKER_TOOL_NAMES,
  MAX_CONSUMER_REQUEST_BYTES, MAX_CONSUMER_RESPONSE_BYTES, CONSUMER_TIMEOUT_MS,
} from '../../runner/consumer-transport.mjs';

const id = '12345678-1234-4234-8234-123456789abc';
const ownerToken = 'o'.repeat(43), workerToken = 'athw1.' + id + '.' + 'w'.repeat(43);
const leaseToken = 'athl1.' + id + '.1.' + 'l'.repeat(43);
const provision = { credentialId: id, requestId: 'provision:test-1', runId: 'run:界🌈"\\', verifier: 'a'.repeat(64), label: 'Synthetic transport Worker' };
const revoke = { credentialId: id, requestId: 'revoke:test-1' };
const tools = () => WORKER_TOOL_NAMES.map(name => ({ name, inputSchema: { type: 'object', additionalProperties: false } }));
const initialization = () => ({ protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agent-task-hub-worker', version: '1' } });
const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
function normal(req, res, body) {
  if (req.url === '/api/execution/workers') {
    res.statusCode = body.action === 'provision' ? 201 : 200;
    res.end(JSON.stringify({ worker: { credentialId: body.credentialId, runId: body.runId ?? provision.runId, revokedAt: body.action === 'revoke' ? 123 : null } }));
    return;
  }
  if (body.method === 'notifications/initialized') { res.statusCode = 204; res.end(); return; }
  const result = body.method === 'initialize' ? initialization() : body.method === 'tools/list' ? { tools: tools() } : toolResult({ run: { id: body.params?.arguments?.runId ?? 'synthetic-run', text: '中文🌈"\\\n' } });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
}
async function peer(t, handler = normal) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString());
    requests.push({ path: req.url, body, bytes: raw.length, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    await handler(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, endpoint: origin + '/api/execution/worker-mcp', requests };
}
function errorKind(kind, values = {}) {
  return error => {
    assert.ok(error instanceof ConsumerTransportError);
    assert.equal(error.kind, kind);
    for (const [key, value] of Object.entries(values)) assert.equal(error[key], value);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    for (const secret of [workerToken, ownerToken, leaseToken, 'remote-secret-value']) {
      assert.ok(!String(error).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.ok(!error.stack.includes(secret));
    }
    return true;
  };
}

test('canonical native endpoint, 2500ms timeout and byte limits match the frozen contract', () => {
  assert.equal(CONSUMER_TIMEOUT_MS, 2500);
  assert.equal(MAX_CONSUMER_REQUEST_BYTES, 16384);
  assert.equal(MAX_CONSUMER_RESPONSE_BYTES, 1048576);
  for (const endpoint of ['http://127.0.0.1:9999/api/execution/worker-mcp', 'http://192.0.2.1/api/execution/worker-mcp', 'https://example.invalid/api/execution/worker-mcp']) {
    const transport = createConsumerTransport({ endpoint });
    assert.equal(transport.endpoint, endpoint);
    assert.equal(transport.origin, new URL(endpoint).origin);
    assert.ok(Object.isFrozen(transport));
  }
  for (const endpoint of [undefined, '/api/execution/worker-mcp', 'ftp://example.invalid/api/execution/worker-mcp',
    'https://secret@example.invalid/api/execution/worker-mcp', 'http://127.0.0.1/api/connector/mcp',
    'http://127.0.0.1/api/execution/workers', 'http://127.0.0.1/api/execution/worker-mcp/',
    'http://127.0.0.1/api/execution/worker-mcp?target=https://foreign.invalid', 'http://127.0.0.1/api/execution/worker-mcp#secret',
    'http://127.0.0.1/api/execution/../execution/worker-mcp']) {
    assert.throws(() => createConsumerTransport({ endpoint }), errorKind('configuration'));
  }
  for (const timeoutMs of [0, -1, 2501, 2.5, '2500']) assert.throws(() => createConsumerTransport({ endpoint: 'http://127.0.0.1/api/execution/worker-mcp', timeoutMs }), errorKind('configuration'));
});

test('real HTTP negotiates initialization, exact eight tools and notification with strict Host/Origin', async t => {
  const fixture = await peer(t);
  const transport = createConsumerTransport(fixture);
  const result = await transport.initialize(workerToken);
  assert.equal(result.serverInfo.name, 'agent-task-hub-worker');
  assert.deepEqual(result.tools.map(tool => tool.name), WORKER_TOOL_NAMES);
  assert.deepEqual(fixture.requests.map(request => request.body.method), ['initialize', 'tools/list', 'notifications/initialized']);
  for (const request of fixture.requests) {
    assert.equal(request.path, '/api/execution/worker-mcp');
    assert.equal(request.headers.host, new URL(fixture.origin).host);
    assert.equal(request.headers.origin, fixture.origin);
    assert.equal(request.headers.authorization, 'Bearer ' + workerToken);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.ok(request.bytes <= MAX_CONSUMER_REQUEST_BYTES);
  }
});

test('real HTTP calls all eight native tools and preserves Unicode, emoji and escaped text', async t => {
  const fixture = await peer(t);
  const transport = createConsumerTransport(fixture);
  const common = { runId: provision.runId, requestId: 'action:test-1', leaseToken };
  for (const name of WORKER_TOOL_NAMES) {
    const args = name === 'get_execution_run' ? { runId: provision.runId } : name === 'list_execution_runs' ? {} : name === 'claim_execution_run'
      ? { runId: provision.runId, requestId: 'claim:test-1', leaseId: id, verifier: 'a'.repeat(64), mode: 'reconcile' }
      : { ...common, ...(name === 'report_execution_run' ? { message: '中文🌈"\\\n'.repeat(200) } : {}) };
    const value = await transport.callTool(workerToken, name, args);
    assert.equal(value.run.text, '中文🌈"\\\n');
  }
  assert.deepEqual(fixture.requests.map(item => item.body.params.name), WORKER_TOOL_NAMES);
});

test('real HTTP owner provisioning/revocation are confined to workers and return metadata', async t => {
  const fixture = await peer(t);
  const transport = createConsumerTransport(fixture);
  assert.equal((await transport.provisionWorker(ownerToken, provision)).credentialId, id);
  assert.equal((await transport.revokeWorker(ownerToken, revoke)).revokedAt, 123);
  assert.deepEqual(fixture.requests.map(item => item.body), [{ action: 'provision', ...provision }, { action: 'revoke', ...revoke }]);
  assert.ok(fixture.requests.every(item => item.path === '/api/execution/workers' && item.headers.authorization === 'Bearer ' + ownerToken));
});

test('wrong credential kinds, malformed tokens, hidden tools and extra authority fields never reach HTTP', async t => {
  const fixture = await peer(t);
  const transport = createConsumerTransport(fixture);
  await assert.rejects(transport.initialize(ownerToken), errorKind('credential'));
  await assert.rejects(transport.callTool(ownerToken, 'list_execution_runs'), errorKind('credential'));
  await assert.rejects(transport.provisionWorker(workerToken, provision), errorKind('credential'));
  await assert.rejects(transport.revokeWorker(workerToken, revoke), errorKind('credential'));
  for (const malformed of [workerToken + '\n', workerToken.replace('.12345678-', '.12345679-').replace('-4234-', '-5234-'), 'Bearer ' + workerToken, null]) {
    await assert.rejects(transport.initialize(malformed), errorKind('credential'));
  }
  await assert.rejects(transport.callTool(workerToken, 'prepare_execution', {}), errorKind('input'));
  await assert.rejects(transport.callTool(workerToken, 'get_execution_run', { runId: 'run', owner: ownerToken }), errorKind('input'));
  await assert.rejects(transport.callTool(workerToken, 'list_execution_runs', { project: 'foreign' }), errorKind('input'));
  await assert.rejects(transport.callTool(workerToken, 'claim_execution_run', { runId: 'run', requestId: 'request', leaseId: id, verifier: 'a'.repeat(64), mode: 'auto' }), errorKind('input'));
  await assert.rejects(transport.callTool(workerToken, 'report_execution_run', { runId: 'run', requestId: 'request', leaseToken, message: 'x'.repeat(2049) }), errorKind('input'));
  for (const input of [{ ...provision, owner: ownerToken }, { ...provision, projectId: 'foreign' }, { ...provision, action: 'provision' }, { ...provision, label: undefined }, { ...provision, verifier: workerToken }]) {
    await assert.rejects(transport.provisionWorker(ownerToken, input), errorKind('input'));
  }
  await assert.rejects(transport.revokeWorker(ownerToken, { ...revoke, runId: 'foreign' }), errorKind('input'));
  assert.equal(fixture.requests.length, 0);
});

test('caller options cannot override Host, Origin, path or credential headers', async t => {
  const fixture = await peer(t);
  const transport = createConsumerTransport(fixture);
  await transport.callTool(workerToken, 'list_execution_runs', {}, { headers: { host: 'foreign.invalid', origin: 'https://foreign.invalid', authorization: 'Bearer ' + ownerToken }, endpoint: 'https://foreign.invalid' });
  assert.equal(fixture.requests[0].headers.host, new URL(fixture.origin).host);
  assert.equal(fixture.requests[0].headers.origin, fixture.origin);
  assert.equal(fixture.requests[0].headers.authorization, 'Bearer ' + workerToken);
});

test('safe HTTP/domain errors retain status and known code but never remote messages or secrets', async t => {
  const fixture = await peer(t, (_req, res) => { res.statusCode = 409; res.end(JSON.stringify({ error: ownerToken + workerToken + 'remote-secret-value', code: 'REQUEST_CONFLICT' })); });
  await assert.rejects(createConsumerTransport(fixture).provisionWorker(ownerToken, provision), errorKind('http', { status: 409, domainCode: 'REQUEST_CONFLICT' }));
});

test('safe RPC errors preserve native AUTHORIZATION_DENIED/INVALID_EVIDENCE/REQUEST_CONFLICT; unknown codes are dropped', async t => {
  let domainCode = 'AUTHORIZATION_DENIED';
  const fixture = await peer(t, (_req, res, body) => res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: workerToken + ownerToken + leaseToken, data: { code: domainCode, status: 403 } } })));
  const transport = createConsumerTransport(fixture);
  for (domainCode of ['AUTHORIZATION_DENIED', 'INVALID_EVIDENCE', 'REQUEST_CONFLICT', 'remote-secret-value']) {
    await assert.rejects(transport.callTool(workerToken, 'list_execution_runs'), errorKind('rpc', { status: 403, rpcCode: -32000, domainCode: domainCode === 'remote-secret-value' ? undefined : domainCode }));
  }
});

test('real HTTP rejects redirects before any foreign peer receives a credential', async t => {
  const foreign = await peer(t);
  const fixture = await peer(t, (_req, res) => { res.statusCode = 307; res.setHeader('location', foreign.endpoint); res.end('{}'); });
  await assert.rejects(createConsumerTransport(fixture).callTool(workerToken, 'list_execution_runs'), errorKind('redirect'));
  assert.equal(foreign.requests.length, 0);
  assert.equal(fixture.requests.length, 1);
});

test('real HTTP exact 1 MiB UTF-8 response passes and one-byte overflow fails', async t => {
  let size = MAX_CONSUMER_RESPONSE_BYTES;
  const fixture = await peer(t, (_req, res, body) => {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: toolResult({ text: '中文🌈"\\\n'.repeat(10000) }) });
    res.end(raw + ' '.repeat(size - Buffer.byteLength(raw)));
  });
  const transport = createConsumerTransport(fixture);
  assert.equal((await transport.callTool(workerToken, 'list_execution_runs')).text, '中文🌈"\\\n'.repeat(10000));
  size++;
  await assert.rejects(transport.callTool(workerToken, 'list_execution_runs'), errorKind('response_limit'));
});

test('real unknown-length response stream is cancelled while peer is still writing', async t => {
  let closedEarly = false, writes = 0;
  const fixture = await peer(t, (_req, res) => {
    res.write('{"padding":"');
    const timer = setInterval(() => {
      writes++;
      if (writes === 64) { clearInterval(timer); res.end('"}'); }
      else res.write('x'.repeat(128 * 1024));
    }, 2);
    res.on('close', () => { closedEarly = writes < 64; clearInterval(timer); });
  });
  await assert.rejects(createConsumerTransport(fixture).callTool(workerToken, 'list_execution_runs'), errorKind('response_limit'));
  for (let i = 0; i < 30 && !closedEarly; i++) await delay(10);
  assert.equal(closedEarly, true);
  assert.ok(writes < 64);
});

test('real HTTP fatal UTF-8 rejects malformed and truncated bytes; split multibyte chunks survive', async t => {
  let mode = 'split';
  const fixture = await peer(t, async (_req, res, body) => {
    if (mode !== 'split') { res.end(Buffer.from(mode === 'truncated' ? '{"x":"\xc3' : '{"x":"\xc3("}', 'latin1')); return; }
    const raw = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: toolResult({ text: '中文🌈"\\\n' }) }));
    const at = raw.indexOf(Buffer.from('中')) + 1;
    res.write(raw.subarray(0, at)); await delay(10); res.end(raw.subarray(at));
  });
  const transport = createConsumerTransport(fixture);
  assert.equal((await transport.callTool(workerToken, 'list_execution_runs')).text, '中文🌈"\\\n');
  for (mode of ['malformed', 'truncated']) await assert.rejects(transport.callTool(workerToken, 'list_execution_runs'), errorKind('encoding'));
});

test('real HTTP distinguishes preflight cancellation, active cancellation and finite timeout', async t => {
  const fixture = await peer(t, (_req, res) => { res.write('{"pending":'); });
  const transport = createConsumerTransport({ ...fixture, timeoutMs: 50 });
  const before = new AbortController(); before.abort(workerToken);
  await assert.rejects(transport.callTool(workerToken, 'list_execution_runs', {}, { signal: before.signal }), errorKind('cancelled'));
  assert.equal(fixture.requests.length, 0);
  const during = new AbortController();
  const result = transport.callTool(workerToken, 'list_execution_runs', {}, { signal: during.signal });
  setTimeout(() => during.abort(ownerToken), 20);
  await assert.rejects(result, errorKind('cancelled'));
  await assert.rejects(transport.callTool(workerToken, 'list_execution_runs'), errorKind('timeout'));
});

test('real committed request with dropped connection returns network error and does not silently retry', async t => {
  const fixture = await peer(t, (_req, res) => { res.writeHead(201); res.flushHeaders(); res.socket.destroy(); });
  const transport = createConsumerTransport(fixture);
  await assert.rejects(transport.provisionWorker(ownerToken, provision), errorKind('network'));
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.requests[0].body, { action: 'provision', ...provision });
});

test('real HTTP and MCP reject malformed JSON, ID/version mismatch, dual result/error and inconsistent envelopes', async t => {
  let mode = 'json';
  const fixture = await peer(t, (_req, res, body) => {
    if (mode === 'json') { res.end('invalid ' + workerToken); return; }
    const value = { jsonrpc: '2.0', id: body.id, result: toolResult({ ok: true }) };
    if (mode === 'id') value.id++;
    if (mode === 'version') value.jsonrpc = '1.0';
    if (mode === 'both') value.error = { code: -32000, message: ownerToken };
    if (mode === 'dual') value.result.content[0].text = '{"ok":false}';
    if (mode === 'isError') value.result.isError = true;
    res.end(JSON.stringify(value));
  });
  const transport = createConsumerTransport(fixture);
  await assert.rejects(transport.callTool(workerToken, 'list_execution_runs'), errorKind('json'));
  for (mode of ['id', 'version', 'both', 'dual', 'isError']) await assert.rejects(transport.callTool(workerToken, 'list_execution_runs'), errorKind('protocol'));
});

test('initialization rejects wrong protocol/name and missing, extra or duplicate discovery tools', async t => {
  let mode = 'protocol';
  const fixture = await peer(t, (_req, res, body) => {
    if (body.method === 'initialize') {
      const result = initialization();
      if (mode === 'protocol') result.protocolVersion = '2025-11-25';
      if (mode === 'name') result.serverInfo.name = 'foreign-server';
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      return;
    }
    const advertised = tools();
    if (mode === 'missing') advertised.pop();
    if (mode === 'extra') advertised.push({ name: 'prepare_execution', inputSchema: { type: 'object' } });
    if (mode === 'duplicate') advertised[7] = advertised[0];
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: advertised } }));
  });
  const transport = createConsumerTransport(fixture);
  for (mode of ['protocol', 'name', 'missing', 'extra', 'duplicate']) await assert.rejects(transport.initialize(workerToken), errorKind('protocol'));
  assert.ok(fixture.requests.every(item => item.body.method !== 'notifications/initialized'));
});
