/**
 * A publish commits only on the head the Compositor has recorded.
 *
 * Recording a commit acknowledges every GitHub edit up to it, and a publish
 * overwrites what it acknowledges with D1's content. So the action refuses
 * `stale_head` unless the head it reads (`publishSha`) is the head_sha it
 * loaded, before the forced snapshot and before anything is finished or
 * written; an edit that landed after the page's own check would otherwise be
 * overwritten. Its final write records the new commit compare-and-set from
 * `publishSha`, so a head another writer recorded during the publish is kept,
 * and the publish still reports its commit.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { guardedOnHead, readableHeadWrite } from "./helpers/head-write";

const state = vi.hoisted(() => ({
  /** The project as the route loaded it. */
  loadedHead: null as string | null,
  /** Every projects-row `set` payload, readable. */
  projectWrites: [] as Record<string, unknown>[],
  /** The project row as D1 holds it, for the columns these writes touch. */
  row: { head_sha: null as string | null, published_sha: null as string | null },
}));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/db.server", async () => {
  const { projects } = await import("~/db/schema");
  return {
    getDb: vi.fn(() => ({
      select: (columns?: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {};
        const rows = columns && "slug" in columns ? [{ slug: "about", title: "About" }] : [];
        chain.from = () => chain;
        chain.innerJoin = () => chain;
        chain.where = () => Object.assign(Promise.resolve(rows), chain);
        // A read ordered with `.orderBy()` (objects, in `objectsSheetOrder`) answers the same rows.
        chain.orderBy = function (this: unknown) { return this; };
        chain.limit = () => Promise.resolve(rows);
        return chain;
      },
      update: (table: unknown) => ({
        set: (payload: Record<string, unknown>) => {
          if (table === projects) {
            state.projectWrites.push(readableHeadWrite(payload));
            // Applied to the row as D1 would: a head guarded on another head
            // lands only while the row holds that one.
            const guarded = guardedOnHead(payload.head_sha);
            if (!guarded) {
              if ("head_sha" in payload) state.row.head_sha = payload.head_sha as string | null;
            } else if (state.row.head_sha === guarded.head) {
              state.row.head_sha = guarded.value as string;
            }
            if ("published_sha" in payload) state.row.published_sha = payload.published_sha as string | null;
          }
          return { where: async () => undefined };
        },
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
      head_sha: state.loadedHead,
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

const RECORDED = "0123456789abcdef0123456789abcdef01234567";
const AHEAD = "1111111111111111111111111111111111111111";

const { getRepoHead, getFileAtRef } = vi.hoisted(() => ({
  getRepoHead: vi.fn(async () => "0123456789abcdef0123456789abcdef01234567"),
  getFileAtRef: vi.fn(async () => ({ status: "ok" as const, content: "title: \"x\"\n" })),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getRepoHead, getFileAtRef };
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
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet: vi.fn(async () => []) };
});
const { controlFreezeLease } = vi.hoisted(() => ({ controlFreezeLease: vi.fn(async () => true) }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease,
  newFreezeOperationId: () => "op-publish",
}));

import { action } from "~/routes/_app.publish";
import { prepareObjectsCommit } from "~/lib/pending-object-ops.server";

const snapshotFetch = vi.fn(async () => new Response("OK", { status: 200 }));

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

async function runPublish() {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Publish site");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: buildContext(),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.loadedHead = RECORDED;
  state.projectWrites.length = 0;
  state.row.head_sha = RECORDED;
  state.row.published_sha = null;
  getRepoHead.mockResolvedValue(RECORDED);
});

describe("a publish on a GitHub head ahead of the recorded head", () => {
  beforeEach(() => {
    getRepoHead.mockResolvedValue(AHEAD);
  });

  it("refuses stale_head, naming the project", async () => {
    expect(await runPublish()).toEqual({ ok: false, intent: "publish", error: "stale_head", projectId: 7 });
  });

  it("refuses before the objects are finished and the snapshot is forced", async () => {
    await runPublish();
    expect(prepareObjectsCommit).not.toHaveBeenCalled();
    expect(snapshotFetch).not.toHaveBeenCalled();
  });

  it("commits and records nothing, and lets the lease go as failed", async () => {
    await runPublish();
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(state.projectWrites).toEqual([]);
    expect(controlFreezeLease.mock.calls.map((c) => (c as unknown[])[3])).toEqual([
      { op: "begin", kind: "publish", operationId: "op-publish" },
      { op: "end", operationId: "op-publish", outcome: "failed" },
    ]);
  });

  it("refuses a project with no head recorded", async () => {
    state.loadedHead = null;
    expect(await runPublish()).toMatchObject({ ok: false, error: "stale_head" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });
});

describe("a publish on the recorded head", () => {
  it("commits on it and records the new commit from it", async () => {
    expect(await runPublish()).toMatchObject({ ok: true, intent: "publish", newHeadSha: "new-sha" });
    expect((commitFilesToRepo.mock.calls[0] as unknown[])[9]).toBe(RECORDED);
    expect(state.projectWrites).toHaveLength(1);
    expect(state.projectWrites[0]).toMatchObject({
      published_sha: "new-sha",
      head_sha: "new-sha",
      head_sha_from: RECORDED,
      gh_checked_at: null,
    });
  });

  // The preparation reads the record a row D1 holds under a stripped id is
  // judged against from the project itself, so none is passed.
  it("prepares the objects at the recorded head", async () => {
    await runPublish();
    expect(vi.mocked(prepareObjectsCommit).mock.calls[0]).toEqual([
      expect.anything(), expect.anything(), 7, expect.objectContaining({ head: RECORDED }),
    ]);
  });

  it("answers a row D1 holds under a stripped id as a head to sync, and commits nothing", async () => {
    const { ObjectsSheetChanged } = await vi.importActual<typeof import("~/lib/pending-object-ops.server")>(
      "~/lib/pending-object-ops.server",
    );
    vi.mocked(prepareObjectsCommit).mockRejectedValueOnce(new ObjectsSheetChanged());
    expect(await runPublish()).toEqual({ ok: false, intent: "publish", error: "stale_head", projectId: 7 });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("advances the record of the objects.csv read with the head, from the head it published on", async () => {
    await runPublish();
    expect(state.projectWrites[0]).toMatchObject({
      objects_read_sha: "new-sha",
      objects_read_sha_while_head: RECORDED,
      objects_read_sha_from: RECORDED,
    });
  });

  it("advances the row's head to its commit when no other writer moved it", async () => {
    await runPublish();
    expect(state.row).toEqual({ head_sha: "new-sha", published_sha: "new-sha" });
  });

  it("keeps a head another writer recorded after the pre-check, and still reports its commit", async () => {
    const COMPETING = "2222222222222222222222222222222222222222";
    // Past the pre-check, while the commit is in flight, Keep my version (which
    // takes no lease) records another head.
    commitFilesToRepo.mockImplementationOnce(async () => {
      state.row.head_sha = COMPETING;
      return { newHeadSha: "new-sha" };
    });
    const res = await runPublish();
    expect(res).toMatchObject({ ok: true, intent: "publish", newHeadSha: "new-sha" });
    expect(state.row.head_sha).toBe(COMPETING);
    // What the publish committed is recorded either way.
    expect(state.row.published_sha).toBe("new-sha");
    expect(typeof state.projectWrites[0].publish_snapshot).toBe("string");
  });
});
