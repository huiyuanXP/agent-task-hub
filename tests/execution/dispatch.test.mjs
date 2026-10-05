import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, context, evidenceFor } from './sqlite.mjs';
import { revokeAuthorization } from '../../lib/execution/authorization.mts';
import { transitionRun, getRun } from '../../lib/execution/runs.mts';
const api = await import('../../lib/execution/dispatch.mts').catch(() => ({}));
import { authorized } from './fixtures/authorization.mjs';
test('atomic permit is idempotent and freezes original deadline; current revision and grant fence new dispatch', async t => {
  assert.equal(typeof api.createDispatchPermit, 'function'); const { db, sqlite } = fixture(t); const { run, owner } = await authorized(db);
  const [a,b] = await Promise.all([api.createDispatchPermit(db, owner, run.id), api.createDispatchPermit(db, owner, run.id)]);
  assert.equal(a.permitId, b.permitId); assert.equal(a.deadlineMs, b.deadlineMs); assert.equal(sqlite.prepare('SELECT count(*) n FROM execution_permits').get().n, 1);
  assert.equal(a.runId, run.id); assert.equal(a.operation.operationId, 'ticket.validate.v1'); assert.equal(a.deadlineMs, a.issuedAt + 30000);
  await revokeAuthorization(db, owner, { authorizationId: run.authorizationId, decisionId: 'revoke' });
  assert.equal(sqlite.prepare('SELECT cancel_requested FROM execution_permits').get().cancel_requested, 1);
  assert.equal((await api.checkpointPermit(db, a)).allowed, false);
});
test('logical cancellation atomically retains physical reservation and cancel intent; v1 cannot downgrade dispatched evidence', async t => {
  assert.equal(typeof api.createDispatchPermit, 'function'); const { db, sqlite } = fixture(t); const { run, owner } = await authorized(db);
  const permit = await api.createDispatchPermit(db, owner, run.id);
  const running = await transitionRun(db, owner, { id: run.id, expectedVersion: 1, to: 'running' });
  const old = await evidenceFor(running);
  await assert.rejects(transitionRun(db, { ...owner, evidenceTrust: old.trust }, { id: run.id, expectedVersion: running.version, to: 'succeeded', evidence: old.evidence }));
  await transitionRun(db, owner, { id: run.id, expectedVersion: running.version, to: 'cancelled' });
  const row = sqlite.prepare('SELECT * FROM execution_permits WHERE id=?').get(permit.permitId);
  assert.equal(row.cancel_requested, 1); assert.equal(row.closed_at, null);
  assert.throws(() => sqlite.exec('DELETE FROM execution_permits'));
  assert.equal((await getRun(db, context.owner, run.id)).evidence, null);
});
test('permit transaction rejects revision/revocation races after domain validation', async t => {
  assert.equal(typeof api.createDispatchPermit, 'function'); const { db, sqlite } = fixture(t); const { run, owner } = await authorized(db);
  const raced = { ...db, async batch(statements) { sqlite.prepare("UPDATE execution_authorizations SET status='revoked',last_decision_id='race',decision_key='race',updated_at=updated_at+1 WHERE id=?").run(run.authorizationId); return db.batch(statements); } };
  await assert.rejects(api.createDispatchPermit(raced, owner, run.id));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM execution_permits').get().n, 0);
});
