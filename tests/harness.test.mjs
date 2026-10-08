import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorkspace, loopbackUrl, freePort, startChild, runChild, stopChild, waitForHttp } from './harness.mjs';

// Copying unchecked files or reusing a workspace would expose local state.
test('workspaces copy application inputs without local state, secrets or symlinks', async () => {
  const source = await mkdtemp(join(tmpdir(), 'hub-source-'));
  let first, second;
  try {
    for (const dir of ['app', '.local/state', 'private-config', 'node_modules', 'dist', '.git', 'migrations']) {
      await mkdir(join(source, dir), { recursive: true });
    }
    for (const file of ['.dev.vars', '.env.private', '.local/state/development.sqlite', 'private-config/execution.json', 'node_modules/private', 'dist/private', '.git/private', 'app/private.db', 'app/.dev.vars.local','app/control.json','app/runner.json','app/credentials.json','app/session.key','app/private.pem', 'private-config/credentials.json']) {
      await writeFile(join(source, file), 'must not be copied');
    }
    await writeFile(join(source, 'app/page.tsx'), 'synthetic source');
    await writeFile(join(source, '.env.example'), 'EXAMPLE_ONLY=');
    await writeFile(join(source, 'migrations/001.sql'), 'CREATE TABLE synthetic(id TEXT);');
    await symlink(join(source, '.dev.vars'), join(source, 'app/secret-link'));
    first = await createWorkspace(source);
    second = await createWorkspace(source);
    assert.notEqual(first, second);
    assert.equal(await readFile(join(first, 'app/page.tsx'), 'utf8'), 'synthetic source');
    assert.equal(await readFile(join(first, '.env.example'), 'utf8'), 'EXAMPLE_ONLY=');
    assert.equal(await readFile(join(first, 'migrations/001.sql'), 'utf8'), 'CREATE TABLE synthetic(id TEXT);');
    for (const file of ['.local', 'private-config', '.dev.vars', '.env.private', 'node_modules', 'dist', '.git', 'app/private.db', 'app/.dev.vars.local','app/control.json','app/runner.json','app/credentials.json','app/session.key','app/private.pem', 'app/secret-link', 'private-config/credentials.json']) {
      await assert.rejects(access(join(first, file)), { code: 'ENOENT' });
    }
  } finally {
    for (const dir of [first, second, source].filter(Boolean)) await rm(dir, { recursive: true, force: true });
  }
});

test('workspace does not follow a symlinked schema directory', async () => {
  const source = await mkdtemp(join(tmpdir(), 'hub-source-'));
  const outside = await mkdtemp(join(tmpdir(), 'hub-private-'));
  let workspace;
  try {
    await writeFile(join(outside, '001.sql'), 'must not be copied');
    await symlink(outside, join(source, 'migrations'));
    workspace = await createWorkspace(source);
    await assert.rejects(access(join(workspace, 'migrations/001.sql')), { code: 'ENOENT' });
  } finally {
    for (const dir of [workspace, source, outside].filter(Boolean)) await rm(dir, { recursive: true, force: true });
  }
});

// Weak hostname/protocol validation would allow requests to public endpoints.
test('only explicit HTTP loopback origins are accepted', () => {
  for (const [input, origin] of [
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5173'],
    ['http://localhost:8787/', 'http://localhost:8787'],
    ['http://[::1]:3456', 'http://[::1]:3456'],
  ]) assert.equal(loopbackUrl(input).origin, origin);
  for (const input of [
    'https://example.test', 'https://127.0.0.1', 'ftp://localhost',
    'http://127.0.0.1.example.test', 'http://user:password@127.0.0.1',
    'http://0.0.0.0', 'http://[::]', 'http://[::ffff:192.0.2.1]',
    'http://localhost/api', 'http://localhost?target=external', 'http://localhost#fragment',
    'http://localhost:invalid', 'http://localhost:0', 'http://localhost/api/..',
    'http://localhost?', 'http://localhost#', 'http://127.1', ' http://localhost',
    'http://localhost\n', 'not a URL', '', null,
  ]) assert.throws(() => loopbackUrl(input), undefined, String(input));
});

test('Python independently rejects malformed loopback targets before making requests', async () => {
  const artifacts = await mkdtemp(join(tmpdir(), 'hub-api-target-'));
  try {
    for (const value of ['http://@127.0.0.1:1', 'http://127.0.0.1:1?', 'http://127.0.0.1:1#']) {
      const result = spawnSync('python3', [fileURLToPath(new URL('./api.py', import.meta.url))], {
        env: { PATH: process.env.PATH, TEST_DEV_URL: value, TEST_PREVIEW_URL: 'http://127.0.0.1:2', TEST_ARTIFACT_DIR: artifacts },
        encoding: 'utf8', timeout: 5000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /HTTP loopback URL required/);
    }
  } finally { await rm(artifacts, { recursive: true, force: true }); }
});

// Holding or allocating a public socket would break the runner's port contract.
test('freePort releases an available loopback TCP port', async () => {
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('commands reject nonzero exits instead of silently continuing', async () => {
  await assert.rejects(runChild(process.execPath, ['-e', 'process.exit(7)']), /exit 7/);
});

test('readiness fails promptly when a server exits', async () => {
  const child = startChild(process.execPath, ['-e', 'process.exit(8)']);
  try {
    await assert.rejects(waitForHttp(`http://127.0.0.1:${await freePort()}`, [child], { timeoutMs: 5000 }), /exit 8/);
  } finally { await stopChild(child); }
});

test('readiness has a deadline for an unavailable server', async () => {
  await assert.rejects(waitForHttp(`http://127.0.0.1:${await freePort()}`, [], { timeoutMs: 80 }), /Timed out/);
});

test('stopping a server reaps it and releases its listener', async () => {
  const port = await freePort();
  const child = startChild(process.execPath, ['-e', `require('http').createServer((_,res)=>res.end('ready')).listen(${port},'127.0.0.1')`]);
  try {
    await waitForHttp(`http://127.0.0.1:${port}`, [child]);
    await stopChild(child);
    assert.equal(child.result.signal, 'SIGTERM');
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => server.close(resolve));
  } finally { await stopChild(child); }
});

test('an aborted command is stopped and reaped', async () => {
  const abort = new AbortController();
  const pending = runChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: abort.signal });
  abort.abort(new Error('test interruption'));
  await assert.rejects(pending, /test interruption/);
});

test('aborting escalates when a child ignores SIGTERM', { timeout: 6000 }, async () => {
  const abort = new AbortController();
  const pending = runChild(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { signal: abort.signal });
  const timer = setTimeout(() => abort.abort(new Error('ignored termination')), 200);
  try { await assert.rejects(pending, /ignored termination/); } finally { clearTimeout(timer); }
});
