/**
 * Authorization tests for toggle-draft and toggle-private actions in
 * _app.stories.tsx. Verifies that both intents scope their UPDATE to the
 * caller's active project, closing the cross-project IDOR where any
 * signed-in user could flip draft/private on any story by id.
 *
 * @version v1.3.0-beta
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
      get: vi.fn(() => 99),
    })),
  })),
}));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 42, github_repo_full_name: "owner/repo" },
    userRole: "collaborator",
  })),
}));

vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.stories";
import { getDb } from "~/lib/db.server";
import { createSessionStorage } from "~/lib/session.server";
import { resolveActiveProject } from "~/lib/membership.server";

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

  // Reset db mock to fresh chained fns each test
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue({}),
      })),
    })),
  } as never);

  // Default session: returns activeProjectId = 99
  vi.mocked(createSessionStorage).mockReturnValue({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 99) })),
  } as never);

  // Default resolved project
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo" } as never,
    userRole: "collaborator",
  });
});

// ---------------------------------------------------------------------------
// toggle-draft
// ---------------------------------------------------------------------------

describe("_app.stories action: toggle-draft IDOR fix", () => {
  it("returns ok:true and scopes the UPDATE where-clause by the resolved project id", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo" } as never,
      userRole: "collaborator",
    });

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

    // The where arg must encode the resolved project id (42)
    const whereArg = captureWhereArg();
    expect(drizzleClauseContainsValue(whereArg, 42)).toBe(true);
  });

  it("returns { ok:false, error:'no_project' } and does NOT mutate DB when resolveActiveProject returns null", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue(null);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-draft", { storyDbId: "10", currentValue: "false" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string; error?: string };

    expect(res.ok).toBe(false);
    expect(res.intent).toBe("toggle-draft");
    expect(res.error).toBe("no_project");

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).not.toHaveBeenCalled();
  });

  it("passes the sessionActiveId from the session cookie to resolveActiveProject", async () => {
    vi.mocked(createSessionStorage).mockReturnValue({
      getSession: vi.fn(async () => ({ get: vi.fn(() => 77) })),
    } as never);

    const { context } = buildContext();
    await action({
      request: buildRequest("toggle-draft", { storyDbId: "5", currentValue: "true" }),
      context,
      params: {},
    } as never);

    expect(resolveActiveProject).toHaveBeenCalledWith(
      expect.anything(), // db
      7,                 // user.id
      77,                // sessionActiveId
    );
  });
});

// ---------------------------------------------------------------------------
// toggle-private
// ---------------------------------------------------------------------------

describe("_app.stories action: toggle-private IDOR fix", () => {
  it("returns ok:true and scopes the UPDATE where-clause by the resolved project id", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 55, github_repo_full_name: "owner/repo" } as never,
      userRole: "collaborator",
    });

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

  it("returns { ok:false, error:'no_project' } and does NOT mutate DB when resolveActiveProject returns null", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue(null);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-private", { storyDbId: "20", currentValue: "true" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string; error?: string };

    expect(res.ok).toBe(false);
    expect(res.intent).toBe("toggle-private");
    expect(res.error).toBe("no_project");

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).not.toHaveBeenCalled();
  });

  it("passes the sessionActiveId from the session cookie to resolveActiveProject", async () => {
    vi.mocked(createSessionStorage).mockReturnValue({
      getSession: vi.fn(async () => ({ get: vi.fn(() => 33) })),
    } as never);

    const { context } = buildContext();
    await action({
      request: buildRequest("toggle-private", { storyDbId: "20", currentValue: "false" }),
      context,
      params: {},
    } as never);

    expect(resolveActiveProject).toHaveBeenCalledWith(
      expect.anything(),
      7,
      33,
    );
  });
});
