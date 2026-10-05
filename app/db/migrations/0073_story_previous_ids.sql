-- The IDs a story held before its current one, so an editor address with an
-- earlier ID resolves to the story.
--
-- @version v1.5.0-beta
--
-- One row per earlier ID per project. The snapshot writes it in the batch that
-- renames the story, and an ID a later story leaves is pointed at that story.
-- A story's rows go with it, and a project's with the project.
--
-- The backfill covers what stories.source_path already records: a story
-- renamed since the file in the spreadsheets folder it was read from or last
-- written to. Earlier IDs a publish has since moved past are not recoverable.
-- Where two stories record the same file, nothing says which left its ID
-- last, so neither is recorded and the old address finds no story rather
-- than the wrong one.
CREATE TABLE `story_previous_ids` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `project_id` integer NOT NULL REFERENCES `projects`(`id`) ON DELETE CASCADE,
  `story_id` text NOT NULL,
  `story_row_id` integer NOT NULL REFERENCES `stories`(`id`) ON DELETE CASCADE,
  `recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_previous_ids_project_story_unique`
  ON `story_previous_ids` (`project_id`, `story_id`);
--> statement-breakpoint
CREATE INDEX `story_previous_ids_row` ON `story_previous_ids` (`story_row_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `story_previous_ids` (`project_id`, `story_id`, `story_row_id`, `recorded_at`)
SELECT `project_id`,
       substr(`source_path`, 28, length(`source_path`) - 31),
       `id`,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `stories`
WHERE `source_path` LIKE 'telar-content/spreadsheets/%.csv'
  AND length(`source_path`) > 31
  AND instr(substr(`source_path`, 28, length(`source_path`) - 31), '/') = 0
  AND substr(`source_path`, 28, length(`source_path`) - 31) <> `story_id`
  AND substr(`story_id`, 1, 1) <> '~'
  AND NOT EXISTS (
    SELECT 1 FROM `stories` AS `other`
    WHERE `other`.`project_id` = `stories`.`project_id`
      AND `other`.`id` <> `stories`.`id`
      AND `other`.`source_path` = `stories`.`source_path`
  );
