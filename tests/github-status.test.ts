/**
 * Tests for the github-status.server helpers: version comparison, staleness,
 * the latest-tag cache (success TTL, failure retry, shared lookups, rate
 * limits), the refresh claim, the two head-bump writers, and the refreshGithubStatus
 * waterfall they compose into.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted mocks for the GitHub waterfall + sync helpers that
// refreshGithubStatus orchestrates. `vi.hoisted` so the const handles
// exist before the hoisted `vi.mock` factories run.
const mocks = vi.hoisted(() => ({
  checkRepoAvailabilityMock: vi.fn(),
  getRepoHeadMock: vi.fn(),
  computeFullSyncDiffMock: vi.fn(),
  hasDivergentChangesMock: vi.fn(),
}));

vi.mock("~/lib/github.server", () => ({
  checkRepoAvailability: mocks.checkRepoAvailabilityMock,
  getRepoHead: mocks.getRepoHeadMock,
  // The site has no story subtrees at either commit here, which is no change,
  // so the refresh falls through to the existing diff;
  // tests/github-status-story-files.test.ts covers the trees themselves.
  getSubtreeOids: () => Promise.resolve({ ok: true, at: () => ({ kind: "absent" }) }),
  getRepoTree: () => Promise.reject(new Error("no listing expected")),
  // Real enough for the tag cache's one live call: fetchLatestRelease reaches
  // through this module for its request headers.
  githubHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
}));

vi.mock("~/lib/sync.server", () => ({
  computeFullSyncDiff: mocks.computeFullSyncDiffMock,
  hasDivergentChanges: mocks.hasDivergentChangesMock,
}));

// getDb is not invoked by the functions under test (the fake db is passed
// in directly), but the module imports it — stub it so the import resolves
// without pulling in the real D1/Drizzle machinery.
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
// The objects lease is free and D1's compared rows are as the verdict read
// them; tests/github-status-record-lease.test.ts covers the other cases.
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "refresh-lease"),
}));
vi.mock("~/lib/synced-rows-fingerprint.server", () => ({ syncedRowsFingerprint: vi.fn(async () => "as-compared") }));
// The site's framework version, which the diff matches objects by.
vi.mock("~/lib/site-version.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  readSiteTelarVersion: vi.fn(async () => "1.8.0"),
}));

import { compareTelarVersion } from "~/lib/telar-version";
import { CollidingColumnsRefusal } from "~/lib/import.server";
import {
  isStale,
  deriveHeadDiverged,
  STATUS_TTL_MS,
  __resetTagCacheForTest,
  getCachedLatestTagIfWarm,
  getCachedLatestTag,
  readLatestTag,
  readWarmLatestTag,
  __setTagClockForTest,
  TAG_TTL_MS,
  TAG_FAILURE_RETRY_MS,
  claimRefresh,
  bumpProjectHeadFrom,
  refreshGithubStatus,
  deriveWorkflowsApproval,
} from "~/lib/github-status.server";
import { readableHeadWrite } from "./helpers/head-write";

// ---------------------------------------------------------------------------
// Fake Drizzle db. Records every `.set({...})` payload in order, and every
// `.where(cond)` condition alongside it, so tests can assert exactly which
// writes happened, with what columns, and against what row.
//
// Supports:
//   db.update(table).set(payload).where(cond)              -> awaitable, resolves []
//   db.update(table).set(payload).where(cond).returning(_) -> resolves a configurable
//                                                             row array (for claimRefresh)
//
// `nextReturning` is a queue: each `.returning()` call shifts the next array.
// ---------------------------------------------------------------------------
interface FakeDb {
  sets: Record<string, unknown>[];
  wheres: unknown[];
  nextReturning: unknown[][];
  update: (table: unknown) => { set: (payload: Record<string, unknown>) => unknown };
  /** Reads answer with no rows: a site with no stories. */
  select: () => { from: () => { where: () => Promise<unknown[]> } };
}

function makeFakeDb(returningQueue: unknown[][] = []): FakeDb {
  const db: FakeDb = {
    sets: [],
    wheres: [],
    nextReturning: returningQueue,
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    update(_table: unknown) {
      return {
        set: (payload: Record<string, unknown>) => {
          db.sets.push(readableHeadWrite(payload));
          const whereResult = {
            // `.returning()` for the claim path.
            returning: (_cols?: unknown) =>
              Promise.resolve(db.nextReturning.shift() ?? []),
            // Awaitable directly (head/cache writes don't call .returning()).
            then: (resolve: (v: unknown[]) => unknown) => resolve([]),
          };
          return {
            where: (cond: unknown) => {
              db.wheres.push(cond);
              return whereResult;
            },
          };
        },
      };
    },
  };
  return db;
}

// Walk a Drizzle SQL condition tree (as built by `eq`/`and`) and check whether
// it compares the given column name against the given value anywhere. Drizzle
// conditions are `SQL` nodes exposing `queryChunks`; a column chunk carries a
// `name` + `columnType`, immediately followed (within the same `eq(...)`
// sub-node) by a `Param` chunk carrying the literal `value`. Tracking the most
// recently seen column name while walking each `queryChunks` array in order
// lets us pair a `Param` with the column it belongs to, rather than just
// checking whether the value appears anywhere in the tree.
function drizzleWhereComparesColumnToValue(
  node: unknown,
  columnName: string,
  value: unknown,
  lastColumn: { name: string | null } = { name: null },
): boolean {
  if (node === null || node === undefined || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  const ctorName = (obj.constructor as { name?: string } | undefined)?.name;
  if (typeof obj.name === "string" && "columnType" in obj) {
    lastColumn.name = obj.name;
  }
  if ("value" in obj && ctorName === "Param") {
    return lastColumn.name === columnName && obj.value === value;
  }
  if (Array.isArray(obj.queryChunks)) {
    for (const chunk of obj.queryChunks) {
      if (drizzleWhereComparesColumnToValue(chunk, columnName, value, lastColumn)) return true;
    }
  }
  return false;
}

beforeEach(() => {
  mocks.checkRepoAvailabilityMock.mockReset();
  mocks.getRepoHeadMock.mockReset();
  mocks.computeFullSyncDiffMock.mockReset();
  mocks.hasDivergentChangesMock.mockReset();
});

describe("compareTelarVersion (pure)", () => {
  it("flags needsUpgrade when latest is ahead of site version", () => {
    const r = compareTelarVersion("1.3.0", "v1.4.0");
    expect(r.needsUpgrade).toBe(true);
  });
  it("no upgrade when site equals latest (with/without v prefix)", () => {
    expect(compareTelarVersion("1.4.0", "v1.4.0").needsUpgrade).toBe(false);
    expect(compareTelarVersion("v1.4.0", "v1.4.0").needsUpgrade).toBe(false);
  });
  it("fails open (no upgrade) when latestTag is null", () => {
    expect(compareTelarVersion("1.3.0", null).needsUpgrade).toBe(false);
  });
  it("fails open (no upgrade) when siteVersion is null", () => {
    expect(compareTelarVersion(null, "v1.4.0").needsUpgrade).toBe(false);
  });
  it("isBelowMinimum is true when site version is strictly below MIN_SUPPORTED_VERSION (v0.9.0-beta)", () => {
    // v0.8.0 < v0.9.0-beta
    const r = compareTelarVersion("0.8.0", "v1.4.0");
    expect(r.isBelowMinimum).toBe(true);
  });
  it("isBelowMinimum is false when site version is at or above MIN_SUPPORTED_VERSION (v0.9.0-beta)", () => {
    // v1.4.0 >= v0.9.0-beta
    const r = compareTelarVersion("1.4.0", "v1.4.0");
    expect(r.isBelowMinimum).toBe(false);
  });
});

describe("isStale", () => {
  const now = Date.parse("2026-05-31T12:00:00.000Z");
  it("cold cache (null) is stale", () => expect(isStale(null, now)).toBe(true));
  it("fresh within TTL is not stale", () =>
    expect(isStale(new Date(now - 1000).toISOString(), now)).toBe(false));
  it("older than TTL is stale", () =>
    expect(isStale(new Date(now - STATUS_TTL_MS - 1).toISOString(), now)).toBe(true));
});

describe("deriveHeadDiverged (SHA-tagged verdict)", () => {
  const base = { gh_diverged: 1, gh_diverged_against_sha: "localA", gh_remote_head_sha: "remoteB" };
  it("true when verdict applies to current local head and remote differs", () =>
    expect(deriveHeadDiverged({ ...base } as any, "localA")).toBe(true));
  it("false when local head changed since the verdict (e.g. after publish)", () =>
    expect(deriveHeadDiverged({ ...base } as any, "localZ")).toBe(false));
  it("false when verdict bool is 0", () =>
    expect(deriveHeadDiverged({ ...base, gh_diverged: 0 } as any, "localA")).toBe(false));
  it("false on cold cache (nulls)", () =>
    expect(deriveHeadDiverged({ gh_diverged: null, gh_diverged_against_sha: null, gh_remote_head_sha: null } as any, "localA")).toBe(false));
});

describe("getCachedLatestTagIfWarm", () => {
  it("returns undefined when cold (never fetched)", () => {
    __resetTagCacheForTest();
    expect(getCachedLatestTagIfWarm(Date.parse("2026-05-31T12:00:00Z"))).toBeUndefined();
  });
});

const NOW = Date.parse("2026-05-31T12:00:00.000Z");
/** The objects lease a refresh records a head under. */
const LEASE = { env: {} as never, userId: 1 };

describe("getCachedLatestTag", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetTagCacheForTest();
  });

  it("carries a pinned release tag through to the GitHub request", async () => {
    __resetTagCacheForTest();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v1.7.0-rc.1",
        body: "rc notes",
        published_at: "2026-09-01T00:00:00Z",
      }),
    });

    const tag = await getCachedLatestTag("tok", NOW, "v1.7.0-rc.1");

    expect(tag).toBe("v1.7.0-rc.1");
    const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(url).toContain("/releases/tags/v1.7.0-rc.1");
  });

  it("asks for the newest published release when no tag is pinned", async () => {
    __resetTagCacheForTest();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: "v1.6.2",
        body: "notes",
        published_at: "2026-07-17T00:00:00Z",
      }),
    });

    const tag = await getCachedLatestTag("tok", NOW);

    expect(tag).toBe("v1.6.2");
    const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(url).toContain("/releases/latest");
  });
});

// The tag cache holds a success for TAG_TTL_MS and a failure, as a failure,
// for TAG_FAILURE_RETRY_MS or until GitHub's rate-limit answer allows the
// next request, whichever is later. Time is injected through `now`.
describe("the latest-tag cache", () => {
  const realFetch = globalThis.fetch;

  function releaseResponse(tag: string) {
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ tag_name: tag, body: "", published_at: "2026-09-01T00:00:00Z" }),
    };
  }
  function errorResponse(status: number, headers: Record<string, string> = {}) {
    return { ok: false, status, headers: new Headers(headers), json: async () => ({}) };
  }
  function fetchCalls(): number {
    return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
  }

  // A lookup answers instantly unless a case says otherwise: the failure is
  // received at the `now` the caller passed.
  beforeEach(() => {
    __resetTagCacheForTest();
    __setTagClockForTest(() => NOW);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetTagCacheForTest();
  });

  it("keeps a success for ten minutes and looks again after", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(releaseResponse("v1.8.0"));

    expect(await readLatestTag("tok", NOW)).toEqual({ ok: true, tag: "v1.8.0" });
    expect(await readLatestTag("tok", NOW + TAG_TTL_MS)).toEqual({ ok: true, tag: "v1.8.0" });
    expect(fetchCalls()).toBe(1);

    expect(readWarmLatestTag(NOW + TAG_TTL_MS + 1)).toBeUndefined();
    await readLatestTag("tok", NOW + TAG_TTL_MS + 1);
    expect(fetchCalls()).toBe(2);
  });

  it("retries a failed lookup after 30 seconds and not before", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(502));

    expect(await readLatestTag("tok", NOW)).toEqual({ ok: false });
    expect(TAG_FAILURE_RETRY_MS).toBe(30_000);

    // Both readers see the failure until it expires.
    expect(readWarmLatestTag(NOW + 29_999)).toEqual({ ok: false });
    expect(getCachedLatestTagIfWarm(NOW + 29_999)).toBeNull();
    expect(await readLatestTag("tok", NOW + 29_999)).toEqual({ ok: false });
    expect(fetchCalls()).toBe(1);

    expect(readWarmLatestTag(NOW + 30_000)).toBeUndefined();
    expect(getCachedLatestTagIfWarm(NOW + 30_000)).toBeUndefined();
    globalThis.fetch = vi.fn().mockResolvedValue(releaseResponse("v1.8.0"));
    expect(await readLatestTag("tok", NOW + 30_000)).toEqual({ ok: true, tag: "v1.8.0" });
    expect(fetchCalls()).toBe(1);
  });

  it("records a network failure the same way", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    expect(await readLatestTag("tok", NOW)).toEqual({ ok: false });
    expect(readWarmLatestTag(NOW + 29_999)).toEqual({ ok: false });
    expect(readWarmLatestTag(NOW + 30_000)).toBeUndefined();
  });

  it("answers a failure as null to the tag-or-null readers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(500));

    expect(await getCachedLatestTag("tok", NOW)).toBeNull();
    expect(getCachedLatestTagIfWarm(NOW + 1)).toBeNull();
  });

  it("answers a pinned release that cannot be fetched as a failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(404));

    expect(await readLatestTag("tok", NOW, "v1.8.0-rc.1")).toEqual({ ok: false });
    const url = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain("/releases/tags/v1.8.0-rc.1");
  });

  it("shares one request among concurrent lookups", async () => {
    let answer!: (value: unknown) => void;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { answer = resolve; })) as unknown as typeof fetch;

    const first = readLatestTag("tok", NOW);
    const second = readLatestTag("tok", NOW);
    answer(releaseResponse("v1.8.0"));

    expect(await first).toEqual({ ok: true, tag: "v1.8.0" });
    expect(await second).toEqual({ ok: true, tag: "v1.8.0" });
    expect(fetchCalls()).toBe(1);
  });

  it("starts a new request once the shared one has settled", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(503));

    await Promise.all([readLatestTag("tok", NOW), readLatestTag("tok", NOW)]);
    await readLatestTag("tok", NOW + TAG_FAILURE_RETRY_MS);

    expect(fetchCalls()).toBe(2);
  });

  it("waits for x-ratelimit-reset when the rate limit is exhausted", async () => {
    const resetSeconds = NOW / 1000 + 120;
    globalThis.fetch = vi.fn().mockResolvedValue(
      errorResponse(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) }),
    );

    await readLatestTag("tok", NOW);
    expect(await readLatestTag("tok", NOW + 119_999)).toEqual({ ok: false });
    expect(fetchCalls()).toBe(1);

    await readLatestTag("tok", NOW + 120_000);
    expect(fetchCalls()).toBe(2);
  });

  it("waits for Retry-After on a 429", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(429, { "retry-after": "90" }));

    await readLatestTag("tok", NOW);
    expect(readWarmLatestTag(NOW + 89_999)).toEqual({ ok: false });
    expect(readWarmLatestTag(NOW + 90_000)).toBeUndefined();
  });

  it("counts the 30 seconds from when a slow failure arrives, not from when it was asked", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(502));
    __setTagClockForTest(() => NOW + 40_000);

    await readLatestTag("tok", NOW);

    expect(readWarmLatestTag(NOW + 40_000 + 29_999)).toEqual({ ok: false });
    expect(readWarmLatestTag(NOW + 40_000 + 30_000)).toBeUndefined();
  });

  it("counts Retry-After from when the 429 arrives", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(429, { "retry-after": "90" }));
    __setTagClockForTest(() => NOW + 40_000);

    await readLatestTag("tok", NOW);

    expect(readWarmLatestTag(NOW + 40_000 + 89_999)).toEqual({ ok: false });
    expect(readWarmLatestTag(NOW + 40_000 + 90_000)).toBeUndefined();
  });

  it("never retries sooner than 30 seconds, whatever the headers say", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(429, { "retry-after": "1" }));

    await readLatestTag("tok", NOW);
    expect(readWarmLatestTag(NOW + 29_999)).toEqual({ ok: false });
  });

  it("ignores x-ratelimit-reset on a 403 with requests remaining", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      errorResponse(403, { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(NOW / 1000 + 3600) }),
    );

    await readLatestTag("tok", NOW);
    expect(readWarmLatestTag(NOW + TAG_FAILURE_RETRY_MS)).toBeUndefined();
  });
});

describe("claimRefresh", () => {
  it("returns true when the conditional update claims exactly one row", async () => {
    const db = makeFakeDb([[{ id: 7 }]]);
    const won = await claimRefresh(db as any, 7, NOW);
    expect(won).toBe(true);
  });

  it("returns false when the conditional update claims no rows (already fresh)", async () => {
    const db = makeFakeDb([[]]);
    const won = await claimRefresh(db as any, 7, NOW);
    expect(won).toBe(false);
  });

  it("writes a real gh_checked_at on the claim", async () => {
    const db = makeFakeDb([[{ id: 7 }]]);
    await claimRefresh(db as any, 7, NOW);
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0].gh_checked_at).toBe(new Date(NOW).toISOString());
  });
});

describe("bumpProjectHeadFrom (compare-and-set)", () => {
  it("writes the new head and invalidates the cache when the row still sits at the old one", async () => {
    const db = makeFakeDb([[{ id: 7 }]]);
    const recorded = await bumpProjectHeadFrom(db as any, 7, "oldsha", "newsha", NOW);
    expect(recorded).toBe(true);
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).toMatchObject({ head_sha: "newsha", gh_checked_at: null });
  });

  it("advances objects_read_sha with the head, only from the head it replaces", async () => {
    const db = makeFakeDb([[{ id: 7 }]]);
    await bumpProjectHeadFrom(db as any, 7, "oldsha", "newsha", NOW);
    expect(db.sets[0]).toMatchObject({
      objects_read_sha: "newsha",
      objects_read_sha_from: "oldsha",
      objects_read_sha_while_head: "oldsha",
    });
  });

  it("guards the write with the project id and the old head, so an unconditional update would fail this assertion", async () => {
    const db = makeFakeDb([[{ id: 7 }]]);
    await bumpProjectHeadFrom(db as any, 7, "oldsha", "newsha", NOW);
    expect(db.wheres).toHaveLength(1);
    const cond = db.wheres[0];
    expect(drizzleWhereComparesColumnToValue(cond, "id", 7)).toBe(true);
    expect(drizzleWhereComparesColumnToValue(cond, "head_sha", "oldsha")).toBe(true);
    // The new head must not appear as the compare-and-set condition — only as
    // the write payload asserted above.
    expect(drizzleWhereComparesColumnToValue(cond, "head_sha", "newsha")).toBe(false);
  });

  it("reports no write when another writer already recorded a newer head", async () => {
    const db = makeFakeDb([[]]);
    const recorded = await bumpProjectHeadFrom(db as any, 7, "oldsha", "newsha", NOW);
    expect(recorded).toBe(false);
  });
});

describe("refreshGithubStatus", () => {
  const baseProject = {
    id: 7,
    head_sha: "localHead",
    github_repo_full_name: "owner/repo",
  };

  it("(a) remote head === local head: no diff call, exactly one in-sync write, no head_sha", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
    mocks.getRepoHeadMock.mockResolvedValue("localHead");
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW, LEASE);

    expect(mocks.computeFullSyncDiffMock).not.toHaveBeenCalled();
    expect(db.sets).toHaveLength(1);
    const final = db.sets[0];
    expect(final).not.toHaveProperty("head_sha");
    expect(final).toMatchObject({
      gh_repo_available: 1,
      gh_remote_head_sha: "localHead",
      gh_diverged: 0,
      gh_checked_at: new Date(NOW).toISOString(),
    });
    // The verdict and its stamp land only while the head is the one loaded.
    expect(final).toMatchObject({
      gh_checked_at_while_head: "localHead",
      gh_diverged_while_head: "localHead",
      gh_diverged_against_sha_while_head: "localHead",
    });
  });

  it("(b) remote !== local, divergent: one write, gh_diverged=1 against local head, no head_sha", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
    mocks.computeFullSyncDiffMock.mockResolvedValue({ stub: true });
    mocks.hasDivergentChangesMock.mockReturnValue(true);
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW, LEASE);

    expect(mocks.computeFullSyncDiffMock).toHaveBeenCalledOnce();
    expect(mocks.computeFullSyncDiffMock.mock.calls[0][6]).toEqual({
      headRef: "remoteHead", frameworkVersion: "1.8.0", legacyRef: "localHead",
    });
    expect(db.sets).toHaveLength(1);
    const final = db.sets[0];
    expect(final).not.toHaveProperty("head_sha");
    expect(final).toMatchObject({
      gh_diverged: 1,
      gh_diverged_against_sha: "localHead",
      gh_remote_head_sha: "remoteHead",
    });
  });

  it("(c) remote !== local, NOT divergent: ONE atomic write folds head advance + verdict", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
    mocks.computeFullSyncDiffMock.mockResolvedValue({ stub: true });
    mocks.hasDivergentChangesMock.mockReturnValue(false);
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW, LEASE);

    // Single write: head_sha advance AND the verdict land together atomically.
    expect(db.sets).toHaveLength(1);
    const final = db.sets[0];
    expect(final).toHaveProperty("head_sha", "remoteHead");
    expect(final.gh_checked_at).toBe(new Date(NOW).toISOString());
    expect(final.gh_checked_at).not.toBeNull();
    expect(final).toMatchObject({
      head_sha: "remoteHead",
      gh_diverged: 0,
      gh_diverged_against_sha: "remoteHead",
      gh_remote_head_sha: "remoteHead",
    });
    // Compare-and-set from the head the verdict was computed against, so a
    // head another writer recorded since the load is kept.
    expect(final.head_sha_from).toBe("localHead");
    // The diff read objects.csv at the new head, so the record advances with
    // it, from the head it replaces only.
    expect(final).toMatchObject({
      objects_read_sha: "remoteHead",
      objects_read_sha_from: "localHead",
      objects_read_sha_while_head: "localHead",
    });
  });

  it("(d) unavailable: writes gh_repo_available=0 + real gh_checked_at, returns early", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "unavailable", canonicalFullName: null });
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW, LEASE);

    expect(mocks.computeFullSyncDiffMock).not.toHaveBeenCalled();
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).toMatchObject({
      gh_repo_available: 0,
      gh_checked_at: new Date(NOW).toISOString(),
    });
  });

  it("(e) local head null + remote present: ONE write backfills head_sha + in-sync verdict", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
    const db = makeFakeDb();

    await refreshGithubStatus(
      { ...baseProject, head_sha: null },
      "tok",
      db as any,
      NOW,
      LEASE,
    );

    // After backfill, local === remote, so no diff call and in-sync verdict.
    expect(mocks.computeFullSyncDiffMock).not.toHaveBeenCalled();
    // Single write folds the backfill into the cache write.
    expect(db.sets).toHaveLength(1);
    const final = db.sets[0];
    expect(final).toMatchObject({
      head_sha: "remoteHead",
      gh_diverged: 0,
      gh_remote_head_sha: "remoteHead",
      gh_checked_at: new Date(NOW).toISOString(),
    });
    // Compare-and-set from no head recorded.
    expect(final).toHaveProperty("head_sha_from", null);
    // The backfill compares rendered stories and reads no objects.csv.
    expect(final).not.toHaveProperty("objects_read_sha");
  });

  it("(f) repo available but getRepoHead null: no cache write, prior verdict preserved", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
    mocks.getRepoHeadMock.mockRejectedValue(new Error("fetch failed"));
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW, LEASE);

    expect(mocks.computeFullSyncDiffMock).not.toHaveBeenCalled();
    expect(db.sets).toHaveLength(0);
  });

  // A sheet the sync refuses for its colliding columns has changed since the
  // local head, so the probe reports the repo as diverged, as for any diff it
  // cannot compute; the sync the banner leads to names the columns.
  it("(f2) the diff refuses a sheet for its colliding columns: no throw, gh_diverged=1, head left alone", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
    mocks.computeFullSyncDiffMock.mockRejectedValue(
      new CollidingColumnsRefusal("objects.csv", "medium_genre", ["medium", "object_type"]),
    );
    const db = makeFakeDb();

    await expect(refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW, LEASE)).resolves.toBeUndefined();

    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({
      gh_diverged: 1,
      gh_diverged_against_sha: "localHead",
      gh_remote_head_sha: "remoteHead",
    });
  });

  it("(g) rename-healing: canonical full_name differs from stored, folded into the single write", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({
      availability: "available",
      canonicalFullName: "owner/renamed-repo",
    });
    mocks.getRepoHeadMock.mockResolvedValue("localHead");
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW, LEASE);

    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).toMatchObject({
      github_repo_full_name: "owner/renamed-repo",
      gh_repo_available: 1,
      gh_checked_at: new Date(NOW).toISOString(),
    });
  });

  it("(h) canonical full_name matches stored: no github_repo_full_name write", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue({
      availability: "available",
      canonicalFullName: "owner/repo",
    });
    mocks.getRepoHeadMock.mockResolvedValue("localHead");
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW, LEASE);

    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).not.toHaveProperty("github_repo_full_name");
  });
});

describe("refreshGithubStatus and a file read lossily at the head", () => {
  // The diff the refresh gets when the only change from the base turned the
  // valid encoding of U+FFFD in objects.csv into an invalid byte: equal text,
  // and the file named as unreadable.
  function diffWith(unreadableFiles: string[]) {
    return {
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
      stories: { newStories: [], changedStories: [], missingStories: [] },
      config: { changedFields: [], versionChange: null },
      glossary: { added: [], removed: [], changed: [] },
      hasConflicts: false,
      classification: "three-way" as const,
      suppressedEditorOnly: 0,
      unreadableFiles,
    };
  }

  const project = { id: 7, head_sha: "localHead", github_repo_full_name: "owner/repo" };

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("~/lib/sync.server")>("~/lib/sync.server");
    mocks.hasDivergentChangesMock.mockImplementation(actual.hasDivergentChanges);
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
  });

  it("is divergence, and advances neither head_sha nor objects_read_sha", async () => {
    mocks.computeFullSyncDiffMock.mockResolvedValue(diffWith(["objects.csv"]));
    const db = makeFakeDb();

    await refreshGithubStatus({ ...project }, "tok", db as any, NOW, LEASE);

    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).not.toHaveProperty("objects_read_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "localHead" });
  });

  it("with the valid encoding of U+FFFD, advances the head as before", async () => {
    mocks.computeFullSyncDiffMock.mockResolvedValue(diffWith([]));
    const db = makeFakeDb();

    await refreshGithubStatus({ ...project }, "tok", db as any, NOW, LEASE);

    expect(db.sets[0]).toMatchObject({ head_sha: "remoteHead", objects_read_sha: "remoteHead", gh_diverged: 0 });
  });

  it("is not divergence once the author's sync has recorded that head", async () => {
    const db = makeFakeDb();

    await refreshGithubStatus({ ...project, head_sha: "remoteHead" }, "tok", db as any, NOW, LEASE);

    expect(mocks.computeFullSyncDiffMock).not.toHaveBeenCalled();
    expect(db.sets[0]).toMatchObject({ gh_diverged: 0 });
  });

  it("is not a change the dashboard's check offers, so that check records the head", async () => {
    const { hasDiffChanges } = await import("~/components/features/dashboard/sync-changes");
    expect(hasDiffChanges(diffWith(["objects.csv"]) as never)).toBe(false);
  });
});

describe("refreshGithubStatus and a row D1 holds under a stripped id", () => {
  // Nothing changed on GitHub but a commit that moves the head; D1 still holds
  // `o1` where the recorded version and GitHub both write `o1  `.
  const diff = {
    objects: {
      newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null,
      respelled: [{ objectId: "o1", docId: 1, githubId: "o1  " }],
    },
    stories: { newStories: [], changedStories: [], missingStories: [] },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], removed: [], changed: [] },
    hasConflicts: false,
    classification: "three-way" as const,
    suppressedEditorOnly: 0,
    unreadableFiles: [],
  };
  const project = { id: 7, head_sha: "localHead", github_repo_full_name: "owner/repo" };

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("~/lib/sync.server")>("~/lib/sync.server");
    mocks.hasDivergentChangesMock.mockImplementation(actual.hasDivergentChanges);
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
  });

  // Judged against the commit D1's object rows are from, else the head, and
  // only until the project's ids have been repaired.
  it("pairs such rows against objects_read_sha, else head_sha, until the ids have been repaired", async () => {
    mocks.computeFullSyncDiffMock.mockResolvedValue({ ...diff, objects: { ...diff.objects, respelled: undefined } });
    await refreshGithubStatus({ ...project, objects_read_sha: "readSha" }, "tok", makeFakeDb() as any, NOW, LEASE);
    await refreshGithubStatus({ ...project }, "tok", makeFakeDb() as any, NOW, LEASE);
    await refreshGithubStatus({ ...project, legacy_ids_repaired_at: "2026-09-30" }, "tok", makeFakeDb() as any, NOW, LEASE);
    expect(mocks.computeFullSyncDiffMock.mock.calls.map((call) => call[6].legacyRef)).toEqual(["readSha", "localHead", undefined]);
  });

  it("advances the head for the same diff with no such row", async () => {
    mocks.computeFullSyncDiffMock.mockResolvedValue({ ...diff, objects: { ...diff.objects, respelled: undefined } });
    const db = makeFakeDb();

    await refreshGithubStatus({ ...project }, "tok", db as any, NOW, LEASE);

    expect(db.sets[0]).toMatchObject({ head_sha: "remoteHead", objects_read_sha: "remoteHead", gh_diverged: 0 });
  });

  it("is divergence, so the author is sent to a sync, and advances neither head_sha nor objects_read_sha", async () => {
    mocks.computeFullSyncDiffMock.mockResolvedValue(diff);
    const db = makeFakeDb();

    await refreshGithubStatus({ ...project }, "tok", db as any, NOW, LEASE);

    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).not.toHaveProperty("objects_read_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "localHead" });
  });
});

describe("deriveWorkflowsApproval", () => {
  const base = {
    workflowsWriteMissing: 1 as number | null,
    targetType: "User" as string | null,
    installationId: 124561975,
    repoFullName: "olympia-m/my-site",
    role: "convenor" as "convenor" | "collaborator" | null,
  };

  it("flags approval needed for a convenor on a user install, linking the bare installation page", () => {
    const r = deriveWorkflowsApproval(base);
    expect(r.needed).toBe(true);
    expect(r.url).toBe("https://github.com/settings/installations/124561975");
  });

  it("uses the org-scoped URL for an organization install", () => {
    const r = deriveWorkflowsApproval({ ...base, targetType: "Organization", repoFullName: "Group-9-UCSB/site" });
    expect(r.needed).toBe(true);
    expect(r.url).toBe("https://github.com/organizations/Group-9-UCSB/settings/installations/124561975");
  });

  it("does NOT flag for a collaborator (only the install owner can approve)", () => {
    const r = deriveWorkflowsApproval({ ...base, role: "collaborator" });
    expect(r.needed).toBe(false);
    expect(r.url).toBeNull();
  });

  it("does NOT flag when workflows is present (0)", () => {
    expect(deriveWorkflowsApproval({ ...base, workflowsWriteMissing: 0 }).needed).toBe(false);
  });

  it("does NOT flag when the cache is cold (null) — fail-open", () => {
    expect(deriveWorkflowsApproval({ ...base, workflowsWriteMissing: null }).needed).toBe(false);
  });
});

describe("refreshGithubStatus and a heading-only edit", () => {
  const diff = {
    objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
    stories: { newStories: [], changedStories: [], missingStories: [] },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], removed: [], changed: [] },
    hasConflicts: false,
    classification: "three-way" as const,
    suppressedEditorOnly: 0,
    unreadableFiles: [],
  };
  const project = { id: 7, head_sha: "localHead", github_repo_full_name: "owner/repo" };

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("~/lib/sync.server")>("~/lib/sync.server");
    mocks.hasDivergentChangesMock.mockImplementation(actual.hasDivergentChanges);
    mocks.checkRepoAvailabilityMock.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
  });

  it.each(["objects.csv", "project.csv", "glossary.csv"])("does not record the head when %s's headings moved", async (file) => {
    mocks.computeFullSyncDiffMock.mockResolvedValue({ ...diff, headingFiles: [file] });
    const db = makeFakeDb();

    await refreshGithubStatus({ ...project }, "tok", db as any, NOW, LEASE);

    expect(db.sets[0]).not.toHaveProperty("head_sha");
    expect(db.sets[0]).toMatchObject({ gh_diverged: 1, gh_diverged_against_sha: "localHead" });
  });

  it("records the head when no heading moved", async () => {
    mocks.computeFullSyncDiffMock.mockResolvedValue({ ...diff, headingFiles: [] });
    const db = makeFakeDb();

    await refreshGithubStatus({ ...project }, "tok", db as any, NOW, LEASE);

    expect(db.sets[0]).toMatchObject({ head_sha: "remoteHead", gh_diverged: 0 });
  });

  it("is no change the dashboard's check offers, so that check records the head", async () => {
    const { hasDiffChanges } = await import("~/components/features/dashboard/sync-changes");
    expect(hasDiffChanges({ ...diff, headingFiles: ["objects.csv"] } as never)).toBe(false);
  });
});
