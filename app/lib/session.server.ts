/**
 * Cookie session storage for Telar Compositor.
 *
 * Two cookies:
 *   - sessionStorage: main user session (httpOnly, 7-day maxAge, stores userId)
 *   - stateCookieStorage: OAuth state (httpOnly, 10-min maxAge, stores oauth_state)
 *
 * Both use SameSite=Lax — Strict would break the OAuth callback (cross-site redirect).
 */

import {
  createCookieSessionStorage,
} from "react-router";

/**
 * Factory — takes SESSION_SECRET at runtime rather than module level
 * so the binding is available (Cloudflare Workers don't have env at import time).
 */
export function createSessionStorage(secret: string) {
  return createCookieSessionStorage({
    cookie: {
      name: "__compositor_session",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      secrets: [secret],
    },
  });
}

export function createStateCookieStorage(secret: string) {
  return createCookieSessionStorage({
    cookie: {
      name: "__compositor_oauth_state",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60 * 10, // 10 minutes
      secrets: [secret],
    },
  });
}

