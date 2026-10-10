import fs from 'node:fs/promises';
import { constants, fstat as fstatCallback } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { secureRoot, safeRead } from './state.mjs';

const MAX_JOURNAL_BYTES = 65536;
const fstat = promisify(fstatCallback);
const unavailable = () => Object.assign(new Error('Consumer state unavailable'), { code: 'CONSUMER_STATE_UNAVAILABLE', status: 503 });
const invalid = () => Object.assign(new Error('Invalid consumer state input'), { code: 'CONSUMER_STATE_INPUT' });
const tokenRejected = () => Object.assign(new Error('Local API token input rejected'), { code: 'LOCAL_TOKEN_INPUT' });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const privateFile = stat => stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077);
const privateDirectory = stat => stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077);
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
}
function binding(endpoint, runId) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || typeof runId !== 'string' ||
      !runId.trim() || runId.length > 200 || /[\u0000-\u001f\u007f]/.test(runId)) throw invalid();
  let url;
  try { url = new URL(endpoint); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.href !== endpoint || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/api/execution/worker-mcp') throw invalid();
}
function dataJSON(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
  const visited = new Set();
  let items = 0;
  const visit = (value, depth) => {
    if (depth > 16 || ++items > 8192) throw invalid();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw invalid(); return; }
    if (typeof value !== 'object' || visited.has(value)) throw invalid();
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw invalid();
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) ||
          /^(?:apiToken|localApiToken|localToken|issuerToken|authorization)$/i.test(key)) throw invalid();
      visit(child, depth + 1);
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) throw invalid();
    visited.delete(value);
  };
  visit(data, 0);
  return JSON.stringify(data);
}
function envelope(endpoint, runId, data) {
  const copy = JSON.parse(dataJSON(data));
  const value = { version: 1, endpoint, runId, data: copy };
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (bytes.length > MAX_JOURNAL_BYTES) throw invalid();
  return { value, bytes };
}
async function acquireLock(fd) {
  await new Promise((resolvePromise, reject) => {
    let finished = false;
    const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else resolvePromise();
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(unavailable()); }, 2500);
    child.once('error', () => finish(unavailable()));
    child.once('exit', (code, signal) => finish(code === 0 && signal === null ? null :
      Object.assign(new Error('Another consumer owns this state'), { code: 'CONSUMER_STATE_BUSY' })));
  });
}
/** Private, Run-bound journal. Kernel flock belongs to the inherited open file description. */
export async function openConsumerState(options) {
  exact(options, ['root', 'endpoint', 'runId', 'initialData']);
  const { endpoint, runId } = options;
  binding(endpoint, runId);
  if (process.platform !== 'linux' || typeof options.root !== 'string' || !options.root.startsWith('/')) throw invalid();
  const initialData = options.initialData === undefined ? {} : JSON.parse(dataJSON(options.initialData));
  let directory, lock, failure = null, closed = false, closing = false, closePromise;
  let serial = Promise.resolve(), current, journalStat = null;
  const assertAvailable = () => { if (failure || closed) throw unavailable(); };
  try {
    const root = await secureRoot(resolve(options.root));
    directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directoryStat = await directory.stat();
    if (!privateDirectory(directoryStat)) throw unavailable();
    const pinned = '/proc/self/fd/' + directory.fd;
    lock = await fs.open(join(pinned, '.consumer.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const lockStat = await lock.stat();
    if (!privateFile(lockStat)) throw unavailable();
    await acquireLock(lock.fd);
    const journalPath = join(pinned, 'journal.json');
    async function checkPinned(checkJournal = true) {
      assertAvailable();
      const [pathStat, dirStat, heldLock, pathLock] = await Promise.all([
        fs.lstat(root), directory.stat(), lock.stat(), fs.lstat(join(pinned, '.consumer.lock')),
      ]);
      if (!privateDirectory(pathStat) || !sameFile(pathStat, directoryStat) || !sameFile(dirStat, directoryStat) ||
          !privateFile(heldLock) || !privateFile(pathLock) || !sameFile(heldLock, lockStat) || !sameFile(pathLock, lockStat)) throw unavailable();
      if (checkJournal && journalStat) {
        const stat = await fs.lstat(journalPath);
        if (!privateFile(stat) || !sameFile(stat, journalStat)) throw unavailable();
      }
    }
    async function commit(next) {
      const serialized = envelope(endpoint, runId, next);
      const name = '.consumer-tmp-' + process.pid + '-' + randomBytes(8).toString('hex') + '.json';
      const temp = join(pinned, name);
      let renamed = false;
      try {
        await checkPinned();
        const file = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(serialized.bytes); await file.sync(); } finally { await file.close(); }
        await checkPinned();
        await fs.rename(temp, journalPath); renamed = true;
        await directory.sync();
        journalStat = await fs.lstat(journalPath);
        await checkPinned();
        current = serialized.value;
      } catch {
        failure = unavailable();
        throw failure;
      } finally {
        if (!renamed) await fs.rm(temp, { force: true }).catch(() => {});
      }
    }
    await checkPinned(false);
    try {
      const handle = await fs.open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes;
      try {
        const before = await handle.stat();
        if (!privateFile(before) || before.size > MAX_JOURNAL_BYTES) throw unavailable();
        const buffer = Buffer.alloc(before.size + 1);
        let count = 0;
        while (count < buffer.length) {
          const read = await handle.read(buffer, count, buffer.length - count, count);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        bytes = buffer.subarray(0, count);
        const after = await handle.stat();
        if (bytes.length !== before.size || !sameFile(before, after) || before.mtimeMs !== after.mtimeMs || after.size !== before.size) throw unavailable();
        journalStat = after;
      } finally { await handle.close(); }
      const saved = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      exact(saved, ['version', 'endpoint', 'runId', 'data']);
      if (saved.version !== 1 || saved.endpoint !== endpoint || saved.runId !== runId) throw invalid();
      current = envelope(endpoint, runId, saved.data).value;
      await checkPinned();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await commit(initialData);
    }
    // Interrupted writes are removed only while this process holds the same kernel lock.
    const names = await fs.readdir(pinned);
    if (names.length > 128) throw unavailable();
    for (const name of names) {
      if (!/^\.consumer-tmp-[0-9]+-[a-f0-9]{16}\.json$/.test(name)) continue;
      const stat = await fs.lstat(join(pinned, name));
      if (!privateFile(stat) || stat.size > MAX_JOURNAL_BYTES) throw unavailable();
      await fs.rm(join(pinned, name));
    }
    await directory.sync();
    return {
      snapshot() { assertAvailable(); return JSON.parse(JSON.stringify(current)); },
      assertAvailable,
      update(mutator) {
        if (closing || closed || typeof mutator !== 'function') return Promise.reject(unavailable());
        const next = serial.then(async () => {
          assertAvailable();
          const draft = JSON.parse(JSON.stringify(current.data));
          const result = mutator(draft);
          if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(() => {});
            throw invalid();
          }
          const value = result === undefined ? draft : result;
          envelope(endpoint, runId, value); // Input rejection does not poison a healthy disk.
          await commit(value);
          return JSON.parse(JSON.stringify(current));
        });
        serial = next.catch(() => {});
        return next;
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = serial.then(async () => {
          closed = true;
          await lock.close();
          await directory.close();
        });
        return closePromise;
      },
    };
  } catch (error) {
    await lock?.close().catch(() => {});
    await directory?.close().catch(() => {});
    if (error.code === 'CONSUMER_STATE_BUSY' || error.code === 'CONSUMER_STATE_INPUT') throw error;
    throw unavailable();
  }
}
/** Only explicit private files or inherited private file/anonymous pipe descriptors supply bootstrap authority. */
export async function readLocalApiToken(options) {
  exact(options, ['tokenFile', 'tokenFd']);
  const hasFile = options.tokenFile !== undefined, hasFd = options.tokenFd !== undefined;
  if (hasFile === hasFd) throw tokenRejected();
  let bytes;
  try {
    if (hasFile) {
      if (typeof options.tokenFile !== 'string' || !options.tokenFile.startsWith('/')) throw tokenRejected();
      bytes = await safeRead(options.tokenFile, 45);
    } else {
      const fd = options.tokenFd;
      if (!Number.isSafeInteger(fd) || fd < 3) throw tokenRejected();
      const before = await fstat(fd);
      const target = await fs.readlink('/proc/self/fd/' + fd);
      const pipe = before.isFIFO() && /^pipe:\[[0-9]+\]$/.test(target);
      if ((!pipe && (!privateFile(before) || before.size > 45)) || before.uid !== process.getuid() || (before.mode & 0o077)) throw tokenRejected();
      const duplicate = await fs.open('/proc/self/fd/' + fd, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const after = await duplicate.stat();
        if (!sameFile(before, after)) throw tokenRejected();
        const buffer = Buffer.alloc(46);
        const deadline = Date.now() + 2500;
        let count = 0;
        while (count < buffer.length) {
          let read;
          try { read = await duplicate.read(buffer, count, buffer.length - count, null); }
          catch (error) {
            if (error.code !== 'EAGAIN' || Date.now() >= deadline) throw tokenRejected();
            await new Promise(resolvePromise => setTimeout(resolvePromise, 5)); continue;
          }
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        if (count > 45) throw tokenRejected();
        bytes = buffer.subarray(0, count);
      } finally { await duplicate.close(); }
    }
    const text = bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}(?:\r?\n)?$/.test(text)) throw tokenRejected();
    return text.slice(0, 43);
  } catch { throw tokenRejected(); }
}
