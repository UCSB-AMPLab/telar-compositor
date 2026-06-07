-- Add created_by to the six entity tables so authorship survives a cold rebuild from D1.
-- Collaborators set created_by on each entity's Y.Map at creation, but with no column to
-- persist it, a cold buildFromD1Rows (after a convenor reset or blob-loss eviction) rebuilt
-- every entity with created_by: undefined — silently destroying the authorship the delete
-- permission gate (use-structural-ops canDelete + workers/can-delete) relies on. Nullable,
-- references users(id); authorship is immutable so UPDATEs never touch it.
ALTER TABLE stories ADD COLUMN created_by integer REFERENCES users(id);
ALTER TABLE steps ADD COLUMN created_by integer REFERENCES users(id);
ALTER TABLE layers ADD COLUMN created_by integer REFERENCES users(id);
ALTER TABLE objects ADD COLUMN created_by integer REFERENCES users(id);
ALTER TABLE glossary_terms ADD COLUMN created_by integer REFERENCES users(id);
ALTER TABLE project_pages ADD COLUMN created_by integer REFERENCES users(id);
