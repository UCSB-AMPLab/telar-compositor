/**
 * This file holds the one table that says which site-configuration fields a
 * member may write, so the route action, the page's Yjs field writes and the
 * Durable Object's snapshot enforcement all decide from the same list rather
 * than from three hand-maintained copies of it.
 *
 * The line, approved 2026-08-27: a collaborator may not change *where the site
 * lives, how it is built, or where its data comes from*. Six fields fall on
 * the convenor's side of it and are named below. This is an approved list, not
 * one derived from the schema or inferred from a field's type — a column added
 * to `project_config` later is collaborator-writable until someone decides
 * otherwise, and moving one across the line is that decision, not a refactor.
 *
 * Everything else in `project_config` — titles, descriptions, author, email,
 * theme, display toggles, `collection_mode`, `featured_count` — stays with any
 * member, matching what the homepage editor's autosave already reaches through
 * the shared document.
 *
 * `refresh-themes` is not on this list because it is not a config field: it
 * wipes `project_themes` and rebuilds it from the repo, and stays convenor-only
 * on its own terms.
 *
 * @version v1.5.0-beta
 */

/** Roles a project membership row can carry. */
export type ConfigRole = "convenor" | "collaborator" | "instructor";

/**
 * The six fields only a site's convenor may write.
 *
 * `url` and `baseurl` decide where the site lives; `include_demo_content`
 * decides what is built into it; `google_sheets_enabled` and
 * `google_sheets_published_url` decide where its content comes from; and
 * `story_key` is the credential that gates reader access to the stories.
 */
export const CONVENOR_ONLY_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  "url",
  "baseurl",
  "story_key",
  "google_sheets_enabled",
  "google_sheets_published_url",
  "include_demo_content",
]);

/** True when `name` is one of the six the convenor alone may write. */
export function isConvenorOnlyConfigField(name: string): boolean {
  return CONVENOR_ONLY_CONFIG_FIELDS.has(name);
}

/**
 * Whether a caller holding `role` may write the config field `name`.
 *
 * Instructors carry a collaborator's editorial rights and no more, so the two
 * answer alike. A role the gates do not recognise — including a missing one —
 * writes nothing: an unknown role is not standing, and reading it as one would
 * turn a membership bug into a config rewrite.
 */
export function canWriteConfigField(
  name: string,
  role: string | null | undefined,
): boolean {
  if (role === "convenor") return true;
  if (role !== "collaborator" && role !== "instructor") return false;
  return !isConvenorOnlyConfigField(name);
}
