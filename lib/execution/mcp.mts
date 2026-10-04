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
  { name: 'get_operation_catalog', description: 'Read owned Ticket revision and real fixed operation definitions. Catalog hashes bind the exact frozen input; this does not grant execution.', inputSchema: object({ ticketId: string, expectedRevision: integer }), annotations: read },
  { name: 'prepare_execution', description: 'Atomically reserve a queued Run and pending authorization for one exact catalog operation, resource budget and latest-start expiry. Use a stable requestId; no process starts.', inputSchema: object({ ticketId: string, expectedRevision: integer, requestId: string, attempt: integer, scope, budget, expiresAt: integer }), annotations: write },
  { name: 'get_authorization', description: 'Read owned immutable scope, budget, decision audit and effective pending/approved/rejected/revoked/expired/stale status.', inputSchema: object({ authorizationId: string }), annotations: read },
  { name: 'decide_authorization', description: 'Owner-only approve or reject a pending request without widening scope or budget. Stable decisionId makes identical retries idempotent. Worker leases never confer this capability.', inputSchema: object({ authorizationId: string, decisionId: string, outcome: { type: 'string', enum: ['approved', 'rejected'] } }), annotations: write },
  { name: 'revoke_authorization', description: 'Owner-only revoke pending/approved authorization. Blocks new starts and future lease renewal; cancellation of already dispatched work is a separate bounded process.', inputSchema: object({ authorizationId: string, decisionId: string }), annotations: write },
];
/** Focused dispatcher: existing planning tools remain in their original route. */
async function dispatch(db: ExecutionDatabase, context: AuthorizationContext, name: string, args: unknown): Promise<unknown> {
  if (!executionTools.some(tool => tool.name === name)) return undefined;
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
export async function dispatchExecutionTool(db: ExecutionDatabase, context: AuthorizationContext, name: string, args: unknown): Promise<unknown> {
  try { return await dispatch(db, context, name, args); }
  catch (error) {
    if (error instanceof ExecutionError) throw error;
    throw new ExecutionError('STORAGE_UNAVAILABLE', 'Execution storage unavailable', 503);
  }
}
