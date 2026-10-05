-- Custom-column passthrough for glossary.csv, matching objects (0031).
--
-- @version v1.5.0-beta
--
-- extra_columns: JSON object of the custom glossary.csv columns the Compositor
-- has no first-class column for; NULL when none. Without it, a column an author
-- adds to glossary.csv by hand is absent from D1 and so deleted by the next
-- publish, which writes the file from the fixed column list alone.
ALTER TABLE glossary_terms ADD COLUMN extra_columns text;
