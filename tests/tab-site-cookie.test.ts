/**
 * The site a reloaded tab hands to its document request: the server
 * reads `telar_tab_site` for a document request before the session's site, so
 * the role guard and every loader resolve the tab's site rather than the site
 * another tab switched to.
 *
 * @version v1.5.0-beta
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveActiveProject: vi.fn(),
  getUserRole: vi.fn(),
}));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));
vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(async () => []), orderBy: vi.fn(async () => []) })),
      })),
    })),
  })),
}));
// The session names site 11, as it does after another tab switched to it.
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn((key: string) => (key === "activeProjectId" ? 11 : undefined)) })),
    commitSession: vi.fn(async () => ""),
  })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: mocks.resolveActiveProject,
  requireProjectMember: vi.fn(),
  getUserRole: mocks.getUserRole,
  getUserProjects: vi.fn(async () => []),
  getPresenceColor: vi.fn(async () => null),
}));

import { readTabSite } from "~/lib/tab-site";
import { isHandoffSite, siteHint } from "~/lib/active-project.server";
import { handoffRedirectMiddleware, retryWithoutHandoff } from "~/middleware/handoff.server";

function cookieTestContext(userId: number) {
  return {
    get: () => ({ id: userId, github_login: "tester" }),
    cloudflare: { env: { DB: {}, SESSION_SECRET: "s", ENCRYPTION_KEY: "k" } },
  } as unknown as Parameters<never>[0];
}

async function redirectOf(loader: (a: unknown) => unknown, arg: unknown): Promise<Response | null> {
  try {
    await loader(arg);
    return null;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function pageRequest(path: string, headers: Record<string, string>): Request {
  return new Request(`https://stage.test${path}`, { headers });
}

const DOCUMENT = { "Sec-Fetch-Dest": "document", Cookie: "telar_tab_site=42:%2Fupgrade; other=1" };

/** A request to `path`, as `readTabSite` reads it. */
function requestAt(headers: Record<string, string>, path = "/upgrade") {
  return { headers: new Headers(headers), url: `https://stage.test${path}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Site 42: the tab's; the user is a convenor there and holds no role on 11.
  mocks.resolveActiveProject.mockImplementation(async (_db: unknown, _u: number, id: number) => ({
    project: { id, github_repo_full_name: `owner/site-${id}` },
  }));
  mocks.getUserRole.mockImplementation(async (_db: unknown, projectId: number) => (projectId === 42 ? "convenor" : null));
});

describe("readTabSite for a document request", () => {
  it("reads the hand-off cookie", () => {
    expect(readTabSite(requestAt(DOCUMENT))).toBe(42);
  });

  it("accepts a document request from a browser that sends no Sec-Fetch-Dest, by its Accept", () => {
    expect(readTabSite(requestAt({ Accept: "text/html,application/xhtml+xml", Cookie: "telar_tab_site=42:%2Fupgrade" }))).toBe(42);
  });

  it("ignores the cookie for a fetch, which names its site by header", () => {
    expect(readTabSite(requestAt({ "Sec-Fetch-Dest": "empty", Cookie: "telar_tab_site=42:%2Fupgrade" }))).toBeUndefined();
    expect(readTabSite(requestAt({ Accept: "text/x-script", Cookie: "telar_tab_site=42:%2Fupgrade" }))).toBeUndefined();
  });

  it("prefers the header to the cookie", () => {
    expect(readTabSite(requestAt({ ...DOCUMENT, "X-Telar-Site": "7" }))).toBe(7);
  });

  it("gives a fresh tab at another path nothing, and a reload of the same path the site", () => {
    const cookie = { "Sec-Fetch-Dest": "document", Cookie: "telar_tab_site=42:%2Fobjects%2Fsome%2520page" };
    expect(readTabSite(requestAt(cookie, "/publish"))).toBeUndefined();
    expect(readTabSite(requestAt(cookie, "/objects"))).toBeUndefined();
    expect(readTabSite(requestAt(cookie, "/objects/some%20page"))).toBe(42);
  });

  it.each(["telar_tab_site=", "telar_tab_site=0:%2Fupgrade", "telar_tab_site=4x:%2Fupgrade", "telar_tab_site=-1:%2Fupgrade", "xtelar_tab_site=42:%2Fupgrade", "telar_tab_site=42", "telar_tab_site=42:%E0%A4%A"])(
    "ignores the malformed or foreign cookie %j",
    (cookie) => {
      expect(readTabSite(requestAt({ "Sec-Fetch-Dest": "document", Cookie: cookie }))).toBeUndefined();
    },
  );
});

describe("the _app loader's role guard, on a document request", () => {
  it("guards the tab's site, not the session's: no redirect where the tab's role admits the page", async () => {
    const { loader } = await import("../app/routes/_app");
    const res = await redirectOf(loader as never, {
      request: pageRequest("/upgrade", DOCUMENT),
      context: cookieTestContext(7),
    });
    expect(res).toBeNull();
    expect(mocks.resolveActiveProject).toHaveBeenCalledWith(expect.anything(), 7, 42);
  });

  it("without the cookie the session's site is guarded, and its missing role redirects", async () => {
    const { loader } = await import("../app/routes/_app");
    const res = await redirectOf(loader as never, {
      request: pageRequest("/upgrade", { "Sec-Fetch-Dest": "document" }),
      context: cookieTestContext(7),
    });
    expect(res?.headers.get("Location")).toBe("/objects?denied=upgrade");
  });

  // The loader itself redirects under the hand-off; the middleware retries it.
  it("redirects where the tab's own site refuses the page, leaving the retry to the middleware", async () => {
    mocks.getUserRole.mockResolvedValue(null);
    const { loader } = await import("../app/routes/_app");
    const res = await redirectOf(loader as never, {
      request: pageRequest("/upgrade", DOCUMENT),
      context: cookieTestContext(7),
    });
    expect(res?.headers.get("Location")).toBe("/objects?denied=upgrade");
    expect(mocks.resolveActiveProject).toHaveBeenCalledWith(expect.anything(), 7, 42);
  });

  it("does not let a fetch's stale cookie steer it", async () => {
    const { loader } = await import("../app/routes/_app");
    const res = await redirectOf(loader as never, {
      request: pageRequest("/upgrade", { "Sec-Fetch-Dest": "empty", Cookie: "telar_tab_site=42:%2Fupgrade" }),
      context: cookieTestContext(7),
    });
    expect(res?.headers.get("Location")).toBe("/objects?denied=upgrade");
  });
});

describe("the hand-off is a hint every loader reads alike", () => {
  const hintFor = (headers: Record<string, string>) =>
    siteHint(new Request("https://stage.test/upgrade", { headers }), 11);

  it("names the hand-off's site, and reports it", () => {
    expect(hintFor(DOCUMENT)).toEqual({ siteId: 42, handoffSite: 42 });
  });

  it("falls back to the session's site, naming no hand-off, for a header request or no cookie", () => {
    expect(hintFor({ "Sec-Fetch-Dest": "empty", "X-Telar-Site": "42" })).toEqual({ siteId: 42, handoffSite: undefined });
    expect(hintFor({ "Sec-Fetch-Dest": "document" })).toEqual({ siteId: 11, handoffSite: undefined });
  });

  it("reports the site a render resolved as the hand-off's only when it is", () => {
    expect(isHandoffSite(42, 42)).toBe(true);
    expect(isHandoffSite(42, 11)).toBe(false);
    expect(isHandoffSite(42, null)).toBe(false);
    expect(isHandoffSite(undefined, 42)).toBe(false);
  });
});

describe("the _app loader's site selection", () => {
  async function layoutData(path: string, headers: Record<string, string>) {
    const { loader } = await import("../app/routes/_app");
    return (await (loader as (a: unknown) => unknown)({
      request: pageRequest(path, headers),
      context: cookieTestContext(7),
    })) as { activeProjectId: number | null; siteFromHandoff: boolean };
  }

  beforeEach(() => {
    mocks.getUserRole.mockResolvedValue("convenor");
  });

  it("resolves the hand-off's site and says so, on a document request that carries it", async () => {
    const data = await layoutData("/upgrade", DOCUMENT);
    expect(data.activeProjectId).toBe(42);
    expect(data.siteFromHandoff).toBe(true);
  });

  it("resolves the session's site, not from the hand-off, without the cookie", async () => {
    const data = await layoutData("/upgrade", { "Sec-Fetch-Dest": "document" });
    expect(data.activeProjectId).toBe(11);
    expect(data.siteFromHandoff).toBe(false);
  });

  it("resolves the header's site, not from the hand-off, for a fetch", async () => {
    const data = await layoutData("/upgrade", { "Sec-Fetch-Dest": "empty", "X-Telar-Site": "42", Cookie: "telar_tab_site=42:%2Fupgrade" });
    expect(data.activeProjectId).toBe(42);
    expect(data.siteFromHandoff).toBe(false);
  });
});

describe("a redirect answered under the hand-off is retried without it", () => {
  const CLEARED = "telar_tab_site=; Max-Age=0; Path=/publish; SameSite=Lax; Secure";
  const publishAt = (headers: Record<string, string>, method = "GET") =>
    new Request("https://stage.test/publish?from=nav", { method, headers });
  const HANDOFF_ON_PUBLISH = { "Sec-Fetch-Dest": "document", Cookie: "telar_tab_site=42:%2Fpublish" };
  const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });

  it("replaces a redirect with one to the same address that clears the cookie", () => {
    const retry = retryWithoutHandoff(publishAt(HANDOFF_ON_PUBLISH), redirectTo("/upgrade"))!;
    expect(retry.status).toBe(302);
    expect(retry.headers.get("Location")).toBe("/publish?from=nav");
    expect(retry.headers.getSetCookie()).toEqual([CLEARED]);
  });

  it("keeps a cookie the replaced redirect set", () => {
    const original = new Response(null, { status: 302, headers: { Location: "/signin", "Set-Cookie": "session=; Max-Age=0" } });
    expect(retryWithoutHandoff(publishAt(HANDOFF_ON_PUBLISH), original)!.headers.getSetCookie()).toEqual([CLEARED, "session=; Max-Age=0"]);
  });

  it.each([301, 302, 303, 307, 308])("treats a %i as a redirect", (status) => {
    expect(retryWithoutHandoff(publishAt(HANDOFF_ON_PUBLISH), redirectTo("/x", status))).not.toBeNull();
  });

  it("leaves a page that renders alone", () => {
    expect(retryWithoutHandoff(publishAt(HANDOFF_ON_PUBLISH), new Response("page", { status: 200 }))).toBeNull();
    expect(retryWithoutHandoff(publishAt(HANDOFF_ON_PUBLISH), new Response("gone", { status: 404 }))).toBeNull();
  });

  it("leaves a redirect alone when the request carried no hand-off, or is not a document GET", () => {
    expect(retryWithoutHandoff(publishAt({ "Sec-Fetch-Dest": "document" }), redirectTo("/upgrade"))).toBeNull();
    expect(retryWithoutHandoff(publishAt({ "Sec-Fetch-Dest": "empty", Cookie: "telar_tab_site=42:%2Fpublish" }), redirectTo("/upgrade"))).toBeNull();
    expect(retryWithoutHandoff(publishAt(HANDOFF_ON_PUBLISH, "POST"), redirectTo("/upgrade"))).toBeNull();
    // A hand-off written for another path is not honoured, so nothing is retried.
    expect(retryWithoutHandoff(publishAt({ "Sec-Fetch-Dest": "document", Cookie: "telar_tab_site=42:%2Fobjects" }), redirectTo("/upgrade"))).toBeNull();
  });

  it("as middleware, catches a redirect the route returns or throws, and passes a page and a plain redirect through", async () => {
    const run = (request: Request, next: () => Promise<unknown>) => handoffRedirectMiddleware({ request } as never, next as never) as Promise<Response>;
    const returned = await run(publishAt(HANDOFF_ON_PUBLISH), async () => redirectTo("/upgrade"));
    expect(returned.headers.get("Location")).toBe("/publish?from=nav");
    const thrown = await run(publishAt(HANDOFF_ON_PUBLISH), async () => {
      throw redirectTo("/upgrade");
    });
    expect(thrown.headers.get("Location")).toBe("/publish?from=nav");
    const page = new Response("page");
    expect(await run(publishAt(HANDOFF_ON_PUBLISH), async () => page)).toBe(page);
    const plain = redirectTo("/upgrade");
    expect(await run(publishAt({ "Sec-Fetch-Dest": "document" }), async () => plain)).toBe(plain);
    const failure = new Error("boom");
    await expect(run(publishAt(HANDOFF_ON_PUBLISH), async () => Promise.reject(failure))).rejects.toBe(failure);
  });

  // The loop: the hand-off's site sits behind the release, so /publish
  // redirects to /upgrade; there the path-scoped cookie is absent, the session's
  // site resolves, and sends the request back to /publish.
  it("ends after one retry on the session's site, where the request would redirect forever", async () => {
    const handoffSiteBehind = (request: Request) => (readTabSite(request) === 42 ? "/upgrade" : null);
    const sessionSiteAtUpgrade = (request: Request) => (new URL(request.url).pathname === "/upgrade" ? "/publish" : null);
    let request = publishAt(HANDOFF_ON_PUBLISH);
    const hops: string[] = [];
    for (let i = 0; i < 6; i++) {
      const to = handoffSiteBehind(request) ?? sessionSiteAtUpgrade(request);
      if (to === null) break;
      const answered = redirectTo(to);
      const retry = retryWithoutHandoff(request, answered);
      const next = retry ?? answered;
      hops.push(next.headers.get("Location")!);
      const location = new URL(next.headers.get("Location")!, "https://stage.test");
      // The browser follows: the hand-off cookie is sent only where it is still set.
      const cleared = retry !== null;
      request = new Request(location, {
        headers: { "Sec-Fetch-Dest": "document", ...(cleared ? {} : { Cookie: request.headers.get("Cookie") ?? "" }) },
      });
    }
    // The first answer is retried to /publish without the cookie; the session's
    // site then renders /publish (no redirect from either rule), and the loop ends.
    expect(hops).toEqual(["/publish?from=nav"]);
  });

  it("retries the real loader's role-guard redirect without the hand-off, and the session's site then renders the page", async () => {
    // The hand-off's site 42 holds no role; the session's site 11 admits /upgrade.
    mocks.getUserRole.mockImplementation(async (_db: unknown, projectId: number) => (projectId === 11 ? "convenor" : null));
    const { loader } = await import("../app/routes/_app");
    const handoffRequest = pageRequest("/upgrade", DOCUMENT);
    const bounce = await redirectOf(loader as never, { request: handoffRequest, context: cookieTestContext(7) });
    expect(bounce?.headers.get("Location")).toBe("/objects?denied=upgrade");

    const retry = retryWithoutHandoff(handoffRequest, bounce!)!;
    expect(retry.headers.get("Location")).toBe("/upgrade");
    expect(retry.headers.getSetCookie()[0]).toContain("telar_tab_site=; Max-Age=0; Path=/upgrade");

    // The browser follows it with no hand-off.
    const retried = pageRequest("/upgrade", { "Sec-Fetch-Dest": "document" });
    expect(await redirectOf(loader as never, { request: retried, context: cookieTestContext(7) })).toBeNull();
    expect(mocks.resolveActiveProject).toHaveBeenLastCalledWith(expect.anything(), 7, 11);
  });

  // The middleware runs on every _app route only if the layout lists it (text check).
  it("is listed on the _app layout after the auth middleware (text check)", () => {
    const source = readFileSync(join(__dirname, "../app/routes/_app.tsx"), "utf8");
    expect(source).toContain("export const middleware = [authMiddleware, handoffRedirectMiddleware];");
  });
});
