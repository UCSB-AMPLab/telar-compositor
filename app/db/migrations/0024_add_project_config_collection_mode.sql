-- Add collection_mode to project_config — toggles the published homepage to lead with objects (collection mode) instead of stories.
ALTER TABLE `project_config` ADD `collection_mode` integer DEFAULT 0 NOT NULL;
