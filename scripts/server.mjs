import { createServer } from 'node:http';
import next from 'next';
import { planningInterval, startPlanningScheduler } from './planning-scheduler.mjs';
import { loadExecutionConfiguration } from './execution-config.mjs';
import { database, closeDatabases } from '../lib/local-store.mts';
import { AuthError, authenticateHeaders, checkRequestOrigin, configuredOrigin } from '../lib/local-auth.mts';

process.env.NEXT_TELEMETRY_DISABLED = '1';
const args = process.argv.slice(2);
let dev = false;
let executionConfig;
let requestedPort;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dev') dev = true;
  else if (args[i] === '--port') requestedPort = Number(args[++i]);
  else if (args[i] === '--execution-config') {
    executionConfig = args[++i];
    if (!executionConfig) throw Error('--execution-config requires a private configuration file');
  } else throw Error(`Unknown server option: ${args[i]}`);
}
const controlOrigin = executionConfig ? await loadExecutionConfiguration(executionConfig) : undefined;
const configuredPort = controlOrigin
  ? Number(controlOrigin.port || (controlOrigin.protocol === 'https:' ? 443 : 80))
  : 5173;
const port = requestedPort ?? Number(process.env.APP_PORT ?? configuredPort);
const schedulerInterval = planningInterval();
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid server port');

const hostname = process.env.APP_HOST ?? (controlOrigin?.hostname === '[::1]' ? '::1' : controlOrigin?.hostname) ?? '127.0.0.1';
const originHostname = hostname.includes(':') ? `[${hostname}]` : hostname;
process.env.APP_ORIGIN ??= `http://${originHostname}:${port}`;
const origin = configuredOrigin();
const db = database();
const app = next({ dev, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', origin);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    }

    // These exact machine endpoints authenticate their own credentials in-route.
    const service = new Set(['/api/execution/checkpoint','/api/connector/enroll','/api/connector/heartbeat','/api/connector/mcp','/api/connector/agent']).has(url.pathname);
    const publicDownload = url.pathname === '/api/connectors/download' && ['GET','HEAD'].includes(req.method ?? 'GET');
    if (!service) {
      const protectedRoute =
        (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/')) ||
        url.pathname === '/mcp';
      if (protectedRoute && !publicDownload) {
        const session = await authenticateHeaders(db, headers, req.method ?? 'GET', origin);
        if (!session) throw new AuthError(401, 'Authentication required');
      } else {
        checkRequestOrigin(headers, req.method ?? 'GET', origin, 'none');
      }
    }

    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
      res.setHeader('Cache-Control', 'private, no-store');
    }
    await handle(req, res);
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 503;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    });
    res.end(JSON.stringify({
      error: error instanceof AuthError ? error.message : 'Application unavailable',
    }));
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, hostname, resolve);
});
const scheduler = startPlanningScheduler(db, schedulerInterval);
console.log(`Local server ready at ${origin}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const httpClosed = new Promise(resolve => server.close(resolve));
  await scheduler.stop();
  await httpClosed;
  await app.close();
  closeDatabases();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown().then(() => process.exit(0), () => process.exit(1));
  });
}
