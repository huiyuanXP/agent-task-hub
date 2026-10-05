import type { AccessEnvironment } from '../access-identity.mts';
import { parseAccessConfig } from '../access-identity.mts';
import type { WorkerConfiguration } from './worker-types.mts';
import { denied } from './worker-guard.mts';
export interface WorkerAuthEnvironment extends AccessEnvironment {
    AUTH_MODE?: string;
    AUTH_TRUST_SITES_HEADERS?: string;
    EXECUTION_WORKER_MACHINE_INGRESS?: string;
}
export function workerConfiguration(env: WorkerAuthEnvironment, origin: string): WorkerConfiguration {
    if (env.EXECUTION_WORKER_MACHINE_INGRESS !== undefined && env.EXECUTION_WORKER_MACHINE_INGRESS !== '1')
        throw Error('Invalid worker ingress configuration');
    if (env.AUTH_MODE === 'trusted-sites' && env.AUTH_TRUST_SITES_HEADERS === '1')
        return { mode: 'trusted-sites', origin };
    if (env.AUTH_MODE && env.AUTH_MODE !== 'access')
        throw Error('Unsupported worker authentication configuration');
    const config = parseAccessConfig(env);
    if (origin !== config.applicationOrigin)
        throw denied();
    return { mode: 'access', origin, issuer: config.teamDomain, audience: config.audience, allowedEmails: [...config.allowedEmails] };
}
/** Reserve the opaque credential namespace on every route before owner parsing. */
export function isWorkerAuthorization(value: string | null): boolean { return /^Bearer\s+ath[wl]/i.test(value ?? ''); }
export function workerTransport(request: Request, env: WorkerAuthEnvironment): boolean {
    const url = new URL(request.url), h = request.headers;
    return url.pathname === '/mcp' && !url.search && !h.has('cookie') && (!h.has('origin') || h.get('origin') === url.origin) &&
        (!h.has('sec-fetch-site') || ['none', 'same-origin'].includes(h.get('sec-fetch-site')!.toLowerCase())) &&
        (!h.has('cf-access-jwt-assertion') || env.EXECUTION_WORKER_MACHINE_INGRESS === '1');
}
