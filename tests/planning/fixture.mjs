// Actual compiled Worker/D1, synthetic JWKS, and opt-in controlled callbacks.
import { build } from 'esbuild';
import { createHmac } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
export async function planningFixture({ callbacks = {}, engineHarness = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'planning-worker-'));
  let worker;
  try {
    const config = JSON.parse(await readFile('dist/server/wrangler.json', 'utf8'));
    const origin = 'https://planning.example.test';
    const issuer = 'https://planning-fixture.cloudflareaccess.com';
    const audience = 'c'.repeat(64);
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'planning-fixture', use: 'sig', alg: 'RS256' };
    const tokens = {};
    for (const actor of ['alice', 'bob']) tokens[actor] = await new SignJWT({ type: 'app', email: actor + '@example.test', sub: actor })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: jwk.kid }).setIssuer(issuer).setAudience(audience)
      .setIssuedAt().setExpirationTime('10m').sign(privateKey);
    const unexpected = [];
    const pauseGates = new Map();
    const files = await readdir('dist/server', { recursive: true });
    const options = { host: '127.0.0.1', port: 0, modulesRoot: 'dist/server',
      assets: { directory: 'dist/client', binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false } },
      modules: [config.main, ...files.filter(path => /\.m?js$/.test(path) && path !== config.main)].map(path => ({ type: 'ESModule', path: join('dist/server', path) })),
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
      bindings: { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: audience, ACCESS_APPLICATION_ORIGIN: origin, ACCESS_ALLOWED_EMAILS: '["alice@example.test","bob@example.test"]' },
      d1Databases: { DB: '00000000-0000-4000-8000-000000000000' }, d1Persist: join(directory, 'd1'),
      outboundService: async request => {
        if (request.url === issuer + '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
        if (engineHarness && request.url === 'https://planning-fixture.internal/pause') {
          const gate = pauseGates.get(await request.text());
          assert.ok(gate, 'Only an explicitly registered fixture acquisition may pause');
          gate.paused = true; await gate.released;
          return new Response(null, { status: 204 });
        }
        const target = callbacks[request.url];
        if (target) {
          const body = await request.text();
          const id = request.headers.get('webhook-id');
          const timestamp = request.headers.get('webhook-timestamp');
          const expected = 'v1,' + createHmac('sha256', Buffer.from(target.secret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
          assert.ok(request.headers.get('webhook-signature').split(' ').includes(expected), 'Real callback HMAC');
          const event = JSON.parse(body);
          if (event.type === 'verification') return Response.json({ challenge: event.challenge });
          target.events.push({ event, id, body, subscription: request.headers.get('X-MCP-Subscription-Id') });
          return target.respond ? target.respond(event, request) : new Response(null, { status: 204 });
        }
        unexpected.push(request.url); return new Response('Forbidden test destination', { status: 403 });
      },
    };
    // Fixture-only auxiliary Worker runs shared helpers against the same real D1.
    // It is never part of the application build or externally registered routes.
    let engineCode;
    if (engineHarness) {
      const bundled = await build({ stdin: { contents: `
        import { planningMetadata, retryPlanningJob, deliverJob } from './lib/planning-recovery';
        import { deliverDue } from './lib/planning-delivery';
        function delayedDatabase(db, gate) {
          function statement(inner) {
            return new Proxy(inner, { get(target, key) {
              if (key === 'bind') return (...args) => statement(target.bind(...args));
              if (key === 'all') return async (...args) => {
                const result = await target.all(...args);
                // Pause only after a real due-target read, retaining its snapshot.
                if (!gate.paused && result.results.some(row => 'delivery_token' in row && 'attempts' in row)) {
                  gate.paused = true; await fetch('https://planning-fixture.internal/pause', { method: 'POST', body: gate.id });
                }
                return result;
              };
              const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
            }});
          }
          return new Proxy(db, { get(target, key) {
            if (key === 'prepare') return query => statement(target.prepare(query));
            const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
          }});
        }
        export default { async fetch(request, env) {
          const { operation, id, owner } = await request.json();
          if (operation === 'delayed-due') {
            await deliverDue(delayedDatabase(env.DB, { id, paused: false }), owner, id);
            return Response.json({});
          }
          if (operation === 'due') { await deliverDue(env.DB, owner, id); return Response.json({}); }
          if (operation === 'deliver') { await deliverJob(id, owner); return Response.json({}); }
          if (operation === 'retry') return Response.json(await retryPlanningJob(id, owner, env.DB));
          const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=? AND owner=?').bind(id, owner).first();
          return Response.json(job ? await planningMetadata(job, env.DB) : null);
        }};`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false,
        format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'] });
      engineCode = bundled.outputFiles[0].text;
    }
    const launch = () => {
      if (!engineCode) return new Miniflare(options);
      const { host, port, d1Persist, ...appOptions } = options;
      return new Miniflare({ host, port, d1Persist, workers: [ { ...appOptions, name: 'app' },
        { name: 'planning-helper', modules: true, script: engineCode, compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags, d1Databases: options.d1Databases, outboundService: options.outboundService } ] });
    };
    worker = launch();
    await worker.ready;
    let db = await worker.getD1Database('DB', engineCode ? 'app' : undefined);
    for (const name of (await readdir('drizzle')).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(join('drizzle', name), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').filter(statement => statement.trim())) await db.prepare(statement).run();
    }
    const dispatch = (path, init = {}, actor = 'alice') => worker.dispatchFetch(origin + path, {
      ...init, headers: { authorization: 'Bearer ' + tokens[actor], ...Object.fromEntries(new Headers(init.headers)) }, redirect: 'manual',
    });
    const request = async (path, body, actor = 'alice', headers = {}) => {
      const response = await worker.dispatchFetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + tokens[actor], origin, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
      return { status: response.status, body: await response.json() };
    };
    const rpc = async (name, args, actor = 'alice') => {
      const response = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args ?? {} } }, actor);
      assert.equal(response.status, 200); return response.body;
    };
    return { engine: async (operation, id, owner) => {
      if (operation === 'pause-state') return { paused: pauseGates.get(id)?.paused ?? false };
      if (operation === 'resume') { pauseGates.get(id)?.release(); return {}; }
      if (operation === 'delayed-due') {
        const gate = { paused: false };
        gate.released = new Promise(resolve => { gate.release = resolve; });
        pauseGates.set(id, gate);
      }
      try {
        const helper = await worker.getWorker('planning-helper');
        const response = await helper.fetch('https://fixture.internal/', { method: 'POST', body: JSON.stringify({ operation, id, owner }) });
        return await response.json();
      } finally { if (operation === 'delayed-due') pauseGates.delete(id); }
    }, get db() { return db; }, origin, dispatch, request, rpc, scheduled: async () => { assert.deepEqual(config.triggers.crons, ['*/1 * * * *']); const entry = await worker.getWorker(engineCode ? 'app' : undefined); return entry.scheduled({ cron: config.triggers.crons[0], scheduledTime: Date.now() }); }, restart: async () => { await worker.dispose(); worker = launch(); await worker.ready; db = await worker.getD1Database('DB', engineCode ? 'app' : undefined); }, close: async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(unexpected, [], 'Unexpected outbound requests'); } };
  } catch (error) {
    await worker?.dispose(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
