-- Story ordering becomes a field on the story rather than its position in the
-- collaborative Y.Array.
--
-- Moving a story by deleting its Y.Map and reinserting a clone is
-- indistinguishable, on the wire, from deleting a colleague's story and putting
-- a hollow one carrying their identity in its place. The own-content rule
-- therefore had to carry an exemption for "that was really a reorder", decided
-- on fields any collaborator can write. A story that carries its own place
-- issues no delete when it moves, so the rule never fires.
--
-- order_key is a fractional index: a base-62 string compared
-- lexicographically, for which a value strictly between any two neighbours
-- always exists. The integer `order` column cannot do that — there is nothing
-- between 1 and 2 — and renumbering the neighbours instead writes every row on
-- every drag and interleaves badly when two people drag at once, which is the
-- failure this change exists to escape. The alphabet is ASCII-ascending, so
-- SQLite's default BINARY collation sorts it correctly with no collation
-- clause.
--
-- `order` is kept, unchanged in type and meaning, as the dense rank the
-- snapshot derives from order_key order rather than from the Y.Array index. It
-- is the column project.csv publishes and the framework consumes; turning it
-- into text would be a change to the published contract, which this is not.
--
-- The backfill carries the existing order across: rank each project's stories
-- by ("order", id) — the exact sequence every reader used before this
-- migration — and write that rank as a fixed-width key. The four base-62 digits
-- hold 14,776,336 stories per project; the trailing '1' keeps the fractional
-- part free of the trailing zero that would make a key non-canonical, and being
-- constant across every row it does not disturb the ordering.

ALTER TABLE stories ADD COLUMN order_key TEXT;

UPDATE stories
SET order_key = (
  SELECT
    'a0'
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (r.rn / 238328) % 62 + 1, 1)
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (r.rn / 3844) % 62 + 1, 1)
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (r.rn / 62) % 62 + 1, 1)
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', r.rn % 62 + 1, 1)
    || '1'
  FROM (
    SELECT
      id AS rid,
      ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY "order" ASC, id ASC) - 1 AS rn
    FROM stories
  ) AS r
  WHERE r.rid = stories.id
);

CREATE INDEX IF NOT EXISTS stories_project_order_key ON stories (project_id, order_key);
