/**
 * Hardening tests for the insert-pending-objects action (telar-compositor#24).
 *
 * Production failure chain this pins against: the action had no try/catch, so
 * any D1 error became an uncaught 500 ("Unexpected Server Error" — the route
 * ErrorBoundary), the CommitAndBuildModal had no error branch and froze on
 * "inserting", the images were ALREADY committed to GitHub by upload-image, so
 * the repo and D1 diverged (sophiaamaral05's project: 11 objects in
 * objects.csv, 6 in D1), and because objects has no UNIQUE(project_id,
 * object_id), every retry duplicated whatever rows had landed.
 *
 * The hardened action must:
 *   - never throw (structured insert_failed on D1 errors, missing_data on bad JSON)
 *   - resolve the project membership-aware (resolveActiveProject), no
 *     first-owned-project fallback
 *   - be idempotent: pre-check existing (project_id, object_id) rows, skip
 *     them, and return their canonical ids so the client Y.Array mirror still
 *     works on retry
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 99) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 42, github_repo_full_name: "owner/repo" },
    userRole: "convenor",
  })),
}));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/sync.server", () => ({
  computeSyncDiff: vi.fn(),
  applySyncChanges: vi.fn(),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn(),
  verifySiteUrl: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn() }));
vi.mock("~/lib/csv-export.server", () => ({
  serializeObjectsCsv: vi.fn(),
  dbObjectToCsvRow: vi.fn(),
}));
vi.mock("~/lib/upload.server", () => ({
  commitMultipleBinaryFilesWithCsv: vi.fn(),
  arrayBufferToBase64: vi.fn(),
  validateUploadFile: vi.fn(),
}));
vi.mock("~/lib/slugify", () => ({
  generateUniqueObjectSlug: vi.fn(),
  slugify: vi.fn(),
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

function buildRequest(pendingObjects: unknown): Request {
  const form = new URLSearchParams();
  form.set("intent", "insert-pending-objects");
  form.set(
    "pendingObjects",
    typeof pendingObjects === "string" ? pendingObjects : JSON.stringify(pendingObjects)
  );
  return new Request("https://compositor.telar.org/objects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext(userId = 7) {
  const user = { id: userId, encrypted_access_token: "enc-token" };
  const env = { ENCRYPTION_KEY: "key", SESSION_SECRET: "sess-secret", DB: {} };
  return {
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"],
  };
}

function pending(objectId: string): Record<string, unknown> {
  return {
    object_id: objectId,
    title: `Title ${objectId}`,
    featured: false,
    creator: null,
    description: null,
    source_url: null,
    period: null,
    year: null,
    object_type: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    alt_text: null,
    image_available: true,
    origin: "repo",
  };
}

/** db mock: select → existing rows; insert captures rows and returns ids. */
function makeDbMock(existingRows: Array<{ id: number; object_id: string }>) {
  const capturedInserts: Record<string, unknown>[][] = [];
  let nextId = 1000;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(existingRows),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((rows: Record<string, unknown>[]) => {
        capturedInserts.push(rows);
        return {
          returning: vi.fn().mockResolvedValue(
            rows.map((r) => ({ id: nextId++, object_id: r.object_id }))
          ),
        };
      }),
    })),
  };
  return { db, capturedInserts };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo" } as never,
    userRole: "convenor",
  });
});

describe("insert-pending-objects hardening", () => {
  it("skips object_ids already in D1 and returns their existing ids (idempotent retry)", async () => {
    const { db, capturedInserts } = makeDbMock([{ id: 7, object_id: "dup-obj" }]);
    vi.mocked(getDb).mockReturnValue(db as never);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest([pending("dup-obj"), pending("fresh-obj")]),
      context,
      params: {},
    } as never)) as {
      ok: boolean;
      insertedCount: number;
      inserted: Array<{ id: number; object_id: string }>;
    };

    expect(res.ok).toBe(true);
    // Only the fresh object is INSERTed…
    const allInsertedRows = capturedInserts.flat();
    expect(allInsertedRows).toHaveLength(1);
    expect(allInsertedRows[0].object_id).toBe("fresh-obj");
    expect(res.insertedCount).toBe(1);
    // …but BOTH come back with canonical ids so the Y.Array mirror works.
    const byKey = new Map(res.inserted.map((r) => [r.object_id, r.id]));
    expect(byKey.get("dup-obj")).toBe(7);
    expect(typeof byKey.get("fresh-obj")).toBe("number");
  });

  it("returns structured missing_data (not a 500) on malformed JSON", async () => {
    const { db } = makeDbMock([]);
    vi.mocked(getDb).mockReturnValue(db as never);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("{not json"),
      context,
      params: {},
    } as never)) as { ok: boolean; error: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing_data");
  });

  it("returns structured missing_data when the payload is not an array", async () => {
    const { db } = makeDbMock([]);
    vi.mocked(getDb).mockReturnValue(db as never);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest({ object_id: "not-an-array" }),
      context,
      params: {},
    } as never)) as { ok: boolean; error: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing_data");
  });

  it("returns structured insert_failed (not a 500) when the D1 insert throws", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockRejectedValue(new Error("D1_ERROR: storage operation exceeded timeout")),
        })),
      })),
    };
    vi.mocked(getDb).mockReturnValue(db as never);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest([pending("any-obj")]),
      context,
      params: {},
    } as never)) as { ok: boolean; error: string; message?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("insert_failed");
    expect(res.message).toContain("D1_ERROR");
  });

  it("returns no_project via membership-aware resolution (no first-owned-project fallback)", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue(null);
    const { db } = makeDbMock([]);
    vi.mocked(getDb).mockReturnValue(db as never);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest([pending("x")]),
      context,
      params: {},
    } as never)) as { ok: boolean; error: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_project");
    expect(vi.mocked(resolveActiveProject)).toHaveBeenCalled();
  });
});
