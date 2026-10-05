import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { secureRoot, safeRead, atomicWrite } from './state.mjs';
/** One process owns all pending secrets/IDs; writes from renewal and polling serialize. */
export async function openConsumerState(root) {
    root = await secureRoot(root);
    const handle = await open(join(root, '.consumer.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077)) {
        await handle.close();
        throw Error('Unsafe consumer lock');
    }
    const lock = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '/proc/self/fd/3', process.execPath, '-e', "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore', handle.fd] });
    try {
        await new Promise((resolve, reject) => { lock.once('error', reject); lock.once('exit', () => reject(Error('Consumer state already in use'))); lock.stdout.once('data', resolve); });
    }
    catch (error) {
        await handle.close();
        throw error;
    }
    let closed = false, failed = false, serial = Promise.resolve(), value = null;
    lock.on('exit', () => { if (!closed)
        failed = true; });
    const close = async () => { await serial; closed = true; lock.stdin.end(); if (lock.exitCode === null)
        await new Promise(r => lock.once('exit', r)); await handle.close(); };
    try {
        try {
            value = JSON.parse((await safeRead(join(root, 'consumer.json'), 524288)).toString());
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    catch (error) {
        await close();
        throw error;
    }
    return { get value() { return structuredClone(value); }, close, async update(fn) {
            const pending = serial.then(async () => {
                if (closed || failed)
                    throw Error('Consumer journal unavailable');
                // Validate an existing target before atomic replacement (no unsafe-file repair).
                try {
                    await safeRead(join(root, 'consumer.json'), 524288);
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
                const next = await fn(structuredClone(value));
                const encoded = Buffer.from(JSON.stringify(next));
                if (encoded.length > 524288)
                    throw Error('Consumer state capacity exceeded');
                await atomicWrite(root, 'consumer.json', encoded);
                value = structuredClone(next);
                return structuredClone(value);
            });
            serial = pending.catch(() => { failed = true; });
            return pending;
        } };
}
