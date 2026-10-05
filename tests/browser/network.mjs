import { createServer, request as httpRequest } from 'node:http';
import { trustedBrowserExecutable } from './executable.mjs';
import { observeWorkerNetwork, localDebuggerEndpoint } from './worker-network.mjs';
import { loopbackUrl, freePort } from '../harness.mjs';

// Chromium bypasses proxies for loopback by default. <-loopback> removes that
// bypass, so native redirects, popups, frames and workers all cross this gate.
export async function launchRestrictedBrowser(chromium, values, options = {}) {
  const executablePath = await trustedBrowserExecutable(process.env.TEST_CHROMIUM_EXECUTABLE);
  const origins = values.map(value => loopbackUrl(value).origin);
  const blocked = [], requestedExternal = [], errors = [], sockets = new Set(), tunnels = new WeakMap();
  let browser, closing, stopObserving;
  const track = socket => {
    if (!sockets.has(socket)) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
    return socket;
  };
  function target(request, connect = false) {
    let url;
    try { url = new URL(connect ? `https://${request.url}` : request.url, tunnels.get(request.socket)); }
    catch { blocked.push('invalid URL'); return null; }
    if (!connect && url.protocol === 'http:' && !url.username && !url.password && origins.includes(url.origin)) return url;
    blocked.push(url.origin);
    return null;
  }
  const proxy = createServer((request, response) => {
    const url = target(request);
    if (!url) { response.writeHead(403); response.end('Blocked by browser test network policy'); return; }
    const upstream = httpRequest(url, { method: request.method, headers: { ...request.headers, host: url.host } }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('socket', track);
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  proxy.on('connection', track);
  proxy.on('connect', (request, socket, head) => {
    let destination;
    try { destination = new URL(`http://${request.url}`); } catch { /* Deny malformed authorities below. */ }
    if (!destination || destination.username || destination.password || !origins.includes(destination.origin)) {
      target(request, true);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    // Chromium tunnels even plain ws:// through CONNECT. Parse the tunnel as
    // HTTP here instead of opening a raw TCP relay: every request/upgrade still
    // passes target(), and TLS or any other opaque protocol cannot escape.
    tunnels.set(socket, destination.origin);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    proxy.emit('connection', socket);
    if (head.length) socket.unshift(head);
  });
  proxy.on('clientError', (_, socket) => {
    if (tunnels.has(socket)) blocked.push(tunnels.get(socket).replace('http:', 'https:'));
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  proxy.on('upgrade', (request, socket, head) => {
    const url = target(request);
    if (!url) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = httpRequest(url, { method: request.method, headers: { ...request.headers, host: url.host } });
    upstream.on('socket', track);
    upstream.on('upgrade', (response, peer, peerHead) => {
      const headers = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) peer.write(head);
      if (peerHead.length) socket.write(peerHead);
      socket.pipe(peer).pipe(socket);
      socket.on('error', () => peer.destroy());
      peer.on('error', () => socket.destroy());
      socket.once('close', () => peer.destroy());
      peer.once('close', () => socket.destroy());
    });
    upstream.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.end();
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
  const closeProxy = () => {
    closing ??= new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      proxy.close(error => error ? reject(error) : resolve());
    });
    return closing;
  };
  try {
    const debuggerPort = await freePort();
    browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${debuggerPort}`, '--remote-debugging-address=127.0.0.1'], ...(executablePath ? { executablePath } : {}), proxy: { server: proxyOrigin, bypass: '<-loopback>' } });
    browser.once('disconnected', () => { void closeProxy().catch(error => errors.push(error.message)); });
    const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
    stopObserving = await observeWorkerNetwork(await localDebuggerEndpoint(debuggerPort), origins, requestedExternal, errors, () => browser.close());
    context.on('request', request => {
      const url = new URL(request.url());
      if (['http:', 'https:'].includes(url.protocol) && !origins.includes(url.origin)) requestedExternal.push(url.origin);
    });
    await context.routeWebSocket('**/*', webSocket => {
      const url = new URL(webSocket.url());
      if (url.protocol === 'ws:' && origins.includes(url.origin.replace(/^ws:/, 'http:'))) return webSocket.connectToServer();
      blocked.push(url.origin);
      requestedExternal.push(url.origin);
      webSocket.close();
    });
    return { browser, context, blocked, requestedExternal, errors, proxyOrigin, flushNetworkEvidence: () => stopObserving.flush(), close: async () => {
      stopObserving?.close();
      try { await browser.close(); } finally { await closeProxy(); }
    } };
  } catch (error) {
    stopObserving?.close();
    await browser?.close();
    await closeProxy();
    throw error;
  }
}
