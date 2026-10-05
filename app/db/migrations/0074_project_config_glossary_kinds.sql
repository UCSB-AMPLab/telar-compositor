-- The site's own glossary kinds as the Compositor holds them: a JSON
-- array of { id, label, heading, values? }, written by the Glossary page and
-- published as `glossary.kinds` in _config.yml.
--
-- @version v1.5.0-beta
--
-- NULL until an author first edits the kinds, so the repository's
-- _config.yml stays their source until then; no backfill.
ALTER TABLE `project_config` ADD COLUMN `glossary_kinds_json` text;
