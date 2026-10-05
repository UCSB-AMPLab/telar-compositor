-- Course projects, part 5 of 6: mark objects a site received from a course, and
-- stop a departing account's user row from being held hostage by objects it
-- created in projects it no longer belongs to.
--
-- course_project_id names the course an object came from, NULL for an object the
-- site made itself. It distinguishes course items in the objects list, it gates
-- deletion, and it is what leaving a course clears. ON DELETE SET NULL is a
-- backstop; the designed path clears the marker through the document before a
-- course is deleted.
--
-- created_by is redeclared ON DELETE SET NULL. As a plain reference with no
-- delete behaviour it already blocks account deletion for anyone who created an
-- object in a project they later left; preloading would multiply that across
-- every child site. The identical exposure on the other content tables predates
-- this release and is not touched here.
--
-- Full rebuild because SQLite cannot alter a column's foreign-key behaviour in
-- place. Every current column is carried with its default, in declaration order,
-- and id values are preserved: activity and Y.Doc rows key on them.
PRAGMA defer_foreign_keys = true;

CREATE TABLE objects_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  object_id TEXT NOT NULL,
  title TEXT,
  featured INTEGER DEFAULT 0,
  creator TEXT,
  description TEXT,
  source_url TEXT,
  period TEXT,
  year TEXT,
  object_type TEXT,
  subjects TEXT,
  source TEXT,
  credit TEXT,
  thumbnail TEXT,
  image_available INTEGER DEFAULT 0,
  missing_from_repo INTEGER DEFAULT 0,
  origin TEXT DEFAULT 'repo',
  alt_text TEXT,
  dimensions TEXT,
  extra_columns TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT,
  course_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
);

INSERT INTO objects_new
  (id, project_id, object_id, title, featured, creator, description, source_url,
   period, year, object_type, subjects, source, credit, thumbnail,
   image_available, missing_from_repo, origin, alt_text, dimensions,
   extra_columns, created_by, updated_at)
  SELECT
   id, project_id, object_id, title, featured, creator, description, source_url,
   period, year, object_type, subjects, source, credit, thumbnail,
   image_available, missing_from_repo, origin, alt_text, dimensions,
   extra_columns, created_by, updated_at
  FROM objects;

DROP TABLE objects;

ALTER TABLE objects_new RENAME TO objects;
