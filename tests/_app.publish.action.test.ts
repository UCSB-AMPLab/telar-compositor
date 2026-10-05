/**
 * The publish action must never ship a site that is missing the author's
 * edits behind a success banner. Its force-snapshot block has exactly three
 * outcomes, and this file locks all three.
 *
 *   - `snapshotRes.ok` → the DO ANSWERED. Either it snapshotted, or it had no
 *     project bound (no live editing session ever reached this instance) and
 *     skipped. D1 is authoritative → publish.
 *   - `!snapshotRes.ok` → the DO answered and its snapshot FAILED. The author's
 *     edits are in the DO, not in D1 → refuse with `snapshot_failed`.
 *   - `doStub.fetch(...)` REJECTS → the DO could not answer at all → refuse
 *     with `snapshot_unreachable`.
 *
 * The third outcome is NOT "no DO instance is alive". A stub fetch instantiates
 * the object on demand, so an absent instance is created, finds `projectId ===
 * null`, and answers 200 — the first outcome. A rejection means the instance
 * could not respond, which is precisely the state in which D1 may be stale.
 * Tolerating it is what let a reset DO publish stale content.
 *
 * The two refusals carry different error codes so the UI can tell a failed
 * snapshot from an unreachable session.
 *
 * The `poll-build` answers are pinned here too: each names the commit it
 * answers for, which is what lets a caller running two builds at once — the
 * repair's rebuild beside a publish — tell a late answer from the current one.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — paths/exports verified against app/routes/_app.publish.tsx imports.
// Resolved-module-id equality is what vi.mock matches on: the route imports
// signInternalMarker from "../../workers/auth" (app/routes/ → root/workers),
// and this test file in tests/ reaches the same module via "../workers/auth".
// ---------------------------------------------------------------------------

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));
// The objects operations a publish finishes first are tested in
// tests/publish-pending-objects.test.ts; here there are none.
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/db.server", () => ({
  // Every chain resolves empty. The action reads page rows for its
  // post-snapshot blocker check before assembling anything, so a bare object
  // here would throw there and never reach the file-set build this file
  // asserts on. No rows means no blockers, which is the state the "continue"
  // case needs; that case then lands in the action's outer catch further down
  // → error: "publish_failed" (NOT "snapshot_failed"), which is exactly the
  // distinction this test asserts.
  getDb: vi.fn(() => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve([]), chain);
      // A read ordered with `.orderBy()` (objects, in `objectsSheetOrder`) answers the same rows.
      chain.orderBy = function (this: unknown) { return this; };
      chain.limit = () => Promise.resolve([]);
      return chain;
    },
  })),
}));

// The publish path reaches GitHub after the file set is built. Stubbed so the
// assertions here are about the action's control flow, not the network.
vi.mock("~/lib/upgrade.server", () => ({
  healMissingFrameworkFiles: vi.fn(async () => []),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })),
  listWorkflowRunsBySha: vi.fn(),
  isRepoPrivate: vi.fn(async () => null),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "tok"),
}));

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

// The action resolves the revision it publishes before anything else; these
// cases are about the forced snapshot, so any SHA will do for them. The
// _config.yml read is stubbed to "absent" — a repository with no such file,
// which publishes — because an unstubbed read reaches the network and a read
// that fails is its own refusal, which would stand in for the snapshot outcome
// these cases are about.
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(async () => "sha-at-the-start"),
    getFileAtRef: vi.fn(async () => ({ status: "absent" })),
  };
});

// vi.hoisted so the spy exists before the hoisted vi.mock factory runs.
const { buildPublishFileSet } = vi.hoisted(() => ({
  buildPublishFileSet: vi.fn(async () => [] as unknown[]),
}));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.publish";
import { listWorkflowRunsBySha, isRepoPrivate } from "~/lib/commit.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DOFetch = (request: Request) => Promise<Response>;

function buildContext(doFetch: DOFetch) {
  const user = { id: 1, encrypted_access_token: "x", github_login: "u" };
  const doStub = { fetch: doFetch };
  const COLLABORATION = {
    idFromName: vi.fn(() => "do-id"),
    get: vi.fn(() => doStub),
  };
  const env = {
    DB: {},
    SESSION_SECRET: "s",
    ENCRYPTION_KEY: "k",
    COLLABORATION,
  };
  return {
    get: vi.fn(() => user),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

// The active project every request must post against: the mocked
// `resolveActiveProject`'s id, string-compared by `resolvePageProject`.
const ACTIVE_SITE_ID = "7";

function buildRequest(): Request {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("siteId", ACTIVE_SITE_ID);
  return new Request("https://app/publish", {
    method: "POST",
    body: form,
    headers: { Cookie: "" },
  });
}

function buildPollRequest(sha: string): Request {
  const form = new FormData();
  form.set("intent", "poll-build");
  form.set("sha", sha);
  form.set("siteId", ACTIVE_SITE_ID);
  return new Request("https://app/publish", {
    method: "POST",
    body: form,
    headers: { Cookie: "" },
  });
}

/** The DO is never reached by a poll; any stub will do. */
const idleDoFetch: DOFetch = async () => new Response("OK", { status: 200 });

async function poll(sha: string) {
  return await action({
    request: buildPollRequest(sha),
    context: buildContext(idleDoFetch),
    params: {},
  } as unknown as Parameters<typeof action>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publish action — force-snapshot outcomes", () => {
  it("returns snapshot_failed and does NOT build the publish file set when /snapshot returns 500", async () => {
    const doFetch: DOFetch = async () =>
      new Response("snapshot_failed", { status: 500 });
    const res = await action({
      request: buildRequest(),
      context: buildContext(doFetch),
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "snapshot_failed" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("returns snapshot_incomplete and does NOT build the publish file set when an entity INSERT did not land", async () => {
    // The snapshot ran and wrote everything it could, but one entity has no D1
    // row behind it. Publishing from D1 now ships an objects.csv missing that
    // object under a success banner, so the action refuses — with its own code,
    // because the edits are not merely unsaved: a specific entity is absent.
    const doFetch: DOFetch = async () =>
      new Response("snapshot_incomplete", { status: 500 });
    const res = await action({
      request: buildRequest(),
      context: buildContext(doFetch),
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "snapshot_incomplete" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("returns snapshot_unreachable and does NOT build the publish file set when the DO fetch rejects", async () => {
    const doFetch: DOFetch = async () => {
      throw new Error("DO unreachable");
    };
    const res = await action({
      request: buildRequest(),
      context: buildContext(doFetch),
      params: {},
    } as unknown as Parameters<typeof action>[0]);

    expect(res).toMatchObject({
      ok: false,
      intent: "publish",
      error: "snapshot_unreachable",
    });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("publishes from D1 when the DO answers 200 (the no-live-editing-session case)", async () => {
    // A project with nobody editing: the stub fetch instantiates the DO, which
    // finds no bound projectId and answers 200 without snapshotting. This is
    // the reachable "publish from D1" path — a rejection never was.
    const doFetch: DOFetch = async () => new Response("OK", { status: 200 });
    const res = (await action({
      request: buildRequest(),
      context: buildContext(doFetch),
      params: {},
    } as unknown as Parameters<typeof action>[0])) as { error?: string };

    // Past the snapshot block: the file-set build ran. Downstream the unmocked
    // db chain throws into the action's outer catch → publish_failed, which is
    // fine — the assertion is that the snapshot block let it through.
    expect(res?.error).not.toBe("snapshot_failed");
    expect(res?.error).not.toBe("snapshot_unreachable");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });
});

describe("publish action — the freeze ends however the publish does", () => {
  /** A DO that records the paths it is asked for, answering the snapshot with `snapshot`. */
  function recordingDo(snapshot: () => Promise<Response>) {
    const seen: string[] = [];
    const doFetch: DOFetch = async (request) => {
      const url = new URL(request.url);
      seen.push(`${url.pathname}${url.searchParams.get("control") ? ` ${url.searchParams.get("control")}` : ""}`);
      return url.pathname === "/snapshot" ? snapshot() : new Response("OK", { status: 200 });
    };
    return { seen, doFetch };
  }

  async function publishWith(doFetch: DOFetch) {
    return await action({
      request: buildRequest(),
      context: buildContext(doFetch),
      params: {},
    } as unknown as Parameters<typeof action>[0]);
  }

  it("is raised before the snapshot and ended as failed when the snapshot refuses", async () => {
    const { seen, doFetch } = recordingDo(async () => new Response("snapshot_failed", { status: 500 }));
    await publishWith(doFetch);
    expect(seen[0]).toMatch(/^\/freeze begin:publish:/);
    expect(seen[1]).toBe("/snapshot");
    expect(seen.at(-1)).toMatch(/^\/freeze end:.+:failed$/);
    expect(seen).toHaveLength(3);
  });

  it("is ended as failed when the object cannot be reached for the snapshot", async () => {
    const { seen, doFetch } = recordingDo(async () => {
      throw new Error("DO unreachable");
    });
    const res = await publishWith(doFetch);
    expect(res).toMatchObject({ error: "snapshot_unreachable" });
    expect(seen.at(-1)).toMatch(/^\/freeze end:.+:failed$/);
  });

  it("stops before the snapshot while another publish or upgrade holds the lock", async () => {
    const seen: string[] = [];
    const doFetch: DOFetch = async (request) => {
      const url = new URL(request.url);
      seen.push(url.pathname);
      return url.pathname === "/freeze"
        ? new Response("freeze_refused", { status: 409 })
        : new Response("OK", { status: 200 });
    };
    expect(await publishWith(doFetch)).toMatchObject({ ok: false, error: "operation_in_progress" });
    expect(seen).toEqual(["/freeze"]);
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("does not change the snapshot's refusal when the freeze itself cannot be raised", async () => {
    const doFetch: DOFetch = async (request) => {
      if (new URL(request.url).pathname === "/freeze") throw new Error("freeze unreachable");
      return new Response("snapshot_failed", { status: 500 });
    };
    expect(await publishWith(doFetch)).toMatchObject({ ok: false, error: "snapshot_failed" });
  });
});

describe("publish action — poll-build names the commit it answers for", () => {
  it("returns the sha beside a run's status", async () => {
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([
      { id: 11, status: "in_progress", conclusion: null, html_url: "https://gh/run/11" },
    ] as never);

    expect(await poll("asked-sha")).toEqual({
      ok: true,
      intent: "poll-build",
      sha: "asked-sha",
      buildStatus: "in_progress",
      buildConclusion: null,
      buildUrl: "https://gh/run/11",
      runId: 11,
      phases: null,
      repoPrivate: null,
    });
  });

  it("returns the sha when GitHub has registered no run for it yet", async () => {
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([] as never);

    expect(await poll("asked-sha")).toEqual({
      ok: true,
      intent: "poll-build",
      sha: "asked-sha",
      buildStatus: "pending",
      buildConclusion: null,
      buildUrl: null,
      runId: null,
      phases: null,
      repoPrivate: null,
    });
  });

  // The failure card names a private repository as the cause of a failed
  // build, so the poll has to ask — and has to ask only then. Asking on every
  // poll would put a GitHub request on a five-second loop for every publish in
  // the product, and asking on success would let a card claim a cause for
  // something that did not go wrong.
  it("asks whether the repository is private once a build has failed", async () => {
    vi.mocked(isRepoPrivate).mockResolvedValueOnce(true);
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([
      { id: 12, status: "completed", conclusion: "failure", html_url: "https://gh/run/12" },
    ] as never);

    expect(await poll("asked-sha")).toMatchObject({ repoPrivate: true });
    expect(isRepoPrivate).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the build succeeded", async () => {
    vi.mocked(isRepoPrivate).mockClear();
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([
      { id: 13, status: "completed", conclusion: "success", html_url: "https://gh/run/13" },
    ] as never);

    expect(await poll("asked-sha")).toMatchObject({ repoPrivate: null });
    expect(isRepoPrivate).not.toHaveBeenCalled();
  });

  it("does not ask while the build is still running", async () => {
    vi.mocked(isRepoPrivate).mockClear();
    vi.mocked(listWorkflowRunsBySha).mockResolvedValue([
      { id: 14, status: "in_progress", conclusion: null, html_url: "https://gh/run/14" },
    ] as never);

    expect(await poll("asked-sha")).toMatchObject({ repoPrivate: null });
    expect(isRepoPrivate).not.toHaveBeenCalled();
  });

  it("returns the sha when the poll itself failed", async () => {
    vi.mocked(listWorkflowRunsBySha).mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await poll("asked-sha")).toEqual({
      ok: false,
      intent: "poll-build",
      sha: "asked-sha",
      error: "poll_failed",
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("poll-build"), expect.any(Error));
  });
});
