import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRun, getRun, listRuns, transitionRun } from '../../lib/execution/runs.mts';
import { fixture, context, input, status, evidenceFor, sqliteAdapter } from './sqlite.mjs';

// Missing snapshot capture, owner predicates, guards, SQL atomics, edge checks,
// or cryptographic receipt verification each breaks the behavior named below.
test('freezes exact Ticket body/revision, identity and execution source after Ticket edits', async t => {
  const { db, sqlite, body } = fixture(t);
  const run = await createRun(db, context, input);
  sqlite.prepare('UPDATE records SET body=?, revision=2 WHERE id=?').run('{"title":"Changed"}', 'ticket-1');
  const frozen = await getRun(db, context.owner, run.id);
  assert.equal(frozen.ticketBody, body);
  assert.equal(frozen.ticketRevision, 1);
  assert.equal(frozen.actor, 'actor-a');
  assert.equal(frozen.authorizationId, 'authorization-1');
  assert.equal(frozen.attempt, 1);
  assert.equal(frozen.source, 'execution');
  assert.equal(frozen.state, 'queued');
});
test('stale revision is a typed 409 without inserting a Run', async t => {
  const { db } = fixture(t);
  await assert.rejects(createRun(db, context, { ...input, expectedRevision: 2 }), status(409));
  assert.deepEqual(await listRuns(db, context.owner, {}), []);
});
test('foreign and absent Ticket/Run are indistinguishable 404s', async t => {
  const { db } = fixture(t);
  const run = await createRun(db, context, input);
  await assert.rejects(createRun(db, { owner: 'owner-b', actor: 'actor-b' }, input), status(404));
  await assert.rejects(getRun(db, 'owner-b', run.id), status(404));
  await assert.rejects(getRun(db, context.owner, 'missing'), status(404));
  await assert.rejects(transitionRun(db, { owner: 'owner-b', actor: 'actor-b' }, { id: run.id, expectedVersion: 1, to: 'cancelled' }), status(404));
  assert.deepEqual(await listRuns(db, 'owner-b', {}), []);
});
test('identical retries retain one ID even after the Ticket changes or the Run ends', async t => {
  const { db, sqlite } = fixture(t);
  const run = await createRun(db, context, input);
  sqlite.prepare('UPDATE records SET body=?,revision=2 WHERE id=?').run('{"title":"New"}', 'ticket-1');
  assert.equal((await createRun(db, context, input)).id, run.id);
  await transitionRun(db, context, { id: run.id, expectedVersion: 1, to: 'cancelled' });
  assert.equal((await createRun(db, context, input)).id, run.id);
  assert.equal((await listRuns(db, context.owner, {})).length, 1);
});
test('request ID reuse with changed input or actor conflicts', async t => {
  const { db } = fixture(t);
  await createRun(db, context, input);
  for (const changed of [{ expectedRevision: 2 }, { ticketId: 'other' }, { attempt: 2 }, { authorizationId: 'other' }]) {
    await assert.rejects(createRun(db, context, { ...input, ...changed }), status(409));
  }
  await assert.rejects(createRun(db, { ...context, actor: 'other' }, input), status(409));
});
test('concurrent retries from separate SQLite connections produce one ID', async t => {
  const { db, path, sqlite } = fixture(t);
  const other = new DatabaseSync(path);
  t.after(() => other.close());
  const runs = await Promise.all(Array.from({ length: 12 }, (_, n) => createRun(n % 2 ? db : sqliteAdapter(other), context, input)));
  assert.equal(new Set(runs.map(run => run.id)).size, 1);
  assert.equal(sqlite.prepare('SELECT count(*) AS total FROM execution_runs').get().total, 1);
});
test('active Ticket uniqueness rejects different requests but permits a later attempt after termination', async t => {
  const { db } = fixture(t);
  const results = await Promise.allSettled([
    createRun(db, context, input), createRun(db, context, { ...input, requestId: 'other' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected');
  assert.equal(failure.reason.status, 409);
  const run = results.find(result => result.status === 'fulfilled').value;
  await transitionRun(db, context, { id: run.id, expectedVersion: 1, to: 'failed' });
  const next = await createRun(db, context, { ...input, requestId: 'next', attempt: 2 });
  assert.notEqual(next.id, run.id);
});
test('bounded exact input schema rejects invalid attempts, revisions, IDs and caller state/evidence', async t => {
  const { db } = fixture(t);
  for (const invalid of [null, [], 'x', {}, ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(attempt => ({ ...input, attempt })),
    { ...input, expectedRevision: 0 }, { ...input, requestId: '' }, { ...input, requestId: 'x'.repeat(129) },
    { ...input, requestId: 'spaces forbidden' }, { ...input, authorizationId: null }, { ...input, ticketId: 'x'.repeat(201) },
    { ...input, state: 'running' }, { ...input, evidence: {} }]) {
    await assert.rejects(createRun(db, context, invalid), status(400));
  }
});
test('owner scoped list filters state/Ticket and has a bounded limit', async t => {
  const { db } = fixture(t);
  const run = await createRun(db, context, input);
  assert.equal((await listRuns(db, context.owner, { ticketId: 'ticket-1', state: 'queued', limit: 1 }))[0].id, run.id);
  assert.deepEqual(await listRuns(db, context.owner, { state: 'failed' }), []);
  await assert.rejects(listRuns(db, context.owner, { state: 'done' }), status(400));
  await assert.rejects(listRuns(db, context.owner, { limit: 101 }), status(400));
});
const legal = { queued: ['running', 'waiting', 'failed', 'cancelled'], running: ['waiting', 'succeeded', 'failed', 'cancelled'], waiting: ['queued', 'running', 'failed', 'cancelled'], succeeded: [], failed: [], cancelled: [] };
for (const from of Object.keys(legal)) for (const to of Object.keys(legal)) {
  test(`state edge ${from} -> ${to} is ${legal[from].includes(to) ? 'legal' : 'rejected'}`, async t => {
    const { db } = fixture(t);
    let run = await createRun(db, context, input);
    if (from !== 'queued') {
      if (from === 'succeeded') {
        run = await transitionRun(db, context, { id: run.id, expectedVersion: run.version, to: 'running' });
        const signed = await evidenceFor(run);
        run = await transitionRun(db, { ...context, evidenceTrust: signed.trust }, { id: run.id, expectedVersion: run.version, to: 'succeeded', evidence: signed.evidence });
      } else run = await transitionRun(db, context, { id: run.id, expectedVersion: run.version, to: from });
    }
    const signed = to === 'succeeded' ? await evidenceFor(run) : null;
    const change = transitionRun(db, { ...context, ...(signed ? { evidenceTrust: signed.trust } : {}) }, { id: run.id, expectedVersion: run.version, to, ...(signed ? { evidence: signed.evidence } : {}) });
    if (legal[from].includes(to)) {
      const updated = await change;
      assert.equal(updated.state, to);
      assert.equal(updated.version, run.version + 1);
      assert.equal(updated.lastActor, 'actor-a');
    } else await assert.rejects(change, status(409));
  });
}
test('concurrent transitions compare version atomically and cannot overwrite cancellation', async t => {
  const { db } = fixture(t);
  const run = await createRun(db, context, input);
  const changes = await Promise.allSettled(['cancelled', 'running'].map(to => transitionRun(db, context, { id: run.id, expectedVersion: 1, to })));
  assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(changes.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal((await getRun(db, context.owner, run.id)).version, 2);
});
test('success rejects missing, forged, wrong-key and cross-contract receipts', async t => {
  const { db } = fixture(t);
  let run = await createRun(db, context, input);
  run = await transitionRun(db, context, { id: run.id, expectedVersion: 1, to: 'running' });
  await assert.rejects(transitionRun(db, context, { id: run.id, expectedVersion: 2, to: 'succeeded' }), status(409));
  const signed = await evidenceFor(run);
  await assert.rejects(transitionRun(db, context, { id: run.id, expectedVersion: 2, to: 'succeeded', evidence: signed.evidence }), status(409));
  const wrong = await evidenceFor(run);
  await assert.rejects(transitionRun(db, { ...context, evidenceTrust: wrong.trust }, { id: run.id, expectedVersion: 2, to: 'succeeded', evidence: signed.evidence }), status(409));
  for (const override of [{ owner: 'owner-b' }, { runId: 'other' }, { ticketRevision: 2 }, { ticketId: 'other' }, { attempt: 2 }, { authorizationId: 'other' }, { contractSha256: '0'.repeat(64) }, { exitCode: 1 }, { status: 'failed' }, { keyId: 'other' }]) {
    const bad = await evidenceFor(run, override, signed.keys);
    await assert.rejects(transitionRun(db, { ...context, evidenceTrust: signed.trust }, { id: run.id, expectedVersion: 2, to: 'succeeded', evidence: bad.evidence }), status(409));
  }
  const forged = structuredClone(signed.evidence);
  forged.claims.backendId = 'forged';
  await assert.rejects(transitionRun(db, { ...context, evidenceTrust: signed.trust }, { id: run.id, expectedVersion: 2, to: 'succeeded', evidence: forged }), status(409));
  const success = await transitionRun(db, { ...context, evidenceTrust: signed.trust }, { id: run.id, expectedVersion: 2, to: 'succeeded', evidence: signed.evidence });
  assert.deepEqual(success.evidence, signed.evidence);
});
test('legacy records remain byte-for-byte unchanged when execution Runs are created and cancelled', async t => {
  const { db, sqlite } = fixture(t);
  const old = sqlite.prepare('SELECT * FROM records WHERE id=?').get('legacy-run');
  const run = await createRun(db, context, input);
  await transitionRun(db, context, { id: run.id, expectedVersion: 1, to: 'cancelled' });
  assert.deepEqual(sqlite.prepare('SELECT * FROM records WHERE id=?').get('legacy-run'), old);
});
test('invalid or oversized stored Ticket contracts cannot enter execution storage', async t => {
  const { db, sqlite } = fixture(t);
  for (const body of ['[]', 'null', '"text"', '{broken', JSON.stringify({ title: 'x'.repeat(80000) })]) {
    sqlite.prepare('UPDATE records SET body=? WHERE id=?').run(body, 'ticket-1');
    await assert.rejects(createRun(db, context, input), status(400));
  }
  assert.deepEqual(await listRuns(db, context.owner), []);
});
test('database itself blocks immutable mutation, deletion and illegal edges', async t => {
  const { db, sqlite } = fixture(t);
  const run = await createRun(db, context, input);
  for (const column of ['ticket_body', 'owner', 'actor', 'authorization_id', 'request_id', 'input_key', 'created']) {
    assert.throws(() => sqlite.prepare(`UPDATE execution_runs SET ${column}=?,state='running',version=version+1 WHERE id=?`).run('changed', run.id), /Immutable execution contract/);
  }
  assert.throws(() => sqlite.prepare('DELETE FROM execution_runs WHERE id=?').run(run.id), /Execution history is immutable/);
  assert.throws(() => sqlite.prepare("UPDATE execution_runs SET state='succeeded',version=version+1 WHERE id=?").run(run.id), /Invalid execution transition/);
  await transitionRun(db, context, { id: run.id, expectedVersion: 1, to: 'cancelled' });
  assert.throws(() => sqlite.prepare("UPDATE execution_runs SET state='queued',version=version+1 WHERE id=?").run(run.id), /Invalid execution transition/);
});
test('create captures validated caller input before an asynchronous database boundary', async t => {
  const { db } = fixture(t);
  const mutable = { ...input };
  const mutableContext = { ...context };
  const pending = createRun(db, mutableContext, mutable);
  mutable.ticketId = 'missing'; mutable.authorizationId = 'changed'; mutableContext.owner = 'foreign';
  const run = await pending;
  assert.equal(run.ticketId, 'ticket-1'); assert.equal(run.authorizationId, 'authorization-1'); assert.equal(run.owner, 'owner-a');
});
test('transition retains exactly the receipt and trusted context validated at entry', async t => {
  const { db } = fixture(t);
  let run = await createRun(db, context, input);
  run = await transitionRun(db, context, { id: run.id, expectedVersion: 1, to: 'running' });
  const signed = await evidenceFor(run);
  const original = structuredClone(signed.evidence);
  const mutableContext = { ...context, evidenceTrust: { ...signed.trust } };
  const change = { id: run.id, expectedVersion: 2, to: 'succeeded', evidence: signed.evidence };
  const pending = transitionRun(db, mutableContext, change);
  change.to = 'cancelled'; signed.evidence.claims.backendId = 'mutated'; mutableContext.evidenceTrust.keyId = 'changed';
  const updated = await pending;
  assert.equal(updated.state, 'succeeded'); assert.deepEqual(updated.evidence, original);
});
