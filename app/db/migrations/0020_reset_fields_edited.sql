-- 0020_reset_fields_edited.sql
-- Reset inflated wire-message counts to zero.
-- After this migration, fields_edited grows from zero using the new
-- unique-field Set semantics in the Durable Object.
-- Preserves other contribution fields (sessions, stories_edited,
-- objects_edited, last_active).
UPDATE project_members
SET contributions = json_set(
  COALESCE(contributions, '{}'),
  '$.fields_edited', 0
);
