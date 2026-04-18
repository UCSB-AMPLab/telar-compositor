CREATE TABLE `project_members` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `project_id` integer NOT NULL REFERENCES `projects`(`id`),
  `user_id` integer NOT NULL REFERENCES `users`(`id`),
  `role` text NOT NULL CHECK(`role` IN ('owner', 'collaborator')),
  `invited_at` text,
  `joined_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_members_unique` ON `project_members` (`project_id`, `user_id`);
--> statement-breakpoint
CREATE TABLE `project_invites` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `project_id` integer NOT NULL REFERENCES `projects`(`id`),
  `token` text NOT NULL,
  `created_by` integer NOT NULL REFERENCES `users`(`id`),
  `expires_at` text NOT NULL,
  `used_by` integer REFERENCES `users`(`id`),
  `used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_invites_token_unique` ON `project_invites` (`token`);
--> statement-breakpoint
CREATE TABLE `project_pages` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `project_id` integer NOT NULL REFERENCES `projects`(`id`),
  `title` text NOT NULL DEFAULT 'Untitled',
  `slug` text NOT NULL,
  `body` text DEFAULT '',
  `order` integer NOT NULL DEFAULT 0,
  `created_at` text,
  `updated_at` text
);
--> statement-breakpoint
-- Back-fill owner rows for all existing projects
INSERT INTO `project_members` (`project_id`, `user_id`, `role`, `joined_at`)
SELECT `id`, `user_id`, 'owner', `created_at` FROM `projects`;
