-- Rename role 'owner' -> 'convenor' and add contributions column to project_members.
-- Multi-user features not yet deployed; no production data has role values to preserve.
-- SQLite does not support ALTER TABLE ... DROP CONSTRAINT, so we recreate the table.

PRAGMA foreign_keys=OFF;
--> statement-breakpoint

CREATE TABLE `project_members_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `project_id` integer NOT NULL REFERENCES `projects`(`id`),
  `user_id` integer NOT NULL REFERENCES `users`(`id`),
  `role` text NOT NULL CHECK(`role` IN ('convenor', 'collaborator')),
  `invited_at` text,
  `joined_at` text,
  `presence_color` text,
  `contributions` text
);
--> statement-breakpoint

INSERT INTO `project_members_new`
  (`id`, `project_id`, `user_id`, `role`, `invited_at`, `joined_at`, `presence_color`, `contributions`)
SELECT
  `id`, `project_id`, `user_id`,
  CASE `role` WHEN 'owner' THEN 'convenor' ELSE `role` END,
  `invited_at`, `joined_at`, `presence_color`, NULL
FROM `project_members`;
--> statement-breakpoint

DROP TABLE `project_members`;
--> statement-breakpoint

ALTER TABLE `project_members_new` RENAME TO `project_members`;
--> statement-breakpoint

CREATE UNIQUE INDEX `project_members_unique` ON `project_members` (`project_id`, `user_id`);
--> statement-breakpoint

PRAGMA foreign_keys=ON;
