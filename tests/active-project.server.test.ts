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
 * @version v1.4.0-beta
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

import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";

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
