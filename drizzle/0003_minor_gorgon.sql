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
--> statement-breakpoint
CREATE UNIQUE INDEX `authorization_audit_owner_decision` ON `authorization_audit` (`owner`,`decision_id`);--> statement-breakpoint
CREATE INDEX `authorization_audit_grant` ON `authorization_audit` (`owner`,`authorization_id`,`at`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `authorizations_owner_request` ON `execution_authorizations` (`owner`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `authorizations_run` ON `execution_authorizations` (`run_id`);--> statement-breakpoint
CREATE TRIGGER authorizations_binding BEFORE INSERT ON execution_authorizations
WHEN NEW.status <> 'pending' OR NOT EXISTS (
 SELECT 1 FROM execution_runs WHERE id=NEW.run_id AND owner=NEW.owner
 AND authorization_id=NEW.id AND ticket_id=NEW.ticket_id AND ticket_revision=NEW.ticket_revision
 AND actor=NEW.actor AND request_id=NEW.request_id AND state='queued')
BEGIN SELECT RAISE(ABORT,'authorization Run binding invalid'); END;
--> statement-breakpoint
CREATE TRIGGER authorizations_immutable BEFORE UPDATE ON execution_authorizations
WHEN NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner OR NEW.actor IS NOT OLD.actor
 OR NEW.run_id IS NOT OLD.run_id OR NEW.ticket_id IS NOT OLD.ticket_id OR NEW.ticket_revision IS NOT OLD.ticket_revision
 OR NEW.scope IS NOT OLD.scope OR NEW.budget IS NOT OLD.budget OR NEW.operations IS NOT OLD.operations
 OR NEW.expires_at IS NOT OLD.expires_at OR NEW.request_id IS NOT OLD.request_id OR NEW.input_key IS NOT OLD.input_key
 OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'immutable authorization'); END;
--> statement-breakpoint
CREATE TRIGGER authorizations_state BEFORE UPDATE ON execution_authorizations
WHEN NOT ((OLD.status='pending' AND NEW.status IN ('approved','rejected','revoked')) OR (OLD.status='approved' AND NEW.status='revoked'))
 OR NEW.last_decision_id=OLD.last_decision_id
BEGIN SELECT RAISE(ABORT,'invalid authorization decision'); END;
--> statement-breakpoint
CREATE TRIGGER authorizations_no_delete BEFORE DELETE ON execution_authorizations
BEGIN SELECT RAISE(ABORT,'immutable authorization history'); END;
--> statement-breakpoint
CREATE TRIGGER authorizations_requested AFTER INSERT ON execution_authorizations
BEGIN INSERT INTO authorization_audit(decision_id,owner,actor,kind,authorization_id,run_id,at,scope,budget,decision_key)
 VALUES(NEW.last_decision_id,NEW.owner,NEW.actor,'requested',NEW.id,NEW.run_id,NEW.created_at,NEW.scope,NEW.budget,NEW.decision_key); END;
--> statement-breakpoint
CREATE TRIGGER authorizations_decided AFTER UPDATE ON execution_authorizations
BEGIN INSERT INTO authorization_audit(decision_id,owner,actor,kind,authorization_id,run_id,at,scope,budget,decision_key)
 VALUES(NEW.last_decision_id,NEW.owner,NEW.last_actor,NEW.status,NEW.id,NEW.run_id,NEW.updated_at,NEW.scope,NEW.budget,NEW.decision_key); END;
--> statement-breakpoint
CREATE TRIGGER authorization_audit_bound BEFORE INSERT ON authorization_audit
WHEN NOT EXISTS(SELECT 1 FROM execution_authorizations WHERE id=NEW.authorization_id AND owner=NEW.owner
 AND run_id=NEW.run_id AND scope=NEW.scope AND budget=NEW.budget AND last_decision_id=NEW.decision_id
 AND last_actor=NEW.actor AND decision_key=NEW.decision_key
 AND ((NEW.kind='requested' AND status='pending') OR NEW.kind=status))
BEGIN SELECT RAISE(ABORT,'invalid audit binding'); END;
--> statement-breakpoint
CREATE TRIGGER authorization_audit_no_update BEFORE UPDATE ON authorization_audit
BEGIN SELECT RAISE(ABORT,'immutable authorization audit'); END;
--> statement-breakpoint
CREATE TRIGGER authorization_audit_no_delete BEFORE DELETE ON authorization_audit
BEGIN SELECT RAISE(ABORT,'immutable authorization audit'); END;
