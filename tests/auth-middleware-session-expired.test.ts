/**
 * Auth middleware — session-expiry must be a clean logout, not a redirect loop.
 *
 * Regression guard for the production outage where a failed/expired token
 * refresh redirected to /signin?reason=session_expired WITHOUT clearing the
 * session cookie. The still-valid cookie made /signin bounce the user back to
 * an _app route, which failed the refresh again — ERR_TOO_MANY_REDIRECTS.
 *
 * The middleware must attach destroySession to that redirect so the cookie is
 * cleared and /signin renders the sign-in page instead of bouncing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { redirect } from "react-router";

// --- Mocks -----------------------------------------------------------------

const destroySession = vi.fn(async () => "__compositor_session=; Max-Age=0");
const getSession = vi.fn(async () => ({
  get: (key: string) =>
    key === "userId" ? 1 : key === "createdAt" || key === "expires" ? "stamp" : undefined,
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession, destroySession }),
}));

const maybeRefreshToken = vi.fn();
vi.mock("~/lib/auth.server", () => ({
  maybeRefreshToken: (...args: unknown[]) => maybeRefreshToken(...args),
}));

vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 1, github_login: "testuser" }],
        }),
      }),
    }),
  }),
}));

vi.mock("../workers/auth", () => ({
  isSessionLifetimeValid: () => true,
}));

import { authMiddleware } from "~/middleware/auth.server";

// --- Helpers ---------------------------------------------------------------

function makeArgs() {
  return {
    request: new Request("https://compositor.telar.org/dashboard", {
      headers: { Cookie: "__compositor_session=abc" },
    }),
    context: {
      cloudflare: { env: { DB: {}, SESSION_SECRET: "s" } },
      set: vi.fn(),
    },
  } as never;
}

describe("authMiddleware — session expiry", () => {
  beforeEach(() => {
    destroySession.mockClear();
    maybeRefreshToken.mockReset();
  });

  it("re-throws the session_expired redirect WITH a destroySession cookie", async () => {
    maybeRefreshToken.mockRejectedValue(redirect("/signin?reason=session_expired"));

    let thrown: unknown;
    try {
      await authMiddleware(makeArgs(), async () => new Response(null));
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain("session_expired");
    // The fix: the cookie is destroyed so /signin won't bounce the user back.
    expect(destroySession).toHaveBeenCalledOnce();
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("does not swallow non-redirect errors from the refresh", async () => {
    const boom = new Error("network down");
    maybeRefreshToken.mockRejectedValue(boom);

    await expect(
      authMiddleware(makeArgs(), async () => new Response(null)),
    ).rejects.toBe(boom);
    expect(destroySession).not.toHaveBeenCalled();
  });
});
