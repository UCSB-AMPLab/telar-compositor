-- The GitHub account a repository-access withdrawal is for.
--
-- @version v1.5.0-beta
--
-- repo_access_withdrawals.github_id: the person's GitHub account id at the
-- moment their membership ended, recorded in the same batch. Deleting an
-- account sets users.github_id to a negative tombstone in that batch, and the
-- reconciler resolves the current login by account id, so the id has to
-- travel with the withdrawal. NULL only for a person who never had one.
ALTER TABLE repo_access_withdrawals ADD COLUMN github_id integer;
