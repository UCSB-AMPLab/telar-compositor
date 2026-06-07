/**
 * Auth guard middleware for _app layout.
 *
 * - No session → redirect to /signin.
 * - User not found in D1 → destroy session, redirect to /signin.
 * - Token near expiry → auto-refresh before setting context.
 * - Sets authenticated user on context via userContext RouterContext key.
 */

import { redirect, createContext } from "react-router";
import type { MiddlewareFunction } from "react-router";
import { createSessionStorage } from "~/lib/session.server";
import { maybeRefreshToken } from "~/lib/auth.server";
import { getDb } from "~/lib/db.server";
import { users } from "~/db/schema";
import { eq } from "drizzle-orm";
import { isSessionLifetimeValid } from "../../workers/auth";

export type AuthenticatedUser = typeof users.$inferSelect;

/** Type-safe context key for the authenticated user */
export const userContext = createContext<AuthenticatedUser | null>(null);

export const authMiddleware: MiddlewareFunction = async ({ request, context }, next) => {
  const env = context.cloudflare.env as Env;
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const userId = session.get("userId") as number | undefined;

  if (!userId) {
    throw redirect("/signin");
  }

  // Enforce the server-side session lifetime on the HTTP path too, using the
  // SAME guard the websocket auth applies (workers/auth.ts). A token with no
  // enforceable lifetime (legacy cookies minted before createdAt was stamped)
  // or one past its 7-day window gets a clean logout here — rather than staying
  // authenticated over HTTP while the collaboration socket silently rejects it.
  const createdAt = session.get("createdAt") as string | undefined;
  const expires = session.get("expires") as string | undefined;
  if (!isSessionLifetimeValid(createdAt, expires)) {
    throw redirect("/signin", {
      headers: {
        "Set-Cookie": await sessionStorage.destroySession(session),
      },
    });
  }

  const db = getDb(env.DB);
  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, Number(userId)))
    .limit(1);

  if (userRows.length === 0) {
    throw redirect("/signin", {
      headers: {
        "Set-Cookie": await sessionStorage.destroySession(session),
      },
    });
  }

  // Auto-refresh token if near expiry (throws redirect on expired refresh token)
  const refreshedUser = await maybeRefreshToken(userRows[0], env);

  // Set user on context for child loaders/actions
  context.set(userContext, refreshedUser);

  return next();
};
