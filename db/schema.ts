import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
export const records = sqliteTable('records', { id:text('id').primaryKey(), owner:text('owner').notNull(), kind:text('kind').notNull(), body:text('body').notNull(), revision:integer('revision').notNull().default(1), created:text('created').notNull(), updated:text('updated').notNull() }, t=>[index('records_owner_kind').on(t.owner,t.kind)]);
export const subscriptions=sqliteTable('subscriptions',{id:text('id').primaryKey(),owner:text('owner').notNull(),body:text('body').notNull(),expires:integer('expires').notNull()},t=>[index('subscriptions_owner').on(t.owner)]);
export const jobs=sqliteTable('jobs',{id:text('id').primaryKey(),owner:text('owner').notNull(),ideaId:text('idea_id').notNull(),ideaRevision:integer('idea_revision').notNull(),status:text('status').notNull(),event:text('event').notNull(),delivery:text('delivery').notNull().default('pending'),claimToken:text('claim_token'),lease:integer('lease'),result:text('result'),created:text('created').notNull()},t=>[index('jobs_owner').on(t.owner)]);

export const executionRuns = sqliteTable('execution_runs', {
  id: text('id').primaryKey().notNull(), owner: text('owner').notNull(), actor: text('actor').notNull(),
  ticketId: text('ticket_id').notNull(), ticketRevision: integer('ticket_revision').notNull(),
  ticketBody: text('ticket_body').notNull(), requestId: text('request_id').notNull(),
  authorizationId: text('authorization_id').notNull(), attempt: integer('attempt').notNull(),
  source: text('source').notNull().default('execution'), inputKey: text('input_key').notNull(),
  state: text('state').notNull().default('queued'), version: integer('version').notNull().default(1),
  evidence: text('evidence'), lastActor: text('last_actor').notNull(),
  created: text('created').notNull(), updated: text('updated').notNull(),
}, t => [
  uniqueIndex('execution_runs_owner_request').on(t.owner, t.requestId),
  index('execution_runs_owner_created').on(t.owner, t.created, t.id),
  uniqueIndex('execution_runs_active_ticket').on(t.owner, t.ticketId).where(sql`${t.state} IN ('queued','running','waiting')`),
  check('execution_runs_ticket_revision', sql`${t.ticketRevision} > 0`),
  check('execution_runs_ticket_body', sql`length(${t.ticketBody}) <= 80000 AND json_valid(${t.ticketBody}) AND json_type(${t.ticketBody}) = 'object'`),
  check('execution_runs_request_id', sql`length(${t.requestId}) BETWEEN 1 AND 128`),
  check('execution_runs_attempt', sql`${t.attempt} > 0`),
  check('execution_runs_source', sql`${t.source} = 'execution'`),
  check('execution_runs_state', sql`${t.state} IN ('queued','running','waiting','succeeded','failed','cancelled')`),
  check('execution_runs_version', sql`${t.version} > 0`),
  check('execution_runs_evidence', sql`${t.evidence} IS NULL OR (length(${t.evidence}) <= 16000 AND json_valid(${t.evidence}))`),
  check('execution_runs_success', sql`(${t.state} = 'succeeded' AND ${t.evidence} IS NOT NULL) OR (${t.state} <> 'succeeded' AND ${t.evidence} IS NULL)`),
]);

export const executionAuthorizations = sqliteTable('execution_authorizations', {
  id: text('id').primaryKey().notNull(), owner: text('owner').notNull(), actor: text('actor').notNull(),
  runId: text('run_id').notNull(), ticketId: text('ticket_id').notNull(), ticketRevision: integer('ticket_revision').notNull(),
  scope: text('scope').notNull(), budget: text('budget').notNull(), operations: text('operations').notNull(),
  expiresAt: integer('expires_at').notNull(), status: text('status').notNull().default('pending'),
  requestId: text('request_id').notNull(), inputKey: text('input_key').notNull(),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
  lastDecisionId: text('last_decision_id').notNull(), lastActor: text('last_actor').notNull(), decisionKey: text('decision_key').notNull(),
}, t => [
  uniqueIndex('authorizations_owner_request').on(t.owner, t.requestId),
  uniqueIndex('authorizations_run').on(t.runId),
  check('authorizations_scope', sql`json_valid(${t.scope}) AND json_type(${t.scope}) = 'array' AND json_array_length(${t.scope}) = 1`),
  check('authorizations_budget', sql`json_valid(${t.budget}) AND json_type(${t.budget}) = 'object'`),
  check('authorizations_operations', sql`json_valid(${t.operations}) AND json_type(${t.operations}) = 'array' AND json_array_length(${t.operations}) = 1`),
  check('authorizations_status', sql`${t.status} IN ('pending','approved','rejected','revoked')`),
  check('authorizations_expiry', sql`${t.expiresAt} > ${t.createdAt}`),
]);
export const authorizationAudit = sqliteTable('authorization_audit', {
  decisionId: text('decision_id').notNull(), owner: text('owner').notNull(), actor: text('actor').notNull(),
  kind: text('kind').notNull(), authorizationId: text('authorization_id').notNull(), runId: text('run_id').notNull(),
  at: integer('at').notNull(), scope: text('scope').notNull(), budget: text('budget').notNull(), decisionKey: text('decision_key').notNull(),
}, t => [
  uniqueIndex('authorization_audit_owner_decision').on(t.owner, t.decisionId),
  index('authorization_audit_grant').on(t.owner, t.authorizationId, t.at),
  check('authorization_audit_kind', sql`${t.kind} IN ('requested','approved','rejected','revoked')`),
]);
