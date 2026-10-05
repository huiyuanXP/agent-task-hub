import { getRun, listRuns } from './runs.mts';
import type { ListRunFilters } from './types.mts';
import type { ExecutionDatabase } from './types.mts';
import type { AuthorizationContext, DecisionInput, PrepareExecutionInput, RevokeInput } from './authorization-types.mts';
import { decideAuthorization, getAuthorization, prepareExecution, revokeAuthorization } from './authorization.mts';
import { getOperationCatalog } from './catalog.mts';
import { exactObject, ExecutionError } from './errors.mts';
const string = { type: 'string' };
const integer = { type: 'integer', minimum: 1 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const budget = object({ timeoutMs: { ...integer, maximum: 30000 }, memoryMb: { ...integer, maximum: 256 }, cpus: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, pids: { ...integer, maximum: 64 } });
const scope = { type: 'array', minItems: 1, maxItems: 1, items: object({ operationId: string, definitionHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }) };
const read = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false };
export const executionTools = [
  { name: 'get_execution_run', description: 'Read one owned frozen execution Run for explicit delegation selection.', inputSchema: object({ runId: string }), annotations: read },
  { name: 'list_execution_runs', description: 'List owned execution Runs with bounded filters.', inputSchema: object({ ticketId: string, state: { type: 'string', enum: ['queued','running','waiting','succeeded','failed','cancelled'] }, limit: { ...integer, maximum: 100 } }, []), annotations: read },
  { name: 'get_operation_catalog', description: 'Read owned Ticket revision and real fixed operation definitions. Catalog hashes bind the exact frozen input; this does not grant execution.', inputSchema: object({ ticketId: string, expectedRevision: integer }), annotations: read },
  { name: 'prepare_execution', description: 'Atomically reserve a queued Run and pending authorization for one exact catalog operation, resource budget and latest-start expiry. Use a stable requestId; no process starts.', inputSchema: object({ ticketId: string, expectedRevision: integer, requestId: string, attempt: integer, scope, budget, expiresAt: integer }), annotations: write },
  { name: 'get_authorization', description: 'Read owned immutable scope, budget, decision audit and effective pending/approved/rejected/revoked/expired/stale status.', inputSchema: object({ authorizationId: string }), annotations: read },
  { name: 'decide_authorization', description: 'Owner-only approve or reject a pending request without widening scope or budget. Stable decisionId makes identical retries idempotent. Worker leases never confer this capability.', inputSchema: object({ authorizationId: string, decisionId: string, outcome: { type: 'string', enum: ['approved', 'rejected'] } }), annotations: write },
  { name: 'revoke_authorization', description: 'Owner-only revoke pending/approved authorization. Blocks new starts and future lease renewal; cancellation of already dispatched work is a separate bounded process.', inputSchema: object({ authorizationId: string, decisionId: string }), annotations: write },
];
/** Focused dispatcher: existing planning tools remain in their original route. */
async function dispatch(db: ExecutionDatabase, context: AuthorizationContext, name: string, args: unknown): Promise<unknown> {
  if (name === 'get_execution_run') { exactObject(args, ['runId']); return { run: await getRun(db, context.owner, args.runId as string) }; }
  if (name === 'list_execution_runs') { exactObject(args, ['ticketId', 'state', 'limit']); return { runs: await listRuns(db, context.owner, args as ListRunFilters) }; }
  if (name === 'get_operation_catalog') {
    exactObject(args, ['ticketId', 'expectedRevision']);
    return getOperationCatalog(db, context, args as unknown as { ticketId: string; expectedRevision: number });
  }
  if (name === 'prepare_execution') return prepareExecution(db, context, args as PrepareExecutionInput);
  if (name === 'get_authorization') {
    exactObject(args, ['authorizationId']); return getAuthorization(db, context, args.authorizationId as string);
  }
  if (name === 'decide_authorization') return decideAuthorization(db, context, args as DecisionInput);
  return revokeAuthorization(db, context, args as RevokeInput);
}

/** Isolate unexpected execution storage/crypto errors from legacy route diagnostics. */
export async function dispatchExecutionTool(db: ExecutionDatabase, context: AuthorizationContext | (() => AuthorizationContext), name: string, args: unknown): Promise<unknown> {
  if (!executionTools.some(tool => tool.name === name)) return undefined;
  try {
    let resolved: AuthorizationContext;
    try { resolved = typeof context === 'function' ? context() : context; }
    catch { throw new ExecutionError('CONFIGURATION_UNAVAILABLE', 'Execution configuration unavailable', 503); }
    return await dispatch(db, resolved, name, args);
  }
  catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError('STORAGE_UNAVAILABLE', 'Execution storage unavailable', 503);
  }
}
