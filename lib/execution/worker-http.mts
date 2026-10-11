import type { LocalDatabase } from '../database.mts';
import { AuthError, configuredOrigin } from '../local-auth.mts';
import { ExecutionError, exactObject, invalid } from './errors.mts';
import { readBody } from './http.mts';
import { resolveWorkerIssuer } from './worker-auth.mts';
import { listWorkers, provisionWorker, revokeWorker } from './workers.mts';

const headers = { 'Cache-Control': 'private, no-store' };
export function workerHttpError(error: unknown): Response {
  if (error instanceof AuthError) return Response.json({ error: error.message }, { status: error.status, headers });
  if (error instanceof ExecutionError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
  return Response.json({ error: 'Worker storage unavailable' }, { status: 503, headers });
}
/** Identity comes from the actual request credential, never owner fields. */
export async function handleWorkersRequest(db: LocalDatabase, request: Request, origin = configuredOrigin()): Promise<Response> {
  try {
    const issuer = await resolveWorkerIssuer(db, request.headers, request.method, origin);
    const query = new URL(request.url).searchParams;
    if (query.size) invalid('Worker management does not accept query parameters');
    if (request.method === 'GET') return Response.json({ workers: await listWorkers(db, issuer) }, { headers });
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
    const body = await readBody(request);
    exactObject(body, ['action', 'credentialId', 'requestId', 'runId', 'verifier', 'label']);
    const input = { ...body }; delete input.action;
    if (body.action === 'provision') return Response.json({ worker: await provisionWorker(db, issuer, input) }, { status: 201, headers });
    if (body.action === 'revoke') return Response.json({ worker: await revokeWorker(db, issuer, input) }, { headers });
    invalid('Only provision and revoke Worker actions are available');
  } catch (error) { return workerHttpError(error); }
}
