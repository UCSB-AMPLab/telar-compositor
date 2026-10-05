-- The remaining five collaborative lists follow stories (0043): an entry's
-- place becomes a field on the entry rather than its position in the Y.Array.
--
-- Moving an entry by deleting its Y.Map and reinserting a clone is
-- indistinguishable, on the wire, from deleting a colleague's entry and putting
-- a hollow one carrying their identity in its place. The own-content rule
-- therefore had to carry an exemption for "that was really a reorder", decided
-- on fields any collaborator can write. With stories converted the exemption
-- was still load-bearing for these five; with them converted it is not, and it
-- goes.
--
-- order_key is a fractional index: a base-62 string compared
-- lexicographically, for which a value strictly between any two neighbours
-- always exists. An integer rank cannot do that — there is nothing between 1
-- and 2 — and renumbering the neighbours instead writes every row on every drag
-- and interleaves badly when two people drag at once, which is the failure this
-- change exists to escape. The alphabet is ASCII-ascending, so SQLite's default
-- BINARY collation sorts it correctly with no collation clause.
--
-- Every existing published rank is kept, unchanged in type and meaning, and is
-- now the dense rank the snapshot derives from order_key order rather than from
-- the Y.Array index:
--   steps.step_number         -> story.csv `step` / `paso`
--   layers.layer_number       -> which layer{n}_* cell pair the layer occupies
--   project_pages."order"     -> editor-only; the published menu order is
--                                navigation_json, which is untouched here
-- objects and glossary_terms have no rank column and publish none: objects.csv
-- and glossary.csv do not encode order. They gain order_key alone, so the
-- editor list order stops being an accident of the Y.Array.
--
-- The backfill carries the existing order across: rank each list by exactly the
-- sequence every reader used before this migration, and write that rank as a
-- fixed-width key. The four base-62 digits hold 14,776,336 entries per parent;
-- the trailing '1' keeps the fractional part free of the trailing zero that
-- would make a key non-canonical, and being constant across every row it does
-- not disturb the ordering.

ALTER TABLE steps ADD COLUMN order_key TEXT;
ALTER TABLE layers ADD COLUMN order_key TEXT;
ALTER TABLE objects ADD COLUMN order_key TEXT;
ALTER TABLE glossary_terms ADD COLUMN order_key TEXT;
ALTER TABLE project_pages ADD COLUMN order_key TEXT;

-- Steps: ordered within their story by the rank the snapshot has always
-- written from the Y.Array index.
UPDATE steps
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
      ROW_NUMBER() OVER (PARTITION BY story_id ORDER BY step_number ASC, id ASC) - 1 AS rn
    FROM steps
  ) AS r
  WHERE r.rid = steps.id
);

-- Layers: ordered within their step. layer_number is also the published slot
-- (layer1_* versus layer2_* cells), so it stays exactly what it is; the key
-- only records the sequence the snapshot ranks from.
UPDATE layers
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
      ROW_NUMBER() OVER (PARTITION BY step_id ORDER BY layer_number ASC, id ASC) - 1 AS rn
    FROM layers
  ) AS r
  WHERE r.rid = layers.id
);

-- Objects: no rank column ever existed, so the order the cold build handed the
-- editor was `ORDER BY id` — that is the order to preserve.
UPDATE objects
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
      ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY id ASC) - 1 AS rn
    FROM objects
  ) AS r
  WHERE r.rid = objects.id
);

-- Glossary terms: same as objects — the cold build's `ORDER BY id`.
UPDATE glossary_terms
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
      ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY id ASC) - 1 AS rn
    FROM glossary_terms
  ) AS r
  WHERE r.rid = glossary_terms.id
);

-- Pages: ordered within their project by the "order" column the cold build
-- already sorted on.
UPDATE project_pages
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
    FROM project_pages
  ) AS r
  WHERE r.rid = project_pages.id
);

CREATE INDEX IF NOT EXISTS steps_story_order_key ON steps (story_id, order_key);
CREATE INDEX IF NOT EXISTS layers_step_order_key ON layers (step_id, order_key);
CREATE INDEX IF NOT EXISTS objects_project_order_key ON objects (project_id, order_key);
CREATE INDEX IF NOT EXISTS glossary_terms_project_order_key ON glossary_terms (project_id, order_key);
CREATE INDEX IF NOT EXISTS project_pages_project_order_key ON project_pages (project_id, order_key);
