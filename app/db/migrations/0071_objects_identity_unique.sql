-- An object's identity is unique within its project.
--
-- @version v1.5.0-beta
--
-- stories and project_pages carry a unique index on their identity (0002,
-- 0021); objects did not, so the collaboration object had to keep the rule in
-- application code. Production held no duplicate (project_id, object_id) pair
-- when this was written (3 October 2026).
CREATE UNIQUE INDEX objects_project_object_unique ON objects(project_id, object_id);
