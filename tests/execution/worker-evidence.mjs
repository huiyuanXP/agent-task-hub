import { backendConfiguration } from '../../lib/execution/backend-config.mts';
import { signedFetch } from '../../lib/execution/transport.mts';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { consumerFixture } from './fixtures/consumer.mjs';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';
import { authenticateWorker } from '../../lib/execution/workers.mts';
import { claimExecution, completeExecution } from '../../lib/execution/leases.mts';
import { raceDatabase } from './fixtures/race.mjs';
const f = await consumerFixture({ docker: true });
const hash = v => createHash('sha256').update(v).digest('hex');
async function delegate(run) {
    const key = randomBytes(32).toString('base64url'), id = crypto.randomUUID();
    const created = await f.api('/api/execution/workers', { action: 'provision', credentialId: id, requestId: id, runId: run.id, verifier: hash(key), label: 'evidence' });
    assert.equal(created.status, 201);
    const token = 'athw1.' + id + '.' + key, p = await authenticateWorker(f.db, token, { mode: 'access', origin: f.origin, issuer: f.issuer, audience: f.audience, allowedEmails: ['alice@example.test'] });
    const leaseKey = randomBytes(32).toString('base64url'), leaseId = crypto.randomUUID();
    const l = await claimExecution(f.db, p, { runId: run.id, leaseId, requestId: leaseId, verifier: hash(leaseKey), mode: 'reconcile' });
    return { token, p, args: { runId: run.id, leaseToken: 'athl1.' + leaseId + '.' + l.generation + '.' + leaseKey, requestId: crypto.randomUUID() } };
}
try {
    const first = await f.prepare('evidence-source');
    assert.equal((await f.api('/api/execution/dispatch', { action: 'start', runId: first.run.id })).status, 202);
    let result;
    for (let i = 0; i < 150; i++) {
        result = await f.api('/api/execution/dispatch?runId=' + first.run.id);
        if (result.data.backend?.receipts.some(r => r.claims.purpose === 'stop'))
            break;
        await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(result.data.run.state, 'succeeded');
    const second = await f.prepare('evidence-target');
    await createDispatchPermit(f.db, { owner: f.owner, actor: f.owner }, second.run.id);
    const foreign = await delegate(second.run);
    f.overrideResult({ runId: second.run.id, receipts: result.data.backend.receipts });
    const ownerReply = await f.api('/api/execution/dispatch?runId=' + second.run.id);
    assert.equal(ownerReply.status, 409);
    const response = await f.api('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'complete_execution_run', arguments: foreign.args } }, foreign.token);
    assert.ok(response.data.error, 'A valid signed receipt for another permit must not complete a worker request');
    f.overrideResult(null);
    // Complete's real result-ingestion transaction is fenced, not only its action
    // request or HTTP wrapper. Keep a genuine result pending outside D1.
    const third = await f.prepare('evidence-race');
    assert.equal((await f.api('/api/execution/dispatch', { action: 'start', runId: third.run.id })).status, 202);
    const pending = await f.db.prepare('SELECT envelope FROM execution_permits WHERE run_id=?').bind(third.run.id).first();
    const configuration = await backendConfiguration(f.bindings);
    let raw;
    for (let i = 0; i < 250; i++) {
        raw = await signedFetch(configuration.transport, '/result', { permit: JSON.parse(pending.envelope) });
        if (raw.data.receipts?.some(r => r.claims.purpose === 'stop'))
            break;
        await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(raw.data.receipts?.some(r => r.claims.purpose === 'result'));
    const owned = await delegate(third.run);
    const race = raceDatabase(f.db, sql => sql.includes('INSERT OR IGNORE INTO backend_attestations'), () => f.db.prepare('UPDATE execution_leases SET expires_at=1 WHERE run_id=?').bind(third.run.id).run());
    await assert.rejects(completeExecution(race.db, owned.p, owned.args, f.bindings));
    assert.equal(race.fired, true);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM backend_attestations a JOIN execution_permits p ON p.id=a.permit_id WHERE p.run_id=?').bind(third.run.id).first()).n, 0);
    assert.equal((await f.api('/api/execution?id=' + third.run.id)).data.run.state, 'queued');
    await f.api('/api/execution/dispatch?runId=' + third.run.id);
    await f.api('/api/execution/dispatch', { action: 'cancel', runId: second.run.id });
    console.log('Actual signed foreign backend result rejected; lease expiry at trusted receipt-ingestion D1 boundary rolls back evidence and Run changes');
}
finally {
    await f.close();
}
