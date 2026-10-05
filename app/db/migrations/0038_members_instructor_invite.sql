-- Course projects, part 3 of 6: widen project_members.role to admit 'instructor'
-- and record which invite or code admitted each member.
--
-- The role CHECK added by 0018 cannot be widened in place, so this is a full
-- rebuild. It carries the table's nine current columns — 0018's precedent
-- predates welcomed_at (0027), and dropping that column would re-fire the
-- "you've been added" welcome modal for every member on the instance. id values
-- are preserved: the unique constraint and the welcome-modal state ride on row
-- identity.
--
-- FK ordering with 0039: this migration lands before the project_invites
-- rebuild, and stays there. At this point project_invites still exists in its
-- pre-0039 shape, so REFERENCES project_invites(id) resolves as written; and
-- when 0039 drops that table one migration later, every joined_via_invite_id is
-- still NULL (this migration introduces the column and nothing writes it until
-- the join-code work), so the implicit ON DELETE SET NULL a DROP TABLE fires has
-- nothing to clear. 0039 restores the project_invites name inside its own
-- transaction, so the dangling window never reaches a commit.
--
-- PRAGMA foreign_keys is documented as a no-op inside an open transaction and
-- wrangler wraps each migration in one; defer_foreign_keys is the form that
-- takes effect.
PRAGMA defer_foreign_keys = true;

CREATE TABLE project_members_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('convenor','collaborator','instructor')),
  invited_at TEXT,
  joined_at TEXT,
  welcomed_at TEXT,
  presence_color TEXT,
  contributions TEXT,
  joined_via_invite_id INTEGER REFERENCES project_invites(id) ON DELETE SET NULL
);

INSERT INTO project_members_new
  (id, project_id, user_id, role, invited_at, joined_at, welcomed_at, presence_color, contributions)
  SELECT id, project_id, user_id, role, invited_at, joined_at, welcomed_at, presence_color, contributions
  FROM project_members;

DROP TABLE project_members;

ALTER TABLE project_members_new RENAME TO project_members;

CREATE UNIQUE INDEX project_members_unique ON project_members (project_id, user_id);
