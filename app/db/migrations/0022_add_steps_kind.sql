-- Add kind column to steps so a story can mix media steps and section-break (chapter heading) steps.
ALTER TABLE `steps` ADD `kind` text DEFAULT 'media' NOT NULL;
