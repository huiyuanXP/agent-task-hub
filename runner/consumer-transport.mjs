import { isDeepStrictEqual } from 'node:util';

export const MAX_CONSUMER_REQUEST_BYTES = 16 * 1024;
export const MAX_CONSUMER_RESPONSE_BYTES = 1024 * 1024;
export const CONSUMER_TIMEOUT_MS = 2500;
export const WORKER_TOOL_NAMES = Object.freeze([
  'get_execution_run', 'list_execution_runs', 'claim_execution_run', 'start_execution_run',
  'renew_execution_run', 'report_execution_run', 'complete_execution_run', 'cancel_execution_run',
]);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const credentialId = new RegExp('^' + uuid + '$');
const workerTokenPattern = new RegExp('^athw1\\.' + uuid + '\\.[A-Za-z0-9_-]{43}$');
const leaseTokenPattern = new RegExp('^athl1\\.' + uuid + '\\.([1-9][0-9]{0,15})\\.[A-Za-z0-9_-]{43}$');
const domainCodes = new Set([
  'INVALID_INPUT', 'NOT_FOUND', 'REVISION_CONFLICT', 'REQUEST_CONFLICT', 'ACTIVE_RUN',
  'TRANSITION_CONFLICT', 'INVALID_EVIDENCE', 'BODY_TOO_LARGE', 'UNSUPPORTED_MEDIA',
  'AUTHORIZATION_DENIED', 'DECISION_CONFLICT', 'STORAGE_UNAVAILABLE', 'DISPATCH_CONFLICT',
  'CONFIGURATION_UNAVAILABLE', 'RESPONSE_TOO_LARGE',
]);
const messages = {
  configuration: 'Invalid consumer endpoint or timeout',
  input: 'Invalid consumer request',
  credential: 'Invalid credential for this endpoint',
  request_limit: 'Consumer request exceeds 16 KiB',
  response_limit: 'Consumer response exceeds 1 MiB',
  timeout: 'Consumer request timed out',
  cancelled: 'Consumer request cancelled',
  network: 'Consumer service connection failed',
  redirect: 'Consumer service redirect rejected',
  encoding: 'Consumer service returned invalid UTF-8',
  json: 'Consumer service returned invalid JSON',
  protocol: 'Consumer service returned an invalid protocol response',
  http: 'Consumer service rejected the HTTP request',
  rpc: 'Consumer service rejected the Worker request',
};
export class ConsumerTransportError extends Error {
  constructor(kind, { status, rpcCode, domainCode } = {}) {
    super(messages[kind] ?? messages.protocol);
    this.name = 'ConsumerTransportError';
    this.kind = Object.hasOwn(messages, kind) ? kind : 'protocol';
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    if (Number.isSafeInteger(rpcCode)) this.rpcCode = rpcCode;
    if (domainCodes.has(domainCode)) this.domainCode = domainCode;
  }
}
const fail = (kind, details) => { throw new ConsumerTransportError(kind, details); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || Object.getOwnPropertySymbols(value).length) fail('input');
}
function boundedId(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('input');
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) fail('input');
}
function managementInput(input, provision) {
  const keys = provision ? ['credentialId', 'requestId', 'runId', 'verifier', 'label'] : ['credentialId', 'requestId'];
  exact(input, keys);
  if (typeof input.credentialId !== 'string' || !credentialId.test(input.credentialId)) fail('input');
  requestId(input.requestId);
  if (provision) {
    boundedId(input.runId);
    if (typeof input.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(input.verifier)) fail('input');
    boundedId(input.label, 120);
  }
  return Object.fromEntries(keys.map(key => [key, input[key]]));
}
function toolInput(name, args) {
  if (!WORKER_TOOL_NAMES.includes(name)) fail('input');
  if (name === 'list_execution_runs') { exact(args, []); return {}; }
  if (name === 'get_execution_run') { exact(args, ['runId']); boundedId(args.runId); return { runId: args.runId }; }
  const claim = name === 'claim_execution_run', report = name === 'report_execution_run';
  const keys = claim ? ['runId', 'requestId', 'leaseId', 'verifier', 'mode'] : ['runId', 'requestId', 'leaseToken', ...(report ? ['message'] : [])];
  exact(args, keys); boundedId(args.runId); requestId(args.requestId);
  if (claim) {
    if (typeof args.leaseId !== 'string' || !credentialId.test(args.leaseId) ||
        typeof args.verifier !== 'string' || !/^[0-9a-f]{64}$/.test(args.verifier) ||
        !['execute', 'reconcile'].includes(args.mode)) fail('input');
  } else {
    const match = typeof args.leaseToken === 'string' && leaseTokenPattern.exec(args.leaseToken);
    if (!match || !Number.isSafeInteger(Number(match[1]))) fail('input');
    if (report && (typeof args.message !== 'string' || args.message.length > 2048)) fail('input');
  }
  return Object.fromEntries(keys.map(key => [key, args[key]]));
}
async function boundedJSON(response, allowEmpty) {
  if (allowEmpty && response.status === 204) {
    if (response.body) await response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_CONSUMER_RESPONSE_BYTES) fail('response_limit');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof ConsumerTransportError) throw error;
      if (error?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') fail('encoding');
      throw error;
    } finally { reader.releaseLock(); }
  }
  try { return JSON.parse(text); } catch { fail('json'); }
}
export function createConsumerTransport({ endpoint, timeoutMs = CONSUMER_TIMEOUT_MS } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { fail('configuration'); }
  if (typeof endpoint !== 'string' || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.pathname !== '/api/execution/worker-mcp' ||
      url.search || url.hash || endpoint !== url.origin + '/api/execution/worker-mcp' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CONSUMER_TIMEOUT_MS) fail('configuration');
  const origin = url.origin, workers = origin + '/api/execution/workers';
  let nextId = 0;
  async function post(target, token, body, { signal } = {}, allowEmpty = false) {
    const isWorker = target === endpoint;
    if (typeof token !== 'string' || !(isWorker ? workerTokenPattern : /^[A-Za-z0-9_-]{43}$/).test(token)) fail('credential');
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('input');
    let raw;
    try { raw = JSON.stringify(body); } catch { fail('input'); }
    if (Buffer.byteLength(raw, 'utf8') > MAX_CONSUMER_REQUEST_BYTES) fail('request_limit');
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await fetch(target, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { host: url.host, origin, 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: raw,
      });
      const value = await boundedJSON(response, allowEmpty);
      if (!response.ok) fail('http', { status: response.status, domainCode: object(value) ? value.code : undefined });
      return value;
    } catch (error) {
      if (signal?.aborted) fail('cancelled');
      if (timeout.signal.aborted) fail('timeout');
      if (error instanceof ConsumerTransportError) throw error;
      // Undici rejects before following a redirect. Inspect only this fixed marker;
      // never retain its cause, request, token or remote error message.
      if (error?.cause?.message === 'unexpected redirect') fail('redirect');
      fail('network');
    } finally { clearTimeout(timer); }
  }
  async function rpc(token, method, params, options) {
    const id = ++nextId;
    const value = await post(endpoint, token, { jsonrpc: '2.0', id, method, params }, options);
    if (!object(value) || value.jsonrpc !== '2.0' || value.id !== id ||
        Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) fail('protocol');
    if (Object.hasOwn(value, 'error')) {
      if (!object(value.error) || !Number.isSafeInteger(value.error.code)) fail('protocol');
      fail('rpc', { rpcCode: value.error.code, status: value.error.data?.status, domainCode: value.error.data?.code });
    }
    return value.result;
  }
  async function initialize(workerToken, options) {
    const result = await rpc(workerToken, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-task-hub-consumer', version: '1' },
    }, options);
    if (!object(result) || result.protocolVersion !== '2024-11-05' ||
        !object(result.capabilities?.tools) || result.serverInfo?.name !== 'agent-task-hub-worker') fail('protocol');
    const discovery = await rpc(workerToken, 'tools/list', {}, options);
    if (!object(discovery) || !Array.isArray(discovery.tools) || discovery.tools.length !== WORKER_TOOL_NAMES.length ||
        discovery.tools.some(tool => !object(tool) || !WORKER_TOOL_NAMES.includes(tool.name) || tool.inputSchema?.type !== 'object') ||
        new Set(discovery.tools.map(tool => tool.name)).size !== WORKER_TOOL_NAMES.length) fail('protocol');
    await post(endpoint, workerToken, { jsonrpc: '2.0', method: 'notifications/initialized' }, options, true);
    return { ...result, tools: discovery.tools };
  }
  async function callTool(workerToken, name, args = {}, options) {
    const result = await rpc(workerToken, 'tools/call', { name, arguments: toolInput(name, args) }, options);
    if (!object(result) || result.isError !== false || !object(result.structuredContent) || !Array.isArray(result.content) ||
        result.content.length !== 1 || result.content[0]?.type !== 'text' || typeof result.content[0]?.text !== 'string') fail('protocol');
    let text;
    try { text = JSON.parse(result.content[0].text); } catch { fail('protocol'); }
    if (!isDeepStrictEqual(text, result.structuredContent)) fail('protocol');
    return result.structuredContent;
  }
  async function manage(ownerToken, input, provision, options) {
    const body = { action: provision ? 'provision' : 'revoke', ...managementInput(input, provision) };
    const result = await post(workers, ownerToken, body, options);
    if (!object(result) || !object(result.worker) || result.worker.credentialId !== body.credentialId) fail('protocol');
    return result.worker;
  }
  return Object.freeze({
    endpoint, origin, initialize, callTool,
    provisionWorker: (ownerToken, input, options) => manage(ownerToken, input, true, options),
    revokeWorker: (ownerToken, input, options) => manage(ownerToken, input, false, options),
  });
}
