import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { consumerFixture } from './fixtures/consumer.mjs';
import { backendConfiguration } from '../../lib/execution/backend-config.mts';
import { signedFetch } from '../../lib/execution/transport.mts';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function cli(args) {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'runner/consumer.mjs', ...args], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    return { child, done: new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, output })); }) };
}
for (const changed of process.argv[2] ? [process.argv[2]] : ['registry', 'revocation']) {
    assert.ok(['registry', 'revocation'].includes(changed));
    const f = await consumerFixture({ docker: true });
    let runtime;
    try {
        const { run, authorization } = await f.prepare('restart-live-' + changed, 'consumer.slow');
        const state = join(f.root, 'consumer'), owner = join(f.root, 'owner.jwt');
        const journal = async () => JSON.parse(await readFile(join(state, 'consumer.json'), 'utf8'));
        await writeFile(owner, f.alice, { mode: 0o600 });
        assert.equal((await cli(['bootstrap', '--state', state, '--endpoint', f.base + '/mcp', '--run', run.id, '--owner-file', owner]).done).code, 0);
        runtime = cli(['run', '--state', state]);
        const backend = await backendConfiguration(f.bindings);
        let permit, saved, running = false;
        const until = Date.now() + 25000;
        while (Date.now() < until) {
            permit = await f.db.prepare('SELECT * FROM execution_permits WHERE run_id=?').bind(run.id).first();
            saved = await journal();
            if (permit && saved.lease?.generation && saved.lease.expiresAt > Date.now() + 4500 && Object.keys(saved.operations).some(k => k.startsWith('complete_execution_run:'))) {
                const result = await signedFetch(backend.transport, '/result', { permit: JSON.parse(permit.envelope) });
                if (result.data.phase === 'running') { running = true; break; }
            }
            await pause(50);
        }
        assert.ok(running, 'Kill only after actual Docker execution starts with a recently renewed live lease');
        runtime.child.kill('SIGKILL'); await runtime.done;
        saved = await journal();
        if (changed === 'registry') await f.configure({ EXECUTION_REGISTRY: JSON.stringify(f.registry.map(d => ({ ...d, label: d.label + ' drift' }))) });
        else assert.equal((await f.api('/api/authorization', { action: 'revoke', authorizationId: authorization.id, decisionId: 'restart-revoke' })).status, 200);
        assert.ok(saved.lease.expiresAt > Date.now() + 1000, 'Restart while the prior generation remains exclusive');
        const before = f.requests.filter(r => r.name === 'claim_execution_run').length;
        runtime = cli(['run', '--state', state]);
        while (Date.now() < saved.lease.expiresAt - 200 && f.requests.filter(r => r.name === 'claim_execution_run').length === before) await pause(25);
        assert.equal(f.requests.filter(r => r.name === 'claim_execution_run').length, before + 1, 'Startup retries the saved claim once');
        await pause(150);
        assert.ok(Date.now() < saved.lease.expiresAt, 'Observe local recovery before old expiry');
        const recovering = await journal();
        assert.ok(JSON.stringify(recovering.lease) === JSON.stringify(saved.lease), 'Keep the existing lease secret/id/generation while it is still live');
        for (const [key, id] of Object.entries(saved.operations)) {
            if (recovering.operations[key] === id) continue;
            assert.ok(key.startsWith('complete_execution_run:') && recovering.operations[key] === undefined, 'Only acknowledged completion can retire its pending identity');
            const action = await f.db.prepare('SELECT response FROM execution_worker_actions WHERE lease_id=? AND request_id=?').bind(saved.lease.leaseId, id).first();
            assert.ok(action?.response, 'Retired completion has its durable response');
        }
        const result = await runtime.done;
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, changed === 'registry' ? /succeeded; stop confirmed/ : /cancelled; stop confirmed/);
        const retained = await f.db.prepare('SELECT * FROM execution_permits WHERE run_id=?').bind(run.id).first();
        assert.equal(retained.id, permit.id); assert.equal(retained.deadline_ms, permit.deadline_ms); assert.equal(retained.envelope, permit.envelope); assert.notEqual(retained.closed_at, null);
        assert.equal(f.backendRequests.filter(r => r.path === '/start' && r.runId === run.id).length, 1);
        const generations = (await f.db.prepare('SELECT generation,mode FROM execution_leases WHERE run_id=? ORDER BY generation').bind(run.id).all()).results;
        for (const [index, lease] of generations.entries()) assert.deepEqual(lease, { generation: index + 1, mode: index ? 'reconcile' : 'execute' });
        const receipts = (await f.db.prepare('SELECT purpose,receipt FROM backend_attestations WHERE permit_id=?').bind(permit.id).all()).results;
        assert.ok(receipts.some(r => r.purpose === 'stop'));
        assert.ok(receipts.some(r => r.purpose === 'result'));
        console.log('Immediate live-lease restart after ' + changed + ': saved lease/actions retained, trusted ' + (changed === 'registry' ? 'success' : 'cancellation') + '/stop, original permit/deadline, exactly one physical start');
    } finally {
        runtime?.child.kill('SIGKILL'); await runtime?.done;
        await f.close();
    }
}
