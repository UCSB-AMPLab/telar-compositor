-- Migration 0025: replace dead users.language_preference (set-once cookie default, never read)
-- with users.ui_locale (NULL = never actively chose; non-null = user's locked UI locale).

ALTER TABLE users ADD COLUMN ui_locale TEXT;
--> statement-breakpoint
UPDATE users SET ui_locale = language_preference
  WHERE language_preference IS NOT NULL AND language_preference <> 'en';
--> statement-breakpoint
ALTER TABLE users DROP COLUMN language_preference;
