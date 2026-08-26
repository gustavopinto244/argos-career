CREATE TABLE `pending_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`first_queued_at` integer NOT NULL,
	`last_queued_at` integer NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_alerts_text_unique` ON `pending_alerts` (`text`);