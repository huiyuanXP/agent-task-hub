import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const api = await import('../../runner/consumer-state.mjs').catch(() => ({}));
test('consumer journal excludes overlapping processes, serializes updates and rejects unsafe secret state', async (t) => {
    assert.equal(typeof api.openConsumerState, 'function');
    const root = await mkdtemp(join(tmpdir(), 'consumer-state-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = await api.openConsumerState(root);
    try {
        await state.update(() => ({ version: 1, counter: 0 }));
        await assert.rejects(api.openConsumerState(root));
        await Promise.all(Array.from({ length: 20 }, () => state.update(v => ({ ...v, counter: v.counter + 1 }))));
        assert.equal(state.value.counter, 20);
        assert.equal(JSON.parse(await readFile(join(root, 'consumer.json'), 'utf8')).counter, 20);
    }
    finally {
        await state.close();
    }
    const restarted = await api.openConsumerState(root);
    assert.equal(restarted.value.counter, 20);
    await restarted.close();
    await chmod(join(root, 'consumer.json'), 0o644);
    await assert.rejects(api.openConsumerState(root));
    await rm(join(root, 'consumer.json'));
    await writeFile(join(root, 'foreign'), '{}', { mode: 0o600 });
    await symlink(join(root, 'foreign'), join(root, 'consumer.json'));
    await assert.rejects(api.openConsumerState(root));
});
