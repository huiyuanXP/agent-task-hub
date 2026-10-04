/** Owns setup uncertainty before Docker mutations; never starts or recreates resources. */
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { load, safeRead, processIdentity, reference } from './state.mjs';
import { cleanupWorkspace } from './workspaces.mjs';
export async function guard(root, id) {
  const activation = new Promise(resolve => { process.once('message', resolve); process.once('disconnect', resolve); });
  const key = await safeRead(join(root, '.ownership-key'), 32), started = await processIdentity(process.pid);
  if (process.connected) process.send({ phase: 'ready', pid: process.pid, start: started });
  if (process.connected) await activation;
  let state = await load(root, key, id);
  if (state.guardian?.pid !== process.pid || state.guardian.start !== started) return;
  const due = performance.now() + Math.max(0, Math.min(state.policy.ceilings.timeoutMs, state.deadlineMs - Date.now()));
  if (process.connected) process.send({ phase: 'armed', pid: process.pid, start: started });
  const ref = reference(root, state); let delay = 250;
  while (true) {
    try { state = await load(root, key, id); } catch (error) {
      if (error.code === 'ENOENT') return;
      await new Promise(resolve => setTimeout(resolve, delay)); continue;
    }
    if (state.state === 'removed') return;
    if (state.state === 'removal_pending' || Date.now() >= state.deadlineMs || performance.now() >= due) {
      try { if ((await cleanupWorkspace(ref))?.state === 'removed') return; } catch { /* Retain owned cleanup obligation. */ }
      delay = Math.min(2000, delay * 2);
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) guard(process.argv[2], process.argv[3]).catch(() => { process.exitCode = 1; });
