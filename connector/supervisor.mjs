// The durable journal identifies this process group before the daemon delivers a prompt.
// This supervisor outlives an abruptly killed daemon long enough to stop its model group.
import { spawn } from 'node:child_process';
import { processIdentity } from './runner.mjs';

const [ownerPid, ownerIdentity, deadlineValue, executable, ...args] = process.argv.slice(2);
const deadline = Number(deadlineValue);
const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let stopping = false, forceTimer, checking = false;
function stop(message) {
  if (stopping) return;
  stopping = true;
  process.stderr.write(`Managed Codex supervisor: ${message}\n`);
  try { process.kill(process.platform === 'win32' ? child.pid : -process.pid, 'SIGTERM'); } catch { /* Process may already have exited. */ }
  forceTimer = setTimeout(() => {
    try { process.kill(process.platform === 'win32' ? child.pid : -process.pid, 'SIGKILL'); } catch { process.exit(1); }
  }, 1000);
}
process.on('SIGTERM', () => stop('termination requested'));
process.on('SIGINT', () => stop('interruption requested'));
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
const watch = setInterval(async () => {
  if (checking || stopping) return;
  checking = true;
  try {
    if (Date.now() >= deadline) stop('finite execution deadline reached');
    else if (await processIdentity(Number(ownerPid)) !== ownerIdentity) stop('owning daemon exited');
  } catch { stop('owning daemon identity unavailable'); }
  finally { checking = false; }
}, 250);
child.once('error', error => { process.stderr.write(`Codex launch failed: ${error.code || 'unknown error'}\n`); clearInterval(watch); process.exitCode = 1; process.stdin.destroy(); });
child.once('close', code => {
  clearInterval(watch);
  if (stopping) return; // Keep the one-second group SIGKILL timer alive for descendants.
  clearTimeout(forceTimer);
  process.exit(code ?? 1);
});
