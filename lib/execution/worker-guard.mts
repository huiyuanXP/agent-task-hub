import { randomUUID } from 'node:crypto';
import type { LocalDatabase, LocalStatement, SqlValue } from '../database.mts';
import type { ExecutionDatabase, ExecutionStatement } from './types.mts';
import type { WorkerIssuer, WorkerPrincipal } from './worker-types.mts';
import { issuerAuthorizationPredicate, workerAuthorizationPredicate } from './worker-auth.mts';
import { ExecutionError } from './errors.mts';

type Predicate = { sql: string; values: SqlValue[] };
const denied = () => new ExecutionError('AUTHORIZATION_DENIED', 'Worker delegation is no longer valid', 403);

/** Statements stay tied to this wrapper and its original SQLite handle. */
function guardedDatabase(db: LocalDatabase, predicate: Predicate): ExecutionDatabase {
  predicate = { sql: predicate.sql, values: [...predicate.values] };
  const originals = new WeakMap<ExecutionStatement, LocalStatement>();
  async function checkRead() {
    const row = await db.prepare(`SELECT (${predicate.sql}) AS authorized`).bind(...predicate.values).first<{ authorized: number }>();
    if (row?.authorized !== 1) throw denied();
  }
  async function batch(statements: ExecutionStatement[]) {
    const raw = statements.map(statement => {
      const original = originals.get(statement);
      if (!original) throw new ExecutionError('AUTHORIZATION_DENIED', 'Statement belongs to another Worker database', 403);
      return original;
    });
    const before = randomUUID(), after = randomUUID();
    const check = (id: string) => db.prepare(`INSERT INTO execution_worker_checks(id,valid) VALUES(?,(${predicate.sql}))`).bind(id, ...predicate.values);
    try {
      const results = await db.batch([
        check(before), ...raw, check(after),
        db.prepare('DELETE FROM execution_worker_checks WHERE id IN (?,?)').bind(before, after),
      ]);
      return results.slice(1, -2);
    } catch (error) {
      if (error instanceof Error && error.message.includes('CHECK constraint failed: execution_worker_authorized')) throw denied();
      throw error;
    }
  }
  function wrap(original: LocalStatement, sql: string): ExecutionStatement {
    const statement: ExecutionStatement = {
      bind(...values) { return wrap(original.bind(...values), sql); },
      async first<T>() {
        // RETURNING and writable CTEs must never bypass the write transaction.
        if (!/^\s*SELECT\b/i.test(sql)) throw denied();
        await checkRead(); const value = await original.first<T>(); await checkRead(); return value;
      },
      async all<T>() {
        if (!/^\s*SELECT\b/i.test(sql)) throw denied();
        await checkRead(); const value = await original.all<T>(); await checkRead(); return value;
      },
      async run() { return (await batch([statement]))[0]; },
    };
    originals.set(statement, original);
    return statement;
  }
  return { prepare(sql) { return wrap(db.prepare(sql), sql); }, batch };
}

/** Owner writes retain the exact local credential that authorized provisioning. */
export function guardedIssuerDatabase(db: LocalDatabase, issuer: WorkerIssuer): ExecutionDatabase {
  return guardedDatabase(db, issuerAuthorizationPredicate({ ...issuer }));
}
/** Every consequential Worker write checks the whole delegation inside SQLite. */
export function guardedWorkerDatabase(db: LocalDatabase, principal: WorkerPrincipal): ExecutionDatabase {
  return guardedDatabase(db, workerAuthorizationPredicate({ ...principal }));
}
