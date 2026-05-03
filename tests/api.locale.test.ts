/**
 * Tests for the api.locale action — open-redirect guard.
 *
 * Covers the five Referer cases in the per-task plan:
 *  - cross-origin Referer  -> /signin
 *  - same-origin Referer   -> pathname + search of the Referer
 *  - malformed Referer     -> /signin (no exception)
 *  - non-http(s) Referer   -> /signin
 *  - missing Referer       -> /signin
 *
 * Every case must still emit the locale cookie on the response.
 *
 * The action only depends on `react-router`'s `redirect` helper and
 * the `localeCookie` from `~/i18n/i18next.server`; both are pure and
 * runnable under the node vitest environment, so no module mocks are
 * needed.
 */

import { describe, it, expect } from "vitest";
import { action } from "~/routes/api.locale";

const REQUEST_URL = "http://localhost:5173/api/locale";

/**
 * Build a minimal POST Request to /api/locale with the given Referer
 * header (or none, when `referer` is null) and a `locale=en` form body.
 */
function buildRequest(referer: string | null, locale = "en"): Request {
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

/** Dispatch the action with the given request and return the Response. */
async function runAction(request: Request): Promise<Response> {
  const result = await action({
    request,
    params: {},
    context: {} as never,
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

describe("api.locale action — Referer redirect validation", () => {
  it("redirects to /signin when the Referer is cross-origin", async () => {
    const res = await runAction(
      buildRequest("https://evil.example/foo?bar=1"),
    );
    expectRedirectStatus(res);
    expect(res.headers.get("Location")).toBe("/signin");
    expectLocaleCookie(res);
  });

  it("redirects to the same-origin pathname + search when the Referer matches", async () => {
    const res = await runAction(
      buildRequest("http://localhost:5173/dashboard?tab=stories"),
    );
    expectRedirectStatus(res);
    expect(res.headers.get("Location")).toBe("/dashboard?tab=stories");
    expectLocaleCookie(res);
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
