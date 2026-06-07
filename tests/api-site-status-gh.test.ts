/**
 * Tests for the `gh-status` payload added to the api.site-status resource
 * route (Task 6 — Navigation Performance plan).
 *
 * Strategy: mock all heavy server deps and invoke the loader directly with a
 * minimal Request + RouterContext stub. Assert the four key branches:
 *   (A) stale cache + claim won  → refreshGithubStatus IS called; derived values returned.
 *   (B) fresh cache              → refreshGithubStatus NOT called; cached values returned.
 *   (C) stale cache + claim lost → refreshGithubStatus NOT called; cached values returned.
 *   (D) decrypt / D1 error       → fail-open 200 with cache-derived values (no 500).
 *   (E) unpublishedCount         → real content-diff count included in gh-status response.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock handles — must exist before the vi.mock factories run.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  // db.server
  getDbMock: vi.fn(),
  // session.server
  createSessionStorageMock: vi.fn(),
  // crypto.server
  decryptMock: vi.fn(),
  // membership.server
  resolveActiveProjectMock: vi.fn(),
  getUserRoleMock: vi.fn(),
  // github-status.server
  isStale: vi.fn(),
  claimRefresh: vi.fn(),
  refreshGithubStatus: vi.fn(),
  deriveHeadDiverged: vi.fn(),
  getCachedLatestTag: vi.fn(),
  // upgrade.server
  compareTelarVersion: vi.fn(),
  // github-app.server
  getInstallationInfo: vi.fn(),
  // publish.server
  computeChangeSummary: vi.fn(),
  buildEntityHashes: vi.fn(),
  // auth.server (middleware)
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/db.server", () => ({ getDb: mocks.getDbMock }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: mocks.createSessionStorageMock,
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: mocks.decryptMock }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: mocks.resolveActiveProjectMock,
  getUserRole: mocks.getUserRoleMock,
}));
vi.mock("~/lib/github-status.server", () => ({
  isStale: mocks.isStale,
  claimRefresh: mocks.claimRefresh,
  refreshGithubStatus: mocks.refreshGithubStatus,
  deriveHeadDiverged: mocks.deriveHeadDiverged,
  getCachedLatestTag: mocks.getCachedLatestTag,
}));
vi.mock("~/lib/upgrade.server", () => ({
  compareTelarVersion: mocks.compareTelarVersion,
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationInfo: mocks.getInstallationInfo,
}));
// The route also imports github.server (GITHUB_API constant only) and
// publish/sync servers (for other payload cases). Stub them so imports
// resolve cleanly.
vi.mock("~/lib/github.server", () => ({ githubHeaders: vi.fn(() => ({})) }));
vi.mock("~/lib/publish.server", () => ({
  computeChangeSummary: mocks.computeChangeSummary,
  buildEntityHashes: mocks.buildEntityHashes,
}));
vi.mock("~/lib/sync.server", () => ({
  computeFullSyncDiff: vi.fn(),
}));
vi.mock("~/middleware/auth.server", () => ({
  userContext: mocks.userContext,
}));

// Import the loader AFTER all mocks are registered.
import { loader } from "../app/routes/api.site-status";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const FAKE_USER = {
  id: 42,
  github_id: 1,
  github_login: "tester",
  github_name: null,
  github_email: null,
  encrypted_access_token: "enc-tok",
  created_at: null,
};

const BASE_PROJECT_ROW = {
  id: 7,
  head_sha: "abc123",
  github_repo_full_name: "owner/repo",
  gh_checked_at: new Date(Date.now() - 60_000).toISOString(), // stale by default
  gh_repo_available: 1,
  gh_remote_head_sha: "abc123",
  gh_diverged: 0,
  gh_diverged_against_sha: "abc123",
};

const ACTIVE_PROJECT = {
  id: 7,
  publish_snapshot: null,
  last_published_at: null,
  head_sha: "abc123",
  last_synced_at: null,
  github_repo_full_name: "owner/repo",
};

const CONFIG_ROW = { telar_version: "1.3.0" };

/**
 * Build a minimal RouterContext stub matching what the loader expects.
 * The db mock receives a `selectImpl` fn that returns the row arrays for each
 * `.select().from().where().limit()` call in order.
 */
// Records payloads passed to db.update(...).set(...). Reset per test.
let recordedUpdates: Record<string, unknown>[] = [];

function makeContext(selectQueue: unknown[][], user = FAKE_USER) {
  let callIdx = 0;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectQueue[callIdx++] ?? []),
        })),
      })),
    })),
  };

  // db also needs .select().from().where() (no .limit) for project_config
  // Patch: make the where() return both a .limit() and be directly thenable
  // (drizzle chains can end at .where() for config rows).
  const dbFull = {
    select: vi.fn(() => {
      const fromFn = vi.fn(() => {
        const whereFn = vi.fn(() => {
          const result = selectQueue[callIdx++] ?? [];
          return {
            limit: vi.fn(async () => result),
            then: (res: (v: unknown) => unknown) => Promise.resolve(result).then(res),
          };
        });
        return { where: whereFn };
      });
      return { from: fromFn };
    }),
    // Records .update(...).set(payload).where(...) — the route's only real
    // update here is the workflows-permission cache write (claimRefresh and
    // refreshGithubStatus are mocked away).
    update: vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        recordedUpdates.push(payload);
        return { where: vi.fn(async () => []) };
      }),
    })),
  };

  mocks.getDbMock.mockReturnValue(dbFull);

  const env = {
    DB: {},
    SESSION_SECRET: "secret",
    ENCRYPTION_KEY: "key",
  };

  const sessionStub = { get: vi.fn(() => undefined) };
  mocks.createSessionStorageMock.mockReturnValue({
    getSession: vi.fn(async () => sessionStub),
  });

  return {
    get: (key: unknown) => (key === mocks.userContext ? user : undefined),
    cloudflare: { env },
  };
}

function makeRequest(payload: string) {
  return new Request(`https://compositor.telar.org/api/site-status?payload=${payload}`);
}

/**
 * The gh-status case now runs loadChangeSummary (5 DB selects) BEFORE the
 * GitHub waterfall. Prepend 5 empty-array entries to a gh-status queue so the
 * gh-status-specific rows stay at the right indices. Tests that control the
 * change summary themselves supply the 5 entries directly.
 */
const CS_EMPTY: unknown[][] = [[], [], [], [], []]; // stories, objects, pages, glossary, project_config

function ghQueue(...rows: unknown[][]): unknown[][] {
  return [...CS_EMPTY, ...rows];
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

/** Empty ChangeSummary (everything up to date). */
const EMPTY_SUMMARY = {
  isUpToDate: true,
  backCompatBootstrap: false,
  stories: { new: [], modified: [], deleted: [] },
  objects: { new: [], modified: [], deleted: [] },
  pages: { new: [], modified: [], deleted: [] },
  glossary: { new: [], modified: [], deleted: [] },
  settings: { changed: [] },
  landing: { changed: false },
  navigation: { changed: false },
  fileChanges: { addedStoryFiles: [], removedStoryFiles: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  recordedUpdates = [];
  mocks.resolveActiveProjectMock.mockResolvedValue({ project: ACTIVE_PROJECT });
  mocks.getUserRoleMock.mockResolvedValue("owner");
  mocks.decryptMock.mockResolvedValue("decrypted-token");
  mocks.refreshGithubStatus.mockResolvedValue(undefined);
  mocks.getCachedLatestTag.mockResolvedValue("v1.4.0");
  mocks.compareTelarVersion.mockReturnValue({ needsUpgrade: true, isBelowMinimum: false });
  mocks.deriveHeadDiverged.mockReturnValue(false);
  // Default: loadChangeSummary resolves with 0 changes (empty summary).
  // The 5 DB selects it fires (stories, objects, pages, glossary, project_config)
  // consume the FIRST 5 entries of makeContext queues — existing tests must
  // prepend 5 `[]` entries before their gh-status-specific rows.
  mocks.buildEntityHashes.mockResolvedValue({});
  mocks.computeChangeSummary.mockReturnValue(EMPTY_SUMMARY);
  // Default: installation holds workflows:write (no modal). Tests that exercise
  // the accept-gap override this.
  mocks.getInstallationInfo.mockResolvedValue({ workflowsWrite: true, targetType: "User" });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("api.site-status — gh-status payload", () => {
  describe("(A) stale cache + claim won → refreshGithubStatus IS called", () => {
    it("calls refreshGithubStatus when cache is stale and claim succeeds", async () => {
      mocks.isStale.mockReturnValue(true);
      mocks.claimRefresh.mockResolvedValue(true);

      // select queue: [proj row for stale check, proj row for re-read, config row]
      // (ghQueue prepends the 5 loadChangeSummary selects that now run first)
      const ctx = makeContext(ghQueue(
        [BASE_PROJECT_ROW],           // first select (stale check)
        [BASE_PROJECT_ROW],           // second select (re-read after refresh)
        [CONFIG_ROW],                 // project_config
      ));

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      expect(res.status).toBe(200);

      expect(mocks.claimRefresh).toHaveBeenCalledOnce();
      expect(mocks.refreshGithubStatus).toHaveBeenCalledOnce();
      expect(mocks.refreshGithubStatus).toHaveBeenCalledWith(
        BASE_PROJECT_ROW,
        "decrypted-token",
        expect.anything(),
        expect.any(Number),
      );
    });

    it("flags the workflows-permission cache as missing when the install lacks the grant (org-aware)", async () => {
      mocks.isStale.mockReturnValue(true);
      mocks.claimRefresh.mockResolvedValue(true);
      mocks.getInstallationInfo.mockResolvedValue({ workflowsWrite: false, targetType: "Organization" });

      const ctx = makeContext(ghQueue([BASE_PROJECT_ROW], [BASE_PROJECT_ROW], [CONFIG_ROW]));
      await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never);

      expect(mocks.getInstallationInfo).toHaveBeenCalledOnce();
      expect(recordedUpdates).toContainEqual({
        gh_workflows_write_missing: 1,
        gh_install_target_type: "Organization",
      });
    });

    it("clears the workflows-permission flag when the install holds the grant", async () => {
      mocks.isStale.mockReturnValue(true);
      mocks.claimRefresh.mockResolvedValue(true);
      mocks.getInstallationInfo.mockResolvedValue({ workflowsWrite: true, targetType: "User" });

      const ctx = makeContext(ghQueue([BASE_PROJECT_ROW], [BASE_PROJECT_ROW], [CONFIG_ROW]));
      await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never);

      expect(recordedUpdates).toContainEqual({
        gh_workflows_write_missing: 0,
        gh_install_target_type: "User",
      });
    });

    it("does NOT check installation permissions when the claim is lost (no duplicate work)", async () => {
      mocks.isStale.mockReturnValue(true);
      mocks.claimRefresh.mockResolvedValue(false);

      const ctx = makeContext(ghQueue([BASE_PROJECT_ROW], [BASE_PROJECT_ROW], [CONFIG_ROW]));
      await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never);

      expect(mocks.getInstallationInfo).not.toHaveBeenCalled();
    });

    it("returns DerivedGithubStatus shape derived from re-read row", async () => {
      mocks.isStale.mockReturnValue(true);
      mocks.claimRefresh.mockResolvedValue(true);
      mocks.deriveHeadDiverged.mockReturnValue(true);
      mocks.compareTelarVersion.mockReturnValue({ needsUpgrade: true, isBelowMinimum: false });

      const ctx = makeContext(ghQueue(
        [BASE_PROJECT_ROW],
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ));

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;

      expect(body).toMatchObject({
        repoUnavailable: false,        // gh_repo_available === 1
        headDiverged: true,            // mocked deriveHeadDiverged
        needsUpgrade: true,            // mocked compareTelarVersion
        isBelowMinimum: false,
        latestTelarTag: "v1.4.0",
      });
    });

    it("decrypts the token exactly once", async () => {
      mocks.isStale.mockReturnValue(true);
      mocks.claimRefresh.mockResolvedValue(true);

      const ctx = makeContext(ghQueue(
        [BASE_PROJECT_ROW],
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ));

      await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never);
      expect(mocks.decryptMock).toHaveBeenCalledOnce();
    });
  });

  describe("(B) fresh cache → refreshGithubStatus NOT called", () => {
    it("skips refresh entirely when cache is fresh", async () => {
      mocks.isStale.mockReturnValue(false);

      // select queue: [proj row, config row] — no re-read on the fresh path.
      const ctx = makeContext(ghQueue(
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ));

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      expect(res.status).toBe(200);

      expect(mocks.claimRefresh).not.toHaveBeenCalled();
      expect(mocks.refreshGithubStatus).not.toHaveBeenCalled();
    });

    it("returns derived values from the cached row when fresh", async () => {
      mocks.isStale.mockReturnValue(false);
      mocks.deriveHeadDiverged.mockReturnValue(false);
      mocks.compareTelarVersion.mockReturnValue({ needsUpgrade: false, isBelowMinimum: false });

      const ctx = makeContext(ghQueue(
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ));

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;

      expect(body).toMatchObject({
        repoUnavailable: false,
        headDiverged: false,
        needsUpgrade: false,
        isBelowMinimum: false,
        latestTelarTag: "v1.4.0",
      });
    });
  });

  describe("(C) stale cache + claim lost → refreshGithubStatus NOT called", () => {
    it("skips refresh when claim is not won", async () => {
      mocks.isStale.mockReturnValue(true);
      mocks.claimRefresh.mockResolvedValue(false); // another request won the claim

      const ctx = makeContext(ghQueue(
        [BASE_PROJECT_ROW],
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ));

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      expect(res.status).toBe(200);

      expect(mocks.claimRefresh).toHaveBeenCalledOnce();
      expect(mocks.refreshGithubStatus).not.toHaveBeenCalled();
    });

    it("still returns derived values from cache when claim lost", async () => {
      mocks.isStale.mockReturnValue(true);
      mocks.claimRefresh.mockResolvedValue(false);
      mocks.compareTelarVersion.mockReturnValue({ needsUpgrade: false, isBelowMinimum: true });

      const ctx = makeContext(ghQueue(
        [BASE_PROJECT_ROW],
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ));

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;

      expect(body).toMatchObject({
        repoUnavailable: false,
        isBelowMinimum: true,
        latestTelarTag: "v1.4.0",
      });
    });
  });

  describe("edge cases", () => {
    it("returns repoUnavailable: true when gh_repo_available === 0", async () => {
      mocks.isStale.mockReturnValue(false);
      mocks.deriveHeadDiverged.mockReturnValue(false);
      mocks.compareTelarVersion.mockReturnValue({ needsUpgrade: false, isBelowMinimum: false });

      const unavailableRow = { ...BASE_PROJECT_ROW, gh_repo_available: 0 };
      // Fresh path: proj row + config row (no re-read).
      const ctx = makeContext(ghQueue(
        [unavailableRow],
        [CONFIG_ROW],
      ));

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;

      expect(body.repoUnavailable).toBe(true);
    });

    it("handles missing project row gracefully (returns headDiverged: false)", async () => {
      mocks.isStale.mockReturnValue(false);
      mocks.compareTelarVersion.mockReturnValue({ needsUpgrade: false, isBelowMinimum: false });

      // Fresh path: proj row (empty) + config row (empty) — no re-read.
      const ctx = makeContext(ghQueue(
        [],      // no project row on first select
        [],      // no config row
      ));

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;

      expect(body.headDiverged).toBe(false);
      expect(body.repoUnavailable).toBe(false);
    });

    it("returns 400 if payload param is missing", async () => {
      const ctx = makeContext([]);
      await expect(
        loader({
          request: new Request("https://compositor.telar.org/api/site-status"),
          context: ctx as never,
          params: {},
        } as never),
      ).rejects.toMatchObject({ status: 400 });
    });

    it("returns 401 if user is not in context", async () => {
      const ctx = {
        get: () => undefined,
        cloudflare: { env: { DB: {}, SESSION_SECRET: "s", ENCRYPTION_KEY: "k" } },
      };
      await expect(
        loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never),
      ).rejects.toMatchObject({ status: 401 });
    });
  });

  describe("(D) fail-open on transient error", () => {
    it("returns 200 with cache-derived values when decrypt throws (proj undefined)", async () => {
      // decrypt throws before any DB read — proj stays undefined.
      mocks.decryptMock.mockRejectedValue(new Error("decrypt failure"));
      // isStale / compareTelarVersion won't be reached, but set safe defaults.
      mocks.isStale.mockReturnValue(false);
      mocks.compareTelarVersion.mockReturnValue({ needsUpgrade: false, isBelowMinimum: false });

      const ctx = makeContext([]); // no selects will succeed

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      // proj is undefined → both fields false; upgrade signal dropped on error.
      expect(body).toMatchObject({
        repoUnavailable: false,
        headDiverged: false,
        needsUpgrade: false,
        isBelowMinimum: false,
        latestTelarTag: null,
      });
    });

    it("returns 200 with cache-derived values when first db.select throws (proj undefined)", async () => {
      // decrypt succeeds, but the first DB select throws (D1 error).
      mocks.decryptMock.mockResolvedValue("decrypted-token");
      mocks.isStale.mockReturnValue(false);
      mocks.compareTelarVersion.mockReturnValue({ needsUpgrade: false, isBelowMinimum: false });

      // Override getDb to return a db whose select().from().where().limit() rejects.
      const throwingDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => { throw new Error("D1 unavailable"); }),
              then: (_res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
                Promise.reject(new Error("D1 unavailable")).catch(rej ?? ((e) => { throw e; })),
            })),
          })),
        })),
      };
      mocks.getDbMock.mockReturnValue(throwingDb);

      const env = { DB: {}, SESSION_SECRET: "secret", ENCRYPTION_KEY: "key" };
      const sessionStub = { get: vi.fn(() => undefined) };
      mocks.createSessionStorageMock.mockReturnValue({
        getSession: vi.fn(async () => sessionStub),
      });
      const ctx = {
        get: (key: unknown) => (key === mocks.userContext ? FAKE_USER : undefined),
        cloudflare: { env },
      };

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        repoUnavailable: false,
        headDiverged: false,
        needsUpgrade: false,
        isBelowMinimum: false,
        latestTelarTag: null,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // (E) unpublishedCount — real content-diff count via loadChangeSummary
  // ---------------------------------------------------------------------------
  describe("(E) unpublishedCount in gh-status response", () => {
    it("includes unpublishedCount: 3 when summary has 2 changed stories + 1 changed object", async () => {
      mocks.isStale.mockReturnValue(false); // fresh path — simplest queue

      // computeChangeSummary returns 2 modified stories + 1 new object → count 3
      const summaryWith3Changes = {
        ...EMPTY_SUMMARY,
        isUpToDate: false,
        stories: {
          new: [],
          modified: [
            { story_id: "s1", title: "Story One" },
            { story_id: "s2", title: "Story Two" },
          ],
          deleted: [],
        },
        objects: {
          new: [{ object_id: "o1", title: "Object One" }],
          modified: [],
          deleted: [],
        },
      };
      mocks.buildEntityHashes.mockResolvedValue({});
      mocks.computeChangeSummary.mockReturnValue(summaryWith3Changes);

      // loadChangeSummary fires 5 db selects (stories, objects, pages, glossary,
      // project_config). Then gh-status fires: proj row + config row (fresh path).
      // The queue is consumed in order by callIdx++.
      const ctx = makeContext([
        [],           // stories rows (loadChangeSummary)
        [],           // objects rows
        [],           // pages rows
        [],           // glossary rows
        [],           // project_config rows (loadChangeSummary)
        [BASE_PROJECT_ROW],  // projects row (gh-status)
        [CONFIG_ROW],        // project_config (gh-status)
      ]);

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.unpublishedCount).toBe(3);
    });

    it("includes unpublishedCount: 0 when summary reports everything up to date", async () => {
      mocks.isStale.mockReturnValue(false);
      mocks.buildEntityHashes.mockResolvedValue({});
      mocks.computeChangeSummary.mockReturnValue(EMPTY_SUMMARY);

      const ctx = makeContext([
        [], [], [], [], [],   // loadChangeSummary selects
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ]);

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;
      expect(body.unpublishedCount).toBe(0);
    });

    it("unpublishedCount: 0 overrides a stale loader value — 'in-sync' semantics preserved", async () => {
      // Pill's live poll returns count:0 even though the _app loader might have count:7.
      // This test confirms the response has the authoritative 0, not undefined.
      mocks.isStale.mockReturnValue(false);
      mocks.buildEntityHashes.mockResolvedValue({});
      mocks.computeChangeSummary.mockReturnValue(EMPTY_SUMMARY);

      const ctx = makeContext([
        [], [], [], [], [],
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ]);

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;
      // Must be exactly 0 (not undefined) so the client's ?? merge picks it up
      // correctly and overrides any stale loader proxy value.
      expect(body.unpublishedCount).toBe(0);
      expect(body).toHaveProperty("unpublishedCount");
    });

    it("unpublishedCount is undefined (absent or falsy) when loadChangeSummary throws", async () => {
      // When buildEntityHashes rejects, loadChangeSummary's catch sets
      // unpublishedCount=undefined → the field is present but undefined, so
      // the client falls back to the loader proxy.
      mocks.isStale.mockReturnValue(false);
      mocks.buildEntityHashes.mockRejectedValue(new Error("simulated D1 error"));

      const ctx = makeContext(ghQueue(
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ));

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;
      // undefined serialises to absent in JSON; either way it should not be a number
      expect(body.unpublishedCount == null).toBe(true);
    });

    it("counts settings changes: 1 changed settings field → unpublishedCount: 1", async () => {
      mocks.isStale.mockReturnValue(false);
      mocks.buildEntityHashes.mockResolvedValue({});
      mocks.computeChangeSummary.mockReturnValue({
        ...EMPTY_SUMMARY,
        isUpToDate: false,
        settings: { changed: [{ key: "title", label: "Title" }] },
      });

      const ctx = makeContext([
        [], [], [], [], [],
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ]);

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;
      expect(body.unpublishedCount).toBe(1);
    });

    it("counts landing and navigation changes as 1 each", async () => {
      mocks.isStale.mockReturnValue(false);
      mocks.buildEntityHashes.mockResolvedValue({});
      mocks.computeChangeSummary.mockReturnValue({
        ...EMPTY_SUMMARY,
        isUpToDate: false,
        landing: { changed: true },
        navigation: { changed: true },
      });

      const ctx = makeContext([
        [], [], [], [], [],
        [BASE_PROJECT_ROW],
        [CONFIG_ROW],
      ]);

      const res = await loader({ request: makeRequest("gh-status"), context: ctx as never, params: {} } as never) as Response;
      const body = await res.json() as Record<string, unknown>;
      expect(body.unpublishedCount).toBe(2);
    });
  });
});
