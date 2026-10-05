import { constants } from 'node:fs';
import { open, readFile, readlink, statfs } from 'node:fs/promises';
import { inspectContainer, assertOwned } from './docker.mjs';
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export function fdPath(handle) { return `/proc/self/fd/${handle.fd}`; }
export async function mountId(handle) {
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
  const match = /^mnt_id:\s*(\d+)$/m.exec(info);
  if (!match) throw Error('Unsupported topology: mount identity unavailable');
  return match[1];
}
export async function requireTmpfs(handle) {
  if ((await statfs(fdPath(handle))).type !== 0x01021994) throw Error('Output filesystem is not bounded tmpfs');
  return mountId(handle);
}
async function processState(proc, containerId) {
  const path = fdPath(proc);
  const [stat, cgroup, mountNamespace, pidNamespace] = await Promise.all([
    readFile(path + '/stat', 'utf8'), readFile(path + '/cgroup', 'utf8'), readlink(path + '/ns/mnt'), readlink(path + '/ns/pid'),
  ]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (fields[0] === 'Z' || !fields[19]) throw Error('Container process identity expired');
  if (!cgroup.split('\n').some(line => line.split(':').slice(2).join(':').split('/').some(part => part === containerId || part === `docker-${containerId}.scope`))) throw Error('Unsupported topology: process cgroup does not identify owned container');
  if (mountNamespace === await readlink('/proc/self/ns/mnt') || pidNamespace === await readlink('/proc/self/ns/pid')) throw Error('Host process namespace sharing is forbidden');
  if (!/^mnt:\[\d+\]$/.test(mountNamespace) || !/^pid:\[\d+\]$/.test(pidNamespace)) throw Error('Unsupported process namespace identity');
  return JSON.stringify({ start: fields[19], cgroup, mountNamespace, pidNamespace });
}
async function checkedContainer(state, previous, frozen) {
  const container = await inspectContainer(state.containerId);
  if (!container) throw Error('Container removed during artifact capture');
  assertOwned(container, state);
  if (container.Id !== state.containerId || !container.State.Running || container.State.Restarting || (frozen && !container.State.Paused) || !Number.isSafeInteger(container.State.Pid) || container.State.Pid <= 0) throw Error('Owned container is not frozen');
  const host = container.HostConfig;
  if (host.NetworkMode !== 'none' || host.PidMode || host.IpcMode !== 'private' || host.RestartPolicy?.Name !== 'no' || !host.ReadonlyRootfs || container.Config.User !== '1000:1000') throw Error('Unsupported container isolation topology');
  if (previous && (container.State.Pid !== previous.State.Pid || container.State.StartedAt !== previous.State.StartedAt)) throw Error('Container process identity changed');
  return container;
}
/** Pin proc directory before following its trusted root magic-link. Never reopen numeric PID paths. */
async function pinOutput(state, frozen) {
  const before = await checkedContainer(state, undefined, frozen), handles = [];
  try {
    const proc = await open(`/proc/${before.State.Pid}`, DIR); handles.push(proc);
    const identity = await processState(proc, state.containerId);
    const root = await open(fdPath(proc) + '/root', constants.O_RDONLY | constants.O_DIRECTORY); handles.push(root);
    const job = await open(fdPath(root) + '/job', DIR); handles.push(job);
    const output = await open(fdPath(job) + '/output', DIR); handles.push(output);
    const outputMount = await requireTmpfs(output);
    await verifyMount(proc, outputMount);
    if (state.processIdentity && state.processIdentity !== identity) throw Error('Started process identity mismatch');
    if (identity !== await processState(proc, state.containerId)) throw Error('Container identity changed while pinning output');
    await checkedContainer(state, before, frozen);
    return {
      output, identity,
      async verify() {
        if (identity !== await processState(proc, state.containerId) || outputMount !== await mountId(output)) throw Error('Pinned output identity changed');
        await verifyMount(proc, outputMount);
        await checkedContainer(state, before, frozen);
      },
      async close() { await Promise.all(handles.map(handle => handle.close())); },
    };
  } catch (error) { await Promise.all(handles.map(handle => handle.close())); throw error; }
}

export function pinFrozenOutput(state) { return pinOutput(state, true); }
/** Before any user operation: establish supported host/proc topology using only the inert keeper. */
export async function verifyOutputAccess(state) {
  const pinned = await pinOutput(state, false);
  try { await pinned.verify(); return pinned.identity; } finally { await pinned.close(); }
}
function unescapeMount(value) {
  if (/\\(?!040|011|012|134)/.test(value)) throw Error('Unsupported mountinfo escaping');
  return value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}
async function verifyMount(proc, mount) {
  validateMountInfo(await readFile(fdPath(proc) + '/mountinfo', 'utf8'), mount);
}
export function validateMountInfo(value, mount) {
  const lines = value.trim().split('\n');
  if (lines.length > 256) throw Error('Unsupported container mount count');
  let found = false;
  for (const line of lines) {
    const parts = line.split(' '), separator = parts.indexOf('-');
    if (separator < 6) throw Error('Invalid mountinfo');
    const root = unescapeMount(parts[3]), point = unescapeMount(parts[4]);
    if (point.startsWith('/job/output/')) throw Error('Nested output mount is forbidden');
    if (point === '/job/output') {
      if (found || parts[0] !== mount || root !== '/' || parts[separator + 1] !== 'tmpfs') throw Error('Output mount identity mismatch');
      found = true;
    }
  }
  if (!found) throw Error('Output tmpfs mount is unavailable');
}
