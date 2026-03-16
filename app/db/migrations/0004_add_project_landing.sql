CREATE TABLE `project_landing` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `project_id` integer NOT NULL REFERENCES `projects`(`id`),
  `stories_heading` text,
  `stories_intro` text,
  `objects_heading` text,
  `objects_intro` text,
  `welcome_body` text,
  `updated_at` text
);
