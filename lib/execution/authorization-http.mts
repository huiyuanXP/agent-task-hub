import type { ExecutionDatabase } from './types.mts';
import type { AuthorizationContext, DecisionInput, PrepareExecutionInput, RevokeInput } from './authorization-types.mts';
import { getOperationCatalog } from './catalog.mts';
import { decideAuthorization, getAuthorization, prepareExecution, revokeAuthorization } from './authorization.mts';
import { exactObject, ExecutionError, invalid } from './errors.mts';
import { readBody } from './http.mts';
const headers = { 'Cache-Control': 'no-store' };
export async function handleAuthorizationRequest(db: ExecutionDatabase, context: AuthorizationContext | null, request: Request): Promise<Response> {
  if (!context) return Response.json({ error: 'Authentication required' }, { status: 401, headers });
  try {
    if (request.method === 'GET') {
      const query = new URL(request.url).searchParams, keys = [...query.keys()];
      if (new Set(keys).size !== keys.length) invalid('Duplicate query fields');
      if (keys.length === 1 && query.has('id')) return Response.json({ authorization: await getAuthorization(db, context, query.get('id')!) }, { headers });
      if (keys.length !== 2 || !query.has('ticketId') || !query.has('expectedRevision') || !/^[1-9]\d*$/.test(query.get('expectedRevision')!)) invalid('Specify an authorization ID or Ticket revision');
      return Response.json(await getOperationCatalog(db, context, { ticketId: query.get('ticketId')!, expectedRevision: Number(query.get('expectedRevision')) }), { headers });
    }
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
    if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid request origin' }, { status: 403, headers });
    const body = await readBody(request);
    exactObject(body, ['action', 'ticketId', 'expectedRevision', 'requestId', 'attempt', 'scope', 'budget', 'expiresAt', 'authorizationId', 'decisionId', 'outcome']);
    const input = { ...body }; delete input.action;
    if (body.action === 'prepare') return Response.json(await prepareExecution(db, context, input as unknown as PrepareExecutionInput), { status: 201, headers });
    if (body.action === 'decide') return Response.json({ authorization: await decideAuthorization(db, context, input as unknown as DecisionInput) }, { headers });
    if (body.action === 'revoke') return Response.json({ authorization: await revokeAuthorization(db, context, input as unknown as RevokeInput) }, { headers });
    invalid('Unknown authorization action');
  } catch (error) {
    if (error instanceof ExecutionError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    console.error('Authorization storage unavailable');
    return Response.json({ error: 'Authorization storage unavailable' }, { status: 503, headers });
  }
}
