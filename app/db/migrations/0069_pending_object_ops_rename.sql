-- pending_object_ops accepts a `rename` record.
--
-- @version v1.5.0-beta
--
-- `kind` is a CHECK constraint, so the table is rebuilt. Ids are carried, and
-- so is AUTOINCREMENT's high-water mark: the collaboration object keeps
-- receipts by operation id, and an id must never be reused. When rows above
-- max(id) were deleted, a placeholder at the old sequence value moves the new
-- table's sequence to it and is removed. The placeholder takes an existing
-- project's id because project_id is a foreign key; with no project there is no
-- receipt to protect.
--
-- payload for rename: a one-element array { from, to, doc_id, step_values,
-- text }: the old and new ids, the object's D1 id, the step values and the text
-- rewrites the rename made.
CREATE TABLE pending_object_ops_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'remove', 'rename')),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'committed')),
  payload TEXT NOT NULL,
  parent_sha TEXT,
  commit_sha TEXT,
  actor_id INTEGER,
  created_at TEXT NOT NULL
);

INSERT INTO pending_object_ops_new
  (id, project_id, kind, state, payload, parent_sha, commit_sha, actor_id, created_at)
SELECT id, project_id, kind, state, payload, parent_sha, commit_sha, actor_id, created_at
FROM pending_object_ops;

INSERT INTO pending_object_ops_new (id, project_id, kind, state, payload, created_at)
SELECT s.seq, (SELECT MIN(id) FROM projects), 'register', 'committed', '[]', ''
FROM sqlite_sequence s
WHERE s.name = 'pending_object_ops'
  AND s.seq > (SELECT COALESCE(MAX(id), 0) FROM pending_object_ops)
  AND EXISTS (SELECT 1 FROM projects);
DELETE FROM pending_object_ops_new
WHERE id = (SELECT seq FROM sqlite_sequence WHERE name = 'pending_object_ops')
  AND id > (SELECT COALESCE(MAX(id), 0) FROM pending_object_ops);

DROP TABLE pending_object_ops;
ALTER TABLE pending_object_ops_new RENAME TO pending_object_ops;
CREATE INDEX pending_object_ops_project ON pending_object_ops (project_id, id);
