-- Cache GitHub-derived project status so the _app layout loader never blocks
-- navigation on a GitHub API waterfall. Raw remote facts + a SHA-tagged
-- divergence verdict (the verdict needs the content diff, so it is cached).
-- The verdict is valid only while local head_sha equals gh_diverged_against_sha.
-- needsUpgrade/isBelowMinimum/latestTag are NOT stored: the latest Telar tag is
-- global, cached in-isolate, and compared against project_config.telar_version
-- at read time. All nullable; existing rows read as cold cache (fail-open for
-- the pill, fail-closed for the upgrade gate). Refreshed out-of-band by the
-- Site Status pill via /api/site-status?payload=gh-status.
ALTER TABLE projects ADD COLUMN gh_repo_available integer;
ALTER TABLE projects ADD COLUMN gh_remote_head_sha text;
ALTER TABLE projects ADD COLUMN gh_diverged integer;
ALTER TABLE projects ADD COLUMN gh_diverged_against_sha text;
ALTER TABLE projects ADD COLUMN gh_checked_at text;
