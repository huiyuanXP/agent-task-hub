import type { RunContext, Run } from './types.mts';
export interface ResourceBudget { timeoutMs: number; memoryMb: number; cpus: number; pids: number }
export interface OperationScope { operationId: string; definitionHash: string }
export interface OperationDefinition { operationId: string; label: string; image: string; scriptVersion: 1; argv?: string[]; inputs?: { path: string; sha256: string; bytes: number }[]; artifacts?: { path: string; maxBytes: number }[] }
export interface AuthorizationContext extends RunContext {
  /** Server-only owner capability. Never derived from a worker name or lease. */
  grantAuthority?: 'owner';
  /** Trusted clock/registry injection; adapters never read these from payloads. */
  now?: number;
  registry?: readonly OperationDefinition[];
}
export interface OperationDescriptor {
  operationId: string; label: string; image: string; argv: string[];
  layout: { version: number; cwd: string; input: string; output: string; executable: string };
  inputs: { path: string; sha256: string; bytes: number }[];
  artifacts: { path: string; maxBytes: number }[];
  policy: { network: 'none'; credentials: string[]; maxInputBytes: number; workTmpfsMb: number; maxLogBytes: number; maxArtifactBytes: number; maxArchiveEntries: number; ceilings: ResourceBudget };
  definitionHash: string;
}
export type AuthorizationStatus = 'pending' | 'approved' | 'rejected' | 'revoked';
export type EffectiveAuthorizationStatus = AuthorizationStatus | 'expired' | 'stale_revision' | 'stale_definition';
export interface PrepareExecutionInput {
  ticketId: string; expectedRevision: number; requestId: string; attempt: number;
  scope: OperationScope[]; budget: ResourceBudget; expiresAt: number;
}
export interface DecisionInput { authorizationId: string; decisionId: string; outcome: 'approved' | 'rejected' }
export interface RevokeInput { authorizationId: string; decisionId: string }
export interface AssertAuthorizationInput { authorizationId: string; runId: string; scope: OperationScope[]; budget: ResourceBudget }
export interface AuthorizationAudit { decisionId: string; actor: string; owner: string; kind: 'requested' | 'approved' | 'rejected' | 'revoked'; authorizationId: string; runId: string; at: number; scope: OperationScope[]; budget: ResourceBudget }
export interface Authorization {
  id: string; owner: string; actor: string; runId: string; ticketId: string; ticketRevision: number;
  scope: OperationScope[]; budget: ResourceBudget; operations: OperationDescriptor[]; expiresAt: number;
  status: AuthorizationStatus; effectiveStatus: EffectiveAuthorizationStatus; createdAt: number; decisions: AuthorizationAudit[];
}
export interface PreparedExecution { run: Run; authorization: Authorization }
export interface AuthorizationRow {
  id: string; owner: string; actor: string; run_id: string; ticket_id: string; ticket_revision: number;
  scope: string; budget: string; operations: string; expires_at: number; status: AuthorizationStatus;
  request_id: string; input_key: string; created_at: number; updated_at: number;
  last_decision_id: string; last_actor: string; decision_key: string;
}
