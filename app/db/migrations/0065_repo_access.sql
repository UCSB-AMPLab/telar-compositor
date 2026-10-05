-- Repository access for project members.
--
-- @version v1.5.0-beta
--
-- The GitHub App adds each member who joins a project as a collaborator on its
-- repository. Members who joined before this release are not added: the
-- UPDATE below marks every existing row as owed nothing, and a row inserted
-- afterwards takes the default and is owed an add, so no insert site changes.
--
-- projects.gh_team_checked_at: the reconciler's claim on a project's refresh,
-- kept apart from gh_checked_at so the two polls never contend.
--
-- project_members.gh_access: what GitHub last said, read through the
-- installation token: access, pending, lapsed or none; NULL until first read.
-- gh_invitation_id and gh_invitation_url: the open or lapsed invitation, if any.
-- gh_add_state: NULL until an add is attempted, then sent, failed (retried) or
-- revoked (never re-added); gh_add_attempts, gh_add_error and
-- gh_add_attempted_at record the attempts so a failure is visible and retried.
--
-- repo_access_withdrawals: access to withdraw for a person whose membership
-- row is already gone (a removal, a departure, a deleted account, a course
-- instructor leaving or a site detached from its course). It is written in the
-- same batch as the removal and deleted once GitHub confirms the withdrawal.
ALTER TABLE projects ADD COLUMN gh_team_checked_at text;
ALTER TABLE project_members ADD COLUMN gh_access text;
ALTER TABLE project_members ADD COLUMN gh_invitation_id integer;
ALTER TABLE project_members ADD COLUMN gh_invitation_url text;
ALTER TABLE project_members ADD COLUMN gh_access_checked_at text;
ALTER TABLE project_members ADD COLUMN gh_add_state text;
ALTER TABLE project_members ADD COLUMN gh_add_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE project_members ADD COLUMN gh_add_error text;
ALTER TABLE project_members ADD COLUMN gh_add_attempted_at text;
ALTER TABLE project_members ADD COLUMN gh_add_owed integer NOT NULL DEFAULT 1;
UPDATE project_members SET gh_add_owed = 0;
CREATE TABLE repo_access_withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX repo_access_withdrawals_project ON repo_access_withdrawals (project_id, id);
