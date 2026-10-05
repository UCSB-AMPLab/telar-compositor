-- A glossary term's identity is unique within its project.
--
-- @version v1.5.0-beta
--
-- Held terms are left out: a term_id that is blank or opens with `#` once the
-- whitespace Python's str.isspace() matches is stripped (isHeldTermId) is a row
-- the site never shows, several may share one, and publish writes
-- them back as the author wrote them.
--
-- Apply only after the collaboration object has renamed the duplicates that
-- concurrent term creation left behind: production held two pairs, both
-- `untitled-term` (3 October 2026), and the index cannot be built over them.
CREATE UNIQUE INDEX glossary_terms_project_term_unique
  ON glossary_terms(project_id, term_id)
  WHERE trim(term_id, char(9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288)) <> ''
    AND substr(trim(term_id, char(9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288)), 1, 1) <> '#';
