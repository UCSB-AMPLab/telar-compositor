/**
 * Hardening tests for the upload-image action (telar-compositor#25).
 *
 * Production failure this pins against: olympia-m's upload "would not
 * proceed" with the generic "check your connection" copy on every retry, and
 * her repo showed NO commit — the failure was pre-commit and deterministic.
 * Two confirmed mechanisms: (a) the user-editable object ID was sent raw and
 * anything non-slug (uppercase, spaces, "#") was rejected as
 * invalid_object_id, which the client didn't map; (b) the whole pre-commit
 * region (decrypt, slug D1 queries, file reads, CSV fetch) ran OUTSIDE the
 * try/catch, so any throw became an opaque 500.
 *
 * The hardened action must: normalise the requested id with slugify and fall
 * back title → "object" (so non-ASCII titles can't produce an empty slug),
 * never throw from the pre-commit region (structured upload_failed), resolve
 * the project membership-aware, and enforce the convenor gate the UI assumes.
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
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 },
    userRole: "convenor",
  })),
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
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(async () => ({ runId: 11, htmlUrl: "https://gh/run/11" })),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(),
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

function buildUploadRequest(metadata: Record<string, string>): Request {
  const form = new FormData();
  form.set("intent", "upload-image");
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDb).mockReturnValue(makeDbMock() as never);
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
    userRole: "convenor",
  });
  vi.mocked(generateUniqueObjectSlug).mockImplementation(async (slug: string) => slug);
});

describe("upload-image hardening", () => {
  it("normalises a user-typed id like 'Mission Bell #2' instead of rejecting it", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: buildUploadRequest({ objectId: "Mission Bell #2" }),
      context,
      params: {},
    } as never)) as { ok: boolean; objectId?: string; error?: string };

    expect(vi.mocked(generateUniqueObjectSlug)).toHaveBeenCalledWith("mission-bell-2", 42, expect.anything());
    expect(res.ok).toBe(true);
    expect(res.objectId).toBe("mission-bell-2");
  });

  it("commits with the App installation token (user token is local-dev fallback only)", async () => {
    const { context } = buildContext();
    await action({
      request: buildUploadRequest({ objectId: "fine-id" }),
      context,
      params: {},
    } as never);

    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).toHaveBeenCalledWith(
      expect.objectContaining({ token: "install-token" })
    );
  });

  it("falls back to 'object' when the title has no ASCII alphanumerics and no id was given", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: buildUploadRequest({ objectId: "", title: "中文物品" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(vi.mocked(generateUniqueObjectSlug)).toHaveBeenCalledWith("object", 42, expect.anything());
    expect(res.ok).toBe(true);
  });

  it("returns structured upload_failed (not a 500) when the pre-commit region throws", async () => {
    vi.mocked(generateUniqueObjectSlug).mockRejectedValue(
      new Error("D1_ERROR: storage operation exceeded timeout")
    );

    const { context } = buildContext();
    const res = (await action({
      request: buildUploadRequest({ objectId: "fine-id" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("upload_failed");
  });

  it("enforces the convenor gate the UI assumes (collaborator → forbidden)", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
      userRole: "collaborator",
    });

    const { context } = buildContext();
    const res = (await action({
      request: buildUploadRequest({ objectId: "x" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("forbidden");
  });

  it("returns no_project from membership-aware resolution (no first-owned fallback)", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue(null);

    const { context } = buildContext();
    const res = (await action({
      request: buildUploadRequest({ objectId: "x" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_project");
  });
});
