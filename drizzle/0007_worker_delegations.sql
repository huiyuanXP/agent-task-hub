CREATE TABLE `execution_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`run_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`principal_id` text NOT NULL,
	`generation` integer NOT NULL,
	`mode` text NOT NULL,
	`verifier` text NOT NULL,
	`request_id` text NOT NULL,
	`input_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "execution_leases_mode" CHECK("execution_leases"."mode" IN ('execute','reconcile'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_leases_generation` ON `execution_leases` (`owner`,`run_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_leases_request` ON `execution_leases` (`credential_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `execution_leases_active` ON `execution_leases` (`owner`,`run_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `execution_worker_actions` (
	`lease_id` text NOT NULL,
	`request_id` text NOT NULL,
	`input_key` text NOT NULL,
	`action` text NOT NULL,
	`response` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "execution_worker_response" CHECK("execution_worker_actions"."response" IS NULL OR (json_valid("execution_worker_actions"."response") AND length("execution_worker_actions"."response")<=524288))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_worker_actions_request` ON `execution_worker_actions` (`lease_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `execution_worker_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "execution_worker_authority" CHECK("execution_worker_checks"."valid"=1)
);
--> statement-breakpoint
CREATE TABLE `execution_worker_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`issued_by` text NOT NULL,
	`principal_id` text NOT NULL,
	`run_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`ticket_revision` integer NOT NULL,
	`attempt` integer NOT NULL,
	`authorization_id` text NOT NULL,
	`verifier` text NOT NULL,
	`label` text NOT NULL,
	`request_id` text NOT NULL,
	`input_key` text NOT NULL,
	`mode` text NOT NULL,
	`origin` text NOT NULL,
	`issuer` text,
	`audience` text,
	`email` text NOT NULL,
	`token_hash` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	`revoke_request_id` text,
	CONSTRAINT "execution_workers_expiry" CHECK("execution_worker_credentials"."expires_at">"execution_worker_credentials"."created_at" AND "execution_worker_credentials"."expires_at"<="execution_worker_credentials"."created_at"+900000),
	CONSTRAINT "execution_workers_verifier" CHECK(length("execution_worker_credentials"."verifier")=64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_workers_owner_request` ON `execution_worker_credentials` (`owner`,`request_id`);--> statement-breakpoint
CREATE INDEX `execution_workers_run` ON `execution_worker_credentials` (`owner`,`run_id`,`expires_at`);