-- Front-matter passthrough for page files, matching the custom-column
-- passthroughs of objects (0031) and the glossary (0054).
--
-- @version v1.5.0-beta
--
-- frontmatter: the text between a page file's two `---` markers, exactly as
-- the file has it (line endings, comments, key order). NULL when it was never
-- captured, which is every page imported before this column; "" when the file
-- has none. Without it, every key the Compositor does not model
-- (`localized_for`, `language`, `title_key`) is deleted by the next publish,
-- which writes the page's front matter from its title alone.
--
-- frontmatter_source: the slug of the file a page never captured is read from
-- at publish, to carry its front matter forward. Set here to the slug of every
-- existing page, which is the file each was imported from, so a page renamed
-- later still reads its own file. D1 only; NULL for pages created after this.
ALTER TABLE project_pages ADD COLUMN frontmatter text;
ALTER TABLE project_pages ADD COLUMN frontmatter_source text;
UPDATE project_pages SET frontmatter_source = slug;
