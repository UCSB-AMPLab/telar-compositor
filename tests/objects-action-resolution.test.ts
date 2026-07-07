/**
 * Pins the modernised project resolution + failure semantics of the objects
 * route's repo-facing intents (follow-up to telar-compositor#24/#25).
 *
 * - compute-sync-diff / sync-apply / commit-objects resolve the project
 *   membership-aware (resolveActiveProject) and enforce the convenor gate the
 *   UI assumes — the old owner-only query with its ?? allProjects[0] fallback
 *   could target the WRONG owned project on a stale session.
 * - commit-objects must not report failure for a commit that succeeded: a
 *   post-commit dispatch failure returns ok:true + dispatchFailed so the
 *   modal skips build tracking instead of polling a run that never started.
 * - decrypt failures return structured errors instead of uncaught 500s.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(async () => null),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHead: vi.fn() }));
vi.mock("~/lib/sync.server", () => ({
  computeSyncDiff: vi.fn(),
  applySyncChanges: vi.fn(),
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
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
}));
vi.mock("~/lib/csv-export.server", () => ({
  serializeObjectsCsv: vi.fn(() => "csv-content"),
  dbObjectToCsvRow: vi.fn((o: unknown) => o),
}));
vi.mock("~/lib/upload.server", () => ({
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
import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { decrypt } from "~/lib/crypto.server";
import { getInstallationToken } from "~/lib/github-app.server";
import { dispatchWorkflow, commitFilesToRepo, StaleHeadError } from "~/lib/commit.server";

function buildRequest(intent: string, extra: Record<string, string> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
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
    GITHUB_PRIVATE_KEY: "pk",
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
  vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
  vi.mocked(decrypt).mockResolvedValue("user-token");
  vi.mocked(commitFilesToRepo).mockResolvedValue({ newHeadSha: "new-sha" } as never);
  vi.mocked(getInstallationToken).mockResolvedValue("install-token" as never);
  vi.mocked(dispatchWorkflow).mockResolvedValue({ runId: 11, htmlUrl: "https://gh/run/11" } as never);
  asConvenor();
});

describe("convenor gates on repo-facing intents", () => {
  for (const intent of ["compute-sync-diff", "sync-apply", "commit-objects"]) {
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
});

describe("commit-objects post-commit dispatch semantics", () => {
  it("returns ok:true + dispatchFailed when the dispatch fails AFTER a successful commit", async () => {
    vi.mocked(getInstallationToken).mockRejectedValue(new Error("install token unavailable"));
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
