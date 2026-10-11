import type { SqlValue } from '../database.mts';
export interface WorkerPredicate { sql: string; values: SqlValue[] }
export type WorkerLeaseMode = 'execute' | 'reconcile';
export interface WorkerLease {
  leaseId: string; runId: string; generation: number; mode: WorkerLeaseMode; createdAt: number; expiresAt: number;
}
export interface WorkerLeaseRow {
  lease_id: string; owner: string; credential_id: string; run_id: string; generation: number;
  mode: WorkerLeaseMode; verifier: string; request_id: string; input_key: string;
  created_at: number; expires_at: number; renewed_at: number;
}
export interface ClaimExecutionRunInput { runId: string; requestId: string; leaseId: string; verifier: string; mode: WorkerLeaseMode }
export interface LeasedExecutionInput { runId: string; requestId: string; leaseToken: string }
export interface ReportExecutionInput extends LeasedExecutionInput { message: string }
export type WorkerActionKind = 'claim' | 'renew' | 'report' | 'start' | 'complete' | 'cancel';
/** Internal ledger input deliberately excludes raw lease tokens. */
export interface WorkerActionInput { requestId: string; message?: string }
export interface WorkerActionRow {
  owner: string; credential_id: string; run_id: string; lease_id: string; generation: number;
  request_id: string; kind: WorkerActionKind; input_key: string; status: 'pending' | 'completed';
  response_json: string | null; created_at: number; updated_at: number;
}
export interface WorkerActionResult { completed: boolean; response: unknown | null }
export interface WorkerReport { runId: string; leaseId: string; generation: number; message: string; reportedAt: number }
