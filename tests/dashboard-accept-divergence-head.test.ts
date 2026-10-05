/**
 * What Keep my version records.
 *
 * The author chose to keep the Compositor's version over the differences one
 * check showed them, at one commit (`FullSyncDiff.headSha`). The page posts
 * that commit, and the action records it compare-and-set from the head loaded
 * with the project. A commit that lands after the check is never recorded: the
 * action reads no head of its own. A missing or malformed SHA, or a head that
 * moved since the load, records nothing and answers `accept_divergence_stale`,
 * so the page checks again. The page posts the project whose diff it showed,
 * and a project other than the one the session resolves (another tab switched
 * it) records nothing and answers stale too.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  /** The project row's head_sha, as D1 holds it. */
  row: { head_sha: null as string | null, last_synced_at: null as string | null, page_files_json: null as string | null },
  /** The project as the route loaded it. */
  loadedHead: null as string | null,
  /** The writes, in the order they happened. */
  events: [] as string[],
}));

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => ({})) }));
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
    project: { id: 1, github_repo_full_name: "owner/repo", head_sha: state.loadedHead, onboarding_completed: 1 },
    userRole: "convenor",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));
vi.mock("~/lib/github.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  // A commit that landed after the check: never to be recorded here.
  getRepoHead: vi.fn(async () => LATER),
}));
// The project row in memory: the compare-and-set writes only while it still
// holds `fromSha`.
vi.mock("~/lib/github-status.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  bumpProjectHeadFrom: vi.fn(
    async (
      _db: unknown, _id: number, fromSha: string | null, toSha: string, _now?: number,
      also?: { last_synced_at?: string; page_files_json?: string },
    ) => {
      state.events.push("record");
      if (state.row.head_sha !== fromSha) return false;
      state.row.head_sha = toSha;
      if (also?.last_synced_at) state.row.last_synced_at = also.last_synced_at;
      if (also?.page_files_json) state.row.page_files_json = also.page_files_json;
      return true;
    },
  ),
}));

// The page files record at the shown head, with nothing applied.
vi.mock("~/lib/page-files-check.server", () => ({
  keptPageFilesRecordJson: vi.fn(async (_db: unknown, _id: number, _access: unknown, _base: unknown, shown: string) =>
    JSON.stringify({ commit: shown, files: { "acerca.md": null } })),
}));

// The record that the project's ids have been repaired.
vi.mock("~/lib/legacy-object-ids.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  markLegacyIdsRepaired: vi.fn(async () => {
    state.events.push("repaired");
  }),
}));

// GitHub's object order, applied before the head is recorded. The
// record is the action's, run by the order under its lease;
// tests/object-order-sync.test.ts pins that it runs there.
vi.mock("~/lib/sync.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  applyGitHubObjectOrder: vi.fn(orderThenRecord()),
}));

/** The order applied, then the action's record of the head run as the order runs it. */
function orderThenRecord(answer: { legacyUnjudged?: true } = {}) {
  return async (...args: unknown[]) => {
    state.events.push("order");
    const record = args[7] as (() => Promise<boolean>) | undefined;
    return { superseded: false, recorded: record ? await record() : false, ...answer };
  };
}

import { action } from "~/routes/_app.dashboard";
import { getRepoHead } from "~/lib/github.server";
import { applyGitHubObjectOrder } from "~/lib/sync.server";
import { markLegacyIdsRepaired } from "~/lib/legacy-object-ids.server";

const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const SHOWN = "0123456789abcdef0123456789abcdef01234567";
const LATER = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

/**
 * Keep my version as the page posts it: the diff's own project, base and head.
 * A field set to undefined is left out; a null base is posted as "".
 */
async function keepMine(fields: Record<string, string | undefined>) {
  const context = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: { env: { ENCRYPTION_KEY: "key", SESSION_SECRET: "sess-secret", DB: {} } },
  } as unknown as Parameters<typeof action>[0]["context"];
  // siteId is the page-site gate's own field (resolvePageProject), compared
  // against the mocked resolveActiveProject's id (1); projectId is this
  // action's own field, checked separately against the loaded project below.
  const posted = Object.entries({
    intent: "accept-divergence",
    siteId: "1",
    projectId: "1",
    baseSha: BASE,
    ...fields,
  }).filter((entry): entry is [string, string] => entry[1] !== undefined);
  const request = new Request("https://compositor.telar.org/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(posted).toString(),
  });
  return action({ request, context, params: {} } as never);
}

const STALE = { ok: false, intent: "accept-divergence", error: "accept_divergence_stale" };

beforeEach(() => {
  vi.clearAllMocks();
  state.loadedHead = BASE;
  state.row.head_sha = BASE;
  state.row.last_synced_at = null;
  state.row.page_files_json = null;
  state.events.length = 0;
});

describe("Keep my version records the commit the author was shown", () => {
  it("records the posted SHA, and stamps the sync", async () => {
    expect(await keepMine({ headSha: SHOWN })).toEqual({ ok: true, intent: "accept-divergence" });
    expect(state.row.head_sha).toBe(SHOWN);
    expect(state.row.last_synced_at).not.toBeNull();
  });

  it("records the page files record at the shown head in the same write", async () => {
    await keepMine({ headSha: SHOWN });
    expect(JSON.parse(state.row.page_files_json!)).toEqual({ commit: SHOWN, files: { "acerca.md": null } });
  });

  it("never reads, or records, a fresh head", async () => {
    await keepMine({ headSha: SHOWN });
    expect(getRepoHead).not.toHaveBeenCalled();
    expect(state.row.head_sha).not.toBe(LATER);
  });

  it("records over no head recorded, for a diff computed against none", async () => {
    state.loadedHead = null;
    state.row.head_sha = null;
    expect(await keepMine({ headSha: SHOWN, baseSha: "" })).toEqual({ ok: true, intent: "accept-divergence" });
    expect(state.row.head_sha).toBe(SHOWN);
  });

  it("advances from the base the diff was computed against, not the head loaded with the request", async () => {
    // The request loaded a head that is not the diff's base; the row still holds the base.
    state.loadedHead = OTHER;
    expect(await keepMine({ headSha: SHOWN })).toEqual({ ok: true, intent: "accept-divergence" });
    expect(state.row.head_sha).toBe(SHOWN);
  });
});

describe("Keep my version records nothing it cannot stand behind", () => {
  it("answers stale for a diff computed against a base that is not the recorded head", async () => {
    // The check compared against OTHER; head_sha has since become BASE.
    expect(await keepMine({ headSha: SHOWN, baseSha: OTHER })).toEqual(STALE);
    expect(state.row.head_sha).toBe(BASE);
    expect(state.row.last_synced_at).toBeNull();
  });

  it("answers stale for a diff computed against no base when a head is recorded", async () => {
    expect(await keepMine({ headSha: SHOWN, baseSha: "" })).toEqual(STALE);
    expect(state.row.head_sha).toBe(BASE);
  });

  it("answers stale for a page that sends no base", async () => {
    expect(await keepMine({ headSha: SHOWN, baseSha: undefined })).toEqual(STALE);
    expect(state.row.head_sha).toBe(BASE);
  });

  for (const bad of ["main", BASE.toUpperCase(), BASE.slice(1)]) {
    it(`answers stale for a malformed base ${JSON.stringify(bad)}`, async () => {
      expect(await keepMine({ headSha: SHOWN, baseSha: bad })).toEqual(STALE);
      expect(state.row.head_sha).toBe(BASE);
    });
  }

  it("answers stale and keeps the head another writer recorded since the load", async () => {
    state.row.head_sha = OTHER;
    expect(await keepMine({ headSha: SHOWN })).toEqual(STALE);
    expect(state.row.head_sha).toBe(OTHER);
    expect(state.row.last_synced_at).toBeNull();
  });

  it("answers stale for a page that sends no SHA", async () => {
    expect(await keepMine({})).toEqual(STALE);
    expect(state.row.head_sha).toBe(BASE);
    expect(getRepoHead).not.toHaveBeenCalled();
  });

  for (const bad of ["", "0123456", `${SHOWN}0`, SHOWN.toUpperCase(), `${SHOWN.slice(0, 39)}g`]) {
    it(`answers stale for a malformed SHA ${JSON.stringify(bad)}`, async () => {
      expect(await keepMine({ headSha: bad })).toEqual(STALE);
      expect(state.row.head_sha).toBe(BASE);
    });
  }

  it("answers stale for a diff of another project, recording nothing on this one", async () => {
    // Tab 1 showed project 2's diff; tab 2 switched the session to project 1.
    expect(await keepMine({ headSha: SHOWN, projectId: "2" })).toEqual(STALE);
    expect(state.row.head_sha).toBe(BASE);
    expect(state.row.last_synced_at).toBeNull();
  });

  it("answers stale for a page that sends no project", async () => {
    expect(await keepMine({ headSha: SHOWN, projectId: undefined })).toEqual(STALE);
    expect(state.row.head_sha).toBe(BASE);
  });
});

describe("Keep my version applies GitHub's object order first", () => {
  it("applies the order at the shown head, then records it", async () => {
    expect(await keepMine({ headSha: SHOWN })).toEqual({ ok: true, intent: "accept-divergence" });
    expect(state.events).toEqual(["order", "record", "repaired"]);
    expect(vi.mocked(applyGitHubObjectOrder).mock.calls[0][2]).toBe(SHOWN);
  });

  it("answers stale and records nothing when an order entry is superseded", async () => {
    vi.mocked(applyGitHubObjectOrder).mockResolvedValueOnce({ superseded: true });
    expect(await keepMine({ headSha: SHOWN })).toEqual(STALE);
    expect(state.row.head_sha).toBe(BASE);
    expect(state.events).not.toContain("record");
  });

  it("answers failed and records nothing when the order cannot be applied", async () => {
    vi.mocked(applyGitHubObjectOrder).mockRejectedValueOnce(new Error("objects.csv unreadable"));
    expect(await keepMine({ headSha: SHOWN })).toMatchObject({ ok: false, error: "accept_divergence_failed" });
    expect(state.row.head_sha).toBe(BASE);
    expect(state.events).not.toContain("record");
  });

  it("passes the diff's base, and answers stale recording nothing when that base has moved", async () => {
    const { SyncBaseStale } = await vi.importActual<typeof import("~/lib/sync.server")>("~/lib/sync.server");
    vi.mocked(applyGitHubObjectOrder).mockRejectedValueOnce(new SyncBaseStale());
    expect(await keepMine({ headSha: SHOWN })).toEqual(STALE);
    expect(vi.mocked(applyGitHubObjectOrder).mock.calls[0][3]).toBe(BASE);
    expect(state.row.head_sha).toBe(BASE);
    expect(state.events).not.toContain("record");
  });

  it("applies nothing for a request it answers stale on its own fields", async () => {
    await keepMine({ headSha: "main" });
    expect(applyGitHubObjectOrder).not.toHaveBeenCalled();
  });
});

// Keep my version counts as the project's first sync check: its ingest gave any
// row an earlier import stored stripped GitHub's spelling, so once it records
// the head the ids are marked repaired, and only then.
describe("Keep my version and the project's ids", () => {
  it("marks them repaired once it has recorded the head", async () => {
    expect(await keepMine({ headSha: SHOWN })).toEqual({ ok: true, intent: "accept-divergence" });
    expect(state.events).toEqual(["order", "record", "repaired"]);
    expect(markLegacyIdsRepaired).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it("leaves them unmarked when the order or a respelling was superseded", async () => {
    vi.mocked(applyGitHubObjectOrder).mockResolvedValueOnce({ superseded: true });
    expect(await keepMine({ headSha: SHOWN })).toEqual(STALE);
    expect(markLegacyIdsRepaired).not.toHaveBeenCalled();
  });

  it("leaves them unmarked when another writer recorded a head since", async () => {
    state.row.head_sha = OTHER;
    expect(await keepMine({ headSha: SHOWN })).toEqual(STALE);
    expect(markLegacyIdsRepaired).not.toHaveBeenCalled();
  });

  it("leaves them unmarked when the record they are judged against could not be read", async () => {
    vi.mocked(applyGitHubObjectOrder).mockImplementationOnce(orderThenRecord({ legacyUnjudged: true }));
    expect(await keepMine({ headSha: SHOWN })).toEqual({ ok: true, intent: "accept-divergence" });
    expect(markLegacyIdsRepaired).not.toHaveBeenCalled();
  });

  it("leaves them unmarked when the ingest failed", async () => {
    vi.mocked(applyGitHubObjectOrder).mockRejectedValueOnce(new Error("ingest-sync failed: DO returned 500"));
    expect(await keepMine({ headSha: SHOWN })).toMatchObject({ ok: false, error: "accept_divergence_failed" });
    expect(markLegacyIdsRepaired).not.toHaveBeenCalled();
  });
});
