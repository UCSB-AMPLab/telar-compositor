/**
 * Coordination helper that keeps a request-side project_config repair from being
 * silently undone by a stale collaboration Y.Doc.
 *
 * The collaboration Durable Object is the only writer to D1 for the entities it
 * owns (config included), reconciling its in-memory Y.Doc to D1 on each snapshot.
 * So when a request path writes one of those columns DIRECTLY to D1 — as
 * onboarding's `fix-site-config` does for url / baseurl / google_sheets_enabled —
 * a DO that still holds the OLD config Y.Map would overwrite the repair on its
 * next snapshot.
 *
 * The fix is to rebuild the Y.Doc from the repaired D1 via the DO's `/reset`
 * route (it clears the yjs_state blob and reloads from D1 rows). We only need to
 * do this when a blob actually exists: with no blob the next editor session cold-
 * starts straight from the repaired D1, so there is nothing to clobber — and we
 * avoid needlessly spinning up the DO during the common first-onboarding flow.
 *
 * Best-effort: a DO outage must never fail the config repair the caller just
 * committed to D1 and the repo. (A residual sub-second race remains if a warm
 * DO's snapshot alarm fires between the D1 write and this /reset; it is
 * negligible for the onboarding-only trigger and shares the broader sync-gate
 * question tracked for the dashboard full-sync path.)
 *
 * @version v1.3.2-beta
 */

import { eq } from "drizzle-orm";
import { projects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";

interface CollabResetEnv {
  SESSION_SECRET: string;
  COLLABORATION: {
    idFromName: (name: string) => unknown;
    get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
  };
}

export async function resetCollabDocIfBlobExists(
  db: ReturnType<typeof getDb>,
  env: CollabResetEnv,
  projectId: number,
): Promise<void> {
  const [row] = await db
    .select({ yjs_state: projects.yjs_state })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  // No live Y.Doc snapshot to diverge — the next cold start builds from the
  // repaired D1 directly.
  if (!row?.yjs_state) return;

  try {
    const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "reset");
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    await stub.fetch(
      new Request("https://internal/reset", { method: "POST", headers }),
    );
  } catch {
    // Best-effort: the D1 repair already succeeded; a DO outage must not flip the
    // user-visible outcome. The next snapshot/reset will reconcile eventually.
  }
}
