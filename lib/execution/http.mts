import type { CreateRunInput, ExecutionDatabase, ListRunFilters, RunContext } from './types.mts';
import { createRun, getRun, listRuns, transitionRun } from './runs.mts';
import { exactObject, ExecutionError, invalid } from './errors.mts';

const headers = { 'Cache-Control': 'no-store' };
export async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ExecutionError('UNSUPPORTED_MEDIA', 'JSON required', 415);
  const length = request.headers.get('content-length');
  if (length !== null) {
    if (!/^\d+$/.test(length)) invalid('Invalid Content-Length');
    if (Number(length) > 16384) throw new ExecutionError('BODY_TOO_LARGE', 'Maximum request body is 16384 bytes', 413);
  }
  if (!request.body) invalid('JSON body required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 16384) { await reader.cancel(); throw new ExecutionError('BODY_TOO_LARGE', 'Maximum request body is 16384 bytes', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { invalid('Malformed JSON'); }
}
/** Caller supplies trusted identity; HTTP payloads cannot construct backend trust. */
export async function handleExecutionRequest(db: ExecutionDatabase, context: RunContext | null, request: Request): Promise<Response> {
  if (!context) return Response.json({ error: 'Authentication required' }, { status: 401, headers });
  try {
    if (request.method === 'GET') {
      const query = new URL(request.url).searchParams;
      const keys = Array.from(query.keys());
      if (new Set(keys).size !== keys.length || keys.some(key => !['id', 'ticketId', 'state', 'limit'].includes(key))) invalid('Invalid query');
      if (query.has('id')) {
        if (keys.length !== 1) invalid('ID cannot be combined with filters');
        return Response.json({ run: await getRun(db, context.owner, query.get('id')!) }, { headers });
      }
      const filters: ListRunFilters = {};
      if (query.has('ticketId')) filters.ticketId = query.get('ticketId')!;
      if (query.has('state')) filters.state = query.get('state') as ListRunFilters['state'];
      if (query.has('limit')) {
        if (!/^[1-9]\d*$/.test(query.get('limit')!)) invalid('Invalid limit');
        filters.limit = Number(query.get('limit'));
      }
      return Response.json({ runs: await listRuns(db, context.owner, filters) }, { headers });
    }
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
    if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid request origin' }, { status: 403, headers });
    const body = await readBody(request);
    exactObject(body, ['action', 'ticketId', 'expectedRevision', 'requestId', 'authorizationId', 'attempt', 'id', 'expectedVersion']);
    if (body.action === 'create') {
      const input = { ...body }; delete input.action;
      const run = await createRun(db, context, input as unknown as CreateRunInput);
      return Response.json({ run }, { status: 201, headers });
    }
    if (body.action === 'cancel') {
      exactObject(body, ['action', 'id', 'expectedVersion']);
      // Never forward a client-supplied lifecycle destination or evidence.
      const run = await transitionRun(db, { owner: context.owner, actor: context.actor }, { id: body.id as string, expectedVersion: body.expectedVersion as number, to: 'cancelled' });
      return Response.json({ run }, { headers });
    }
    invalid('Only create and cancel actions are available');
  } catch (error) {
    if (error instanceof ExecutionError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    console.error('Execution storage unavailable');
    return Response.json({ error: 'Execution storage unavailable' }, { status: 503, headers });
  }
}
