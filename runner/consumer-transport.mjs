import { safeRead } from './state.mjs';
export class ConsumerError extends Error {
    constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export function endpoint(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new ConsumerError('INVALID_ENDPOINT');
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))))
        throw new ConsumerError('INVALID_ENDPOINT');
    return url.href;
}
export async function ingressHeaders(path, origin) {
    if (!path)
        return {};
    if (new URL(origin).protocol !== 'https:')
        throw new ConsumerError('INGRESS_REQUIRES_HTTPS');
    const input = JSON.parse((await safeRead(path, 16384)).toString());
    if (Object.keys(input).some(k => !['clientId', 'clientSecret'].includes(k)) || ![input.clientId, input.clientSecret].every(s => typeof s === 'string' && s.length > 0 && s.length < 4096 && !/[\r\n]/.test(s)))
        throw new ConsumerError('INVALID_INGRESS');
    return { 'CF-Access-Client-Id': input.clientId, 'CF-Access-Client-Secret': input.clientSecret };
}
export function connection(url, token, ingress = {}) {
    url = endpoint(url);
    const origin = new URL(url).origin;
    async function post(path, body) {
        if (!['/mcp', '/api/execution/workers'].includes(path))
            throw new ConsumerError('INVALID_ROUTE');
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await fetch(origin + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500), headers: { ...ingress, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
                const reader = response.body?.getReader();
                if (!reader)
                    throw new ConsumerError('INVALID_RESPONSE');
                let length = 0;
                const chunks = [];
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        length += value.length;
                        if (length > 1048576) {
                            await reader.cancel();
                            throw new ConsumerError('RESULT_TOO_LARGE');
                        }
                        chunks.push(value);
                    }
                }
                finally {
                    reader.releaseLock();
                }
                if (!response.ok)
                    throw new ConsumerError(response.status === 401 ? 'CREDENTIAL_INVALID' : response.status === 403 ? 'AUTHORITY_REJECTED' : 'HTTP_FAILURE', response.status);
                if (response.status === 202 && !length)
                    return null;
                let value;
                try {
                    value = JSON.parse(Buffer.concat(chunks).toString());
                }
                catch {
                    throw new ConsumerError('INVALID_RESPONSE');
                }
                return value;
            }
            catch (error) {
                if (error instanceof ConsumerError && error.status !== 503)
                    throw error;
                if (attempt === 2)
                    throw new ConsumerError('TRANSPORT_UNAVAILABLE', 503);
            }
        }
    }
    let id = 0;
    const rpc = async (method, params = {}, notification = false) => {
        const requestId = ++id;
        const reply = await post('/mcp', { jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params });
        if (notification)
            return;
        if (!reply || reply.jsonrpc !== '2.0' || reply.id !== requestId)
            throw new ConsumerError('INVALID_RPC');
        if (reply.error) {
            const code = reply.error.data?.code;
            throw new ConsumerError(['INVALID_EVIDENCE', 'WORKER_AUTHORITY_EXPIRED', 'LEASE_CONFLICT', 'AUTHORIZATION_DENIED', 'DISPATCH_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(code) ? code : 'RPC_REJECTED', reply.error.data?.status ?? 400);
        }
        return reply.result;
    };
    return { post, rpc, async initialize() { const info = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'execution-consumer', version: '1.0.0' } }); if (!['2025-03-26', '2026-07-28'].includes(info.protocolVersion))
            throw new ConsumerError('PROTOCOL_UNSUPPORTED'); await rpc('notifications/initialized', {}, true); await rpc('ping'); }, async call(name, args) { const result = await rpc('tools/call', { name, arguments: args }); if (result.isError || !result.structuredContent)
            throw new ConsumerError('INVALID_TOOL_RESULT'); return result.structuredContent; } };
}
