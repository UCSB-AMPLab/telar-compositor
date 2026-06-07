/**
 * Welcome acknowledgement API route.
 *
 * Stamps `welcomed_at` on the signed-in user's membership of the active
 * project, so the one-time "you've been added to a project" landing modal
 * (see `_app.tsx` loader `needsWelcome`) does not show again. Authenticated
 * inline via the session `userId` (the same pattern as `api.locale.tsx`) —
 * resource routes do not sit under the layout's authMiddleware.
 *
 * @version v1.3.0-beta
 */

import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/api.welcome-ack";
import { getDb } from "~/lib/db.server";
import { project_members } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { resolveActiveProject } from "~/lib/membership.server";

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as Env;
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const userId = session.get("userId") as number | undefined;
  if (!userId) return { ok: false };

  const db = getDb(env.DB);
  const sessionActiveId = session.get("activeProjectId") as number | undefined;
  const resolved = await resolveActiveProject(db, Number(userId), sessionActiveId);
  if (!resolved) return { ok: false };

  await db
    .update(project_members)
    .set({ welcomed_at: new Date().toISOString() })
    .where(
      and(
        eq(project_members.project_id, resolved.project.id),
        eq(project_members.user_id, Number(userId)),
      ),
    );

  return { ok: true };
}
