/**
 * This file tests the `_app.pages.tsx` action — focused on the
 * `scan-repo-pages` and `import-pages` intents that bring user-authored
 * pages from the connected repo into the compositor's editor.
 *
 * Why an action-level test (mirrors `tests/stories.action.test.ts`):
 *   the action decrypts the user's GitHub token, splits the project's
 *   `github_repo_full_name`, calls `scanRepoPages`, and (for `import-pages`)
 *   inserts new rows into D1. We mock the dependency graph at the module
 *   boundary and invoke `action({ request, context })` directly.
 *
 * Architecture:
 *   `import-pages` writes rows to D1 and returns the imported page records.
 *   The client effect on `importFetcher.data` mirrors the records into the
 *   active Yjs document via the editor's normal Yjs path. This keeps the
 *   editor hydrated immediately while D1 stays in sync via the existing
 *   snapshot path.
 *
 * Anti-pattern guards covered here:
 *   - `import-pages` skips slugs that already exist in D1 (no overwrite).
 *   - `import-pages` only writes pages explicitly requested via `slugs[]`,
 *     OR all detected pages when `slugs[]` is omitted.
 *   - `import-pages` returns `imported: N` reflecting only newly inserted
 *     rows.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const insertCalls: Array<{ table: unknown; values: unknown }> = [];

function makeDbMock() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => existingPagesInD1),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        insertCalls.push({ table, values });
        return undefined;
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  };
}

let existingPagesInD1: Array<{ slug: string }> = [];
const dbMock = makeDbMock();

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => dbMock),
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
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 42,
      github_repo_full_name: "owner/repo",
    },
    userRole: "convenor",
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "user-token"),
}));

const { scanRepoPagesMock } = vi.hoisted(() => ({
  scanRepoPagesMock: vi.fn(),
}));
vi.mock("~/lib/import.server", () => ({
  scanRepoPages: scanRepoPagesMock,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.pages";
import { decrypt } from "~/lib/crypto.server";
import { scanRepoPages } from "~/lib/import.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(intent: string, fields: Record<string, string | string[]> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const v of value) form.append(key, v);
    } else {
      form.set(key, value);
    }
  }
  return new Request("https://compositor.telar.org/pages", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext() {
  const user = { id: 7, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
  };
  return {
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  insertCalls.length = 0;
  existingPagesInD1 = [];
  vi.mocked(decrypt).mockClear();
  scanRepoPagesMock.mockReset();
});

describe("_app.pages action: scan-repo-pages intent", () => {
  it("decrypts the token, splits the repo, calls scanRepoPages, and returns the page list", async () => {
    scanRepoPagesMock.mockResolvedValue([
      { slug: "about", title: "About", body: "About body.", order: 0 },
      { slug: "team", title: "Team", body: "Team body.", order: 1 },
    ]);

    const { context } = buildContext();
    const result = await action({
      request: buildRequest("scan-repo-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(decrypt).toHaveBeenCalledWith("enc-token", "key");
    expect(scanRepoPagesMock).toHaveBeenCalledWith("user-token", "owner", "repo");
    expect(result).toEqual({
      ok: true,
      intent: "scan-repo-pages",
      pages: [
        { slug: "about", title: "About", body: "About body.", order: 0 },
        { slug: "team", title: "Team", body: "Team body.", order: 1 },
      ],
    });
  });

  it("returns an empty list when the repo has no pages", async () => {
    scanRepoPagesMock.mockResolvedValue([]);

    const { context } = buildContext();
    const result = await action({
      request: buildRequest("scan-repo-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(result).toEqual({
      ok: true,
      intent: "scan-repo-pages",
      pages: [],
    });
  });
});

describe("_app.pages action: import-pages intent", () => {
  it("writes ALL discovered pages to D1 when no slugs are provided", async () => {
    scanRepoPagesMock.mockResolvedValue([
      { slug: "about", title: "About", body: "About body.", order: 0 },
      { slug: "team", title: "Team", body: "Team body.", order: 1 },
    ]);

    const { context } = buildContext();
    const result = await action({
      request: buildRequest("import-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    // Two insert calls — one per page. (Using single-row inserts keeps the
    // already_present skip logic per-row clean.)
    expect(insertCalls).toHaveLength(2);
    expect(result).toEqual({
      ok: true,
      intent: "import-pages",
      imported: 2,
      pages: [
        { slug: "about", title: "About", body: "About body.", order: 0 },
        { slug: "team", title: "Team", body: "Team body.", order: 1 },
      ],
      already_present: [],
    });
  });

  it("writes only the requested slugs when `slugs[]` is provided", async () => {
    scanRepoPagesMock.mockResolvedValue([
      { slug: "about", title: "About", body: "About body.", order: 0 },
      { slug: "team", title: "Team", body: "Team body.", order: 1 },
      { slug: "credits", title: "Credits", body: "Credits body.", order: 2 },
    ]);

    const { context } = buildContext();
    const result = await action({
      request: buildRequest("import-pages", { slugs: ["about", "credits"] }),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(insertCalls).toHaveLength(2);
    expect(result).toEqual({
      ok: true,
      intent: "import-pages",
      imported: 2,
      pages: [
        { slug: "about", title: "About", body: "About body.", order: 0 },
        { slug: "credits", title: "Credits", body: "Credits body.", order: 2 },
      ],
      already_present: [],
    });
  });

  it("skips slugs that already exist in D1 and reports them in already_present", async () => {
    existingPagesInD1 = [{ slug: "about" }];
    scanRepoPagesMock.mockResolvedValue([
      { slug: "about", title: "About", body: "About body.", order: 0 },
      { slug: "team", title: "Team", body: "Team body.", order: 1 },
    ]);

    const { context } = buildContext();
    const result = await action({
      request: buildRequest("import-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    // Only `team` should have been inserted; `about` is already present.
    expect(insertCalls).toHaveLength(1);
    expect(result).toMatchObject({
      ok: true,
      intent: "import-pages",
      imported: 1,
      already_present: ["about"],
    });
    expect((result as { pages: Array<{ slug: string }> }).pages.map((p) => p.slug)).toEqual(["team"]);
  });
});

describe("_app.pages action: existing autosave-page-body intent (regression)", () => {
  it("still rejects requests with no projectId", async () => {
    const { context } = buildContext();
    await expect(
      action({
        request: buildRequest("autosave-page-body", { value: "hello" }),
        context,
        params: {},
      } as unknown as Parameters<typeof action>[0]),
    ).rejects.toMatchObject({ status: 400 });
  });
});
