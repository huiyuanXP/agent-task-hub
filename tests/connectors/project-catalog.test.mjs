import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../lib/database.mts';
import { ensureProject, listProjects } from '../../lib/projects/catalog.mts';
import { inviteConnector, listConnections } from '../../lib/connectors/service.mts';

test('project catalog combines owner business records and registered projects while preserving stable identity and records', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-project-catalog-')), db = openDatabase(join(dir, 'test.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const owner of ['alice', 'bob']) await db.prepare('INSERT INTO local_users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,?)').bind(owner, owner, owner, 'synthetic-unused', Date.now()).run();
  const registered = await inviteConnector(db, 'alice', { action: 'invite', project: 'Registered only', name: 'Synthetic client', capabilities: ['read'] });
  await ensureProject(db, 'bob', 'Bob secret');
  const rows = [
    ['idea', 'Idea only'], ['plan', 'Plan only'], ['ticket', 'Ticket only'], ['idea', 'Registered only'],
    ['idea', ''], ['plan', null], ['idea', 'idea only'], ['history', 'History secret'], ['run', 'Manual secret'],
    ['ticket', 7], ['plan', 'x'.repeat(121)], ['idea', 'Invalid\nname'],
  ];
  for (let i = 0; i < rows.length; i++) {
    const [kind, project] = rows[i];
    await db.prepare('INSERT INTO records(id,owner,kind,body,revision,created,updated) VALUES(?,?,?,?,1,?,?)')
      .bind(`row-${i}`, 'alice', kind, JSON.stringify({ title: 'Synthetic', project }), '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z').run();
  }
  await db.prepare('INSERT INTO records(id,owner,kind,body,revision,created,updated) VALUES(?,?,?,?,1,?,?)')
    .bind('bob-record', 'bob', 'idea', JSON.stringify({ title: 'Private', project: 'Bob business' }), '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z').run();
  const before = await db.prepare('SELECT * FROM records ORDER BY id').all();
  const first = await listProjects(db, 'alice');
  assert.deepEqual(first.map(p => p.name), ['Idea only', 'Plan only', 'Registered only', 'Ticket only', 'idea only', '通用']);
  assert.equal(first.find(p => p.name === 'Registered only').id, registered.projectId);
  assert.deepEqual(await listProjects(db, 'alice'), first);
  assert.deepEqual((await listConnections(db, 'alice')).projects, first);
  assert.deepEqual(await db.prepare('SELECT * FROM records ORDER BY id').all(), before);
  assert.deepEqual((await listProjects(db, 'bob')).map(p => p.name), ['Bob business', 'Bob secret', '通用']);
  assert.equal((await db.prepare('SELECT count(*) n FROM workspace_runs').first()).n, 0);
  assert.equal((await db.prepare('SELECT count(*) n FROM execution_authorizations').first()).n, 0);
});
