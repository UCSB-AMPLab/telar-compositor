/**
 * This file is the Drizzle ORM schema for the compositor's D1 database —
 * every table, column, type, and inferred TypeScript model the server
 * code reads or writes flows through here.
 *
 * @version v1.3.0-beta
 */

import { sqliteTable, text, integer, real, unique, blob } from "drizzle-orm/sqlite-core";

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
  github_plan: text("github_plan"),
  ui_locale: text("ui_locale"),
  last_seen_release: text("last_seen_release"),
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: integer("user_id").notNull().references(() => users.id),
  github_repo_full_name: text("github_repo_full_name").notNull(),
  installation_id: integer("installation_id").notNull(),
  github_pages_url: text("github_pages_url"),
  onboarding_completed: integer("onboarding_completed", { mode: "boolean" }).default(false),
  head_sha: text("head_sha"),
  published_sha: text("published_sha"),
  last_synced_at: text("last_synced_at"),
  last_published_at: text("last_published_at"),
  publish_snapshot: text("publish_snapshot"),  // JSON: PublishSnapshot from publish.server.ts
  yjs_state: blob("yjs_state"),  // Stores Y.encodeStateAsUpdate() binary output
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
  // GitHub status cache (migration 0030) — keeps GitHub work off the per-nav
  // _app loader. Refreshed out-of-band via /api/site-status?payload=gh-status.
  gh_repo_available: integer("gh_repo_available"),       // null=cold, 1=available, 0=unavailable
  gh_remote_head_sha: text("gh_remote_head_sha"),
  gh_diverged: integer("gh_diverged"),                   // null=cold, 1=diverged, 0=in-sync
  gh_diverged_against_sha: text("gh_diverged_against_sha"), // local head_sha the verdict applies to
  gh_checked_at: text("gh_checked_at"),                  // ISO; null=cold cache
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
  collection_mode: integer("collection_mode", { mode: "boolean" }).notNull().default(false),
  featured_count: integer("featured_count").default(4),
  story_key: text("story_key"),
  navigation_json: text("navigation_json"),
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
  image_available: integer("image_available", { mode: "boolean" }).default(false),
  missing_from_repo: integer("missing_from_repo", { mode: "boolean" }).default(false),
  origin: text("origin").default("repo"),
  alt_text: text("alt_text"),
  dimensions: text("dimensions"),
  extra_columns: text("extra_columns"), // JSON object of passthrough custom columns; null when none
  created_by: integer("created_by").references(() => users.id),
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
  draft: integer("draft", { mode: "boolean" }).default(false),
  show_sections: integer("show_sections", { mode: "boolean" }).notNull().default(false),
  created_by: integer("created_by").references(() => users.id),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const steps = sqliteTable("steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  story_id: integer("story_id").notNull().references(() => stories.id),
  step_number: integer("step_number").notNull(),
  kind: text("kind", { enum: ["media", "section"] }).notNull().default("media"),
  object_id: text("object_id"),
  x: real("x"),
  y: real("y"),
  zoom: real("zoom"),
  page: text("page"),
  question: text("question"),
  answer: text("answer"),
  alt_text: text("alt_text"),
  clip_start: text("clip_start"),
  clip_end: text("clip_end"),
  loop: text("loop"),
  created_by: integer("created_by").references(() => users.id),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const layers = sqliteTable("layers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  step_id: integer("step_id").notNull().references(() => steps.id),
  layer_number: integer("layer_number").notNull(),
  title: text("title"),
  button_label: text("button_label"),
  content: text("content"),
  created_by: integer("created_by").references(() => users.id),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const glossary_terms = sqliteTable("glossary_terms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  term_id: text("term_id").notNull(),
  title: text("title"),
  definition: text("definition"),
  related_terms: text("related_terms"), // pipe-separated related term_ids (framework passthrough); null when none
  created_by: integer("created_by").references(() => users.id),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const project_themes = sqliteTable("project_themes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  theme_id: text("theme_id").notNull(),
  name: text("name"),
  description: text("description"),
  creator: text("creator"),
  creator_url: text("creator_url"),
  swatch_color: text("swatch_color"),
});

export const project_landing = sqliteTable("project_landing", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  stories_heading: text("stories_heading"),
  stories_intro: text("stories_intro"),
  objects_heading: text("objects_heading"),
  objects_intro: text("objects_intro"),
  welcome_body: text("welcome_body"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const project_members = sqliteTable("project_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  user_id: integer("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["convenor", "collaborator"] }).notNull(),
  invited_at: text("invited_at").$defaultFn(() => new Date().toISOString()),
  joined_at: text("joined_at"),
  // Null until a collaborator acknowledges the "you've been added" welcome
  // modal on landing; set once (one-time landing notification).
  welcomed_at: text("welcomed_at"),
  presence_color: text("presence_color"),
  contributions: text("contributions"),
}, (table) => [
  unique("project_members_unique").on(table.project_id, table.user_id),
]);

export const project_invites = sqliteTable("project_invites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  token: text("token").notNull().unique(),
  created_by: integer("created_by").notNull().references(() => users.id),
  expires_at: text("expires_at").notNull(),
  used_by: integer("used_by").references(() => users.id),
  used_at: text("used_at"),
});

export const project_pages = sqliteTable("project_pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  title: text("title").notNull().default("Untitled"),
  slug: text("slug").notNull(),
  body: text("body").default(""),
  order: integer("order").notNull().default(0),
  created_by: integer("created_by").references(() => users.id),
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
}, (table) => [
  unique("project_pages_project_slug_unique").on(table.project_id, table.slug),
]);

// Coarse per-save activity rows (actor + entity + verb + timestamp) feeding
// the Start-tab activity feed. One row per save/create/sync, not
// per-field. `verb` and `entity_type` are plain text validated in code (see
// activity.server.ts) rather than Drizzle enums, to avoid migration churn as
// new verbs appear — matching the loose-text convention used by objects.origin.
export const activity_log = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  actor_user_id: integer("actor_user_id").references(() => users.id), // nullable: system/sync events
  verb: text("verb").notNull(),                 // 'edited'|'added'|'created'|'synced'|'published'
  entity_type: text("entity_type").notNull(),   // 'story'|'object'|'term'|'page'|'config'|'site'
  entity_id: text("entity_id"),                 // slug/story_id; nullable for site-level
  entity_label: text("entity_label"),           // denormalised title (avoids a join at read)
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
});
