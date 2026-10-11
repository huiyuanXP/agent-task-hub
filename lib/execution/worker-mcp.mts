import type { LocalDatabase } from '../database.mts';
import { AuthError, configuredOrigin } from '../local-auth.mts';
import type { WorkerPrincipal } from './worker-types.mts';
import type { BackendEnvironment } from './backend-config.mts';
import { configuredRegistry } from './backend-config.mts';
import { claimExecutionRun, renewExecutionRun, reportExecutionRun } from './worker-leases.mts';
import { startExecutionRun, completeExecutionRun, cancelExecutionRun } from './worker-actions.mts';
import { authenticateWorkerHeaders } from './worker-auth.mts';
import { guardedWorkerDatabase } from './worker-guard.mts';
import { boundedId, exactObject, ExecutionError, invalid } from './errors.mts';
import { getRun } from './runs.mts';
import { readBody } from './http.mts';
import { workerHttpError } from './worker-http.mts';

export const MAX_WORKER_RESPONSE_BYTES = 1024 * 1024;
const headers = { 'Cache-Control': 'private, no-store' };
const leasedProperties = { runId: { type: 'string', maxLength: 200 }, requestId: { type: 'string', maxLength: 128 }, leaseToken: { type: 'string', maxLength: 200 } };
const leasedTool = (name: string, description: string, report = false) => ({ name, description, inputSchema: { type: 'object', properties: { ...leasedProperties, ...(report ? { message: { type: 'string', maxLength: 2048 } } : {}) }, required: ['runId', 'requestId', 'leaseToken', ...(report ? ['message'] : [])], additionalProperties: false } });
const tools = [
  { name: 'get_execution_run', description: 'Read this delegated execution Run and its existing permit summary', inputSchema: { type: 'object', properties: { runId: { type: 'string', maxLength: 200 } }, required: ['runId'], additionalProperties: false } },
  { name: 'list_execution_runs', description: 'Read the single execution Run delegated to this Worker', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'claim_execution_run', description: 'Claim a six-second exclusive execute or historical reconcile generation', inputSchema: { type: 'object', properties: { runId: leasedProperties.runId, requestId: leasedProperties.requestId, leaseId: { type: 'string', maxLength: 36 }, verifier: { type: 'string', maxLength: 64 }, mode: { type: 'string', enum: ['execute', 'reconcile'] } }, required: ['runId', 'requestId', 'leaseId', 'verifier', 'mode'], additionalProperties: false } },
  leasedTool('start_execution_run', 'Start the fixed operation with the current approved execute lease'),
  leasedTool('renew_execution_run', 'Renew the current approved execute generation'),
  leasedTool('report_execution_run', 'Retain a bounded idempotent progress message', true),
  leasedTool('complete_execution_run', 'Reconcile the existing permit and require a trusted result'),
  leasedTool('cancel_execution_run', 'Request cancellation and separately reconcile signed physical closure'),
];
function response(value: unknown): Response {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_WORKER_RESPONSE_BYTES) throw new ExecutionError('RESPONSE_TOO_LARGE', 'Worker response exceeds 1 MiB', 413);
  return new Response(json, { headers: { ...headers, 'Content-Type': 'application/json' } });
}
async function delegatedRun(db: LocalDatabase, principal: WorkerPrincipal) {
  const guarded = guardedWorkerDatabase(db, principal);
  const run = await getRun(guarded, principal.owner, principal.runId);
  const permit = await guarded.prepare('SELECT id,deadline_ms,cancel_requested,closed_at FROM execution_permits WHERE owner=? AND run_id=?')
    .bind(principal.owner, principal.runId).first<{ id: string; deadline_ms: number; cancel_requested: number; closed_at: number | null }>();
  // No issuer/verifier, request metadata, raw evidence or signing material.
  return { id: run.id, ticketId: run.ticketId, ticketRevision: run.ticketRevision, project: principal.project,
    attempt: run.attempt, state: run.state, version: run.version, source: run.source,
    contract: JSON.parse(run.ticketBody), created: run.created, updated: run.updated,
    permit: permit ? { permitId: permit.id, deadlineMs: permit.deadline_ms, cancelRequested: permit.cancel_requested === 1, closedAt: permit.closed_at } : null };
}
export async function handleWorkerMCPRequest(db: LocalDatabase, request: Request, origin = configuredOrigin(), env: BackendEnvironment = {}): Promise<Response> {
  let id: string | number | null = null;
  try {
    const principal = await authenticateWorkerHeaders(db, request.headers, request.method, origin);
    if (new URL(request.url).searchParams.size) invalid('Worker MCP does not accept query parameters');
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, Allow: 'POST' } });
    const body = await readBody(request);
    exactObject(body, ['jsonrpc', 'id', 'method', 'params']);
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string' || (body.id !== undefined && body.id !== null && typeof body.id !== 'string' && !(typeof body.id === 'number' && Number.isSafeInteger(body.id)))) invalid('Invalid JSON-RPC request');
    if (typeof body.id === 'string' && body.id.length > 200) invalid('JSON-RPC ID too long');
    id = body.id === undefined ? null : body.id as string | number | null;
    if (body.method === 'notifications/initialized') return new Response(null, { status: 204, headers });
    if (body.method === 'initialize') {
      exactObject(body.params ?? {}, ['protocolVersion', 'capabilities', 'clientInfo']);
      return response({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agent-task-hub-worker', version: '1' } } });
    }
    if (body.method === 'ping') { exactObject(body.params ?? {}, []); return response({ jsonrpc: '2.0', id, result: {} }); }
    if (body.method === 'discover' || body.method === 'tools/list') { exactObject(body.params ?? {}, []); return response({ jsonrpc: '2.0', id, result: { tools } }); }
    if (body.method !== 'tools/call') return response({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    exactObject(body.params, ['name', 'arguments']);
    const args = body.params.arguments ?? {};
    let value;
    if (body.params.name === 'get_execution_run') {
      exactObject(args, ['runId']); boundedId(args.runId);
      if (args.runId !== principal.runId) throw new ExecutionError('AUTHORIZATION_DENIED', 'Worker is bound to another Run', 403);
      value = { run: await delegatedRun(db, principal) };
    } else if (body.params.name === 'list_execution_runs') {
      exactObject(args, []); value = { runs: [await delegatedRun(db, principal)] };
    } else if (body.params.name === 'claim_execution_run' || body.params.name === 'renew_execution_run' || body.params.name === 'report_execution_run') {
      const context = { owner: principal.owner, actor: principal.actor, executionRunId: principal.runId,
        ...(body.params.name === 'claim_execution_run' && args && typeof args === 'object' && 'mode' in args && args.mode === 'reconcile' ? {} : { registry: configuredRegistry(env) }) };
      if (body.params.name === 'claim_execution_run') value = await claimExecutionRun(db, principal, args, context);
      else if (body.params.name === 'renew_execution_run') value = await renewExecutionRun(db, principal, args, context);
      else value = await reportExecutionRun(db, principal, args, context);
    } else if (body.params.name === 'start_execution_run') value = await startExecutionRun(db, principal, args, env);
    else if (body.params.name === 'complete_execution_run') value = await completeExecutionRun(db, principal, args, env);
    else if (body.params.name === 'cancel_execution_run') value = await cancelExecutionRun(db, principal, args, env);
    else throw new ExecutionError('AUTHORIZATION_DENIED', 'Tool is not delegated to this Worker', 403);
    return response({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false } });
  } catch (error) {
    if (error instanceof AuthError) return workerHttpError(error);
    if (error instanceof ExecutionError) return response({ jsonrpc: '2.0', id, error: { code: error.code === 'INVALID_INPUT' ? -32602 : -32000, message: error.message, data: { code: error.code, status: error.status } } });
    return response({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Worker storage unavailable' } });
  }
}
