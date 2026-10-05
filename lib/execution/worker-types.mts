import type { AuthorizationContext } from './authorization-types.mts';
export interface WorkerConfiguration {
    mode: 'access' | 'trusted-sites';
    origin: string;
    issuer?: string;
    audience?: string;
    allowedEmails?: readonly string[];
}
export interface WorkerIssuer extends AuthorizationContext, WorkerConfiguration {
    email: string;
    expiresAt: number | null;
    tokenHash?: string;
}
export interface WorkerPrincipal {
    kind: 'execution_worker';
    user: null;
    owner: string;
    actor: string;
    credentialId: string;
    runId: string;
    ticketId: string;
    ticketRevision: number;
    attempt: number;
    authorizationId: string;
    expiresAt: number;
    configuration: WorkerConfiguration;
}
export interface WorkerRow {
    id: string;
    owner: string;
    issued_by: string;
    principal_id: string;
    run_id: string;
    ticket_id: string;
    ticket_revision: number;
    attempt: number;
    authorization_id: string;
    verifier: string;
    label: string;
    request_id: string;
    input_key: string;
    mode: string;
    origin: string;
    issuer: string | null;
    audience: string | null;
    email: string;
    token_hash: string | null;
    created_at: number;
    expires_at: number;
    revoked_at: number | null;
    revoked_by: string | null;
    revoke_request_id: string | null;
}
export interface ProvisionWorkerInput {
    credentialId: string;
    requestId: string;
    runId: string;
    verifier: string;
    label: string;
}
export interface LeaseRow {
    id: string;
    owner: string;
    run_id: string;
    credential_id: string;
    principal_id: string;
    generation: number;
    mode: 'execute' | 'reconcile';
    verifier: string;
    request_id: string;
    input_key: string;
    created_at: number;
    expires_at: number;
}
export interface LeaseInput {
    runId: string;
    leaseToken: string;
    requestId: string;
}
export interface ClaimInput {
    runId: string;
    leaseId: string;
    requestId: string;
    verifier: string;
    mode: 'execute' | 'reconcile';
}
