import assert from 'node:assert/strict';
import { localFixture } from '../local/fixture.mjs';
import { inviteConnector, enrollConnector } from '../../lib/connectors/service.mts';
import { MAX_MCP_RESPONSE_BYTES } from '../../lib/task-reads/bounds.mts';
const f = await localFixture();
try {
  const insert = async (id, kind, body, owner = f.alice.userId) => f.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?)')
    .bind(id, owner, kind, JSON.stringify(body), 1, 'same', 'same').run();
  const text = '中🙂"\\\n'.repeat(50000);
  for (let i = 0; i < 6; i++) await insert('large-' + i, 'ticket', { project: 'A', notes: text });
  await insert('hidden-owner', 'ticket', { project: 'A', notes: 'PRIVATE_OTHER_OWNER' }, f.bob.userId);
  await insert('hidden-project', 'ticket', { project: 'B', notes: 'PRIVATE_OTHER_PROJECT' });
  await insert('oversized-single', 'ticket', { project: 'Oversized', notes: 'x'.repeat(2 * 1024 * 1024) });
  const enroll = async project => {
    const invitation = await inviteConnector(f.db, f.alice.userId, { action: 'invite', project, name: 'Native byte client', capabilities: ['read'] });
    return enrollConnector(f.db, { code: invitation.code, name: 'Native byte client', version: '1', workspace: 'Synthetic repository' });
  };
  const a = await enroll('A'), b = await enroll('B');
  const snapshot = async () => {
    const tables = (await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
    return Promise.all(tables.filter(row => !['workspace_connections', 'workspace_connection_events'].includes(row.name)).map(async ({ name }) => [name, (await f.db.prepare('SELECT * FROM "' + name + '" ORDER BY rowid').all()).results]));
  };
  const before = await snapshot();
  const rpc = async (path, token, name, args, id = '中🙂') => {
    const response = await fetch(f.origin + path, { method: 'POST', headers: { origin: f.origin, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200); const raw = await response.text();
    assert.ok(Buffer.byteLength(raw) <= MAX_MCP_RESPONSE_BYTES);
    assert.doesNotMatch(raw, /PRIVATE_OTHER_OWNER|PRIVATE_OTHER_PROJECT/);
    return JSON.parse(raw);
  };
  const pageValue = response => {
    assert.equal(response.error, undefined); assert.equal(response.result.isError, false);
    assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
    return response.result.structuredContent;
  };
  for (const [path, token] of [['/mcp', f.aliceToken], ['/api/connector/mcp', a.token]]) {
    const ids = []; let cursor;
    do {
      const value = pageValue(await rpc(path, token, 'list_tickets', { project: 'A', limit: 100, ...(cursor ? { cursor } : {}) }, '中🙂'.repeat(20000)));
      assert.ok(value.items.length > 0 && value.items.length < 6);
      ids.push(...value.items.map(row => row.id)); cursor = value.next_cursor;
    } while (cursor);
    assert.deepEqual(ids, ['large-5', 'large-4', 'large-3', 'large-2', 'large-1', 'large-0']);
  }
  console.log('PASS: actual owner and project MCP HTTP envelopes stay within 4 MiB with Unicode/escaped bodies, large RPC IDs and exact continuation');
  const page = pageValue(await rpc('/api/connector/mcp', a.token, 'list_tickets', { limit: 100 }));
  const foreign = await rpc('/api/connector/mcp', b.token, 'list_tickets', { cursor: page.next_cursor });
  assert.equal(foreign.result.isError, true);
  console.log('PASS: byte-truncated project cursor remains scoped to its authenticated project');
  const tooLarge = await rpc('/mcp', f.aliceToken, 'get_ticket', { ticket_id: 'oversized-single' });
  assert.deepEqual(tooLarge.error.data, { code: 'RESPONSE_TOO_LARGE', status: 413 });
  assert.ok(JSON.stringify(tooLarge).length < 500);
  assert.deepEqual(await snapshot(), before);
  console.log('PASS: oversized single detail returns a bounded typed error and all application tables except connector communication bookkeeping remain read-only');
  const overflow = await fetch(f.origin + '/mcp', { method: 'POST', headers: { origin: f.origin, authorization: 'Bearer ' + f.aliceToken, 'content-type': 'application/json' }, duplex: 'half', body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', extra: 'x'.repeat(200000) }))); controller.close(); } }) });
  assert.equal(overflow.status, 200); const inputError = await overflow.json();
  assert.deepEqual(inputError.error.data, { code: 'BODY_TOO_LARGE', status: 413 });
  console.log('PASS: actual chunked owner MCP ingress rejects more than 200000 UTF-8 bytes before parsing');
} finally { await f.close(); }
