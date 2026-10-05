-- A glossary entry's kind.
--
-- @version v1.5.0-beta
--
-- glossary_terms.kind: the id of the entry's kind as the sheet's kind column
-- holds it (core kinds term, source, entity, place, or a site kind from
-- glossary.kinds in _config.yml), or a value that is not a known kind, kept as
-- written. NULL when the sheet gives none, which the framework reads as term.
--
-- Until now the import kept the column among the custom columns, under the key
-- "kind" (a sheet's "tipo" is renamed to "kind" on import). The UPDATE moves
-- that value into the new column and out of extra_columns, so the entry does
-- not publish the column twice. Rows whose extra_columns is NULL, not JSON, or
-- holds no "kind" key are left as they are.
ALTER TABLE glossary_terms ADD COLUMN kind text;
UPDATE glossary_terms
SET kind = json_extract(extra_columns, '$.kind'),
    extra_columns = json_remove(extra_columns, '$.kind')
WHERE extra_columns IS NOT NULL
  AND json_valid(extra_columns)
  AND json_type(extra_columns, '$.kind') IS NOT NULL;
