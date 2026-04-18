/**
 * OAuth callback handler.
 *
 * Validates state, exchanges code for tokens, fetches GitHub user,
 * encrypts tokens, upserts user in D1, migrates locale cookie to D1,
 * creates session, redirects to /dashboard.
 */

import { redirect } from "react-router";
import type { Route } from "./+types/_auth.callback";
import { exchangeCodeForTokens, fetchGitHubUser } from "~/lib/auth.server";
import { encrypt } from "~/lib/crypto.server";
import { createSessionStorage, createStateCookieStorage } from "~/lib/session.server";
import { getDb } from "~/lib/db.server";
import { users } from "~/db/schema";
import { eq } from "drizzle-orm";

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

  // Detect locale from cookie (migrated to D1 on first sign-in)
  const localeCookieHeader = request.headers.get("Cookie") ?? "";
  const localeMatch = localeCookieHeader.match(/locale=([a-z]{2})/);
  const cookieLocale = localeMatch ? localeMatch[1] : null;
  const languagePreference = cookieLocale ?? "en";

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
    // Insert new user — migrate locale cookie preference to D1
    const [newUser] = await db
      .insert(users)
      .values({
        github_id: githubUser.id,
        github_login: githubUser.login,
        github_name: githubUser.name,
        github_email: githubUser.email,
        github_plan: githubUser.plan,
        encrypted_access_token: encAccessToken,
        encrypted_refresh_token: encRefreshToken,
        access_token_expires_at: accessTokenExpiresAt,
        refresh_token_expires_at: refreshTokenExpiresAt,
        language_preference: languagePreference,
      })
      .returning({ id: users.id });
    userId = newUser.id;
  }

  // Create authenticated session
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession();
  session.set("userId", userId);

  // Support post-OAuth redirect to the page that triggered sign-in (e.g. invite accept)
  const returnTo = stateSession.get("returnTo") as string | undefined;
  const safeRedirect =
    returnTo && returnTo.startsWith("/") && !returnTo.includes("//")
      ? returnTo
      : "/dashboard";

  const headers = new Headers();
  headers.append("Set-Cookie", await sessionStorage.commitSession(session));
  // Clear the OAuth state cookie
  headers.append(
    "Set-Cookie",
    await stateCookieStorage.destroySession(stateSession),
  );

  return redirect(safeRedirect, { headers });
}
