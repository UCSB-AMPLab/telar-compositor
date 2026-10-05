/**
 * The one `delete-object` action must refuse a course item.
 *
 * `objects.course_project_id` gates deletion on every path, not only through
 * the collaborative document: the detail page's `delete-object` reads the
 * row's marker server-side, in the action, before doing any work of its own
 * (design §6). The UI gate is a mirror, not the enforcement.
 *
 * The delete lives on the detail route alone, so the objects list is covered
 * here for what it must NOT do: the intent reaches its 400 default and no D1
 * delete of its own. The detail action removes no row either — the document
 * is the delete signal there and the snapshot's DELETE branch takes the row —
 * so its unmarked case asserts the `ok` answer the page waits for, not a
 * DELETE.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted, self-contained factories
// ---------------------------------------------------------------------------

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
// The document half goes through the collaboration object and its record is
// tested in tests/object-delete-on-server.test.ts; here it answers done.
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 42) })),
  })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(),
  getUserRole: vi.fn(),
}));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));

// Objects-list route deps
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
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn(async () => true) }));
vi.mock("~/lib/sync.server", () => ({ computeSyncDiff: vi.fn(), applySyncChanges: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(() => false),
  disableGoogleSheetsInConfig: vi.fn(),
  verifySiteUrl: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(),
  resolveProjectToken: vi.fn(async () => "installation-token"),
}));
vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn(async () => "applied") }));
vi.mock("~/lib/csv-export.server", () => ({
  serializeObjectsCsv: vi.fn(() => "csv"),
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
  getYText: vi.fn(),
}));

// Detail-route-only deps
vi.mock("~/lib/iiif-types", () => ({ deriveStatus: vi.fn() }));
vi.mock("~/lib/media-type", () => ({ detectMediaType: vi.fn(() => "image"), extractVideoId: vi.fn() }));
vi.mock("~/components/features/objects/IiifViewer", () => ({ IiifViewer: vi.fn() }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({ CommitAndBuildModal: vi.fn() }));
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: vi.fn() }));
vi.mock("~/components/features/editor/AudioPlayer", () => ({ AudioPlayer: vi.fn() }));
vi.mock("~/components/ui/Switch", () => ({ Switch: vi.fn() }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: vi.fn() }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: vi.fn() }));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action as objectsListAction } from "~/routes/_app.objects";
import { action as objectDetailAction } from "~/routes/_app.objects.$objectId";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject, getUserRole } from "~/lib/membership.server";
import { projects as projectsTable } from "~/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(url: string, extra: Record<string, string>): Request {
  const form = new URLSearchParams();
  form.set("intent", "delete-object");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new Request(url, {
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
    get: vi.fn(() => user),
    cloudflare: { env },
  } as unknown as Parameters<typeof objectsListAction>[0]["context"];
}

const PROJECT_ROW = {
  id: 42,
  github_repo_full_name: "owner/repo",
  installation_id: 5,
  gh_workflows_write_missing: null,
};

/**
 * A db whose single-row select returns `row`; delete/update are spies. The
 * detail route's delete-object also reads the row's own project — a second
 * select, against a different table — so dispatch on the table asked for.
 */
function makeDb(row: Record<string, unknown> | null) {
  const deleteWhere = vi.fn().mockResolvedValue({});
  const del = vi.fn(() => ({ where: deleteWhere }));
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(table === projectsTable ? [PROJECT_ROW] : (row ? [row] : [])),
            orderBy: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) })) })),
      delete: del,
    },
    del,
  };
}

const PLAIN_ROW = {
  id: 10,
  project_id: 42,
  object_id: "obj-123",
  title: "Plain object",
  missing_from_repo: false,
  course_project_id: null,
};

const COURSE_ROW = { ...PLAIN_ROW, title: "Course object", course_project_id: 7 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5 } as never,
    userRole: "convenor",
  });
  vi.mocked(getUserRole).mockResolvedValue("convenor");
});

// ---------------------------------------------------------------------------
// Objects list — _app.objects delete-object
// ---------------------------------------------------------------------------

describe("_app.objects delete-object — the list route handles no delete", () => {
  for (const [label, row] of [["marked", COURSE_ROW], ["unmarked", PLAIN_ROW]] as const) {
    it(`leaves a ${label} object alone and answers 400`, async () => {
      const { db, del } = makeDb(row);
      vi.mocked(getDb).mockReturnValue(db as never);

      let thrown: unknown = null;
      try {
        await objectsListAction({
          request: buildRequest("https://compositor.telar.org/objects", { objectDbId: "10", siteId: "42" }),
          context: buildContext(),
          params: {},
        } as never);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(400);
      expect(del).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Detail page — _app.objects.$objectId delete-object
// ---------------------------------------------------------------------------

describe("_app.objects.$objectId delete-object — course-item refusal", () => {
  it("refuses a marked object with course_item_delete_refused and does not delete", async () => {
    const { db, del } = makeDb(COURSE_ROW);
    vi.mocked(getDb).mockReturnValue(db as never);

    const res = (await objectDetailAction({
      request: buildRequest("https://compositor.telar.org/objects/obj-123", {
        objectDbId: "10",
        fromRepo: "false",
      }),
      context: buildContext(),
      params: { objectId: "obj-123" },
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("course_item_delete_refused");
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses a marked object before touching the repo, even with fromRepo=true", async () => {
    const { db, del } = makeDb(COURSE_ROW);
    vi.mocked(getDb).mockReturnValue(db as never);
    const { commitFilesToRepo } = await import("~/lib/commit.server");

    const res = (await objectDetailAction({
      request: buildRequest("https://compositor.telar.org/objects/obj-123", {
        objectDbId: "10",
        fromRepo: "true",
      }),
      context: buildContext(),
      params: { objectId: "obj-123" },
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("course_item_delete_refused");
    expect(del).not.toHaveBeenCalled();
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("still admits an unmarked object, leaving its row to the snapshot", async () => {
    const { db, del } = makeDb(PLAIN_ROW);
    vi.mocked(getDb).mockReturnValue(db as never);

    const res = await objectDetailAction({
      request: buildRequest("https://compositor.telar.org/objects/obj-123", {
        objectDbId: "10",
        fromRepo: "false",
      }),
      context: buildContext(),
      params: { objectId: "obj-123" },
    } as never);

    // The answer the page waits for before it writes the document.
    expect(res).toEqual({ ok: true, intent: "delete-object", objectDbId: 10, pending: false });
    expect(del).not.toHaveBeenCalled();
  });
});
