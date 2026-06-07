import { describe, it, expect, vi, beforeEach } from "vitest";

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
}));

vi.mock("~/lib/sync.server", () => ({
  computeFullSyncDiff: mocks.computeFullSyncDiffMock,
  hasDivergentChanges: mocks.hasDivergentChangesMock,
}));

// getDb is not invoked by the functions under test (the fake db is passed
// in directly), but the module imports it — stub it so the import resolves
// without pulling in the real D1/Drizzle machinery.
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));

import { compareTelarVersion } from "~/lib/upgrade.server";
import {
  isStale,
  deriveHeadDiverged,
  STATUS_TTL_MS,
  __resetTagCacheForTest,
  getCachedLatestTagIfWarm,
  claimRefresh,
  bumpProjectHead,
  refreshGithubStatus,
  deriveWorkflowsApproval,
} from "~/lib/github-status.server";

// ---------------------------------------------------------------------------
// Fake Drizzle db. Records every `.set({...})` payload in order so tests can
// assert exactly which writes happened and with what columns.
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
  nextReturning: unknown[][];
  update: (table: unknown) => { set: (payload: Record<string, unknown>) => unknown };
}

function makeFakeDb(returningQueue: unknown[][] = []): FakeDb {
  const db: FakeDb = {
    sets: [],
    nextReturning: returningQueue,
    update(_table: unknown) {
      return {
        set: (payload: Record<string, unknown>) => {
          db.sets.push(payload);
          const whereResult = {
            // `.returning()` for the claim path.
            returning: (_cols?: unknown) =>
              Promise.resolve(db.nextReturning.shift() ?? []),
            // Awaitable directly (head/cache writes don't call .returning()).
            then: (resolve: (v: unknown[]) => unknown) => resolve([]),
          };
          return { where: (_cond: unknown) => whereResult };
        },
      };
    },
  };
  return db;
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

describe("bumpProjectHead (cache invalidator)", () => {
  it("sets head_sha AND nulls gh_checked_at", async () => {
    const db = makeFakeDb();
    await bumpProjectHead(db as any, 7, "newsha", NOW);
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).toMatchObject({ head_sha: "newsha", gh_checked_at: null });
  });
});

describe("refreshGithubStatus", () => {
  const baseProject = {
    id: 7,
    head_sha: "localHead",
    github_repo_full_name: "owner/repo",
  };

  it("(a) remote head === local head: no diff call, exactly one in-sync write, no head_sha", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue("available");
    mocks.getRepoHeadMock.mockResolvedValue("localHead");
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW);

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
  });

  it("(b) remote !== local, divergent: one write, gh_diverged=1 against local head, no head_sha", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue("available");
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
    mocks.computeFullSyncDiffMock.mockResolvedValue({ stub: true });
    mocks.hasDivergentChangesMock.mockReturnValue(true);
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW);

    expect(mocks.computeFullSyncDiffMock).toHaveBeenCalledOnce();
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
    mocks.checkRepoAvailabilityMock.mockResolvedValue("available");
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
    mocks.computeFullSyncDiffMock.mockResolvedValue({ stub: true });
    mocks.hasDivergentChangesMock.mockReturnValue(false);
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW);

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
  });

  it("(d) unavailable: writes gh_repo_available=0 + real gh_checked_at, returns early", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue("unavailable");
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW);

    expect(mocks.computeFullSyncDiffMock).not.toHaveBeenCalled();
    expect(db.sets).toHaveLength(1);
    expect(db.sets[0]).toMatchObject({
      gh_repo_available: 0,
      gh_checked_at: new Date(NOW).toISOString(),
    });
  });

  it("(e) local head null + remote present: ONE write backfills head_sha + in-sync verdict", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue("available");
    mocks.getRepoHeadMock.mockResolvedValue("remoteHead");
    const db = makeFakeDb();

    await refreshGithubStatus(
      { ...baseProject, head_sha: null },
      "tok",
      db as any,
      NOW,
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
  });

  it("(f) repo available but getRepoHead null: no cache write, prior verdict preserved", async () => {
    mocks.checkRepoAvailabilityMock.mockResolvedValue("available");
    mocks.getRepoHeadMock.mockRejectedValue(new Error("fetch failed"));
    const db = makeFakeDb();

    await refreshGithubStatus({ ...baseProject }, "tok", db as any, NOW);

    expect(mocks.computeFullSyncDiffMock).not.toHaveBeenCalled();
    expect(db.sets).toHaveLength(0);
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
