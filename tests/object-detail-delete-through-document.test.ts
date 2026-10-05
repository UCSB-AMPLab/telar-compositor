/**
 * The object detail page's delete leaves the D1 row to the snapshot.
 *
 * The document is the delete signal on every object path: removing the Y.Map
 * is what a delete means, and the Durable Object's snapshot DELETE branch
 * sweeps the D1 row that no Y.Map claims any more. A route action that deleted
 * the row itself could run without the Y.Map ever being removed — the socket
 * not yet connected, or a direct POST — and the surviving Y.Map would then be
 * re-INSERTed by the next snapshot, resurrecting the object with metadata
 * pointing at repository files a `fromRepo` delete had already removed.
 *
 * So the action issues no DELETE of its own. It removes the Y.Map through the
 * collaboration object's ingest, after the convenor-gated repo cleanup when
 * asked (tested in tests/object-delete-on-server.test.ts), and
 * answers `ok` with the `objectDbId` it was given, which the page binds its
 * answer to. The standing it enforces is unchanged:
 * the document's own delete admits the convenor or the object's creator, repo
 * cleanup admits the convenor alone, and a course item is refused to
 * everyone.
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
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
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

vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "captured-head"),
  getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
  getFileAtRef: vi.fn(async () => ({
    status: "ok",
    content: "object_id,title\nobj-123,Plain object\n",
  })),
  getFileContent: vi.fn(async () => "object_id,title\n"),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn(async () => true) }));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "sha-after-delete" })),
  dispatchWorkflow: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
}));
vi.mock("~/lib/csv-export.server", () => ({
  serializeObjectsCsv: vi.fn(() => "id,title\n"),
  dbObjectToCsvRow: vi.fn((o: unknown) => o),
}));

// Client-side deps the route module pulls in but these action cases never run.
vi.mock("~/lib/iiif-types", () => ({ deriveStatus: vi.fn() }));
vi.mock("~/lib/media-type", () => ({
  detectMediaType: vi.fn(() => "image"),
  extractVideoId: vi.fn(),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), getYText: vi.fn() }));
vi.mock("~/components/features/objects/IiifViewer", () => ({ IiifViewer: vi.fn() }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({
  CommitAndBuildModal: vi.fn(),
}));
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: vi.fn() }));
vi.mock("~/components/features/editor/AudioPlayer", () => ({ AudioPlayer: vi.fn() }));
vi.mock("~/components/ui/Switch", () => ({ Switch: vi.fn() }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: vi.fn() }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: vi.fn() }));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.objects.$objectId";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject, getUserRole } from "~/lib/membership.server";
import { commitFilesToRepo } from "~/lib/commit.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { projects as projectsTable } from "~/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The caller in every test below. */
const CALLER_ID = 7;
/** Another member of the same project. */
const OTHER_MEMBER_ID = 21;

const PLAIN_ROW = {
  id: 10,
  project_id: 42,
  object_id: "obj-123",
  title: "Plain object",
  missing_from_repo: false,
  course_project_id: null,
  created_by: OTHER_MEMBER_ID,
};

function buildRequest(extra: Record<string, string>): Request {
  const form = new URLSearchParams();
  form.set("intent", "delete-object");
  form.set("objectDbId", "10");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new Request("https://compositor.telar.org/objects/obj-123", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext(userId = CALLER_ID) {
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
  } as unknown as Parameters<typeof action>[0]["context"];
}

/**
 * A db whose single-row select returns `row`; `del` is the DELETE spy. The
 * object's own project is a second select, against a different table, so it
 * answers a project row shaped from the object row's own project_id.
 */
function seed(row: Record<string, unknown>) {
  const del = vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) }));
  const projectRow = {
    id: row.project_id,
    github_repo_full_name: "owner/repo",
    installation_id: 5,
    gh_workflows_write_missing: null,
  };
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(table === projectsTable ? [projectRow] : [row]),
          orderBy: vi.fn().mockResolvedValue([row]),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue({}) })) })),
    delete: del,
  } as never);
  return del;
}

/** The role the caller carries on project 42 — the object's own project in
 * every test that does not deliberately move it. `getUserRole` answers null
 * for any other project id, which is what a caller with no membership there
 * reads as. */
function asRole(role: "convenor" | "collaborator" | "instructor", projectId = 42) {
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: {
      id: projectId,
      github_repo_full_name: "owner/repo",
      installation_id: 5,
    } as never,
    userRole: role,
  });
  vi.mocked(getUserRole).mockImplementation(async (_db, pid) => (pid === projectId ? role : null));
}

/** Run delete-object and return either the payload or the thrown redirect. */
async function runDelete(fromRepo: boolean): Promise<unknown> {
  try {
    return await action({
      request: buildRequest({ fromRepo: String(fromRepo) }),
      context: buildContext(),
      params: { objectId: "obj-123" },
    } as never);
  } catch (e) {
    return e;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(commitFilesToRepo).mockResolvedValue({ newHeadSha: "sha-after-delete" } as never);
  vi.mocked(getRepoHead).mockResolvedValue("captured-head");
  vi.mocked(getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  vi.mocked(getFileAtRef).mockResolvedValue({
    status: "ok",
    content: "object_id,title\nobj-123,Plain object\n",
  });
  asRole("convenor");
});

/** The answer an admitted delete gives, either path. */
const ADMITTED = { ok: true, intent: "delete-object", objectDbId: 10, pending: false };

// ---------------------------------------------------------------------------
// The row is left to the snapshot
// ---------------------------------------------------------------------------

describe("_app.objects.$objectId delete-object — the document is the delete signal", () => {
  it("issues no DELETE of its own on the compositor-only path", async () => {
    const del = seed(PLAIN_ROW);

    expect(await runDelete(false)).toEqual(ADMITTED);
    expect(del).not.toHaveBeenCalled();
  });

  it("issues no DELETE of its own on the repo path either", async () => {
    const del = seed(PLAIN_ROW);

    const result = await runDelete(true);

    // Repo cleanup is the action's own work and still runs.
    expect(vi.mocked(commitFilesToRepo)).toHaveBeenCalled();
    expect(result).toEqual(ADMITTED);
    expect(del).not.toHaveBeenCalled();
  });

  it("answers ok with the objectDbId rather than redirecting", async () => {
    seed(PLAIN_ROW);

    const result = await runDelete(false);

    // The page, not the action, leaves the page: a redirect here would land
    // before the document write the answer authorises.
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual(ADMITTED);
  });
});

// ---------------------------------------------------------------------------
// Standing, unchanged
// ---------------------------------------------------------------------------

describe("_app.objects.$objectId delete-object — standing survives the change", () => {
  for (const role of ["collaborator", "instructor"] as const) {
    it(`refuses a ${role} who did not create the object`, async () => {
      asRole(role);
      const del = seed(PLAIN_ROW);

      expect(await runDelete(false)).toEqual({
        ok: false, error: "forbidden", objectDbId: 10,
      });
      expect(del).not.toHaveBeenCalled();
    });

    it(`refuses a ${role} the repo path even on their own object`, async () => {
      asRole(role);
      const del = seed({ ...PLAIN_ROW, created_by: CALLER_ID });

      expect(await runDelete(true)).toEqual({
        ok: false, error: "forbidden", objectDbId: 10,
      });
      expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    });

    it(`admits a ${role} on an object they created`, async () => {
      asRole(role);
      seed({ ...PLAIN_ROW, created_by: CALLER_ID });

      expect(await runDelete(false)).toEqual(ADMITTED);
    });
  }

  it("refuses a course item to the convenor, repo cleanup included", async () => {
    const del = seed({ ...PLAIN_ROW, course_project_id: 7 });

    expect(await runDelete(true)).toEqual({
      ok: false,
      error: "course_item_delete_refused",
      objectDbId: 10,
    });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  // The object's own project is 99 now, not 42 — the row names its own
  // site, and the caller (a member of 42 only, per the default beforeEach
  // role) carries no standing there.
  it("refuses an object whose own project the caller does not belong to", async () => {
    const del = seed({ ...PLAIN_ROW, project_id: 99 });

    const result = await runDelete(false);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect(del).not.toHaveBeenCalled();
  });
});
