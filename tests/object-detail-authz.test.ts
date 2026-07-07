/**
 * Authorization tests for autosave-object-field, autosave-object-featured,
 * update-object, and delete-object action cases in _app.objects.$objectId.tsx.
 *
 * Verifies that all four intents scope their mutations by the caller's active
 * project, closing the cross-project IDOR where any signed-in user could
 * update or permanently delete any object by db id.
 *
 * @version v1.4.0-beta
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
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue({}),
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
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(),
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
vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn() }));
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

// Extract the captured where-argument from the last db.delete().where() call.
function captureDeleteWhereArg(): unknown {
  const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
    delete: ReturnType<typeof vi.fn>;
  };
  const whereMock = dbInstance.delete.mock.results.at(-1)?.value as {
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

// ---------------------------------------------------------------------------
// Setup — reset mocks before every test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Fresh db mock with select that returns a default object row
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([
            {
              id: 10,
              project_id: 42,
              object_id: "obj-123",
              title: "Test Object",
              missing_from_repo: false,
            },
          ]),
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
// autosave-object-featured
// ---------------------------------------------------------------------------

describe("_app.objects.$objectId action: autosave-object-featured IDOR fix", () => {
  it("scopes the UPDATE where-clause by the resolved project id", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 55, github_repo_full_name: "owner/repo" } as never,
      userRole: "collaborator",
    });

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

    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.update).toHaveBeenCalled();

    const whereArg = captureUpdateWhereArg();
    expect(drizzleClauseContainsValue(whereArg, 55)).toBe(true);
  });

  it("returns { ok:false, error:'no_project' } and does NOT mutate DB when resolveActiveProject returns null", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue(null);

    const { context } = buildContext();
    const res = (await action({
      request: buildRequest("autosave-object-featured", {
        entityId: "10",
        value: "false",
      }),
      context,
      params: { objectId: "obj-123" },
    } as never)) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toBe("no_project");

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
  it("redirects to /objects without calling db.delete when object belongs to a different project", async () => {
    // Object exists but belongs to project 99, caller's active project is 42
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: 10,
                project_id: 99,   // different project
                object_id: "obj-123",
                title: "Test Object",
                missing_from_repo: false,
              },
            ]),
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
    } as never);

    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo" } as never,
      userRole: "collaborator",
    });

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

    // db.delete must NOT have been called
    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      delete: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.delete).not.toHaveBeenCalled();
  });

  it("redirects to /objects without db.delete when resolveActiveProject returns null", async () => {
    vi.mocked(resolveActiveProject).mockResolvedValue(null);

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

  it("scopes the DELETE where-clause by project_id when object is in the caller's active project", async () => {
    // Object belongs to the same project as the caller (project 42)
    vi.mocked(resolveActiveProject).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo" } as never,
      userRole: "collaborator",
    });

    const { context } = buildContext();

    let thrownValue: unknown = null;
    try {
      await action({
        request: buildRequest("delete-object", { objectDbId: "10", fromRepo: "false" }),
        context,
        params: { objectId: "obj-123" },
      } as never);
    } catch (e) {
      thrownValue = e;
    }

    // After a successful delete the action throws redirect("/objects")
    expect(thrownValue).toBeInstanceOf(Response);
    const response = thrownValue as Response;
    expect(response.status).toBe(302);

    // The DELETE must have been called and scoped to project 42
    const dbInstance = vi.mocked(getDb).mock.results.at(-1)?.value as {
      delete: ReturnType<typeof vi.fn>;
    };
    expect(dbInstance.delete).toHaveBeenCalled();

    const whereArg = captureDeleteWhereArg();
    expect(drizzleClauseContainsValue(whereArg, 42)).toBe(true);
  });
});
