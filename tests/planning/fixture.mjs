// Actual compiled Worker/D1; only the synthetic external JWKS is supplied here.
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
export async function planningFixture({ executionRegistry } = {}) {
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
    const files = await readdir('dist/server', { recursive: true });
    worker = new Miniflare({ host: '127.0.0.1', port: 0, modulesRoot: 'dist/server',
      modules: [config.main, ...files.filter(path => /\.m?js$/.test(path) && path !== config.main)].map(path => ({ type: 'ESModule', path: join('dist/server', path) })),
      compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
      bindings: { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: audience, ACCESS_APPLICATION_ORIGIN: origin, ACCESS_ALLOWED_EMAILS: '["alice@example.test","bob@example.test"]', ...(executionRegistry === undefined ? {} : { EXECUTION_REGISTRY: executionRegistry }) },
      d1Databases: { DB: '00000000-0000-4000-8000-000000000000' }, d1Persist: join(directory, 'd1'),
      outboundService: request => {
        if (request.url === issuer + '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
        unexpected.push(request.url); return new Response('Forbidden test destination', { status: 403 });
      },
    });
    await worker.ready;
    const db = await worker.getD1Database('DB');
    for (const name of (await readdir('drizzle')).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(join('drizzle', name), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').filter(statement => statement.trim())) await db.prepare(statement).run();
    }
    const request = async (path, body, actor = 'alice') => {
      const response = await worker.dispatchFetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + tokens[actor], origin, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
      return { status: response.status, body: await response.json() };
    };
    const rpc = async (name, args, actor = 'alice') => {
      const response = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args ?? {} } }, actor);
      assert.equal(response.status, 200); return response.body;
    };
    return { db, request, rpc, close: async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(unexpected, [], 'Unexpected outbound requests'); } };
  } catch (error) {
    await worker?.dispose(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
