-- 0021_navigation_slug_unique.sql
-- navigation_json on project_config, UNIQUE(project_id, slug) on project_pages.

ALTER TABLE project_config
  ADD COLUMN navigation_json TEXT;

CREATE UNIQUE INDEX project_pages_project_slug_unique
  ON project_pages (project_id, slug);
