import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { fixture } from './sqlite.mjs';
import { authorized } from './fixtures/authorization.mjs';
import { createDispatchPermit } from '../../lib/execution/dispatch.mts';
const api = await import('../../lib/execution/workers.mts').catch(() => ({}));
const leases = await import('../../lib/execution/leases.mts').catch(() => ({}));
const hash = x => createHash('sha256').update(x).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const config = { mode: 'trusted-sites', origin: 'http://127.0.0.1:8787' };
async function setup(t) {
    assert.equal(typeof api.provisionWorker, 'function');
    const f = fixture(t);
    const a = await authorized(f.db);
    const issuer = { ...a.owner, mode: 'trusted-sites', origin: config.origin, email: 'alice@example.test', expiresAt: Date.now() + 900000 };
    const key = secret(), input = { credentialId: crypto.randomUUID(), requestId: crypto.randomUUID(), runId: a.run.id, verifier: hash(key), label: 'display label' };
    const issued = await api.provisionWorker(f.db, issuer, input);
    const token = 'athw1.' + input.credentialId + '.' + key;
    const principal = await api.authenticateWorker(f.db, token, config);
    return { ...f, ...a, issuer, key, input, issued, token, principal };
}
function claim(runId) { const key = secret(); return { key, input: { runId, requestId: crypto.randomUUID(), leaseId: crypto.randomUUID(), verifier: hash(key), mode: 'execute' } }; }
async function take(f) { const c = claim(f.run.id); const lease = await leases.claimExecution(f.db, f.principal, c.input); return { ...c, lease, token: 'athl1.' + c.input.leaseId + '.' + lease.generation + '.' + c.key }; }
test('delegation has finite frozen scope, verifier-only persistence and response-loss binding', async (t) => {
    const f = await setup(t);
    assert.equal(f.principal.kind, 'execution_worker');
    assert.equal(f.principal.user, null);
    assert.equal(f.principal.grantAuthority, undefined);
    assert.equal(f.principal.runId, f.run.id);
    assert.ok(f.issued.expiresAt <= f.issuer.expiresAt);
    assert.ok(f.issued.expiresAt <= Date.now() + 900000);
    assert.deepEqual(await api.provisionWorker(f.db, f.issuer, f.input), f.issued);
    await assert.rejects(api.provisionWorker(f.db, f.issuer, { ...f.input, verifier: hash(secret()) }));
    await assert.rejects(api.provisionWorker(f.db, { ...f.issuer, owner: 'foreign' }, { ...f.input, requestId: 'foreign' }));
    assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM execution_worker_credentials').all()).includes(f.key));
    assert.ok(!JSON.stringify(await api.listWorkers(f.db, f.issuer)).includes(f.input.verifier));
    await api.revokeWorker(f.db, f.issuer, { credentialId: f.input.credentialId, requestId: 'revoke' });
    await assert.rejects(api.authenticateWorker(f.db, f.token, config));
});
test('competing leases are exclusive, exact retries preserve generation and changed verifiers conflict', async (t) => {
    const f = await setup(t);
    assert.equal(typeof leases.claimExecution, 'function');
    const a = claim(f.run.id), b = claim(f.run.id);
    const result = await Promise.allSettled([leases.claimExecution(f.db, f.principal, a.input), leases.claimExecution(f.db, f.principal, b.input)]);
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    const winner = result[0].status === 'fulfilled' ? a : b;
    const first = result.find(r => r.status === 'fulfilled').value;
    assert.equal(first.generation, 1);
    assert.deepEqual(await leases.claimExecution(f.db, f.principal, winner.input), first);
    await assert.rejects(leases.claimExecution(f.db, f.principal, { ...winner.input, verifier: hash(secret()) }));
    f.sqlite.prepare('UPDATE execution_leases SET expires_at=?').run(Date.now() - 1);
    await assert.rejects(leases.claimExecution(f.db, f.principal, winner.input));
    const next = await take(f);
    assert.equal(next.lease.generation, 2);
    await assert.rejects(leases.reportExecution(f.db, f.principal, { runId: f.run.id, leaseToken: 'athl1.' + winner.input.leaseId + '.1.' + winner.key, requestId: 'old', message: 'old' }));
});
test('progress and renewal require the current generation, reports never assert lifecycle, terminal reports reject', async (t) => {
    const f = await setup(t), l = await take(f), args = { runId: f.run.id, leaseToken: l.token, requestId: 'progress', message: 'waiting for backend' };
    const first = await leases.reportExecution(f.db, f.principal, args);
    assert.deepEqual(await leases.reportExecution(f.db, f.principal, args), first);
    assert.equal(f.sqlite.prepare('SELECT state FROM execution_runs').get().state, 'queued');
    await assert.rejects(leases.reportExecution(f.db, f.principal, { ...args, message: 'changed' }));
    await assert.rejects(leases.reportExecution(f.db, f.principal, { ...args, state: 'succeeded' }));
    await assert.rejects(leases.reportExecution(f.db, f.principal, { ...args, message: 'x'.repeat(2049) }));
    const renewed = await leases.renewExecution(f.db, f.principal, { runId: f.run.id, leaseToken: l.token, requestId: 'renew' });
    assert.deepEqual(await leases.renewExecution(f.db, f.principal, { runId: f.run.id, leaseToken: l.token, requestId: 'renew' }), renewed);
    f.sqlite.prepare("UPDATE execution_runs SET state='cancelled',version=version+1").run();
    await assert.rejects(leases.reportExecution(f.db, f.principal, args));
});
test('revocation and lease expiry racing the atomic mutation cannot commit even after successful preflight', async (t) => {
    for (const change of ["UPDATE execution_worker_credentials SET revoked_at=1", "UPDATE execution_leases SET expires_at=1", "UPDATE execution_leases SET generation=generation+1"]) {
        const f = await setup(t), l = await take(f);
        let fired = false;
        const raced = { ...f.db, async batch(statements) { if (!fired) {
                fired = true;
                f.sqlite.exec(change);
            } return f.db.batch(statements); } };
        await assert.rejects(leases.reportExecution(raced, f.principal, { runId: f.run.id, leaseToken: l.token, requestId: 'race', message: 'must not persist' }));
        assert.equal(f.sqlite.prepare("SELECT count(*) n FROM execution_worker_actions WHERE request_id='race'").get().n, 0);
    }
});
test('reconciliation needs a historical permit, survives grant expiry, never renews or starts', async (t) => {
    const f = await setup(t);
    let c = claim(f.run.id);
    c.input.mode = 'reconcile';
    await assert.rejects(leases.claimExecution(f.db, f.principal, c.input));
    const permit = await createDispatchPermit(f.db, f.owner, f.run.id);
    f.sqlite.prepare("UPDATE execution_authorizations SET status='revoked',last_decision_id='race',decision_key='race',updated_at=updated_at+1").run();
    await assert.rejects(leases.claimExecution(f.db, f.principal, claim(f.run.id).input));
    const lease = await leases.claimExecution(f.db, f.principal, c.input);
    const token = 'athl1.' + c.input.leaseId + '.' + lease.generation + '.' + c.key;
    await assert.rejects(leases.renewExecution(f.db, f.principal, { runId: f.run.id, leaseToken: token, requestId: 'no' }));
    await assert.rejects(leases.reportExecution(f.db, f.principal, { runId: f.run.id, leaseToken: token, requestId: 'no', message: 'no' }));
    await assert.rejects(leases.startExecution(f.db, f.principal, { runId: f.run.id, leaseToken: token, requestId: 'no' }, {}));
    assert.equal(JSON.parse(f.sqlite.prepare('SELECT envelope FROM execution_permits').get().envelope).deadlineMs, permit.deadlineMs);
});
test('immutable issuance retries cannot revive an expired credential after retention, and issuance audits the owner actor', async (t) => {
    const f = await setup(t);
    assert.equal(f.issued.issuedBy, f.issuer.actor);
    f.sqlite.prepare('UPDATE execution_worker_credentials SET created_at=?,expires_at=?').run(Date.now() - 90000000, Date.now() - 89500000);
    await assert.rejects(api.provisionWorker(f.db, f.issuer, f.input));
});
test('owner MCP can find explicitly selected Runs without exposing unrelated owner tools to workers', async (t) => {
    const f = await setup(t);
    const { dispatchExecutionTool } = await import('../../lib/execution/mcp.mts');
    const result = await dispatchExecutionTool(f.db, f.owner, 'get_execution_run', { runId: f.run.id });
    assert.equal(result?.run.id, f.run.id);
    assert.equal((await dispatchExecutionTool(f.db, f.owner, 'list_execution_runs', {})).runs.length, 1);
});
test('delegated Run reconciliation never recovers a different terminal predecessor reservation', async (t) => {
    const f = await setup(t);
    await createDispatchPermit(f.db, f.owner, f.run.id);
    const { transitionRun } = await import('../../lib/execution/runs.mts');
    await transitionRun(f.db, f.owner, { id: f.run.id, expectedVersion: 1, to: 'cancelled' });
    const { prepareExecution } = await import('../../lib/execution/authorization.mts');
    const next = await prepareExecution(f.db, f.owner, { ticketId: f.run.ticketId, expectedRevision: 1, requestId: 'successor', attempt: 2, scope: f.authorization.scope, budget: f.authorization.budget, expiresAt: Date.now() + 60000 });
    const { reconcileBackend } = await import('../../lib/execution/backend-http.mts');
    const result = await reconcileBackend(f.db, { ...f.owner, executionRunId: next.run.id }, {}, next.run.id);
    assert.equal(result.backend, null);
    assert.equal(f.sqlite.prepare('SELECT closed_at FROM execution_permits').get().closed_at, null);
});
test('selected registry drift blocks execute renewal and claim but preserves historical reconciliation', async (t) => {
    const f = await setup(t), l = await take(f);
    await createDispatchPermit(f.db, f.owner, f.run.id);
    const { REGISTERED_OPERATIONS } = await import('../../lib/execution/registry.mts');
    const registry = REGISTERED_OPERATIONS.map(d => ({ ...d, label: d.label + ' changed' }));
    await assert.rejects(leases.renewExecution(f.db, f.principal, { runId: f.run.id, leaseToken: l.token, requestId: 'drift' }, { registry }));
    f.sqlite.prepare('UPDATE execution_leases SET expires_at=1').run();
    await assert.rejects(leases.claimExecution(f.db, f.principal, claim(f.run.id).input, { registry }));
    const next = claim(f.run.id);
    next.input.mode = 'reconcile';
    assert.equal((await leases.claimExecution(f.db, f.principal, next.input, { registry })).mode, 'reconcile');
});
