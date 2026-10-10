import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { safeCallback, signedPost } from '../../lib/event-transport.mts';

test('callbacks accept only explicitly written loopback authorities', () => {
  for (const url of ['http://127.0.0.1:4567/a?q=1', 'https://localhost/a', 'http://[::1]:80/a']) {
    assert.equal(safeCallback(url), new URL(url).href);
  }
  for (const url of ['https://chatgpt.com/a', 'https://openai.com', 'http://example.com',
    'http://127.1:80', 'http://2130706433', 'http://0177.0.0.1', 'http://0x7f000001',
    'http://127.0.0.01', 'http://127.0.0.1.evil.test', 'http://localhost.',
    'http://user@localhost', 'http://localhost/#fragment', 'ftp://localhost',
    'http://localhost:0', 'http://localhost:65536', 'http://localhost:',
    ' http://localhost', 'http://localhost\\evil', 'http://%6cocalhost',
    'http://[0:0:0:0:0:0:0:1]', 'http://localhost\n', 'http://localhost/#']) {
    assert.throws(() => safeCallback(url), undefined, url);
  }
});

test('real local signed challenge and rotated events are accepted and redirects never followed', async t => {
  const secrets = [31, 49].map(n => 'whsec_' + Buffer.alloc(32, n).toString('base64'));
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push(req.url);
    if (req.url === '/redirect') { res.writeHead(302, {location: '/forbidden'}); res.end(); return; }
    const message = `${req.headers['webhook-id']}.${req.headers['webhook-timestamp']}.${body}`;
    const signatures = req.headers['webhook-signature'].split(' ');
    for (const secret of secrets) assert.ok(signatures.includes('v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(message).digest('base64')));
    const event = JSON.parse(body);
    res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({challenge: event.challenge}));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const sub = {id: 'local', url: `http://127.0.0.1:${server.address().port}/callback`, secret: secrets[0], previousSecret: secrets[1], rotationUntil: Date.now() + 60000, args: {}};
  const challenge = await signedPost(sub, {type: 'verification', challenge: 'real-local-challenge'}, 'challenge-id');
  assert.deepEqual(await challenge.json(), {challenge: 'real-local-challenge'});
  const event = await signedPost(sub, {eventId: 'event-id', name: 'idea.planning_requested', timestamp: new Date().toISOString(), data: {job_id: 'job'}, cursor: null}, 'event-id');
  assert.equal(event.status, 200); await event.body.cancel();
  await assert.rejects(signedPost({...sub, url: sub.url.replace('/callback', '/redirect')}, {type: 'verification', challenge: 'x'}, 'redirect'), {reason: 'redirect'});
  assert.deepEqual(seen, ['/callback', '/callback', '/redirect']);
  await assert.rejects(signedPost(sub, {type: 'verification', challenge: 'x'.repeat(262144)}, 'large'), {reason: 'event_too_large'});
});
