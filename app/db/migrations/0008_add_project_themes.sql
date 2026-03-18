CREATE TABLE project_themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  theme_id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  creator TEXT,
  creator_url TEXT,
  swatch_color TEXT
);