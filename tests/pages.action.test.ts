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
 *   `import-pages` posts the discovered pages to the collaboration DO's
 *   /ingest-sync endpoint, which appends them to the shared document and lets
 *   the snapshot pipeline write the rows. What the action sends, what it does
 *   with the DO's skip list, and why it may not write `project_pages` itself
 *   all live in `tests/pages-import-through-do.test.ts`; this file
 *   keeps the scan and the fail-open guards the two intents share.
 *
 * Anti-pattern guards covered here:
 *   - Neither intent propagates a repo-tree fetch failure: an uncaught throw
 *     is sanitised into a root-level error that white-screens the tab.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testGithubAppPrivateKey, installGithubAppFetchStub } from "./helpers/github-app-fetch";

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
      // Drizzle's insert builder is both awaitable AND chainable with
      // `.returning()`; model both so `await …values()` and `…values().returning()`
      // work.
      values: vi.fn((values: unknown) => {
        insertCalls.push({ table, values });
        const builder = Promise.resolve(undefined) as Promise<undefined> & {
          returning: () => Promise<Array<{ id: number }>>;
        };
        builder.returning = async () => [{ id: insertCalls.length }];
        return builder;
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

// With no head recorded, both intents read the head of main first.
vi.mock("~/lib/github.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getRepoHead: vi.fn(async () => "main-head"),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.pages";
import { decrypt } from "~/lib/crypto.server";
import { scanRepoPages } from "~/lib/import.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { GitHubTransientError, NoSuchBranchError } from "~/lib/github.server";
import { isUnreachableAnswer } from "~/lib/unreachable-write";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(intent: string, fields: Record<string, string | string[]> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  // Site-level intents are refused unless the posted siteId matches the
  // session's active project (id 42 per the resolveActiveProject mock above);
  // row-bound intents (autosave-page-body) ignore it.
  form.set("siteId", "42");
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

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(scanRepoPagesMock).toHaveBeenCalledWith("user-token", "owner", "repo", "main-head", { warnings: [], repair: "import_then_publish" });
    expect(result).toEqual({
      ok: true,
      intent: "scan-repo-pages",
      pages: [
        { slug: "about", title: "About", body: "About body.", order: 0 },
        { slug: "team", title: "Team", body: "Team body.", order: 1 },
      ],
      warnings: [],
    });
  });

  // scan-repo-pages runs for every project member
  // (no role gate at all), so it must never fall back to a collaborator's
  // own token on a mint failure — that would trade a private-repo refusal
  // for the collaborator's own, possibly-wrong-scoped, GitHub credential.
  // ~/lib/github-app.server is left unmocked here: with no real App
  // credentials in this harness, the installation mint fails fast (missing
  // key), so a collaborator's request exercises resolveProjectToken's real
  // non-convenor branch — no fallback, degrading to the fail-open empty list
  // without ever calling scanRepoPages on the collaborator's raw token.
  it("a collaborator's request never reaches scanRepoPages with a fallback token when the mint fails", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValueOnce({
      project: { id: 42, github_repo_full_name: "owner/repo" } as never,
      userRole: "collaborator",
    });

    const { context } = buildContext();
    const result = await action({
      request: buildRequest("scan-repo-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(scanRepoPagesMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, intent: "scan-repo-pages", pages: [], warnings: [] });
  });

  // The installation token belongs to publishing
  // roles. This intent has no role gate of its own, so which token an
  // instructor's read travels on is decided entirely by the shared
  // membership set — the same answer a collaborator gets below.
  it("instructor: scanRepoPages runs on the installation token when the mint succeeds", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValueOnce({
      project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 55 } as never,
      userRole: "instructor",
    });
    scanRepoPagesMock.mockResolvedValue([]);
    installGithubAppFetchStub();

    const user = { id: 7, encrypted_access_token: "enc-token" };
    const env = {
      ENCRYPTION_KEY: "key",
      SESSION_SECRET: "sess-secret",
      DB: {},
      GITHUB_APP_ID: "app-id",
      GITHUB_PRIVATE_KEY: testGithubAppPrivateKey(),
    };
    const context = {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"];

    const result = await action({
      request: buildRequest("scan-repo-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(scanRepoPagesMock).toHaveBeenCalledWith("install-token", "owner", "repo", "main-head", { warnings: [], repair: "import_then_publish" });
    expect(result).toEqual({ ok: true, intent: "scan-repo-pages", pages: [], warnings: [] });
  });

  it("collaborator: scanRepoPages runs on the installation token when the mint succeeds", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValueOnce({
      project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 55 } as never,
      userRole: "collaborator",
    });
    scanRepoPagesMock.mockResolvedValue([]);
    installGithubAppFetchStub();

    const user = { id: 7, encrypted_access_token: "enc-token" };
    const env = {
      ENCRYPTION_KEY: "key",
      SESSION_SECRET: "sess-secret",
      DB: {},
      GITHUB_APP_ID: "app-id",
      GITHUB_PRIVATE_KEY: testGithubAppPrivateKey(),
    };
    const context = {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"];

    await action({
      request: buildRequest("scan-repo-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(scanRepoPagesMock).toHaveBeenCalledWith("install-token", "owner", "repo", "main-head", { warnings: [], repair: "import_then_publish" });
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
      warnings: [],
    });
  });

  // Regression: this scan fires automatically on mount whenever the Pages tab
  // has no pages yet (_app.pages.tsx mount effect). If the connected repo's
  // tree can't be fetched — e.g. an empty repo with no commits returns 404 on
  // GET /git/trees/HEAD, so getRepoTree throws "GitHub API error fetching
  // tree: 404" — the action must NOT propagate the throw. An uncaught action
  // error is sanitised by React Router into a root-level "Unexpected Server
  // Error", white-screening the whole Pages tab. A best-effort scan must fail
  // open: degrade to the plain empty state (no import banner) so the user can
  // still create pages by hand.
  it("fails open (empty list) when the repo tree can't be fetched", async () => {
    scanRepoPagesMock.mockRejectedValue(
      new Error("GitHub API error fetching tree: 404"),
    );

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
      warnings: [],
    });
  });

  // The scan reads each page strictly and throws on one it cannot read, so a
  // page is never left out of what it offers. That is a scan that could not be
  // made, answered unreachable (see the block below), not an empty repo.
});

describe("_app.pages action: import-pages intent", () => {
  // Regression: import-pages re-scans the repo (same getRepoTree path as
  // scan-repo-pages). It's user-initiated and only reachable after a
  // successful scan, but a transient repo-tree fetch error must still not
  // propagate uncaught (which white-screens the tab). It returns ok:false so
  // the client clears its spinners and toasts, and reaches no DO.
  it("answers a failure, writing nothing, when a page cannot be read", async () => {
    scanRepoPagesMock.mockRejectedValue(new SheetUnreadableError("telar-content/texts/pages/about.md"));

    const { context } = buildContext();
    const result = await action({
      request: buildRequest("import-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(insertCalls).toHaveLength(0);
    expect(result).toEqual({ ok: false, intent: "import-pages", imported: 0, pages: [], already_present: [] });
  });

  it("fails open (ok:false, no inserts) when the repo tree can't be fetched", async () => {
    scanRepoPagesMock.mockRejectedValue(
      new Error("GitHub API error fetching tree: 404"),
    );

    const { context } = buildContext();
    const result = await action({
      request: buildRequest("import-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(insertCalls).toHaveLength(0);
    expect(result).toEqual({
      ok: false,
      intent: "import-pages",
      imported: 0,
      pages: [],
      already_present: [],
    });
  });

  // Same rule as scan-repo-pages — the token an
  // instructor's repo re-scan travels on is the shared membership set's
  // answer, not this intent's, which carries no role gate.
  it("instructor: scanRepoPages (the repo re-scan) runs on the installation token", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValueOnce({
      project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 55, head_sha: "recorded-head" } as never,
      userRole: "instructor",
    });
    scanRepoPagesMock.mockResolvedValue([]);
    installGithubAppFetchStub();

    const user = { id: 7, encrypted_access_token: "enc-token" };
    const env = {
      ENCRYPTION_KEY: "key",
      SESSION_SECRET: "sess-secret",
      DB: {},
      GITHUB_APP_ID: "app-id",
      GITHUB_PRIVATE_KEY: testGithubAppPrivateKey(),
    };
    const context = {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"];

    await action({
      request: buildRequest("import-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    // At the recorded head.
    expect(scanRepoPagesMock).toHaveBeenCalledWith("install-token", "owner", "repo", "recorded-head");
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

describe("_app.pages action: scan-repo-pages when GitHub does not answer", () => {
  async function scanFailing(failure: unknown) {
    scanRepoPagesMock.mockRejectedValue(failure);
    const { context } = buildContext();
    return action({
      request: buildRequest("scan-repo-pages"),
      context,
      params: {},
    } as unknown as Parameters<typeof action>[0]);
  }

  const UNREACHABLE = { ok: false, reason: "unreachable", intent: "scan-repo-pages", pages: [], warnings: [] };

  it.each([
    ["a GraphQL 5xx", new GitHubTransientError("GitHub GraphQL error: 502", 502)],
    ["a request that never completed", new TypeError("fetch failed")],
    ["a tree 503", new Error("GitHub API error fetching tree: 503")],
    ["a tree rate limit", new Error("GitHub API error fetching tree: 429")],
    ["a GraphQL rate limit on the head read", new Error("GitHub GraphQL error: 429")],
    ["a page file that cannot be read", new SheetUnreadableError("telar-content/texts/pages/about.md")],
  ])("answers %s as unreachable, so the page asks again", async (_name, failure) => {
    const answer = await scanFailing(failure);
    expect(answer).toEqual(UNREACHABLE);
    // The shape the page's retry recognises.
    expect(isUnreachableAnswer(answer)).toBe(true);
  });

  it.each([
    ["a repository with no branch", new NoSuchBranchError("main")],
    ["an empty repository's tree (404)", new Error("GitHub API error fetching tree: 404")],
    ["an empty repository's tree (409)", new Error("GitHub API error fetching tree: 409")],
    ["a refused credential", new Error("GitHub API error fetching tree: 401")],
    ["a defect in the code, not an outage", new TypeError("Cannot read properties of undefined (reading 'replace')")],
  ])("keeps %s as an ok answer with no pages", async (_name, failure) => {
    expect(await scanFailing(failure)).toEqual({ ok: true, intent: "scan-repo-pages", pages: [], warnings: [] });
  });
});
