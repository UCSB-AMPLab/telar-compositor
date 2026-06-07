/**
 * Release acknowledgement API route.
 *
 * Stamps `last_seen_release` on the signed-in user with the current release id
 * so the once-per-release "What's new" modal (see `_app.tsx` loader
 * `needsReleaseNote`) does not show again. Authenticated inline via the session
 * `userId` (same pattern as `api.welcome-ack.tsx`) — resource routes do not sit
 * under the layout's authMiddleware.
 *
 * @version v1.3.0-beta
 */

import { eq } from "drizzle-orm";
import type { Route } from "./+types/api.release-ack";
import { getDb } from "~/lib/db.server";
import { users } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { CURRENT_RELEASE } from "~/lib/release-notes";

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as Env;
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const userId = session.get("userId") as number | undefined;
  if (!userId) return { ok: false };

  const db = getDb(env.DB);
  await db
    .update(users)
    .set({ last_seen_release: CURRENT_RELEASE.id })
    .where(eq(users.id, Number(userId)));

  return { ok: true };
}
