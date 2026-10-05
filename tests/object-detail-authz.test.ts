/**
 * Authorization tests for autosave-object-field, autosave-object-featured,
 * update-object, and delete-object action cases in _app.objects.$objectId.tsx.
 *
 * Verifies that all four intents scope their mutations by the caller's active
 * project, closing the cross-project IDOR where any signed-in user could
 * update or delete any object by db id — and that `delete-object` additionally
 * requires standing, since project scope alone admits every collaborator and
 * instructor in the project. The two halves of the delete dialog take two
 * different standings; see the block comment above the standing tests at the
 * foot of this file.
 *
 * `delete-object` issues no DELETE of its own: the object's Y.Map removal is
 * the delete and the snapshot's DELETE branch takes the D1 row. So what a
 * refusal costs an unauthorised caller is the repo cleanup and the `ok` answer
 * the page needs before it writes the document, and every case here asserts
 * that no DELETE reaches D1 either way. Every answer, refusal included,
 * carries the `objectDbId` it was asked about — that is what binds it to the
 * request the page made.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue({}),
    })),
  })),
}));
// The document half goes through the collaboration object and its record is
// tested in tests/object-delete-on-server.test.ts; here it answers done.
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
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
  getUserRole: vi.fn(async () => "convenor"),
  requireProjectMember: vi.fn(async () => {}),
}));

vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(),
}));

// Heavy server-side deps not needed for these action cases
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(),
  getRepoTree: vi.fn(),
  getFileAtRef: vi.fn(),
  getFileContent: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(),
  resolveProjectToken: vi.fn(async () => "installation-token"),
}));
vi.mock("~/lib/csv-export.server", () => ({
  serializeObjectsCsv: vi.fn(() => ""),
  dbObjectToCsvRow: vi.fn((o: unknown) => o),
}));
vi.mock("~/lib/iiif-types", () => ({ deriveStatus: vi.fn() }));
vi.mock("~/lib/media-type", () => ({
  detectMediaType: vi.fn(() => "image"),
  extractVideoId: vi.fn(),
}));
vi.mock("~/lib/yjs-helpers", () => ({
  findYMapById: vi.fn(),
  getYText: vi.fn(),
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: vi.fn(),
}));
vi.mock("~/components/features/objects/IiifViewer", () => ({
  IiifViewer: vi.fn(),
}));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({
  CommitAndBuildModal: vi.fn(),
}));
vi.mock("~/components/features/editor/VideoEmbed", () => ({
  VideoEmbed: vi.fn(),
}));
vi.mock("~/components/features/editor/AudioPlayer", () => ({
  AudioPlayer: vi.fn(),
}));
vi.mock("~/components/ui/Switch", () => ({ Switch: vi.fn() }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: vi.fn() }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: vi.fn() }));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/_app.objects.$objectId";
import { getDb } from "~/lib/db.server";
import { createSessionStorage } from "~/lib/session.server";
import { resolveActiveProject, getUserRole, requireProjectMember } from "~/lib/membership.server";
import { projects as projectsTable } from "~/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(intent: string, extra: Record<string, string> = {}): Request {
  const form = new URLSearchParams();
  form.set("intent", intent);
  for (const [k, v] of Object.entries(extra)) {
    form.set(k, v);
  }
  return new Request("https://compositor.telar.org/objects/obj-123", {
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
  };
  return {
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    } as unknown as Parameters<typeof action>[0]["context"],
  };
}

// Extract the captured where-argument from the last db.update().set().where() call.
function captureUpdateWhereArg(): unknown {
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

// Walk a Drizzle SQL node recursively and check whether `value` appears anywhere.
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

const DEFAULT_OBJECT_ROW = {
  id: 10,
  project_id: 42,
  object_id: "obj-123",
  title: "Test Object",
  missing_from_repo: false,
};

const DEFAULT_PROJECT_ROW = {
  id: 42,
  github_repo_full_name: "owner/repo",
  installation_id: 5,
  gh_workflows_write_missing: null,
};

/**
 * A db mock whose select dispatches on the table it was asked to read from:
 * `delete-object` reads the object row and then the row's own project row,
 * two different tables now that neither read is scoped by the session.
 */
function makeDb(opts: { objectRows?: unknown[]; projectRows?: unknown[] } = {}) {
  const { objectRows = [DEFAULT_OBJECT_ROW], projectRows = [DEFAULT_PROJECT_ROW] } = opts;
  return {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(table === projectsTable ? projectRows : objectRows),
        })),
        orderBy: vi.fn().mockResolvedValue([]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue({}),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue({}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Setup — reset mocks before every test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Fresh db mock with select that returns a default object row
  vi.mocked(getDb).mockReturnValue(makeDb() as never);

  vi.mocked(createSessionStorage).mockReturnValue({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 99) })),
  } as never);

  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo" } as never,
    userRole: "collaborator",
  });

  vi.mocked(getUserRole).mockResolvedValue("convenor");
  vi.mocked(requireProjectMember).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// autosave-object-featured
// ---------------------------------------------------------------------------

describe("_app.objects.$objectId action: autosave-object-featured IDOR fix", () => {
  // The row now names its own site: the UPDATE is scoped by the object row's
  // own project_id (42, from DEFAULT_OBJECT_ROW), not the session's active
  // project, and membership is checked on that same project.
  it("scopes the UPDATE where-clause by the row's own project id", async () => {
    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("autosave-object-featured", {
        entityId: "10",
        value: "true",
      }),
      context,
      params: { objectId: "obj-123" },
    } as never)) as { ok: boolean; intent: string };

    expect(res.ok).toBe(true);
    expect(res.intent).toBe("autosave-object-featured");
    expect(vi.mocked(requireProjectMember)).toHaveBeenCalledWith(expect.anything(), 42, 7);

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).toHaveBeenCalled();

    const whereArg = captureUpdateWhereArg();
    expect(drizzleClauseContainsValue(whereArg, 42)).toBe(true);
  });

  // A row absent at toggle time (deleted between the grid read and the
  // click) answers ok with no write, rather than an error: there is nothing
  // left to refuse the caller on.
  it("returns { ok:true } and does NOT mutate DB when the object row does not exist", async () => {
    vi.mocked(getDb).mockReturnValue(makeDb({ objectRows: [] }) as never);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("autosave-object-featured", {
        entityId: "10",
        value: "false",
      }),
      context,
      params: { objectId: "obj-123" },
    } as never)) as { ok: boolean; intent?: string };

    expect(res).toEqual({ ok: true, intent: "autosave-object-featured" });

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// delete-object
// ---------------------------------------------------------------------------

describe("_app.objects.$objectId action: delete-object IDOR fix", () => {
  // The object's own project (99) is looked up and the caller's standing is
  // read there directly — not compared against the session's active
  // project. A caller with no membership on that project is refused.
  it("redirects to /objects without calling db.delete when the caller has no membership on the object's own project", async () => {
    vi.mocked(getDb).mockReturnValue(makeDb({
      objectRows: [{
        id: 10,
        project_id: 99,
        object_id: "obj-123",
        title: "Test Object",
        missing_from_repo: false,
        created_by: null,
      }],
      projectRows: [{ id: 99, github_repo_full_name: "other/repo", installation_id: 9, gh_workflows_write_missing: null }],
    }) as never);
    vi.mocked(getUserRole).mockResolvedValue(null);

    const { context } = buildContext();
    const result = action({
      request: buildRequest("delete-object", { objectDbId: "10", fromRepo: "false" }),
      context,
      params: { objectId: "obj-123" },
    } as never);

    // Should throw a redirect Response (302)
    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(302);
    expect(err.headers.get("Location")).toContain("/objects");
    expect(vi.mocked(getUserRole)).toHaveBeenCalledWith(expect.anything(), 99, 7);

    // db.delete must NOT have been called
    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      delete: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.delete).not.toHaveBeenCalled();
  });

  // The object's project_id may name a project row that is itself gone
  // (deleted, or never existed); that answers the same redirect as a role
  // read that finds no membership.
  it("redirects to /objects without db.delete when the object's project row is missing", async () => {
    vi.mocked(getDb).mockReturnValue(makeDb({ projectRows: [] }) as never);

    const { context } = buildContext();
    const result = action({
      request: buildRequest("delete-object", { objectDbId: "10" }),
      context,
      params: { objectId: "obj-123" },
    } as never);

    await expect(result).rejects.toBeInstanceOf(Response);
    const err = (await result.catch((e: unknown) => e)) as Response;
    expect(err.status).toBe(302);
    expect(err.headers.get("Location")).toContain("/objects");

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      delete: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.delete).not.toHaveBeenCalled();
  });

  it("admits an object in the caller's own project without issuing a DELETE", async () => {
    // Object belongs to project 42 (DEFAULT_OBJECT_ROW / DEFAULT_PROJECT_ROW),
    // and the caller carries the convenor standing the delete gate requires.
    vi.mocked(getUserRole).mockResolvedValue("convenor");

    const { context } = buildContext();

    const result = await action({
      request: buildRequest("delete-object", { objectDbId: "10", fromRepo: "false" }),
      context,
      params: { objectId: "obj-123" },
    } as never);

    // An admitted delete answers ok; the page writes the document from there.
    expect(result).toEqual({ ok: true, intent: "delete-object", objectDbId: 10, pending: false });

    // The row itself is the snapshot's to take.
    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      delete: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// delete-object — standing, not just membership
// ---------------------------------------------------------------------------

/**
 * The delete dialog offers two operations and they take two different
 * standings.
 *
 * "Remove from compositor" (no `fromRepo`) is the collaborative document's own
 * delete. `use-structural-ops.ts` states the model — the convenor deletes
 * anything, a collaborator or instructor deletes only what they created —
 * `canDeleteYMap` implements it, `workers/can-delete.ts` enforces it
 * server-side as a "legitimate self-delete", and the objects grid honours it.
 * So the detail page must honour it too, or the same object is deletable from
 * the list and refused on its own page.
 *
 * "Delete from repo" (`fromRepo`) additionally removes the image folder and
 * the objects.csv row from the published site. That repo cleanup is what the
 * objects LIST route admits the convenor alone to, so it stays convenor-only
 * for everyone else — including a collaborator deleting their own object.
 *
 * `resolveActiveProjectFromRequest` establishes membership only, so the role
 * it reports is what both predicates read.
 */

/** The caller in every test below (buildContext's default user id). */
const CALLER_ID = 7;
/** Some other member of the same project. */
const OTHER_MEMBER_ID = 21;

/** The two answers the standing tests below expect, both bound to the id. */
const REFUSED = { ok: false, error: "forbidden", objectDbId: 10 };
const ADMITTED = { ok: true, intent: "delete-object", objectDbId: 10, pending: false };

/** Seed the object row the action looks up, with a chosen `created_by`. */
function seedObject(createdBy: number | null) {
  vi.mocked(getDb).mockReturnValue(makeDb({
    objectRows: [{
      id: 10,
      project_id: 42,
      object_id: "obj-123",
      title: "Test Object",
      missing_from_repo: false,
      created_by: createdBy,
    }],
  }) as never);
}

// `getUserRole` reads the row's own project (42 in every standing test
// below); `resolveActiveProject` still feeds the site-level poll-build and
// dispatch-iiif cases further down, which read the session's page project.
function asRole(role: "convenor" | "collaborator" | "instructor") {
  vi.mocked(getUserRole).mockResolvedValue(role);
  vi.mocked(resolveActiveProject).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo" } as never,
    userRole: role,
  });
}

/** Run delete-object and return either the payload or the thrown redirect. */
async function runDelete(fromRepo: boolean): Promise<unknown> {
  const { context } = buildContext(CALLER_ID);
  try {
    return await action({
      request: buildRequest("delete-object", {
        objectDbId: "10",
        fromRepo: String(fromRepo),
      }),
      context,
      params: { objectId: "obj-123" },
    } as never);
  } catch (e) {
    return e;
  }
}

function deleteMock() {
  return (
    vi.mocked(getDb).mock.results.at(-1)?.value as {
      delete: ReturnType<typeof vi.fn>;
    }
  ).delete;
}

describe("_app.objects.$objectId delete-object: remove-from-compositor follows canDeleteYMap", () => {
  for (const role of ["collaborator", "instructor"] as const) {
    it(`refuses a ${role} who did not create the object`, async () => {
      asRole(role);
      seedObject(OTHER_MEMBER_ID);

      expect(await runDelete(false)).toEqual(REFUSED);
      expect(deleteMock()).not.toHaveBeenCalled();
    });

    it(`refuses a ${role} when the object has no recorded creator`, async () => {
      asRole(role);
      seedObject(null);

      expect(await runDelete(false)).toEqual(REFUSED);
      expect(deleteMock()).not.toHaveBeenCalled();
    });

    it(`admits a ${role} on an object they created themselves`, async () => {
      asRole(role);
      seedObject(CALLER_ID);

      // An admitted delete answers ok and leaves the row to the snapshot.
      expect(await runDelete(false)).toEqual(ADMITTED);
      expect(deleteMock()).not.toHaveBeenCalled();
    });
  }

  it("admits the convenor on an object someone else created", async () => {
    asRole("convenor");
    seedObject(OTHER_MEMBER_ID);

    expect(await runDelete(false)).toEqual(ADMITTED);
    expect(deleteMock()).not.toHaveBeenCalled();
  });
});

describe("_app.objects.$objectId delete-object: delete-from-repo stays convenor-only", () => {
  for (const role of ["collaborator", "instructor"] as const) {
    it(`refuses a ${role} on their OWN object — repo cleanup is not theirs`, async () => {
      asRole(role);
      seedObject(CALLER_ID);

      expect(await runDelete(true)).toEqual(REFUSED);
      expect(deleteMock()).not.toHaveBeenCalled();
    });

    it(`refuses a ${role} on someone else's object`, async () => {
      asRole(role);
      seedObject(OTHER_MEMBER_ID);

      expect(await runDelete(true)).toEqual(REFUSED);
      expect(deleteMock()).not.toHaveBeenCalled();
    });
  }

  it("admits the convenor past the gate and into the repo branch", async () => {
    asRole("convenor");
    seedObject(OTHER_MEMBER_ID);

    const result = await runDelete(true);

    // The repo branch's GitHub deps are stubbed, so the head read throws and
    // the branch answers delete_failed. That is the whole point of the case:
    // the convenor got past the role check and into work the gate would
    // otherwise have refused, and a read it cannot rely on commits nothing.
    expect(result).toEqual({ ok: false, error: "delete_failed", objectDbId: 10 });
    const { commitFilesToRepo } = await import("~/lib/commit.server");
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });
});

// poll-build and dispatch-iiif are both member-level
// (a collaborator reaches them, per their own comments in the route). A
// private repo the collaborator is not a GitHub collaborator on rejects
// their own OAuth token outright, so both must resolve their token through
// resolveProjectToken (installation token, user-token fallback for the
// convenor only) rather than the collaborator's own decrypted token.
describe("_app.objects.$objectId poll-build and dispatch-iiif run on the resolved project token", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("poll-build (collaborator): the run-status fetch and getJobSteps run on resolveProjectToken's token", async () => {
    asRole("collaborator");
    const { resolveProjectToken } = await import("~/lib/github-app.server");
    vi.mocked(resolveProjectToken).mockResolvedValueOnce("resolved-token");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/owner/repo/actions/runs/900",
        id: 900,
      }),
    });
    globalThis.fetch = fetchSpy as never;
    const { getJobSteps, mapStepsToBuildPhases } = await import("~/lib/commit.server");
    vi.mocked(getJobSteps).mockResolvedValue([]);
    vi.mocked(mapStepsToBuildPhases).mockReturnValue([]);
    const { githubHeaders } = await import("~/lib/github.server");

    const { context } = buildContext(CALLER_ID);
    const res = (await action({
      request: buildRequest("poll-build", { runId: "900", siteId: "42" }),
      context,
      params: { objectId: "obj-123" },
    } as never)) as { ok: boolean; buildStatus?: string };

    expect(res.ok).toBe(true);
    expect(res.buildStatus).toBe("completed");
    expect(vi.mocked(githubHeaders)).toHaveBeenCalledWith("resolved-token");
    expect(vi.mocked(getJobSteps)).toHaveBeenCalledWith(
      "resolved-token",
      "owner",
      "repo",
      900,
    );
  });

  it("dispatch-iiif (collaborator): dispatchWorkflow runs on resolveProjectToken's token, not the collaborator's own", async () => {
    asRole("collaborator");
    const { resolveProjectToken } = await import("~/lib/github-app.server");
    vi.mocked(resolveProjectToken).mockResolvedValueOnce("resolved-token");
    const { dispatchWorkflow } = await import("~/lib/commit.server");
    vi.mocked(dispatchWorkflow).mockResolvedValue({
      runId: 5,
      runUrl: "https://api.github.com/repos/owner/repo/actions/runs/5",
      htmlUrl: "https://gh/run/5",
    });

    const { context } = buildContext(CALLER_ID);
    const res = (await action({
      request: buildRequest("dispatch-iiif", { siteId: "42" }),
      context,
      params: { objectId: "obj-123" },
    } as never)) as { ok: boolean; runId?: number | null };

    expect(res.ok).toBe(true);
    expect(res.runId).toBe(5);
    expect(vi.mocked(dispatchWorkflow)).toHaveBeenCalledWith(
      "resolved-token",
      "owner",
      "repo",
      "build.yml",
    );
  });
});
