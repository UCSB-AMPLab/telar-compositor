/**
 * This file handles the OAuth callback — the route GitHub redirects
 * back to after the user authorises the compositor's GitHub App.
 *
 * Validates the CSRF state, exchanges the code for access + refresh
 * tokens, fetches the GitHub user, encrypts the tokens, upserts the
 * user row in D1, hydrates the locale cookie from `users.ui_locale`
 * (D1 is the cross-browser source of truth for language), creates
 * the session, and redirects to /dashboard.
 *
 * @version v1.3.0-beta
 */

import { redirect } from "react-router";
import type { Route } from "./+types/_auth.callback";
import { exchangeCodeForTokens, fetchGitHubUser } from "~/lib/auth.server";
import { encrypt } from "~/lib/crypto.server";
import { createSessionStorage, createStateCookieStorage } from "~/lib/session.server";
import { getDb } from "~/lib/db.server";
import { users } from "~/db/schema";
import { eq } from "drizzle-orm";
import { localeCookie } from "~/i18n/i18next.server";
import { CURRENT_RELEASE } from "~/lib/release-notes";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as Env;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const receivedState = url.searchParams.get("state");

  // GitHub App installation redirects here with setup_action=install but no
  // OAuth code/state — just redirect to dashboard (or sign-in if not authed).
  const setupAction = url.searchParams.get("setup_action");
  if (setupAction === "install") {
    return redirect("/dashboard");
  }

  // Validate required params
  if (!code || !receivedState) {
    return new Response("Missing code or state", { status: 400 });
  }

  // Validate CSRF state against cookie
  const stateCookieStorage = createStateCookieStorage(env.SESSION_SECRET);
  const stateSession = await stateCookieStorage.getSession(
    request.headers.get("Cookie"),
  );
  const storedState = stateSession.get("oauth_state");

  if (!storedState || storedState !== receivedState) {
    return new Response("Invalid state", { status: 403 });
  }

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(code, env);
  const githubUser = await fetchGitHubUser(tokens.access_token);

  // Encrypt tokens before storing in D1
  const now = Date.now();
  const [encAccessToken, encRefreshToken] = await Promise.all([
    encrypt(tokens.access_token, env.ENCRYPTION_KEY),
    encrypt(tokens.refresh_token, env.ENCRYPTION_KEY),
  ]);

  const accessTokenExpiresAt = new Date(now + tokens.expires_in * 1000).toISOString();
  const refreshTokenExpiresAt = new Date(
    now + tokens.refresh_token_expires_in * 1000,
  ).toISOString();

  // Upsert user in D1
  const db = getDb(env.DB);

  const existingUsers = await db
    .select()
    .from(users)
    .where(eq(users.github_id, githubUser.id))
    .limit(1);

  let userId: number;

  if (existingUsers.length > 0) {
    // Update existing user's tokens and metadata
    await db
      .update(users)
      .set({
        github_login: githubUser.login,
        github_name: githubUser.name,
        github_email: githubUser.email,
        github_plan: githubUser.plan,
        encrypted_access_token: encAccessToken,
        encrypted_refresh_token: encRefreshToken,
        access_token_expires_at: accessTokenExpiresAt,
        refresh_token_expires_at: refreshTokenExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .where(eq(users.github_id, githubUser.id));
    userId = existingUsers[0].id;
  } else {
    // Insert new user
    const [newUser] = await db
      .insert(users)
      .values({
        github_id: githubUser.id,
        github_login: githubUser.login,
        github_name: githubUser.name,
        github_email: githubUser.email,
        github_plan: githubUser.plan,
        last_seen_release: CURRENT_RELEASE.id,
        encrypted_access_token: encAccessToken,
        encrypted_refresh_token: encRefreshToken,
        access_token_expires_at: accessTokenExpiresAt,
        refresh_token_expires_at: refreshTokenExpiresAt,
      })
      .returning({ id: users.id });
    userId = newUser.id;
  }

  // Create authenticated session
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession();
  session.set("userId", userId);
  // Stamp the session creation time so the server-side lifetime guard
  // (isSessionLifetimeValid, enforced on both the HTTP and websocket auth
  // paths) can bound this token to the 7-day window. Without it the token has
  // no server-enforceable lifetime and a copied cookie would live forever.
  session.set("createdAt", new Date().toISOString());

  // Hydrate locale cookie from D1 — D1 is the cross-browser source of truth.
  // If ui_locale is set, override any incoming cookie; if null, leave it alone.
  const userRowAfterUpsert = await db
    .select({ ui_locale: users.ui_locale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const uiLocale = userRowAfterUpsert[0]?.ui_locale ?? null;

  // Support post-OAuth redirect to the page that triggered sign-in (e.g. invite accept)
  const returnTo = stateSession.get("returnTo") as string | undefined;
  const safeRedirect =
    returnTo && returnTo.startsWith("/") && !returnTo.includes("//")
      ? returnTo
      : "/dashboard";

  const headers = new Headers();
  headers.append("Set-Cookie", await sessionStorage.commitSession(session));
  // Hydrate locale cookie from D1 when set; leave cookie untouched when null.
  if (uiLocale) {
    headers.append("Set-Cookie", await localeCookie.serialize(uiLocale));
  }
  // Clear the OAuth state cookie
  headers.append(
    "Set-Cookie",
    await stateCookieStorage.destroySession(stateSession),
  );

  return redirect(safeRedirect, { headers });
}
