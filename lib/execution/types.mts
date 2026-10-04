/** Structural D1 interface: no Worker runtime imports in the domain. */
export interface ExecutionStatement {
  bind(...values: (string | number | null)[]): ExecutionStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface ExecutionDatabase { prepare(sql: string): ExecutionStatement }
export type RunState = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
export interface EvidenceArtifact { path: string; sha256: string; bytes: number }
/** Versioned, fixed-order signing contract. Transport authentication uses another key. */
export interface EvidenceClaims {
  version: 1;
  keyId: string;
  owner: string;
  runId: string;
  ticketId: string;
  ticketRevision: number;
  attempt: number;
  authorizationId: string;
  contractSha256: string;
  status: 'succeeded';
  backendId: string;
  exitCode: 0;
  artifacts: EvidenceArtifact[];
  stdoutSha256: string;
  stderrSha256: string;
  startedAt: string;
  endedAt: string;
}
export interface ExecutionEvidence { claims: EvidenceClaims; signature: string }
export interface EvidenceTrust { keyId: string; key: CryptoKey }
/** Constructed only by trusted server code, never from the request body. */
export interface RunContext { owner: string; actor: string; evidenceTrust?: EvidenceTrust }
export interface CreateRunInput {
  ticketId: string;
  expectedRevision: number;
  requestId: string;
  authorizationId: string;
  attempt: number;
}
export interface ListRunFilters { ticketId?: string; state?: RunState; limit?: number }
export interface TransitionRunInput { id: string; expectedVersion: number; to: RunState; evidence?: ExecutionEvidence }
export interface Run {
  id: string; owner: string; actor: string; ticketId: string; ticketRevision: number;
  ticketBody: string; requestId: string; authorizationId: string; attempt: number;
  source: 'execution'; state: RunState; version: number; evidence: ExecutionEvidence | null;
  lastActor: string; created: string; updated: string;
}
export interface RunRow {
  id: string; owner: string; actor: string; ticket_id: string; ticket_revision: number;
  ticket_body: string; request_id: string; authorization_id: string; attempt: number;
  source: 'execution'; input_key: string; state: RunState; version: number;
  evidence: string | null; last_actor: string; created: string; updated: string;
}
