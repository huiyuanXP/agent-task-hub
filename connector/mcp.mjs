import { heartbeat, redact, request, VERSION } from './common.mjs';

export async function serveMcp(config) {
  let initialized = false;
  const pending = new Map();
  const tasks = new Set();
  const respond = value => process.stdout.write(JSON.stringify(value) + '\n');
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
  let buffered = '';
  try {
    for await (const chunk of process.stdin) {
      buffered += chunk.toString();
      let boundary;
      while ((boundary = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, boundary).replace(/\r$/, '');
        buffered = buffered.slice(boundary + 1);
        if (!line) continue;
        if (line.length > 262144) { respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds the limit' } }); continue; }
        const task = handle(line); tasks.add(task); task.finally(() => tasks.delete(task));
      }
      if (buffered.length > 262144) throw Error('STDIO request exceeds the limit');
    }
    if (buffered.trim()) { const task = handle(buffered); tasks.add(task); }
    await Promise.all(tasks);
  } finally { clearInterval(timer); for (const controller of pending.values()) controller.abort(); }
}
