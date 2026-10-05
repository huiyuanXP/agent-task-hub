import { backendConfiguration } from '../../lib/execution/backend-config.mts';
import { signedFetch } from '../../lib/execution/transport.mts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { consumerFixture } from './fixtures/consumer.mjs';
const f = await consumerFixture({ docker: true });
const children = new Set();
function cli(args) { const child = spawn(process.execPath, ['--experimental-strip-types', 'runner/consumer.mjs', ...args], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child); let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal, output }); }); }); return { child, done }; }
try {
    const prepared = await f.prepare('ticket-consumer-real', 'consumer.slow');
    const ownerFile = join(f.root, 'owner.jwt');
    await writeFile(ownerFile, f.alice, { mode: 0o600 });
    const state = join(f.root, 'consumer');
    await mkdir(state, { mode: 0o700 });
    f.drops.set('provision', 1);
    const bootstrap = await cli(['bootstrap', '--state', state, '--endpoint', f.base + '/mcp', '--run', prepared.run.id, '--owner-file', ownerFile]).done;
    assert.equal(bootstrap.code, 0, bootstrap.output);
    const saved = await readFile(join(state, 'consumer.json'), 'utf8');
    assert.ok(!saved.includes(f.alice));
    assert.ok(!saved.includes('owner.jwt'));
    await rm(ownerFile);
    for (const action of ['claim_execution_run', 'start_execution_run', 'complete_execution_run'])
        f.drops.set(action, 1);
    const runtime = cli(['run', '--state', state]);
    const result = await runtime.done;
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /succeeded/);
    assert.ok(f.requests.filter(r => r.name === 'renew_execution_run').length >= 3, 'Long operation renews concurrently');
    assert.ok(f.requests.filter(r => r.name === 'claim_execution_run').length >= 2, 'Dropped claim retries stable identity');
    assert.equal((await f.db.prepare('SELECT count(*) n FROM execution_permits WHERE run_id=?').bind(prepared.run.id).first()).n, 1);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM execution_leases WHERE run_id=?').bind(prepared.run.id).first()).n, 1);
    const run = (await f.api('/api/execution?id=' + prepared.run.id)).data.run;
    assert.equal(run.evidence.claims.version, 2);
    assert.equal(run.state, 'succeeded');
    assert.notEqual((await f.db.prepare('SELECT closed_at FROM execution_permits WHERE run_id=?').bind(run.id).first()).closed_at, null);
    assert.equal((await cli(['run', '--state', state, '--owner-file', 'ignored']).done).code, 1);
    console.log('Actual CLI bootstrap/run + Access/D1/MCP + supervisor/Docker: slow execution, concurrent renewal, dropped provision/claim/start/complete responses, one physical identity and confirmed stop passed');
    // Signal shutdown is a separate real operation, so success cannot mask cancellation.
    const second = await f.prepare('ticket-consumer-signal', 'consumer.slow');
    await writeFile(ownerFile, f.alice, { mode: 0o600 });
    const state2 = join(f.root, 'consumer-signal');
    assert.equal((await cli(['bootstrap', '--state', state2, '--endpoint', f.base + '/mcp', '--run', second.run.id, '--owner-file', ownerFile]).done).code, 0);
    const signal = cli(['run', '--state', state2]);
    const until = Date.now() + 20000;
    let permit;
    while (Date.now() < until) {
        permit = await f.db.prepare('SELECT * FROM execution_permits WHERE run_id=?').bind(second.run.id).first();
        if (permit)
            break;
        await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(permit);
    await new Promise(r => setTimeout(r, 2000));
    signal.child.kill('SIGTERM');
    const stopped = await signal.done;
    assert.equal(stopped.code, 0, stopped.output);
    assert.match(stopped.output, /stop confirmed/);
    assert.equal((await f.api('/api/execution?id=' + second.run.id)).data.run.state, 'cancelled');
    assert.notEqual((await f.db.prepare('SELECT closed_at FROM execution_permits WHERE run_id=?').bind(second.run.id).first()).closed_at, null);
    console.log('SIGTERM requests owned cancellation and observes trusted physical stop before CLI exit');
    const recovered = await f.prepare('ticket-consumer-recover', 'consumer.slow', 45000);
    const state3 = join(f.root, 'consumer-recover');
    assert.equal((await cli(['bootstrap', '--state', state3, '--endpoint', f.base + '/mcp', '--run', recovered.run.id, '--owner-file', ownerFile]).done).code, 0);
    const crashing = cli(['run', '--state', state3]);
    let prior;
    const crashUntil = Date.now() + 15000;
    while (Date.now() < crashUntil) {
        const found = (await f.api('/api/execution?id=' + recovered.run.id)).data.run;
        if (found.state === 'running') {
            prior = await f.db.prepare('SELECT * FROM execution_permits WHERE run_id=?').bind(recovered.run.id).first();
            break;
        }
        await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(prior);
    crashing.child.kill('SIGKILL');
    await crashing.done;
    const starts = f.backendRequests.filter(r => r.path === '/start' && r.runId === recovered.run.id).length;
    const backend = await backendConfiguration(f.bindings);
    let historical;
    const historyUntil = prior.deadline_ms + 5000;
    while (Date.now() < historyUntil) {
        historical = await signedFetch(backend.transport, '/result', { permit: JSON.parse(prior.envelope) });
        if (historical.data.receipts?.some(r => r.claims.purpose === 'stop'))
            break;
        await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(historical.data.receipts?.find(r => r.claims.purpose === 'result')?.claims.status, 'succeeded', JSON.stringify(historical.data));
    // Let the real process finish under its original deadline, and let both grant
    // and lease expire while no consumer can ingest its result.
    await new Promise(r => setTimeout(r, Math.max(0, recovered.authorization.expiresAt - Date.now() + 100)));
    await f.db.prepare('UPDATE records SET revision=revision+1 WHERE id=?').bind(recovered.run.ticketId).run();
    const resume = await cli(['run', '--state', state3]).done;
    assert.equal(resume.code, 0, resume.output);
    assert.match(resume.output, /succeeded; stop confirmed/);
    const after = await f.db.prepare('SELECT * FROM execution_permits WHERE run_id=?').bind(recovered.run.id).first();
    assert.equal(after.id, prior.id);
    assert.equal(after.deadline_ms, prior.deadline_ms);
    assert.equal(f.backendRequests.filter(r => r.path === '/start' && r.runId === recovered.run.id).length, starts, 'Reconciliation never resends start');
    const generations = await f.db.prepare('SELECT generation,mode FROM execution_leases WHERE run_id=? ORDER BY generation').bind(recovered.run.id).all();
    assert.deepEqual(generations.results, [{ generation: 1, mode: 'execute' }, { generation: 2, mode: 'reconcile' }]);
    console.log('SIGKILL restart reclaims generation 2, reconciles historical success after grant expiry and Ticket drift, preserves original deadline and sends no second start');
    const failedHistorical = await f.prepare('ticket-consumer-historical-failure', 'consumer.slow', 5000);
    const stateFailure = join(f.root, 'consumer-historical-failure');
    assert.equal((await cli(['bootstrap', '--state', stateFailure, '--endpoint', f.base + '/mcp', '--run', failedHistorical.run.id, '--owner-file', ownerFile]).done).code, 0);
    assert.equal((await f.api('/api/execution/dispatch', { action: 'start', runId: failedHistorical.run.id })).status, 202);
    await new Promise(r => setTimeout(r, Math.max(0, failedHistorical.authorization.expiresAt - Date.now() + 1000)));
    const startsFailure = f.backendRequests.filter(r => r.path === '/start' && r.runId === failedHistorical.run.id).length;
    const failedResume = await cli(['run', '--state', stateFailure]).done;
    assert.equal(failedResume.code, 0, failedResume.output);
    assert.match(failedResume.output, /failed; stop confirmed/);
    assert.equal(f.backendRequests.filter(r => r.path === '/start' && r.runId === failedHistorical.run.id).length, startsFailure);
    assert.equal((await f.api('/api/execution?id=' + failedHistorical.run.id)).data.run.state, 'failed');
    console.log('Natural hard-deadline failure is reconciled truthfully after grant expiry without a second start or changed deadline');
    const invalidated = await f.prepare('ticket-consumer-revoked', 'consumer.slow');
    const state4 = join(f.root, 'consumer-revoked');
    assert.equal((await cli(['bootstrap', '--state', state4, '--endpoint', f.base + '/mcp', '--run', invalidated.run.id, '--owner-file', ownerFile]).done).code, 0);
    const revoking = cli(['run', '--state', state4]);
    const revokeUntil = Date.now() + 15000;
    let active;
    while (Date.now() < revokeUntil) {
        active = await f.db.prepare('SELECT * FROM execution_permits WHERE run_id=?').bind(invalidated.run.id).first();
        if (active)
            break;
        await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(active);
    // The revoke command is separately owner-authenticated. Runtime state has an
    // exclusive lock, so use the same concrete owner API during the active process.
    const credential = JSON.parse(await readFile(join(state4, 'consumer.json'), 'utf8')).credentialId;
    assert.equal((await f.api('/api/execution/workers', { action: 'revoke', credentialId: credential, requestId: 'revoke-active' })).status, 200);
    const rejected = await revoking.done;
    assert.equal(rejected.code, 1);
    assert.match(rejected.output, /CREDENTIAL_INVALID/);
    assert.match(rejected.output, /unconfirmed/);
    const cancel = await f.api('/api/execution/dispatch', { action: 'cancel', runId: invalidated.run.id });
    assert.equal(cancel.status, 200);
    assert.equal((await cli(['run', '--state', state4]).done).code, 1);
    // Exercise the actual owner revoke command with an unused delegation.
    const revokeTarget = await f.prepare('ticket-consumer-revoke-command');
    const state5 = join(f.root, 'consumer-revoke-command');
    assert.equal((await cli(['bootstrap', '--state', state5, '--endpoint', f.base + '/mcp', '--run', revokeTarget.run.id, '--owner-file', ownerFile]).done).code, 0);
    const revokedCommand = await cli(['revoke', '--state', state5, '--owner-file', ownerFile]).done;
    assert.equal(revokedCommand.code, 0, revokedCommand.output);
    assert.equal((await cli(['run', '--state', state5]).done).code, 1);
    const pendingRun = await f.prepare('ticket-consumer-pending');
    const pendingState = join(f.root, 'consumer-pending');
    const bootstrapArgs = ['bootstrap', '--state', pendingState, '--endpoint', f.base + '/mcp', '--run', pendingRun.run.id, '--owner-file', ownerFile];
    f.drops.set('provision', 3);
    assert.equal((await cli(bootstrapArgs).done).code, 1);
    const pendingBefore = JSON.parse(await readFile(join(pendingState, 'consumer.json'), 'utf8'));
    assert.equal((await cli(bootstrapArgs).done).code, 0);
    const pendingAfter = JSON.parse(await readFile(join(pendingState, 'consumer.json'), 'utf8'));
    assert.equal(pendingAfter.secret, pendingBefore.secret);
    assert.equal(pendingAfter.credentialId, pendingBefore.credentialId);
    assert.equal(pendingAfter.provisionRequestId, pendingBefore.provisionRequestId);
    f.drops.set('claim_execution_run', 3);
    assert.equal((await cli(['run', '--state', pendingState]).done).code, 1);
    const pendingClaim = JSON.parse(await readFile(join(pendingState, 'consumer.json'), 'utf8')).lease;
    const resumedClaim = await cli(['run', '--state', pendingState]).done;
    assert.equal(resumedClaim.code, 0, resumedClaim.output);
    const resumedState = JSON.parse(await readFile(join(pendingState, 'consumer.json'), 'utf8'));
    assert.equal(resumedState.lease.leaseId, pendingClaim.leaseId);
    assert.equal(resumedState.lease.secret, pendingClaim.secret);
    assert.equal(resumedState.lease.generation, 1);
    console.log('All-replies-lost bootstrap and claim processes restart from the same fsynced secrets/IDs and recover the same server generation');
    assert.deepEqual(f.outbound, []);
    console.log('Revocation stops privileged runtime writes without owner fallback, reports stop unconfirmed, and separate owner revoke CLI works');
}
finally {
    for (const child of children)
        child.kill('SIGKILL');
    await f.close();
}
