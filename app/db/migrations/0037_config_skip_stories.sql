-- Course projects, part 2 of 6: the framework's development-features.skip_stories
-- flag, which removes the stories section from the homepage entirely. Existing
-- rows backfill false by the default; only course provisioning sets it true.
ALTER TABLE project_config ADD COLUMN skip_stories INTEGER NOT NULL DEFAULT 0;
