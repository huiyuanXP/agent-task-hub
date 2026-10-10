CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created` text NOT NULL,
	`updated` text NOT NULL
);

CREATE INDEX `records_owner_kind` ON `records` (`owner`,`kind`);

CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`idea_id` text NOT NULL,
	`idea_revision` integer NOT NULL,
	`status` text NOT NULL,
	`event` text NOT NULL,
	`delivery` text DEFAULT 'pending' NOT NULL,
	`claim_token` text,
	`lease` integer,
	`result` text,
	`created` text NOT NULL
);

CREATE INDEX `jobs_owner` ON `jobs` (`owner`);
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`body` text NOT NULL,
	`expires` integer NOT NULL
);

CREATE INDEX `subscriptions_owner` ON `subscriptions` (`owner`);

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

CREATE UNIQUE INDEX `execution_runs_owner_request` ON `execution_runs` (`owner`,`request_id`);
CREATE INDEX `execution_runs_owner_created` ON `execution_runs` (`owner`,`created`,`id`);
CREATE UNIQUE INDEX `execution_runs_active_ticket` ON `execution_runs` (`owner`,`ticket_id`) WHERE "execution_runs"."state" IN ('queued','running','waiting');

CREATE TRIGGER execution_runs_immutable BEFORE UPDATE ON execution_runs
WHEN NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner OR NEW.actor IS NOT OLD.actor
  OR NEW.ticket_id IS NOT OLD.ticket_id OR NEW.ticket_revision IS NOT OLD.ticket_revision
  OR NEW.ticket_body IS NOT OLD.ticket_body OR NEW.request_id IS NOT OLD.request_id
  OR NEW.authorization_id IS NOT OLD.authorization_id OR NEW.attempt IS NOT OLD.attempt
  OR NEW.source IS NOT OLD.source OR NEW.input_key IS NOT OLD.input_key OR NEW.created IS NOT OLD.created
BEGIN SELECT RAISE(ABORT, 'Immutable execution contract'); END;

CREATE TRIGGER execution_runs_edges BEFORE UPDATE ON execution_runs
WHEN NEW.version != OLD.version + 1 OR NOT (
  (OLD.state = 'queued' AND NEW.state IN ('running','waiting','failed','cancelled')) OR
  (OLD.state = 'running' AND NEW.state IN ('waiting','succeeded','failed','cancelled')) OR
  (OLD.state = 'waiting' AND NEW.state IN ('queued','running','failed','cancelled'))
)
BEGIN SELECT RAISE(ABORT, 'Invalid execution transition'); END;

CREATE TRIGGER execution_runs_no_delete BEFORE DELETE ON execution_runs
BEGIN SELECT RAISE(ABORT, 'Execution history is immutable'); END;


CREATE TABLE `authorization_audit` (
	`decision_id` text NOT NULL,
	`owner` text NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`authorization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`at` integer NOT NULL,
	`scope` text NOT NULL,
	`budget` text NOT NULL,
	`decision_key` text NOT NULL,
	CONSTRAINT "authorization_audit_kind" CHECK("authorization_audit"."kind" IN ('requested','approved','rejected','revoked'))
);

CREATE UNIQUE INDEX `authorization_audit_owner_decision` ON `authorization_audit` (`owner`,`decision_id`);
CREATE INDEX `authorization_audit_grant` ON `authorization_audit` (`owner`,`authorization_id`,`at`);
CREATE TABLE `execution_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`actor` text NOT NULL,
	`run_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`ticket_revision` integer NOT NULL,
	`scope` text NOT NULL,
	`budget` text NOT NULL,
	`operations` text NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`request_id` text NOT NULL,
	`input_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_decision_id` text NOT NULL,
	`last_actor` text NOT NULL,
	`decision_key` text NOT NULL,
	CONSTRAINT "authorizations_scope" CHECK(json_valid("execution_authorizations"."scope") AND json_type("execution_authorizations"."scope") = 'array' AND json_array_length("execution_authorizations"."scope") = 1),
	CONSTRAINT "authorizations_budget" CHECK(json_valid("execution_authorizations"."budget") AND json_type("execution_authorizations"."budget") = 'object'),
	CONSTRAINT "authorizations_operations" CHECK(json_valid("execution_authorizations"."operations") AND json_type("execution_authorizations"."operations") = 'array' AND json_array_length("execution_authorizations"."operations") = 1),
	CONSTRAINT "authorizations_status" CHECK("execution_authorizations"."status" IN ('pending','approved','rejected','revoked')),
	CONSTRAINT "authorizations_expiry" CHECK("execution_authorizations"."expires_at" > "execution_authorizations"."created_at")
);

CREATE UNIQUE INDEX `authorizations_owner_request` ON `execution_authorizations` (`owner`,`request_id`);
CREATE UNIQUE INDEX `authorizations_run` ON `execution_authorizations` (`run_id`);
CREATE TRIGGER authorizations_binding BEFORE INSERT ON execution_authorizations
WHEN NEW.status <> 'pending' OR NOT EXISTS (
 SELECT 1 FROM execution_runs WHERE id=NEW.run_id AND owner=NEW.owner
 AND authorization_id=NEW.id AND ticket_id=NEW.ticket_id AND ticket_revision=NEW.ticket_revision
 AND actor=NEW.actor AND request_id=NEW.request_id AND state='queued')
BEGIN SELECT RAISE(ABORT,'authorization Run binding invalid'); END;

CREATE TRIGGER authorizations_immutable BEFORE UPDATE ON execution_authorizations
WHEN NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner OR NEW.actor IS NOT OLD.actor
 OR NEW.run_id IS NOT OLD.run_id OR NEW.ticket_id IS NOT OLD.ticket_id OR NEW.ticket_revision IS NOT OLD.ticket_revision
 OR NEW.scope IS NOT OLD.scope OR NEW.budget IS NOT OLD.budget OR NEW.operations IS NOT OLD.operations
 OR NEW.expires_at IS NOT OLD.expires_at OR NEW.request_id IS NOT OLD.request_id OR NEW.input_key IS NOT OLD.input_key
 OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable authorization'); END;

CREATE TRIGGER authorizations_state BEFORE UPDATE ON execution_authorizations
WHEN NOT ((OLD.status='pending' AND NEW.status IN ('approved','rejected','revoked')) OR (OLD.status='approved' AND NEW.status='revoked'))
 OR NEW.last_decision_id=OLD.last_decision_id
BEGIN SELECT RAISE(ABORT,'invalid authorization decision'); END;

CREATE TRIGGER authorizations_no_delete BEFORE DELETE ON execution_authorizations
BEGIN SELECT RAISE(ABORT,'immutable authorization history'); END;

CREATE TRIGGER authorizations_requested AFTER INSERT ON execution_authorizations
BEGIN INSERT INTO authorization_audit(decision_id,owner,actor,kind,authorization_id,run_id,at,scope,budget,decision_key)
 VALUES(NEW.last_decision_id,NEW.owner,NEW.actor,'requested',NEW.id,NEW.run_id,NEW.created_at,NEW.scope,NEW.budget,NEW.decision_key); END;

CREATE TRIGGER authorizations_decided AFTER UPDATE ON execution_authorizations
BEGIN INSERT INTO authorization_audit(decision_id,owner,actor,kind,authorization_id,run_id,at,scope,budget,decision_key)
 VALUES(NEW.last_decision_id,NEW.owner,NEW.last_actor,NEW.status,NEW.id,NEW.run_id,NEW.updated_at,NEW.scope,NEW.budget,NEW.decision_key); END;

CREATE TRIGGER authorization_audit_bound BEFORE INSERT ON authorization_audit
WHEN NOT EXISTS(SELECT 1 FROM execution_authorizations WHERE id=NEW.authorization_id AND owner=NEW.owner
 AND run_id=NEW.run_id AND scope=NEW.scope AND budget=NEW.budget AND last_decision_id=NEW.decision_id
 AND last_actor=NEW.actor AND decision_key=NEW.decision_key
 AND ((NEW.kind='requested' AND status='pending') OR NEW.kind=status))
BEGIN SELECT RAISE(ABORT,'invalid audit binding'); END;

CREATE TRIGGER authorization_audit_no_update BEFORE UPDATE ON authorization_audit
BEGIN SELECT RAISE(ABORT,'immutable authorization audit'); END;

CREATE TRIGGER authorization_audit_no_delete BEFORE DELETE ON authorization_audit
BEGIN SELECT RAISE(ABORT,'immutable authorization audit'); END;


CREATE TABLE `planning_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`job_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`generation` integer NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`delivery_token` text,
	`delivery_lease` integer,
	`last_http_status` integer,
	`terminal_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

CREATE UNIQUE INDEX `planning_deliveries_target` ON `planning_deliveries` (`job_id`,`subscription_id`,`generation`);
CREATE INDEX `planning_deliveries_due` ON `planning_deliveries` (`status`,`next_attempt_at`,`delivery_lease`);
CREATE INDEX `planning_deliveries_job` ON `planning_deliveries` (`owner`,`job_id`,`generation`);
ALTER TABLE `jobs` ADD `generation` integer DEFAULT 0 NOT NULL;
ALTER TABLE `jobs` ADD `recoveries` integer DEFAULT 0 NOT NULL;
ALTER TABLE `jobs` ADD `wake_deadline` integer;
ALTER TABLE `jobs` ADD `retry_after` integer;
ALTER TABLE `jobs` ADD `recovery_reason` text;
ALTER TABLE `jobs` ADD `updated_at` integer DEFAULT 0 NOT NULL;
CREATE INDEX `jobs_recovery_due` ON `jobs` (`status`,`wake_deadline`,`lease`);
CREATE INDEX `jobs_discovery` ON `jobs` (`updated_at`,`id`);

CREATE TABLE `backend_attestations` (
	`id` text PRIMARY KEY NOT NULL,
	`permit_id` text NOT NULL,
	`owner` text NOT NULL,
	`purpose` text NOT NULL,
	`receipt` text NOT NULL,
	`received_at` integer NOT NULL,
	CONSTRAINT "backend_attestations_receipt" CHECK(json_valid("backend_attestations"."receipt") AND length("backend_attestations"."receipt") <= 16000),
	CONSTRAINT "backend_attestations_purpose" CHECK("backend_attestations"."purpose" IN ('result','cancel_fence','stop'))
);

CREATE UNIQUE INDEX `backend_attestations_permit_purpose` ON `backend_attestations` (`permit_id`,`purpose`);
CREATE TABLE `execution_permits` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`run_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`authorization_id` text NOT NULL,
	`envelope` text NOT NULL,
	`envelope_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`deadline_ms` integer NOT NULL,
	`cancel_requested` integer DEFAULT 0 NOT NULL,
	`closed_at` integer,
	CONSTRAINT "execution_permits_envelope" CHECK(json_valid("execution_permits"."envelope") AND length("execution_permits"."envelope") <= 1048576),
	CONSTRAINT "execution_permits_cancel" CHECK("execution_permits"."cancel_requested" IN (0,1)),
	CONSTRAINT "execution_permits_deadline" CHECK("execution_permits"."deadline_ms" > "execution_permits"."created_at")
);

CREATE UNIQUE INDEX `execution_permits_run` ON `execution_permits` (`owner`,`run_id`);
CREATE UNIQUE INDEX `execution_permits_physical_ticket` ON `execution_permits` (`owner`,`ticket_id`) WHERE "execution_permits"."closed_at" IS NULL;
CREATE TRIGGER execution_permits_immutable BEFORE UPDATE ON execution_permits
WHEN NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner OR NEW.run_id IS NOT OLD.run_id OR NEW.ticket_id IS NOT OLD.ticket_id
 OR NEW.authorization_id IS NOT OLD.authorization_id OR NEW.envelope IS NOT OLD.envelope OR NEW.envelope_hash IS NOT OLD.envelope_hash
 OR NEW.created_at IS NOT OLD.created_at OR NEW.deadline_ms IS NOT OLD.deadline_ms OR NEW.cancel_requested < OLD.cancel_requested
 OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT OLD.closed_at)
BEGIN SELECT RAISE(ABORT, 'Immutable dispatch authority'); END;

CREATE TRIGGER execution_permits_no_delete BEFORE DELETE ON execution_permits
BEGIN SELECT RAISE(ABORT, 'Dispatch history is immutable'); END;

CREATE TRIGGER backend_attestations_no_update BEFORE UPDATE ON backend_attestations
BEGIN SELECT RAISE(ABORT, 'Backend attestation is immutable'); END;

CREATE TRIGGER backend_attestations_no_delete BEFORE DELETE ON backend_attestations
BEGIN SELECT RAISE(ABORT, 'Backend attestation is immutable'); END;

CREATE TRIGGER execution_cancel_outbox AFTER UPDATE ON execution_runs
WHEN NEW.state IN ('cancelled','failed')
BEGIN UPDATE execution_permits SET cancel_requested=1 WHERE owner=NEW.owner AND run_id=NEW.id AND closed_at IS NULL; END;

CREATE TRIGGER authorization_cancel_outbox AFTER UPDATE ON execution_authorizations
WHEN NEW.status='revoked'
BEGIN UPDATE execution_permits SET cancel_requested=1 WHERE owner=NEW.owner AND authorization_id=NEW.id AND closed_at IS NULL; END;

CREATE TRIGGER execution_dispatched_v2 BEFORE UPDATE ON execution_runs
WHEN NEW.state='succeeded' AND EXISTS(SELECT 1 FROM execution_permits WHERE run_id=NEW.id AND owner=NEW.owner)
 AND (json_extract(NEW.evidence,'$.claims.version') IS NOT 2 OR json_extract(NEW.evidence,'$.claims.purpose') IS NOT 'result')
BEGIN SELECT RAISE(ABORT, 'Dispatched success requires v2 permit evidence'); END;

