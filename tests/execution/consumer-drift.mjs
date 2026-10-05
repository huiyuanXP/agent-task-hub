import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consumerFixture } from './fixtures/consumer.mjs';
const f = await consumerFixture({ docker: true });
let runtime;
function cli(args) { const child = spawn(process.execPath, ['--experimental-strip-types', 'runner/consumer.mjs', ...args], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); return { child, done: new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, output })); }) }; }
try {
    const { run } = await f.prepare('consumer-registry-drift', 'consumer.slow');
    const ownerFile = join(f.root, 'owner.jwt'), state = join(f.root, 'consumer');
    await writeFile(ownerFile, f.alice, { mode: 0o600 });
    assert.equal((await cli(['bootstrap', '--state', state, '--endpoint', f.base + '/mcp', '--run', run.id, '--owner-file', ownerFile]).done).code, 0);
    runtime = cli(['run', '--state', state]);
    const until = Date.now() + 15000;
    while (Date.now() < until && !f.requests.some(r => r.name === 'report_execution_run'))
        await new Promise(r => setTimeout(r, 100));
    assert.ok(f.requests.some(r => r.name === 'report_execution_run'));
    await f.configure({ EXECUTION_REGISTRY: JSON.stringify(f.registry.map(d => ({ ...d, label: d.label + ' changed' }))) });
    const result = await runtime.done;
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /succeeded; stop confirmed/);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM execution_permits WHERE run_id=?').bind(run.id).first()).n, 1);
    const generations = (await f.db.prepare('SELECT generation,mode FROM execution_leases WHERE run_id=? ORDER BY generation').bind(run.id).all()).results;
    assert.ok(generations.length >= 2);
    for (let i = 0; i < generations.length; i++) assert.deepEqual(generations[i], { generation: i + 1, mode: i === 0 ? 'execute' : 'reconcile' });
    assert.equal(f.backendRequests.filter(r => r.path === '/start' && r.runId === run.id).length, 1);
    console.log('Actual CLI tolerates renewal denial during selected registry drift, waits out existing exclusivity, reclaims reconciliation and confirms original execution success');
}
finally {
    runtime?.child.kill('SIGKILL');
    await f.close();
}
