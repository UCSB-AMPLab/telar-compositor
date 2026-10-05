/**
 * The dashboard's full sync and orphan restore refuse a sheet in which two or
 * more colliding columns each hold values, and return the refusal as its own
 * error, carrying the sheet and the columns for the sync screen to name. Nothing
 * is written: no D1 row, no document ingest, no activity entry.
 *
 * The sync and the parse run for real; GitHub, D1 and the collaboration DO are
 * faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => {
  const writes: string[] = [];
  const chain = (): unknown => {
    const node = Promise.resolve([]) as unknown as Promise<unknown[]> & Record<string, unknown>;
    for (const m of ["from", "where", "limit", "orderBy", "set", "values", "returning", "innerJoin", "leftJoin", "groupBy"]) {
      node[m] = () => chain();
    }
    return node;
  };
  const handle = {
    select: () => chain(),
    update: () => {
      writes.push("update");
      return chain();
    },
    insert: () => {
      writes.push("insert");
      return chain();
    },
    delete: () => {
      writes.push("delete");
      return chain();
    },
  };
  return { writes, handle };
});

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => db.handle) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", async () => {
  const { strictReadsFromFileContent } = await import("./helpers/strict-sheet-read");
  const getFileContent = vi.fn(async () => null);
  return {
    getRepoHead: vi.fn(async () => "head-sha"),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileContent,
    // objects.csv is read strictly at the sync's head, from the files the case
    // serves; the base reads find nothing.
    getFileAtRef: vi.fn(strictReadsFromFileContent(getFileContent, async () => ({ status: "absent" }))),
    // The column picker lists the spreadsheets directory to offer
    // the groups; listing none, it finds no group, and the refusal stands, as
    // it does wherever the repair does not see the parse's group.
    listDirectoryEntries: vi.fn(async () => []),
    searchGitHubUsers: vi.fn(async () => []),
    githubHeaders: vi.fn(() => ({})),
  };
});
vi.mock("~/lib/membership.server", () => ({
  getUserProjects: vi.fn(async () => []),
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 1, github_repo_full_name: "owner/repo", head_sha: null, onboarding_completed: 1 },
    userRole: "convenor",
  })),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));
vi.mock("~/lib/import.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/import.server")>("~/lib/import.server");
  return { ...actual, scanRepoOrphanStoryIds: vi.fn(async () => ["story-one"]) };
});
vi.mock("~/lib/commit.server", () => ({ commitFilesToRepo: vi.fn(async () => undefined) }));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => undefined) }));

import { action } from "~/routes/_app.dashboard";
import { getFileContent } from "~/lib/github.server";
import { recordActivity } from "~/lib/activity.server";

const SHEETS = "telar-content/spreadsheets";

function serveRepo(files: Record<string, string>) {
  vi.mocked(getFileContent).mockImplementation(
    async (_t: string, _o: string, _r: string, path: string) => files[path] ?? null,
  );
}

function buildRequest(fields: Record<string, string>): Request {
  // siteId matches the mocked resolveActiveProject's project id (1), which
  // resolvePageProject's page-site gate compares it against.
  return new Request("https://compositor.telar.org/dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ siteId: "1", ...fields }).toString(),
  });
}

/** The context, with a DO binding that records the paths it is sent. */
function buildContext() {
  const doPaths: string[] = [];
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    DB: {},
    COLLABORATION: {
      idFromName: vi.fn(() => "do-id"),
      get: vi.fn(() => ({
        fetch: vi.fn(async (req: Request) => {
          doPaths.push(new URL(req.url).pathname);
          return new Response(JSON.stringify({ restored: 0, applied: {}, skipped: {} }), { status: 200 });
        }),
      })),
    },
  };
  const context = {
    get: vi.fn(() => ({ id: 7, encrypted_access_token: "enc-token" })),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
  return { context, doPaths };
}

const REFUSED_OBJECTS = {
  ok: false,
  error: "colliding_columns",
  collidingColumns: { sheet: "objects.csv", canonicalName: "medium_genre", headers: ["medium", "object_type"] },
};

const NO_CHANGES = {
  objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
  stories: { accept: [], reject: [], insertNew: [] },
  config: { accept: [], reject: [] },
  glossary: { accept: [], reject: [], insertNew: [] },
  // The check's identity, as a current page sends it: this project, no head recorded.
  projectId: 1,
  baseSha: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.writes.length = 0;
  serveRepo({ [`${SHEETS}/objects.csv`]: "object_id,title,medium,object_type\nobj-001,First,Oil,Painting\n" });
});

describe("dashboard full sync refuses a sheet whose colliding columns both hold values", () => {
  it("compute-full-sync-diff returns the refusal, naming the sheet and columns", async () => {
    const { context } = buildContext();
    const result = await action({
      request: buildRequest({ intent: "compute-full-sync-diff" }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({ ...REFUSED_OBJECTS, intent: "compute-full-sync-diff" });
    expect(db.writes).toEqual([]);
  });

  it("apply-full-sync returns the refusal and writes nothing", async () => {
    const { context, doPaths } = buildContext();
    const result = await action({
      request: buildRequest({ intent: "apply-full-sync", changes: JSON.stringify(NO_CHANGES) }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({ ...REFUSED_OBJECTS, intent: "apply-full-sync" });
    expect(db.writes).toEqual([]);
    expect(doPaths).not.toContain("/ingest-sync");
    expect(vi.mocked(recordActivity)).not.toHaveBeenCalled();
  });

  it("apply-full-sync still reports any other failure by its message", async () => {
    vi.mocked(getFileContent).mockRejectedValue(new Error("GitHub is down"));
    const { context } = buildContext();
    const result = await action({
      request: buildRequest({ intent: "apply-full-sync", changes: JSON.stringify(NO_CHANGES) }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({ ok: false, intent: "apply-full-sync", error: "apply_failed", message: "GitHub is down" });
  });
});

describe("dashboard orphan restore refuses a story sheet whose colliding columns both hold values", () => {
  it("returns the refusal and sends nothing to the document", async () => {
    serveRepo({
      [`${SHEETS}/story-one.csv`]:
        "step,object,x,y,zoom,question,pregunta,answer\n1,obj-001,0.5,0.5,1,What?,¿Qué?,An answer\n",
    });
    const { context, doPaths } = buildContext();
    const result = await action({
      request: buildRequest({ intent: "restore-orphan-drafts" }),
      context,
      params: {},
    } as never);
    expect(result).toEqual({
      ok: false,
      intent: "restore-orphan-drafts",
      error: "colliding_columns",
      collidingColumns: { sheet: "story-one.csv", canonicalName: "question", headers: ["question", "pregunta"] },
      // No file was read before the refused one, so no warning was raised.
      warnings: [],
    });
    expect(doPaths).not.toContain("/restore-orphans");
    expect(db.writes).toEqual([]);
  });
});
