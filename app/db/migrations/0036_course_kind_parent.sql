-- Course projects, part 1 of 6: mark a project as a course and link a site to one.
--
-- `kind` is loose text validated in code, not a CHECK constraint, so a future
-- kind costs no migration (same convention as objects.origin and
-- activity_log.verb). Every existing row and every insertion path that does not
-- name the column becomes 'site' by the default.
--
-- `parent_project_id` is the enrolment record: a site points at the course it
-- belongs to. ON DELETE SET NULL is a backstop against a missed row — the
-- designed path detaches every child before a course is deleted.
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'site';
ALTER TABLE projects ADD COLUMN parent_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
