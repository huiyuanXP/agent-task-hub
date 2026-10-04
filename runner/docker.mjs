import http from 'node:http';
import { IMAGE, PROXY_KEYS } from './policy.mjs';
const SOCKET = '/var/run/docker.sock';
let apiPromise;
async function apiPrefix() {
  apiPromise ??= (async () => {
    const version = await rawRequest('GET', '/version');
    const number = value => { const parts = String(value).split('.').map(Number); return parts[0] * 100 + parts[1]; };
    const chosen = Math.min(151, number(version.ApiVersion));
    if (!Number.isFinite(chosen) || chosen < 141 || number(version.MinAPIVersion ?? '1.24') > chosen) throw Error('Unsupported local Docker API; require compatible API 1.41 through 1.51');
    return `/v${Math.floor(chosen / 100)}.${chosen % 100}`;
  })();
  try { return await apiPromise; } catch (error) { apiPromise = undefined; throw error; }
}
export async function request(method, path, options) { return rawRequest(method, (await apiPrefix()) + path, options); }
/** Explicit local daemon only: never reads Docker CLI configuration or environment. */
function rawRequest(method, path, { body, timeoutMs = 5000, maxBytes = 1048576, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath: SOCKET, path, method, headers: { Connection: 'close', ...(data ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json', 'Content-Length': data.length } : {}) } });
    const timer = setTimeout(() => req.destroy(Error('Docker request deadline exceeded')), Math.max(1, timeoutMs));
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.on('response', res => {
      res.on('close', () => clearTimeout(timer));
      if (stream && res.statusCode < 300) { resolve(res); return; }
      const chunks = []; let size = 0;
      res.on('error', reject);
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) res.destroy(Error('Docker response byte limit')); else chunks.push(chunk); });
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (res.statusCode >= 300) { const error = Error(`Docker HTTP ${res.statusCode} for ${method} ${path.split('?')[0]}`); error.statusCode = res.statusCode; reject(error); }
        else if (!bytes.length) resolve(null);
        else { try { resolve(JSON.parse(bytes.toString())); } catch { resolve(bytes); } }
      });
    });
    req.end(data);
  });
}
export async function inspectContainer(id) {
  try { return await request('GET', `/containers/${encodeURIComponent(id)}/json`); } catch (e) { if (e.statusCode === 404) return null; throw e; }
}
export async function inspectVolume(id) {
  try { return await request('GET', `/volumes/${encodeURIComponent(id)}`); } catch (e) { if (e.statusCode === 404) return null; throw e; }
}
export function labels(state) { return { 'ath.workspace': state.id, 'ath.authority': state.authority }; }
export function assertOwned(object, state) {
  const found = object.Config?.Labels ?? object.Labels;
  if (Object.entries(labels(state)).some(([key, value]) => found?.[key] !== value)) throw Error('Foreign resource ownership mismatch');
}
export function containerConfig(state, importing = false) {
  const p = state.policy;
  return { Image: IMAGE, User: '1000:1000', WorkingDir: '/job', Entrypoint: ['node'], Cmd: ['-e', 'setInterval(()=>{},1000)'], Env: PROXY_KEYS.map(key => `${key}=`), Labels: labels(state), NetworkDisabled: true,
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: p.ceilings.memoryMb * 1048576, MemorySwap: p.ceilings.memoryMb * 1048576, NanoCpus: Math.floor(p.ceilings.cpus * 1e9), PidsLimit: p.ceilings.pids, ShmSize: 8 * 1048576, LogConfig: { Type: 'none' }, RestartPolicy: { Name: 'no' },
      Mounts: [{ Type: 'volume', Source: state.volumeName, Target: '/job/input', ReadOnly: !importing, VolumeOptions: { NoCopy: true } }],
      Tmpfs: { '/job/output': `rw,noexec,nosuid,nodev,size=${p.workTmpfsMb}m,uid=1000,gid=1000,mode=0700`, '/tmp': 'rw,noexec,nosuid,nodev,size=8m,uid=1000,gid=1000,mode=0700' } } };
}
export async function verifyEnvironment(id) {
  const inspected = await inspectContainer(id);
  if (!inspected) throw Error('Container disappeared before environment inspection');
  // Only the pinned image defaults and explicitly empty proxy names are allowed.
  const allowed = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', ...PROXY_KEYS]);
  const env = inspected.Config.Env ?? [];
  if (env.some(value => !allowed.has(value.split('=')[0])) || PROXY_KEYS.some(key => env.filter(value => value.startsWith(key + '=')).length !== 1 || !env.includes(key + '='))) throw Error('Unexpected container environment authority');
}
export async function removeContainer(id, state) {
  const found = await inspectContainer(id);
  if (!found) return;
  assertOwned(found, state);
  try { await request('DELETE', `/containers/${id}?force=1&v=1`); } catch (e) { if (e.statusCode !== 404) throw e; }
  if (await inspectContainer(id)) throw Error('Container removal not confirmed');
}
export async function removeVolume(name, state) {
  const found = await inspectVolume(name);
  if (!found) return;
  assertOwned(found, state);
  try { await request('DELETE', `/volumes/${name}`); } catch (e) { if (e.statusCode !== 404) throw e; }
  if (await inspectVolume(name)) throw Error('Volume removal not confirmed');
}
/** Raw daemon exec identity is suitable for durable Task4 journaling before start. */
export async function createExec(containerId, argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 32 || argv.some(value => typeof value !== 'string' || value.includes('\0')) || Buffer.byteLength(JSON.stringify(argv)) > 65536) throw Error('Invalid fixed argv');
  return request('POST', `/containers/${containerId}/exec`, { body: { AttachStdout: true, AttachStderr: true, Tty: false, User: '1000:1000', WorkingDir: '/job', Cmd: argv } });
}
export function inspectExec(id) { return request('GET', `/exec/${id}/json`); }
export async function startExec(id, { timeoutMs, maxLogBytes }) {
  const stream = await request('POST', `/exec/${id}/start`, { body: { Detach: false, Tty: false }, stream: true, timeoutMs });
  const chunks = [[], []], sizes = [0, 0], totals = [0, 0];
  let pending = Buffer.alloc(0), remaining = 0, channel = 0;
  const snapshot = () => ({ stdout: Buffer.concat(chunks[0]), stderr: Buffer.concat(chunks[1]), stdoutTruncated: totals[0] > maxLogBytes, stderrTruncated: totals[1] > maxLogBytes });
  try {
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length) {
      if (!remaining) {
        if (pending.length < 8) break;
        if (![1, 2].includes(pending[0]) || pending[1] || pending[2] || pending[3]) { stream.destroy(); throw Error('Invalid Docker stream frame'); }
        channel = pending[0] - 1; remaining = pending.readUInt32BE(4); pending = pending.subarray(8);
        if (remaining > 16777216) { stream.destroy(); throw Error('Docker frame exceeds bound'); }
        if (!remaining) continue;
      }
      const count = Math.min(remaining, pending.length);
      const keep = Math.min(count, maxLogBytes - sizes[channel]);
      if (keep) { chunks[channel].push(Buffer.from(pending.subarray(0, keep))); sizes[channel] += keep; }
      totals[channel] += count; remaining -= count; pending = pending.subarray(count);
    }
  }
  if (pending.length || remaining) throw Error('Truncated Docker stream');
  const inspected = await inspectExec(id);
  if (inspected.Running || !Number.isInteger(inspected.ExitCode)) throw Error('Docker exec exit is unavailable');
  return { exitCode: inspected.ExitCode, ...snapshot() };
  } catch (error) { error.output = snapshot(); throw error; }
}
