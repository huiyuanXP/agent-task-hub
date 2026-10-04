import { mkdtemp, readdir, lstat, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const inputs = [
  'app', 'build', 'components', 'db', 'drizzle', 'hooks', 'lib', 'public', 'scripts', 'tests',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'next.config.ts',
  'postcss.config.mjs', 'eslint.config.mjs', 'drizzle.config.ts', 'components.json',
  'cloudflare-env.d.ts', '.env.example', '.openai/hosting.json',
];
function excluded(name) {
  return ['node_modules', 'dist', '.git', '.wrangler', '.sites-runtime', '.next', '.vinext', 'test-results'].includes(name)
    || (name.startsWith('.env') && name !== '.env.example')
    || name.startsWith('.dev.vars')
    || /\.(?:sqlite|sqlite3|db)(?:-(?:shm|wal|journal))?$/.test(name)
    || name.endsWith('.tsbuildinfo');
}

async function copyInput(source, target) {
  if (excluded(basename(source))) return;
  const info = await lstat(source);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) await copyInput(join(source, name), join(target, name));
  } else if (info.isFile()) {
    await mkdir(join(target, '..'), { recursive: true });
    await copyFile(source, target);
  } else throw new Error(`Unsupported application input: ${source}`);
}

export async function createWorkspace(sourceRoot) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-task-hub-test-'));
  try {
    for (const input of inputs) {
      const source = join(sourceRoot, input);
      // Only an absent optional top-level input is skipped; nested copy errors fail.
      try {
        if (dirname(input) !== '.' && (await lstat(join(sourceRoot, dirname(input)))).isSymbolicLink()) continue;
        await lstat(source);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      await copyInput(source, join(workspace, input));
    }
    return workspace;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

export function loopbackUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value
      || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/.test(value)) {
    throw new Error('Expected an HTTP loopback origin');
  }
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port === '0') {
    throw new Error(`Expected an HTTP loopback origin: ${value}`);
  }
  return url;
}

export async function freePort() {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

export function startChild(command, args, { cwd, env = process.env, logFile } = {}) {
  const fd = logFile ? openSync(logFile, 'a') : undefined;
  let child;
  try {
    child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd ?? 'inherit', fd ?? 'inherit'] });
  } finally { if (fd !== undefined) closeSync(fd); }
  const record = { child, result: null, command: `${command} ${args.join(' ')}` };
  record.done = new Promise(resolve => {
    child.once('error', error => { record.result = { error }; resolve(record.result); });
    child.once('close', (code, signal) => { record.result = { code, signal }; resolve(record.result); });
  });
  return record;
}

function exitError(record) {
  return record.result.error ?? new Error(`${record.command}: exit ${record.result.code} (${record.result.signal ?? 'no signal'})`);
}

function signalGroup(record, signal) {
  if (!record.child.pid) return;
  try { process.kill(-record.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function stopChild(record) {
  if (record.stopping) return record.stopping;
  record.stopping = (async () => {
    signalGroup(record, 'SIGTERM');
    const timeout = new AbortController();
    try {
      await Promise.race([record.done, delay(3000, undefined, { signal: timeout.signal })]);
    } finally { timeout.abort(); }
    // The parent may exit before a descendant; always signal the whole group.
    signalGroup(record, 'SIGKILL');
    await record.done;
  })();
  return record.stopping;
}

export async function runChild(command, args, options = {}) {
  options.signal?.throwIfAborted();
  const record = startChild(command, args, options);
  const abort = () => { void stopChild(record); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await record.done;
    options.signal?.throwIfAborted();
    if (result.error || result.code !== 0 || result.signal) throw exitError(record);
    return result;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await stopChild(record);
  }
}

export async function waitForHttp(value, children, { timeoutMs = 90000, signal } = {}) {
  const url = loopbackUrl(value);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    for (const child of children) if (child.result) throw exitError(child);
    try {
      const requestSignal = AbortSignal.timeout(Math.max(1, Math.min(1500, deadline - Date.now())));
      const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, requestSignal]) : requestSignal });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { signal?.throwIfAborted(); }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${url.origin}`);
}
