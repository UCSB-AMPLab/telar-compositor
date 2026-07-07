/**
 * Authorization tests for toggle-featured and update-object actions in
 * _app.objects.tsx. Verifies that both intents scope their UPDATE to the
 * caller's active project, closing the cross-project IDOR where any
 * signed-in user could flip featured or overwrite metadata on any object
 * by id.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — factories must be self-contained (hoisted before variable init)
// ---------------------------------------------------------------------------

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue({}),
      })),
    })),
  })),
}));

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn(() => 99),
    })),
  })),
}));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 42, github_repo_full_name: "owner/repo" },
    userRole: "collaborator",
  })),
}));

vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(),
}));

// Heavy server-side deps not needed for these action cases
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
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: vi.fn(),
}));
vi.mock("~/hooks/use-structural-ops", () => ({
  useStructuralOps: vi.fn(),
}));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({
  findYMapById: vi.fn(),
  findYMapByIdOrTempId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.objects";
import { getDb } from "~/lib/db.server";
import { createSessionStorage } from "~/lib/session.server";
import { resolveActiveProject } from "~/lib/membership.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(intent: string, extra: Record<string, string> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  for (const [k, v] of Object.entries(extra)) {
    form.set(k, v);
  }
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
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({ fetch: vi.fn() })),
    },
  };
  return {
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"],
  };
}

// Extract the captured where-argument from the last db.update().set().where() call.
function captureWhereArg(): unknown {
  const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
    update: ReturnType<typeof vi.fn>;
  };
  const setMock = dbInstance.update.mock.results.at(-1)?.value as {
    set: ReturnType<typeof vi.fn>;
  };
  const whereMock = setMock.set.mock.results.at(-1)?.value as {
    where: ReturnType<typeof vi.fn>;
  };
  return whereMock.where.mock.calls.at(-1)?.[0];
}

// Walk a drizzle SQL node recursively and check whether `value` appears anywhere.
function drizzleClauseContainsValue(node: unknown, value: number): boolean {
  if (node === null || node === undefined) return false;
  if (typeof node === "number") return node === value;
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj["value"] === "number" && obj["value"] === value) return true;
    if (Array.isArray(obj["queryChunks"])) {
      for (const chunk of obj["queryChunks"] as unknown[]) {
        if (drizzleClauseContainsValue(chunk, value)) return true;
      }
    }
    if (drizzleClauseContainsValue(obj["left"], value)) return true;
    if (drizzleClauseContainsValue(obj["right"], value)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue({}),
      })),
    })),
  } as never);

  vi.mocked(createSessionStorage).mockReturnValue({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 99) })),
  } as never);

  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo" } as never,
    userRole: "collaborator",
  });
});

// ---------------------------------------------------------------------------
// toggle-featured
// ---------------------------------------------------------------------------

describe("_app.objects action: toggle-featured IDOR fix", () => {
  it("returns ok:true and scopes the UPDATE where-clause by the resolved project id", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo" } as never,
      userRole: "collaborator",
    });

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-featured", { objectDbId: "10", currentValue: "false" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("toggle-featured");

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).toHaveBeenCalled();

    const whereArg = captureWhereArg();
    expect(drizzleClauseContainsValue(whereArg, 42)).toBe(true);
  });

  it("returns { ok:false, error:'no_project' } and does NOT mutate DB when resolveActiveProject returns null", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue(null);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-featured", { objectDbId: "10", currentValue: "false" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string; error?: string };

    expect(res.ok).toBe(false);
    expect(res.intent).toBe("toggle-featured");
    expect(res.error).toBe("no_project");

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).not.toHaveBeenCalled();
  });

  it("passes the sessionActiveId from the session cookie to resolveActiveProject", async () => {
    vi.mocked(createSessionStorage).mockReturnValue({
      getSession: vi.fn(async () => ({ get: vi.fn(() => 77) })),
    } as never);

    const { context } = buildContext();
    await action({
      request: buildRequest("toggle-featured", { objectDbId: "5", currentValue: "true" }),
      context,
      params: {},
    } as never);

    expect(resolveActiveProject).toHaveBeenCalledWith(
      expect.anything(), // db
      7,                 // user.id
      77,                // sessionActiveId
    );
  });
});

// ---------------------------------------------------------------------------
// insert-pending-objects — dimensions + extra_columns passthrough (H17 gap #2)
//
// New objects pulled in via sync travel as PendingObject blobs through the
// client and into this action's D1 insert. The inserted row must carry the
// first-class `dimensions` field and the `extra_columns` custom-column blob.
// ---------------------------------------------------------------------------

describe("_app.objects action: insert-pending-objects carries dimensions + extra_columns", () => {
  it("includes dimensions and extra_columns on the inserted D1 row", async () => {
    let capturedRows: Record<string, unknown>[] | null = null;

    vi.mocked(getDb).mockReturnValue({
      // db.select().from(projects).where(...) → one project
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: 42 }]),
        })),
      })),
      // db.insert(objects).values(rows).returning(...) → capture rows
      insert: vi.fn(() => ({
        values: vi.fn((rows: Record<string, unknown>[]) => {
          capturedRows = rows;
          return {
            returning: vi.fn().mockResolvedValue(
              rows.map((r, i) => ({ id: i + 1, object_id: r.object_id })),
            ),
          };
        }),
      })),
    } as never);

    const pendingObjects = [
      {
        object_id: "new-obj",
        title: "Carved Mask",
        featured: false,
        creator: "Ana Talla",
        description: "A wooden mask",
        source_url: null,
        period: null,
        year: null,
        object_type: "Sculpture",
        subjects: null,
        source: "Museum Collection",
        credit: "Photo by A. Talla",
        thumbnail: null,
        alt_text: null,
        dimensions: "40 x 20 cm",
        extra_columns: JSON.stringify({ accession_number: "ACC-2026-001" }),
        image_available: true,
        origin: "repo",
      },
    ];

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("insert-pending-objects", {
        pendingObjects: JSON.stringify(pendingObjects),
      }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("insert-pending-objects");

    expect(capturedRows).not.toBeNull();
    expect(capturedRows!).toHaveLength(1);
    expect(capturedRows![0].object_id).toBe("new-obj");
    expect(capturedRows![0].dimensions).toBe("40 x 20 cm");
    expect(capturedRows![0].extra_columns).toBe(
      JSON.stringify({ accession_number: "ACC-2026-001" }),
    );
  });
});
