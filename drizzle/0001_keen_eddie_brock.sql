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
--> statement-breakpoint
CREATE INDEX `jobs_owner` ON `jobs` (`owner`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`body` text NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscriptions_owner` ON `subscriptions` (`owner`);