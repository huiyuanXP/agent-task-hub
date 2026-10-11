/** Trusted local-account issuer, resolved only from the actual request credential. */
export interface WorkerIssuer {
  owner: string; actor: string; origin: string; issuerTokenHash: string; issuerExpiresAt: number;
}
/** Server-only principal; verifier and issuer hash must never enter response projections. */
export interface WorkerPrincipal extends WorkerIssuer {
  credentialId: string; expiresAt: number; runId: string; project: string; ticketId: string;
  ticketRevision: number; attempt: number; authorizationId: string; verifier: string;
}
export interface WorkerCredential {
  credentialId: string; runId: string; project: string; ticketId: string; ticketRevision: number;
  attempt: number; authorizationId: string; label: string; createdAt: number; expiresAt: number;
  revokedAt: number | null;
}
export interface WorkerCredentialRow {
  credential_id: string; owner: string; actor: string; origin: string; issuer_token_hash: string;
  issuer_expires_at: number; run_id: string; project: string; ticket_id: string; ticket_revision: number;
  attempt: number; authorization_id: string; verifier: string; label: string; request_id: string;
  input_key: string; created_at: number; expires_at: number; revoked_at: number | null;
  revoke_request_id: string | null;
}
export interface ProvisionWorkerInput { credentialId: string; requestId: string; runId: string; verifier: string; label: string }
export interface RevokeWorkerInput { credentialId: string; requestId: string }
