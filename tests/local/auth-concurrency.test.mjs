import {fixtureEnvironment} from './fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../lib/database.mts';
import { createAccount } from '../../lib/local-auth.mts';
const worker = fileURLToPath(new URL('./auth-race-worker.mjs', import.meta.url));
async function scenario(name) {
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', worker, name], {
    env: { ...fixtureEnvironment(), UV_THREADPOOL_SIZE: '1' }, timeout: 15000,
  });
  return JSON.parse(stdout);
}

test('password reset rejects a login still verifying the previous password', async () => {
  const result = await scenario('reset');
  assert.equal(result.reset, 'fulfilled');
  assert.equal(result.login, 'rejected');
  assert.equal(result.status, 401);
  assert.equal(result.oldTokenValid, false);
  assert.equal(result.replacement, 200);
});

test('concurrent wrong passwords reserve only five attempts before hashing', async () => {
  const statuses = await scenario('admission');
  assert.equal(statuses.filter(status => status === 401).length, 5);
  assert.equal(statuses.filter(status => status === 429).length, 7);
});

test('successful login preserves reservations belonging to newer requests', async () => {
  const result = await scenario('newer-reservations');
  assert.deepEqual(result.pending, [401, 401, 401, 401]);
  assert.equal(result.newer.filter(status => status === 401).length, 1);
  assert.equal(result.newer.filter(status => status === 429).length, 7);
});


test('pre-reset attempts cannot recreate the reset throttle window when they finish', async () => {
  const statuses = await scenario('reset-reservations');
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
});

test('a success from an expired window cannot refund capacity in its replacement', async () => {
  const result = await scenario('expired-window');
  assert.deepEqual(result.replacement, [401, 401, 401, 401, 401]);
  assert.equal(result.following, 429);
});

test('separate processes share atomic throttle admission in the same SQLite file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-auth-processes-'));
  const file = join(dir, 'data.sqlite');
  const db = openDatabase(file);
  const children = [];
  try {
    await createAccount(db, { username: 'alice', displayName: 'Alice', password: 'synthetic-password' });
    const clients = Array.from({ length: 3 }, () => {
      const child = fork(worker, ['process-admission', file], {
        execArgv: ['--experimental-strip-types'], env: { ...fixtureEnvironment(), UV_THREADPOOL_SIZE: '1' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      let output = '';
      child.stderr.on('data', chunk => { output += chunk; });
      const ready = new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', code => { if (code !== 0) reject(Error(output)); });
      });
      const result = new Promise((resolve, reject) => {
        child.on('message', message => { if (message.result) resolve(message.result); });
        child.once('error', reject);
        child.once('exit', code => { if (code !== 0) reject(Error(output)); });
      });
      return { child, ready, result };
    });
    await Promise.all(clients.map(client => client.ready));
    for (const client of clients) client.child.send('go');
    const statuses = (await Promise.all(clients.map(client => client.result))).flat();
    assert.equal(statuses.filter(status => status === 401).length, 5);
    assert.equal(statuses.filter(status => status === 429).length, 7);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
