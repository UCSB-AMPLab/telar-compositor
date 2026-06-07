-- Cache whether each installation has accepted the App's `workflows: write`
-- grant, so the _app loader can surface a login-time "approve updated
-- permissions" modal without a per-navigation GitHub call. GitHub does not
-- auto-propagate a newly-declared App permission to existing installations —
-- each owner must approve it — so an install can hold contents/pages/etc. yet
-- lack workflows, which fails any upgrade that touches .github/workflows/.
-- Both nullable; existing rows read as cold (unknown) and fail-open (no modal)
-- until the gh-status poll fills them. Refreshed out-of-band alongside the
-- other gh_ columns via /api/site-status?payload=gh-status.
ALTER TABLE projects ADD COLUMN gh_workflows_write_missing integer;
ALTER TABLE projects ADD COLUMN gh_install_target_type text;
