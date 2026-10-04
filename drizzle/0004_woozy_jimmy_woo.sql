CREATE TABLE `auth_revocations` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_revocations_expiry` ON `auth_revocations` (`expires_at`);