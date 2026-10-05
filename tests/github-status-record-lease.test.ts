/**
 * The status refresh records a head only under the objects lease.
 *
 * A refresh that finds nothing divergent between the recorded head and
 * GitHub's advances head_sha and objects_read_sha to GitHub's head. A sync
 * apply writes D1 under the objects lease, so a refresh that compared D1
 * while an apply was writing it may have read the apply's half-written values
 * as the Compositor's own edits; recording GitHub's head then would hide
 * GitHub's values from the next check. The refresh records only as a sync
 * check does (`recordIfLeaseFree`): under a lease it was granted, and only
 * while D1's compared rows are the ones its comparison read
 * (`syncedRowsFingerprint`). A refresh that does not record leaves the
 * verdict it computed unwritten, since it was reached over rows that may not
 * be D1's.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  /** What the lease begin answers: refused while an apply holds it, unavailable when the object cannot be asked. */
  leaseBegin: "applied" as "applied" | "refused" | "unavailable",
  /** The fingerprint of D1's compared rows as they stand. */
  rows: "as-compared",
  /** When an apply writes D1's compared rows: while the refresh compares them, or after, before it takes the lease. */
  applyWrites: null as "during" | "after" | null,
  /** The lease controls, in order. */
  controls: [] as string[],
}));

vi.mock("~/lib/github.server", () => ({
  checkRepoAvailability: vi.fn(async () => ({ availability: "available", canonicalFullName: "owner/repo" })),
  getRepoHead: vi.fn(async () => "remoteHead"),
  getSubtreeOids: () => Promise.resolve({ ok: true, at: () => ({ kind: "absent" }) }),
  getRepoTree: () => Promise.reject(new Error("no listing expected")),
  githubHeaders: (token: string) => ({ Authorization: `Bearer ${token}` }),
}));
vi.mock("~/lib/sync.server", () => ({
  // Nothing divergent.
  computeFullSyncDiff: vi.fn(async () => {
    if (state.applyWrites === "during") state.rows = "rows-an-apply-wrote";
    return {};
  }),
  hasDivergentChanges: vi.fn(() => false),
}));
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/lib/site-version.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  readSiteTelarVersion: vi.fn(async () => "1.8.0"),
}));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, control: { op: string }) => {
    state.controls.push(control.op);
    if (control.op === "begin" && state.applyWrites === "after") state.rows = "rows-an-apply-wrote";
    return control.op === "begin" ? state.leaseBegin : "applied";
  }),
  newFreezeOperationId: vi.fn(() => "refresh-lease"),
}));
vi.mock("~/lib/synced-rows-fingerprint.server", () => ({
  syncedRowsFingerprint: vi.fn(async () => state.rows),
}));

import { refreshGithubStatus } from "~/lib/github-status.server";
import { readableHeadWrite } from "./helpers/head-write";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const LEASE = { env: {} as never, userId: 3 };

/** A fake database that keeps each write's columns, read as `readableHeadWrite` reads them. */
function refreshWritesDb() {
  const sets: Record<string, unknown>[] = [];
  const db = {
    sets,
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        sets.push(readableHeadWrite(payload));
        return { where: () => Promise.resolve([]) };
      },
    }),
  };
  return db;
}

/** Every column the refresh wrote, across its writes. */
function refreshWrote(db: ReturnType<typeof refreshWritesDb>): Record<string, unknown> {
  return Object.assign({}, ...db.sets);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.leaseBegin = "applied";
  state.rows = "as-compared";
  state.applyWrites = null;
  state.controls = [];
});

describe("a refresh with a recorded head and nothing divergent", () => {
  const project = { id: 7, head_sha: "localHead", github_repo_full_name: "owner/repo" };

  it("records GitHub's head under a lease it was granted, while D1's rows are as compared", async () => {
    const db = refreshWritesDb();
    await refreshGithubStatus({ ...project }, "tok", db as never, NOW, LEASE);
    expect(refreshWrote(db)).toMatchObject({
      head_sha: "remoteHead", head_sha_from: "localHead", objects_read_sha: "remoteHead",
      gh_diverged: 0, gh_diverged_against_sha: "remoteHead",
    });
    expect(state.controls).toEqual(["begin", "end"]);
  });

  it("records nothing while an apply holds the objects lease", async () => {
    state.leaseBegin = "refused";
    const db = refreshWritesDb();
    await refreshGithubStatus({ ...project }, "tok", db as never, NOW, LEASE);
    expect(refreshWrote(db)).not.toHaveProperty("head_sha");
    expect(refreshWrote(db)).not.toHaveProperty("objects_read_sha");
    // The verdict was reached over rows an apply may have been writing.
    expect(refreshWrote(db)).not.toHaveProperty("gh_diverged");
    expect(refreshWrote(db)).toMatchObject({ gh_remote_head_sha: "remoteHead", gh_repo_available: 1 });
  });

  it("records nothing when the lease could not be asked for", async () => {
    state.leaseBegin = "unavailable";
    const db = refreshWritesDb();
    await refreshGithubStatus({ ...project }, "tok", db as never, NOW, LEASE);
    expect(refreshWrote(db)).not.toHaveProperty("head_sha");
    expect(refreshWrote(db)).not.toHaveProperty("objects_read_sha");
  });

  // An apply wrote D1 after the refresh compared it and released the lease
  // before the refresh asked for it.
  it("records nothing when D1's rows were written after the comparison", async () => {
    state.applyWrites = "after";
    const db = refreshWritesDb();
    await refreshGithubStatus({ ...project }, "tok", db as never, NOW, LEASE);
    expect(refreshWrote(db)).not.toHaveProperty("head_sha");
    expect(refreshWrote(db)).not.toHaveProperty("objects_read_sha");
    expect(refreshWrote(db)).not.toHaveProperty("gh_diverged");
  });

  // The comparison may have read either value.
  it("records nothing when D1's rows were written while the refresh compared them", async () => {
    state.applyWrites = "during";
    const db = refreshWritesDb();
    await refreshGithubStatus({ ...project }, "tok", db as never, NOW, LEASE);
    expect(refreshWrote(db)).not.toHaveProperty("head_sha");
    expect(refreshWrote(db)).not.toHaveProperty("objects_read_sha");
    expect(refreshWrote(db)).not.toHaveProperty("gh_diverged");
  });
});

describe("a refresh backfilling a head over none", () => {
  const project = { id: 7, head_sha: null, github_repo_full_name: "owner/repo" };

  it("records GitHub's head under a lease it was granted, while D1's rows are as compared", async () => {
    const db = refreshWritesDb();
    await refreshGithubStatus({ ...project }, "tok", db as never, NOW, LEASE);
    expect(refreshWrote(db)).toMatchObject({ head_sha: "remoteHead", head_sha_from: null, gh_diverged: 0 });
  });

  it("records nothing while an apply holds the objects lease", async () => {
    state.leaseBegin = "refused";
    const db = refreshWritesDb();
    await refreshGithubStatus({ ...project }, "tok", db as never, NOW, LEASE);
    expect(refreshWrote(db)).not.toHaveProperty("head_sha");
  });

  // The backfill compares rendered stories and pages: an apply writing them
  // between that comparison and the record moves the fingerprint.
  it("records nothing when D1's rows were written after the comparison", async () => {
    state.applyWrites = "after";
    const db = refreshWritesDb();
    await refreshGithubStatus({ ...project }, "tok", db as never, NOW, LEASE);
    expect(refreshWrote(db)).not.toHaveProperty("head_sha");
  });
});
