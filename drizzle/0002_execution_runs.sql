CREATE TABLE `execution_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`actor` text NOT NULL,
	`ticket_id` text NOT NULL,
	`ticket_revision` integer NOT NULL,
	`ticket_body` text NOT NULL,
	`request_id` text NOT NULL,
	`authorization_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`source` text DEFAULT 'execution' NOT NULL,
	`input_key` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`evidence` text,
	`last_actor` text NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL,
	CONSTRAINT "execution_runs_ticket_revision" CHECK("execution_runs"."ticket_revision" > 0),
	CONSTRAINT "execution_runs_ticket_body" CHECK(length("execution_runs"."ticket_body") <= 80000 AND json_valid("execution_runs"."ticket_body") AND json_type("execution_runs"."ticket_body") = 'object'),
	CONSTRAINT "execution_runs_request_id" CHECK(length("execution_runs"."request_id") BETWEEN 1 AND 128),
	CONSTRAINT "execution_runs_attempt" CHECK("execution_runs"."attempt" > 0),
	CONSTRAINT "execution_runs_source" CHECK("execution_runs"."source" = 'execution'),
	CONSTRAINT "execution_runs_state" CHECK("execution_runs"."state" IN ('queued','running','waiting','succeeded','failed','cancelled')),
	CONSTRAINT "execution_runs_version" CHECK("execution_runs"."version" > 0),
	CONSTRAINT "execution_runs_evidence" CHECK("execution_runs"."evidence" IS NULL OR (length("execution_runs"."evidence") <= 16000 AND json_valid("execution_runs"."evidence"))),
	CONSTRAINT "execution_runs_success" CHECK(("execution_runs"."state" = 'succeeded' AND "execution_runs"."evidence" IS NOT NULL) OR ("execution_runs"."state" <> 'succeeded' AND "execution_runs"."evidence" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_runs_owner_request` ON `execution_runs` (`owner`,`request_id`);--> statement-breakpoint
CREATE INDEX `execution_runs_owner_created` ON `execution_runs` (`owner`,`created`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_runs_active_ticket` ON `execution_runs` (`owner`,`ticket_id`) WHERE "execution_runs"."state" IN ('queued','running','waiting');
--> statement-breakpoint
CREATE TRIGGER execution_runs_immutable BEFORE UPDATE ON execution_runs
WHEN NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner OR NEW.actor IS NOT OLD.actor
  OR NEW.ticket_id IS NOT OLD.ticket_id OR NEW.ticket_revision IS NOT OLD.ticket_revision
  OR NEW.ticket_body IS NOT OLD.ticket_body OR NEW.request_id IS NOT OLD.request_id
  OR NEW.authorization_id IS NOT OLD.authorization_id OR NEW.attempt IS NOT OLD.attempt
  OR NEW.source IS NOT OLD.source OR NEW.input_key IS NOT OLD.input_key OR NEW.created IS NOT OLD.created
BEGIN SELECT RAISE(ABORT, 'Immutable execution contract'); END;
--> statement-breakpoint
CREATE TRIGGER execution_runs_edges BEFORE UPDATE ON execution_runs
WHEN NEW.version != OLD.version + 1 OR NOT (
  (OLD.state = 'queued' AND NEW.state IN ('running','waiting','failed','cancelled')) OR
  (OLD.state = 'running' AND NEW.state IN ('waiting','succeeded','failed','cancelled')) OR
  (OLD.state = 'waiting' AND NEW.state IN ('queued','running','failed','cancelled'))
)
BEGIN SELECT RAISE(ABORT, 'Invalid execution transition'); END;
--> statement-breakpoint
CREATE TRIGGER execution_runs_no_delete BEFORE DELETE ON execution_runs
BEGIN SELECT RAISE(ABORT, 'Execution history is immutable'); END;
