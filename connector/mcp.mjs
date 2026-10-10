import { StringDecoder } from 'node:string_decoder';
import { heartbeat, MAX_RESPONSE_BYTES, redact, request, VERSION } from './common.mjs';

export const MAX_STDIO_REQUEST_BYTES = 200000;

export async function serveMcp(config) {
  let initialized = false;
  const pending = new Map();
  const tasks = new Set();
  const respond = value => {
    let line = JSON.stringify(value);
    if (Buffer.byteLength(line, 'utf8') > MAX_RESPONSE_BYTES) {
      line = JSON.stringify({ jsonrpc: '2.0', id: value.id ?? null, error: { code: -32000, message: 'STDIO response exceeds the limit' } });
    }
    process.stdout.write(line + '\n');
  };
  const beat = () => heartbeat(config, 'mcp').catch(error => process.stderr.write(`MCP heartbeat: ${redact(error, config)}\n`));
  await beat();
  const timer = setInterval(beat, 15000);
  timer.unref();
  async function handle(line) {
    let rpc;
    try { rpc = JSON.parse(line); } catch { respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || (rpc.id !== undefined && typeof rpc.id !== 'string' && typeof rpc.id !== 'number' && rpc.id !== null)) {
      respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); return;
    }
    if (rpc.method === 'notifications/cancelled') { pending.get(rpc.params?.requestId)?.abort(); return; }
    if (rpc.id === undefined) return;
    let result;
    try {
      if (rpc.method === 'initialize') {
        if (!rpc.params || typeof rpc.params.protocolVersion !== 'string') { respond({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'protocolVersion is required' } }); return; }
        initialized = true;
        const protocolVersion = ['2025-11-25', '2025-06-18', '2024-11-05'].includes(rpc.params.protocolVersion) ? rpc.params.protocolVersion : '2025-11-25';
        result = { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'agent-task-hub-connector', version: VERSION }, instructions: 'Tools are restricted to the enrolled project and granted capabilities.' };
      } else if (rpc.method === 'ping') result = {};
      else if (rpc.method === 'tools/list' || rpc.method === 'tools/call') {
        if (!initialized) { respond({ jsonrpc: '2.0', id: rpc.id, error: { code: -32002, message: 'Initialize the MCP session first' } }); return; }
        if (pending.has(rpc.id)) { respond({ jsonrpc: '2.0', id: rpc.id, error: { code: -32600, message: 'Duplicate in-flight request ID' } }); return; }
        const controller = new AbortController();
        pending.set(rpc.id, controller);
        const response = await request(config, '/api/connector/mcp', rpc, { signal: controller.signal, timeoutMs: 30000 });
        respond({ ...response, jsonrpc: '2.0', id: rpc.id });
        return;
      } else { respond({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }); return; }
      respond({ jsonrpc: '2.0', id: rpc.id, result });
    } catch (error) { respond({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: redact(error, config) } }); }
    finally { pending.delete(rpc.id); }
  }
  const decoder = new StringDecoder('utf8');
  let buffered = '', bufferedBytes = 0, discarding = false;
  const dispatch = line => {
    if (!line) return;
    const task = handle(line);
    tasks.add(task);
    task.finally(() => tasks.delete(task));
  };
  const consume = text => {
    let offset = 0;
    do {
      const boundary = text.indexOf('\n', offset);
      const fragment = text.slice(offset, boundary === -1 ? text.length : boundary);
      if (!discarding) {
        bufferedBytes += Buffer.byteLength(fragment, 'utf8');
        // A CR before LF is framing, not part of the JSON request.
        const trailingCr = fragment ? fragment.endsWith('\r') : buffered.endsWith('\r');
        if (bufferedBytes - (trailingCr ? 1 : 0) > MAX_STDIO_REQUEST_BYTES) {
          respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds the limit' } });
          buffered = '';
          discarding = true;
        } else buffered += fragment;
      }
      if (boundary === -1) break;
      if (!discarding) dispatch(buffered.replace(/\r$/, ''));
      buffered = ''; bufferedBytes = 0; discarding = false;
      offset = boundary + 1;
    } while (offset < text.length);
  };
  try {
    for await (const chunk of process.stdin) consume(decoder.write(chunk));
    consume(decoder.end());
    if (!discarding && buffered.trim()) dispatch(buffered.replace(/\r$/, ''));
    await Promise.all(tasks);
  } finally { clearInterval(timer); for (const controller of pending.values()) controller.abort(); }
}
