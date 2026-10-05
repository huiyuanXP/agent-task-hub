import { mkdir, open, readFile, rename, readdir, opendir, lstat, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { exact } from './policy.mjs';
export const MAX_WORKSPACES = 64;
export const MAX_ACTIVE = 8;
export function identity(run) {
  exact(run, ['owner', 'runId', 'attempt', 'deadlineMs']);
  if (![run.owner, run.runId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256) || !Number.isSafeInteger(run.attempt) || run.attempt < 1 || (run.deadlineMs !== undefined && (!Number.isSafeInteger(run.deadlineMs) || run.deadlineMs <= Date.now()))) throw Error('Invalid workspace identity or deadline');
  return { owner: run.owner, runId: run.runId, attempt: run.attempt };
}
export function workspaceId(run) { return 'ath-' + createHash('sha256').update(JSON.stringify([run.owner, run.runId, run.attempt])).digest('hex').slice(0, 40); }
export function reference(root, state) { return Object.freeze({ root, id: state.id, owner: state.owner, runId: state.runId, attempt: state.attempt }); }
export async function secureRoot(root) {
  if (typeof root !== 'string' || !root.startsWith('/')) throw Error('State root must be absolute');
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || await realpath(root) !== root) throw Error('State root must be private and contain no symlinks');
  return root;
}
/** Kernel flock survives neither SIGKILL nor dead parents; no stale lock deletion race. */
async function withLock(path, fn) {
  const lock = spawn('/usr/bin/flock', ['--exclusive', '--timeout', '5', path, process.execPath, '-e', "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { lock.once('error', reject); lock.once('exit', () => reject(Error('State lock unavailable'))); lock.stdout.once('data', () => resolve()); });
  try { return await fn(); } finally { lock.stdin.end(); }
}
export async function withRoot(root, fn) {
  root = await secureRoot(root);
  return withLock(join(root, '.lock'), async () => {
    let key;
    try { key = await safeRead(join(root, '.ownership-key'), 32); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await records(root)).length) throw Error('Ownership key missing for existing state');
      key = randomBytes(32); await atomicWrite(root, '.ownership-key', key);
    }
    if (key.length !== 32) throw Error('Invalid state ownership key');
    return await fn(root, key);
  });
}
export async function safeRead(path, maxBytes = 2097152, allowRetiredMetadata = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.nlink !== 1 && !(allowRetiredMetadata && stat.nlink === 0)) || stat.size > maxBytes || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Unsafe state file');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    if (count !== stat.size) throw Error('State file changed');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
export async function atomicWrite(directory, name, bytes) {
  if (bytes.length > 2097152) throw Error('State evidence byte capacity exceeded');
  const temp = `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  const file = await open(join(directory, temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let renamed = false;
  try {
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(join(directory, temp), join(directory, name)); renamed = true;
    await syncDirectory(directory);
  } finally { if (!renamed) await rm(join(directory, temp), { force: true }); }
}
export async function syncDirectory(directory) {
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
function signature(key, payload) { return createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex'); }
export function authority(key, id) { return createHmac('sha256', key).update('resource:' + id).digest('hex'); }
export async function save(root, key, state) {
  await atomicWrite(join(root, state.id), 'metadata.json', Buffer.from(JSON.stringify({ payload: state, mac: signature(key, state) })));
}
export async function load(root, key, id) {
  if (!/^ath-[a-f0-9]{40}$/.test(id)) throw Error('Invalid workspace identity');
  const dir = await lstat(join(root, id));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw Error('Unsafe workspace state directory');
  const wrapper = JSON.parse((await safeRead(join(root, id, 'metadata.json'), 2097152, true)).toString());
  const expected = signature(key, wrapper.payload);
  if (typeof wrapper.mac !== 'string' || wrapper.mac.length !== 64 || !timingSafeEqual(Buffer.from(wrapper.mac), Buffer.from(expected))) throw Error('Workspace metadata ownership signature mismatch');
  const state = wrapper.payload;
  if (state.id !== id || workspaceId(state) !== id || state.authority !== authority(key, id)) throw Error('Workspace identity mismatch');
  return state;
}
export async function withWorkspace(workspace, fn) {
  exact(workspace, ['root', 'id', 'owner', 'runId', 'attempt']);
  workspace = { ...workspace };
  if (workspace.id !== workspaceId(workspace)) throw Error('Workspace ownership identity mismatch');
  const root = await secureRoot(workspace.root);
  const key = await safeRead(join(root, '.ownership-key'), 32);
  // Validate the private directory before opening its lock. Admission alone uses
  // the root lock; a slow operation cannot serialize unrelated workspaces.
  await load(root, key, workspace.id);
  return withLock(join(root, workspace.id, '.lock'), async () => {
    const state = await load(root, key, workspace.id);
    if (state.owner !== workspace.owner || state.runId !== workspace.runId || state.attempt !== workspace.attempt) throw Error('Workspace ownership mismatch');
    return fn(state, () => save(root, key, state), root, key);
  });
}
export async function records(root) {
  const files = await readdir(root);
  if (files.length > MAX_WORKSPACES * 2 + 8) throw Error('State directory capacity exceeded');
  return files.filter(name => /^ath-[a-f0-9]{40}$/.test(name));
}
export async function cleanTemps(root) {
  for (const entry of await readdir(root)) if (/^\.tmp-[0-9]+-[a-f0-9]{16}$/.test(entry)) await rm(join(root, entry));
}
/** Called only under admission serialization after metadata was found absent.
 * Unlike established-workspace cleanup, every entry must be a private regular
 * interrupted-write file; validate the whole reservation before deleting any. */
export async function cleanReservationTemps(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Unsafe reservation directory');
    const pinned = `/proc/self/fd/${handle.fd}`;
    try { await lstat(join(pinned, 'metadata.json')); throw Error('Unexpected reservation metadata'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const names = [];
    const entries = await opendir(pinned);
    for await (const entry of entries) {
      if (names.length >= MAX_WORKSPACES * 2 + 8 || !/^\.tmp-[0-9]+-[a-f0-9]{16}$/.test(entry.name)) throw Error('Unexpected reservation entry or capacity');
      const file = await lstat(join(pinned, entry.name));
      if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid() || (file.mode & 0o077) || file.size > 2097152) throw Error('Unsafe reservation temporary file');
      names.push(entry.name);
    }
    for (const name of names) await rm(join(pinned, name));
  } finally { await handle.close(); }
}
export async function processIdentity(pid) {
  try { const value = await readFile(`/proc/${pid}/stat`, 'utf8'); const fields = value.slice(value.lastIndexOf(')') + 2).split(' '); return fields[0] === 'Z' ? null : fields[19]; } catch { return null; }
}
export async function watchdogAlive(state) { return Boolean(state.watchdog && await processIdentity(state.watchdog.pid) === state.watchdog.start); }
