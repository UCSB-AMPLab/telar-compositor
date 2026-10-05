-- Course projects, part 4 of 6: generalise project_invites into the table that
-- carries both legacy single-use invite links and reusable course join codes.
--
-- created_by stops being NOT NULL and both user references become
-- ON DELETE SET NULL: a course code survives its issuer, and a redeemer's
-- account deletion must not trip over a surviving invite. used_at is carried
-- verbatim and is never nulled — it is the permanent consumed flag once used_by
-- can be cleared by a user deletion.
--
-- Backfill makes every live legacy row a single-use collaborator invite with its
-- expiry kept: pending links resolve exactly as before and consumed ones stay
-- consumed. max_uses NULL means unlimited.
--
-- The rebuild runs after 0038 by design — see the FK-ordering note there. All
-- joined_via_invite_id values are NULL at this point, so the ON DELETE SET NULL
-- the DROP fires against project_members changes nothing, and the RENAME
-- restores the referenced name inside this transaction.
PRAGMA defer_foreign_keys = true;

CREATE TABLE project_invites_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  token TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at TEXT,
  conferred_role TEXT NOT NULL,
  max_uses INTEGER,
  revoked_at TEXT,
  label TEXT
);

INSERT INTO project_invites_new
  (id, project_id, token, created_by, expires_at, used_by, used_at, conferred_role, max_uses, revoked_at, label)
  SELECT id, project_id, token, created_by, expires_at, used_by, used_at, 'collaborator', 1, NULL, NULL
  FROM project_invites;

DROP TABLE project_invites;

ALTER TABLE project_invites_new RENAME TO project_invites;

CREATE UNIQUE INDEX project_invites_token_unique ON project_invites (token);
