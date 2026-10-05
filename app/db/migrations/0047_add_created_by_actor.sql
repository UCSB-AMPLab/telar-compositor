-- Add created_by_actor to the six entity tables: what made a row, when no
-- person did.
--
-- `created_by` points at a user, so it has exactly two things to say — a person,
-- or null. Null then has to carry every case at once: content the Telar template
-- shipped, content imported from a repo whose CSVs were written outside the
-- compositor by hands it never saw, and content that predates the column. A
-- reader cannot tell those apart, and a view built on it must render all three
-- as "unknown", which reads to a student as "nobody" — the one thing it must
-- never say about work somebody did.
--
-- This column states the non-person case instead of leaving it to be inferred.
-- 'telar_template' for the starter story and placeholder object the template
-- ships; 'imported' for the rest of a linked repo's content. Null means read
-- `created_by`: either a person made the row, or nothing here knows.
--
-- The importing user is deliberately NOT written as the author of imported
-- content, even though the import knows exactly who they are. They become the
-- project's convenor in the same step, and crediting them for whatever the
-- repo's CSVs contain — and for whatever anyone later writes into those rows —
-- carries an air of authority that is worse than an honest null.
--
-- Server-authored, and it never enters the Yjs document: nothing edits it, so
-- keeping it out means it cannot be written by a client at all. The snapshot
-- preserves it by omission, having no SET clause that mentions it. A stale-id
-- re-INSERT of a story, step, layer or page loses it, which is a bounded loss
-- on a recovery path that only runs when the D1 row is already gone.
--
-- Loose text rather than a CHECK constraint, matching `projects.kind` and
-- `objects.origin`: the vocabulary is validated in code
-- (`app/lib/authorship.ts`), so a further actor costs no migration.
--
-- Backwards-compatible: a nullable column is invisible to code that does not
-- select it, so a rollback to the previous worker keeps working.
ALTER TABLE stories ADD COLUMN created_by_actor text;
ALTER TABLE steps ADD COLUMN created_by_actor text;
ALTER TABLE layers ADD COLUMN created_by_actor text;
ALTER TABLE objects ADD COLUMN created_by_actor text;
ALTER TABLE glossary_terms ADD COLUMN created_by_actor text;
ALTER TABLE project_pages ADD COLUMN created_by_actor text;
