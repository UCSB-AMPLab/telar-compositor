/**
 * Authorization tests for toggle-featured and update-object actions in
 * _app.objects.tsx. Verifies that both intents scope their UPDATE to the
 * caller's active project, closing the cross-project IDOR where any
 * signed-in user could flip featured or overwrite metadata on any object
 * by id.
 *
 * @version v1.5.0-beta
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
  requireProjectMember: vi.fn(async () => {}),
}));

vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(),
}));

// Heavy server-side deps not needed for these action cases
vi.mock("~/lib/iiif.server", () => ({ fetchAndParseManifest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
// The operation lock is granted: these cases are about what the
// action does once it holds it.
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "op-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "head-sha"),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/sync.server", () => ({
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
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
  createImageBlobs: vi.fn(async () => []),
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
import { registerCommittedObjects } from "~/lib/register-objects.server";
import { createSessionStorage } from "~/lib/session.server";
import { resolveActiveProject, requireProjectMember } from "~/lib/membership.server";
import { signInternalMarker } from "../workers/auth";

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

/** `toggle-featured` reads the object row (its own project_id) before the
 * UPDATE; `objectRow: null` models a row absent at toggle time. */
function makeDb(objectRow: { project_id: number } | null = { project_id: 42 }) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(objectRow ? [objectRow] : []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue({}),
      })),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(getDb).mockReturnValue(makeDb() as never);

  vi.mocked(createSessionStorage).mockReturnValue({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 99) })),
  } as never);

  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo" } as never,
    userRole: "collaborator",
  });

  vi.mocked(requireProjectMember).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// toggle-featured
// ---------------------------------------------------------------------------

describe("_app.objects action: toggle-featured IDOR fix", () => {
  it("returns ok:true and scopes the UPDATE where-clause by the row's own project id", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-featured", { objectDbId: "10", currentValue: "false" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("toggle-featured");
    expect(vi.mocked(requireProjectMember)).toHaveBeenCalledWith(expect.anything(), 42, 7);

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).toHaveBeenCalled();

    const whereArg = captureWhereArg();
    expect(drizzleClauseContainsValue(whereArg, 42)).toBe(true);
  });

  // The row names its own site now: the session's active project plays no
  // part in scoping the UPDATE, so a session naming a different project
  // (55) still scopes to the row's own project (42).
  it("scopes the UPDATE by the row's own project regardless of the session's active project", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 55, github_repo_full_name: "owner/other" } as never,
      userRole: "collaborator",
    });

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-featured", { objectDbId: "10", currentValue: "false" }),
      context,
      params: {},
    } as never)) as { ok: boolean };

    expect(res.ok).toBe(true);
    const whereArg = captureWhereArg();
    expect(drizzleClauseContainsValue(whereArg, 42)).toBe(true);
    expect(drizzleClauseContainsValue(whereArg, 55)).toBe(false);
  });

  // A row absent at toggle time (deleted between the grid read and the
  // click) answers ok with no write, rather than an error: there is nothing
  // left to refuse the caller on.
  it("returns { ok:true } and does NOT mutate DB when the object row does not exist", async () => {
    vi.mocked(getDb).mockReturnValue(makeDb(null) as never);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("toggle-featured", { objectDbId: "10", currentValue: "false" }),
      context,
      params: {},
    } as never)) as { ok: boolean; intent: string };

    expect(res).toEqual({ ok: true, intent: "toggle-featured" });

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// registration — dimensions + extra_columns passthrough (H17 gap #2)
//
// New objects pulled in via sync travel as PendingObject blobs through the
// client and into the committing action, whose record hands them to the
// registration. The action no longer writes D1 itself
// — the row is minted by the collaboration DO's snapshot — so the two fields
// have to survive one step earlier, on the ingest payload the DO builds the
// object Y.Map from. Drop them there and the snapshot INSERT writes empty
// strings, which is the same lost accession number by a longer route.
// ---------------------------------------------------------------------------

describe("registration carries dimensions + extra_columns", () => {
  it("includes dimensions and extra_columns on the ingested object", async () => {
    let ingestBody: Record<string, unknown> | null = null;

    vi.mocked(signInternalMarker).mockResolvedValue({
      sigHex: "sig",
      timestamp: 1,
    } as never);
    vi.mocked(getDb).mockReturnValue({
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) })),
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

    const user = { id: 7, encrypted_access_token: "enc-token" };
    const context = {
      get: vi.fn(() => user),
      cloudflare: {
        env: {
          ENCRYPTION_KEY: "key",
          SESSION_SECRET: "sess-secret",
          DB: {},
          COLLABORATION: {
            idFromName: vi.fn(() => "do-id"),
            get: vi.fn(() => ({
              fetch: vi.fn(async (req: Request) => {
                ingestBody = JSON.parse(await req.text()) as Record<string, unknown>;
                return new Response(
                  JSON.stringify({ applied: { objectInsert: 1 }, skipped: {}, failed: {} }),
                  { status: 200 },
                );
              }),
            })),
          },
        },
      },
    } as unknown as Parameters<typeof action>[0]["context"];

    // The objects reach the registration from the committing action's record,
    // which holds them as the client sent them.
    const env = (context as unknown as { cloudflare: { env: Env } }).cloudflare.env;
    const res = await registerCommittedObjects(env, getDb(env.DB), 42, 7, pendingObjects);

    expect(res.ok).toBe(true);

    expect(ingestBody).not.toBeNull();
    const sent = (ingestBody as unknown as {
      objects: { insert: Array<Record<string, unknown>> };
    }).objects.insert;
    expect(sent).toHaveLength(1);
    expect(sent[0].object_id).toBe("new-obj");
    expect(sent[0].dimensions).toBe("40 x 20 cm");
    expect(sent[0].extra_columns).toBe(
      JSON.stringify({ accession_number: "ACC-2026-001" }),
    );
  });
});
