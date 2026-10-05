-- Add last_edited_by to the six entity tables, so the record can say who wrote
-- in a row rather than only who made it.
--
-- `created_by` answers *who made this entity*, and every consumer that matters
-- — a fair account of group work above all — needs *who wrote what is in it*.
-- The two diverge the moment a second person touches an entity, which in a
-- real-time collaborative editor is the normal case rather than the exception.
-- Measured over one classroom cohort, steps created against steps written in
-- ran 0 against 3, 1 against 3, 2 against 3, 16 against 10, 7 against 3: a
-- creation-only reading reports the person who wrote 837 words as having built
-- nothing, and credits whoever scaffolded sixteen steps with sixteen pieces
-- of writing when the writing is in ten. Panels diverge through empty ones,
-- where a creation count scores an untouched shell as finished work.
--
-- Written by the Durable Object from the field paths it already resolves, never
-- from a value the client supplies: `stories:7:steps:11:answer` names the row
-- it belongs to, and the actor is the session's server-resolved user. That
-- distinction is the whole reason this column is not simply set by the editor.
--
-- Nullable, because a row nobody has edited since this shipped has no honest
-- answer, and null here means *not recorded* — never *nobody*. Consumers must
-- render it as unknown.
--
-- Backwards-compatible: a nullable column is invisible to code that does not
-- select it, so a rollback to the previous worker keeps working.
ALTER TABLE stories ADD COLUMN last_edited_by integer REFERENCES users(id);
ALTER TABLE steps ADD COLUMN last_edited_by integer REFERENCES users(id);
ALTER TABLE layers ADD COLUMN last_edited_by integer REFERENCES users(id);
ALTER TABLE objects ADD COLUMN last_edited_by integer REFERENCES users(id);
ALTER TABLE glossary_terms ADD COLUMN last_edited_by integer REFERENCES users(id);
ALTER TABLE project_pages ADD COLUMN last_edited_by integer REFERENCES users(id);
