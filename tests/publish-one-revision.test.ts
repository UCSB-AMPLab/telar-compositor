/**
 * This file pins that one publish is one revision of the repository.
 *
 * A publish reads the repository four times over: the check that decides
 * whether it may run, the assembly that builds the file set, the framework-file
 * heal that adds what a site is missing, and the commit that names the head it
 * expects to replace. Each read that resolves a branch NAME resolves it again,
 * and a hand commit landing between two of them puts the publish across two
 * revisions: the file set carries the older file, the commit succeeds over the
 * newer head, and the author's hand edit is silently undone. The heal is the
 * sharpest case — it reads the DEFAULT branch, so on a site whose default is
 * not the branch being published it can add a framework copy of a file the
 * target branch already has.
 *
 * So the action resolves the head once and every read carries that SHA,
 * including the one the commit is told to expect: a hand commit in the window
 * then fails the publish with the stale-head outcome the page already reports,
 * which is the honest answer — nothing is lost, and the author republishes.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
// The objects operations a publish finishes first are tested in
// tests/publish-pending-objects.test.ts; here there are none.
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/db.server", () => ({
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
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  })),
}));

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
      // The recorded head, the one the repository is at: a publish commits only on it.
      head_sha: "sha-at-the-start",
      publish_snapshot: null,
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

const PUBLISH_SHA = "sha-at-the-start";

const { getRepoHead, getFileAtRef } = vi.hoisted(() => ({
  getRepoHead: vi.fn(async () => "sha-at-the-start"),
  getFileAtRef: vi.fn(async () => ({ status: "ok" as const, content: "title: \"x\"\n" })),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getRepoHead, getFileAtRef };
});

const { healMissingFrameworkFiles } = vi.hoisted(() => ({
  healMissingFrameworkFiles: vi.fn(async () => [] as unknown[]),
}));
vi.mock("~/lib/upgrade.server", () => ({ healMissingFrameworkFiles }));

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

const { buildPublishFileSet } = vi.hoisted(() => ({
  buildPublishFileSet: vi.fn(async () => [] as unknown[]),
}));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet };
});

// The freeze lease is the Durable Object's; here only the calls the action
// makes to it are observed.
const { controlFreezeLease } = vi.hoisted(() => ({ controlFreezeLease: vi.fn(async () => true) }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease,
  newFreezeOperationId: () => "op-publish",
}));

import { action } from "~/routes/_app.publish";

function buildContext() {
  const doStub = { fetch: async () => new Response("OK", { status: 200 }) };
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => doStub) },
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
    request: new Request("https://app/publish", {
      method: "POST",
      body: form,
      headers: { Cookie: "" },
    }),
    context: buildContext(),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as { ok?: boolean; error?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("one publish, one revision", () => {
  it("resolves the head once, however many readers there are", async () => {
    await runPublish();

    expect(getRepoHead).toHaveBeenCalledTimes(1);
  });

  it("reads the config it checks at that SHA, not at a branch name", async () => {
    await runPublish();

    for (const call of getFileAtRef.mock.calls) {
      expect((call as unknown[])[4]).toBe(PUBLISH_SHA);
    }
  });

  it("assembles the file set at that SHA", async () => {
    await runPublish();

    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
    expect((buildPublishFileSet.mock.calls[0] as unknown[])[0]).toMatchObject({
      ref: PUBLISH_SHA,
    });
  });

  it("heals framework files against that SHA's tree, not the default branch", async () => {
    await runPublish();

    expect(healMissingFrameworkFiles).toHaveBeenCalledTimes(1);
    expect(healMissingFrameworkFiles.mock.calls[0] as unknown[]).toContain(PUBLISH_SHA);
  });

  it("tells the commit which head it expects to replace", async () => {
    await runPublish();

    expect((commitFilesToRepo.mock.calls[0] as unknown[])[9]).toBe(PUBLISH_SHA);
  });

  // The window the SHA exists to close: someone commits by hand while the
  // publish is assembling. The commit refuses, and the author is told the head
  // moved rather than watching their own edit disappear.
  it("fails with the stale-head outcome when a hand commit lands in the window", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new StaleHeadError("head moved"));

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, error: "stale_head" });
  });
});

describe("the freeze a publish holds", () => {
  const controls = () => controlFreezeLease.mock.calls.map((call) => (call as unknown[])[3]);

  it("begins before the commit and ends as succeeded once it lands", async () => {
    const res = await runPublish();

    expect(res).toMatchObject({ ok: true });
    expect(controls()).toEqual([
      { op: "begin", kind: "publish", operationId: "op-publish" },
      { op: "end", operationId: "op-publish", outcome: "succeeded" },
    ]);
  });

  it("ends as failed when the commit is refused", async () => {
    commitFilesToRepo.mockRejectedValueOnce(new StaleHeadError("head moved"));

    await runPublish();

    expect(controls()).toEqual([
      { op: "begin", kind: "publish", operationId: "op-publish" },
      { op: "end", operationId: "op-publish", outcome: "failed" },
    ]);
  });

  it("publishes as before when the freeze cannot be raised", async () => {
    // Advisory: a lease the object would not take is no reason to refuse.
    controlFreezeLease.mockResolvedValue(false);

    const res = await runPublish();

    expect(res).toMatchObject({ ok: true });
    controlFreezeLease.mockResolvedValue(true);
  });
});
