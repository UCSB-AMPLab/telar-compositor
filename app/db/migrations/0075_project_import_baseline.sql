-- What the import read, as the entity hashes a publish snapshot carries.
--
-- @version v1.5.6-beta
--
-- import_baseline: NULL, or the JSON of `EntityHashes` taken from D1 when an
-- import finishes. A site's first publish has no snapshot to compare with, and
-- compares its stories, objects, pages and glossary terms with this instead, so
-- its commit names what the author changed rather than everything the import
-- read. Projects imported before this column keep it NULL; no backfill.
ALTER TABLE projects ADD COLUMN import_baseline text;
