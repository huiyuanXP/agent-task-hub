import { signReply } from '../../../lib/execution/transport.mts';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { REGISTERED_OPERATIONS } from '../../../lib/execution/registry.mts';
import { startSupervisor } from '../../../runner/server.mjs';
import { cleanupFixture } from './cleanup.mjs';
import { freePort } from '../../harness.mjs';
export async function consumerFixture({ docker = false } = {}) {
    const origin = 'https://hub.example.test', issuer = 'https://consumer-team.cloudflareaccess.com', audience = 'd'.repeat(64);
    const keys = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
    const token = async (sub, lifetime = '15m') => new SignJWT({ type: 'app', email: sub + '@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture', typ: 'JWT' }).setIssuer(issuer).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime(lifetime).sign(keys.privateKey);
    const alice = await token('alice'), bob = await token('bob');
    const owner = 'access:' + createHash('sha256').update(JSON.stringify([issuer, 'alice'])).digest('hex');
    const root = await mkdtemp(join(tmpdir(), 'consumer-worker-'));
    let worker, supervisor, resultOverride = null;
    const drops = new Map(), requests = [], outbound = [], backendRequests = [];
    const facade = createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req)
                chunks.push(chunk);
            const body = Buffer.concat(chunks), headers = new Headers(req.headers);
            headers.delete('host');
            if (headers.get('origin') === base)
                headers.set('origin', origin);
            const name = body.length ? (() => { try {
                const v = JSON.parse(body);
                return v.params?.name ?? v.action ?? v.method;
            }
            catch {
                return null;
            } })() : null;
            requests.push({ name, path: req.url });
            const response = await worker.dispatchFetch(origin + req.url, { method: req.method, headers, ...(body.length ? { body } : {}), redirect: 'manual' });
            const bytes = Buffer.from(await response.arrayBuffer());
            if (drops.get(name) > 0) {
                drops.set(name, drops.get(name) - 1);
                res.destroy();
                return;
            }
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(bytes);
        }
        catch {
            res.writeHead(503);
            res.end('Unavailable');
        }
    });
    await new Promise(r => facade.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + facade.address().port;
    async function pair(keyId) { const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); return { signing: { keyId, privateKey: k.privateKey }, trust: { keyId, key: k.publicKey }, private: JSON.stringify({ keyId, jwk: await crypto.subtle.exportKey('jwk', k.privateKey) }), public: JSON.stringify({ keyId, jwk: await crypto.subtle.exportKey('jwk', k.publicKey) }) }; }
    const control = await pair('control'), node = await pair('supervisor'), evidence = await pair('evidence');
    const runnerPort = await freePort(), runnerUrl = 'http://127.0.0.1:' + runnerPort;
    const registry = [...REGISTERED_OPERATIONS, { ...REGISTERED_OPERATIONS[0], operationId: 'consumer.slow', label: 'Consumer slow integration', argv: ['node', '-e', 'process.stdout.write("consumer actual execution");setTimeout(()=>{},10000)'], inputs: [], artifacts: [] }];
    const bindings = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUDIENCE: audience, ACCESS_APPLICATION_ORIGIN: origin, ACCESS_ALLOWED_EMAILS: '["alice@example.test","bob@example.test"]', EXECUTION_REGISTRY: JSON.stringify(registry), EXECUTION_RUNNER_URL: runnerUrl, EXECUTION_RUNNER_AUDIENCE: 'runner', EXECUTION_CHECKPOINT_AUDIENCE: 'control', EXECUTION_CONTROL_KEY: control.private, EXECUTION_RUNNER_KEY: node.public, EXECUTION_EVIDENCE_KEY: evidence.public };
    const built = JSON.parse(await readFile('dist/server/wrangler.json', 'utf8'));
    const options = { host: '127.0.0.1', port: 0, modulesRoot: 'dist/server', modules: [built.main, ...(await readdir('dist/server', { recursive: true })).filter(p => /\.m?js$/.test(p) && p !== built.main)].map(path => ({ type: 'ESModule', path: join('dist/server', path) })), compatibilityDate: built.compatibility_date, compatibilityFlags: built.compatibility_flags,
        bindings, d1Databases: { DB: '00000000-0000-4000-8000-000000000000' }, d1Persist: join(root, 'd1'), assets: { directory: 'dist/client', binding: 'ASSETS', routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: false } },
        outboundService: async (request) => { if (request.url === issuer + '/cdn-cgi/access/certs')
            return Response.json({ keys: [jwk] }); if (docker && new URL(request.url).origin === runnerUrl) {
            const body = await request.text();
            backendRequests.push({ path: new URL(request.url).pathname, runId: JSON.parse(body).permit?.runId });
            if (resultOverride && new URL(request.url).pathname === '/result' && JSON.parse(body).permit?.runId === resultOverride.runId) {
                const reply = JSON.stringify({ phase: 'closed', receipts: resultOverride.receipts });
                return new Response(reply, { status: 200, headers: { 'content-type': 'application/json', 'x-execution-signature': JSON.stringify(await signReply(node.signing, JSON.parse(request.headers.get('x-execution-signature')), 200, reply)) } });
            }
            return fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body, redirect: 'error' });
        } outbound.push(request.url); return new Response('Denied', { status: 403 }); } };
    try {
        worker = new Miniflare(options);
        await worker.ready;
        let db = await worker.getD1Database('DB');
        for (const name of (await readdir('drizzle')).filter(n => n.endsWith('.sql')).sort())
            for (const sql of (await readFile(join('drizzle', name), 'utf8')).split('--> statement-breakpoint').filter(s => s.trim()))
                await db.prepare(sql).run();
        if (docker)
            supervisor = await startSupervisor({ registry, root: join(root, 'supervisor'), port: runnerPort, audience: 'runner', controlTrust: control.trust, transportKey: node.signing, evidenceKey: evidence.signing, checkpoint: { baseUrl: base, audience: 'control', direction: 'runner-to-control', signing: node.signing, trust: control.trust } });
        async function api(path, body, jwt = alice, extra = {}) { const r = await worker.dispatchFetch(origin + path, { headers: { ...(jwt ? { authorization: 'Bearer ' + jwt } : {}), ...(body ? { 'content-type': 'application/json', origin } : {}), ...extra }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }); const text = await r.text(); let data; try {
            data = JSON.parse(text);
        }
        catch {
            data = { error: 'Non-JSON response' };
        } return { status: r.status, data }; }
        async function prepare(id = 'ticket-consumer', operation = 'ticket.validate.v1', lifetime = 600000, ticketBody = JSON.stringify({ title: id, status: 'todo' })) {
            const now = new Date().toISOString();
            await db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?)').bind(id, owner, 'ticket', ticketBody, 1, now, now).run();
            const catalog = await api('/api/authorization?ticketId=' + id + '&expectedRevision=1');
            const selected = catalog.data.operations.find(o => o.operationId === operation);
            const result = await api('/api/authorization', { action: 'prepare', ticketId: id, expectedRevision: 1, requestId: id, attempt: 1, scope: [{ operationId: selected.operationId, definitionHash: selected.definitionHash }], budget: { timeoutMs: 30000, memoryMb: 256, cpus: 1, pids: 64 }, expiresAt: Date.now() + lifetime });
            if (result.status !== 201)
                throw Error('Prepare failed');
            await api('/api/authorization', { action: 'decide', authorizationId: result.data.authorization.id, decisionId: 'approve-' + id, outcome: 'approved' });
            return result.data;
        }
        return { root, origin, issuer, audience, base, alice, bob, token, owner, get db() { return db; }, bindings, registry, api, prepare, drops, requests, outbound, backendRequests, worker, supervisor, async databaseUnavailable() { await worker.setOptions({ ...options, d1Databases: {} }); }, overrideResult(value) { resultOverride = value; }, async configure(changes) { Object.assign(bindings, changes); await worker.setOptions({ ...options, bindings: { ...bindings } }); db = await worker.getD1Database('DB'); }, async close() { try {
                await supervisor?.close();
            }
            finally {
                await worker?.dispose();
                await new Promise(r => facade.close(r));
                if (docker)
                    await cleanupFixture(join(root, 'supervisor'));
                await rm(root, { recursive: true, force: true });
            } } };
    }
    catch (error) {
        await supervisor?.close();
        await worker?.dispose();
        await new Promise(r => facade.close(r));
        if (docker)
            await cleanupFixture(join(root, 'supervisor'));
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}
