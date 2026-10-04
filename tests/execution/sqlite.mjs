import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Executes actual SQL; only the D1 wire interface is adapted.
export function sqliteAdapter(sqlite) {
  return {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        execute() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
      statement.run = async () => statement.execute();
      return statement;
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        // No await inside the native transaction: concurrent batches cannot interleave.
        for (const statement of statements) results.push(statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

export function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'execution-sqlite-'));
  const path = join(directory, 'test.sqlite');
  const sqlite = new DatabaseSync(path);
  for (const migration of readdirSync(new URL('../../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(`../../drizzle/${migration}`, import.meta.url), 'utf8'));
  }
  t.after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  const now = new Date(Date.now() - 1000).toISOString();
  const body = '{"title":"Frozen ticket","scope":"only declared operations","status":"todo"}';
  sqlite.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').run('ticket-1', 'owner-a', 'ticket', body, 1, now, now);
  sqlite.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').run('legacy-run', 'owner-a', 'run', '{"title":"Manual snapshot","source":"execution","contract":{"title":"Old"}}', 1, now, now);
  return { db: sqliteAdapter(sqlite), sqlite, body, path };
}

export const context = { owner: 'owner-a', actor: 'actor-a' };
export const input = { ticketId: 'ticket-1', expectedRevision: 1, requestId: 'request-1', authorizationId: 'authorization-1', attempt: 1 };
export function status(expected) {
  return error => error.status === expected && typeof error.code === 'string';
}

export async function evidenceFor(run, overrides = {}, keyPair) {
  const keys = keyPair ?? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const digest = async value => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
  const claims = {
    version: 1, keyId: 'backend-test-key', owner: run.owner, runId: run.id,
    ticketId: run.ticketId, ticketRevision: run.ticketRevision, attempt: run.attempt,
    authorizationId: run.authorizationId, contractSha256: await digest(run.ticketBody),
    status: 'succeeded', backendId: 'synthetic-signed-backend', exitCode: 0,
    artifacts: [{ path: 'output/result.json', sha256: await digest('{"ok":true}'), bytes: 11 }],
    stdoutSha256: await digest('ok\n'), stderrSha256: await digest(''),
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), ...overrides,
  };
  // Hand-authored wire order, independent of production signing-payload helper.
  const payload = JSON.stringify(claims);
  const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(payload))).toString('hex');
  return { evidence: { claims, signature }, trust: { keyId: 'backend-test-key', key: keys.publicKey }, keys };
}
