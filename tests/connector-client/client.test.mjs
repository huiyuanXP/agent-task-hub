import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '../..');
const cli = join(root, 'connector/cli.mjs');
function command(executable, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => accept({ code, stdout, stderr }));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(options.input ?? '');
  });
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ath-connector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await command('git', ['init', directory])).code, 0);
  await writeFile(join(directory, 'README.md'), 'temporary connector project\n');
  await command('git', ['-C', directory, '-c', 'user.name=Connector Test', '-c', 'user.email=connector@example.test', 'add', 'README.md']);
  assert.equal((await command('git', ['-C', directory, '-c', 'user.name=Connector Test', '-c', 'user.email=connector@example.test', 'commit', '-m', 'Fixture'])).code, 0);
  const requests = [];
  const backend = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push({ path: request.url, body, authorization: request.headers.authorization });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/connector/enroll') {
      assert.equal(body.code, 'single-use-invitation');
      assert.equal(body.workspace, directory.split('/').at(-1));
      response.end(JSON.stringify({ token: 'private-connector-credential', origin: origin, connection: { id: 'connector:test', projectId: 'project:test', project: 'Synthetic project', capabilities: ['read', 'submit', 'plan', 'execute'] } }));
    } else if (request.headers.authorization !== 'Bearer private-connector-credential') {
      response.statusCode = 401; response.end(JSON.stringify({ error: 'Unauthorized' }));
    } else if (request.url === '/api/connector/mcp') {
      const value = body.method === 'tools/list' ? { tools: [{ name: 'list_tickets', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: '{"items":[]}' }], structuredContent: { items: [] }, isError: false };
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value }));
    } else if (request.url === '/api/connector/agent') {
      response.end(JSON.stringify({ job: null }));
    } else response.end(JSON.stringify({ connection: { id: 'connector:test' } }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const origin = `http://127.0.0.1:${backend.address().port}`;
  t.after(() => new Promise(accept => backend.close(accept)));
  return { directory, origin, requests, backend, config: join(directory, '.agent-task-hub/connection.json') };
}

test('unpacked archive installs private standalone runtime and preserves client configuration', async t => {
  const item = await fixture(t);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(item.directory, '.codex'));
  const existing = '[mcp_servers.existing]\ncommand = "existing-server"\n';
  await writeFile(join(item.directory, '.codex/config.toml'), existing);
  const packed = await command(process.execPath, [join(root, 'scripts/package-connector.mjs')]);
  assert.equal(packed.code, 0, packed.stderr);
  const unpacked = join(item.directory, 'download');
  await mkdir(unpacked);
  assert.equal((await command('tar', ['-xzf', join(root, 'build/connector/agent-task-hub-connector.tgz'), '-C', unpacked])).code, 0);
  const downloadedCli = join(unpacked, 'agent-task-hub-connector/cli.mjs');
  const install = await command(process.execPath, [downloadedCli, 'install', '--url', item.origin, '--workspace', item.directory, '--code-stdin'], { input: 'single-use-invitation\n' });
  assert.equal(install.code, 0, install.stderr);
  assert.ok(!install.stdout.includes('private-connector-credential'));
  const config = JSON.parse(await readFile(item.config, 'utf8'));
  assert.equal(config.connectionId, 'connector:test');
  assert.equal((await stat(item.config)).mode & 0o777, 0o600);
  assert.equal((await stat(join(item.directory, '.agent-task-hub'))).mode & 0o777, 0o700);
  const configured = await readFile(join(item.directory, '.codex/config.toml'), 'utf8');
  assert.ok(configured.startsWith(existing));
  assert.ok(configured.includes(config.runtime));
  assert.ok(configured.includes(process.execPath));
  await writeFile(join(unpacked, 'agent-task-hub-connector/README.md'), 'Updated downloaded runtime guide\n');
  const update = await command(process.execPath, [downloadedCli, 'install', '--url', item.origin, '--workspace', item.directory, '--code-stdin'], { input: 'single-use-invitation\n' });
  assert.equal(update.code, 0, update.stderr);
  assert.equal(await readFile(join(config.runtime, '../README.md'), 'utf8'), 'Updated downloaded runtime guide\n');
  assert.equal(JSON.parse(await readFile(item.config, 'utf8')).installationId, config.installationId);
  await rm(unpacked, { recursive: true });
  const doctor = await command(process.execPath, [config.runtime, 'doctor', '--config', item.config]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.ok(doctor.stdout.includes('connector:test'));
  const repeated = await command(process.execPath, [config.runtime, 'install', '--url', item.origin, '--workspace', item.directory, '--code-stdin'], { input: 'single-use-invitation\n' });
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(item.requests.filter(request => request.path === '/api/connector/enroll').length, 1);
  const uninstalled = await command(process.execPath, [config.runtime, 'uninstall', '--config', item.config]);
  assert.equal(uninstalled.code, 0, uninstalled.stderr);
  assert.equal(await readFile(join(item.directory, '.codex/config.toml'), 'utf8'), existing);
  await assert.rejects(access(item.config));
});

test('actual STDIO process negotiates MCP and forwards scoped bearer tools without stdout diagnostics', async t => {
  const item = await fixture(t);
  const install = await command(process.execPath, [cli, 'install', '--url', item.origin, '--workspace', item.directory, '--code-stdin'], { input: 'single-use-invitation\n' });
  assert.equal(install.code, 0, install.stderr);
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'real-stdio-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tickets', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'ping' },
    { jsonrpc: '2.0', id: 5, method: 'unavailable' },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  const mcp = await command(process.execPath, [cli, 'mcp', '--config', item.config], { input });
  assert.equal(mcp.code, 0, mcp.stderr);
  const replies = mcp.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 5);
  assert.equal(replies.find(reply => reply.id === 1).result.protocolVersion, '2025-11-25');
  assert.equal(replies.find(reply => reply.id === 2).result.tools[0].name, 'list_tickets');
  assert.deepEqual(replies.find(reply => reply.id === 3).result.structuredContent, { items: [] });
  assert.equal(replies.find(reply => reply.id === 5).error.code, -32601);
  assert.ok(item.requests.filter(request => request.path === '/api/connector/mcp').every(request => request.authorization === 'Bearer private-connector-credential'));
});

test('unauthenticated real Codex keeps agent heartbeat available without claiming work', async t => {
  const item = await fixture(t);
  const install = await command(process.execPath, [cli, 'install', '--url', item.origin, '--workspace', item.directory, '--code-stdin'], { input: 'single-use-invitation\n' });
  assert.equal(install.code, 0, install.stderr);
  const environment = { ...process.env, CODEX_HOME: join(item.directory, 'empty-codex-profile') };
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  const agent = await command(process.execPath, [cli, 'agent', '--config', item.config, '--once'], { env: environment });
  assert.equal(agent.code, 0, agent.stderr);
  const heartbeat = item.requests.find(request => request.body.mode === 'agent');
  assert.equal(heartbeat.body.agentReady, false);
  assert.match(heartbeat.body.error, /logged in|login|authentication/i);
  assert.equal(item.requests.filter(request => request.path === '/api/connector/agent').length, 0);
});

test('URL changes reject credentialed or public cleartext endpoints', async t => {
  const item = await fixture(t);
  const install = await command(process.execPath, [cli, 'install', '--url', item.origin, '--workspace', item.directory, '--code-stdin'], { input: 'single-use-invitation\n' });
  assert.equal(install.code, 0, install.stderr);
  for (const url of ['http://example.com', 'https://secret@example.com', 'https://example.com/path']) {
    const change = await command(process.execPath, [cli, 'set-url', '--config', item.config, '--url', url]);
    assert.equal(change.code, 1);
  }
  assert.equal(JSON.parse(await readFile(item.config, 'utf8')).url, item.origin);
});
