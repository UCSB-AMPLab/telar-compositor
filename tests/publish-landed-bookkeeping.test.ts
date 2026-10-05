/**
 * Once `commitFilesToRepo` returns, the site has changed: nothing after that
 * point may turn a landed commit into a reported `publish_failed`.
 *
 * The publish snapshot (`newSnapshot`, and everything it is built from —
 * `newConfigManaged`, `newNavigationHash`, the rest) is built before the
 * commit runs, from the same reads the file set and the deletions are built
 * from. The one `db.update(projects)` write that records the landed commit is
 * tried up to three times, on a short pause, because it is a single
 * idempotent statement; if every try fails, the miss is logged once and
 * swallowed, and the action still answers `{ ok: true, ... }` with the
 * lease ending as succeeded.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { guardedOnHead, readableHeadWrite } from "./helpers/head-write";

const state = vi.hoisted(() => ({
  /** Every projects-row `set` payload that actually landed, readable. */
  projectWrites: [] as Record<string, unknown>[],
  /** The project row as D1 holds it, for the columns these writes touch. */
  row: { head_sha: null as string | null, published_sha: null as string | null },
  /** How many of the next `where()` calls on a projects update should throw. */
  writeFailuresRemaining: 0,
  /** Every attempt at the projects update, whether it threw or landed. */
  writeAttempts: 0,
  /** The page rows every select naming `slug` answers. */
  pageRows: [] as Array<Record<string, unknown>>,
  /** The story rows every select naming `source_path` answers. */
  storyRows: [] as Array<Record<string, unknown>>,
  /** Every story-row `set` payload that landed. */
  storyWrites: [] as Record<string, unknown>[],
  /** How many of the next story-row updates should throw. */
  storyWriteFailuresRemaining: 0,
  /** The statement count of each batch run. */
  batches: [] as number[],
}));

const RECORDED = "0123456789abcdef0123456789abcdef01234567";

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/db.server", async () => {
  const { projects, stories } = await import("~/db/schema");
  /** A statement run when awaited or batched, as drizzle's builders are. */
  const statement = (run: () => Promise<void>) => ({
    run,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
  });
  return {
    getDb: vi.fn(() => ({
      select: (columns?: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {};
        const rows = columns && "slug" in columns ? state.pageRows : columns && "source_path" in columns ? state.storyRows : [];
        chain.from = () => chain;
        chain.innerJoin = () => chain;
        chain.where = () => Object.assign(Promise.resolve(rows), chain);
        // A read ordered with `.orderBy()` (objects, in `objectsSheetOrder`) answers the same rows.
        chain.orderBy = function (this: unknown) { return this; };
        chain.limit = () => Promise.resolve(rows);
        return chain;
      },
      // D1 runs a batch as one transaction: a refused statement lands none.
      batch: async (statements: Array<{ run: () => Promise<void> }>) => {
        state.batches.push(statements.length);
        const before = { projects: state.projectWrites.length, stories: state.storyWrites.length };
        try {
          for (const s of statements) await s.run();
        } catch (err) {
          state.projectWrites.length = before.projects;
          state.storyWrites.length = before.stories;
          throw err;
        }
      },
      update: (table: unknown) => ({
        set: (payload: Record<string, unknown>) => ({
          where: () => statement(async () => {
            if (table === stories) {
              if (state.storyWriteFailuresRemaining > 0) {
                state.storyWriteFailuresRemaining -= 1;
                throw new Error("d1 refused the story write");
              }
              state.storyWrites.push(payload);
              return undefined;
            }
            if (table !== projects) return undefined;
            state.writeAttempts += 1;
            if (state.writeFailuresRemaining > 0) {
              state.writeFailuresRemaining -= 1;
              throw new Error("d1 refused the write");
            }
            state.projectWrites.push(readableHeadWrite(payload));
            const guarded = guardedOnHead(payload.head_sha);
            if (!guarded) {
              if ("head_sha" in payload) state.row.head_sha = payload.head_sha as string | null;
            } else if (state.row.head_sha === guarded.head) {
              state.row.head_sha = guarded.value as string;
            }
            if ("published_sha" in payload) state.row.published_sha = payload.published_sha as string | null;
            return undefined;
          }),
        }),
      }),
    })),
  };
});

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 7,
      github_repo_full_name: "owner/repo",
      installation_id: 55,
      publish_snapshot: null,
      head_sha: RECORDED,
    },
    userRole: "convenor",
  })),
  requirePublishingRole: vi.fn(async () => {}),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));

const { getRepoHead, getFileAtRef, checkRepoAvailability } = vi.hoisted(() => ({
  checkRepoAvailability: vi.fn(async () => ({ availability: "available", canonicalFullName: "owner/repo" })),
  getRepoHead: vi.fn(async () => RECORDED),
  getFileAtRef: vi.fn(async () => ({ status: "ok" as const, content: 'title: "x"\n' })),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getRepoHead, getFileAtRef, checkRepoAvailability };
});
vi.mock("~/lib/upgrade.server", () => ({ healMissingFrameworkFiles: vi.fn(async () => []) }));

const { commitFilesToRepo, StaleHeadError } = vi.hoisted(() => {
  class StaleHeadError extends Error {}
  return { commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })), StaleHeadError };
});
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo,
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError,
}));

/** `buildPageContentHashes` runs only while `newSnapshot` is assembled, so
 *  making it throw pins the snapshot build to before the commit: a mutation
 *  that moved it after `commitFilesToRepo` would call the commit anyway. */
const { buildPageContentHashes } = vi.hoisted(() => ({
  buildPageContentHashes: vi.fn(() => ({}) as Record<string, string>),
}));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet: vi.fn(async () => []), buildPageContentHashes };
});

const { controlFreezeLease } = vi.hoisted(() => ({ controlFreezeLease: vi.fn(async () => true) }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease,
  newFreezeOperationId: () => "op-publish",
}));

import { action } from "~/routes/_app.publish";
import { sha256Hex } from "~/lib/story-canonical";

/** Each `pages.storeWrittenFrontmatter` arm the collaboration object was sent. */
const storeDeliveries: unknown[] = [];
const storeAnswer = vi.fn(async (): Promise<Response> => Response.json({ storedPages: [] }));
const snapshotFetch = vi.fn(async (request?: Request) => {
  if (!request?.url.endsWith("/ingest-sync")) return new Response("OK", { status: 200 });
  const body = JSON.parse(await request.text()) as { pages?: { storeWrittenFrontmatter?: unknown } };
  if (body.pages?.storeWrittenFrontmatter === undefined) return Response.json({});
  storeDeliveries.push(body.pages.storeWrittenFrontmatter);
  return storeAnswer();
});

function buildContext() {
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: snapshotFetch })) },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

/**
 * The acknowledgement of the page whose settings the publish replaces: page 3
 * below, with its stored block. Worked out once, before any test, so a publish
 * starts at once under the fake timers of the retry cases.
 */
let acknowledgedAbout = "";
beforeAll(async () => {
  acknowledgedAbout = JSON.stringify([{ pageId: 3, fingerprint: await sha256Hex("\ntitle: [About\n") }]);
});

function runPublish() {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Publish site");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  form.set("acknowledgedReplacedPages", acknowledgedAbout);
  return action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: buildContext(),
    params: {},
  } as unknown as Parameters<typeof action>[0]) as Promise<Record<string, unknown>>;
}

/** The lease's outcome from its `end` call, or undefined if none was made. */
function leaseEndOutcome(): unknown {
  const calls = controlFreezeLease.mock.calls as unknown[][];
  const end = calls.find((c) => (c[3] as { op?: string } | undefined)?.op === "end");
  return end ? (end[3] as { outcome: unknown }).outcome : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.projectWrites.length = 0;
  state.row.head_sha = RECORDED;
  state.row.published_sha = null;
  state.writeFailuresRemaining = 0;
  state.writeAttempts = 0;
  state.pageRows = [{ slug: "about", title: "About" }];
  state.storyRows = [];
  state.storyWrites = [];
  state.storyWriteFailuresRemaining = 0;
  state.batches = [];
  storeDeliveries.length = 0;
  getRepoHead.mockResolvedValue(RECORDED);
  checkRepoAvailability.mockResolvedValue({ availability: "available", canonicalFullName: "owner/repo" });
  buildPageContentHashes.mockReturnValue({});
});

describe("recording a landed publish retries a refused D1 write", () => {
  it("succeeds on the second try and records the write", async () => {
    state.writeFailuresRemaining = 1;

    vi.useFakeTimers();
    try {
      const pending = runPublish();
      // Nothing retried before the first pause elapses.
      await vi.advanceTimersByTimeAsync(99);
      expect(state.writeAttempts).toBe(1);
      expect(state.projectWrites).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;

      expect(res).toMatchObject({ ok: true, intent: "publish", newHeadSha: "new-sha" });
      expect(state.writeAttempts).toBe(2);
      expect(state.projectWrites).toHaveLength(1);
      expect(state.projectWrites[0]).toMatchObject({ published_sha: "new-sha" });
      expect(console.error).not.toHaveBeenCalledWith(
        "[publish] record of a landed commit failed",
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reports success when every try fails, logging the miss once", async () => {
    state.writeFailuresRemaining = 3;

    vi.useFakeTimers();
    try {
      const pending = runPublish();
      await vi.advanceTimersByTimeAsync(100 + 300);
      const res = await pending;

      expect(res).toMatchObject({
        ok: true,
        intent: "publish",
        newHeadSha: "new-sha",
        commitUrl: "https://github.com/owner/repo/commit/new-sha",
      });
      // Three tries, none landed.
      expect(state.writeAttempts).toBe(3);
      expect(state.projectWrites).toHaveLength(0);
      expect(console.error).toHaveBeenCalledWith(
        "[publish] record of a landed commit failed",
        expect.objectContaining({ projectId: 7, commit: "new-sha" }),
      );
      // The commit landed, so the lease still ends as succeeded.
      expect(leaseEndOutcome()).toBe("succeeded");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the record of each story's file lands with the record of the commit", () => {
  const STORY = { id: 3, story_id: "loom", title: "Loom", draft: false, private: false, source_path: null };

  it("is written in the same batch", async () => {
    state.storyRows = [STORY];

    const res = await runPublish();

    expect(res).toMatchObject({ ok: true });
    expect(state.batches).toEqual([2]);
    expect(state.projectWrites).toHaveLength(1);
    expect(state.storyWrites).toEqual([{ source_path: "telar-content/spreadsheets/loom.csv" }]);
  });

  it("does not land the commit's record when a story's record is refused after it", async () => {
    state.storyRows = [STORY];
    state.storyWriteFailuresRemaining = 3;

    vi.useFakeTimers();
    try {
      const pending = runPublish();
      await vi.advanceTimersByTimeAsync(100 + 300);
      expect((await pending).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // Each try ran the commit's record before the refused story record.
    expect(state.writeAttempts).toBe(3);
    expect(state.projectWrites).toHaveLength(0);
    expect(state.storyWrites).toEqual([]);
  });

  it("misses with it when every try fails", async () => {
    state.storyRows = [STORY];
    state.writeFailuresRemaining = 3;

    vi.useFakeTimers();
    try {
      const pending = runPublish();
      await vi.advanceTimersByTimeAsync(100 + 300);
      expect((await pending).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(state.batches).toEqual([2, 2, 2]);
    expect(state.projectWrites).toHaveLength(0);
    expect(state.storyWrites).toEqual([]);
  });
});

describe("the publish snapshot is built before the commit", () => {
  it("never calls commitFilesToRepo when building the snapshot throws", async () => {
    buildPageContentHashes.mockImplementation(() => {
      throw new Error("snapshot build failed");
    });

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "publish_failed" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(state.projectWrites).toHaveLength(0);
    expect(leaseEndOutcome()).toBe("failed");
  });

  it("never calls commitFilesToRepo when serialising the snapshot throws", async () => {
    buildPageContentHashes.mockReturnValue({
      about: { toJSON: () => { throw new RangeError("snapshot too large"); } },
    } as unknown as Record<string, string>);

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "publish_failed" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(state.projectWrites).toHaveLength(0);
    expect(leaseEndOutcome()).toBe("failed");
  });
});

describe("the page blocks the publish wrote, once it lands", () => {
  /** A block the publish cannot read as a mapping, and the block it writes in its place. */
  const SYNTAX = "\ntitle: [About\n";
  const WRITTEN = '\ntitle: "About"\n';

  beforeEach(() => {
    state.pageRows = [
      { id: 3, slug: "about", title: "About", body: "Body", frontmatter: SYNTAX, frontmatter_source: null, order: 0 },
      { id: 4, slug: "kept", title: "Kept", body: "Body", frontmatter: "\ntitle: Kept\n", frontmatter_source: null, order: 1 },
      { id: 5, slug: "empty", title: "Empty", body: "Body", frontmatter: "", frontmatter_source: null, order: 2 },
      { id: 6, slug: "unread", title: "Unread", body: "Body", frontmatter: null, frontmatter_source: "unread", order: 3 },
    ];
  });

  it("sends the block written for the page whose stored block it could not read, and only that page", async () => {
    const res = await runPublish();

    expect(res).toMatchObject({ ok: true, intent: "publish", newHeadSha: "new-sha" });
    expect(storeDeliveries).toEqual([[{ pageId: 3, expected: SYNTAX, frontmatter: WRITTEN }]]);
  });

  it("answers a GitHub permission refusal as one, not as a failed publish", async () => {
    const { GitHubPermissionError } = await import("~/lib/github.server");
    commitFilesToRepo.mockRejectedValueOnce(new GitHubPermissionError("GitHub GraphQL error: 403", 403));

    const res = await runPublish();

    expect(res).toEqual({ ok: false, intent: "publish", error: "github_permission", projectId: 7 });
  });

  it("answers a refused installation token as a permission refusal, before any commit", async () => {
    const { GitHubPermissionError } = await import("~/lib/github.server");
    const { resolveProjectToken } = await import("~/lib/github-app.server");
    vi.mocked(resolveProjectToken).mockRejectedValueOnce(
      new GitHubPermissionError("Failed to get installation token: 404 Not Found", 404),
    );

    const res = await runPublish();

    expect(res).toEqual({ ok: false, intent: "publish", error: "github_permission", projectId: 7 });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("answers any other failed commit as publish_failed without carrying its text", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new Error("GitHub GraphQL error: 422"));

    const res = await runPublish();

    expect(res).toEqual({ ok: false, intent: "publish", error: "publish_failed", projectId: 7 });
  });

  it("stores the repository's current name when a failed publish finds it renamed", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new Error("GitHub GraphQL error: 422"));
    checkRepoAvailability.mockResolvedValue({ availability: "available", canonicalFullName: "owner/renamed" });

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, error: "publish_failed" });
    expect(checkRepoAvailability).toHaveBeenCalledWith("install-token", "owner", "repo");
    expect(state.projectWrites).toContainEqual({ github_repo_full_name: "owner/renamed" });
  });

  it("stores nothing when the failed publish finds the name unchanged", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new Error("GitHub GraphQL error: 422"));

    await runPublish();

    expect(state.projectWrites).toEqual([]);
  });

  it("still answers the failure when the name check itself fails", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new Error("GitHub GraphQL error: 422"));
    checkRepoAvailability.mockRejectedValue(new Error("offline"));

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, error: "publish_failed" });
  });

  it("sends nothing when the commit fails", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new Error("GitHub refused the commit"));

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, intent: "publish" });
    expect(storeDeliveries).toEqual([]);
  });

  it("still answers success with the commit URL when the collaboration object cannot be reached", async () => {
    storeAnswer.mockRejectedValueOnce(new Error("the object is unreachable"));

    const res = await runPublish();

    expect(storeDeliveries).toHaveLength(1);
    expect(res).toMatchObject({
      ok: true,
      intent: "publish",
      newHeadSha: "new-sha",
      commitUrl: "https://github.com/owner/repo/commit/new-sha",
    });
    expect(leaseEndOutcome()).toBe("succeeded");
  });
});
