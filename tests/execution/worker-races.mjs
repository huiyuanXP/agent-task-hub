import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { consumerFixture } from './fixtures/consumer.mjs';
import { raceDatabase } from './fixtures/race.mjs';
import { authenticateWorker, provisionWorker } from '../../lib/execution/workers.mts';
import { claimExecution, reportExecution, renewExecution, startExecution } from '../../lib/execution/leases.mts';
const f = await consumerFixture();
let sequence = 0;
const hash = v => createHash('sha256').update(v).digest('hex');
async function provision(lifetime = 600000) {
    const { run } = await f.prepare('race-' + (++sequence));
    const secret = randomBytes(32).toString('base64url'), id = crypto.randomUUID();
    const issuer = { owner: f.owner, actor: f.owner, grantAuthority: 'owner', mode: 'access', origin: f.origin, issuer: f.issuer, audience: f.audience, allowedEmails: ['alice@example.test'], email: 'alice@example.test', expiresAt: Date.now() + lifetime, tokenHash: hash(f.alice) };
    await provisionWorker(f.db, issuer, { credentialId: id, requestId: id, runId: run.id, verifier: hash(secret), label: 'race' });
    return { run, p: await authenticateWorker(f.db, 'athw1.' + id + '.' + secret, issuer) };
}
async function claim(x) { const secret = randomBytes(32).toString('base64url'), id = crypto.randomUUID(); const input = { runId: x.run.id, leaseId: id, requestId: id, verifier: hash(secret), mode: 'execute' }; const lease = await claimExecution(f.db, x.p, input); return { input, lease, token: 'athl1.' + id + '.' + lease.generation + '.' + secret }; }
try {
    for (const target of ['claim', 'report', 'renew', 'start'])
        for (const changed of ['credential', 'lease', 'generation', 'grant', 'revision']) {
            if (target === 'claim' && ['lease', 'generation'].includes(changed) || target === 'report' && ['grant', 'revision'].includes(changed))
                continue;
            const x = await provision();
            const l = target === 'claim' ? null : await claim(x);
            const requestId = 'mutation-' + sequence;
            const sql = target === 'claim' ? 'INSERT OR IGNORE INTO execution_leases' : target === 'renew' ? 'UPDATE execution_leases SET expires_at' : target === 'start' ? 'INSERT OR IGNORE INTO execution_permits' : 'INSERT OR IGNORE INTO execution_worker_actions';
            const race = raceDatabase(f.db, text => text.includes(sql), async () => {
                if (changed === 'credential')
                    await f.db.prepare('UPDATE execution_worker_credentials SET revoked_at=1 WHERE id=?').bind(x.p.credentialId).run();
                if (changed === 'lease')
                    await f.db.prepare('UPDATE execution_leases SET expires_at=1 WHERE id=?').bind(l.lease.leaseId).run();
                if (changed === 'generation')
                    await f.db.prepare('UPDATE execution_leases SET generation=generation+1 WHERE id=?').bind(l.lease.leaseId).run();
                if (changed === 'grant')
                    await f.db.prepare("UPDATE execution_authorizations SET status='revoked',last_decision_id='race',decision_key='race',updated_at=updated_at+1 WHERE id=?").bind(x.run.authorizationId).run();
                if (changed === 'revision')
                    await f.db.prepare('UPDATE records SET revision=revision+1 WHERE id=?').bind(x.run.ticketId).run();
            });
            const input = { runId: x.run.id, leaseToken: l?.token, requestId };
            if (target === 'claim')
                await assert.rejects(claimExecution(race.db, x.p, { runId: x.run.id, leaseId: crypto.randomUUID(), requestId, verifier: hash('new-secret'), mode: 'execute' }));
            if (target === 'report')
                await assert.rejects(reportExecution(race.db, x.p, { ...input, message: 'must rollback' }));
            if (target === 'renew')
                await assert.rejects(renewExecution(race.db, x.p, input));
            if (target === 'start')
                await assert.rejects(startExecution(race.db, x.p, input, f.bindings));
            assert.equal(race.fired, true, target + '/' + changed + ' must reach mutation boundary');
            if (target === 'claim')
                assert.equal((await f.db.prepare('SELECT count(*) n FROM execution_leases WHERE run_id=?').bind(x.run.id).first()).n, 0);
            if (target === 'report')
                assert.equal((await f.db.prepare('SELECT count(*) n FROM execution_worker_actions WHERE request_id=?').bind(requestId).first()).n, 0);
            if (target === 'renew')
                assert.equal((await f.db.prepare('SELECT response FROM execution_worker_actions WHERE request_id=?').bind(requestId).first()).response, null);
            if (target === 'start')
                assert.equal((await f.db.prepare('SELECT count(*) n FROM execution_permits WHERE run_id=?').bind(x.run.id).first()).n, 0);
        }
    const credentialExpiry = await provision(1000);
    const beforeCredential = await f.db.prepare('SELECT expires_at FROM execution_worker_credentials WHERE id=?').bind(credentialExpiry.p.credentialId).first();
    const credentialRace = raceDatabase(f.db, sql => sql.includes('INSERT OR IGNORE INTO execution_leases'), () => new Promise(r => setTimeout(r, Math.max(0, beforeCredential.expires_at - Date.now() + 75))));
    await assert.rejects(claimExecution(credentialRace.db, credentialExpiry.p, { runId: credentialExpiry.run.id, leaseId: crypto.randomUUID(), requestId: 'natural-credential', verifier: hash('natural'), mode: 'execute' }));
    assert.equal(credentialRace.fired, true);
    assert.deepEqual(await f.db.prepare('SELECT expires_at FROM execution_worker_credentials WHERE id=?').bind(credentialExpiry.p.credentialId).first(), beforeCredential);
    assert.equal((await f.db.prepare('SELECT count(*) n FROM execution_leases WHERE run_id=?').bind(credentialExpiry.run.id).first()).n, 0);
    const leaseExpiry = await provision();
    const lease = await claim(leaseExpiry);
    const beforeLease = await f.db.prepare('SELECT expires_at FROM execution_leases WHERE id=?').bind(lease.lease.leaseId).first();
    const leaseRace = raceDatabase(f.db, sql => sql.includes('INSERT OR IGNORE INTO execution_worker_actions'), () => new Promise(r => setTimeout(r, Math.max(0, beforeLease.expires_at - Date.now() + 75))));
    await assert.rejects(reportExecution(leaseRace.db, leaseExpiry.p, { runId: leaseExpiry.run.id, leaseToken: lease.token, requestId: 'natural-lease', message: 'must not persist' }));
    assert.equal(leaseRace.fired, true);
    assert.deepEqual(await f.db.prepare('SELECT expires_at FROM execution_leases WHERE id=?').bind(lease.lease.leaseId).first(), beforeLease);
    assert.equal((await f.db.prepare("SELECT count(*) n FROM execution_worker_actions WHERE request_id='natural-lease'").first()).n, 0);
    console.log('Natural credential and six-second lease expiry after preflight reject actual D1 batches with stored expiry values unchanged');
    assert.equal((await f.db.prepare('SELECT count(*) n FROM execution_worker_checks').first()).n, 0);
    console.log('Actual D1 domain-boundary races: delegation/lease expiry-revocation, grant and Ticket changes cannot commit claim, renewal, report or start-permit; all guards roll back');
}
finally {
    await f.close();
}
