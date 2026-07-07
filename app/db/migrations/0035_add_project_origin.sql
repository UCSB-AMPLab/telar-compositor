-- Add projects.origin — "imported" (added from an existing GitHub repo) or
-- "created" (provisioned born-clean by the create flow). Existing rows default
-- to "imported", which is correct for every project that predates the create
-- flow. New imports keep the default; the create flow sets "created". Durable
-- signal for telemetry and create-vs-import branching.
ALTER TABLE `projects` ADD `origin` text DEFAULT 'imported';
