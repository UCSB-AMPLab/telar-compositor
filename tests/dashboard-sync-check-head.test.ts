/**
 * What the dashboard's change check records when it finds nothing to sync.
 *
 * The check reads one commit (`diff.headSha`). When the diff holds nothing,
 * the dialog, story content included, offers nothing, so the route records
 * that commit as synced; when it holds anything, the route records nothing
 * and leaves the author's choice to the accept. It never records a head it
 * did not read, and it writes compare-and-set against the head it loaded,
 * so a writer that moved the head meanwhile keeps its head.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  /** The project row's head_sha, as D1 holds it. */
  row: { head_sha: null as string | null },
  /** The project as the route loaded it. */
  loadedHead: null as string | null,
  /** The project's legacy_ids_repaired_at, as the route loaded it. */
  repairedAt: null as string | null,
  /** The project's objects_read_sha, as the route loaded it. */
  objectsReadSha: null as string | null,
  diff: undefined as unknown,
  applyThrows: undefined as unknown,
  /** What the lease begin answers: refused while an apply holds it, unavailable when the object cannot be asked. */
  leaseBegin: "applied" as "applied" | "refused" | "unavailable",
  /** The fingerprint of everything in D1 the check compares, as it stands. */
  rows: "rows-as-compared",
  /** When an apply writes what the check compares: while the check reads it, or after, before the check takes the lease. */
  applyWrites: null as "after-version" | "during" | "after" | null,
}));

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => ({})) }));
// The site's framework version, which the diff matches objects by.
vi.mock("~/lib/site-version.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  readSiteTelarVersion: vi.fn(async () => {
    if (state.applyWrites === "after-version") state.rows = "rows-an-apply-wrote";
    return "1.8.0";
  }),
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/membership.server", () => ({
  getUserProjects: vi.fn(async () => []),
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 1, github_repo_full_name: "owner/repo", head_sha: state.loadedHead, onboarding_completed: 1,
      legacy_ids_repaired_at: state.repairedAt,
      objects_read_sha: state.objectsReadSha,
    },
    userRole: "convenor",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));
vi.mock("~/lib/github.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  // A commit lands after the check read its head: never to be recorded here.
  getRepoHead: vi.fn(async () => "1111111111111111111111111111111111111111"),
}));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, control: { op: string }) => {
    if (control.op === "begin" && state.applyWrites === "after") state.rows = "rows-an-apply-wrote";
    return control.op === "begin" ? state.leaseBegin : "applied";
  }),
  newFreezeOperationId: vi.fn(() => "check-lease"),
}));
vi.mock("~/lib/synced-rows-fingerprint.server", () => ({
  syncedRowsFingerprint: vi.fn(async () => state.rows),
}));
vi.mock("~/lib/sync.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  finishPendingBeforeCheck: vi.fn(async () => {}),
  computeFullSyncDiff: vi.fn(async () => {
    if (state.applyWrites === "during") state.rows = "rows-an-apply-wrote";
    return state.diff;
  }),
  // The repair of ids stored stripped is its own spec's; here the check runs once.
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
  applyFullSyncChanges: vi.fn(async () => {
    throw state.applyThrows;
  }),
}));
// The project row in memory: the compare-and-set writes only while it still
// holds `fromSha`.
vi.mock("~/lib/github-status.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  bumpProjectHeadFrom: vi.fn(async (_db: unknown, _id: number, fromSha: string | null, toSha: string) => {
    if (state.row.head_sha !== fromSha) return false;
    state.row.head_sha = toSha;
    return true;
  }),
}));

import { action } from "~/routes/_app.dashboard";
import { runPrePublishValidation } from "~/lib/publish.server";
import type { FullSyncDiff } from "~/lib/sync.server";

const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const READ = "0123456789abcdef0123456789abcdef01234567";

function emptyDiff(content: unknown = { conclusive: true, changes: [], suppressedEditorOnly: 0 }): FullSyncDiff {
  return {
    objects: {
      newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null,
    },
    stories: { newStories: [], changedStories: [], missingStories: [], content },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], changed: [], removed: [] },
    hasConflicts: false,
    classification: "three-way",
    suppressedEditorOnly: 0,
    headSha: READ,
  } as unknown as FullSyncDiff;
}

async function check() {
  const context = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: {
      env: {
        ENCRYPTION_KEY: "key",
        SESSION_SECRET: "sess-secret",
        DB: {},
        COLLABORATION: {
          idFromName: vi.fn(() => "do-id"),
          get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("{}", { status: 200 })) })),
        },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
  const request = new Request("https://compositor.telar.org/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    // siteId matches the mocked resolveActiveProject's project id (1), which
    // resolvePageProject's page-site gate compares it against.
    body: new URLSearchParams({ intent: "compute-full-sync-diff", siteId: "1" }).toString(),
  });
  return action({ request, context, params: {} } as never);
}

describe("the change check and ids an earlier import stored stripped", () => {
  it("runs the legacy repair while the project's ids are unrepaired, and not after", async () => {
    const { checkRepairingLegacyIds } = await import("~/lib/sync.server");
    state.repairedAt = null;
    await check();
    state.repairedAt = "2026-09-30";
    await check();
    state.repairedAt = null;
    expect(vi.mocked(checkRepairingLegacyIds).mock.calls.map((call) => (call[5] as { open: boolean }).open)).toEqual([true, false]);
  });

  it("judges them against objects_read_sha, else the recorded head", async () => {
    const { checkRepairingLegacyIds } = await import("~/lib/sync.server");
    at(BASE);
    state.objectsReadSha = READ;
    await check();
    state.objectsReadSha = null;
    await check();
    expect(vi.mocked(checkRepairingLegacyIds).mock.calls.map((call) => (call[5] as { ref: string | null }).ref)).toEqual([READ, BASE]);
  });
});

function at(head: string | null) {
  state.loadedHead = head;
  state.row.head_sha = head;
}

beforeEach(() => {
  vi.clearAllMocks();
  at(BASE);
  state.diff = emptyDiff();
  state.leaseBegin = "applied";
  state.rows = "rows-as-compared";
  state.applyWrites = null;
});

describe("the change check keeps head_sha when the dialog has something to offer", () => {
  it("keeps it for a story whose steps changed only on GitHub", async () => {
    state.diff = emptyDiff({
      conclusive: true, suppressedEditorOnly: 0,
      changes: [{ story_id: "s1", title: "S", kind: "github-only", acceptByDefault: true,
        summary: { d1Steps: 2, headSteps: 3, changedSteps: 1 }, expected: "h" }],
    });
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  it("keeps it when the story files could not be read", async () => {
    state.diff = emptyDiff({ conclusive: false, reason: "the story trees came back truncated" });
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  it("keeps it for a page whose file changed only on GitHub, so the dialog can list it", async () => {
    state.diff = {
      ...emptyDiff(),
      pages: {
        conclusive: true, suppressedEditorOnly: 0,
        changes: [{ pageId: 5, slug: "about", title: "About", kind: "github-only", acceptByDefault: true, expected: "h" }],
      },
    };
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  it("keeps it for a head that only reorders objects", async () => {
    state.diff = {
      ...emptyDiff(),
      objects: {
        newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [],
        reordered: { order: [{ objectId: "b", docId: 2 }, { objectId: "a", docId: 1 }] },
      },
    } as FullSyncDiff;
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  it("keeps it for a row whose stripped id the repair did not give GitHub's spelling", async () => {
    state.diff = {
      ...emptyDiff(),
      objects: {
        newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null,
        respelled: [{ objectId: "a", docId: 1, githubId: "a  " }],
      },
    } as FullSyncDiff;
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  it("keeps it when the page files could not be read", async () => {
    state.diff = { ...emptyDiff(), pages: { conclusive: false, reason: "the page trees came back malformed" } };
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });
});

describe("the change check records the commit it read when there is nothing to sync", () => {
  it("records diff.headSha, not a head that landed after it", async () => {
    await check();
    expect(state.row.head_sha).toBe(READ);
  });

  it("leaves the head another writer recorded meanwhile", async () => {
    state.loadedHead = BASE;
    state.row.head_sha = "2222222222222222222222222222222222222222";
    await check();
    expect(state.row.head_sha).toBe("2222222222222222222222222222222222222222");
  });

  // An apply holding the objects lease may be writing the values the check
  // compared: the check leaves the record for the next one.
  it("records nothing while an apply holds the objects lease", async () => {
    state.leaseBegin = "refused";
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  // A check fails closed: it loses nothing by leaving the record.
  it("records nothing when the lease could not be asked for", async () => {
    state.leaseBegin = "unavailable";
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  // An apply wrote what the check compared after the check read it, and
  // released the lease before the check took it. The fingerprint covers
  // objects, stories with their steps and layers, the glossary, the settings
  // and the pages (tests/synced-rows-fingerprint.test.ts), all of which the
  // full sync's apply writes under that lease.
  it("records nothing when D1 was written after the check compared it", async () => {
    state.applyWrites = "after";
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  // The site's version is one of the check's reads: a write landing just
  // after it is one the check did not compare (the diff is computed with the
  // version read before it).
  it("records nothing when D1 was written just after the check read the site's version", async () => {
    state.applyWrites = "after-version";
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  // The check may have read either value.
  it("records nothing when D1 was written while the check read it", async () => {
    state.applyWrites = "during";
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });

  it("records nothing for a diff that names no commit", async () => {
    state.diff = { ...emptyDiff(), headSha: undefined };
    await check();
    expect(state.row.head_sha).toBe(BASE);
  });
});

describe("a first sync, with no head recorded", () => {
  it("records the commit the check read", async () => {
    at(null);
    await check();
    expect(state.row.head_sha).toBe(READ);
  });

  it("leaves a head another writer set first", async () => {
    state.loadedHead = null;
    state.row.head_sha = "2222222222222222222222222222222222222222";
    await check();
    expect(state.row.head_sha).toBe("2222222222222222222222222222222222222222");
  });

  // The no-base reformatting case. A published layer file with a trailing
  // space on GitHub is divergent to the status refresh, which compares blobs
  // (tests/github-status-story-files.test.ts, "does not backfill with one
  // differing byte"), and nothing to the check, which compares content
  // (tests/sync-story-content.test.ts, "with no base, a layer file's trailing
  // space"). The
  // check's empty diff is then what clears the stale head, so the author can
  // publish.
  it("clears the stale head a reformatting leaves, so publish is not blocked", async () => {
    at(null);
    const blockers = () => runPrePublishValidation({
      headSha: state.row.head_sha ?? "", currentRepoHead: READ,
      stories: [], steps: [], objects: [], pages: [], glossary: [],
    }).blockers.map((b) => b.code);
    expect(blockers()).toContain("stale_head");
    await check();
    expect(blockers()).not.toContain("stale_head");
  });
});

describe("an apply whose accepted pages were not applied", () => {
  async function apply() {
    const context = {
      get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
      cloudflare: { env: { ENCRYPTION_KEY: "key", SESSION_SECRET: "sess-secret", DB: {} } },
    } as unknown as Parameters<typeof action>[0]["context"];
    const request = new Request("https://compositor.telar.org/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "apply-full-sync", changes: "{}", siteId: "1" }).toString(),
    });
    return action({ request, context, params: {} } as never);
  }

  it("answers page_changed_since_review with the pages, so the dialog checks again", async () => {
    const { PageContentNotApplied } = await import("~/lib/sync.server");
    state.applyThrows = new PageContentNotApplied([5], []);
    expect(await apply()).toEqual({ ok: false, intent: "apply-full-sync", error: "page_changed_since_review", pageIds: [5] });
  });

  it("answers page_content_failed with the pages that did not save", async () => {
    const { PageContentNotApplied } = await import("~/lib/sync.server");
    state.applyThrows = new PageContentNotApplied([], [6]);
    expect(await apply()).toEqual({ ok: false, intent: "apply-full-sync", error: "page_content_failed", pageIds: [6] });
  });
});

describe("an apply refused for a moved base", () => {
  it("answers sync_base_stale, so the dialog checks again", async () => {
    const { SyncBaseStale } = await import("~/lib/sync.server");
    state.applyThrows = new SyncBaseStale();
    const context = {
      get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
      cloudflare: { env: { ENCRYPTION_KEY: "key", SESSION_SECRET: "sess-secret", DB: {} } },
    } as unknown as Parameters<typeof action>[0]["context"];
    const request = new Request("https://compositor.telar.org/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        intent: "apply-full-sync",
        changes: "{}",
        siteId: "1",
      }).toString(),
    });
    expect(await action({ request, context, params: {} } as never)).toEqual({
      ok: false, intent: "apply-full-sync", error: "sync_base_stale",
    });
  });
});

// The check an author starts is the one screen that shows the sheets'
// warnings, so it alone asks the diff to collect them.
describe("the change check asks for the sheets' warnings", () => {
  it("passes collectWarnings to the diff", async () => {
    await check();
    const { computeFullSyncDiff } = await import("~/lib/sync.server");
    expect(vi.mocked(computeFullSyncDiff).mock.calls[0][6]).toEqual({ collectWarnings: true, frameworkVersion: "1.8.0" });
  });
});

// The diff is read after the pending object operations are finished, and a
// check that cannot finish them fails rather than show their effect as a
// difference.
describe("the change check finishes pending object operations first", () => {
  it("finishes them before it reads the diff", async () => {
    await check();
    const { computeFullSyncDiff, finishPendingBeforeCheck } = await import("~/lib/sync.server");
    expect(vi.mocked(finishPendingBeforeCheck)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(finishPendingBeforeCheck).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(computeFullSyncDiff).mock.invocationCallOrder[0]);
  });

  it("fails the check, reading no diff, when they cannot be finished", async () => {
    const { computeFullSyncDiff, finishPendingBeforeCheck } = await import("~/lib/sync.server");
    vi.mocked(finishPendingBeforeCheck).mockRejectedValueOnce(new Error("lease held"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await check()).toMatchObject({ ok: false, intent: "compute-full-sync-diff", error: "sync_failed" });
    expect(computeFullSyncDiff).not.toHaveBeenCalled();
  });
});
