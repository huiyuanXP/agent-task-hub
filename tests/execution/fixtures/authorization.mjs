import { context } from '../sqlite.mjs';
import { getOperationCatalog } from '../../../lib/execution/catalog.mts';
import { prepareExecution, decideAuthorization } from '../../../lib/execution/authorization.mts';
export async function authorized(db, overrides = {}) {
  const owner = { ...context, grantAuthority: 'owner', ...overrides }; const { operations } = await getOperationCatalog(db, owner, { ticketId: 'ticket-1', expectedRevision: 1 });
  const prepared = await prepareExecution(db, owner, { ticketId: 'ticket-1', expectedRevision: 1, requestId: 'permit-test', attempt: 1, scope: [{ operationId: operations[0].operationId, definitionHash: operations[0].definitionHash }], budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + 60000 });
  await decideAuthorization(db, owner, { authorizationId: prepared.authorization.id, decisionId: 'approve', outcome: 'approved' }); return { ...prepared, owner };
}
