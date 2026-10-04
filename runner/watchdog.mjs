/** Independent process owns the concrete container until confirmed removal. */
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { load, safeRead, processIdentity, reference } from './state.mjs';
import { inspectContainer, assertOwned } from './docker.mjs';
import { cleanupWorkspace } from './workspaces.mjs';
export async function watch(root, id) {
  const key = await safeRead(join(root, '.ownership-key'), 32);
  const state = await load(root, key, id);
  if (state.state !== 'container_created' || !state.containerId) throw Error('Watchdog requires persisted concrete container identity');
  const container = await inspectContainer(state.containerId);
  if (!container || container.State.Running) throw Error('Watchdog must arm before start');
  assertOwned(container, state);
  const duration = Math.max(0, Math.min(state.policy.ceilings.timeoutMs, state.deadlineMs - Date.now()));
  const due = performance.now() + duration, ref = reference(root, state);
  process.send?.({ id: state.containerId, pid: process.pid, start: await processIdentity(process.pid) });
  while (true) {
    if (Date.now() >= state.deadlineMs || performance.now() >= due) {
      try { await cleanupWorkspace(ref); return; } catch { /* Retain responsibility until Docker confirms removal. */ }
    } else {
      try { if ((await load(root, key, id)).state === 'removed') return; } catch {
        // A removed state root is never recreated by observation.
        if (!await inspectContainer(state.containerId)) return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) watch(process.argv[2], process.argv[3]).catch(() => { process.exitCode = 1; });
