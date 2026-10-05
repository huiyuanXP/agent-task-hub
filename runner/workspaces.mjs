import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IMAGE, normalizePolicy } from './policy.mjs';
import * as disk from './state.mjs';
import * as docker from './docker.mjs';
import { snapshotInputs } from './inputs.mjs';
import { packInputs } from './archive.mjs';
import { artifactDeclarations, scanArtifacts } from './artifacts.mjs';
import { pinFrozenOutput, verifyOutputAccess } from './container-files.mjs';

export async function createWorkspace(root, run, requestedPolicy = {}, registeredImage = IMAGE) {
  if (typeof registeredImage !== 'string' || !/^node@sha256:[a-f0-9]{64}$/.test(registeredImage)) throw Error('Pinned registered image required');
  const policy = normalizePolicy(requestedPolicy), owner = disk.identity(run), id = disk.workspaceId(owner);
  const requestedDeadline = run.deadlineMs;
  return disk.withRoot(root, async (root, key) => {
    const names = await disk.records(root);
    if (names.includes(id)) {
      const existing = await disk.load(root, key, id);
      if (JSON.stringify(existing.policy) !== JSON.stringify(policy) || existing.requestedDeadline !== (requestedDeadline ?? null) || (existing.image ?? IMAGE) !== registeredImage) throw Error('Workspace identity policy conflict');
      return disk.reference(root, existing);
    }
    if (names.length >= disk.MAX_WORKSPACES) throw Error('Workspace retention capacity exhausted');
    const states = await Promise.all(names.map(name => disk.load(root, key, name)));
    if (states.filter(state => state.state !== 'removed').length >= disk.MAX_ACTIVE) throw Error('Active workspace capacity exhausted');
    const state = { version: 1, image: registeredImage, ...owner, id, authority: disk.authority(key, id), policy, state: 'created', volumeName: id + '-input', containerName: id, importerName: id + '-import', containerId: null, importerId: null, watchdog: null, guardian: null, execution: null, creates: { volume: 'none', importer: 'none', container: 'none' },
      createdAt: Date.now(), requestedDeadline: requestedDeadline ?? null, deadlineMs: Math.min(requestedDeadline ?? Infinity, Date.now() + policy.ceilings.timeoutMs) };
    await mkdir(join(root, id), { mode: 0o700 });
    await disk.syncDirectory(root);
    await disk.save(root, key, state); // Before any Docker resource can exist.
    return disk.reference(root, state);
  });
}
export function inspectWorkspace(workspace) { return disk.withWorkspace(workspace, state => structuredClone(state)); }
function remaining(state) {
  const value = state.deadlineMs - Date.now();
  if (value <= 0) throw Error('Workspace deadline exceeded');
  return Math.min(value, state.policy.ceilings.timeoutMs);
}
async function ensureLive(state) {
  remaining(state);
  if (!await disk.watchdogAlive(state)) throw Error('Owned watchdog is absent; recovery cleanup required');
  const container = await docker.inspectContainer(state.containerId);
  if (!container) throw Error('Owned container removed');
  docker.assertOwned(container, state);
  return container;
}
export function importInputs(workspace, sourceRoot, paths) {
  paths = structuredClone(paths);
  return disk.withWorkspace(workspace, async (state, save) => {
    if (state.state !== 'created') throw Error('Inputs already sealed or workspace state is final');
    remaining(state);
    const files = await snapshotInputs(sourceRoot, paths, state.policy);
    await ensureGuardian(workspace, state, save);
    const archive = packInputs(files);
    state.state = 'importing';
    const volume = await createResource(state, save, 'volume', () => docker.request('POST', '/volumes/create', { body: { Name: state.volumeName, Labels: docker.labels(state) }, timeoutMs: remaining(state) }));
    docker.assertOwned(volume, state);
    const existing = await docker.inspectContainer(state.importerName);
    if (existing) throw Error('Unexpected existing importer identity');
    const created = await createResource(state, save, 'importer', () => docker.request('POST', `/containers/create?name=${state.importerName}`, { body: docker.containerConfig(state, true), timeoutMs: remaining(state) }));
    await docker.request('PUT', `/containers/${created.Id}/archive?path=%2Fjob%2Finput&noOverwriteDirNonDir=1`, { body: archive, timeoutMs: remaining(state) });
    await docker.removeContainer(created.Id, state);
    state.importerId = null; state.state = 'ready'; state.inputs = paths.map(item => ({ ...item })); await save();
  });
}
async function ensureGuardian(workspace, state, save) {
  if (state.guardian && await disk.processIdentity(state.guardian.pid) === state.guardian.start) return;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./guardian.mjs', import.meta.url)), workspace.root, state.id], { detached: true, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  function message(phase) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Setup guardian arming timeout')), 3000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(Error('Setup guardian exited before acknowledgement')); });
      child.once('message', value => { clearTimeout(timer); if (value.phase !== phase || value.pid !== child.pid || !value.start) reject(Error('Invalid guardian identity')); else resolve(value); });
    });
  }
  try {
    const ready = await message('ready');
    state.guardian = { pid: ready.pid, start: ready.start }; await save();
    const armed = message('armed'); child.send({ arm: true }); await armed;
  } finally { if (child.connected) child.disconnect(); child.unref(); }

}
async function createResource(state, save, kind, request) {
  remaining(state);
  state.creates[kind] = 'intent'; await save();
  let result;
  try { result = await request(); } catch (error) {
    // A received client-error response proves this request did not create an object.
    // Transport loss/server errors do not: leave the durable intent for reconciliation.
    if (error.statusCode >= 400 && error.statusCode < 500) { state.creates[kind] = 'failed'; await save(); }
    throw error;
  }
  if (kind !== 'volume') state[kind + 'Id'] = result.Id;
  state.creates[kind] = 'observed'; await save();
  return result;
}
async function arm(workspace, state) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./watchdog.mjs', import.meta.url)), workspace.root, state.id], { detached: true, env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const acknowledgement = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Watchdog arming timeout')), Math.min(3000, remaining(state)));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Watchdog exited before acknowledgement')); });
    child.once('message', message => { clearTimeout(timer); resolve(message); });
  });
  if (acknowledgement.id !== state.containerId || acknowledgement.pid !== child.pid || !acknowledgement.start) throw Error('Invalid watchdog acknowledgement');
  child.disconnect(); child.unref();
  return { pid: child.pid, start: acknowledgement.start };
}
export function startWorkspace(workspace) {
  return disk.withWorkspace(workspace, async (state, save) => {
    if (state.state !== 'ready') throw Error('Workspace state cannot start or is finalized');
    remaining(state);
    if (!state.guardian || await disk.processIdentity(state.guardian.pid) !== state.guardian.start) throw Error('Setup guardian absent; recover instead of starting');
    state.state = 'creating'; await save();
    const created = await createResource(state, save, 'container', () => docker.request('POST', `/containers/create?name=${state.containerName}`, { body: docker.containerConfig(state), timeoutMs: remaining(state) }));
    state.state = 'container_created'; await save();
    remaining(state);
    await docker.verifyEnvironment(created.Id);
    state.watchdog = await arm(workspace, state); state.state = 'watchdog_armed'; await save();
    await ensureLive(state);
    state.state = 'start_intent'; await save();
    await docker.request('POST', `/containers/${state.containerId}/start`, { timeoutMs: remaining(state) });
    state.processIdentity = await verifyOutputAccess(state);
    remaining(state); state.state = 'running'; await save();
    return { containerId: state.containerId, deadlineMs: state.deadlineMs };
  });
}
export function createExecution(workspace, argv) {
  argv = structuredClone(argv);
  return disk.withWorkspace(workspace, async (state, save) => {
    if (state.state !== 'running' || state.execution) throw Error('Workspace execution is already reserved or unavailable');
    await ensureLive(state);
    state.execution = { id: null, phase: 'create_intent' }; await save();
    const created = await docker.createExec(state.containerId, argv);
    state.execution = { id: created.Id, phase: 'created' }; await save();
    return { id: created.Id };
  });
}
export async function startExecution(workspace, execId, onStarted) {
  const limits = await disk.withWorkspace(workspace, async (state, save) => {
    if (state.state !== 'running' || state.execution?.id !== execId || state.execution.phase !== 'created') throw Error('Execution identity or start state mismatch');
    await ensureLive(state);
    const inspected = await docker.inspectExec(execId);
    if (inspected.ContainerID !== state.containerId || inspected.Running) throw Error('Foreign execution identity');
    state.execution.phase = 'start_intent'; await save();
    return { timeoutMs: remaining(state), maxLogBytes: state.policy.maxLogBytes };
  });
  let result;
  try { result = await docker.startExec(execId, { ...limits, onStarted: async at => {
    await disk.withWorkspace(workspace, async (state, save) => { state.execution.startedAt = at; await save(); });
    if (onStarted) await onStarted(at);
  } }); } catch (error) { return retainInterruptedExecution(workspace, error); }
  try { await disk.withWorkspace(workspace, async (state, save, root) => {
    remaining(state);
    if (state.state !== 'running') throw Error('Container removed before authoritative exit retention');
    await disk.atomicWrite(join(root, state.id), 'stdout.log', result.stdout);
    await disk.atomicWrite(join(root, state.id), 'stderr.log', result.stderr);
    state.execution = { ...state.execution, phase: 'exited', exitCode: result.exitCode, stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated }; await save();
  }); } catch (error) {
    // Cleanup/deadline can win after the daemon returns actual bytes. Preserve
    // those bounded streams without accepting an authoritative exit or success.
    error.output = result; return retainInterruptedExecution(workspace, error);
  }
  return result;
}
async function retainInterruptedExecution(workspace, error) {
  await disk.withWorkspace(workspace, async (state, save, root) => {
    if (error.output) {
      await disk.atomicWrite(join(root, state.id), 'stdout.log', error.output.stdout);
      await disk.atomicWrite(join(root, state.id), 'stderr.log', error.output.stderr);
    }
    state.execution = { ...state.execution, phase: 'unavailable', reason: 'Execution interrupted before trusted exit retention' }; await save();
  });
  throw error;
}
export async function captureArtifacts(workspace, declarations) {
  declarations = structuredClone(declarations);
  const state = await disk.withWorkspace(workspace, async (state, save) => {
    artifactDeclarations(declarations, state.policy);
    if (state.state !== 'running' || state.execution?.phase !== 'exited') throw Error('Execution not ready to freeze');
    await ensureLive(state);
    state.state = 'freezing'; await save();
    await docker.request('POST', `/containers/${state.containerId}/pause`, { timeoutMs: remaining(state) });
    const container = await docker.inspectContainer(state.containerId);
    if (!container?.State.Paused) throw Error('Container freeze not confirmed');
    state.state = 'frozen'; await save();
    return structuredClone(state);
  });
  const pinned = await pinFrozenOutput(state);
  try {
    const artifacts = await scanArtifacts(pinned.output, declarations, state.policy, state.deadlineMs);
    await pinned.verify();
    await disk.withWorkspace(workspace, async (current, save, root) => {
      await ensureLive(current);
      await pinned.verify();
      if (current.state !== 'frozen') throw Error('Frozen evidence unavailable after cleanup');
      const retained = artifacts.map(item => ({ path: item.path, sha256: item.sha256, bytes: item.bytes.toString('base64') }));
      remaining(current);
      await disk.atomicWrite(join(root, state.id), 'artifacts.json', Buffer.from(JSON.stringify(retained)));
      remaining(current);
      current.artifacts = artifacts.map(item => ({ path: item.path, sha256: item.sha256, bytes: item.bytes.length })); await save();
    });
    return artifacts;
  } finally { await pinned.close(); }
}
/** No unpause: force removal is the only cleanup transition for frozen work. */
export async function cleanupWorkspace(workspace) {
  let cleanupProcesses = [];
  const result = await disk.withWorkspace(workspace, async (state, save) => {
    cleanupProcesses = [state.guardian, state.watchdog].filter(Boolean);
    if (state.state === 'removed') return { state: 'removed' };
    state.state = 'removal_pending'; await save();
    if (Object.values(state.creates).includes('intent')) await ensureGuardian(workspace, state, save);
    // One 404 cannot fence a create request whose response was lost.
    let pending = false;
    for (const kind of ['container', 'importer']) {
      const found = await docker.inspectContainer(state[kind + 'Id'] ?? state[kind + 'Name']);
      if (found) {
        docker.assertOwned(found, state);
        state[kind + 'Id'] = found.Id; state.creates[kind] = 'observed'; await save();
        await docker.removeContainer(found.Id, state);
      } else if (state.creates[kind] === 'intent') pending = true;
    }
    const volume = await docker.inspectVolume(state.volumeName);
    if (volume) { docker.assertOwned(volume, state); state.creates.volume = 'observed'; await save(); }
    else if (state.creates.volume === 'intent') pending = true;
    if (pending) { await save(); return { state: 'removal_pending' }; }
    // Do not delete a volume while an unresolved container create could auto-recreate it.
    await docker.removeVolume(state.volumeName, state);
    state.state = 'removed'; state.removedAt = Date.now(); await save(); return { state: 'removed' };
  });
  // Release flock before awaiting observers, and never make a guardian wait on itself.
  if (result.state === 'removed' && !cleanupProcesses.some(item => item.pid === process.pid)) {
    const until = Date.now() + 5000;
    for (const item of cleanupProcesses) {
      while (await disk.processIdentity(item.pid) === item.start) {
        if (Date.now() >= until) throw Error('Owned cleanup process has not observed removal yet');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  return result;
}
export function recoverWorkspaces(root) {
  return disk.withRoot(root, async (root, key) => {
    const states = [];
    await disk.cleanTemps(root);
    for (const id of await disk.records(root)) {
      try { states.push(await disk.load(root, key, id)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // No Docker mutation precedes initial metadata. Admission serialization
        // excludes its writer; established-workspace temps stay under their lock.
        await disk.cleanReservationTemps(join(root, id));
        await rmdir(join(root, id)); await disk.syncDirectory(root);
      }
    }
    return states.map(state => disk.reference(root, state));
  }).then(async refs => {
    for (const ref of refs) {
      await disk.withWorkspace(ref, (_, __, root) => disk.cleanTemps(join(root, ref.id)));
      await cleanupWorkspace(ref);
    }
    return Promise.all(refs.map(ref => inspectWorkspace(ref)));
  });
}
