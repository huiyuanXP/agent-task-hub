import { readFile } from 'node:fs/promises';

/** Pure proc-table validation; tests supply controlled rows without binding an
 * unsafe address. Production always supplies actual Linux proc tables below. */
export function validateDebuggerBindings(tables, port) {
  const rows = tables.flatMap(text => text.trim().split('\n').slice(1));
  const listeners = rows.map(row => row.trim().split(/\s+/)).filter(fields => fields[3] === '0A' && parseInt(fields[1].split(':')[1], 16) === port);
  if (!listeners.length || listeners.some(fields => !['0100007F', '00000000000000000000000001000000'].includes(fields[1].split(':')[0]))) throw Error('Chromium debugger must listen only on loopback');
}

/** Verify the generated Chromium listener before trusting its public CDP URL. */
export async function localDebuggerEndpoint(port) {
  let tables;
  try { tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map(path => readFile(path, 'utf8'))); }
  catch (cause) { throw Error('Browser worker observation requires readable Linux /proc/net/tcp and tcp6', {cause}); }
  validateDebuggerBindings(tables, port);
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw Error('Chromium debugger endpoint unavailable');
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 16384) throw Error('Chromium debugger discovery response too large'); chunks.push(Buffer.from(item.value)); }
  } finally { await reader.cancel(); }
  const endpoint = new URL(JSON.parse(Buffer.concat(chunks).toString()).webSocketDebuggerUrl);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== String(port) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/devtools\/browser\/[a-f0-9-]+$/.test(endpoint.pathname)) throw Error('Unexpected Chromium debugger endpoint');
  return endpoint.href;
}

/** Public flattened CDP sessions pause targets until trusted network observation
 * is installed. Background targets are never classified as application traffic. */
export async function observeWorkerNetwork(endpoint, origins, requestedExternal, errors, failClosed) {
  const socket = new WebSocket(endpoint);
  let sequence = 0, closing = false, owner;
  const pending = new Map(), sessions = new Set(), workers = new Set();
  function dispose() {
    closing = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Worker network observer closed')); }
    pending.clear(); sessions.clear(); workers.clear(); socket.close();
  }
  function fail(error) {
    if (closing) return;
    errors.push(error.message); dispose(); void Promise.resolve().then(failClosed).catch(() => {});
  }
  socket.addEventListener('error', () => fail(Error('Worker network observer transport failed')));
  socket.addEventListener('close', () => fail(Error('Worker network observer disconnected')));
  function request(method, params = {}, sessionId) {
    if (closing || pending.size >= 256) return Promise.reject(Error('Worker observer command capacity exceeded or closed'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`Worker observer timed out: ${method}`)); }, 3000);
      pending.set(id, { resolve, reject, timer });
      try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? {sessionId} : {}) })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  const filter = [{type:'page'}, {type:'iframe'}, {type:'worker'}, {type:'shared_worker'}, {exclude:true}];
  async function attached(message) {
    const {sessionId, targetInfo} = message.params;
    const owned = targetInfo.browserContextId === owner || (!targetInfo.browserContextId && sessions.has(message.sessionId));
    if (!owned) {
      await request('Runtime.runIfWaitingForDebugger', {}, sessionId);
      await request('Target.detachFromTarget', {sessionId});
      return;
    }
    if (sessions.size >= 128) throw Error('Worker observer session capacity exceeded');
    sessions.add(sessionId);
    if (['worker', 'shared_worker'].includes(targetInfo.type)) workers.add(sessionId);
    await request('Network.enable', {}, sessionId);
    await request('Target.setAutoAttach', {autoAttach:true, waitForDebuggerOnStart:true, flatten:true, filter}, sessionId);
    await request('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }
  socket.addEventListener('message', event => {
    try {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1048576) throw Error('Worker observer message capacity exceeded');
      const message = JSON.parse(event.data);
      if (message.id) {
        const item = pending.get(message.id);
        if (item) { clearTimeout(item.timer); pending.delete(message.id); if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result); }
        return;
      }
      const params = message.params;
      if (message.method === 'Target.attachedToTarget') void attached(message).catch(fail);
      else if (message.method === 'Target.detachedFromTarget') { sessions.delete(params.sessionId); workers.delete(params.sessionId); }
      else if (workers.has(message.sessionId) && ['Network.webSocketCreated','Network.requestWillBeSent'].includes(message.method)) {
        const url = new URL(params.url ?? params.request.url);
        if (['http:','https:','ws:','wss:'].includes(url.protocol) && !origins.includes(url.origin.replace(/^ws:/,'http:').replace(/^wss:/,'https:'))) requestedExternal.push(url.origin);
      }
    } catch (error) { fail(error); }
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Worker observer connection timeout')), 3000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once:true});
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('Worker observer connection failed')); }, {once:true});
    });
    const {browserContextIds} = await request('Target.getBrowserContexts');
    if (browserContextIds.length !== 1) throw Error('Worker observer requires exactly one owned test browser context');
    [owner] = browserContextIds;
    await request('Target.setAutoAttach', {autoAttach:true, waitForDebuggerOnStart:true, flatten:true, filter});
    return { close: dispose, flush: () => request('Browser.getVersion') };
  } catch (error) { dispose(); throw error; }
}
