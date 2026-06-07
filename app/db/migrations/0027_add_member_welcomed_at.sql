-- Add welcomed_at — null until a collaborator acknowledges the "you've been added" welcome modal on landing. Drives the one-time added-to-project notification.
ALTER TABLE `project_members` ADD `welcomed_at` text;
