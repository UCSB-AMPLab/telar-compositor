/**
 * Request-scoped resolution of the caller's active project.
 *
 * Bundles the session-cookie read and the membership-aware project lookup
 * that route loaders and actions otherwise repeat inline: open the session
 * from the request's Cookie header, pull `activeProjectId`, and hand it to
 * `resolveActiveProject` (which verifies membership and falls back to the
 * user's first project when the session id is missing or invalid).
 *
 * Returns the same `{ project, userRole } | null` shape as
 * `resolveActiveProject` — `null` when the user has no project memberships.
 *
 * This helper lives in its own module (not in membership.server.ts) so that
 * tests mocking `~/lib/membership.server` and `~/lib/session.server` at the
 * module boundary continue to intercept the primitives it delegates to.
 *
 * @version v1.4.0-beta
 */

import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { createSessionStorage } from "~/lib/session.server";

export async function resolveActiveProjectFromRequest(
  request: Request,
  env: Env,
  userId: number,
) {
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;
  const db = getDb(env.DB);
  return resolveActiveProject(db, userId, sessionActiveId);
}
