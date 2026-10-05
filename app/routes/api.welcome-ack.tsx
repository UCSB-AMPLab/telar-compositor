/**
 * Welcome acknowledgement API route.
 *
 * Stamps `welcomed_at` on the signed-in user's membership of the active
 * project, so the one-time "you've been added to a project" landing modal
 * (see `_app.tsx` loader `needsWelcome`) does not show again. Authenticated
 * inline via the session `userId` (the same pattern as `api.locale.tsx`) —
 * resource routes do not sit under the layout's authMiddleware.
 *
 * The stamp is for the site the page showed the modal on, which the form names
 * (`siteId`), whichever site the session names. It touches only the caller's
 * own membership row, so no standing beyond membership is needed, and a site
 * the caller is not a member of stamps nothing.
 *
 * @version v1.5.0-beta
 */

import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/api.welcome-ack";
import { getDb } from "~/lib/db.server";
import { project_members } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as Env;
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const userId = session.get("userId") as number | undefined;
  if (!userId) return { ok: false };

  const formData = await request.formData();
  const siteId = Number(formData.get("siteId"));
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return { ok: false };

  const db = getDb(env.DB);
  await db
    .update(project_members)
    .set({ welcomed_at: new Date().toISOString() })
    .where(
      and(
        eq(project_members.project_id, siteId),
        eq(project_members.user_id, Number(userId)),
      ),
    );

  return { ok: true };
}
