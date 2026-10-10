import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, KeyObject } from 'node:crypto';
import { readProxyBody } from './fixtures/transport-proxy.mjs';
const api = await import('../../lib/execution/transport.mts').catch(() => ({}));
async function pair(keyId) { const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']); return { keyId, privateKey: k.privateKey, publicKey: k.publicKey }; }
test('transport uses interoperable raw P256 and binds direction, nonce, method, path, audience and exact bytes', async () => {
  assert.equal(typeof api.signRequest, 'function');
  const worker = await pair('worker'); const node = await pair('node');
  const body = '{"permit":"one"}';
  const signed = await api.signRequest(worker, { direction: 'control-to-runner', audience: 'runner', method: 'POST', path: '/start', body });
  const trust = { keyId: worker.keyId, key: worker.publicKey };
  assert.equal(await api.verifyRequest(signed, trust, { direction: 'control-to-runner', audience: 'runner', method: 'POST', path: '/start', body }), true);
  assert.equal(Buffer.from(signed.signature, 'hex').length, 64);
  assert.equal(verify('sha256', api.signingBytes(signed.claims), { key: KeyObject.from(worker.publicKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(signed.signature, 'hex')), true);
  const native = { ...signed, signature: sign('sha256', api.signingBytes(signed.claims), { key: KeyObject.from(worker.privateKey), dsaEncoding: 'ieee-p1363' }).toString('hex') };
  assert.equal(await api.verifyRequest(native, trust, { direction: 'control-to-runner', audience: 'runner', method: 'POST', path: '/start', body }), true);
  for (const change of [{ body: '{}' }, { path: '/cancel' }, { method: 'GET' }, { audience: 'other' }, { direction: 'runner-to-control' }])
    assert.equal(await api.verifyRequest(signed, trust, { direction: 'control-to-runner', audience: 'runner', method: 'POST', path: '/start', body, ...change }), false);
  assert.equal(await api.verifyRequest(signed, { keyId: node.keyId, key: node.publicKey }, { direction: 'control-to-runner', audience: 'runner', method: 'POST', path: '/start', body }), false);
  assert.equal(await api.verifyRequest(signed, trust, { direction: 'control-to-runner', audience: 'runner', method: 'POST', path: '/start', body }, signed.claims.expiresAt), false);
  const reply = await api.signReply(node, signed, 202, '{"accepted":true}');
  assert.equal(await api.verifyReply(reply, { keyId: node.keyId, key: node.publicKey }, signed, 202, '{"accepted":true}'), true);
  assert.equal(await api.verifyReply(reply, { keyId: node.keyId, key: node.publicKey }, signed, 200, '{"accepted":true}'), false);
  const another = await api.signRequest(worker, { direction: 'control-to-runner', audience: 'runner', method: 'POST', path: '/start', body });
  assert.equal(await api.verifyReply(reply, { keyId: node.keyId, key: node.publicKey }, another, 202, '{"accepted":true}'), false);
});
test('bounded replay admission refuses duplicates and saturation without dropping live protection', () => {
  assert.equal(typeof api.ReplayWindow, 'function'); const replay = new api.ReplayWindow(2);
  assert.equal(replay.accept('one', 2000, 1000), true); assert.equal(replay.accept('one', 2000, 1000), false);
  assert.equal(replay.accept('two', 2000, 1000), true); assert.equal(replay.accept('three', 2000, 1000), false);
  assert.equal(replay.accept('one', 2000, 1000), false); assert.equal(replay.accept('three', 4000, 3000), true);
});

test('fixture proxy preserves signed Unicode permits across arbitrary byte chunks', async () => {
  const control=await pair('control');
  const body=api.canonical({permit:{ticketBody:JSON.stringify({title:'Actual backend Ticket',payload:'😀'.repeat(79900)})}});
  const bytes=Buffer.from(body);
  const emoji=bytes.indexOf(Buffer.from('😀'));
  // Deliberately split inside a four-byte code point; real sockets may split anywhere.
  const chunks=[bytes.subarray(0,emoji+1),bytes.subarray(emoji+1,65537),bytes.subarray(65537)];
  const signed=await api.signRequest(control,{direction:'control-to-runner',audience:'runner',method:'POST',path:'/start',body});
  const trust={keyId:control.keyId,key:control.publicKey};
  const binding={direction:'control-to-runner',audience:'runner',method:'POST',path:'/start'};
  const legacy=chunks.map(chunk=>chunk.toString()).join('');
  assert.notEqual(Buffer.byteLength(legacy),bytes.length);
  assert.equal(await api.verifyRequest(signed,trust,{...binding,body:legacy}),false);
  const forwarded=await readProxyBody((async function*(){yield* chunks;})());
  assert.deepEqual(forwarded,bytes);
  assert.equal(await api.verifyRequest(signed,trust,{...binding,body:forwarded.toString('utf8')}),true);
});
