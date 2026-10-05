import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { consumerFixture } from './fixtures/consumer.mjs';
import { connection } from '../../runner/consumer-transport.mjs';
const f = await consumerFixture();
try {
    const unicode = '{"payload":"' + '😀'.repeat(79986) + '"}';
    const escaped = JSON.stringify({ payload: '\\"\n'.repeat(10000) });
    const bodies = [unicode, unicode, escaped + ' '.repeat(80000 - [...escaped].length), '{}'+ ' '.repeat(79998)];
    const sizes = [], runs = [];
    for (const [index, ticketBody] of bodies.entries()) {
        assert.equal([...ticketBody].length, 80000);
        assert.equal(typeof JSON.parse(ticketBody), 'object');
        const { run } = await f.prepare('envelope-' + index, 'ticket.validate.v1', 600000, ticketBody);
        runs.push(run);
        const secret = randomBytes(32).toString('base64url'), credentialId = crypto.randomUUID();
        const issued = await f.api('/api/execution/workers', { action: 'provision', runId: run.id, credentialId, requestId: credentialId, verifier: createHash('sha256').update(secret).digest('hex'), label: 'envelope' });
        assert.equal(issued.status, 201);
        const token = 'athw1.' + credentialId + '.' + secret;
        for (const name of ['get_execution_run', 'list_execution_runs']) {
            const args = name === 'get_execution_run' ? { runId: run.id } : {};
            const response = await fetch(f.base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(128), method: 'tools/call', params: { name, arguments: args } }) });
            const bytes = Buffer.from(await response.arrayBuffer());
            assert.ok(bytes.length < 1048576, 'complete encoded JSON-RPC body must fit consumer limit');
            const result = JSON.parse(bytes).result;
            assert.ok(result, bytes.toString());
            assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
            assert.equal((result.structuredContent.run ?? result.structuredContent.runs[0]).ticketBody, ticketBody);
            sizes.push(bytes.length);
            const observed = await connection(f.base + '/mcp', token).call(name, args);
            assert.equal((observed.run ?? observed.runs[0]).ticketBody, ticketBody);
        }
    }
    const call = limit => f.api('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_execution_runs', arguments: { limit } } });
    assert.equal((await call(1)).data.result.structuredContent.runs.length, 1);
    const large = await call(100);
    assert.equal(large.data.error.data.code, 'BODY_TOO_LARGE');
    assert.ok(Buffer.byteLength(JSON.stringify(large.data)) < 1024);
    // Two legitimate bounded Runs can put the outer JSON-RPC envelope over
    // the transport cap while the tool result alone remains just below it.
    const selected = runs.slice(-2).reverse();
    selected[1].ticketBody = unicode;
    selected[0].ticketBody = '{"payload":"' + '😀'.repeat(50000) + '"}';
    const predicted = () => {
        const structuredContent = { runs: selected };
        return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 'x'.repeat(128), result: { resultType: 'complete', content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false } }));
    };
    const padding = Math.floor((1048600 - predicted()) / 2);
    assert.ok(padding > 0 && padding < 30000);
    selected[0].ticketBody += ' '.repeat(padding);
    assert.ok(predicted() > 1048576 && predicted() < 1048650);
    for (const run of selected) assert.ok([...run.ticketBody].length <= 80000);
    await f.prepare('envelope-4', 'ticket.validate.v1', 600000, selected[1].ticketBody);
    await f.prepare('envelope-5', 'ticket.validate.v1', 600000, selected[0].ticketBody);
    const boundary = await f.api('/mcp', { jsonrpc: '2.0', id: 'x'.repeat(128), method: 'tools/call', params: { name: 'list_execution_runs', arguments: { limit: 2 } } });
    assert.equal(boundary.data.error?.data.code, 'BODY_TOO_LARGE', 'cap includes the entire JSON-RPC envelope');
    console.log('Actual maximum 80000-codepoint Unicode, JSON escaping and whitespace Run RPC/consumer roundtrips passed; full envelope bytes=' + sizes.join(',') + '; owner multi-Run response rejects boundedly and limit=1 succeeds');
} finally {
    await f.close();
}
