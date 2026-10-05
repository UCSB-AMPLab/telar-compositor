/**
 * The roles that may publish, upload an image, run the `commit-objects`
 * object-write flow, or upgrade — the actions that commit to a project's
 * repository under the GitHub App installation token rather than the
 * acting user's own.
 *
 * Shared, not server-only: the server gate (`membership.server.ts`,
 * `requirePublishingRole`) and every client affordance that shows or hides
 * those four actions (tabs, tiles, dialogs, popovers) import this same
 * module, so which roles can act and which roles merely see the action
 * cannot drift apart. Written as an explicit membership test of
 * `{convenor, collaborator, instructor}` — never "any non-null role" — so
 * a role introduced later is inert until it is named here on purpose, and
 * reaches those actions on neither side before then.
 *
 * Client-safe: no `.server` suffix, no imports of server-only modules.
 *
 * @version v1.5.0-beta
 */

export type ProjectRole = "convenor" | "collaborator" | "instructor";

const PUBLISHING_ROLES: ReadonlySet<ProjectRole> = new Set([
  "convenor",
  "collaborator",
  "instructor",
]);

/**
 * True when `role` is one of the publishing roles (`convenor`,
 * `collaborator` or `instructor`). `null`, `undefined`, and any other value
 * all refuse.
 */
export function isPublishingRole(
  role: ProjectRole | string | null | undefined,
): boolean {
  return role !== null && role !== undefined && PUBLISHING_ROLES.has(role as ProjectRole);
}
