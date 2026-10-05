-- A record of each objects operation whose commit may hold objects D1 lacks,
-- or lack objects D1 still holds.
--
-- @version v1.5.0-beta
--
-- An objects operation commits to the repository and then applies its document
-- half through the collaboration object, which writes D1. A publish writes
-- objects.csv from D1, so a commit whose document half never ran is undone by
-- the next publish. This row outlives that gap: it is written before the
-- commit, and deleted once the document half has run. It lives in D1 rather
-- than in the collaboration object's storage because the failure it has to
-- outlive is most often that object being unreachable.
--
-- One row per operation, never updated except to move `prepared` to
-- `committed`: an id is the operation's identity, and AUTOINCREMENT keeps it
-- from being reused, since the collaboration object keeps receipts by it.
--
-- payload: register, the objects the commit carried; remove, a JSON array of
-- { object_id, doc_id } naming each object by its D1 id as well as its key.
-- parent_sha: the head the commit was built on.
-- commit_sha: set once the commit is known to have landed; NULL while
-- `prepared`, when a thrown request leaves it unknown.
CREATE TABLE pending_object_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'remove')),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'committed')),
  payload TEXT NOT NULL,
  parent_sha TEXT,
  commit_sha TEXT,
  actor_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX pending_object_ops_project ON pending_object_ops (project_id, id);
