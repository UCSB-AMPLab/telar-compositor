/**
 * Deleting an object from the repository refuses on a site behind the latest
 * release, or when the latest release cannot be read.
 *
 * The repository half rewrites objects.csv and the site rebuilds from it, so
 * it is gated as publishing is, before anything is read or committed. The
 * compositor-only delete writes nothing to the repository and stays open.
 * The gate runs for real; the site version and the release read are each
 * case's inputs.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("~/lib/membership.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/membership.server")>();
  return { ...actual, resolveActiveProject: vi.fn() };
});
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/github.server")>();
  return { ...actual, getRepoHead: vi.fn(), getRepoTree: vi.fn(), getFileContent: vi.fn() };
});
vi.mock("~/lib/github-status.server", () => ({
  bumpProjectHeadFrom: vi.fn(async () => true),
  readLatestTag: vi.fn(async () => ({ ok: true, tag: "v1.8.0" })),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
}));
vi.mock("~/lib/object-repo-delete.server", () => ({
  deleteObjectWithRecord: vi.fn(async () => ({ ok: true, headSha: "new-head", pending: false })),
}));
vi.mock("~/lib/iiif-types", () => ({ deriveStatus: vi.fn() }));
vi.mock("~/lib/media-type", () => ({ detectMediaType: vi.fn(() => "image"), extractVideoId: vi.fn() }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), getYText: vi.fn() }));
vi.mock("~/components/features/objects/IiifViewer", () => ({ IiifViewer: vi.fn() }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({ CommitAndBuildModal: vi.fn() }));
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: vi.fn() }));
vi.mock("~/components/features/editor/AudioPlayer", () => ({ AudioPlayer: vi.fn() }));
vi.mock("~/components/ui/Switch", () => ({ Switch: vi.fn() }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: vi.fn() }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: vi.fn() }));

import { action } from "~/routes/_app.objects.$objectId";
import { getDb } from "~/lib/db.server";
import { resolveActiveProject } from "~/lib/membership.server";
import { readLatestTag, bumpProjectHeadFrom } from "~/lib/github-status.server";
import { deleteObjectWithRecord } from "~/lib/object-repo-delete.server";
import { getRepoHead } from "~/lib/github.server";
import { objects, projects, project_members, project_config } from "~/db/schema";

const OBJECT_DB_ID = 10;
const TARGET_ROW = {
  id: OBJECT_DB_ID,
  project_id: 42,
  object_id: "plano-de-tunja",
  title: "Plano de Tunja",
  missing_from_repo: false,
  course_project_id: null,
  created_by: 7,
};
const PROJECT_ROW = {
  id: 42,
  github_repo_full_name: "owner/repo",
  installation_id: 5,
  gh_workflows_write_missing: null,
};

let siteVersion: string | null = "1.0.0";
const writes: string[] = [];

function makeDb() {
  return {
    // The object lookup, the project lookup, the member-role lookup, and the
    // gate's version read each select a different table; dispatch on it.
    select: vi.fn((columns?: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (table === project_config) return columns && "telar_version" in columns
              ? (siteVersion === null ? [] : [{ telar_version: siteVersion }])
              : [];
            if (table === projects) return [PROJECT_ROW];
            if (table === project_members) return [{ role: "convenor" }];
            if (table === objects) return [TARGET_ROW];
            return [];
          }),
        })),
      })),
    })),
    update: vi.fn(() => {
      writes.push("update");
      return { set: vi.fn(() => ({ where: vi.fn(async () => {}) })) };
    }),
    delete: vi.fn(() => {
      writes.push("delete");
      return { where: vi.fn(async () => {}) };
    }),
  };
}

async function deleteObject(fromRepo: boolean) {
  const form = new URLSearchParams({
    intent: "delete-object",
    objectDbId: String(OBJECT_DB_ID),
    fromRepo: String(fromRepo),
  });
  const request = new Request("https://compositor.telar.org/objects/plano-de-tunja", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const context = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {}, GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "pk" } },
  };
  return (await action({ request, context, params: { objectId: "plano-de-tunja" } } as never)) as Record<string, unknown>;
}

function nothingWritten() {
  expect(getRepoHead).not.toHaveBeenCalled();
  expect(deleteObjectWithRecord).not.toHaveBeenCalled();
  expect(bumpProjectHeadFrom).not.toHaveBeenCalled();
  expect(writes).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  siteVersion = "1.0.0";
  writes.length = 0;
  vi.mocked(getDb).mockReturnValue(makeDb() as never);
  vi.mocked(readLatestTag).mockResolvedValue({ ok: true, tag: "v1.8.0" });
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo", installation_id: 5, gh_workflows_write_missing: null } as never,
    userRole: "convenor",
  });
});

describe("delete-object from the repository", () => {
  it("refuses a site behind the latest release without reading or committing", async () => {
    expect(await deleteObject(true)).toEqual({ ok: false, error: "upgrade_required", objectDbId: OBJECT_DB_ID });
    nothingWritten();
  });

  it("refuses when the latest release cannot be read without reading or committing", async () => {
    vi.mocked(readLatestTag).mockResolvedValue({ ok: false });

    expect(await deleteObject(true)).toEqual({ ok: false, error: "release_unknown", objectDbId: OBJECT_DB_ID });
    nothingWritten();
  });

  it("deletes on a current site", async () => {
    siteVersion = "1.8.0";

    expect(await deleteObject(true)).toEqual({ ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: false });
    expect(deleteObjectWithRecord).toHaveBeenCalledTimes(1);
  });
});

describe("delete-object from the compositor only", () => {
  it("stays open when the latest release cannot be read", async () => {
    vi.mocked(readLatestTag).mockResolvedValue({ ok: false });

    expect(await deleteObject(false)).toEqual({ ok: true, intent: "delete-object", objectDbId: OBJECT_DB_ID, pending: false });
    expect(readLatestTag).not.toHaveBeenCalled();
  });
});
