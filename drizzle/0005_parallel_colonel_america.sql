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
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_deliveries_target` ON `planning_deliveries` (`job_id`,`subscription_id`,`generation`);--> statement-breakpoint
CREATE INDEX `planning_deliveries_due` ON `planning_deliveries` (`status`,`next_attempt_at`,`delivery_lease`);--> statement-breakpoint
CREATE INDEX `planning_deliveries_job` ON `planning_deliveries` (`owner`,`job_id`,`generation`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `recoveries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `wake_deadline` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `retry_after` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `recovery_reason` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `updated_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_recovery_due` ON `jobs` (`status`,`wake_deadline`,`lease`);--> statement-breakpoint
CREATE INDEX `jobs_discovery` ON `jobs` (`updated_at`,`id`);