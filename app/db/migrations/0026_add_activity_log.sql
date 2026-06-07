-- Add activity_log — coarse per-save event rows (actor + entity + verb + timestamp) feeding the Start-tab activity feed. One row per save/create/sync, not per-field.
CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL REFERENCES `projects`(`id`),
	`actor_user_id` integer REFERENCES `users`(`id`),
	`verb` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`entity_label` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_log_project_created_idx` ON `activity_log` (`project_id`, `created_at`);
