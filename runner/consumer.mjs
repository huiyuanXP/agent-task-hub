import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { safeRead } from './state.mjs';
import { openConsumerState } from './consumer-state.mjs';
import { connection, endpoint, ingressHeaders, ConsumerError } from './consumer-transport.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const pause = ms => new Promise(r => setTimeout(r, ms));
function args(argv) { const [command, ...rest] = argv; const result = { command }; if (!['bootstrap', 'run', 'revoke'].includes(command) || rest.length % 2)
    throw new ConsumerError('USAGE'); for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--state', '--endpoint', '--run', '--owner-file', '--owner-fd', '--ingress-file', '--label'].includes(key) || result[key] !== undefined)
        throw new ConsumerError('USAGE');
    result[key] = rest[i + 1];
} if (!result['--state'])
    throw new ConsumerError('STATE_REQUIRED'); return result; }
async function ownerToken(options) {
    if (!!options['--owner-file'] === !!options['--owner-fd'])
        throw new ConsumerError('PROTECTED_OWNER_INPUT_REQUIRED');
    let bytes;
    if (options['--owner-file'])
        bytes = await safeRead(options['--owner-file'], 16384);
    else {
        if (!/^[0-9]{1,5}$/.test(options['--owner-fd']) || Number(options['--owner-fd']) < 3)
            throw new ConsumerError('INVALID_OWNER_DESCRIPTOR');
        // The descriptor must already name a protected regular file, not a pipe/argv.
        const file = await open('/proc/self/fd/' + options['--owner-fd'], 'r');
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 16384)
                throw new ConsumerError('UNSAFE_OWNER_DESCRIPTOR');
            bytes = await file.readFile();
        }
        finally {
            await file.close();
        }
    }
    const token = bytes.toString().trim();
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
        throw new ConsumerError('INVALID_OWNER_CREDENTIAL');
    return token;
}
function validState(value) {
    if (!value || value.version !== 1 || Object.keys(value).some(k => !['version', 'endpoint', 'runId', 'credentialId', 'secret', 'provisionRequestId', 'label', 'credential', 'lease', 'operations', 'revokeRequestId', 'finished'].includes(k)))
        throw new ConsumerError('INVALID_STATE');
    endpoint(value.endpoint);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.secret) || !value.credentialId || !value.runId)
        throw new ConsumerError('INVALID_STATE');
    return value;
}
async function bootstrap(journal, options) {
    const target = endpoint(options['--endpoint']);
    const runId = options['--run'];
    if (!runId || runId.length > 200)
        throw new ConsumerError('RUN_REQUIRED');
    if (journal.value) {
        const prior = validState(journal.value);
        if (prior.endpoint !== target || prior.runId !== runId || prior.label !== (options['--label'] ?? 'consumer'))
            throw new ConsumerError('CONFLICTING_PENDING_BOOTSTRAP');
    }
    else
        await journal.update(() => ({ version: 1, endpoint: target, runId, credentialId: randomUUID(), secret: secret(), provisionRequestId: randomUUID(), label: options['--label'] ?? 'consumer', operations: {} }));
    const state = journal.value, owner = await ownerToken(options), ingress = await ingressHeaders(options['--ingress-file'], target);
    const result = await connection(target, owner, ingress).post('/api/execution/workers', { action: 'provision', credentialId: state.credentialId, requestId: state.provisionRequestId, runId, verifier: hash(state.secret), label: state.label });
    if (result.credentialId !== state.credentialId || result.runId !== runId || !Number.isSafeInteger(result.expiresAt))
        throw new ConsumerError('INVALID_PROVISION_REPLY');
    await journal.update(v => ({ ...v, credential: result }));
    console.log('Worker delegation provisioned; bootstrap exited.');
}
async function revoke(journal, options) {
    const state = validState(journal.value);
    const owner = await ownerToken(options), ingress = await ingressHeaders(options['--ingress-file'], state.endpoint);
    if (!state.revokeRequestId)
        await journal.update(v => ({ ...v, revokeRequestId: randomUUID() }));
    await connection(state.endpoint, owner, ingress).post('/api/execution/workers', { action: 'revoke', credentialId: state.credentialId, requestId: journal.value.revokeRequestId });
    console.log('Worker delegation revoked.');
}
async function runtime(journal, options) {
    if (Object.keys(options).some(k => !['command', '--state', '--ingress-file'].includes(k)) || Object.keys(process.env).some(k => /^(?:OWNER_JWT|OWNER_TOKEN|EXECUTION_OWNER_JWT|EXECUTION_OWNER_TOKEN)$/.test(k)))
        throw new ConsumerError('OWNER_CONFIGURATION_FORBIDDEN');
    const initial = validState(journal.value);
    if (!initial.credential || initial.credential.expiresAt <= Date.now())
        throw new ConsumerError('REPROVISION_REQUIRED');
    const rpc = connection(initial.endpoint, 'athw1.' + initial.credentialId + '.' + initial.secret, await ingressHeaders(options['--ingress-file'], initial.endpoint));
    await rpc.initialize();
    let stopping = false, done = false, renewFailure = null, renewTask = null;
    const stop = () => { stopping = true; };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const currentLease = () => journal.value.lease;
    const leased = async (name, extra = {}, rotate = false) => {
        const l = currentLease();
        if (!l?.generation)
            throw new ConsumerError('LEASE_REQUIRED');
        const key = name + ':' + l.leaseId;
        await journal.update(v => { if (rotate || !v.operations[key])
            v.operations[key] = randomUUID(); return v; });
        const v = journal.value;
        return rpc.call(name, { runId: v.runId, leaseToken: 'athl1.' + l.leaseId + '.' + l.generation + '.' + l.secret, requestId: v.operations[key], ...extra });
    };
    const claim = async (mode, fresh = false) => {
        if (fresh || !currentLease())
            await journal.update(v => ({ ...v, lease: { leaseId: randomUUID(), requestId: randomUUID(), secret: secret(), mode }, operations: {} }));
        const l = currentLease();
        const result = await rpc.call('claim_execution_run', { runId: initial.runId, leaseId: l.leaseId, requestId: l.requestId, verifier: hash(l.secret), mode: l.mode });
        if (result.leaseId !== l.leaseId || result.runId !== initial.runId || !Number.isSafeInteger(result.generation) || !Number.isSafeInteger(result.expiresAt))
            throw new ConsumerError('INVALID_CLAIM_REPLY');
        await journal.update(v => ({ ...v, lease: { ...v.lease, ...result } }));
        renewFailure = null;
    };
    const query = () => rpc.call('get_execution_run', { runId: initial.runId });
    try {
        let observed = await query();
        if (observed.permit?.closedAt) {
            console.log(observed.run.state + '; stop confirmed.');
            return;
        }
        try {
            await claim(observed.permit ? 'reconcile' : 'execute', !!currentLease()?.expiresAt && currentLease().expiresAt <= Date.now());
        }
        catch (error) {
            if (error.code !== 'WORKER_AUTHORITY_EXPIRED')
                throw error;
            const saved = currentLease();
            if (observed.permit && saved?.generation && saved.expiresAt > Date.now()) {
                // A denied execute-claim replay does not revoke this lease's
                // completion/stop authority. Keep its secret and pending actions;
                // the bounded loop below reclaims only after its actual expiry.
                renewFailure = error;
            }
            else {
                await claim(observed.permit ? 'reconcile' : 'execute', true);
            }
        }
        renewTask = (async () => {
            while (!done) {
                await pause(2000);
                if (done)
                    break;
                const l = currentLease();
                if (l.mode !== 'execute' || renewFailure)
                    continue;
                try {
                    const renewed = await leased('renew_execution_run', {}, true);
                    await journal.update(v => { if (v.lease.leaseId === renewed.leaseId)
                        v.lease.expiresAt = renewed.expiresAt; return v; });
                }
                catch (error) {
                    renewFailure = error;
                }
            }
        })();
        const runtimeDeadline = Date.now() + 60000;
        let started = !!observed.permit;
        while (Date.now() < runtimeDeadline) {
            if (renewFailure?.status === 401)
                throw renewFailure;
            // Renewal denial does not supersede an existing exclusive generation.
            // Continue its permitted reconciliation/stop reads until actual expiry.
            if (currentLease().expiresAt <= Date.now()) {
                observed = await query(); // Revoked delegation cannot use reconciliation as a bypass.
                await claim(observed.permit ? 'reconcile' : 'execute', true);
            }
            try {
                if (stopping) {
                    await leased('cancel_execution_run');
                }
                else if (!started && currentLease().mode === 'execute') {
                    await leased('start_execution_run');
                    started = true;
                    await leased('report_execution_run', { message: 'Polling the trusted backend result.' });
                }
                try {
                    const result = await leased('complete_execution_run');
                    if (result?.run)
                        observed = { ...observed, run: result.run };
                    await journal.update(v => { delete v.operations['complete_execution_run:' + v.lease.leaseId]; return v; });
                }
                catch (error) {
                    if (error.code !== 'INVALID_EVIDENCE')
                        throw error;
                }
                observed = await query();
                if (observed.permit?.closedAt) {
                    await journal.update(v => ({ ...v, finished: { state: observed.run.state, stopConfirmed: true } }));
                    console.log(observed.run.state + '; stop confirmed.');
                    return;
                }
            }
            catch (error) {
                if (error.code === 'WORKER_AUTHORITY_EXPIRED') {
                    renewFailure = error;
                    await pause(400);
                    continue;
                }
                if (error.code === 'DISPATCH_CONFLICT' && stopping) {
                    console.log('Cancellation requested; stop unconfirmed.');
                }
                else
                    throw error;
            }
            await pause(400);
        }
        throw new ConsumerError('STOP_UNCONFIRMED');
    }
    finally {
        done = true;
        await renewTask;
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}
export async function main(argv = process.argv.slice(2)) {
    const options = args(argv);
    const journal = await openConsumerState(options['--state']);
    try {
        if (options.command === 'bootstrap')
            await bootstrap(journal, options);
        else if (options.command === 'revoke')
            await revoke(journal, options);
        else
            await runtime(journal, options);
    }
    finally {
        await journal.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { const code = error instanceof ConsumerError ? error.code : 'CONSUMER_UNAVAILABLE'; console.error('Consumer stopped: ' + code + '. Physical stop is unconfirmed unless a trusted stop was observed; the backend deadline remains independent.'); process.exitCode = 1; });
}
