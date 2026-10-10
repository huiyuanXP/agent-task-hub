import type { OperationDescriptor, ResourceBudget } from './authorization-types.mts';
export interface DispatchPermit {
  version: 1; permitId: string; owner: string; runId: string; ticketId: string; ticketRevision: number; attempt: number;
  authorizationId: string; contractSha256: string; ticketBody: string; operation: OperationDescriptor; budget: ResourceBudget;
  issuedAt: number; deadlineMs: number; expiresAt: number;
}
export interface PermitRow { id: string; owner: string; run_id: string; ticket_id: string; authorization_id: string; envelope: string; envelope_hash: string; created_at: number; deadline_ms: number; cancel_requested: number; closed_at: number | null }
