import type { ExecutionDatabase, ExecutionStatement } from './types.mts';
import type { WorkerPrincipal, LeaseRow } from './worker-types.mts';
import { ExecutionError } from './errors.mts';
export interface SqlGuard {
    sql: string;
    values: (string | number | null)[];
}
// SQLite evaluates 'now' at the SQL mutation boundary, not a prior JS await.
export const SQL_NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
export const denied = () => new ExecutionError('WORKER_AUTHORITY_EXPIRED', 'Current worker authority required', 403);
export function credentialGuard(p: WorkerPrincipal): SqlGuard {
    return { sql: `EXISTS(SELECT 1 FROM execution_worker_credentials c JOIN execution_runs r ON r.id=c.run_id AND r.owner=c.owner
    WHERE c.id=? AND c.owner=? AND c.principal_id=? AND c.run_id=? AND c.ticket_id=r.ticket_id
      AND c.ticket_revision=r.ticket_revision AND c.attempt=r.attempt AND c.authorization_id=r.authorization_id
      AND c.revoked_at IS NULL AND c.expires_at>${SQL_NOW}
      AND NOT EXISTS(SELECT 1 FROM auth_revocations v WHERE v.token_hash=c.token_hash))`,
        values: [p.credentialId, p.owner, p.actor, p.runId] };
}
export function combine(...guards: SqlGuard[]): SqlGuard {
    return { sql: guards.map(g => '(' + g.sql + ')').join(' AND '), values: guards.flatMap(g => g.values) };
}
export function leaseGuard(p: WorkerPrincipal, l: LeaseRow): SqlGuard {
    return combine(credentialGuard(p), { sql: `EXISTS(SELECT 1 FROM execution_leases l WHERE l.id=? AND l.credential_id=? AND l.principal_id=?
    AND l.run_id=? AND l.owner=? AND l.generation=? AND l.mode=? AND l.expires_at>${SQL_NOW}
    AND l.generation=(SELECT MAX(generation) FROM execution_leases WHERE owner=l.owner AND run_id=l.run_id))`,
        values: [l.id, p.credentialId, p.actor, p.runId, p.owner, l.generation, l.mode] });
}
/** Guard checks and ALL existing service mutations share one D1 transaction.
 * A failed CHECK rolls back every preceding statement. No check row survives.
 * Wrapped statements are unwrapped only here, preventing accidentally unguarded run(). */
export function guardedDatabase(db: ExecutionDatabase, guard: SqlGuard): ExecutionDatabase {
    const originals = new WeakMap<ExecutionStatement, ExecutionStatement>();
    const batch = async (statements: ExecutionStatement[]) => {
        const id = crypto.randomUUID();
        const check = () => db.prepare(`INSERT INTO execution_worker_checks(id,valid) VALUES (?,CASE WHEN ${guard.sql} THEN 1 ELSE 0 END)`).bind(id, ...guard.values);
        const remove = () => db.prepare('DELETE FROM execution_worker_checks WHERE id=?').bind(id);
        try {
            const result = await db.batch([check(), remove(), ...statements.map(s => originals.get(s) ?? s), check(), remove()]);
            return result.slice(2, -2);
        }
        catch (error) {
            // Constraint details are internal and may include caller input. Fail closed.
            if (String(error).includes('execution_worker_authority'))
                throw denied();
            throw error;
        }
    };
    return { batch, prepare(sql) {
            let original = db.prepare(sql);
            const wrapped: ExecutionStatement = { bind(...values) { original = original.bind(...values); originals.set(wrapped, original); return wrapped; }, first: <T,>() => original.first<T>(), all: <T,>() => original.all<T>(), run: async () => (await batch([wrapped]))[0] };
            originals.set(wrapped, original);
            return wrapped;
        } };
}
export async function checkGuard(db: ExecutionDatabase, guard: SqlGuard) { await guardedDatabase(db, guard).batch([]); }
