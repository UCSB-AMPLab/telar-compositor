import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  github_id: integer("github_id").notNull().unique(),
  github_login: text("github_login").notNull(),
  github_name: text("github_name"),
  github_email: text("github_email"),
  encrypted_access_token: text("encrypted_access_token").notNull(),
  encrypted_refresh_token: text("encrypted_refresh_token").notNull(),
  access_token_expires_at: text("access_token_expires_at").notNull(), // ISO 8601
  refresh_token_expires_at: text("refresh_token_expires_at").notNull(),
  language_preference: text("language_preference").default("en"),
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: integer("user_id").notNull().references(() => users.id),
  github_repo_full_name: text("github_repo_full_name").notNull(),
  installation_id: integer("installation_id").notNull(),
  github_pages_url: text("github_pages_url"),
  head_sha: text("head_sha"),
  published_sha: text("published_sha"),
  last_synced_at: text("last_synced_at"),
  last_published_at: text("last_published_at"),
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const project_config = sqliteTable("project_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  title: text("title"),
  lang: text("lang").default("en"),
  baseurl: text("baseurl"),
  url: text("url"),
  telar_version: text("telar_version"),
  theme: text("theme"),
  description: text("description"),
  author: text("author"),
  email: text("email"),
  logo: text("logo"),
  include_demo_content: integer("include_demo_content", { mode: "boolean" }).default(true),
  google_sheets_enabled: integer("google_sheets_enabled", { mode: "boolean" }).default(false),
  google_sheets_published_url: text("google_sheets_published_url"),
  show_on_homepage: integer("show_on_homepage", { mode: "boolean" }).default(true),
  show_story_steps: integer("show_story_steps", { mode: "boolean" }).default(true),
  show_object_credits: integer("show_object_credits", { mode: "boolean" }).default(true),
  browse_and_search: integer("browse_and_search", { mode: "boolean" }).default(true),
  show_link_on_homepage: integer("show_link_on_homepage", { mode: "boolean" }).default(true),
  show_sample_on_homepage: integer("show_sample_on_homepage", { mode: "boolean" }).default(false),
  featured_count: integer("featured_count").default(4),
  story_key: text("story_key"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const objects = sqliteTable("objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  object_id: text("object_id").notNull(),
  title: text("title"),
  featured: integer("featured", { mode: "boolean" }).default(false),
  creator: text("creator"),
  description: text("description"),
  source_url: text("source_url"),
  period: text("period"),
  year: text("year"),
  object_type: text("object_type"),
  subjects: text("subjects"),
  source: text("source"),
  credit: text("credit"),
  thumbnail: text("thumbnail"),
  has_iiif_tiles: integer("has_iiif_tiles", { mode: "boolean" }).default(false),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const stories = sqliteTable("stories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  story_id: text("story_id").notNull(),
  title: text("title"),
  subtitle: text("subtitle"),
  byline: text("byline"),
  order: integer("order").default(0),
  private: integer("private", { mode: "boolean" }).default(false),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const steps = sqliteTable("steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  story_id: integer("story_id").notNull().references(() => stories.id),
  step_number: integer("step_number").notNull(),
  object_id: text("object_id"),
  x: real("x"),
  y: real("y"),
  zoom: real("zoom"),
  page: text("page"),
  question: text("question"),
  answer: text("answer"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const layers = sqliteTable("layers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  step_id: integer("step_id").notNull().references(() => steps.id),
  layer_number: integer("layer_number").notNull(),
  button_label: text("button_label"),
  content: text("content"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const glossary_terms = sqliteTable("glossary_terms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  term_id: text("term_id").notNull(),
  title: text("title"),
  definition: text("definition"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});
