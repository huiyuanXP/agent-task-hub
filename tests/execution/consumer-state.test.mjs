import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fork, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openConsumerState, readLocalApiToken } from '../../runner/consumer-state.mjs';

const endpoint = 'http://127.0.0.1:5173/api/execution/worker-mcp', runId = 'synthetic-consumer-run';
const script = fileURLToPath(new URL('./fixtures/consumer-state-child.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'consumer-state-')), children = new Set(), journals = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
    }
    for (const journal of journals) await journal.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const open = async (options = {}) => {
    const journal = await openConsumerState({ root, endpoint, runId, ...options });
    journals.push(journal); return journal;
  };
  const start = mode => {
    const child = fork(script, [mode, root, endpoint, runId], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
    children.add(child); return child;
  };
  return { root, open, start, children };
}
function message(child, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('Child checkpoint timed out')), 5000);
    const received = value => { if (value.event === event) finish(null, value); else if (value.event === 'error') finish(Object.assign(Error('Child failed'), { code: value.code })); };
    const exited = () => finish(Error('Child exited before checkpoint'));
    function finish(error, value) {
      clearTimeout(timer); child.off('message', received); child.off('exit', exited);
      if (error) reject(error); else resolve(value);
    }
    child.on('message', received); child.once('exit', exited);
  });
}
test('private journal binds version, endpoint and Run, clones snapshots, and serializes updates without lost increments', async t => {
  const f = await fixture(t), journal = await f.open({ initialData: { count: 0, pending: null } });
  const first = journal.snapshot();
  assert.deepEqual(first, { version: 1, endpoint, runId, data: { count: 0, pending: null } });
  first.data.count = 999; assert.equal(journal.snapshot().data.count, 0);
  await Promise.all(Array.from({ length: 25 }, () => journal.update(data => { data.count += 1; })));
  assert.equal(journal.snapshot().data.count, 25);
  const updated = await journal.update(() => ({ count: 26, pending: { requestId: 'persisted-before-send' } }));
  assert.deepEqual(JSON.parse(await fs.readFile(join(f.root, 'journal.json'), 'utf8')), updated);
  const returned = updated; returned.data.count = 0; assert.equal(journal.snapshot().data.count, 26);
  assert.equal((await fs.stat(f.root)).mode & 0o777, 0o700);
  for (const name of ['journal.json', '.consumer.lock']) assert.equal((await fs.stat(join(f.root, name))).mode & 0o777, 0o600);
  await journal.close();
  await assert.rejects(f.open({ endpoint: 'http://localhost:5173/api/execution/worker-mcp' }), { code: 'CONSUMER_STATE_INPUT' });
  await assert.rejects(f.open({ runId: 'other-run' }), { code: 'CONSUMER_STATE_INPUT' });
  const reopened = await f.open({ initialData: { count: 999 } });
  assert.equal(reopened.snapshot().data.count, 26);
});
test('actual inherited kernel flock excludes same-process and child contenders, and SIGKILL immediately releases ownership', async t => {
  const f = await fixture(t), child = f.start('hold');
  await message(child, 'ready');
  await assert.rejects(f.open(), { code: 'CONSUMER_STATE_BUSY' });
  const second = f.start('hold');
  await assert.rejects(message(second, 'ready'), { code: 'CONSUMER_STATE_BUSY' });
  const updated = message(child, 'updated'); child.send({ action: 'update', count: 7 }); await updated;
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
  const journal = await f.open();
  assert.equal(journal.snapshot().data.count, 7);
  const descendants = await fs.readFile('/proc/self/task/' + process.pid + '/children', 'utf8');
  assert.ok(!descendants.trim().split(/\s+/).includes(String(child.pid)));
});
for (const [phase, expected] of [['before-rename', 0], ['after-rename', 1]]) {
  test('real SIGKILL ' + phase + ' resumes from a complete atomic journal', async t => {
    const f = await fixture(t), initial = await f.open({ initialData: { count: 0 } }); await initial.close();
    const child = f.start(phase); await message(child, 'ready');
    const checkpoint = message(child, 'checkpoint'); child.send({ action: 'update', count: 1 }); await checkpoint;
    const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    const journal = await f.open();
    assert.equal(journal.snapshot().data.count, expected);
    assert.equal(JSON.parse(await fs.readFile(join(f.root, 'journal.json'), 'utf8')).data.count, expected);
    assert.equal((await fs.readdir(f.root)).filter(name => name.startsWith('.consumer-tmp-')).length, 0);
  });
}
test('write failure poisons state and leaves prior durable JSON intact for restart', async t => {
  const f = await fixture(t), journal = await f.open({ initialData: { count: 1 } });
  const originalRename = fs.rename;
  fs.rename = async () => { throw Object.assign(Error('Synthetic disk error'), { code: 'EIO' }); };
  try { await assert.rejects(journal.update(data => { data.count = 2; }), { code: 'CONSUMER_STATE_UNAVAILABLE' }); }
  finally { fs.rename = originalRename; }
  assert.throws(() => journal.snapshot(), { code: 'CONSUMER_STATE_UNAVAILABLE' });
  await assert.rejects(journal.update(data => { data.count = 3; }), { code: 'CONSUMER_STATE_UNAVAILABLE' });
  assert.equal(JSON.parse(await fs.readFile(join(f.root, 'journal.json'), 'utf8')).data.count, 1);
  await journal.close(); assert.equal((await f.open()).snapshot().data.count, 1);
});
test('root or lock inode replacement cannot redirect writes and fails closed', async t => {
  const f = await fixture(t), journal = await f.open({ initialData: { count: 1 } });
  await fs.rename(join(f.root, '.consumer.lock'), join(f.root, 'retained.lock'));
  await fs.writeFile(join(f.root, '.consumer.lock'), '', { mode: 0o600 });
  await assert.rejects(journal.update(data => { data.count = 2; }), { code: 'CONSUMER_STATE_UNAVAILABLE' });
  assert.equal(JSON.parse(await fs.readFile(join(f.root, 'journal.json'), 'utf8')).data.count, 1);
  await journal.close();
  const g = await fixture(t), another = await g.open({ initialData: { count: 4 } });
  const retired = g.root + '-retired';
  t.after(() => fs.rm(retired, { recursive: true, force: true }));
  await fs.rename(g.root, retired); await fs.mkdir(g.root, { mode: 0o700 });
  await assert.rejects(another.update(data => { data.count = 5; }), { code: 'CONSUMER_STATE_UNAVAILABLE' });
  await assert.rejects(fs.readFile(join(g.root, 'journal.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(join(retired, 'journal.json'), 'utf8')).data.count, 4);
});
test('existing journals reject public permission, symlink, hardlink, corruption, wrong version and noncanonical endpoint', async t => {
  const f = await fixture(t), journal = await f.open(); await journal.close();
  const path = join(f.root, 'journal.json'), valid = await fs.readFile(path);
  await fs.chmod(path, 0o644); await assert.rejects(f.open(), { code: 'CONSUMER_STATE_UNAVAILABLE' }); await fs.chmod(path, 0o600);
  const alias = join(f.root, 'alias.json'); await fs.link(path, alias);
  await assert.rejects(f.open(), { code: 'CONSUMER_STATE_UNAVAILABLE' }); await fs.rm(alias);
  await fs.rename(path, alias); await fs.symlink(alias, path);
  await assert.rejects(f.open(), { code: 'CONSUMER_STATE_UNAVAILABLE' }); await fs.rm(path); await fs.rename(alias, path);
  await fs.writeFile(path, '{broken', { mode: 0o600 }); await assert.rejects(f.open(), { code: 'CONSUMER_STATE_UNAVAILABLE' });
  const prefix = Buffer.from(JSON.stringify({ version: 1, endpoint, runId, data: { invalid: '' } }).replace('\"invalid\":\"\"', '\"invalid\":\"'));
  const invalidUtf8 = Buffer.concat([prefix.subarray(0, prefix.length - 2), Buffer.from([255]), Buffer.from('\"}}')]);
  await fs.writeFile(path, invalidUtf8); await assert.rejects(f.open(), { code: 'CONSUMER_STATE_UNAVAILABLE' });
  await fs.writeFile(path, 'x'.repeat(65537)); await assert.rejects(f.open(), { code: 'CONSUMER_STATE_UNAVAILABLE' });
  await fs.writeFile(path, JSON.stringify({ version: 2, endpoint, runId, data: {} }), { mode: 0o600 });
  await assert.rejects(f.open(), { code: 'CONSUMER_STATE_INPUT' });
  await fs.writeFile(path, valid, { mode: 0o600 });
  for (const invalidEndpoint of [endpoint + '/', endpoint + '?x=1', endpoint + '#x', 'http://user:password@127.0.0.1:5173/api/execution/worker-mcp', 'http://127.0.0.1:5173/api/execution/workers']) {
    await assert.rejects(f.open({ endpoint: invalidEndpoint }), { code: 'CONSUMER_STATE_INPUT' });
  }
});
test('invalid data or async mutators cannot persist authority or break subsequent healthy updates', async t => {
  const f = await fixture(t), journal = await f.open({ initialData: { count: 1 } });
  for (const mutate of [
    data => { data.apiToken = randomBytes(32).toString('base64url'); },
    data => { data.authority = undefined; },
    data => { data.cycle = data; },
    data => { data.huge = '汉'.repeat(30000); },
    async data => { data.count = 9; },
  ]) await assert.rejects(journal.update(mutate), { code: 'CONSUMER_STATE_INPUT' });
  assert.equal(journal.snapshot().data.count, 1);
  await journal.update(data => { data.count = 2; });
  const update = journal.update(data => { data.count = 3; }), close = journal.close();
  await update; await close;
  await assert.rejects(journal.update(() => {}), { code: 'CONSUMER_STATE_UNAVAILABLE' });
  assert.throws(() => journal.snapshot(), { code: 'CONSUMER_STATE_UNAVAILABLE' });
  assert.equal((await f.open()).snapshot().data.count, 3);
});
test('local API token reader accepts only explicit private file/fd and exact bounded local token syntax', async t => {
  const f = await fixture(t), token = randomBytes(32).toString('base64url'), path = join(f.root, 'synthetic-token');
  await fs.writeFile(path, token + '\n', { mode: 0o600 });
  assert.equal(await readLocalApiToken({ tokenFile: path }), token);
  const fd = await fs.open(path, 'r'); t.after(() => fd.close());
  assert.equal(await readLocalApiToken({ tokenFd: fd.fd }), token);
  for (const options of [{}, { tokenFile: path, tokenFd: fd.fd }, { tokenFd: 0 }, { tokenFile: 'relative-token' }]) {
    await assert.rejects(readLocalApiToken(options), { code: 'LOCAL_TOKEN_INPUT' });
  }
  await fs.chmod(path, 0o644); await assert.rejects(readLocalApiToken({ tokenFile: path }), { code: 'LOCAL_TOKEN_INPUT' }); await fs.chmod(path, 0o600);
  const alias = join(f.root, 'token-alias'); await fs.symlink(path, alias);
  await assert.rejects(readLocalApiToken({ tokenFile: alias }), { code: 'LOCAL_TOKEN_INPUT' }); await fs.rm(alias); await fs.link(path, alias);
  await assert.rejects(readLocalApiToken({ tokenFile: path }), { code: 'LOCAL_TOKEN_INPUT' }); await fs.rm(alias);
  for (const input of ['athw1.synthetic.' + token, token + '\n\n', token + ' ', 'x'.repeat(46), token.slice(1)]) {
    await fs.writeFile(path, input); await assert.rejects(readLocalApiToken({ tokenFile: path }), { code: 'LOCAL_TOKEN_INPUT' });
  }
});
test('actual anonymous pipe fd delivers a synthetic token without stdout/stderr exposure', async () => {
  const token = randomBytes(32).toString('base64url');
  const child = spawn('/bin/bash', ['-c', 'printf "%s" "$SYNTHETIC_TOKEN" | "$NODE_BINARY" "$CHILD_SCRIPT" token-fd 3 3<&0'], {
    env: { PATH: '/usr/bin:/bin', SYNTHETIC_TOKEN: token, NODE_BINARY: process.execPath, CHILD_SCRIPT: script }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const [exit] = await once(child, 'exit');
  assert.equal(exit, 0); assert.deepEqual(JSON.parse(stdout), { ok: true, digest: hash(token) });
  assert.ok(!stdout.includes(token)); assert.ok(!stderr.includes(token));
});
