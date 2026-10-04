import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chromium } from './node_modules/playwright/index.mjs';
import * as workerNetwork from './worker-network.mjs';
import { launchRestrictedBrowser } from './network.mjs';

async function endpoint(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('redirects cannot escape the two allowed origins', async t => {
  let forbiddenRequests = 0;
  const forbidden = await endpoint((_, response) => { forbiddenRequests++; response.end('forbidden'); });
  const second = await endpoint((_, response) => { response.writeHead(302, { Location: forbidden.origin + '/landing' }); response.end(); });
  const first = await endpoint((_, response) => { response.writeHead(302, { Location: second.origin + '/forward' }); response.end(); });
  let restricted;
  try {
    restricted = await launchRestrictedBrowser(chromium, [first.origin, second.origin]);
    const { context, blocked, errors } = restricted;
    const page = await context.newPage();
    await page.goto(first.origin + '/redirect').catch(() => {});
    t.diagnostic(`forbidden document redirect requests: ${forbiddenRequests}`);
    assert.equal(forbiddenRequests, 0, 'A forbidden redirect hop reached its server');
    assert.ok(blocked.includes(forbidden.origin), 'Forbidden redirect hop must appear in evidence');
    assert.ok(restricted.requestedExternal.includes(forbidden.origin), 'Page redirect must remain visible separately from browser background traffic');
    assert.deepEqual(errors, []);
  } finally {
    await restricted?.close();
    await Promise.all([first, second, forbidden].map(server => server.close()));
  }
});

test('native allowed redirects preserve document URL, cookies and interactive state', async () => {
  let landingCookie;
  const second = await endpoint((request, response) => {
    landingCookie = request.headers.cookie;
    response.setHeader('Content-Type', 'text/html');
    response.end('<button onclick="this.textContent=\'hydrated\'">ready</button>');
  });
  const first = await endpoint((_, response) => {
    response.writeHead(302, { Location: second.origin + '/landing', 'Set-Cookie': 'synthetic_policy=verified; Path=/; HttpOnly; SameSite=Lax' });
    response.end();
  });
  let restricted;
  try {
    restricted = await launchRestrictedBrowser(chromium, [first.origin, second.origin]);
    const page = await restricted.context.newPage();
    await page.goto(first.origin + '/start');
    assert.equal(page.url(), second.origin + '/landing');
    assert.match(landingCookie, /synthetic_policy=verified/);
    await page.getByRole('button', { name: 'ready', exact: true }).click();
    assert.equal(await page.getByRole('button').innerText(), 'hydrated');
    assert.ok(restricted.blocked.every(origin => ![first.origin, second.origin].includes(origin)));
    assert.deepEqual(restricted.requestedExternal, []);
    assert.deepEqual(restricted.errors, []);
    await restricted.close();
    await assert.rejects(fetch(restricted.proxyOrigin + '/', { signal: AbortSignal.timeout(1000) }));
  } finally {
    await restricted?.close();
    await Promise.all([first, second].map(server => server.close()));
  }
});

test('fetch and popup redirects cannot reach a forbidden origin', async t => {
  let forbiddenRequests = 0;
  const forbidden = await endpoint((_, response) => {
    forbiddenRequests++;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end('forbidden');
  });
  const second = await endpoint((_, response) => {
    response.writeHead(302, { Location: forbidden.origin + '/landing', 'Access-Control-Allow-Origin': '*' });
    response.end();
  });
  const first = await endpoint((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<p>local page</p>'); }
    else if (['/fetch', '/popup'].includes(request.url)) { response.writeHead(302, { Location: second.origin + '/forward' }); response.end(); }
    else { response.writeHead(204); response.end(); }
  });
  let restricted;
  try {
    restricted = await launchRestrictedBrowser(chromium, [first.origin, second.origin]);
    const page = await restricted.context.newPage();
    await page.goto(first.origin);
    const result = await page.evaluate(async url => {
      try { await fetch(url); return 'unexpected success'; } catch { return 'blocked'; }
    }, first.origin + '/fetch');
    assert.equal(result, 'blocked');
    assert.equal(forbiddenRequests, 0);
    assert.equal(restricted.blocked.filter(origin => origin === forbidden.origin).length, 1);
    const popupReady = restricted.context.waitForEvent('page');
    await page.evaluate(url => { window.open(url); }, first.origin + '/popup');
    const popup = await popupReady;
    await popup.waitForLoadState().catch(() => {});
    t.diagnostic(`forbidden fetch/popup redirect requests: ${forbiddenRequests}`);
    assert.equal(forbiddenRequests, 0, 'Popup target bypassed the policy');
    assert.equal(restricted.blocked.filter(origin => origin === forbidden.origin).length, 2);
    assert.deepEqual(restricted.errors, []);
  } finally {
    await restricted?.close();
    await Promise.all([first, second, forbidden].map(server => server.close()));
  }
});

test('service workers cannot register or send requests outside the policy', async t => {
  let workerScripts = 0, forbiddenRequests = 0;
  const forbidden = await endpoint((_, response) => { forbiddenRequests++; response.end('forbidden'); });
  const first = await endpoint((request, response) => {
    if (request.url === '/sw.js') {
      workerScripts++;
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`self.addEventListener('install',()=>fetch('${forbidden.origin}/worker'))`);
    } else { response.setHeader('Content-Type', 'text/html'); response.end('<p>local page</p>'); }
  });
  let restricted;
  try {
    restricted = await launchRestrictedBrowser(chromium, [first.origin]);
    const page = await restricted.context.newPage();
    await page.goto(first.origin);
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js').catch(() => {}); });
    t.diagnostic(`service-worker scripts: ${workerScripts}; forbidden worker requests: ${forbiddenRequests}`);
    assert.equal(workerScripts, 0, 'Service worker script escaped registration blocking');
    assert.equal(forbiddenRequests, 0);
    assert.equal(restricted.context.serviceWorkers().length, 0);
    assert.deepEqual(restricted.errors, []);
  } finally {
    await restricted?.close();
    await Promise.all([first, forbidden].map(server => server.close()));
  }
});

test('dedicated worker redirect hops cannot bypass the policy', async t => {
  let forbiddenRequests = 0;
  const forbidden = await endpoint((_, response) => { forbiddenRequests++; response.end('forbidden'); });
  const first = await endpoint((request, response) => {
    if (request.url === '/worker.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end("fetch('/worker-fetch').then(()=>postMessage('unexpected success')).catch(()=>postMessage('blocked'));");
    } else if (request.url === '/worker-fetch') {
      response.writeHead(302, { Location: forbidden.origin + '/landing' }); response.end();
    } else { response.setHeader('Content-Type', 'text/html'); response.end('<p>local page</p>'); }
  });
  let restricted;
  try {
    restricted = await launchRestrictedBrowser(chromium, [first.origin]);
    const page = await restricted.context.newPage();
    await page.goto(first.origin);
    const result = await page.evaluate(() => new Promise((resolve, reject) => {
      const worker = new Worker('/worker.js');
      worker.onmessage = event => { resolve(event.data); worker.terminate(); };
      worker.onerror = event => reject(new Error(event.message));
    })).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(restricted.errors)}`); });
    assert.equal(result, 'blocked');
    t.diagnostic(`forbidden dedicated-worker redirect requests: ${forbiddenRequests}`);
    assert.equal(forbiddenRequests, 0);
    assert.ok(restricted.blocked.includes(forbidden.origin));
    assert.deepEqual(restricted.errors, []);
  } finally {
    await restricted?.close();
    await Promise.all([first, forbidden].map(server => server.close()));
  }
});

test('HTTPS tunnels are denied before connecting to the forbidden server', async t => {
  let connections = 0, allowedConnections = 0;
  const forbidden = await endpoint((_, response) => response.end('forbidden'));
  forbidden.server.on('connection', () => connections++);
  const first = await endpoint((_, response) => response.end('local'));
  first.server.on('connection', () => allowedConnections++);
  let restricted;
  try {
    restricted = await launchRestrictedBrowser(chromium, [first.origin]);
    const page = await restricted.context.newPage();
    const target = forbidden.origin.replace('http:', 'https:');
    await page.goto(target + '/tunnel').catch(() => {});
    assert.equal(connections, 0, 'CONNECT tunnel reached the forbidden server');
    assert.ok(restricted.blocked.includes(target));
    const opaqueTarget = first.origin.replace('http:', 'https:');
    await page.goto(opaqueTarget + '/opaque').catch(() => {});
    t.diagnostic(`forbidden CONNECT connections: ${connections}; opaque TLS target connections: ${allowedConnections}`);
    assert.equal(allowedConnections, 0, 'Opaque TLS bytes were relayed through an allowed HTTP authority');
    assert.ok(restricted.blocked.includes(opaqueTarget));
    assert.deepEqual(restricted.errors, []);
  } finally {
    await restricted?.close();
    await Promise.all([first, forbidden].map(server => server.close()));
  }
});

test('allowed WebSockets work while off-origin upgrades never reach their server', async t => {
  let forbiddenConnections = 0;
  const forbidden = await endpoint((_, response) => response.end('forbidden'));
  forbidden.server.on('connection', () => forbiddenConnections++);
  const first = await endpoint((_, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<p>local page</p>'); });
  first.server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 8]), Buffer.from('ws-ready')]));
    socket.on('data', () => socket.end());
    socket.on('error', () => socket.destroy());
  });
  let restricted;
  try {
    restricted = await launchRestrictedBrowser(chromium, [first.origin]);
    const page = await restricted.context.newPage();
    await page.goto(first.origin);
    const result = await page.evaluate(url => new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onmessage = event => { resolve(event.data); socket.close(); };
      socket.onerror = () => reject(new Error('Allowed WebSocket failed'));
    }), first.origin.replace('http:', 'ws:') + '/socket');
    assert.equal(result, 'ws-ready');
    await page.evaluate(url => new Promise(resolve => {
      const socket = new WebSocket(url);
      socket.onerror = () => resolve();
      socket.onclose = () => resolve();
      socket.onopen = () => { socket.close(); resolve(); };
    }), forbidden.origin.replace('http:', 'ws:') + '/socket');
    assert.equal(forbiddenConnections, 0, 'Off-origin WebSocket bypassed the proxy');
    assert.ok(restricted.blocked.includes(forbidden.origin.replace('http:', 'ws:')));
    assert.ok(restricted.requestedExternal.includes(forbidden.origin.replace('http:', 'ws:')), 'Forbidden application WebSocket remains in app evidence');
    const workerResults = await page.evaluate(async urls => {
      const connect = url => new Promise((resolve, reject) => {
        const code = `const socket=new WebSocket(${JSON.stringify(url)});socket.onmessage=e=>postMessage(e.data);socket.onerror=()=>postMessage('blocked');socket.onopen=()=>{};`;
        const workerUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const worker = new Worker(workerUrl);
        const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(workerUrl); reject(new Error('Worker WebSocket timed out')); }, 5000);
        worker.onmessage = event => {
          clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(workerUrl); resolve(event.data);
        };
      });
      return { allowed: await connect(urls.allowed), denied: await connect(urls.denied) };
    }, { allowed: first.origin.replace('http:', 'ws:') + '/socket', denied: forbidden.origin.replace('http:', 'ws:') + '/socket' });
    assert.deepEqual(workerResults, { allowed: 'ws-ready', denied: 'blocked' });
    t.diagnostic(`forbidden page/worker WebSocket connections: ${forbiddenConnections}`);
    assert.equal(forbiddenConnections, 0, 'Worker WebSocket bypassed the proxy');
    assert.ok(restricted.blocked.includes(forbidden.origin.replace('http:', 'https:')), 'Worker CONNECT denial must appear in evidence');
    assert.deepEqual(restricted.errors, []);
  } finally {
    await restricted?.close();
    await Promise.all([first, forbidden].map(server => server.close()));
  }
});

test('worker-only forbidden WebSocket appears in strict application evidence', async t => {
  let contacts = 0;
  const forbidden = await endpoint((_, response) => response.end('forbidden'));
  forbidden.server.on('connection', () => contacts++);
  const first = await endpoint((_, response) => response.end('<p>local</p>'));
  let restricted;
  try {
    restricted = await launchRestrictedBrowser(chromium, [first.origin]);
    const page = await restricted.context.newPage();
    await page.goto(first.origin);
    const target = forbidden.origin.replace('http:', 'ws:');
    const result = await page.evaluate(url => new Promise((resolve, reject) => {
      const code = `const socket=new WebSocket(${JSON.stringify(url)});socket.onerror=()=>postMessage('blocked')`;
      const blob = URL.createObjectURL(new Blob([code], {type:'text/javascript'}));
      const worker = new Worker(blob);
      const timer = setTimeout(() => reject(Error('Worker timeout')), 5000);
      worker.onmessage = event => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(blob); resolve(event.data); };
    }), target + '/only-worker');
    assert.equal(result, 'blocked');
    await restricted.flushNetworkEvidence();
    assert.equal(contacts, 0);
    assert.ok(restricted.blocked.includes(forbidden.origin.replace('http:', 'https:')));
    t.diagnostic(JSON.stringify({target,contacts,requestedExternal:restricted.requestedExternal,blocked:restricted.blocked,errors:restricted.errors}));
    assert.ok(restricted.requestedExternal.includes(target), 'worker request must appear as its actual ws origin');
    assert.throws(() => assert.ok(restricted.requestedExternal.every(origin => origin === 'https://fonts.googleapis.com')), 'strict application allowlist must reject worker traffic');
    assert.deepEqual(restricted.errors, []);
  } finally { await restricted?.close(); await Promise.all([first,forbidden].map(server=>server.close())); }
});

test('directory browser selectors fail before browser allocation', async () => {
  const previous = process.env.TEST_CHROMIUM_EXECUTABLE;
  process.env.TEST_CHROMIUM_EXECUTABLE = '/tmp';
  try {
    await assert.rejects(launchRestrictedBrowser({launch:async()=>{throw Error('Browser allocation attempted')}}, ['http://127.0.0.1:12345']), /regular executable file/);
  } finally { if (previous === undefined) delete process.env.TEST_CHROMIUM_EXECUTABLE; else process.env.TEST_CHROMIUM_EXECUTABLE = previous; }
});

test('the application cannot reach the trusted loopback debugger listener', async () => {
  const first = await endpoint((_,response)=>response.end('<p>local</p>'));
  let restricted;
  try {
    restricted=await launchRestrictedBrowser(chromium,[first.origin]);
    const session=await restricted.browser.newBrowserCDPSession();
    const command=await session.send('Browser.getBrowserCommandLine');
    const port=command.arguments.find(value=>value.startsWith('--remote-debugging-port=')).split('=')[1];
    const target=`http://127.0.0.1:${port}`;
    const page=await restricted.context.newPage();await page.goto(first.origin);
    const result=await page.evaluate(url=>fetch(url).then(response=>response.status).catch(()=>'blocked'),target+'/json/version');
    assert.ok(result==='blocked'||result===403);
    await restricted.flushNetworkEvidence();
    assert.ok(restricted.blocked.includes(target));
    assert.ok(restricted.requestedExternal.includes(target));
    assert.deepEqual(restricted.errors,[]);
  } finally {await restricted?.close();await first.close()}
});


test('debugger binding tables reject wildcard and nonloopback listeners without opening them', () => {
  assert.equal(typeof workerNetwork.validateDebuggerBindings,'function','controlled binding verifier seam is missing');
  const port=12345, hex=port.toString(16).toUpperCase().padStart(4,'0');
  const row=(address,state='0A',suffix=hex)=>` 0: ${address}:${suffix} 00000000:0000 ${state} 0 0 0`;
  const table=(...rows)=>'sl local_address rem_address st\n'+rows.join('\n')+'\n';
  for(const address of ['0100007F','00000000000000000000000001000000'])assert.doesNotThrow(()=>workerNetwork.validateDebuggerBindings([table(row(address))],port));
  for(const address of ['00000000','00000000000000000000000000000000','0100000A','000080FE000000000000000001000000']){
    assert.throws(()=>workerNetwork.validateDebuggerBindings([table(row('0100007F')),table(row(address))],port),/only on loopback/);
  }
  assert.throws(()=>workerNetwork.validateDebuggerBindings([table(row('0100007F','01'))],port),/only on loopback/);
  assert.throws(()=>workerNetwork.validateDebuggerBindings([table(row('0100007F','0A','FFFF'))],port),/only on loopback/);
  assert.doesNotThrow(()=>workerNetwork.validateDebuggerBindings([table(row('0100007F'),row('00000000','0A','FFFF'))],port));
});
