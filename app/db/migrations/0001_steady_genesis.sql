CREATE TABLE `glossary_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`term_id` text NOT NULL,
	`title` text,
	`definition` text,
	`updated_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `layers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`step_id` integer NOT NULL,
	`layer_number` integer NOT NULL,
	`button_label` text,
	`content` text,
	`updated_at` text,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `objects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`object_id` text NOT NULL,
	`title` text,
	`featured` integer DEFAULT false,
	`creator` text,
	`description` text,
	`source_url` text,
	`period` text,
	`year` text,
	`object_type` text,
	`subjects` text,
	`source` text,
	`credit` text,
	`thumbnail` text,
	`has_iiif_tiles` integer DEFAULT false,
	`updated_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`title` text,
	`lang` text DEFAULT 'en',
	`baseurl` text,
	`url` text,
	`telar_version` text,
	`theme` text,
	`description` text,
	`author` text,
	`email` text,
	`logo` text,
	`include_demo_content` integer DEFAULT true,
	`google_sheets_enabled` integer DEFAULT false,
	`google_sheets_published_url` text,
	`show_on_homepage` integer DEFAULT true,
	`show_story_steps` integer DEFAULT true,
	`show_object_credits` integer DEFAULT true,
	`browse_and_search` integer DEFAULT true,
	`show_link_on_homepage` integer DEFAULT true,
	`show_sample_on_homepage` integer DEFAULT false,
	`featured_count` integer DEFAULT 4,
	`story_key` text,
	`updated_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`github_repo_full_name` text NOT NULL,
	`installation_id` integer NOT NULL,
	`github_pages_url` text,
	`head_sha` text,
	`published_sha` text,
	`last_synced_at` text,
	`last_published_at` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`story_id` integer NOT NULL,
	`step_number` integer NOT NULL,
	`object_id` text,
	`x` real,
	`y` real,
	`zoom` real,
	`page` text,
	`question` text,
	`answer` text,
	`updated_at` text,
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`story_id` text NOT NULL,
	`title` text,
	`subtitle` text,
	`byline` text,
	`order` integer DEFAULT 0,
	`private` integer DEFAULT false,
	`updated_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
