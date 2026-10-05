/**
 * An uploaded object is registered when its commit lands.
 *
 * Registration used to wait for the build, and ran from the uploader's open
 * tab: a build a newer commit cancelled, or a tab closed before the build
 * ended, left the images and CSV rows committed with nothing registered, and
 * the next publish then wrote them out of objects.csv. These cases hold the
 * two committing actions to registering on the server as soon as the commit
 * is in, whatever the dispatch and the build then do, and hold the retry to
 * the project the commit ran against.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testGithubAppPrivateKey, installGithubAppFetchStub } from "./helpers/github-app-fetch";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 42) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 },
    userRole: "convenor",
  })),
}));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
// The operation lock is granted: these cases are about what the
// action does once it holds it.
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "op-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "head-sha"),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(async () => null),
  getFileAtRef: vi.fn(async () => ({ status: "absent" })),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));
// The version gate (readRepoWriteGate) runs for real. These databases record
// no site version, which it reads as current without a lookup, so what these
// cases pin is a write the gate does not stop; the lookup answers a failure
// so that a site version reaching it here would refuse loudly.
/** The project row's head_sha, as D1 holds it. */
const headRow = vi.hoisted(() => ({ head_sha: null as string | null }));
vi.mock("~/lib/github-status.server", () => ({
  bumpProjectHeadFrom: vi.fn(async (_db: unknown, _id: number, fromSha: string | null, toSha: string) => {
    if (headRow.head_sha !== fromSha) return false;
    headRow.head_sha = toSha;
    return true;
  }),
  getCachedLatestTag: vi.fn(async () => null),
  readLatestTag: vi.fn(async () => ({ ok: false })),
}));
vi.mock("~/lib/sync.server", () => ({
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
  computeSyncDiff: vi.fn(),
  applySyncChanges: vi.fn(),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(async () => ({ runId: 11, htmlUrl: "https://gh/run/11" })),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn(),
  verifySiteUrl: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
  SheetsNotDisableableError: class SheetsNotDisableableError extends Error {},
}));
// ~/lib/github-app.server is left entirely unmocked: resolveProjectToken and
// getInstallationToken run for real, against a throwaway RSA key, with only
// the network boundary (fetch) stubbed below — see
// tests/helpers/github-app-fetch.ts for why a mock of getInstallationToken
// itself cannot intercept resolveProjectToken's internal call to it, and
// why this suite instead needs the real fallback logic to run.
vi.mock("~/lib/csv-export.server", () => ({
  serializeObjectsCsv: vi.fn(() => "csv-content"),
  dbObjectToCsvRow: vi.fn((o: unknown) => o),
}));
vi.mock("~/lib/upload.server", () => ({
  createImageBlobs: vi.fn(async () => []),
  commitMultipleBinaryFilesWithCsv: vi.fn(async () => ({ newHeadSha: "new-sha" })),
  arrayBufferToBase64: vi.fn(() => "base64data"),
  validateUploadFile: vi.fn(() => null),
}));
// REAL slugify (the normalisation under test); mocked unique-slug generator
// so we can capture exactly what the action requests.
vi.mock("~/lib/slugify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/slugify")>();
  return { slugify: actual.slugify, generateUniqueObjectSlug: vi.fn() };
});
/** Every call into the registration, in order with the commit and dispatch. */
const events: string[] = [];
/** Every config repair, in order. */
const configWrites: Array<Record<string, unknown>> = [];
vi.mock("~/lib/register-objects.server", () => ({
  registerCommittedObjects: vi.fn(async () => {
    events.push("register");
    return { ok: true, insertedCount: 1, alreadyPresent: [], failed: [] };
  }),
}));
/** The repair writes the config, through the document and then D1. */
vi.mock("~/lib/config-repair.server", () => ({
  repairSiteConfig: vi.fn(async (_db: unknown, _env: unknown, _id: number, values: Record<string, unknown>) => {
    configWrites.push(values);
    events.push("config-write");
    return "applied";
  }),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({
  findYMapById: vi.fn(),
  findYMapByIdOrTempId: vi.fn(),
}));

import { action } from "~/routes/_app.objects";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { generateUniqueObjectSlug } from "~/lib/slugify";
import { commitMultipleBinaryFilesWithCsv } from "~/lib/upload.server";
import { getCachedLatestTag } from "~/lib/github-status.server";
import { disableGoogleSheetsInConfig, SheetsNotDisableableError, dispatchWorkflow, commitFilesToRepo, listWorkflowRunsBySha, getJobSteps, mapStepsToBuildPhases, StaleHeadError, verifySiteUrl } from "~/lib/commit.server";
import { bumpProjectHeadFrom } from "~/lib/github-status.server";
import { registerCommittedObjects } from "~/lib/register-objects.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { getFileAtRef, getFileContent, getRepoHead } from "~/lib/github.server";
import { completePendingObjectOps, readPendingObjectOp } from "~/lib/pending-object-ops.server";
import { createImageBlobs } from "~/lib/upload.server";

function buildUploadRequest(metadata: Record<string, string>): Request {
  const form = new FormData();
  form.set("intent", "upload-image");
  form.set("siteId", "42");
  form.append(
    "imageFile",
    new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", { type: "image/jpeg" })
  );
  form.set(
    "metadataArray",
    JSON.stringify([
      {
        objectId: "",
        title: "A Title",
        creator: "",
        description: "",
        source: "",
        credit: "",
        period: "",
        year: "",
        altText: "",
        ...metadata,
      },
    ])
  );
  return new Request("https://compositor.telar.org/objects", { method: "POST", body: form });
}

function buildContext(userId = 7) {
  const user = { id: userId, encrypted_access_token: "enc-token" };
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    GITHUB_APP_ID: "app-id",
    GITHUB_PRIVATE_KEY: testGithubAppPrivateKey(),
  };
  return {
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"],
  };
}

function makeDbMock() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          // The project's objects, read to assemble objects.csv.
          orderBy: vi.fn(async () => {
            events.push("d1");
            return [];
          }),
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          configWrites.push(values);
          events.push("config-write");
        }),
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installGithubAppFetchStub();
  vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
    userRole: "convenor",
  });
  vi.mocked(generateUniqueObjectSlug).mockImplementation(async (slug: string) => slug);
  events.length = 0;
  configWrites.length = 0;
  // The commits below build on "head-sha", the head getRepoHead answers.
  headRow.head_sha = "head-sha";
  vi.mocked(commitMultipleBinaryFilesWithCsv).mockImplementation(async () => {
    events.push("commit");
    return { newHeadSha: "new-sha" };
  });
  vi.mocked(commitFilesToRepo).mockImplementation(async () => {
    events.push("commit");
    return { newHeadSha: "new-sha" } as never;
  });
  vi.mocked(dispatchWorkflow).mockImplementation(async () => {
    events.push("dispatch");
    return { runId: 11, htmlUrl: "https://gh/run/11" } as never;
  });
  vi.mocked(controlFreezeLease).mockImplementation(async (_env, _project, _user, control) => {
    events.push(control.op === "begin" ? `begin:${control.kind}` : control.op === "end" ? `end:${control.outcome}` : control.op);
    return "applied";
  });
  vi.mocked(createImageBlobs).mockImplementation(async () => {
    events.push("blobs");
    return [{ path: "telar-content/objects/a-title.jpg", mode: "100644", type: "blob", sha: "blob-1" }];
  });
  vi.mocked(getRepoHead).mockImplementation(async () => {
    events.push("head");
    return "head-sha";
  });
  vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) => {
    events.push(`read:${path.split("/").pop()}`);
    return null;
  });
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
    events.push(`read:${path.split("/").pop()}`);
    return { status: "absent" };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Answer = { ok: boolean; error?: string; projectId?: number; registration?: { ok: boolean } };

async function upload(): Promise<Answer> {
  const { context } = buildContext();
  return (await action({ request: buildUploadRequest({}), context, params: {} } as never)) as Answer;
}

/** `siteId` defaults to the resolved project (42); `insert-pending-objects`
 * ignores it (its own `projectId` field is what it checks) and every other
 * case here resolves project 42. */
function post(fields: Record<string, string>): Request {
  return new Request("https://compositor.telar.org/objects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ siteId: "42", ...fields }).toString(),
  });
}

const pendingOne = [{ object_id: "a-title", title: "A Title", featured: false, image_available: false }];

describe("upload-image registers the objects when the commit lands", () => {
  it("registers after the commit and before the dispatch, as the uploader, on the project", async () => {
    const res = await upload();
    expect(res).toMatchObject({ ok: true, projectId: 42, registration: { ok: true } });
    expect(events.filter((e) => ["commit", "register", "dispatch"].includes(e))).toEqual(["commit", "register", "dispatch"]);
    const [, , projectId, actorId, pending] = vi.mocked(registerCommittedObjects).mock.calls[0];
    expect([projectId, actorId]).toEqual([42, 7]);
    expect((pending as Array<{ object_id: string }>).map((p) => p.object_id)).toEqual(["a-title"]);
  });

  it("registers when the dispatch fails", async () => {
    vi.mocked(dispatchWorkflow).mockRejectedValueOnce(new Error("dispatch refused"));
    const res = await upload();
    expect(res.ok).toBe(true);
    expect(registerCommittedObjects).toHaveBeenCalledTimes(1);
  });

  it("answers the commit as landed when the registration fails, carrying the failure", async () => {
    vi.mocked(registerCommittedObjects).mockResolvedValueOnce({ ok: false, error: "insert_failed" });
    const res = await upload();
    expect(res).toMatchObject({ ok: true, registration: { ok: false } });
  });

  it("registers and answers ok when recording the new head fails after the commit", async () => {
    vi.mocked(bumpProjectHeadFrom).mockRejectedValueOnce(new Error("D1 unavailable"));
    const res = await upload();
    expect(res).toMatchObject({ ok: true, registration: { ok: true } });
    expect(registerCommittedObjects).toHaveBeenCalledTimes(1);
  });

  it("registers nothing when the commit fails", async () => {
    vi.mocked(commitMultipleBinaryFilesWithCsv).mockRejectedValueOnce(new Error("GitHub refused"));
    const res = await upload();
    expect(res.ok).toBe(false);
    expect(registerCommittedObjects).not.toHaveBeenCalled();
  });
});

describe("commit-objects registers the objects when the commit lands", () => {
  it("registers after the commit and before the dispatch", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: post({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify(pendingOne) }),
      context,
      params: {},
    } as never)) as Answer;
    expect(res).toMatchObject({ ok: true, projectId: 42, registration: { ok: true } });
    expect(events.filter((e) => ["commit", "register", "dispatch"].includes(e))).toEqual(["commit", "register", "dispatch"]);
    const [, , projectId, actorId, pending] = vi.mocked(registerCommittedObjects).mock.calls[0];
    expect([projectId, actorId, pending]).toEqual([42, 7, pendingOne]);
  });

  it("registers when recording the new head fails after the commit", async () => {
    vi.mocked(bumpProjectHeadFrom).mockRejectedValueOnce(new Error("D1 unavailable"));
    const { context } = buildContext();
    const res = (await action({
      request: post({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify(pendingOne) }),
      context,
      params: {},
    } as never)) as Answer;
    expect(res.ok).toBe(true);
    expect(registerCommittedObjects).toHaveBeenCalledTimes(1);
  });
});

// A sync apply records what it applied under the objects lease; an
// objects commit's record of its own commit moves the same columns, so it is
// made before the commit releases the lease.
describe("commit-objects' record of its commit", () => {
  it("is made while the commit holds the objects lease", async () => {
    const order: string[] = [];
    vi.mocked(controlFreezeLease).mockImplementation(async (_env, _project, _user, control) => {
      order.push(control.op);
      return "applied";
    });
    vi.mocked(bumpProjectHeadFrom).mockImplementationOnce(async () => {
      order.push("record head_sha");
      return true;
    });
    const { context } = buildContext();
    const res = (await action({
      request: post({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify(pendingOne) }),
      context,
      params: {},
    } as never)) as Answer;
    expect(res.ok).toBe(true);
    expect(order).toEqual(["begin", "record head_sha", "end"]);
  });
});

describe("commit-objects when Google Sheets cannot be turned off", () => {
  it("refuses with commit_failed, committing and registering nothing", async () => {
    const originalRead = vi.mocked(getFileContent).getMockImplementation();
    vi.mocked(verifySiteUrl).mockResolvedValueOnce({ pagesEnabled: true, match: true, pagesUrl: "p", configUrl: "p" });
    vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) =>
      path === "_config.yml" ? "google_sheets: *shared\n" : null,
    );
    vi.mocked(disableGoogleSheetsInConfig).mockImplementationOnce(() => {
      throw new SheetsNotDisableableError();
    });
    const { context } = buildContext();
    const res = (await action({
      request: post({ intent: "commit-objects", disableSheets: "true", pendingObjects: JSON.stringify(pendingOne) }),
      context,
      params: {},
    } as never)) as Answer;
    expect(res).toMatchObject({ ok: false, intent: "commit-objects", error: "commit_failed" });
    expect(disableGoogleSheetsInConfig).toHaveBeenCalledTimes(1);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(registerCommittedObjects).not.toHaveBeenCalled();
    vi.mocked(getFileContent).mockImplementation(originalRead!);
  });
});

describe("commit-objects when the dispatch or the registration fails", () => {
  function commitObjects() {
    const { context } = buildContext();
    return action({
      request: post({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify(pendingOne) }),
      context,
      params: {},
    } as never) as Promise<Answer & { dispatchFailed?: boolean }>;
  }

  it("registers when the dispatch fails", async () => {
    vi.mocked(dispatchWorkflow).mockRejectedValueOnce(new Error("dispatch refused"));
    const res = await commitObjects();
    expect(res).toMatchObject({ ok: true, dispatchFailed: true, registration: { ok: true } });
  });

  it("answers the commit as landed when the registration fails", async () => {
    vi.mocked(registerCommittedObjects).mockResolvedValueOnce({ ok: false, error: "insert_failed" });
    const res = await commitObjects();
    expect(res).toMatchObject({ ok: true, registration: { ok: false } });
  });
});

describe("the registration retry", () => {
  it("completes the named operation for the project the commit ran against", async () => {
    vi.mocked(readPendingObjectOp).mockResolvedValueOnce({ id: 5 } as never);
    vi.mocked(completePendingObjectOps).mockResolvedValueOnce({
      ok: true, outcomes: new Map([[5, "completed" as const]]), applied: true,
    });
    const { context } = buildContext();
    const res = (await action({
      request: post({ intent: "insert-pending-objects", operationId: "5", projectId: "42" }),
      context,
      params: {},
    } as never)) as Answer;
    expect(res.ok).toBe(true);
    const [, , projectId, , options] = vi.mocked(completePendingObjectOps).mock.calls[0];
    expect(projectId).toBe(42);
    expect(options).toEqual({ opIds: [5] });
  });

  // A mismatch answers the structured `site_changed` refusal every other
  // site-level intent gives (409), not the page's own `project_changed`
  // shape, so this reads the DataWithResponseInit envelope directly.
  it("is refused when the active project is no longer the one committed to", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: post({ intent: "insert-pending-objects", operationId: "5", projectId: "41" }),
      context,
      params: {},
    } as never)) as unknown as { data: { ok: boolean; intent: string; error: string; currentSiteName: string }; init: { status: number } };
    expect(res.init.status).toBe(409);
    expect(res.data).toEqual({
      ok: false,
      intent: "insert-pending-objects",
      error: "site_changed",
      currentSiteName: "owner/repo",
    });
    expect(completePendingObjectOps).not.toHaveBeenCalled();
  });
});

describe("polling a commit's build", () => {
  it("reports the run the modal tracks, not a later run for the same commit listed first", async () => {
    vi.mocked(listWorkflowRunsBySha).mockResolvedValueOnce([
      { id: 13, status: "in_progress", conclusion: null, html_url: "https://gh/run/13" },
      { id: 12, status: "completed", conclusion: "success", html_url: "https://gh/run/12" },
    ] as never);
    vi.mocked(getJobSteps).mockResolvedValueOnce([] as never);
    vi.mocked(mapStepsToBuildPhases).mockReturnValueOnce([] as never);
    const { context } = buildContext();
    const res = (await action({
      request: post({ intent: "poll-build", sha: "sha-1", runId: "12" }),
      context,
      params: {},
    } as never)) as { ok: boolean; runId: number; buildStatus: string; buildConclusion: string };
    expect(res).toMatchObject({ ok: true, runId: 12, buildStatus: "completed", buildConclusion: "success" });
  });
});

describe("the objects commits hold the lock and commit on the head they read", () => {
  function commitObjects() {
    const { context } = buildContext();
    return action({
      request: post({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify(pendingOne) }),
      context,
      params: {},
    } as never) as Promise<Answer>;
  }

  it("upload: makes the blobs, then locks, reads at one head, commits on it, registers and unlocks", async () => {
    const res = await upload();
    expect(res.ok).toBe(true);
    expect(events).toEqual([
      "blobs", "begin:objects", "head", "read:objects.csv", "read:objetos.csv", "d1", "commit", "register", "end:succeeded", "dispatch",
    ]);
    expect(vi.mocked(getFileAtRef).mock.calls[0][4]).toBe("head-sha");
    expect(vi.mocked(commitMultipleBinaryFilesWithCsv).mock.calls[0][0]).toMatchObject({
      expectedHeadSha: "head-sha",
      imageBlobs: [{ sha: "blob-1" }],
    });
  });

  it("objects commit: locks, reads at one head, commits on it, registers and unlocks", async () => {
    const res = await commitObjects();
    expect(res.ok).toBe(true);
    expect(events).toEqual([
      "begin:objects", "head", "read:_config.yml", "read:objects.csv", "read:objetos.csv", "d1", "commit", "register", "end:succeeded", "dispatch",
    ]);
    expect(vi.mocked(getFileContent).mock.calls.map((c) => c[4])).toEqual(["head-sha"]);
    expect(vi.mocked(getFileAtRef).mock.calls.map((c) => c[4])).toEqual(["head-sha", "head-sha"]);
    expect(vi.mocked(commitFilesToRepo).mock.calls[0][9]).toBe("head-sha");
  });

  it.each<[string, () => Promise<Answer>]>([
    ["upload", () => upload()],
    ["objects commit", () => commitObjects()],
  ])("%s: a lock someone else holds refuses it before anything is read or committed", async (_name, run) => {
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");
    const res = await run();
    expect(res).toMatchObject({ ok: false, error: "operation_in_progress" });
    expect(events).not.toContain("head");
    expect(events).not.toContain("commit");
    expect(registerCommittedObjects).not.toHaveBeenCalled();
  });

  it("upload: a head that moved is refused as stale, registers nothing and ends the lease as failed", async () => {
    vi.mocked(commitMultipleBinaryFilesWithCsv).mockRejectedValueOnce(new StaleHeadError("moved"));
    const res = await upload();
    expect(res).toMatchObject({ ok: false, error: "stale_head" });
    expect(registerCommittedObjects).not.toHaveBeenCalled();
    expect(events).toContain("end:failed");
  });

  it("objects commit: a head that moved is refused as stale, registers nothing and ends the lease as failed", async () => {
    vi.mocked(commitFilesToRepo).mockRejectedValueOnce(new StaleHeadError("moved"));
    const res = await commitObjects();
    expect(res).toMatchObject({ ok: false, error: "stale_head" });
    expect(registerCommittedObjects).not.toHaveBeenCalled();
    expect(events).toContain("end:failed");
  });

  it("upload: ends the lease when a read throws", async () => {
    vi.mocked(getRepoHead).mockRejectedValueOnce(new Error("GitHub unavailable"));
    const res = await upload();
    expect(res.ok).toBe(false);
    expect(events).toEqual(["blobs", "begin:objects", "end:failed"]);
  });
});

describe("commit-objects repairs a fixed site URL only once its commit lands", () => {
  const staleConfig = 'title: "Site"\nurl: "https://old.example.org"\nbaseurl: "/old"\n';

  beforeEach(() => {
    vi.mocked(getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      events.push(`read:${path.split("/").pop()}`);
      return path === "_config.yml" ? staleConfig : null;
    });
    vi.mocked(verifySiteUrl).mockResolvedValue({
      pagesEnabled: true,
      match: false,
      pagesUrl: "https://owner.github.io/repo/",
    } as never);
  });

  function commitObjects() {
    const { context } = buildContext();
    return action({
      request: post({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify(pendingOne) }),
      context,
      params: {},
    } as never) as Promise<Answer>;
  }

  it("commits the fixed URL, then repairs it", async () => {
    const res = await commitObjects();
    expect(res).toMatchObject({ ok: true });
    const files = vi.mocked(commitFilesToRepo).mock.calls[0][4] as Array<{ path: string; content: string }>;
    const config = files.find((f) => f.path === "_config.yml")!.content;
    expect(config).toContain('url: "https://owner.github.io"');
    expect(config).toContain('baseurl: "/repo"');
    expect(configWrites).toEqual([
      expect.objectContaining({ url: "https://owner.github.io", baseurl: "/repo" }),
    ]);
    expect(configWrites[0]).not.toHaveProperty("google_sheets_enabled");
    expect(events.filter((e) => ["commit", "config-write"].includes(e))).toEqual(["commit", "config-write"]);
  });

  it("repairs nothing while the commit is still in flight", async () => {
    let land!: (value: { newHeadSha: string }) => void;
    vi.mocked(commitFilesToRepo).mockImplementationOnce(
      () => new Promise((resolve) => { events.push("commit"); land = resolve as never; }) as never,
    );
    const pending = commitObjects();
    await vi.waitFor(() => expect(events).toContain("commit"));
    await new Promise((r) => setTimeout(r, 0));
    expect(configWrites).toEqual([]);
    land({ newHeadSha: "new-sha" });
    expect(await pending).toMatchObject({ ok: true });
    expect(configWrites).toHaveLength(1);
  });

  it("answers the commit as landed when the repair is not confirmed", async () => {
    const { repairSiteConfig } = await import("~/lib/config-repair.server");
    vi.mocked(repairSiteConfig).mockResolvedValueOnce("uncertain");
    const res = await commitObjects();
    expect(res).toMatchObject({ ok: true });
    expect(registerCommittedObjects).toHaveBeenCalledTimes(1);
  });

  it("repairs nothing when the commit is refused as stale", async () => {
    vi.mocked(commitFilesToRepo).mockRejectedValueOnce(new StaleHeadError("moved"));
    const res = await commitObjects();
    expect(res).toMatchObject({ ok: false, error: "stale_head" });
    expect(configWrites).toEqual([]);
  });

  it("repairs nothing when the commit fails", async () => {
    vi.mocked(commitFilesToRepo).mockRejectedValueOnce(new Error("GitHub GraphQL error: 502"));
    const res = await commitObjects();
    expect(res).toMatchObject({ ok: false, error: "commit_failed" });
    expect(configWrites).toEqual([]);
  });

  it("repairs the URL and the Sheets flag in one call", async () => {
    const { context } = buildContext();
    const { disableGoogleSheetsInConfig } = await import("~/lib/commit.server");
    vi.mocked(disableGoogleSheetsInConfig).mockImplementation((c: string) => c);
    const res = (await action({
      request: post({ intent: "commit-objects", disableSheets: "true", pendingObjects: JSON.stringify(pendingOne) }),
      context,
      params: {},
    } as never)) as Answer;
    expect(res).toMatchObject({ ok: true });
    expect(configWrites).toEqual([
      { google_sheets_enabled: false, url: "https://owner.github.io", baseurl: "/repo" },
    ]);
  });
});

describe("an objects commit advances head_sha only from its own parent", () => {
  async function commitObjects(): Promise<Answer> {
    const { context } = buildContext();
    return (await action({
      request: post({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify(pendingOne) }),
      context,
      params: {},
    } as never)) as Answer;
  }

  for (const [name, run] of [["upload-image", upload], ["commit-objects", commitObjects]] as const) {
    it(`${name}: advances head_sha from the parent when the parent is the recorded head`, async () => {
      const res = await run();
      expect(res.ok).toBe(true);
      expect(headRow.head_sha).toBe("new-sha");
      expect(bumpProjectHeadFrom).toHaveBeenCalledWith(expect.anything(), 42, "head-sha", "new-sha");
    });

    it(`${name}: leaves head_sha when the parent is a GitHub commit the Compositor never read`, async () => {
      // head_sha is B; an author's GitHub edit made "head-sha", and the commit built on it.
      headRow.head_sha = "recorded-b";
      const res = await run();
      expect(res.ok).toBe(true);
      expect(headRow.head_sha).toBe("recorded-b");
    });
  }
});

// ---------------------------------------------------------------------------
// The order objects.csv is written in
// ---------------------------------------------------------------------------

// The objects page writes objects.csv in the order a publish does (the list
// order, `order_key` then `id`), with the new rows after the existing ones in
// the order they were added: the collaboration object gives each registered
// row a key after the last, in that order, so the next publish writes them
// where this write put them. The D1 stand-in
// answers the objects read in whatever order the query asks for, so an
// ORDER BY on another column shows here as another order.

/** The column an `asc(...)`/`desc(...)` orders by. */
function orderColumn(order: unknown): string | undefined {
  const chunks = (order as { queryChunks?: unknown[] }).queryChunks ?? [];
  const column = chunks.find((c) => typeof (c as { name?: unknown }).name === "string") as { name: string } | undefined;
  return column?.name;
}

/** D1 holding `rows`, answering the objects read ordered by the column the ORDER BY names first. */
function orderedDbMock(rows: Array<{ id: number; object_id: string; order_key: string }>) {
  const db = makeDbMock();
  db.select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(async (order: unknown) => {
          const column = orderColumn(order) as "id" | "object_id" | "order_key" | undefined;
          const sorted = [...rows].reverse();
          if (column === "id") sorted.sort((a, b) => a.id - b.id);
          if (column === "object_id") sorted.sort((a, b) => a.object_id.localeCompare(b.object_id));
          if (column === "order_key") sorted.sort((a, b) => (a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id - b.id));
          return sorted.map((r) => ({ ...r, missing_from_repo: false }));
        }),
        limit: vi.fn().mockResolvedValue([]),
      })),
    })),
  })) as never;
  return db;
}

/** The object ids of the rows handed to the objects.csv serializer, in order. */
async function serializedObjectIds(): Promise<string[]> {
  const { serializeObjectsCsv } = await import("~/lib/csv-export.server");
  const rows = vi.mocked(serializeObjectsCsv).mock.calls[0][0] as Array<{ object_id: string }>;
  return rows.map((r) => r.object_id);
}

describe("the objects page writes objects.csv in publish's order", () => {
  // The list order runs against both the ids and the names.
  const existing = [
    { id: 1, object_id: "alpha", order_key: "a2" },
    { id: 2, object_id: "zeta", order_key: "a1" },
    { id: 3, object_id: "mid", order_key: "a3" },
  ];

  it("commit-objects: existing rows in list order, then the new rows as added", async () => {
    vi.mocked(getDb).mockReturnValue(orderedDbMock(existing) as never);
    const { context } = buildContext();
    await action({
      request: post({
        intent: "commit-objects",
        disableSheets: "false",
        pendingObjects: JSON.stringify([
          { object_id: "omega", title: "Omega", featured: false, image_available: false },
          { object_id: "beta", title: "Beta", featured: false, image_available: false },
        ]),
      }),
      context,
      params: {},
    } as never);
    expect(await serializedObjectIds()).toEqual(["zeta", "alpha", "mid", "omega", "beta"]);
  });

  it("upload-image: existing rows in list order, then the uploaded row", async () => {
    vi.mocked(getDb).mockReturnValue(orderedDbMock(existing) as never);
    await upload();
    expect(await serializedObjectIds()).toEqual(["zeta", "alpha", "mid", "a-title"]);
  });
});
