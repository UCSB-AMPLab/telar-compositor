/**
 * Pins the modernised project resolution + failure semantics of the objects
 * route's repo-facing intents (follow-up to telar-compositor#24/#25).
 *
 * - compute-sync-diff / sync-apply / commit-objects resolve the project
 *   membership-aware (resolveActiveProject) — the old owner-only query with
 *   its ?? allProjects[0] fallback could target the WRONG owned project on a
 *   stale session. compute-sync-diff and sync-apply (full-repo import) stay
 *   convenor-only; commit-objects is open to convenor or collaborator, not
 *   instructor.
 * - commit-objects must not report failure for a commit that succeeded: a
 *   post-commit dispatch failure returns ok:true + dispatchFailed so the
 *   modal skips build tracking instead of polling a run that never started.
 * - decrypt failures return structured errors instead of uncaught 500s.
 * - the disableSheets path must reset the collaboration doc after its direct
 *   D1 write — the DO is the sole reconciling writer for config columns, so a
 *   warm Y.Doc still holding google_sheets_enabled=true would clobber the
 *   write back on its next snapshot and strand the settings-page warning.
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
  resolveActiveProject: vi.fn(),
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
  // The column picker lists the spreadsheets directory for the
  // groups it offers; listing none, the refusal stands.
  listDirectoryEntries: vi.fn(async () => []),
  githubHeaders: vi.fn(() => ({})),
}));vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

vi.mock("~/lib/github-status.server", () => ({ bumpProjectHead: vi.fn(), bumpProjectHeadFrom: vi.fn(async () => true) }));
// The check's fingerprint of D1 is its own spec's; the stand-in D1
// here answers the check's reads only.
vi.mock("~/lib/synced-rows-fingerprint.server", () => ({ syncedRowsFingerprint: vi.fn(async () => "rows") }));
vi.mock("~/lib/sync.server", () => ({
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
  computeSyncDiff: vi.fn(),
  finishPendingBeforeCheck: vi.fn(async () => {}),
  objectsBaseAt: vi.fn(async () => undefined),
  applySyncChanges: vi.fn(),
  refuseMovedObjectsBase: vi.fn(async () => {}),
  ObjectsSyncStale: class ObjectsSyncStale extends Error {},
  SyncBaseStale: class SyncBaseStale extends Error {},
  SyncEntriesRefused: class SyncEntriesRefused extends Error {},
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })),
  dispatchWorkflow: vi.fn(async () => ({ runId: 11, htmlUrl: "https://gh/run/11" })),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(() => false),
  disableGoogleSheetsInConfig: vi.fn(),
  verifySiteUrl: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
// ~/lib/github-app.server is left entirely unmocked: resolveProjectToken and
// getInstallationToken run for real, against a throwaway RSA key, with only
// the network boundary (fetch) stubbed below — see
// tests/helpers/github-app-fetch.ts for why a mock of getInstallationToken
// itself cannot intercept resolveProjectToken's internal call to it, and
// why this suite instead needs the real fallback logic to run.
vi.mock("~/lib/config-repair.server", () => ({
  repairSiteConfig: vi.fn(async () => "applied"),
}));
vi.mock("~/lib/csv-export.server", () => ({
  serializeObjectsCsv: vi.fn(() => "csv-content"),
  dbObjectToCsvRow: vi.fn((o: unknown) => o),
}));
vi.mock("~/lib/upload.server", () => ({
  createImageBlobs: vi.fn(async () => []),
  commitMultipleBinaryFilesWithCsv: vi.fn(),
  arrayBufferToBase64: vi.fn(),
  validateUploadFile: vi.fn(),
}));
vi.mock("~/lib/slugify", () => ({
  generateUniqueObjectSlug: vi.fn(),
  slugify: vi.fn(() => "slug"),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({
  findYMapById: vi.fn(),
  findYMapByIdOrTempId: vi.fn(),
}));

import { action } from "~/routes/_app.objects";
import { syncErrorToast } from "~/components/features/objects/sync-error-toast";
import { computeSyncDiff, applySyncChanges, ObjectsSyncStale, SyncEntriesRefused } from "~/lib/sync.server";
import { CollidingColumnsRefusal } from "~/lib/import.server";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { decrypt } from "~/lib/crypto.server";
import { dispatchWorkflow, commitFilesToRepo, StaleHeadError } from "~/lib/commit.server";
import { getFileAtRef, listDirectoryEntries } from "~/lib/github.server";
import { repairSiteConfig } from "~/lib/config-repair.server";

/**
 * Every intent this file posts is site-level and refuses unless the form
 * carries the `siteId` of the session's active project (42, in every case
 * here that resolves one) — so the default carries it, and a test that
 * resolves no project (or a different one) is unaffected, since that check
 * runs before the intent's own logic either way.
 */
function buildRequest(intent: string, extra: Record<string, string> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  form.set("siteId", "42");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new Request("https://compositor.telar.org/objects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
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
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) })),
    })),
  };
}

function asConvenor() {
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
    userRole: "convenor",
  });
}

function asCollaborator() {
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
    userRole: "collaborator",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installGithubAppFetchStub();
  vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
  vi.mocked(decrypt).mockResolvedValue("user-token");
  vi.mocked(commitFilesToRepo).mockResolvedValue({ newHeadSha: "new-sha" } as never);
  vi.mocked(dispatchWorkflow).mockResolvedValue({ runId: 11, htmlUrl: "https://gh/run/11" } as never);
  asConvenor();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("convenor gates on repo-facing intents", () => {
  for (const intent of ["compute-sync-diff", "sync-apply", "commit-objects"]) {
    it(`${intent}: no resolvable project → no_project`, async () => {
      vi.mocked(resolveActiveProject).mockResolvedValue(null);
      const { context } = buildContext();
      const res = (await action({
        request: buildRequest(intent, intent === "sync-apply" ? { changes: "{}" } : {}),
        context,
        params: {},
      } as never)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toBe("no_project");
    });
  }

  // compute-sync-diff and sync-apply are the full-repo import path
  // and stay convenor-only, unlike upload-image and commit-objects, which
  // collaborators may use.
  for (const intent of ["compute-sync-diff", "sync-apply"]) {
    it(`${intent}: collaborator → forbidden`, async () => {
      asCollaborator();
      const { context } = buildContext();
      const res = (await action({
        request: buildRequest(intent, intent === "sync-apply" ? { changes: "{}" } : {}),
        context,
        params: {},
      } as never)) as { ok: boolean; error?: string };
      expect(res.ok).toBe(false);
      expect(res.error).toBe("forbidden");
    });
  }
});

describe("commit-objects — every named publishing role, and nothing else", () => {
  it("collaborator → allowed (object-write pipeline is open to the group, not convenor-only)", async () => {
    asCollaborator();
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(true);
  });

  it("instructor → allowed (a publishing role, named in the set)", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
      userRole: "instructor",
    });
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(true);
  });

  it("an unrecognised future role → forbidden (a role commits only once named in the set)", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
      userRole: "editor" as never,
    });
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("forbidden");
  });
});

describe("commit-objects post-commit dispatch semantics", () => {
  it("returns ok:true + dispatchFailed when the dispatch fails AFTER a successful commit", async () => {
    installGithubAppFetchStub({ mintToken: null });
    vi.mocked(dispatchWorkflow).mockRejectedValue(new Error("dispatch 403"));

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]" }),
      context,
      params: {},
    } as never)) as { ok: boolean; newHeadSha?: string; dispatchFailed?: boolean; dispatchRunId?: number | null };

    expect(res.ok).toBe(true);
    expect(res.newHeadSha).toBe("new-sha");
    expect(res.dispatchFailed).toBe(true);
    expect(res.dispatchRunId).toBeNull();
  });

  it("returns ok:true + dispatchFailed:false when the dispatch starts a run", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]" }),
      context,
      params: {},
    } as never)) as { ok: boolean; dispatchFailed?: boolean; dispatchRunId?: number | null };

    expect(res.ok).toBe(true);
    expect(res.dispatchFailed).toBe(false);
    expect(res.dispatchRunId).toBe(11);
  });

  it("commits with the App installation token (user token is local-dev fallback only)", async () => {
    const { context } = buildContext();
    await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]" }),
      context,
      params: {},
    } as never);

    expect(vi.mocked(commitFilesToRepo)).toHaveBeenCalledWith(
      "install-token",
      "owner",
      "repo",
      "main",
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      true,
      // The head the action read at.
      "head-sha",
    );
  });

  it("still returns commit_failed when the commit itself throws", async () => {
    vi.mocked(commitFilesToRepo).mockRejectedValue(new Error("GitHub 502"));

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("commit_failed");
  });

  it("still returns stale_head on StaleHeadError", async () => {
    vi.mocked(commitFilesToRepo).mockRejectedValue(new StaleHeadError("HEAD moved"));

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("stale_head");
  });
});

describe("commit-objects repairs the Sheets flag through the document", () => {
  it("repairs the flag after the commit, for the resolved project, and resets nothing", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]", disableSheets: "true" }),
      context,
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(vi.mocked(repairSiteConfig)).toHaveBeenCalledTimes(1);
    // Project id from the resolved membership, not anything client-supplied.
    expect(vi.mocked(repairSiteConfig)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      42,
      { google_sheets_enabled: false },
    );
  });

  it("still returns ok:true when the document does not confirm the repair", async () => {
    // The repo commit and head bump have already landed by the time the
    // repair runs; an unconfirmed repair must not misreport the commit as
    // failed (the client's failure path discards pending objects, stranding
    // rows already committed to the repo).
    vi.mocked(repairSiteConfig).mockResolvedValue("uncertain");

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]", disableSheets: "true" }),
      context,
      params: {},
    } as never)) as { ok: boolean; newHeadSha?: string };

    expect(res.ok).toBe(true);
    expect(res.newHeadSha).toBe("new-sha");
  });

  it("repairs nothing when there is nothing to repair", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]", disableSheets: "false" }),
      context,
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(vi.mocked(repairSiteConfig)).not.toHaveBeenCalled();
  });
});

describe("decrypt failures are structured, not 500s", () => {
  it("compute-sync-diff: decrypt throw → sync_failed", async () => {
    vi.mocked(decrypt).mockRejectedValue(new Error("GCM auth failed"));
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("compute-sync-diff"),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("sync_failed");
  });

  it("commit-objects: decrypt throw → commit_failed", async () => {
    vi.mocked(decrypt).mockRejectedValue(new Error("GCM auth failed"));
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("commit-objects", { pendingObjects: "[]" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("commit_failed");
  });
});

// An objects apply whose check is no longer GitHub's head is refused.
// The route answers it as its own error, which the page answers by
// checking again rather than with a toast.
describe("an objects apply of a check that is not current", () => {
  it("sync-apply answers sync_stale", async () => {
    vi.mocked(applySyncChanges).mockRejectedValue(new ObjectsSyncStale());
    const { context } = buildContext();
    const res = await action({
      request: buildRequest("sync-apply", { changes: "{}" }),
      context,
      params: {},
    } as never);
    expect(res).toEqual({ ok: false, intent: "sync-apply", error: "sync_stale" });
  });

  it("any other failure is still apply_failed", async () => {
    vi.mocked(applySyncChanges).mockRejectedValue(new Error("ingest failed"));
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("sync-apply", { changes: "{}" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res.error).toBe("apply_failed");
  });

  // Held back whole for entries the Compositor cannot store.
  it("an apply held back for entries it cannot store answers entries_refused", async () => {
    vi.mocked(applySyncChanges).mockRejectedValue(new SyncEntriesRefused({ objectInsert: [0] }, []));
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("sync-apply", { changes: "{}" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };
    expect(res).toMatchObject({ ok: false, intent: "sync-apply", error: "entries_refused" });
  });
});

// An apply the Compositor held back for entries it cannot store is a fault of
// the Compositor's, and the page's toast says so instead of the general message.
describe("an apply held back for entries the Compositor cannot store", () => {
  it("the toast names the Compositor as the fault, and stays until dismissed", () => {
    const t = (key: string) => key;
    expect(syncErrorToast({ error: "entries_refused" }, t)).toEqual({
      message: "sync_entries_refused",
      type: "destructive",
      autoDismissMs: null,
    });
  });
});

// A sync refuses a sheet it could not read, and the page's toast
// names it, says nothing was synced, and stays until dismissed.
describe("a sheet the sync could not read", () => {
  it("the toast names the sheet, and stays until dismissed", () => {
    const t = (key: string, opts?: Record<string, unknown>) => `${key} ${JSON.stringify(opts ?? {})}`;
    expect(syncErrorToast({ error: "sheet_unreadable", sheet: "objects.csv" }, t)).toEqual({
      message: 'sync_error_sheet_unreadable {"sheet":"objects.csv"}',
      type: "destructive",
      autoDismissMs: null,
    });
  });
});

// A sync refuses a sheet in which two or more colliding columns each hold
// values. The objects page's two sync intents return the refusal as its own
// error, carrying the sheet and the columns, and the page's toast names them.
describe("a sheet the sync refuses for its colliding columns", () => {
  const refusal = () => new CollidingColumnsRefusal("objects.csv", "medium_genre", ["medium", "object_type"]);
  const refused = {
    ok: false,
    error: "colliding_columns",
    collidingColumns: { sheet: "objects.csv", canonicalName: "medium_genre", headers: ["medium", "object_type"] },
  };

  it("compute-sync-diff returns the refusal", async () => {
    vi.mocked(computeSyncDiff).mockRejectedValue(refusal());
    const { context } = buildContext();
    const res = await action({ request: buildRequest("compute-sync-diff"), context, params: {} } as never);
    expect(res).toEqual({ ...refused, intent: "compute-sync-diff" });
  });

  it("compute-sync-diff offers the column picker where the repair sees the group", async () => {
    const path = "telar-content/spreadsheets/objects.csv";
    vi.mocked(listDirectoryEntries).mockResolvedValueOnce([{ path, mode: "100644", type: "blob", sha: "x" }]);
    vi.mocked(getFileAtRef).mockResolvedValueOnce({ status: "ok", content: "object_id,title,medium,object_type\nobj-001,First,Oil,Painting\n" });
    vi.mocked(computeSyncDiff).mockRejectedValue(refusal());
    const { context } = buildContext();
    const res = (await action({ request: buildRequest("compute-sync-diff"), context, params: {} } as never)) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: false, intent: "compute-sync-diff", error: "needs_choices", source: "repo" });
    expect((res.groups as { file: string; positions: number[] }[]).map((g) => [g.file, g.positions])).toEqual([[path, [2, 3]]]);
  });

  it("sync-apply returns the refusal", async () => {
    vi.mocked(applySyncChanges).mockRejectedValue(refusal());
    const { context } = buildContext();
    const res = await action({
      request: buildRequest("sync-apply", { changes: "{}" }),
      context,
      params: {},
    } as never);
    expect(res).toEqual({ ...refused, intent: "sync-apply" });
  });

  it("the toast names the sheet and the columns, and stays until dismissed", () => {
    const t = (key: string, opts?: Record<string, unknown>) => `${key} ${JSON.stringify(opts ?? {})}`;
    const toast = syncErrorToast(refused, t);
    expect(toast).toEqual({
      message: 'sync_error_colliding_columns {"sheet":"objects.csv","columns":"\\"medium\\", \\"object_type\\""}',
      type: "destructive",
      autoDismissMs: null,
    });
    expect(syncErrorToast({ error: "sync_failed" }, t)).toEqual({
      message: "sync_error_toast {}",
      type: "destructive",
    });
  });

  it("the toast never shows the server's own text for a failure it has no message for", () => {
    const t = (key: string) => key;
    const answer = { error: "apply_failed", message: "ingest-sync failed: DO returned 500" };
    expect(syncErrorToast(answer, t).message).toBe("sync_error_toast");
  });
});
