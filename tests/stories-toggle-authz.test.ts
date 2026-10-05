/**
 * Authorization tests for toggle-draft and toggle-private actions in
 * _app.stories.tsx. Both intents are row-bound: they load the story row by
 * id, resolve authorization against that row's OWN project_id via
 * `requireProjectMember`, and scope the UPDATE by that same project_id —
 * never by the caller's session-active project. This closes the
 * cross-project IDOR where any signed-in user could flip draft/private on
 * any story by id, while still letting a member act on a story that belongs
 * to a site other than the one their session currently shows.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — factories must be self-contained (hoisted before variable init)
// ---------------------------------------------------------------------------

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue({}),
      })),
    })),
  })),
}));

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn(() => undefined),
    })),
  })),
}));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => null),
  requireProjectMember: vi.fn(async () => undefined),
}));

vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.stories";
import { getDb } from "~/lib/db.server";
import { requireProjectMember } from "~/lib/membership.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(intent: string, extra: Record<string, string> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  for (const [k, v] of Object.entries(extra)) {
    form.set(k, v);
  }
  return new Request("https://compositor.telar.org/stories", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext(userId = 7) {
  const user = { id: userId, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({ fetch: vi.fn() })),
    },
  };
  return {
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"],
  };
}

// The row select (`db.select({project_id}).from(stories).where(eq(stories.id,
// storyDbId)).limit(1)`) is the only select the row-bound toggle path makes
// directly — `requireProjectMember` is mocked above rather than exercised
// through its own `db.select` chain, so this is the only shape to fake here.
function makeSelectMock(storyRow: { project_id: number } | undefined) {
  return vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => (storyRow ? [storyRow] : [])),
      })),
    })),
  }));
}

function setStoryRow(storyRow: { project_id: number } | undefined) {
  vi.mocked(getDb).mockReturnValue({
    select: makeSelectMock(storyRow),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue({}),
      })),
    })),
  } as never);
}

// Helper to extract the captured where-argument from a freshly-called db mock.
// Returns the raw drizzle SQL object (may be circular — do NOT JSON.stringify it).
function captureWhereArg(): unknown {
  const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
    update: ReturnType<typeof vi.fn>;
  };
  const setMock = dbInstance.update.mock.results.at(-1)?.value as {
    set: ReturnType<typeof vi.fn>;
  };
  const whereMock = setMock.set.mock.results.at(-1)?.value as {
    where: ReturnType<typeof vi.fn>;
  };
  return whereMock.where.mock.calls.at(-1)?.[0];
}

// Drizzle `and(eq(a,x), eq(b,y))` creates a nested SQL object that is circular.
// Instead of JSON.stringify, we walk queryChunks recursively to find a value.
function drizzleClauseContainsValue(node: unknown, value: number): boolean {
  if (node === null || node === undefined) return false;
  if (typeof node === "number") return node === value;
  if (typeof node === "object") {
    // Drizzle SQL nodes expose `queryChunks` (array) or `value` (scalar)
    const obj = node as Record<string, unknown>;
    if (typeof obj["value"] === "number" && obj["value"] === value) return true;
    if (Array.isArray(obj["queryChunks"])) {
      for (const chunk of obj["queryChunks"] as unknown[]) {
        if (drizzleClauseContainsValue(chunk, value)) return true;
      }
    }
    // Also check `left` / `right` for BinarySQL nodes
    if (drizzleClauseContainsValue(obj["left"], value)) return true;
    if (drizzleClauseContainsValue(obj["right"], value)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  setStoryRow({ project_id: 42 });
  vi.mocked(requireProjectMember).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// toggle-draft
// ---------------------------------------------------------------------------

describe("_app.stories action: toggle-draft IDOR fix", () => {
  it("returns ok:true and scopes the UPDATE where-clause by the story row's own project id", async () => {
    setStoryRow({ project_id: 42 });

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-draft", { storyDbId: "10", currentValue: "false" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("toggle-draft");

    // db.update must have been invoked
    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).toHaveBeenCalled();

    // The where arg must encode the row's own project id (42)
    const whereArg = captureWhereArg();
    expect(drizzleClauseContainsValue(whereArg, 42)).toBe(true);
  });

  // toggle-draft is row-bound: it never reads the session. A story row that
  // does not exist answers { ok: true, intent } with no write, matching
  // every other row-bound intent's "missing row" answer.
  it("returns ok:true and does NOT mutate DB when the story row does not exist", async () => {
    setStoryRow(undefined);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-draft", { storyDbId: "10", currentValue: "false" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string; error?: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("toggle-draft");
    expect(res.error).toBeUndefined();

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).not.toHaveBeenCalled();
  });

  // toggle-draft checks membership against the story row's own project id,
  // via requireProjectMember — never against the caller's session-active
  // project.
  it("checks membership against the story row's own project id, regardless of the session", async () => {
    setStoryRow({ project_id: 77 });

    const { context } = buildContext(7);
    await action({
      request: buildRequest("toggle-draft", { storyDbId: "5", currentValue: "true" }),
      context,
      params: {},
    } as never);

    expect(requireProjectMember).toHaveBeenCalledWith(
      expect.anything(), // db
      77,                // the row's own project_id
      7,                 // user.id
    );
  });
});

// ---------------------------------------------------------------------------
// toggle-private
// ---------------------------------------------------------------------------

describe("_app.stories action: toggle-private IDOR fix", () => {
  it("returns ok:true and scopes the UPDATE where-clause by the story row's own project id", async () => {
    setStoryRow({ project_id: 55 });

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-private", { storyDbId: "20", currentValue: "true" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("toggle-private");

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).toHaveBeenCalled();

    const whereArg = captureWhereArg();
    expect(drizzleClauseContainsValue(whereArg, 55)).toBe(true);
  });

  // toggle-private is row-bound: a story row that does not exist answers
  // { ok: true, intent } with no write, matching every other row-bound
  // intent's "missing row" answer.
  it("returns ok:true and does NOT mutate DB when the story row does not exist", async () => {
    setStoryRow(undefined);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-private", { storyDbId: "20", currentValue: "true" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string; error?: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("toggle-private");
    expect(res.error).toBeUndefined();

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).not.toHaveBeenCalled();
  });

  // toggle-private checks membership against the story row's own project id,
  // via requireProjectMember — never against the caller's session-active
  // project.
  it("checks membership against the story row's own project id, regardless of the session", async () => {
    setStoryRow({ project_id: 33 });

    const { context } = buildContext(7);
    await action({
      request: buildRequest("toggle-private", { storyDbId: "20", currentValue: "false" }),
      context,
      params: {},
    } as never);

    expect(requireProjectMember).toHaveBeenCalledWith(
      expect.anything(),
      33,
      7,
    );
  });
});
