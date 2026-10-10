// Shared persisted bodies and wire contracts. These are data, not execution grants.
export interface RecordBody {
  title: string;
  text?: string;
  project?: string;
  priority?: string;
  status?: string;
  planningStatus?: string;
  planning?: PlanningMetadata | null;
  planningDelivery?: string | null;
  goal?: string;
  scope?: string;
  acceptance?: string;
  dependencies?: string;
  queue?: string;
  budget?: string;
  allowedActions?: string;
  assumptions?: string;
  category?: string;
  cadence?: string;
  waitingReason?: string;
  evidence?: string;
  notes?: string;
  ideaId?: string;
  ideaRevision?: number;
  planId?: string;
  ticketId?: string;
  ticketIds?: string[];
  ticketRevision?: number;
  contract?: RecordBody;
  source?: string;
  logicalKey?: string;
  recordId?: string;
  recordKind?: string;
  previousRevision?: number;
  snapshot?: RecordBody;
}
export interface RecordRow {
  id: string;
  owner: string;
  kind: string;
  body: string;
  revision: number;
  created: string;
  updated: string;
}
export type Row = RecordBody & Omit<RecordRow, "owner" | "body">;
export type RecordDraft = RecordBody &
  Partial<Omit<RecordRow, "owner" | "body">> & { kind: string };
export interface PlanningResult {
  plan_id: string;
  ticket_ids: string[];
}
export interface PlanningEvent {
  eventId: string;
  name: string;
  timestamp: string;
  data: {
    idea_id: string;
    idea_revision: number;
    job_id: string;
    project: string;
  };
  cursor: null;
}
export interface JobRow {
  id: string;
  owner: string;
  idea_id: string;
  idea_revision: number;
  status: string;
  event: string;
  delivery: string;
  generation: number;
  recoveries: number;
  wake_deadline: number | null;
  retry_after: number | null;
  recovery_reason: string | null;
  updated_at: number;
  claim_token: string | null;
  lease: number | null;
  result: string | null;
  created: string;
  planner_error?: string | null;
  planner_retry_at?: number | null;
  connector_id?: string | null;
}
export interface PlanningMetadata {
  status: string;
  lease_expires: number | null;
  retry_allowed: boolean;
  generation: number;
  recoveries: number;
  recovery_reason: string | null;
  attempt_total: number;
  next_retry_at: number | null;
  wake_deadline: number | null;
  retry_after: number | null;
  delivery: string;
  planner_error?: string | null;
  planner_retry_at?: number | null;
  targets: {
    id: string;
    subscription_id: string;
    status: string;
    attempts: number;
    last_http_status: number | null;
    reason: string | null;
    next_retry_at: number | null;
  }[];
}
export type VisibleJob = Pick<JobRow, "id" | "idea_id" | "idea_revision" | "created" | "result"> &
  PlanningMetadata & { current_revision: number };
export interface PlanningState {
  jobs: VisibleJob[];
  subscriptions: number;
  error?: string;
}
export interface Subscription {
  id: string;
  url: string;
  secret: string;
  args: { project?: string };
  previousSecret?: string;
  rotationUntil?: number;
  verifiedAt?: number;
}
export interface SubscriptionRow {
  id: string;
  owner: string;
  body: string;
  expires: number;
}
export interface PlannerPlan {
  title: string;
  goal: string;
  scope: string;
  acceptance: string;
  assumptions?: string;
}
export interface PlannerTicket extends PlannerPlan {
  key: string;
  dependencies?: string;
}
export interface ToolArguments {
  request_id?: string;
  title?: string;
  text?: string;
  project?: string;
  idea_id?: string;
  job_id?: string;
  claim_token?: string;
  plan?: PlannerPlan;
  tickets?: PlannerTicket[];
}
export interface RpcParams {
  name?: string;
  arguments?: ToolArguments;
  protocolVersion?: string;
  delivery?: { mode: string; url: string; secret: string };
  ttlMs?: number;
}
export interface RpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: RpcParams;
}
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  description?: string;
}

// Safe session DTO; display data never grants execution authority.
export interface SessionState {
  user: { userId: string; displayName: string; username: string };
  mode: "local";
  expiresAt: number | null;
}
