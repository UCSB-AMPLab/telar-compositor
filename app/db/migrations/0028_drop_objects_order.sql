-- Drop the vestigial objects."order" column. Objects are not reorderable anywhere
-- (no objects-page drag anywhere; the homepage reorders stories, not objects), and
-- the published Telar framework has no object order field — it renders featured objects
-- in natural CSV order and sorts the objects index by title. The column only ever held
-- creation-array order and its sole reader was the objects-manager list sort, now moved
-- to title ASC (matching the live objects index). Added by 0019; removed here.
ALTER TABLE objects DROP COLUMN "order";
