import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consumerFixture } from './fixtures/consumer.mjs';
const f = await consumerFixture();
let file;
try {
    const { run } = await f.prepare();
    const path = join(f.root, 'owner.jwt');
    await writeFile(path, f.alice, { mode: 0o600 });
    file = await open(path, 'r');
    const stdio = Array(11).fill('ignore');
    stdio[1] = 'pipe';
    stdio[2] = 'pipe';
    stdio[10] = file.fd;
    const child = spawn(process.execPath, ['--experimental-strip-types', 'runner/consumer.mjs', 'bootstrap', '--state', join(f.root, 'state'), '--endpoint', f.base + '/mcp', '--run', run.id, '--owner-fd', '10'], { env: { PATH: process.env.PATH }, stdio });
    let output = '';
    child.stdout.on('data', b => output += b);
    child.stderr.on('data', b => output += b);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, output);
    const saved = await readFile(join(f.root, 'state', 'consumer.json'), 'utf8');
    assert.ok(!saved.includes(f.alice));
    assert.ok(!output.includes(f.alice));
    assert.ok(JSON.parse(saved).credential);
    console.log('Actual CLI and verified Access Worker: protected inherited descriptor 10 bootstraps without storing or printing the owner JWT');
}
finally {
    await file?.close();
    await f.close();
}
