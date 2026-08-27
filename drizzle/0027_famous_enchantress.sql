DROP INDEX `pending_alerts_text_unique`;--> statement-breakpoint
ALTER TABLE `pending_alerts` ADD `alert_key` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `pending_alerts_key_unique` ON `pending_alerts` (`alert_key`);