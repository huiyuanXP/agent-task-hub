import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openConsumerState, readLocalApiToken } from '../../../runner/consumer-state.mjs';

const [mode, root, endpoint, runId] = process.argv.slice(2);
const send = value => { if (process.send) process.send(value); };
if (mode === 'token-fd' || mode === 'token-file') {
  try {
    const token = await readLocalApiToken(mode === 'token-fd' ? { tokenFd: Number(root ?? 3) } : { tokenFile: root });
    process.stdout.write(JSON.stringify({ ok: true, digest: createHash('sha256').update(token).digest('hex') }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code }) + '\n');
    process.exitCode = 2;
  }
} else {
  try {
    const journal = await openConsumerState({ root, endpoint, runId, initialData: { count: 0 } });
    if (mode === 'before-rename' || mode === 'after-rename') {
      const rename = fs.rename;
      fs.rename = async (...args) => {
        if (mode === 'before-rename') { send({ event: 'checkpoint', phase: mode }); await new Promise(() => {}); }
        await rename(...args);
        if (mode === 'after-rename') { send({ event: 'checkpoint', phase: mode }); await new Promise(() => {}); }
      };
    }
    send({ event: 'ready', snapshot: journal.snapshot() });
    process.on('message', async message => {
      try {
        if (message.action === 'update') {
          const snapshot = await journal.update(data => { data.count = message.count; });
          send({ event: 'updated', snapshot });
        } else if (message.action === 'close') {
          await journal.close(); send({ event: 'closed' }); process.exit(0);
        }
      } catch (error) { send({ event: 'error', code: error.code }); }
    });
  } catch (error) { send({ event: 'error', code: error.code }); process.exitCode = 2; }
}
