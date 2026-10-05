import type { ExecutionDatabase } from './types.mts';
import type { WorkerPrincipal, ClaimInput, LeaseInput } from './worker-types.mts';
import type { BackendEnvironment } from './backend-config.mts';
import { configuredRegistry } from './backend-config.mts';
import { exactObject, ExecutionError } from './errors.mts';
import { claimExecution, renewExecution, reportExecution, startExecution, completeExecution, cancelExecution, getExecutionRun } from './leases.mts';
const id = { type: 'string', minLength: 1, maxLength: 200 }, requestId = id;
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const write = { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false };
const read = { readOnlyHint: true, openWorldHint: false };
const leased = { runId: id, requestId, leaseToken: { type: 'string', minLength: 1, maxLength: 256, pattern: '^athl1\\.[A-Za-z0-9_-]+\\.[1-9][0-9]*\\.[A-Za-z0-9_-]{43}$' } };
export const workerTools = [
    { name: 'get_execution_run', description: 'Read the delegated frozen Run and its existing permit deadline and stop confirmation.', inputSchema: object({ runId: id }), annotations: read },
    { name: 'list_execution_runs', description: 'Read only the single delegated Run.', inputSchema: object({}), annotations: read },
    { name: 'claim_execution_run', description: 'Claim one exclusive six-second generation using a pre-persisted secret verifier; reconcile mode requires an existing permit.', inputSchema: object({ runId: id, requestId, leaseId: { ...id, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }, verifier: { type: 'string', pattern: '^[a-f0-9]{64}$' }, mode: { type: 'string', enum: ['execute', 'reconcile'] } }), annotations: write },
    { name: 'start_execution_run', description: 'Start or adopt the fixed execution through its immutable permit; requires current execution lease and approved grant.', inputSchema: object(leased), annotations: write },
    { name: 'renew_execution_run', description: 'Renew a current execution lease under its current grant. Reconciliation leases cannot renew.', inputSchema: object(leased), annotations: write },
    { name: 'report_execution_run', description: 'Record bounded progress without asserting lifecycle or success.', inputSchema: object({ ...leased, message: { type: 'string', maxLength: 2048 } }), annotations: write },
    { name: 'complete_execution_run', description: 'Fetch and verify the existing backend result. Only trusted bound evidence can complete a Run.', inputSchema: object(leased), annotations: write },
    { name: 'cancel_execution_run', description: 'Request owned cancellation and reconcile physical stop. Logical cancellation alone does not confirm stop.', inputSchema: object(leased), annotations: { ...write, destructiveHint: true } },
];
export async function dispatchWorkerTool(db: ExecutionDatabase, p: WorkerPrincipal, name: string, args: unknown, env: BackendEnvironment) {
    // Fixed capability gate precedes all dispatch, including hidden owner tools.
    if (!workerTools.some(t => t.name === name))
        throw new ExecutionError('AUTHORIZATION_DENIED', 'Worker capability denied', 403);
    try {
        if (name === 'get_execution_run') {
            exactObject(args, ['runId']);
            return getExecutionRun(db, p, args.runId as string);
        }
        if (name === 'list_execution_runs') {
            exactObject(args, []);
            return { runs: [(await getExecutionRun(db, p, p.runId)).run] };
        }
        if (name === 'claim_execution_run')
            return await claimExecution(db, p, args as ClaimInput, { registry: configuredRegistry(env) });
        if (name === 'renew_execution_run')
            return await renewExecution(db, p, args as LeaseInput, { registry: configuredRegistry(env) });
        if (name === 'report_execution_run')
            return await reportExecution(db, p, args as LeaseInput & {
                message: string;
            });
        if (name === 'start_execution_run')
            return await startExecution(db, p, args as LeaseInput, env);
        if (name === 'complete_execution_run')
            return await completeExecution(db, p, args as LeaseInput, env);
        return await cancelExecution(db, p, args as LeaseInput, env);
    }
    catch (error) {
        if (error instanceof ExecutionError)
            throw error;
        throw new ExecutionError('STORAGE_UNAVAILABLE', 'Worker execution unavailable', 503);
    }
}
