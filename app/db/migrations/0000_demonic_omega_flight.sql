CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`github_id` integer NOT NULL,
	`github_login` text NOT NULL,
	`github_name` text,
	`github_email` text,
	`encrypted_access_token` text NOT NULL,
	`encrypted_refresh_token` text NOT NULL,
	`access_token_expires_at` text NOT NULL,
	`refresh_token_expires_at` text NOT NULL,
	`language_preference` text DEFAULT 'en',
	`created_at` text,
	`updated_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_unique` ON `users` (`github_id`);