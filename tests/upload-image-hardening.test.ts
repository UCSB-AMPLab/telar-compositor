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
 * the project membership-aware, and gate on convenor or collaborator, not
 * instructor.
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
}));vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

// The upload's version gate (readRepoWriteGate) runs for real against a
// stubbed release read. The default databases below record no site version,
// which the gate reads as current without a lookup, so outside the version
// cases what is pinned is the upload on a site the gate does not stop.
vi.mock("~/lib/github-status.server", () => ({
  bumpProjectHeadFrom: vi.fn(async () => true),
  bumpObjectsReadFrom: vi.fn(async () => true),
  readLatestTag: vi.fn(async () => ({ ok: true, tag: "v9.9.9" })),
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
import { bumpObjectsReadFrom, bumpProjectHeadFrom, readLatestTag } from "~/lib/github-status.server";
import { dispatchWorkflow } from "~/lib/commit.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { getFileAtRef } from "~/lib/github.server";

function buildUploadRequest(
  metadata: Record<string, string>,
  file: { name: string; type: string } = { name: "photo.jpg", type: "image/jpeg" },
): Request {
  const form = new FormData();
  form.set("intent", "upload-image");
  form.set("siteId", "42");
  form.append(
    "imageFile",
    new File([new Uint8Array([0xff, 0xd8, 0xff])], file.name, { type: file.type })
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
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([]),
        })),
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
  vi.mocked(readLatestTag).mockResolvedValue({ ok: true, tag: "v9.9.9" });
  vi.mocked(getFileAtRef).mockImplementation((async () => ({ status: "absent" })) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("registers an uploaded audio file as an audio object, beside the others at objects/<id>.<ext>", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: buildUploadRequest({ objectId: "oralhistory" }, { name: "interview.mp3", type: "audio/mpeg" }),
      context,
      params: {},
    } as never)) as { ok: boolean; pendingObject?: { source_url: string | null; image_available: boolean } };

    expect(res.ok).toBe(true);
    // The screens read the media kind from source_url, as for an imported recording.
    expect(res.pendingObject?.source_url).toBe("oralhistory.mp3");
    expect(res.pendingObject?.image_available).toBe(false);
    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).toHaveBeenCalledWith(
      expect.objectContaining({ images: [expect.objectContaining({ imagePath: "telar-content/objects/oralhistory.mp3" })] }),
    );
  });

  it("commits the objects sheet to objetos.csv on a site that holds only that file", async () => {
    vi.mocked(getFileAtRef).mockImplementation((async (_t: string, _o: string, _r: string, path: string) =>
      path === "telar-content/spreadsheets/objetos.csv"
        ? { status: "ok", content: "object_id,title\nmapa,Mapa\n" }
        : { status: "absent" }) as never);
    const { context } = buildContext();
    const res = (await action({
      request: buildUploadRequest({ objectId: "fine-id" }),
      context,
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).toHaveBeenCalledWith(
      expect.objectContaining({ csvPath: "telar-content/spreadsheets/objetos.csv" }),
    );
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

  it("allows a collaborator (upload is open to convenor or collaborator)", async () => {
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

    expect(res.ok).toBe(true);
  });

  it("admits an instructor (a publishing role, named in the set)", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
      userRole: "instructor",
    });

    const { context } = buildContext();
    const res = (await action({
      request: buildUploadRequest({ objectId: "x" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(true);
  });

  it("refuses an unrecognised future role — a role reaches upload only once named in the set", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
      userRole: "editor" as never,
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

/**
 * A database whose project_config answers with a site version — the gate's
 * only read before it decides.
 */
function makeDbMockWithSiteVersion(telarVersion: string) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([{ telar_version: telarVersion }]),
        })),
      })),
    })),
  };
}

// Objects is no longer refused as a page on a site behind the latest
// Telar release; the upload is refused instead, because it is the one act on
// the page that commits to the repository and dispatches its build. The
// refusal is the action's own, not the page's: the page's reading comes from
// whatever load drew it, and on a cold tag cache that reading is provisional.
describe("upload-image on a site behind the latest release", () => {
  it("refuses before anything reaches the repository", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMockWithSiteVersion("1.0.0") as never);
    vi.mocked(readLatestTag).mockResolvedValue({ ok: true, tag: "v9.9.9" });
    const { context } = buildContext();

    const res = (await action({
      request: buildUploadRequest({ objectId: "fine-id" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res).toMatchObject({ ok: false, error: "upgrade_required" });
    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).not.toHaveBeenCalled();
    expect(vi.mocked(dispatchWorkflow)).not.toHaveBeenCalled();
  });

  it("names the convenor for a collaborator whose upgrade only the convenor can complete", async () => {
    // The two refusals are separate because they send the person to
    // different places: one to /upgrade, the other to the person who holds
    // the GitHub App permission the upgrade needs.
    vi.mocked(getDb).mockReturnValue(makeDbMockWithSiteVersion("1.0.0") as never);
    vi.mocked(readLatestTag).mockResolvedValue({ ok: true, tag: "v9.9.9" });
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: {
        id: 42,
        github_repo_full_name: "owner/repo",
        installation_id: 5,
        gh_workflows_write_missing: 1,
      } as never,
      userRole: "collaborator",
    });
    const { context } = buildContext();

    const res = (await action({
      request: buildUploadRequest({ objectId: "fine-id" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res).toMatchObject({ ok: false, error: "upgrade_awaits_convenor" });
    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).not.toHaveBeenCalled();
  });

  it("uploads on a current site", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMockWithSiteVersion("9.9.9") as never);
    vi.mocked(readLatestTag).mockResolvedValue({ ok: true, tag: "v9.9.9" });
    const { context } = buildContext();

    const res = (await action({
      request: buildUploadRequest({ objectId: "fine-id" }),
      context,
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).toHaveBeenCalled();
  });

  it("refuses with a structured answer, not a 500, when the site version cannot be read", async () => {
    // The check runs ahead of the action's guarded region, so a throw from it
    // would be an opaque 500 — the failure issue #25 was. A standing that
    // cannot be read is an unknown release instead, and refuses.
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockRejectedValue(new Error("D1 down")) })),
        })),
      })),
    } as never);
    const { context } = buildContext();

    const res = (await action({
      request: buildUploadRequest({ objectId: "fine-id" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res).toMatchObject({ ok: false, error: "release_unknown" });
    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).not.toHaveBeenCalled();
  });

  it("refuses when the latest release cannot be read", async () => {
    // A failed lookup is unknown, not current. Read as current, it
    // lets a site behind a release published a moment ago write through a
    // worker that could not see it.
    vi.mocked(getDb).mockReturnValue(makeDbMockWithSiteVersion("1.0.0") as never);
    vi.mocked(readLatestTag).mockResolvedValue({ ok: false });
    const { context } = buildContext();

    const res = (await action({
      request: buildUploadRequest({ objectId: "fine-id" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error?: string };

    expect(res).toMatchObject({ ok: false, error: "release_unknown" });
    expect(vi.mocked(commitMultipleBinaryFilesWithCsv)).not.toHaveBeenCalled();
    expect(vi.mocked(dispatchWorkflow)).not.toHaveBeenCalled();
    expect(vi.mocked(controlFreezeLease)).not.toHaveBeenCalled();
  });
});

// A sync apply takes the objects lease and records what it applied;
// the upload's record of its own commit moves the same columns, so it is made
// before the upload releases the lease, not after.
describe("upload-image's record of its commit", () => {
  it("is made while the upload holds the objects lease", async () => {
    const events: string[] = [];
    vi.mocked(controlFreezeLease).mockImplementation(async (_env, _project, _user, control) => {
      events.push(control.op);
      return "applied";
    });
    vi.mocked(bumpProjectHeadFrom).mockImplementation(async () => {
      events.push("record head_sha");
      return true;
    });
    vi.mocked(bumpObjectsReadFrom).mockImplementation(async () => {
      events.push("record objects_read_sha");
      return true;
    });
    const { context } = buildContext();

    const res = (await action({
      request: buildUploadRequest({ objectId: "fine-id" }),
      context,
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(events).toEqual(["begin", "record head_sha", "record objects_read_sha", "end"]);
  });
});
