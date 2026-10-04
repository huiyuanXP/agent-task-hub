// Actual built Vinext Worker + Miniflare workerd/D1 over loopback HTTP.
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { input } from './sqlite.mjs';

const directory = mkdtempSync(join(tmpdir(), 'execution-worker-d1-'));
const state = join(directory, 'd1');
let base;
let worker;
let database;
async function sql(query) { return (await database.prepare(query).all()).results; }
const identity = owner => ({ 'oai-authenticated-user-id': owner, 'oai-authenticated-user-email': `${owner}@example.test` });
async function request(path = '/api/execution', { owner = 'owner-a', body, method, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(owner ? identity(owner) : {}), ...(body === undefined ? {} : { origin: base, 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text: text.slice(0, 300), cache: response.headers.get('cache-control') };
}
async function expectStatus(expected, path, options) {
  const result = await request(path, options);
  assert.equal(result.status, expected, JSON.stringify({ json: result.json, text: result.text }));
  return result.json;
}
try {
  const config = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
  worker = new Miniflare({
    host: '127.0.0.1', port: 0,
    modulesRoot: 'dist/server',
    modules: [config.main, ...readdirSync('dist/server', { recursive: true }).filter(path => /\.m?js$/.test(path) && path !== config.main)]
      .map(path => ({ type: 'ESModule', path: join('dist/server', path) })),
    bindings: { AUTH_MODE: 'trusted-sites', AUTH_TRUST_SITES_HEADERS: '1' },
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    d1Databases: { DB: '00000000-0000-4000-8000-000000000000' }, d1Persist: state,
  });
  database = await worker.getD1Database('DB');
  for (const migration of readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join('drizzle', migration), 'utf8').split('--> statement-breakpoint').filter(sql => sql.trim())) {
      await database.prepare(statement).run();
    }
    console.log(`D1 migration applied: ${migration}`);
  }
  await database.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind('ticket-1', 'owner-a', 'ticket', '{"title":"Frozen local Ticket","status":"todo"}', 1, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z').run();
  await database.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind('legacy-run', 'owner-a', 'run', '{"title":"Manual snapshot","source":"execution","contract":{"title":"Old"}}', 1, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z').run();
  const legacy = (await sql("SELECT * FROM records WHERE id='legacy-run'"))[0];
  const tableNames = (await sql("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name);
  for (const table of ['records', 'jobs', 'subscriptions', 'execution_runs']) assert.ok(tableNames.includes(table));
  base = (await worker.ready).origin;
  await expectStatus(401, '/api/execution', { owner: null });
  await expectStatus(403, '/api/execution', { body: { action: 'create', ...input }, headers: { origin: 'https://foreign.example' } });
  await expectStatus(409, '/api/execution', { body: { action: 'create', ...input, expectedRevision: 2 } });
  await expectStatus(404, '/api/execution', { owner: 'owner-b', body: { action: 'create', ...input } });
  console.log('Worker API: anonymous401, origin403, stale409, foreign Ticket404');
  const initialCreates = await Promise.all(Array.from({ length: 6 }, () => request('/api/execution', { body: { action: 'create', ...input } })));
  for (const result of initialCreates) assert.equal(result.status, 201, JSON.stringify(result.json));
  const { run } = initialCreates[0].json;
  assert.equal(new Set(initialCreates.map(result => result.json.run.id)).size, 1);
  assert.equal((await sql("SELECT count(*) AS total FROM execution_runs WHERE ticket_id='ticket-1'"))[0].total, 1);
  assert.equal(run.owner, 'owner-a'); assert.equal(run.actor, 'owner-a'); assert.equal(run.source, 'execution'); assert.equal(run.state, 'queued');
  const retries = await Promise.all(Array.from({ length: 6 }, () => request('/api/execution', { body: { action: 'create', ...input } })));
  for (const retry of retries) { assert.equal(retry.status, 201); assert.equal(retry.json.run.id, run.id); }
  await database.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind('ticket-distinct-race', 'owner-a', 'ticket', '{"title":"Distinct-request race","status":"todo"}', 1, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z').run();
  const distinctCreates = await Promise.all(Array.from({ length: 6 }, (_, n) => request('/api/execution', { body: { action: 'create', ...input, ticketId: 'ticket-distinct-race', requestId: 'distinct-race-' + n } })));
  const winners = distinctCreates.filter(result => result.status === 201);
  const conflicts = distinctCreates.filter(result => result.status === 409);
  assert.equal(winners.length, 1, JSON.stringify(distinctCreates));
  assert.equal(conflicts.length, 5, JSON.stringify(distinctCreates));
  for (const result of conflicts) assert.equal(result.json.code, 'ACTIVE_RUN');
  const distinctRows = await sql("SELECT id,request_id,state FROM execution_runs WHERE ticket_id='ticket-distinct-race'");
  assert.equal(distinctRows.length, 1); assert.equal(distinctRows[0].id, winners[0].json.run.id);
  assert.equal(distinctRows[0].request_id, winners[0].json.run.requestId); assert.equal(distinctRows[0].state, 'queued');
  console.log('Worker API: initial identical creates201 one row, existing retries201 one ID, distinct initial creates one201/five409 one active row');
  await expectStatus(409, '/api/execution', { body: { action: 'create', ...input, attempt: 2 } });
  await expectStatus(409, '/api/execution', { body: { action: 'create', ...input, requestId: 'second-request' } });
  const read = await request('/api/execution?id=' + run.id); assert.equal(read.status, 200); assert.equal(read.cache, 'no-store');
  await expectStatus(404, '/api/execution?id=' + run.id, { owner: 'owner-b' });
  assert.deepEqual((await expectStatus(200, '/api/execution', { owner: 'owner-b' })).runs, []);
  console.log('Worker API: changed retry409, active Ticket409, read200, foreign Run404/list empty');
  for (const body of ['{', 'null', '[]', '"string"', { action: 'create', ...input, owner: 'forged' }, { action: 'create', ...input, state: 'running' }, { action: 'transition', to: 'succeeded', evidence: {} }, { action: 'cancel', id: run.id, expectedVersion: 1, evidence: {} }]) {
    await expectStatus(400, '/api/execution', { body });
  }
  await expectStatus(413, '/api/execution', { body: 'x'.repeat(16385) });
  await expectStatus(413, '/api/execution', { body: '"' + '界'.repeat(5500) + '"' });
  await expectStatus(415, '/api/execution', { body: '{}', headers: { 'content-type': 'text/plain' } });
  console.log('Worker API: malformed/object/schema/forged transitions400, byte limit413, wrong media415');
  const ticketEdit = await expectStatus(200, '/api/records', { body: { id: 'ticket-1', kind: 'ticket', revision: 1, title: 'Changed Ticket', status: 'todo' } });
  assert.equal(ticketEdit.revision, 2);
  const frozen = (await expectStatus(200, '/api/execution?id=' + run.id)).run;
  assert.equal(frozen.ticketBody, '{"title":"Frozen local Ticket","status":"todo"}'); assert.equal(frozen.ticketRevision, 1);
  assert.equal((await expectStatus(201, '/api/execution', { body: { action: 'create', ...input } })).run.id, run.id);
  const manual = (await expectStatus(200, '/api/records')).records.find(record => record.id === 'legacy-run');
  assert.equal(manual.source, 'manual');
  await expectStatus(400, '/api/records', { body: { id: 'legacy-run', kind: 'run', revision: 1, title: 'Tamper' } });
  const cancelled = await expectStatus(200, '/api/execution', { body: { action: 'cancel', id: run.id, expectedVersion: 1 } });
  assert.equal(cancelled.run.state, 'cancelled');
  await expectStatus(409, '/api/execution', { body: { action: 'cancel', id: run.id, expectedVersion: 1 } });
  const successor = await expectStatus(201, '/api/execution', { body: { action: 'create', ...input, expectedRevision: 2, requestId: 'later', attempt: 2 } });
  assert.notEqual(successor.run.id, run.id);
  assert.deepEqual((await sql("SELECT * FROM records WHERE id='legacy-run'"))[0], legacy);
  assert.equal((await sql('SELECT count(*) AS total FROM execution_runs'))[0].total, 3);
  console.log('Worker API: immutable old body/revision, cancel CAS, next attempt, legacy manual display + unchanged stored snapshot PASS');
  console.log('PASS actual built Worker/D1 API isolation, migrations and regressions');
} finally {
  try { if (worker) await worker.dispose(); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
