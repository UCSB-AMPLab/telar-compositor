/**
 * Unit coverage for resolveActiveProjectFromRequest — the request-scoped
 * wrapper that route loaders/actions call instead of repeating the
 * session-read + membership-lookup idiom inline.
 *
 * Strategy: mock the three primitives it delegates to (createSessionStorage,
 * getDb, resolveActiveProject) at the module boundary and assert the wiring —
 * that the Cookie header feeds the session, `activeProjectId` feeds
 * resolveActiveProject, the userId passes through, and the result is returned
 * verbatim. This is exactly the boundary the objects/stories action tests
 * mock, so the wrapper's real code runs against their mocks unchanged.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getSession = vi.fn((_cookie: string | null): unknown => undefined);
const createSessionStorage = vi.fn((_secret: string) => ({ getSession }));
const getDb = vi.fn((_d1: unknown): unknown => undefined);
const resolveActiveProject = vi.fn(
  (_db: unknown, _userId: number, _sessionActiveId: number | undefined): unknown =>
    undefined,
);

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: (secret: string) => createSessionStorage(secret),
}));
vi.mock("~/lib/db.server", () => ({
  getDb: (d1: unknown) => getDb(d1),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: (
    db: unknown,
    userId: number,
    sessionActiveId: number | undefined,
  ) => resolveActiveProject(db, userId, sessionActiveId),
}));

import { resolveActiveProjectFromRequest, resolvePageProject } from "~/lib/active-project.server";

const SENTINEL_DB = { __db: true };

function buildRequest(cookie: string | null): Request {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.Cookie = cookie;
  return new Request("https://compositor.telar.org/objects", { headers });
}

function fakeEnv(): Env {
  return { SESSION_SECRET: "sess-secret", DB: { __d1: true } } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  getDb.mockReturnValue(SENTINEL_DB);
  getSession.mockResolvedValue({ get: vi.fn(() => 42) });
});

describe("resolveActiveProjectFromRequest", () => {
  it("threads the cookie → activeProjectId → resolveActiveProject and returns its result", async () => {
    const resolvedValue = {
      project: { id: 42 },
      userRole: "convenor" as const,
    };
    resolveActiveProject.mockResolvedValue(resolvedValue);

    const env = fakeEnv();
    const result = await resolveActiveProjectFromRequest(
      buildRequest("__compositor_session=abc"),
      env,
      7,
    );

    // Session storage created from the env secret.
    expect(createSessionStorage).toHaveBeenCalledWith("sess-secret");
    // Session opened from the request's Cookie header.
    expect(getSession).toHaveBeenCalledWith("__compositor_session=abc");
    // Membership lookup receives the db, the userId, and the session's activeProjectId.
    expect(resolveActiveProject).toHaveBeenCalledWith(SENTINEL_DB, 7, 42);
    expect(getDb).toHaveBeenCalledWith(env.DB);
    // Result is returned verbatim.
    expect(result).toBe(resolvedValue);
  });

  it("passes a missing activeProjectId through as undefined", async () => {
    getSession.mockResolvedValue({ get: vi.fn(() => undefined) });
    resolveActiveProject.mockResolvedValue(null);

    const result = await resolveActiveProjectFromRequest(
      buildRequest(null),
      fakeEnv(),
      99,
    );

    expect(getSession).toHaveBeenCalledWith(null);
    expect(resolveActiveProject).toHaveBeenCalledWith(SENTINEL_DB, 99, undefined);
    // Propagates the no-membership null.
    expect(result).toBeNull();
  });
});

describe("resolvePageProject", () => {
  const project = { id: 42, github_repo_full_name: "owner/site-b" };

  function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }

  it("resolves the session's project when the page posted the same site", async () => {
    resolveActiveProject.mockResolvedValue({ project, userRole: "convenor" });
    const result = await resolvePageProject(buildRequest("c=1"), fakeEnv(), 7, form({ siteId: "42" }));
    expect(result).toEqual({ kind: "ok", project, userRole: "convenor" });
  });

  it("refuses when the page showed a different site, naming the session's", async () => {
    resolveActiveProject.mockResolvedValue({ project, userRole: "convenor" });
    const result = await resolvePageProject(buildRequest("c=1"), fakeEnv(), 7, form({ siteId: "41" }));
    expect(result).toEqual({ kind: "site_changed", currentSiteName: "owner/site-b" });
  });

  it("refuses a form that names no site", async () => {
    resolveActiveProject.mockResolvedValue({ project, userRole: "collaborator" });
    const result = await resolvePageProject(buildRequest("c=1"), fakeEnv(), 7, form({}));
    expect(result).toEqual({ kind: "site_changed", currentSiteName: "owner/site-b" });
  });

  it("answers no_project when the user has no memberships", async () => {
    resolveActiveProject.mockResolvedValue(null);
    const result = await resolvePageProject(buildRequest("c=1"), fakeEnv(), 7, form({ siteId: "42" }));
    expect(result).toEqual({ kind: "no_project" });
  });
});

describe("a tab's own site", () => {
  function tabRequest(site: string | null, cookie = "c=1"): Request {
    const headers: Record<string, string> = { Cookie: cookie };
    if (site !== null) headers["X-Telar-Site"] = site;
    return new Request("https://compositor.telar.org/objects", { headers });
  }

  it("resolves the site the tab names when the session names another", async () => {
    getSession.mockResolvedValue({ get: vi.fn(() => 42) });
    resolveActiveProject.mockResolvedValue({ project: { id: 11 }, userRole: "convenor" });
    await resolveActiveProjectFromRequest(tabRequest("11"), fakeEnv(), 7);
    expect(resolveActiveProject).toHaveBeenCalledWith(SENTINEL_DB, 7, 11);
  });

  it.each(["", "0", "-3", "1.5", "abc", "11abc"])("falls back to the session for the header %j", async (value) => {
    getSession.mockResolvedValue({ get: vi.fn(() => 42) });
    resolveActiveProject.mockResolvedValue({ project: { id: 42 }, userRole: "convenor" });
    await resolveActiveProjectFromRequest(tabRequest(value), fakeEnv(), 7);
    expect(resolveActiveProject).toHaveBeenCalledWith(SENTINEL_DB, 7, 42);
  });

  it("lets a write from the tab's site pass the page-site check while the session names another", async () => {
    getSession.mockResolvedValue({ get: vi.fn(() => 42) });
    resolveActiveProject.mockImplementation(((_db: unknown, _u: number, id: number | undefined) =>
      ({ project: { id, github_repo_full_name: `owner/site-${id}` }, userRole: "convenor" })) as never);
    const fd = new FormData();
    fd.set("siteId", "11");
    const result = await resolvePageProject(tabRequest("11"), fakeEnv(), 7, fd);
    expect(result.kind).toBe("ok");
  });
});
