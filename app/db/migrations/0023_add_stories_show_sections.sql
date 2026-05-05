-- Add show_sections toggle to stories — controls whether section headings appear as a TOC on the published title card.
ALTER TABLE `stories` ADD `show_sections` integer DEFAULT 0 NOT NULL;
