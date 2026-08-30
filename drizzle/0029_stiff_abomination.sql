CREATE TABLE `application_events` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`occurred_at` integer NOT NULL,
	`recorded_by` text NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `application_events_fingerprint_idx` ON `application_events` (`fingerprint`);