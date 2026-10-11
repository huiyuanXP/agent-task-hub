import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_RESPONSE_BYTES, request } from '../../connector/common.mjs';
import { MAX_STDIO_REQUEST_BYTES } from '../../connector/mcp.mjs';

const root = resolve(import.meta.dirname, '../..');
const token = 'synthetic-private-byte-test-token';
const initialize = { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-11-25' } };
const call = (id, text = '') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'synthetic_echo', arguments: { text } } });
function sizedJson(bytes, value) {
  const text = JSON.stringify(value);
  const missing = bytes - Buffer.byteLength(text);
  assert.ok(missing >= 0);
  // Put ASCII padding inside the result, so serialization preserves the exact size.
  return JSON.stringify({ ...value, result: { ...value.result, padding: 'a'.repeat(missing - 13) } });
}
function sizedCall(bytes, id, text = '中文🙂"\\\n') {
  const value = call(id, text);
  value.params.arguments.text += 'a'.repeat(bytes - Buffer.byteLength(JSON.stringify(value)));
  const raw = JSON.stringify(value);
  assert.equal(Buffer.byteLength(raw), bytes);
  return raw;
}
async function peer(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push({ path: req.url, body, authorization: req.headers.authorization, bytes: Buffer.byteLength(raw) });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/connector/heartbeat') res.end('{}');
    else await handler(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(accept => server.close(accept));
  });
  return { url: 'http://127.0.0.1:' + server.address().port, token, requests };
}
async function stdio(t, config, chunks) {
  const directory = await mkdtemp(join(tmpdir(), 'ath-byte-stdio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'connection.json');
  await writeFile(file, JSON.stringify({ ...config, workspace: directory, runtime: join(root, 'connector/cli.mjs'), installationId: 'synthetic-byte-install', connectionId: 'synthetic:byte' }), { mode: 0o600 });
  const child = spawn(process.execPath, [join(root, 'connector/cli.mjs'), 'mcp', '--config', file], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {});
  const closed = once(child, 'close');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.once('close', () => clearTimeout(timer));
  for (const chunk of chunks) {
    if (typeof chunk === 'function') await chunk(() => stdout);
    else if (typeof chunk === 'number') await delay(chunk);
    else if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
  }
  child.stdin.end();
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  const lines = stdout.trim().split('\n');
  assert.ok(lines.every(line => Buffer.byteLength(line) <= MAX_RESPONSE_BYTES));
  return { replies: lines.map(line => JSON.parse(line)), lines, stderr };
}
function input(lines, newline = '\n') { return Buffer.from(lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join(newline) + newline); }

test('HTTP byte limit accepts exact 4 MiB with Chinese, emoji and JSON escapes', async t => {
  const value = { jsonrpc: '2.0', id: 1, result: { text: '中文🙂"\\\n'.repeat(1000) } };
  const raw = sizedJson(MAX_RESPONSE_BYTES, value);
  assert.equal(Buffer.byteLength(raw), MAX_RESPONSE_BYTES);
  const config = await peer(t, (_req, res) => res.end(raw));
  const result = await request(config, '/exact', { text: '中文🙂' });
  assert.equal(result.result.text, value.result.text);
  assert.equal(config.requests[0].authorization, 'Bearer ' + token);
});

test('HTTP rejects one byte over 4 MiB, including multibyte bodies below the old character ceiling', async t => {
  const raw = sizedJson(MAX_RESPONSE_BYTES + 1, { result: { text: '中'.repeat(1200000) } });
  assert.equal(Buffer.byteLength(raw), MAX_RESPONSE_BYTES + 1);
  assert.ok(raw.length < 2 * 1024 * 1024);
  const config = await peer(t, (_req, res) => res.end(raw));
  await assert.rejects(request(config, '/overflow', {}), /Service response exceeds the limit/);
});

test('unknown-length chunked HTTP response cancels before the peer finishes', async t => {
  let closedEarly = false, writes = 0;
  const config = await peer(t, (_req, res) => {
    res.write('{"text":"');
    const timer = setInterval(() => {
      writes++;
      if (writes === 64) { clearInterval(timer); res.end('"}'); }
      else res.write('a'.repeat(256 * 1024));
    }, 2);
    res.on('close', () => { closedEarly = writes < 64; clearInterval(timer); });
  });
  await assert.rejects(request(config, '/chunked', {}), /Service response exceeds the limit/);
  for (let attempt = 0; attempt < 30 && !closedEarly; attempt++) await delay(10);
  assert.equal(closedEarly, true, 'the stream must be cancelled while the peer is still producing bytes');
  assert.ok(writes < 64);
});

test('stream cancellation happens on the first over-limit chunk without reading another chunk', async t => {
  let reads = 0, cancels = 0, releases = 0;
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true, status: 200,
    body: { getReader: () => ({
      read: async () => { reads++; return { done: false, value: new Uint8Array(MAX_RESPONSE_BYTES + 1) }; },
      cancel: async () => { cancels++; }, releaseLock: () => { releases++; },
    }) },
  }));
  await assert.rejects(request({ url: 'http://127.0.0.1' }, '/synthetic', {}), /exceeds the limit/);
  assert.deepEqual({ reads, cancels, releases }, { reads: 1, cancels: 1, releases: 1 });
});

test('real HTTP decoder preserves a multibyte sequence split between chunks', async t => {
  const raw = Buffer.from(JSON.stringify({ text: '中文🙂"\\\n' }));
  const split = raw.indexOf(Buffer.from('中')) + 1;
  const config = await peer(t, async (_req, res) => {
    res.write(raw.subarray(0, split));
    await delay(10);
    res.end(raw.subarray(split));
  });
  assert.deepEqual(await request(config, '/unicode', {}), { text: '中文🙂"\\\n' });
});

test('real HTTP rejects malformed and truncated UTF-8 instead of replacing it', async t => {
  const config = await peer(t, (req, res) => res.end(req.url === '/truncated' ? Buffer.from('{"x":"\xc3', 'latin1') : Buffer.from('{"x":"\xc3("}', 'latin1')));
  for (const path of ['/malformed', '/truncated']) await assert.rejects(request(config, path, {}), /Service returned invalid UTF-8/);
});

test('JSON validation and HTTP error redaction remain intact and common requests can exceed 200k', async t => {
  const config = await peer(t, (req, res) => {
    if (req.url === '/invalid') res.end('not-json');
    else if (req.url === '/error') { res.statusCode = 403; res.end(JSON.stringify({ error: { message: 'Denied ' + token + ' Bearer secret' } })); }
    else res.end('{}');
  });
  await assert.rejects(request(config, '/invalid', {}), /Service returned invalid JSON \(200\)/);
  await assert.rejects(request(config, '/error', {}), error => error.status === 403 && !error.message.includes(token) && !error.message.includes('Bearer secret'));
  await request(config, '/workspace-delivery', { delivery: 'x'.repeat(MAX_STDIO_REQUEST_BYTES + 1) });
  assert.ok(config.requests.at(-1).bytes > MAX_STDIO_REQUEST_BYTES);
});

test('actual STDIO bridge forwards > old 2 MiB characters and <= 4 MiB bytes', async t => {
  const raw = sizedJson(3 * 1024 * 1024, { jsonrpc: '2.0', id: 2, result: { text: '中文🙂"\\\n' } });
  assert.ok(raw.length > 2 * 1024 * 1024);
  const config = await peer(t, (_req, res) => res.end(raw));
  const result = await stdio(t, config, [input([initialize, call(2)])]);
  const reply = result.replies.find(reply => reply.id === 2);
  assert.equal(reply.result.text, '中文🙂"\\\n');
  assert.equal(Buffer.byteLength(result.lines.find(line => JSON.parse(line).id === 2)), 3 * 1024 * 1024);
});

test('actual STDIO input accepts exact 200000 UTF-8 bytes and rejects one byte over then recovers', async t => {
  const config = await peer(t, (_req, res, body) => res.end(JSON.stringify({ result: { text: body.params.arguments.text } })));
  const exact = sizedCall(MAX_STDIO_REQUEST_BYTES, 2);
  const overflow = sizedCall(MAX_STDIO_REQUEST_BYTES + 1, 3);
  const result = await stdio(t, config, [input([initialize, exact, overflow, { jsonrpc: '2.0', id: 4, method: 'ping' }], '\r\n')]);
  assert.ok(result.replies.find(reply => reply.id === 2).result.text.startsWith('中文🙂"\\\n'));
  assert.equal(config.requests.filter(item => item.path === '/api/connector/mcp').length, 1);
  assert.equal(config.requests.find(item => item.path === '/api/connector/mcp').bytes, MAX_STDIO_REQUEST_BYTES);
  assert.ok(result.replies.find(reply => reply.id === null && reply.error?.code === -32600));
  assert.deepEqual(result.replies.find(reply => reply.id === 4).result, {});
});

test('actual STDIO decodes deliberately split Chinese and emoji chunks and EOF lines', async t => {
  const config = await peer(t, (_req, res, body) => res.end(JSON.stringify({ result: { text: body.params.arguments.text } })));
  const raw = Buffer.from(JSON.stringify(call(2, '中文🙂"\\\n')));
  const start = raw.indexOf(Buffer.from('中'));
  const chunks = [input([initialize]), async stdout => {
    for (let attempt = 0; attempt < 100 && !stdout().includes('"id":"init"'); attempt++) await delay(10);
    assert.ok(stdout().includes('"id":"init"'), 'wait for initialization before splitting UTF-8 bytes');
  }, raw.subarray(0, start)];
  for (let i = start; i < start + Buffer.byteLength('中文🙂'); i++) chunks.push(raw.subarray(i, i + 1), 5);
  chunks.push(raw.subarray(start + Buffer.byteLength('中文🙂')));
  const result = await stdio(t, config, chunks);
  assert.equal(result.replies.find(reply => reply.id === 2).result.text, '中文🙂"\\\n');
  assert.equal(config.requests.find(item => item.path === '/api/connector/mcp').body.params.arguments.text, '中文🙂"\\\n');
});

test('actual STDIO enforces its byte limit on EOF and fragmented over-limit lines', async t => {
  const config = await peer(t, (_req, res) => res.end('{}'));
  const overflow = Buffer.from(sizedCall(MAX_STDIO_REQUEST_BYTES + 1, 2, '中'.repeat(50000)));
  for (const chunks of [[input([initialize]), overflow], [input([initialize]), overflow.subarray(0, 180000), 5, overflow.subarray(180000), input(['', { jsonrpc: '2.0', id: 4, method: 'ping' }])]]) {
    const result = await stdio(t, config, chunks);
    assert.equal(result.replies.filter(reply => reply.error?.code === -32600).length, 1);
  }
  assert.equal(config.requests.filter(item => item.path === '/api/connector/mcp').length, 0);
});

test('actual STDIO output accepts an exact 4 MiB complete envelope', async t => {
  const raw = sizedJson(MAX_RESPONSE_BYTES, { jsonrpc: '2.0', id: 2, result: { text: '中文🙂' } });
  assert.equal(Buffer.byteLength(raw), MAX_RESPONSE_BYTES);
  const config = await peer(t, (_req, res) => res.end(raw));
  const result = await stdio(t, config, [input([initialize, call(2)])]);
  assert.equal(result.replies.find(reply => reply.id === 2).result.text, '中文🙂');
  assert.equal(Buffer.byteLength(result.lines.find(line => JSON.parse(line).id === 2)), MAX_RESPONSE_BYTES);
});

test('actual STDIO output bounds an envelope growing one byte after request ID replacement', async t => {
  const raw = sizedJson(MAX_RESPONSE_BYTES, { jsonrpc: '2.0', id: 0, result: { text: '中文🙂' } });
  const config = await peer(t, (_req, res) => res.end(raw));
  const result = await stdio(t, config, [input([initialize, call(10)])]);
  const reply = result.replies.find(reply => reply.id === 10);
  assert.deepEqual(reply.error, { code: -32000, message: 'STDIO response exceeds the limit' });
  assert.ok(Buffer.byteLength(JSON.stringify(reply)) < 200);
});
