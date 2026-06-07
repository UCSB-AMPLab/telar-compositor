-- Add last_seen_release — null until a user dismisses the "What's new" release
-- modal; then set to the current release id (see app/lib/release-notes.ts).
-- Drives the once-per-release login announcement. New signups are initialized
-- to the current id at account creation so they start caught up.
ALTER TABLE `users` ADD `last_seen_release` text;
