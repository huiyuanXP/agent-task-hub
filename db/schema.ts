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
