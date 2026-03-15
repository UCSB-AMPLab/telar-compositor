/**
 * GitHub OAuth token exchange, refresh, and user fetch utilities.
 *
 * All tokens are kept encrypted — callers receive/return raw strings but
 * this module handles the encrypt/decrypt boundary when communicating with
 * D1. Refresh token expiry triggers a redirect to /signin?reason=session_expired.
 */

import { redirect } from "react-router";
import { encrypt, decrypt } from "~/lib/crypto.server";
import { getDb } from "~/lib/db.server";
import { users } from "~/db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
  token_type: string;
  scope: string;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

// 30-minute threshold — refresh if token expires within this window
const REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchanges a GitHub OAuth code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(
  code: string,
  env: Env,
): Promise<GitHubTokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_CALLBACK_URL,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as GitHubTokenResponse & {
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error} — ${data.error_description}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Checks if the user's access token is near expiry and refreshes if needed.
 *
 * - Token still valid (>30 min): returns user unchanged, no DB write.
 * - Token near expiry (<=30 min): decrypts refresh token, calls GitHub
 *   refresh endpoint, encrypts new tokens, updates D1, returns updated user.
 * - Refresh token expired: throws redirect to /signin?reason=session_expired.
 */
export async function maybeRefreshToken(
  user: typeof users.$inferSelect,
  env: Env,
): Promise<typeof users.$inferSelect> {
  const expiresAt = new Date(user.access_token_expires_at).getTime();
  const now = Date.now();

  // Token is still valid — no refresh needed
  if (expiresAt - now > REFRESH_THRESHOLD_MS) {
    return user;
  }

  // Check if refresh token itself is expired
  const refreshExpiresAt = new Date(user.refresh_token_expires_at).getTime();
  if (refreshExpiresAt <= now) {
    throw redirect("/signin?reason=session_expired");
  }

  // Decrypt refresh token and call GitHub refresh endpoint
  let rawRefreshToken: string;
  try {
    rawRefreshToken = await decrypt(user.encrypted_refresh_token, env.ENCRYPTION_KEY);
  } catch {
    throw redirect("/signin?reason=session_expired");
  }

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: rawRefreshToken,
  });

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    throw redirect("/signin?reason=session_expired");
  }

  const data = (await response.json()) as GitHubTokenResponse & {
    error?: string;
  };

  if (data.error) {
    throw redirect("/signin?reason=session_expired");
  }

  // Encrypt new tokens and persist to D1
  const [newEncAccessToken, newEncRefreshToken] = await Promise.all([
    encrypt(data.access_token, env.ENCRYPTION_KEY),
    encrypt(data.refresh_token, env.ENCRYPTION_KEY),
  ]);

  const newAccessExpiresAt = new Date(now + data.expires_in * 1000).toISOString();
  const newRefreshExpiresAt = new Date(
    now + data.refresh_token_expires_in * 1000,
  ).toISOString();

  const db = getDb(env.DB);
  const [updatedUser] = await db
    .update(users)
    .set({
      encrypted_access_token: newEncAccessToken,
      encrypted_refresh_token: newEncRefreshToken,
      access_token_expires_at: newAccessExpiresAt,
      refresh_token_expires_at: newRefreshExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .where(eq(users.id, user.id))
    .returning();

  return updatedUser;
}

// ---------------------------------------------------------------------------
// GitHub user info
// ---------------------------------------------------------------------------

/**
 * Fetches the authenticated user's profile from the GitHub API.
 */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Telar-Compositor/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
  };

  return {
    id: data.id,
    login: data.login,
    name: data.name,
    email: data.email,
  };
}
