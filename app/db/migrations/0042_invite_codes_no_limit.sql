-- Course projects, follow-up: drop the join-code use limit and let a code
-- never expire.
--
-- The limit was never wanted, and it could not be held correctly: admissions
-- were counted on project_members.joined_via_invite_id, but a child site's
-- convenor holds one such row, so two courses contesting the same child let
-- one of them admit a site while counting none.
--
-- expires_at becomes nullable, and NULL means the code never expires: a class
-- code handed out at the start of a semester should not need a death date.
-- Legacy invite links keep setting the 48-hour expiry they always have.
--
-- A table rebuild rather than DROP COLUMN, because relaxing NOT NULL has no
-- ALTER form in SQLite. conferred_role, revoked_at and label are carried
-- verbatim: 0039 has already run wherever this runs, so they hold real values.
PRAGMA defer_foreign_keys = true;

CREATE TABLE project_invites_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  token TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at TEXT,
  conferred_role TEXT NOT NULL,
  revoked_at TEXT,
  label TEXT
);

INSERT INTO project_invites_new
  (id, project_id, token, created_by, expires_at, used_by, used_at, conferred_role, revoked_at, label)
  SELECT id, project_id, token, created_by, expires_at, used_by, used_at, conferred_role, revoked_at, label
  FROM project_invites;

DROP TABLE project_invites;

ALTER TABLE project_invites_new RENAME TO project_invites;

CREATE UNIQUE INDEX project_invites_token_unique ON project_invites (token);
