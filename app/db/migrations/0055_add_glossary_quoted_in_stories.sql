-- The overlap acknowledgement a glossary term makes to the framework's
-- protected-story leak sweep (framework 1.8.0).
--
-- @version v1.5.0-beta
--
-- quoted_in_stories: pipe-separated ids of the PROTECTED stories whose passage
-- this public definition deliberately quotes, so the sweep can be told the
-- overlap is intended; NULL when the term acknowledges nothing. Not an index of
-- where the term appears.
ALTER TABLE glossary_terms ADD COLUMN quoted_in_stories text;
