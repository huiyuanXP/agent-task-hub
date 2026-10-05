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
--> statement-breakpoint
CREATE UNIQUE INDEX `backend_attestations_permit_purpose` ON `backend_attestations` (`permit_id`,`purpose`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_permits_run` ON `execution_permits` (`owner`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_permits_physical_ticket` ON `execution_permits` (`owner`,`ticket_id`) WHERE "execution_permits"."closed_at" IS NULL;--> statement-breakpoint
CREATE TRIGGER execution_permits_immutable BEFORE UPDATE ON execution_permits
WHEN NEW.id IS NOT OLD.id OR NEW.owner IS NOT OLD.owner OR NEW.run_id IS NOT OLD.run_id OR NEW.ticket_id IS NOT OLD.ticket_id
 OR NEW.authorization_id IS NOT OLD.authorization_id OR NEW.envelope IS NOT OLD.envelope OR NEW.envelope_hash IS NOT OLD.envelope_hash
 OR NEW.created_at IS NOT OLD.created_at OR NEW.deadline_ms IS NOT OLD.deadline_ms OR NEW.cancel_requested < OLD.cancel_requested
 OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT OLD.closed_at)
BEGIN SELECT RAISE(ABORT, 'Immutable dispatch authority'); END;
--> statement-breakpoint
CREATE TRIGGER execution_permits_no_delete BEFORE DELETE ON execution_permits
BEGIN SELECT RAISE(ABORT, 'Dispatch history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER backend_attestations_no_update BEFORE UPDATE ON backend_attestations
BEGIN SELECT RAISE(ABORT, 'Backend attestation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER backend_attestations_no_delete BEFORE DELETE ON backend_attestations
BEGIN SELECT RAISE(ABORT, 'Backend attestation is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER execution_cancel_outbox AFTER UPDATE ON execution_runs
WHEN NEW.state IN ('cancelled','failed')
BEGIN UPDATE execution_permits SET cancel_requested=1 WHERE owner=NEW.owner AND run_id=NEW.id AND closed_at IS NULL; END;
--> statement-breakpoint
CREATE TRIGGER authorization_cancel_outbox AFTER UPDATE ON execution_authorizations
WHEN NEW.status='revoked'
BEGIN UPDATE execution_permits SET cancel_requested=1 WHERE owner=NEW.owner AND authorization_id=NEW.id AND closed_at IS NULL; END;
--> statement-breakpoint
CREATE TRIGGER execution_dispatched_v2 BEFORE UPDATE ON execution_runs
WHEN NEW.state='succeeded' AND EXISTS(SELECT 1 FROM execution_permits WHERE run_id=NEW.id AND owner=NEW.owner)
 AND (json_extract(NEW.evidence,'$.claims.version') IS NOT 2 OR json_extract(NEW.evidence,'$.claims.purpose') IS NOT 'result')
BEGIN SELECT RAISE(ABORT, 'Dispatched success requires v2 permit evidence'); END;
