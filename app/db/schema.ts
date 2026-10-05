/**
 * This file is the Drizzle ORM schema for the compositor's D1 database —
 * every table, column, type, and inferred TypeScript model the server
 * code reads or writes flows through here.
 *
 * @version v1.5.0-beta
 */

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, unique, uniqueIndex, blob } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * CPython's whitespace (`PYTHON_WHITESPACE`, app/lib/python-whitespace.ts) as
 * SQLite's `char()`, for a `trim()` that strips what `isHeldTermId` strips.
 */
const PYTHON_WHITESPACE_SQL =
  "char(9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760, 8192, 8193, 8194, 8195, 8196, " +
  "8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288)";

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
  // Whether this person may create and run courses. Granted from the backend
  // while the group is small; closed by default, so an unconfigured deploy
  // cannot open the feature by omission.
  course_access: integer("course_access", { mode: "boolean" }).notNull().default(false),
  ui_locale: text("ui_locale"),
  last_seen_release: text("last_seen_release"),
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
  // Set when the account was deleted: the row is then a tombstone that keeps
  // the person's name on their work and nothing else (migration 0057).
  deleted_at: text("deleted_at"),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: integer("user_id").notNull().references(() => users.id),
  github_repo_full_name: text("github_repo_full_name").notNull(),
  installation_id: integer("installation_id").notNull(),
  github_pages_url: text("github_pages_url"),
  onboarding_completed: integer("onboarding_completed", { mode: "boolean" }).default(false),
  head_sha: text("head_sha"),
  // The last commit whose objects.csv D1 accounts for (migration 0061); the
  // objects commits compare GitHub's object rows with it before writing.
  objects_read_sha: text("objects_read_sha"),
  // When the first sync check an author started gave the ids an import stored
  // stripped GitHub's spelling (migration 0063); NULL until then.
  legacy_ids_repaired_at: text("legacy_ids_repaired_at"),
  // The page files the Compositor answers for at a commit (migration 0064):
  // {"commit", "files": {name: page id | null}}; NULL until a writer records it.
  page_files_json: text("page_files_json"),
  // JSON [{path, sha}]: the story CSVs read before any publish, which the first
  // publish deletes for a story D1 no longer holds (migration 0067); NULL when none.
  story_files_to_delete_json: text("story_files_to_delete_json"),
  published_sha: text("published_sha"),
  last_synced_at: text("last_synced_at"),
  last_published_at: text("last_published_at"),
  publish_snapshot: text("publish_snapshot"),  // JSON: PublishSnapshot from publish.server.ts
  yjs_state: blob("yjs_state"),  // Stores Y.encodeStateAsUpdate() binary output
  // The generation and sequence the blob above was current under when
  // written; NULL on both means the blob predates either column (migration
  // 0052) and no instance has yet claimed the row.
  yjs_generation: integer("yjs_generation"),
  yjs_seq: integer("yjs_seq"),
  // The row's write revision (migration 0053). 0 means no instance has ever
  // claimed the row; every claim and every write of the blob, the tags or the
  // revision itself moves it up by one, and a write carrying an earlier
  // revision lands zero rows. Triggers in the migration refuse a blob or tag
  // change on a claimed row that does not move it, and refuse any assignment
  // that does not raise it.
  yjs_write: integer("yjs_write").notNull().default(0),
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
  // GitHub status cache (migration 0030) — keeps GitHub work off the per-nav
  // _app loader. Refreshed out-of-band via /api/site-status?payload=gh-status.
  gh_repo_available: integer("gh_repo_available"),       // null=cold, 1=available, 0=unavailable
  gh_remote_head_sha: text("gh_remote_head_sha"),
  gh_diverged: integer("gh_diverged"),                   // null=cold, 1=diverged, 0=in-sync
  gh_diverged_against_sha: text("gh_diverged_against_sha"), // local head_sha the verdict applies to
  gh_checked_at: text("gh_checked_at"),                  // ISO; null=cold cache
  // Workflows-permission cache (migration 0034) — whether this installation has
  // accepted the App's `workflows: write` grant. null=unknown/cold, 1=missing,
  // 0=present. Refreshed alongside gh-status. Drives the "approve updated
  // permissions" login modal so affected convenors aren't trapped at upgrade.
  gh_workflows_write_missing: integer("gh_workflows_write_missing"),
  gh_install_target_type: text("gh_install_target_type"), // "User" | "Organization" | null (cold) — org-aware reauth URL
  // How this project entered the compositor: "imported" (added from an existing
  // GitHub repo) or "created" (provisioned born-clean by the create flow).
  // Durable signal for telemetry and create-vs-import branching; the post-import
  // config-check skip is gated on a per-run success flag, never on this alone.
  origin: text("origin").default("imported"),
  // "site" for an ordinary Telar site, "course" for one that carries a shared
  // collection and issues join codes. Loose text validated in code rather than a
  // CHECK constraint, so a future kind costs no migration.
  kind: text("kind").notNull().default("site"),
  // A site's course. This column is the enrolment record — set and cleared
  // whenever a site joins or leaves. The SET NULL is a backstop; a course is
  // detached from every child before it is deleted. The return annotation is
  // required on a self-reference: without it the whole table infers as `any`.
  parent_project_id: integer("parent_project_id").references((): AnySQLiteColumn => projects.id, { onDelete: "set null" }),
  // When authorship was recovered from this project's Yjs document. Null means
  // not yet, which is what the backfill sweep selects on. See migration 0050 —
  // it is also the only record of which projects were reset before recovery
  // could run, and so lost that history for good.
  authorship_recovered_at: text("authorship_recovered_at"),
  // The repository-access reconciler's claim column (migration 0065): the
  // last time a run took this project, so two runs do not both add its members.
  gh_team_checked_at: text("gh_team_checked_at"),
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
  // Retired. An answer's length answers to two constants in word-count.ts —
  // 100 is advice, 200 is where the build cuts — and to nothing a site sets,
  // so no reader takes this column and no writer fills it. It stays because it
  // is applied on staging and dropping a live column buys nothing; the field
  // registry declares it carried by no subsystem.
  answer_word_limit: integer("answer_word_limit"),
  // development-features.skip_stories in _config.yml — drops the stories
  // section from the homepage entirely. Course galleries set it with
  // collection_mode.
  skip_stories: integer("skip_stories", { mode: "boolean" }).notNull().default(false),
  story_key: text("story_key"),
  navigation_json: text("navigation_json"),
  // The site's own glossary kinds (JSON array), or null while _config.yml is their source. Migration 0074.
  glossary_kinds_json: text("glossary_kinds_json"),
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
  created_by: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  last_edited_by: integer("last_edited_by").references(() => users.id),
  created_by_actor: text("created_by_actor"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
  // The course this object was preloaded from; null for an object the site made
  // itself. Gates deletion and repo-sync removal while it is set.
  course_project_id: integer("course_project_id").references(() => projects.id, { onDelete: "set null" }),
  // Authoritative ordering: a base-62 fractional index (app/lib/order-key.ts).
  // Objects publish no order at all — objects.csv does not encode one — so this
  // is the editor list's order and nothing else, held as a field so the
  // Y.Array position carries no meaning.
  order_key: text("order_key"),
}, (table) => [
  unique("objects_project_object_unique").on(table.project_id, table.object_id),
]);

export const stories = sqliteTable("stories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  story_id: text("story_id").notNull(),
  title: text("title"),
  subtitle: text("subtitle"),
  byline: text("byline"),
  // Dense rank derived from order_key at snapshot time. This is the column
  // project.csv publishes and the Telar framework consumes.
  order: integer("order").default(0),
  // Authoritative ordering: a base-62 fractional index (app/lib/order-key.ts).
  // A story moves by writing this field, so a reorder removes nothing from the
  // collaborative Y.Array and the own-content delete rule never has to judge it.
  order_key: text("order_key"),
  private: integer("private", { mode: "boolean" }).default(false),
  draft: integer("draft", { mode: "boolean" }).default(false),
  show_sections: integer("show_sections", { mode: "boolean" }).notNull().default(false),
  created_by: integer("created_by").references(() => users.id),
  last_edited_by: integer("last_edited_by").references(() => users.id),
  created_by_actor: text("created_by_actor"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
  // The repository path of the CSV the Compositor last read the story's steps
  // from or a publish wrote them to (migration 0062); NULL where not known, as
  // for a story never published. A publish deletes an older
  // copy of the story only at this path.
  source_path: text("source_path"),
  // JSON object of the story's cells in project.csv columns the Compositor
  // does not map, keyed by header in file order; NULL when there are none.
  extra_columns: text("extra_columns"),
});

// The IDs a story held before its current one, one row per earlier ID per
// project, so an editor address with an earlier ID resolves to the story. The
// snapshot writes a row in the batch that renames the story; an ID another
// story later leaves is pointed at that story. See migration 0073.
export const story_previous_ids = sqliteTable("story_previous_ids", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  story_id: text("story_id").notNull(),
  story_row_id: integer("story_row_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  recorded_at: text("recorded_at").notNull(),
}, (table) => [
  uniqueIndex("story_previous_ids_project_story_unique").on(table.project_id, table.story_id),
]);

export const steps = sqliteTable("steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  story_id: integer("story_id").notNull().references(() => stories.id),
  // Dense rank derived from order_key at snapshot time. This is what story.csv
  // publishes as `step` / `paso`.
  step_number: integer("step_number").notNull(),
  // Authoritative ordering: a base-62 fractional index (app/lib/order-key.ts).
  // A step moves by writing this field, so a reorder removes nothing from the
  // collaborative Y.Array and the own-content delete rule never has to judge it.
  order_key: text("order_key"),
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
  // JSON object of the step's cells in story CSV columns the Compositor does
  // not map, keyed by header in file order; NULL when there are none.
  extra_columns: text("extra_columns"),
  created_by: integer("created_by").references(() => users.id),
  last_edited_by: integer("last_edited_by").references(() => users.id),
  created_by_actor: text("created_by_actor"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const layers = sqliteTable("layers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  step_id: integer("step_id").notNull().references(() => steps.id),
  // Which layer{n}_* cell pair the layer occupies in story.csv. Dense rank,
  // derived from order_key at snapshot time.
  layer_number: integer("layer_number").notNull(),
  // Authoritative ordering: a base-62 fractional index (app/lib/order-key.ts).
  order_key: text("order_key"),
  title: text("title"),
  button_label: text("button_label"),
  content: text("content"),
  created_by: integer("created_by").references(() => users.id),
  last_edited_by: integer("last_edited_by").references(() => users.id),
  created_by_actor: text("created_by_actor"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});

export const glossary_terms = sqliteTable("glossary_terms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  term_id: text("term_id").notNull(),
  title: text("title"),
  definition: text("definition"),
  related_terms: text("related_terms"), // pipe-separated related term_ids (framework passthrough); null when none
  // The entry's kind as written in the sheet's kind column: a core or site kind
  // id, or a value that names no kind, kept as written. null when none.
  kind: text("kind"),
  // JSON object of custom glossary.csv columns with no first-class column here;
  // null when none. Mirrors objects.extra_columns.
  extra_columns: text("extra_columns"),
  // A column no subsystem carries (see the field registry): nothing reads it,
  // writes it, hashes it or publishes it. It stays because it is applied on
  // staging and dropping a live column buys nothing.
  quoted_in_stories: text("quoted_in_stories"),
  // Authoritative ordering: a base-62 fractional index (app/lib/order-key.ts).
  // glossary.csv encodes no order, so this is the editor list's order alone.
  order_key: text("order_key"),
  created_by: integer("created_by").references(() => users.id),
  last_edited_by: integer("last_edited_by").references(() => users.id),
  created_by_actor: text("created_by_actor"),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
}, (table) => [
  // Held ids (blank, or opening `#`, once CPython's whitespace is stripped)
  // publish no term and may repeat, so the index leaves them out.
  uniqueIndex("glossary_terms_project_term_unique")
    .on(table.project_id, table.term_id)
    .where(sql`trim(${table.term_id}, ${sql.raw(PYTHON_WHITESPACE_SQL)}) <> '' AND substr(trim(${table.term_id}, ${sql.raw(PYTHON_WHITESPACE_SQL)}), 1, 1) <> '#'`),
]);

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
  role: text("role", { enum: ["convenor", "collaborator", "instructor"] }).notNull(),
  invited_at: text("invited_at").$defaultFn(() => new Date().toISOString()),
  joined_at: text("joined_at"),
  // Null until a collaborator acknowledges the "you've been added" welcome
  // modal on landing; set once (one-time landing notification).
  welcomed_at: text("welcomed_at"),
  presence_color: text("presence_color"),
  contributions: text("contributions"),
  // The invite or join code that admitted this member — attribution only:
  // which code let them in. Nothing is counted or capped over it.
  joined_via_invite_id: integer("joined_via_invite_id").references(() => project_invites.id, { onDelete: "set null" }),
  // Repository access, as GitHub last answered for this member (migration
  // 0065). null=never read, access=collaborator, pending=open invitation,
  // lapsed=expired invitation, none=neither.
  gh_access: text("gh_access", { enum: ["access", "pending", "lapsed", "none"] }),
  gh_invitation_id: integer("gh_invitation_id"),
  gh_invitation_url: text("gh_invitation_url"),
  gh_access_checked_at: text("gh_access_checked_at"),
  // The add the App owes this member: null=not attempted, sending=sent to
  // GitHub and not yet answered, sent=GitHub took it, failed=retryable
  // (attempts and error say why), revoked=a convenor withdrew access and the
  // App never re-adds. A text column with no CHECK: a new value needs no migration.
  gh_add_state: text("gh_add_state", { enum: ["sending", "sent", "failed", "revoked"] }),
  gh_add_attempts: integer("gh_add_attempts").notNull().default(0),
  gh_add_error: text("gh_add_error"),
  gh_add_attempted_at: text("gh_add_attempted_at"),
  // Whether the App owes this member an add. The migration sets every row
  // that exists when it runs to 0, so members who joined earlier are never
  // added; a row inserted afterwards takes the default and is owed one.
  gh_add_owed: integer("gh_add_owed", { mode: "boolean" }).notNull().default(true),
}, (table) => [
  unique("project_members_unique").on(table.project_id, table.user_id),
]);

// Both legacy single-use invite links (a UUID in a URL) and course join codes
// (a short alphanumeric string a student copies) live here. created_by and
// used_by are nullable ON DELETE SET NULL — a code survives its issuer, and a
// redeemer's account deletion must not trip over a surviving invite, which is
// why used_at rather than used_by is the consumed flag.
export const project_invites = sqliteTable("project_invites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  token: text("token").notNull().unique(),
  created_by: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  // Null means the code never expires — a term-long class code needs no
  // death date. Legacy invite links keep setting their 48-hour window.
  expires_at: text("expires_at"),
  used_by: integer("used_by").references(() => users.id, { onDelete: "set null" }),
  used_at: text("used_at"),
  conferred_role: text("conferred_role").notNull(),
  revoked_at: text("revoked_at"),
  label: text("label"),
});

export const project_pages = sqliteTable("project_pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  title: text("title").notNull().default("Untitled"),
  slug: text("slug").notNull(),
  body: text("body").default(""),
  // The text between the page file's `---` fences, exactly as the file has it.
  // NULL when it was never captured (a page imported before the column
  // existed); "" when the file has none.
  frontmatter: text("frontmatter"),
  // D1 only: the slug of the file a page never captured is carried forward
  // from, which a rename does not change. Set for every page the column found;
  // NULL for pages created since, which read their current slug.
  frontmatter_source: text("frontmatter_source"),
  // Dense rank derived from order_key at snapshot time. Editor-only: the
  // published menu order comes from navigation_json, not this column.
  order: integer("order").notNull().default(0),
  // Authoritative ordering: a base-62 fractional index (app/lib/order-key.ts).
  order_key: text("order_key"),
  created_by: integer("created_by").references(() => users.id),
  last_edited_by: integer("last_edited_by").references(() => users.id),
  created_by_actor: text("created_by_actor"),
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
// Who wrote in each entity — one row per (entity, person). Distinct from
// `created_by` (who made it) and `last_edited_by` (who touched it most
// recently): on a shared step those name one person and this names everyone.
// Written by the Durable Object as an UPSERT, so a snapshot adds contributors
// and never replaces the set; see migration 0048 for why the store carries that
// property rather than the caller.
//
// Consumers MUST join against the entity table: entity_id is polymorphic, so it
// has no foreign key and nothing removes a row when its entity is deleted. A
// count from this table alone includes entities that no longer exist.
export const entity_contributors = sqliteTable("entity_contributors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  // "story" | "step" | "layer" | "object" | "term" | "page" — loose text
  // validated in code, matching projects.kind and objects.origin.
  entity_kind: text("entity_kind").notNull(),
  entity_id: integer("entity_id").notNull(),
  user_id: integer("user_id").notNull().references(() => users.id),
  // Written once; never updated. The last only ever moves forward.
  first_edit_at: text("first_edit_at"),
  last_edit_at: text("last_edit_at"),
  // How the row was arrived at. NULL — the default and the strongest — means the
  // Durable Object observed the edit live. See migration 0048; inference must
  // stay labelled wherever it is shown.
  basis: text("basis"),
  // Words this person added to this entity, accumulated per edit as the rise in
  // the field's word count, never below zero. NULL means nobody counted — a row
  // written before migration 0051, or recovered from the document — which is a
  // different fact from having written nothing, and is rendered differently.
  words_written: integer("words_written"),
}, (table) => [
  unique().on(table.project_id, table.entity_kind, table.entity_id, table.user_id),
]);

// How long each person has spent working in a project, in two measures taken
// from one stream of stamps: `editing_seconds` counts any change to the site,
// `writing_seconds` the part of it spent typing into a prose field. A change
// starts a clock that runs for a minute and a further change inside that minute
// extends it, so the stored total is the measure of the union of those windows.
//
// The two stamps are not display fields. They are how a Durable Object that has
// just started decides whether the change it holds continues the stretch of work
// the last instance saw or begins a new one; without them every eviction would
// credit a fresh minute. Both only ever move forward, and both totals are
// accumulated rather than assigned — see migration 0051.
export const member_editing_time = sqliteTable("member_editing_time", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  user_id: integer("user_id").notNull().references(() => users.id),
  editing_seconds: integer("editing_seconds").notNull().default(0),
  writing_seconds: integer("writing_seconds").notNull().default(0),
  last_change_at: text("last_change_at"),
  last_write_at: text("last_write_at"),
}, (table) => [
  unique("member_editing_time_unique").on(table.project_id, table.user_id),
]);

export const activity_log = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id),
  actor_user_id: integer("actor_user_id").references(() => users.id), // nullable: system/sync events
  verb: text("verb").notNull(),                 // 'edited'|'added'|'created'|'synced'|'published'
  entity_type: text("entity_type").notNull(),   // 'story'|'object'|'term'|'page'|'config'|'site'
  entity_id: text("entity_id"),                 // slug/story_id; nullable for site-level
  entity_label: text("entity_label"),           // denormalised title (avoids a join at read)
  // NOT NULL in the table, unlike every other created_at here: 0026 declared
  // it so. The default fills it on every insert through the ORM, and a raw
  // insert that omitted it would be rejected by the database.
  created_at: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// Per-user redemption rate limiter: one self-resetting row, counting failed
// join-code redemptions against a fixed hourly window that restarts once
// window_start is older than an hour. Every redemption surface is
// post-authentication, so the key is the user, not an address.
export const code_redemption_attempts = sqliteTable("code_redemption_attempts", {
  user_id: integer("user_id").primaryKey(),
  window_start: text("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

// The assertion a fenced batch carries inside its own transaction: the row it
// is about to write still holds the revision the instance claimed. The insert
// is refused by a trigger unless `projects.yjs_write` for `project_id` IS
// exactly `expected` — a missing project row is refused too — and an aborting
// statement aborts the whole batch. The batch's last statement deletes the row
// it inserted, so this table is empty outside a transaction.
export const yjs_write_guard = sqliteTable("yjs_write_guard", {
  project_id: integer("project_id").notNull(),
  expected: integer("expected").notNull(),
});

// One objects operation whose document half has not yet run: a commit that may
// hold objects D1 lacks (`register`), lack objects D1 still holds (`remove`),
// or hold an object under a new id (`rename`). Written before the commit and
// deleted once the collaboration object has applied the document half;
// `completePendingObjectOps` finishes whatever is left, before anything
// serialises objects.csv from D1. Never updated except to move `prepared` to
// `committed`, and the id is never reused: the collaboration object keeps its
// receipts by it. See migrations 0060 and 0069.
export const pending_object_ops = sqliteTable("pending_object_ops", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["register", "remove", "rename"] }).notNull(),
  state: text("state", { enum: ["prepared", "committed"] }).notNull(),
  payload: text("payload").notNull(),
  parent_sha: text("parent_sha"),
  commit_sha: text("commit_sha"),
  actor_id: integer("actor_id"),
  created_at: text("created_at").notNull(),
});

// A repository access the App still has to remove: written in the same batch
// as the removal that makes it necessary (the person's team row is gone, so
// nobody could revoke afterwards), deleted once GitHub confirms. See migrations
// 0065 and 0068.
export const repo_access_withdrawals = sqliteTable("repo_access_withdrawals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project_id: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  user_id: integer("user_id").notNull(),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error"),
  created_at: text("created_at").notNull(),
  // The person's GitHub account id when the membership ended (migration 0068).
  github_id: integer("github_id"),
});
