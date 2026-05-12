/**
 * This file tests the `api.locale` action — the endpoint the locale
 * picker POSTs to when a user changes their UI language.
 *
 * Covers the five Referer cases (open-redirect guard):
 *  - cross-origin Referer  -> /signin
 *  - same-origin Referer   -> pathname + search of the Referer
 *  - malformed Referer     -> /signin (no exception)
 *  - non-http(s) Referer   -> /signin
 *  - missing Referer       -> /signin
 *
 * Also covers the auth-aware D1 write:
 *  - authenticated POST writes users.ui_locale to D1, then sets cookie
 *  - authenticated POST with locale=en writes ui_locale="en" (symmetric)
 *  - D1 update throw is swallowed; cookie + redirect still emit
 *  - invalid locale skips the D1 path entirely (validation precedes auth)
 *
 * Mocking strategy: the action depends on `~/lib/db.server` (`getDb`) only on
 * the authenticated branch. We `vi.mock` that module at the boundary so the
 * existing anonymous tests (no `userContext`) never reach D1, and the new
 * authed tests can assert on a chainable `.update().set().where()` spy.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (must be hoisted above the action import)
// ---------------------------------------------------------------------------

const updateWhereSpy = vi.fn();
const updateSetSpy = vi.fn(() => ({ where: updateWhereSpy }));
const updateSpy = vi.fn(() => ({ set: updateSetSpy }));

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    update: updateSpy,
  })),
}));

const sessionGetSpy = vi.fn();
const getSessionSpy = vi.fn().mockResolvedValue({ get: sessionGetSpy });

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: getSessionSpy,
  })),
}));

import { action } from "~/routes/api.locale";
import type { AuthenticatedUser } from "~/middleware/auth.server";

const REQUEST_URL = "http://localhost:5173/api/locale";

/**
 * Build a minimal POST Request to /api/locale with the given Referer
 * header (or none, when `referer` is null) and a `locale` form body.
 */
function buildRequest(referer: string | null, locale: string = "en"): Request {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (referer !== null) {
    headers.set("Referer", referer);
  }
  const body = new URLSearchParams({ locale }).toString();
  return new Request(REQUEST_URL, {
    method: "POST",
    headers,
    body,
  });
}

/**
 * Build a `Route.ActionArgs`-compatible context. The action no longer reads
 * the user from a router context — it resolves the session inline via the
 * cookie. Authed vs anonymous is controlled by `sessionGetSpy`'s return value
 * (see the `withUser` helper).
 */
function makeContext() {
  return {
    get: vi.fn(() => null),
    cloudflare: {
      env: {
        DB: {} as unknown as D1Database,
        SESSION_SECRET: "test-secret",
      },
    },
  };
}

/** Configure the mocked session to return a userId (or none). */
function withUser(opts: { user?: AuthenticatedUser | null } = {}) {
  const user = opts.user ?? null;
  sessionGetSpy.mockReturnValue(user ? user.id : undefined);
}

/** Dispatch the action with the given request + context, returning the Response. */
async function runAction(
  request: Request,
  context: ReturnType<typeof makeContext> = makeContext(),
): Promise<Response> {
  const result = await action({
    request,
    params: {},
    context: context as never,
  } as never);
  return result as Response;
}

/** A redirect status from React Router's `redirect()` helper is 302 or 303. */
function expectRedirectStatus(res: Response): void {
  expect([302, 303]).toContain(res.status);
}

/** Locale cookie should always be present on the response. */
function expectLocaleCookie(res: Response): void {
  const setCookie = res.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  expect(setCookie).toMatch(/locale=/);
}

/** Minimal authenticated-user stub (only id is read by the action). */
function fakeUser(id: number = 42): AuthenticatedUser {
  return { id } as unknown as AuthenticatedUser;
}

beforeEach(() => {
  updateSpy.mockClear();
  updateSetSpy.mockClear();
  updateWhereSpy.mockClear();
  // default success resolution for the .where() leaf
  updateWhereSpy.mockResolvedValue(undefined);
  // default: anonymous (no userId in session)
  sessionGetSpy.mockReset();
  sessionGetSpy.mockReturnValue(undefined);
});

describe("api.locale action — Referer redirect validation", () => {
  it("redirects to /signin when the Referer is cross-origin", async () => {
    const res = await runAction(
      buildRequest("https://evil.example/foo?bar=1"),
    );
    expectRedirectStatus(res);
    expect(res.headers.get("Location")).toBe("/signin");
    expectLocaleCookie(res);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("redirects to the same-origin pathname + search when the Referer matches", async () => {
    const res = await runAction(
      buildRequest("http://localhost:5173/dashboard?tab=stories"),
    );
    expectRedirectStatus(res);
    expect(res.headers.get("Location")).toBe("/dashboard?tab=stories");
    expectLocaleCookie(res);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("redirects to /signin when the Referer is malformed (does not throw)", async () => {
    const res = await runAction(buildRequest("not a url"));
    expectRedirectStatus(res);
    expect(res.headers.get("Location")).toBe("/signin");
    expectLocaleCookie(res);
  });

  it("redirects to /signin when the Referer scheme is not http(s) (e.g. javascript:)", async () => {
    const res = await runAction(buildRequest("javascript:alert(1)"));
    expectRedirectStatus(res);
    expect(res.headers.get("Location")).toBe("/signin");
    expectLocaleCookie(res);
  });

  it("redirects to /signin when no Referer header is present", async () => {
    const res = await runAction(buildRequest(null));
    expectRedirectStatus(res);
    expect(res.headers.get("Location")).toBe("/signin");
    expectLocaleCookie(res);
  });
});

describe("api.locale action — authenticated D1 write", () => {
  it("writes ui_locale='es' to D1 when authenticated, then sets the cookie", async () => {
    withUser({ user: fakeUser(7) });
    const ctx = makeContext();
    const res = await runAction(
      buildRequest("http://localhost:5173/account", "es"),
      ctx,
    );
    expectRedirectStatus(res);
    expect(res.headers.get("Location")).toBe("/account");
    expectLocaleCookie(res);
    // exactly one D1 update with ui_locale: "es"
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(updateSetSpy).toHaveBeenCalledWith({ ui_locale: "es" });
    expect(updateWhereSpy).toHaveBeenCalledTimes(1);
  });

  it("writes ui_locale='en' to D1 when authenticated (symmetric path)", async () => {
    withUser({ user: fakeUser(11) });
    const ctx = makeContext();
    const res = await runAction(
      buildRequest("http://localhost:5173/account", "en"),
      ctx,
    );
    expectRedirectStatus(res);
    expectLocaleCookie(res);
    expect(updateSetSpy).toHaveBeenCalledWith({ ui_locale: "en" });
  });

  it("swallows D1 failures: cookie + redirect still emit when update throws", async () => {
    updateWhereSpy.mockRejectedValueOnce(new Error("D1 down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    withUser({ user: fakeUser(3) });
    const ctx = makeContext();

    const res = await runAction(
      buildRequest("http://localhost:5173/account", "es"),
      ctx,
    );

    expectRedirectStatus(res);
    expect(res.headers.get("Location")).toBe("/account");
    expectLocaleCookie(res);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const firstArg = errSpy.mock.calls[0]?.[0];
    expect(typeof firstArg).toBe("string");
    expect(firstArg as string).toMatch(/^\[api\.locale\]/);

    errSpy.mockRestore();
  });

  it("does NOT touch D1 when the locale is invalid (validation runs before auth branch)", async () => {
    withUser({ user: fakeUser(1) });
    const ctx = makeContext();
    // The action throws redirect('/signin') on invalid locale, which React
    // Router surfaces as a thrown Response. Catch it and assert on the
    // response, then confirm the D1 spy was never called.
    let caught: Response | undefined;
    try {
      await runAction(
        buildRequest("http://localhost:5173/account", "fr"),
        ctx,
      );
    } catch (thrown) {
      caught = thrown as Response;
    }
    expect(caught).toBeInstanceOf(Response);
    expect(caught && [302, 303].includes(caught.status)).toBe(true);
    expect(caught?.headers.get("Location")).toBe("/signin");
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
