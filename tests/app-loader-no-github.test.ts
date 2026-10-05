/**
 * This file tests the `/_app` layout loader's request-path GitHub
 * discipline (Navigation Performance Task 5).
 *
 * The loader was rewritten to read GitHub-derived status (repo
 * availability, head divergence, upgrade) from the D1 `gh_*` cache
 * columns instead of fanning out a per-navigation GitHub waterfall.
 * The ONLY GitHub call still permitted on the request path is the
 * global latest-tag fetch, and ONLY when the tag cache is cold AND the
 * route is gated (fail-closed upgrade gate).
 *
 * Strategy: mock every server-only dependency the loader touches —
 * membership, session, crypto, db — plus the GitHub-touching modules
 * (`~/lib/github.server`, `~/lib/sync.server`, and `fetchLatestRelease`
 * from `~/lib/upgrade.server`) with spy-able fns that record any call.
 * `~/lib/github-status.server` and `compareTelarVersion` run for real so
 * the cache-derivation + version-comparison logic is exercised authentically.
 *
 * Case (a): warm tag cache + warm gh_* cache → loader returns with ZERO
 *   GitHub calls (the load-bearing fast-navigation guarantee), and
 *   `headDiverged` equals `deriveHeadDiverged`.
 * Case (b): cold tag cache + /publish + convenor + below-latest version
 *   → exactly one allowed `fetchLatestRelease` and a throw redirect to /upgrade.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { deriveHeadDiverged, __resetTagCacheForTest, getCachedLatestTag } from "~/lib/github-status.server";

// ---------------------------------------------------------------------------
// Module mocks (must precede the loader import)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  // GitHub-touching fns — any call here is a request-path GitHub hit.
  getRepoHeadMock: vi.fn(async () => "remote-sha"),
  checkRepoAvailabilityMock: vi.fn(async () => ({ availability: "available" as const, canonicalFullName: null })),
  computeFullSyncDiffMock: vi.fn(async () => ({})),
  hasDivergentChangesMock: vi.fn(() => false),
  fetchLatestReleaseMock: vi.fn(async () => ({ tagName: "v9.9.9" })),
  // membership / session / crypto
  getUserProjectsMock: vi.fn(async () => [] as unknown[]),
  getUserRoleMock: vi.fn(async (): Promise<string | null> => "convenor"),
  getPresenceColorMock: vi.fn(async () => "#E47A6F"),
  resolveActiveProjectMock: vi.fn(async () => null as unknown),
  decryptMock: vi.fn(async () => "decrypted-token"),
  getSessionMock: vi.fn(async () => ({ get: () => 1 })),
}));

vi.mock("~/lib/github.server", () => ({
  getRepoHead: mocks.getRepoHeadMock,
  checkRepoAvailability: mocks.checkRepoAvailabilityMock,
}));

vi.mock("~/lib/sync.server", () => ({
  computeFullSyncDiff: mocks.computeFullSyncDiffMock,
  hasDivergentChanges: mocks.hasDivergentChangesMock,
}));

// Keep compareTelarVersion (and everything else) real; only spy fetchLatestRelease.
vi.mock("~/lib/upgrade.server", async (importActual) => {
  const actual = await importActual<typeof import("~/lib/upgrade.server")>();
  return { ...actual, fetchLatestRelease: mocks.fetchLatestReleaseMock };
});

vi.mock("~/lib/membership.server", () => ({
  getUserProjects: mocks.getUserProjectsMock,
  getUserRole: mocks.getUserRoleMock,
  getPresenceColor: mocks.getPresenceColorMock,
  resolveActiveProject: mocks.resolveActiveProjectMock,
  // The real predicate: the mock stands in for the queries, not for the
  // rule about which rows list.
  listableProjects: (rows: Array<{ userRole: string; parent_project_id: number | null }>) =>
    rows.filter((p) => !(p.userRole === "instructor" && p.parent_project_id != null)),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({ getSession: mocks.getSessionMock })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: mocks.decryptMock,
}));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

// Drizzle table objects carry their SQLite name on Symbol.for("drizzle:Name").
const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");
function tableName(t: unknown): string {
  const name = (t as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof name === "string" ? name : "unknown";
}

// Per-table row fixtures the db mock returns. Mutated per-test.
let rowsByTable: Record<string, unknown[]> = {};

vi.mock("~/lib/db.server", () => {
  // A select builder that resolves (await) to the rows for whichever table
  // .from(table) names. Supports the chains the loader uses:
  //   .from(t).where(...)                      → awaited array
  //   .from(t).where(...).limit(n)             → awaited array
  //   .from(t).innerJoin(...).where(...)       → awaited array
  function makeSelectBuilder() {
    let table = "unknown";
    const result = () => rowsByTable[table] ?? [];
    const builder: Record<string, unknown> = {
      from: (t: unknown) => {
        table = tableName(t);
        return builder;
      },
      innerJoin: () => builder,
      where: () => builder,
      limit: () => builder,
      groupBy: () => builder,
      then: (resolve: (v: unknown[]) => unknown) => resolve(result()),
    };
    return builder;
  }
  function makeUpdateBuilder() {
    const builder: Record<string, unknown> = {
      set: () => builder,
      where: () => Promise.resolve(undefined),
    };
    return builder;
  }
  return {
    getDb: vi.fn(() => ({
      select: vi.fn(() => makeSelectBuilder()),
      update: vi.fn(() => makeUpdateBuilder()),
    })),
  };
});

import { loader } from "../app/routes/_app";
import { userContext as userContextStub } from "~/middleware/auth.server";

function makeContext() {
  const env = {
    DB: {} as unknown,
    SESSION_SECRET: "test-secret",
    ENCRYPTION_KEY: "test-key",
    ENVIRONMENT: "test",
  };
  return {
    get: (key: unknown) =>
      key === userContextStub
        ? {
            id: 1,
            github_id: 1,
            github_login: "tester",
            github_name: null,
            github_email: null,
            encrypted_access_token: "encrypted",
          }
        : undefined,
    cloudflare: { env },
  };
}

function makeRequest(path: string): Request {
  return new Request(`https://example.workers.dev${path}`, { method: "GET" });
}

function invoke(request: Request) {
  return (loader as unknown as (a: unknown) => Promise<Record<string, unknown>>)({
    request,
    context: makeContext(),
  });
}

const PROJECT_ROW = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  head_sha: "local-sha",
  github_repo_full_name: "alice/site",
  github_pages_url: "https://alice.example/site",
  gh_repo_available: 1,
  gh_remote_head_sha: "remote-sha",
  gh_diverged: 1,
  gh_diverged_against_sha: "local-sha",
  gh_checked_at: new Date().toISOString(),
  ...overrides,
});

function noGithubCalls(): boolean {
  return (
    mocks.getRepoHeadMock.mock.calls.length === 0 &&
    mocks.checkRepoAvailabilityMock.mock.calls.length === 0 &&
    mocks.computeFullSyncDiffMock.mock.calls.length === 0 &&
    mocks.fetchLatestReleaseMock.mock.calls.length === 0
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetTagCacheForTest();
  rowsByTable = {};
});

describe("/_app loader — request-path GitHub discipline", () => {
  it("(a) warm tag cache + warm gh_* cache: no GitHub call; headDiverged = deriveHeadDiverged", async () => {
    // Warm the in-isolate tag cache so the loader's warm read short-circuits.
    await getCachedLatestTag("token", Date.now()); // primes _tagCache
    expect(mocks.fetchLatestReleaseMock).toHaveBeenCalledTimes(1); // the priming call only
    mocks.fetchLatestReleaseMock.mockClear();

    const projectRow = PROJECT_ROW();
    rowsByTable = {
      projects: [projectRow],
      project_members: [
        // Fields used by the member join query + by the grouped count query.
        { userId: 1, role: "convenor", githubId: 1, username: "tester", name: null, welcomedAt: "x", contributions: null, project_id: 1, n: 1 },
      ],
      project_config: [{ telar_version: "1.0.0", url: "https://alice.example", baseurl: "/site" }],
      // last_published_at null → cheap-count Promise.all branch is skipped.
    };
    // getUserProjects returns the active project so activeProjectId resolves
    // and is non-null; session.get returns 1.
    mocks.getUserProjectsMock.mockResolvedValue([
      { id: 1, github_repo_full_name: "alice/site", userRole: "convenor", user_id: 1 },
    ]);

    const data = await invoke(makeRequest("/dashboard"));

    expect(noGithubCalls()).toBe(true);
    expect(data.headDiverged).toBe(deriveHeadDiverged(projectRow, projectRow.head_sha));
    expect(data.headDiverged).toBe(true);
    expect(data.repoUnavailable).toBe(false);
    expect(data.repoFullName).toBe("alice/site");
    expect(data.activeProjectId).toBe(1);
    // pagesUrl derived from config url+baseurl, lazy-healed.
    expect(data.pagesUrl).toBe("https://alice.example/site");
  });

  it("(b) cold tag cache + /publish + convenor + below-latest version: one allowed fetch, redirect to /upgrade", async () => {
    // Tag cache is cold (reset in beforeEach). Site version below v9.9.9.
    rowsByTable = {
      projects: [PROJECT_ROW()],
      project_members: [
        // Fields used by the member join query + by the grouped count query.
        { userId: 1, role: "convenor", githubId: 1, username: "tester", name: null, welcomedAt: "x", contributions: null, project_id: 1, n: 1 },
      ],
      project_config: [{ telar_version: "1.0.0", url: "https://alice.example", baseurl: "/site" }],
    };
    mocks.getUserProjectsMock.mockResolvedValue([
      { id: 1, github_repo_full_name: "alice/site", userRole: "convenor", user_id: 1 },
    ]);
    mocks.getUserRoleMock.mockResolvedValue("convenor");

    let thrown: unknown;
    try {
      await invoke(makeRequest("/publish"));
    } catch (err) {
      thrown = err;
    }

    // One allowed GitHub fetch: the cold-cache, gated-route tag fetch.
    expect(mocks.fetchLatestReleaseMock).toHaveBeenCalledTimes(1);
    // No other GitHub call snuck onto the request path.
    expect(mocks.getRepoHeadMock).not.toHaveBeenCalled();
    expect(mocks.checkRepoAvailabilityMock).not.toHaveBeenCalled();
    expect(mocks.computeFullSyncDiffMock).not.toHaveBeenCalled();

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/upgrade?from=${encodeURIComponent("/publish")}`);
  });

  // A collaborator whose upgrade the installation's missing workflows:write
  // permission would refuse is never sent to /upgrade. On /objects nobody is
  // redirected any more (see (d)); what this pins is that the loader still
  // reports the state, since the Upload tab reads upgradeAwaitsConvenor to
  // name whom to ask. See (e) for /publish.
  it("(c) cold tag cache + /objects + collaborator + gh_workflows_write_missing=1 + below-latest version: no redirect, upgradeAwaitsConvenor true", async () => {
    rowsByTable = {
      projects: [PROJECT_ROW({ gh_workflows_write_missing: 1 })],
      project_members: [
        { userId: 1, role: "collaborator", githubId: 1, username: "tester", name: null, welcomedAt: "x", contributions: null, project_id: 1, n: 1 },
      ],
      // Below MIN_SUPPORTED_VERSION (v0.9.0-beta) as well as below the
      // fixture's latest tag (v9.9.9) — needsUpgrade must be true for
      // upgradeAwaitsConvenor's own `needsUpgrade &&` clause to matter.
      project_config: [{ telar_version: "0.5.0", url: "https://alice.example", baseurl: "/site" }],
    };
    mocks.getUserProjectsMock.mockResolvedValue([
      { id: 1, github_repo_full_name: "alice/site", userRole: "collaborator", user_id: 1 },
    ]);
    mocks.getUserRoleMock.mockResolvedValue("collaborator");

    const data = await invoke(makeRequest("/objects"));

    // No redirect was thrown — invoke() would have rejected past this point
    // otherwise, since a throw inside the loader propagates out of invoke().
    expect(data.needsUpgrade).toBe(true);
    expect(data.upgradeAwaitsConvenor).toBe(true);
  });

  // Objects is not refused as a page: browsing and editing do not depend on
  // the framework, and the one act there that does — uploading — is refused
  // by its own action (readUploadRefusal). The page still checks the version on
  // a cold cache, because the Upload tab reads needsUpgrade to say so before
  // anyone tries.
  it("(d) same project, but convenor on /objects: not redirected, and the version is still read", async () => {
    rowsByTable = {
      projects: [PROJECT_ROW({ gh_workflows_write_missing: 1 })],
      project_members: [
        { userId: 1, role: "convenor", githubId: 1, username: "tester", name: null, welcomedAt: "x", contributions: null, project_id: 1, n: 1 },
      ],
      project_config: [{ telar_version: "0.5.0", url: "https://alice.example", baseurl: "/site" }],
    };
    mocks.getUserProjectsMock.mockResolvedValue([
      { id: 1, github_repo_full_name: "alice/site", userRole: "convenor", user_id: 1 },
    ]);
    mocks.getUserRoleMock.mockResolvedValue("convenor");

    const data = await invoke(makeRequest("/objects"));

    expect(mocks.fetchLatestReleaseMock).toHaveBeenCalledTimes(1);
    expect(data.needsUpgrade).toBe(true);
    expect(data.upgradeAwaitsConvenor).toBe(false);
  });

  // This collaborator has nothing to do on
  // /publish — sent back to /objects (where disabled controls explain why),
  // never to /upgrade, an upgrade they cannot complete.
  it("(e) same project, /publish instead: redirected to /objects, not /upgrade", async () => {
    rowsByTable = {
      projects: [PROJECT_ROW({ gh_workflows_write_missing: 1 })],
      project_members: [
        { userId: 1, role: "collaborator", githubId: 1, username: "tester", name: null, welcomedAt: "x", contributions: null, project_id: 1, n: 1 },
      ],
      project_config: [{ telar_version: "0.5.0", url: "https://alice.example", baseurl: "/site" }],
    };
    mocks.getUserProjectsMock.mockResolvedValue([
      { id: 1, github_repo_full_name: "alice/site", userRole: "collaborator", user_id: 1 },
    ]);
    mocks.getUserRoleMock.mockResolvedValue("collaborator");

    let thrown: unknown;
    try {
      await invoke(makeRequest("/publish"));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/objects");
  });

  // A failed lookup is unknown, not "no upgrade needed". Publish
  // opens with its button disabled instead of redirecting, because the
  // upgrade page cannot say what the site would be upgraded to either.
  function convenorOnVersionedSite(telarVersion: string | null = "1.0.0") {
    rowsByTable = {
      projects: [PROJECT_ROW()],
      project_members: [
        { userId: 1, role: "convenor", githubId: 1, username: "tester", name: null, welcomedAt: "x", contributions: null, project_id: 1, n: 1 },
      ],
      project_config: [{ telar_version: telarVersion, url: "https://alice.example", baseurl: "/site" }],
    };
    mocks.getUserProjectsMock.mockResolvedValue([
      { id: 1, github_repo_full_name: "alice/site", userRole: "convenor", user_id: 1 },
    ]);
    mocks.getUserRoleMock.mockResolvedValue("convenor");
  }

  it("(f) cold tag cache + /publish + a lookup that fails: no redirect, releaseUnknown", async () => {
    convenorOnVersionedSite();
    mocks.fetchLatestReleaseMock.mockRejectedValueOnce(new Error("GitHub API error fetching latest release: 502"));

    const data = await invoke(makeRequest("/publish"));

    expect(mocks.fetchLatestReleaseMock).toHaveBeenCalledTimes(1);
    expect(data.releaseUnknown).toBe(true);
    expect(data.needsUpgrade).toBe(false);
    expect(data.latestTelarTag).toBeNull();
  });

  it("(g) a failure already in the cache reaches the loader's warm read", async () => {
    convenorOnVersionedSite();
    mocks.fetchLatestReleaseMock.mockRejectedValueOnce(new Error("GitHub API error fetching latest release: 502"));
    await getCachedLatestTag("token", Date.now()); // records the failure
    mocks.fetchLatestReleaseMock.mockClear();

    const data = await invoke(makeRequest("/publish"));

    expect(mocks.fetchLatestReleaseMock).not.toHaveBeenCalled();
    expect(data.releaseUnknown).toBe(true);
  });

  it("(h) a failed lookup on a site with no recorded version is not unknown", async () => {
    convenorOnVersionedSite(null);
    mocks.fetchLatestReleaseMock.mockRejectedValueOnce(new Error("GitHub API error fetching latest release: 502"));

    const data = await invoke(makeRequest("/publish"));

    expect(data.releaseUnknown).toBe(false);
  });

  it("(i) a successful lookup leaves releaseUnknown false", async () => {
    convenorOnVersionedSite("9.9.9");

    const data = await invoke(makeRequest("/publish"));

    expect(mocks.fetchLatestReleaseMock).toHaveBeenCalledTimes(1);
    expect(data.releaseUnknown).toBe(false);
    expect(data.needsUpgrade).toBe(false);
  });
});
