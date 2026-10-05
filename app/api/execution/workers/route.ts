import { env } from 'cloudflare:workers';
import { getAuthenticationContext } from '../../../../lib/auth-context';
import { database } from '../../../../lib/store';
import { workerConfiguration } from '../../../../lib/execution/worker-auth.mts';
import { provisionWorker, listWorkers, revokeWorker } from '../../../../lib/execution/workers.mts';
import { readBody } from '../../../../lib/execution/http.mts';
import { exactObject, ExecutionError, invalid } from '../../../../lib/execution/errors.mts';
import type { ProvisionWorkerInput } from '../../../../lib/execution/worker-types.mts';
const headers = { 'Cache-Control': 'private, no-store' };
async function handle(request: Request) {
    const auth = getAuthenticationContext();
    if (auth?.kind !== 'owner' || !auth.user)
        return Response.json({ error: 'Owner authentication required' }, { status: 401, headers });
    try {
        const configuration = workerConfiguration(env, new URL(request.url).origin);
        const context = { ...configuration, owner: auth.user.userId, actor: auth.user.userId, grantAuthority: 'owner' as const, email: auth.user.email, expiresAt: auth.expiresAt, tokenHash: auth.tokenHash };
        const db = database();
        if (request.method === 'GET')
            return Response.json({ credentials: await listWorkers(db, context) }, { headers });
        if (request.headers.has('origin') && request.headers.get('origin') !== new URL(request.url).origin)
            return Response.json({ error: 'Invalid origin' }, { status: 403, headers });
        const input = await readBody(request);
        exactObject(input, ['action', 'credentialId', 'requestId', 'runId', 'verifier', 'label']);
        const { action, ...args } = input;
        if (action === 'provision')
            return Response.json(await provisionWorker(db, context, args as unknown as ProvisionWorkerInput), { status: 201, headers });
        if (action === 'revoke')
            return Response.json(await revokeWorker(db, context, args as {
                credentialId: string;
                requestId: string;
            }), { headers });
        invalid();
    }
    catch (error) {
        return Response.json(error instanceof ExecutionError ? { error: error.message, code: error.code } : { error: 'Worker credential service unavailable' }, { status: error instanceof ExecutionError ? error.status : 503, headers });
    }
}
export const GET = handle;
export const POST = handle;
