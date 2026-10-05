/**
 * The object page's `rename-object` action: an object's ID change
 * from the checks to the build.
 *
 * The action refuses before any read when the caller may not rename, the
 * object is a course item, the new ID breaks the upload's rule or is the old
 * one, or the site is behind its release. Under the objects lease it reads at
 * one head, finishes earlier operations, and checks the new ID against D1's
 * rows, the sheet's and the objects folder. The page posts the ID it showed,
 * and a rename whose object holds another by then refuses. On a site under
 * 1.8.0 a new ID its sheet reader would lose refuses, and a site whose reads
 * would pass the Worker's subrequest limit refuses before its first story read. A row in objects.csv means one
 * commit fenced to the head, under a `rename` record written prepared before
 * it, with the tile cache listed before the commit and cleared after it, then
 * the build dispatched; no row means a rename in the document alone, under a
 * record written committed. A site reading Google Sheets is renamed only with
 * Sheets switched off in the same commit.
 *
 * The form posts what the dialog said about the steps, worked out from D1's
 * rows as the page's loader works it out (`pageFacts`). Facts that differ
 * once objects.csv at the head is read stop the rename with nothing written,
 * and the answer carries the facts the head gives.
 *
 * D1 is the repository's migration chain in memory. GitHub is stood in for at
 * the module boundary: the reads by path, the fenced commit, the tile cache
 * and the dispatch. The collaboration object is a stand-in whose ingest
 * renames the row and its steps, which is what the real arm's flush does.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const OBJECT_DB_ID = 10;
const OLD_ID = "plano";
const NEW_ID = "plano-nuevo";
const CONVENOR = 7;
const COLLABORATOR = 8;
const HEAD = "captured-head";
const COMMITTED = "rename-commit";
const SITE = "https://example.org/sitio";

const events: string[] = [];
let memory: MemoryD1;
let files: Map<string, string>;
/** Paths whose strict read decodes lossily. */
const lossyPaths = new Set<string>();
let tree: Array<{ path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number }>;
let ingestAnswer: (body: Record<string, unknown>) => Response;
const ingestBodies: Array<Record<string, unknown>> = [];

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: () => drizzle(asD1(memory), { schema }) }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/upgrade-gate.server", () => ({ readRepoWriteRefusal: vi.fn(async () => null) }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "installation-token"),
  resolveProjectToken: vi.fn(async () => "installation-token"),
  getInstallationInfo: vi.fn(),
}));
vi.mock("~/lib/github.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/github.server")>()),
  getRepoHead: vi.fn(async () => HEAD),
  getRepoTree: vi.fn(async () => ({ tree, truncated: false })),
  getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) => {
    events.push(`read:${path}`);
    const content = files.get(path);
    if (content === undefined) return { status: "absent" };
    return lossyPaths.has(path) ? { status: "ok", content, lossy: true } : { status: "ok", content };
  }),
}));
vi.mock("~/lib/commit.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/commit.server")>()),
  dispatchWorkflow: vi.fn(async () => {
    events.push("dispatch");
    return { runId: 77, htmlUrl: "https://github.com/run/77" };
  }),
}));
vi.mock("~/lib/git-tree-commit.server", () => ({ commitTreeOnHead: vi.fn() }));
vi.mock("~/lib/tile-cache.server", () => ({
  listTileCacheEntries: vi.fn(async () => {
    events.push("cache:list");
    return { ok: true, ids: [1] };
  }),
  clearTileCacheEntries: vi.fn(async () => {
    events.push("cache:clear");
    return { listed: true, deleted: [1], failed: [] };
  }),
}));
vi.mock("~/lib/config-repair.server", () => ({
  repairSiteConfig: vi.fn(async () => {
    events.push("config:repair");
    return "applied";
  }),
}));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

// Client-side deps the route module pulls in but these action cases never run.
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
import { StaleHeadError } from "~/lib/commit.server";
import { commitTreeOnHead, type TreeCommitRequest } from "~/lib/git-tree-commit.server";
import { listTileCacheEntries } from "~/lib/tile-cache.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { repairSiteConfig } from "~/lib/config-repair.server";
import { readRepoWriteRefusal } from "~/lib/upgrade-gate.server";
import { objectRenameFacts, renameFactsFingerprint, type ObjectRenameFacts } from "~/lib/object-rename-id";

type Row = { id: number; kind: string; state: string; payload: string; parent_sha: string | null; commit_sha: string | null };

function renameRecords(): Row[] {
  return memory.raw.prepare("SELECT * FROM pending_object_ops ORDER BY id").all() as Row[];
}

function d1ObjectIdOf(id: number): string | undefined {
  return (memory.raw.prepare("SELECT object_id FROM objects WHERE id = ?").get(id) as { object_id: string } | undefined)?.object_id;
}

function heads(): { head_sha: string | null; objects_read_sha: string | null } {
  return memory.raw.prepare("SELECT head_sha, objects_read_sha FROM projects WHERE id = ?").get(PROJECT_ID) as {
    head_sha: string | null;
    objects_read_sha: string | null;
  };
}

/**
 * The collaboration object: an ingest renames the row and every step naming a
 * step value, as the arm's flush does, only while the row holds the entry's
 * old id; a row holding another is superseded, as the arm classes it.
 */
function renamingIngest(body: Record<string, unknown>): Response {
  const entries = (body.objects as { rename: Array<{ from: string; to: string; docId: number; stepValues: string[] }> }).rename;
  const renames = { applied: [] as string[], alreadyApplied: [] as string[], superseded: [] as string[], absent: [], course: [], displaced: [] };
  for (const entry of entries) {
    const key = d1ObjectIdOf(entry.docId);
    if (key !== entry.from) {
      (key === entry.to ? renames.alreadyApplied : renames.superseded).push(entry.to);
      continue;
    }
    memory.raw.prepare("UPDATE objects SET object_id = ? WHERE id = ?").run(entry.to, entry.docId);
    for (const value of entry.stepValues) {
      memory.raw.prepare("UPDATE steps SET object_id = ? WHERE object_id = ?").run(entry.to, value);
    }
    renames.applied.push(entry.to);
  }
  return Response.json({ renames });
}

function renameActionContext(userId = CONVENOR) {
  const stub = {
    fetch: async (req: Request) => {
      const body = JSON.parse(await req.text()) as Record<string, unknown>;
      if (!(body.objects as Record<string, unknown> | undefined)?.rename) {
        return Response.json({});
      }
      ingestBodies.push(body);
      events.push(`ingest:${renameRecords().map((r) => r.state).join(",")}`);
      return ingestAnswer(body);
    },
  };
  return {
    get: vi.fn(() => ({ id: userId, encrypted_access_token: "enc" })),
    cloudflare: {
      env: {
        ENCRYPTION_KEY: "k",
        SESSION_SECRET: "s",
        DB: {},
        GITHUB_APP_ID: "a",
        GITHUB_PRIVATE_KEY: "p",
        COLLABORATION: { idFromName: (n: string) => n, get: () => stub },
      },
    },
  } as never;
}

/** The facts the page's loader shows for the object: D1's rows in sheet order as both orders, and every step's value. */
function pageFacts(): ObjectRenameFacts {
  const rows = memory.raw
    .prepare("SELECT object_id FROM objects WHERE project_id = ? ORDER BY order_key ASC, id ASC")
    .all(PROJECT_ID) as Array<{ object_id: string }>;
  const stepValues = (memory.raw.prepare("SELECT object_id FROM steps").all() as Array<{ object_id: string | null }>).map(
    (row) => row.object_id,
  );
  const object = { object_id: d1ObjectIdOf(OBJECT_DB_ID) ?? OLD_ID };
  return objectRenameFacts(object, { sheet: rows, d1: rows, version: null }, stepValues);
}

async function renameObject(
  newId = NEW_ID,
  options: { userId?: number; disableSheets?: boolean; shownObjectId?: string; confirmedFacts?: string } = {},
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams({
    intent: "rename-object",
    objectDbId: String(OBJECT_DB_ID),
    shownObjectId: options.shownObjectId ?? OLD_ID,
    newId,
    disableSheets: String(options.disableSheets ?? false),
    confirmedFacts: options.confirmedFacts ?? renameFactsFingerprint(pageFacts(), newId),
  });
  return (await action({
    request: new Request(`https://compositor.telar.org/objects/${OLD_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: renameActionContext(options.userId),
    params: { objectId: OLD_ID },
  } as never)) as Record<string, unknown>;
}

function treeBlob(path: string, sha = `sha-${path}`, size?: number) {
  return { path, mode: "100644", type: "blob" as const, sha, ...(size === undefined ? {} : { size }) };
}

/** The one commit request sent. */
function sentRenameCommit(): TreeCommitRequest {
  expect(commitTreeOnHead).toHaveBeenCalledTimes(1);
  return vi.mocked(commitTreeOnHead).mock.calls[0][0];
}

function committedTextOf(request: TreeCommitRequest, path: string): string | undefined {
  return request.texts.find((t) => t.path === path)?.content;
}

const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const STORY_CSV = "telar-content/spreadsheets/historia.csv";
const LAYER_MD = "telar-content/texts/stories/historia/capa.md";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  events.length = 0;
  ingestBodies.length = 0;
  lossyPaths.clear();
  ingestAnswer = renamingIngest;
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) VALUES " +
      `(${CONVENOR}, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01'), (${COLLABORATOR}, 8, 'c', 'e', 'e', '2099-01-01', '2099-01-01')`,
  );
  memory.raw.exec(
    `INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, head_sha, objects_read_sha) VALUES (${PROJECT_ID}, ${CONVENOR}, 'owner/repo', 5, '${HEAD}', '${HEAD}')`,
  );
  memory.raw.exec(`INSERT INTO project_config (project_id, url, baseurl) VALUES (${PROJECT_ID}, 'https://example.org', '/sitio')`);
  memory.raw.exec(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (${PROJECT_ID}, ${CONVENOR}, 'convenor'), (${PROJECT_ID}, ${COLLABORATOR}, 'collaborator')`,
  );
  memory.raw.exec(
    `INSERT INTO objects (id, project_id, object_id, order_key, title, created_by) VALUES (${OBJECT_DB_ID}, ${PROJECT_ID}, '${OLD_ID}', 'a00001', 'Plano', ${CONVENOR}), (11, ${PROJECT_ID}, 'otro', 'a00002', 'Otro', ${CONVENOR})`,
  );
  memory.raw.exec(`INSERT INTO stories (id, project_id, story_id, title) VALUES (1, ${PROJECT_ID}, 'historia', 'Historia')`);
  memory.raw.exec(
    `INSERT INTO steps (id, story_id, step_number, order_key, object_id) VALUES (1, 1, 1, 'a00001', '${OLD_ID}'), (2, 1, 2, 'a00002', 'otro')`,
  );

  files = new Map([
    [OBJECTS_CSV, "object_id,title,thumbnail\nplano,Plano,telar-content/objects/plano.jpg\notro,Otro,\n"],
    [STORY_CSV, "step,object,layer1_content\n1,plano,![m](plano.jpg)\n2,otro,Texto\n"],
    [LAYER_MD, `Antes ![m](plano.jpg) y ![t](${SITE}/iiif/objects/plano/full/max/0/default.jpg)\n`],
  ]);
  tree = [
    treeBlob(OBJECTS_CSV),
    treeBlob(STORY_CSV),
    treeBlob(LAYER_MD),
    treeBlob("telar-content/objects/plano.jpg", "image-sha"),
    treeBlob("telar-content/objects/otro.jpg"),
  ];

  vi.mocked(controlFreezeLease).mockImplementation(async (_e, _p, _u, control) => {
    events.push(control.op === "begin" ? `lease:begin:${control.kind}` : `lease:end:${(control as { outcome?: string }).outcome}`);
    return "applied";
  });
  vi.mocked(commitTreeOnHead).mockImplementation(async () => {
    events.push(`commit:${renameRecords().map((r) => r.state).join(",")}`);
    return { commitSha: COMMITTED };
  });
});

afterEach(() => {
  memory.close();
});

describe("a rename with a row in objects.csv", () => {
  it("moves the files by SHA and rewrites the sheets and text in one commit fenced to the head", async () => {
    const res = await renameObject();
    expect(res).toMatchObject({ ok: true, intent: "rename-object", newId: NEW_ID, pending: false, committed: true, dispatchRunId: 77 });

    const request = sentRenameCommit();
    expect(request).toMatchObject({ parentSha: HEAD, branch: "main", message: `Rename ${OLD_ID} to ${NEW_ID} via Telar Compositor [skip ci]` });
    expect(request.placements).toEqual([{ path: `telar-content/objects/${NEW_ID}.jpg`, sha: "image-sha", mode: "100644" }]);
    expect(request.deletions).toEqual([{ path: "telar-content/objects/plano.jpg", mode: "100644" }]);
    expect(committedTextOf(request, OBJECTS_CSV)).toBe(
      `object_id,title,thumbnail\n${NEW_ID},Plano,telar-content/objects/${NEW_ID}.jpg\notro,Otro,\n`,
    );
    expect(committedTextOf(request, STORY_CSV)).toBe(`step,object,layer1_content\n1,${NEW_ID},![m](${NEW_ID}.jpg)\n2,otro,Texto\n`);
    expect(committedTextOf(request, LAYER_MD)).toBe(
      `Antes ![m](${NEW_ID}.jpg) y ![t](${SITE}/iiif/objects/${NEW_ID}/full/max/0/default.jpg)\n`,
    );
  });

  it("renames the row in objetos.csv, and the glossary's definitions in glosario.csv, of a Spanish-only site", async () => {
    const OBJETOS_CSV = "telar-content/spreadsheets/objetos.csv";
    const GLOSARIO_CSV = "telar-content/spreadsheets/glosario.csv";
    files.set(OBJETOS_CSV, files.get(OBJECTS_CSV) as string);
    files.delete(OBJECTS_CSV);
    files.set(GLOSARIO_CSV, "term_id,title,definition\ntelar,Telar,![m](plano.jpg)\n");
    tree = [...tree.filter((entry) => entry.path !== OBJECTS_CSV), treeBlob(OBJETOS_CSV), treeBlob(GLOSARIO_CSV)];

    const res = await renameObject();
    expect(res).toMatchObject({ ok: true, intent: "rename-object", newId: NEW_ID, committed: true });

    const request = sentRenameCommit();
    expect(committedTextOf(request, OBJETOS_CSV)).toBe(
      `object_id,title,thumbnail\n${NEW_ID},Plano,telar-content/objects/${NEW_ID}.jpg\notro,Otro,\n`,
    );
    expect(committedTextOf(request, OBJECTS_CSV)).toBeUndefined();
    expect(committedTextOf(request, GLOSARIO_CSV)).toBe(`term_id,title,definition\ntelar,Telar,![m](${NEW_ID}.jpg)\n`);
  });

  it("writes the record prepared before the commit, sends the arm with its id, and deletes it once the arm has run", async () => {
    await renameObject();
    expect(events).toContain("commit:prepared");
    expect(events).toContain("ingest:committed");
    expect(ingestBodies).toEqual([
      {
        opId: expect.any(Number),
        objects: {
          rename: [
            expect.objectContaining({ from: OLD_ID, to: NEW_ID, docId: OBJECT_DB_ID, stepValues: [OLD_ID] }),
          ],
        },
      },
    ]);
    expect(renameRecords()).toEqual([]);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(NEW_ID);
  });

  it("lists the tile cache before the commit, clears it after, then dispatches the build, all under the lease but the last two", async () => {
    await renameObject();
    const order = events.filter((e) => /^(lease|cache|commit|ingest|dispatch)/.test(e));
    expect(order).toEqual([
      "lease:begin:objects",
      "cache:list",
      "commit:prepared",
      "ingest:committed",
      "lease:end:succeeded",
      "cache:clear",
      "dispatch",
    ]);
  });

  it("refuses with nothing committed when the tile cache cannot be listed", async () => {
    vi.mocked(listTileCacheEntries).mockResolvedValueOnce({ ok: false, status: 403 });
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_cache_unreachable" });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(renameRecords()).toEqual([]);
    expect(events).not.toContain("dispatch");
  });

  it("refuses a listing that ran past its page cap, as not complete", async () => {
    vi.mocked(listTileCacheEntries).mockResolvedValueOnce({ ok: false, status: 200, truncated: true, ids: [1] });
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_cache_unreachable" });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
  });

  it("answers rename_stale_head and deletes its record when the head moved", async () => {
    vi.mocked(commitTreeOnHead).mockImplementationOnce(async () => {
      events.push(`commit:${renameRecords().map((r) => r.state).join(",")}`);
      throw new StaleHeadError("moved");
    });
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, intent: "rename-object", error: "rename_stale_head" });
    expect(events).toContain("commit:prepared");
    expect(renameRecords()).toEqual([]);
    expect(ingestBodies).toEqual([]);
    expect(events).not.toContain("cache:clear");
    expect(events).not.toContain("dispatch");
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(OLD_ID);
  });

  it("answers rename_failed and keeps the record prepared when the commit's fate is unknown", async () => {
    vi.mocked(commitTreeOnHead).mockRejectedValueOnce(new Error("socket hang up"));
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_failed" });
    expect(renameRecords()).toEqual([expect.objectContaining({ kind: "rename", state: "prepared", parent_sha: HEAD })]);
    expect(events).not.toContain("dispatch");
  });

  it("answers ok and pending when the arm fails after the commit landed, keeping the record committed", async () => {
    ingestAnswer = () => new Response("snapshot_failed", { status: 503 });
    const res = await renameObject();
    expect(res).toMatchObject({ ok: true, pending: true, committed: true });
    expect(renameRecords()).toEqual([expect.objectContaining({ kind: "rename", state: "committed", commit_sha: COMMITTED })]);
    expect(events).toContain("dispatch");
  });

  it("refuses a file in the way of a move, with nothing committed", async () => {
    tree.push(treeBlob(`telar-content/objects/${NEW_ID}.JPG`));
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_file_exists", params: { file: `${NEW_ID}.JPG` } });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
  });

  it("refuses a story CSV that cannot be read, with nothing committed", async () => {
    files.delete(STORY_CSV);
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_failed" });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
  });
});

describe("a rename inside a collision", () => {
  beforeEach(() => {
    files.set(OBJECTS_CSV, "object_id,title\nplano,Plano\nplano.jpg,Plano imagen\n");
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key) VALUES (12, ${PROJECT_ID}, 'plano.jpg', 'a00003')`);
    files.set(STORY_CSV, "step,object,layer1_content\n1,plano,![m](plano.jpg)\n2,plano.jpg,Texto\n");
  });

  it("copies the shared image, rewrites only the steps written exactly as the old ID, and leaves the text", async () => {
    const res = await renameObject();
    expect(res).toMatchObject({ ok: true, committed: true });
    const request = sentRenameCommit();
    expect(request.placements).toEqual([{ path: `telar-content/objects/${NEW_ID}.jpg`, sha: "image-sha", mode: "100644" }]);
    expect(request.deletions).toEqual([]);
    expect(committedTextOf(request, STORY_CSV)).toBe(`step,object,layer1_content\n1,${NEW_ID},![m](plano.jpg)\n2,plano.jpg,Texto\n`);
    expect(committedTextOf(request, LAYER_MD)).toBeUndefined();
    expect(ingestBodies[0]).toMatchObject({
      objects: { rename: [expect.objectContaining({ stepValues: [OLD_ID], rules: expect.objectContaining({ moved: [], tiles: null }) })] },
    });
  });
});

describe("a text file that does not decode cleanly", () => {
  it("refuses the rename with nothing committed, as rewriting it would lose what the decode replaced", async () => {
    lossyPaths.add(LAYER_MD);
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_failed" });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(renameRecords()).toEqual([]);
  });
});

describe("an object that is gone", () => {
  it("sends the page back to the objects grid", async () => {
    memory.raw.prepare("DELETE FROM steps").run();
    memory.raw.prepare("DELETE FROM objects WHERE id = ?").run(OBJECT_DB_ID);
    const thrown = await renameObject().catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/objects");
  });
});

describe("head bookkeeping", () => {
  it("advances the head and objects_read_sha when both stood at the parent", async () => {
    await renameObject();
    expect(heads()).toEqual({ head_sha: COMMITTED, objects_read_sha: COMMITTED });
  });

  it("advances objects_read_sha alone when only it stood at the parent", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = 'elsewhere' WHERE id = ?").run(PROJECT_ID);
    await renameObject();
    expect(heads()).toEqual({ head_sha: "elsewhere", objects_read_sha: COMMITTED });
  });

  it("advances neither when neither stood at the parent", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = 'elsewhere', objects_read_sha = 'older' WHERE id = ?").run(PROJECT_ID);
    await renameObject();
    expect(heads()).toEqual({ head_sha: "elsewhere", objects_read_sha: "older" });
  });
});

describe("a site that reads Google Sheets", () => {
  const SHEETS_ON = "title: Sitio\ngoogle_sheets:\n  enabled: true\n  published_url: \"https://docs.google.com/x\"\n";

  it("refuses without the author's agreement to switch Sheets off, with nothing committed", async () => {
    files.set("_config.yml", SHEETS_ON);
    tree.push(treeBlob("_config.yml"));
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_sheets_on" });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(renameRecords()).toEqual([]);
  });

  it("switches Sheets off in the same commit, and in the document after it", async () => {
    files.set("_config.yml", SHEETS_ON);
    tree.push(treeBlob("_config.yml"));
    const res = await renameObject(NEW_ID, { disableSheets: true });
    expect(res).toMatchObject({ ok: true, committed: true });
    expect(committedTextOf(sentRenameCommit(), "_config.yml")).toContain("enabled: false");
    expect(repairSiteConfig).toHaveBeenCalledWith(expect.anything(), expect.anything(), PROJECT_ID, { google_sheets_enabled: false });
  });
});

describe("a rename with no row in objects.csv", () => {
  beforeEach(() => {
    files.set(OBJECTS_CSV, "object_id,title\notro,Otro\n");
    tree = tree.filter((entry) => entry.path !== "telar-content/objects/plano.jpg");
  });

  it("runs in the document alone under a committed record: no commit, no cache, no build", async () => {
    let seen: Row[] = [];
    ingestAnswer = (body) => {
      seen = renameRecords();
      return renamingIngest(body);
    };
    const res = await renameObject();
    expect(res).toMatchObject({ ok: true, pending: false, committed: false, dispatchRunId: null });
    expect(seen).toEqual([expect.objectContaining({ kind: "rename", state: "committed", parent_sha: null })]);
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(events.filter((e) => e.startsWith("cache") || e === "dispatch")).toEqual([]);
    expect(renameRecords()).toEqual([]);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(NEW_ID);
  });

  it("refuses with rename_unregistered_files when the repository has files under the old ID", async () => {
    tree.push(treeBlob("telar-content/objects/plano.png"));
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_unregistered_files" });
    expect(renameRecords()).toEqual([]);
    expect(ingestBodies).toEqual([]);
  });
});

describe("refusals before anything is read", () => {
  it("refuses a collaborator who did not create the object", async () => {
    const res = await renameObject(NEW_ID, { userId: COLLABORATOR });
    expect(res).toMatchObject({ ok: false, error: "forbidden" });
    expect(events).toEqual([]);
  });

  it("admits a collaborator who created the object", async () => {
    memory.raw.prepare("UPDATE objects SET created_by = ? WHERE id = ?").run(COLLABORATOR, OBJECT_DB_ID);
    const res = await renameObject(NEW_ID, { userId: COLLABORATOR });
    expect(res).toMatchObject({ ok: true });
  });

  it("refuses a course item, the convenor included", async () => {
    memory.raw.prepare("UPDATE objects SET course_project_id = ? WHERE id = ?").run(PROJECT_ID, OBJECT_DB_ID);
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "course_item_rename_refused" });
    expect(events).toEqual([]);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(OLD_ID);
  });

  it.each(["map.jpg", "Map", "-map", "map-", ""])("refuses %j by the upload's rule", async (value) => {
    const res = await renameObject(value);
    expect(res).toMatchObject({ ok: false, error: "invalid_id" });
    expect(events).toEqual([]);
  });

  it("refuses the old ID itself", async () => {
    const res = await renameObject(OLD_ID);
    expect(res).toMatchObject({ ok: false, error: "rename_unchanged" });
  });

  it("refuses a site behind its release", async () => {
    vi.mocked(readRepoWriteRefusal).mockResolvedValueOnce("upgrade_required");
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "upgrade_required" });
    expect(events).toEqual([]);
  });

  it("refuses while another operation holds the objects lease, reading nothing", async () => {
    vi.mocked(controlFreezeLease).mockResolvedValueOnce("refused");
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_operation_in_progress" });
    expect(events.filter((e) => e.startsWith("read:"))).toEqual([]);
    expect(commitTreeOnHead).not.toHaveBeenCalled();
  });
});

describe("the new ID is the object's alone", () => {
  it("refuses an ID another row carries", async () => {
    const res = await renameObject("otro");
    expect(res).toMatchObject({ ok: false, error: "rename_taken", params: { id: "otro" } });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
  });

  it("refuses an ID another sheet row's site ID is", async () => {
    files.set(OBJECTS_CSV, "object_id,title\nplano,Plano\nmapa.jpg,Mapa\n");
    const res = await renameObject("mapa");
    expect(res).toMatchObject({ ok: false, error: "rename_site_taken", params: { id: "mapa", other: "mapa.jpg" } });
  });

  it("refuses an ID another D1 row carries in another letter case", async () => {
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key) VALUES (12, ${PROJECT_ID}, 'Mapa', 'a00003')`);
    const res = await renameObject("mapa");
    expect(res).toMatchObject({ ok: false, error: "rename_site_taken", params: { id: "mapa", other: "Mapa" } });
  });

  it.each([["mapa.png"], ["MAPA.PNG"], ["mapa/001.jpg"]])("refuses an objects file %s under the new ID", async (name) => {
    tree.push(treeBlob(`telar-content/objects/${name}`));
    const res = await renameObject("mapa");
    expect(res).toMatchObject({ ok: false, error: "rename_file_exists", params: { file: name } });
  });
});

describe("a new ID the site's sheet reader would lose", () => {
  it.each(["nan", "null", "2024", "0", "1e3", "1e-3", "true", "false", "inf", "infinity"])("refuses %j on a site under 1.8.0, with nothing read past the head's first files", async (value) => {
    memory.raw.prepare("UPDATE project_config SET telar_version = '1.7.0' WHERE project_id = ?").run(PROJECT_ID);
    const res = await renameObject(value);
    expect(res).toMatchObject({ ok: false, error: "rename_id_unreadable", params: { id: value } });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(renameRecords()).toEqual([]);
    expect(events).not.toContain(`read:${STORY_CSV}`);
  });

  it("refuses it on a site whose version is unknown, read as 1.7.0", async () => {
    memory.raw.prepare("UPDATE project_config SET telar_version = NULL WHERE project_id = ?").run(PROJECT_ID);
    const res = await renameObject("2024");
    expect(res).toMatchObject({ ok: false, error: "rename_id_unreadable" });
  });

  it.each(["nan", "2024", "1e3", "true", "false", "inf"])("admits %j on a 1.8.0 site, which reads the column as text", async (value) => {
    memory.raw.prepare("UPDATE project_config SET telar_version = '1.8.0' WHERE project_id = ?").run(PROJECT_ID);
    const res = await renameObject(value);
    expect(res).toMatchObject({ ok: true, newId: value, committed: true });
  });

  it.each(["2024-mapa", "1e3-map", "true-north"])("admits %j, text to pandas, on a site under 1.8.0", async (value) => {
    memory.raw.prepare("UPDATE project_config SET telar_version = '1.7.0' WHERE project_id = ?").run(PROJECT_ID);
    const res = await renameObject(value);
    expect(res).toMatchObject({ ok: true, committed: true });
  });
});

describe("a site whose reads would pass the Worker's subrequest limit", () => {
  /**
   * The reads the fixture makes beside the extra story CSVs: the tree, then
   * objects.csv, historia.csv and capa.md (no size in the tree, so two each)
   * and _config.yml (absent, one).
   */
  const FIXTURE_READS = 8;
  const READS_ALLOWED = 9000;

  /** `count` more story CSVs of 100 bytes, each readable and naming another object. */
  function addStories(count: number, sizeOfFirst = 100): void {
    for (let i = 0; i < count; i += 1) {
      const path = `telar-content/spreadsheets/s${i}.csv`;
      tree.push(treeBlob(path, `sha-${path}`, i === 0 ? sizeOfFirst : 100));
      files.set(path, "step,object\n1,otro\n");
    }
  }

  it("refuses with the count before any story is read, with nothing committed", async () => {
    addStories(READS_ALLOWED - FIXTURE_READS + 1);
    const res = await renameObject();
    expect(res).toMatchObject({
      ok: false,
      error: "rename_too_many_files",
      params: { count: String(READS_ALLOWED + 1), limit: String(READS_ALLOWED) },
    });
    expect(events.filter((e) => e.startsWith("read:telar-content/spreadsheets/s"))).toEqual([]);
    expect(events).not.toContain(`read:${STORY_CSV}`);
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(renameRecords()).toEqual([]);
    expect(events).not.toContain("cache:list");
  });

  it("admits a site at the limit exactly", async () => {
    addStories(READS_ALLOWED - FIXTURE_READS);
    const res = await renameObject();
    expect(res).toMatchObject({ ok: true, committed: true });
  });

  it("counts a file of 1 MB or more twice, as its contents read is followed by a raw one", async () => {
    addStories(READS_ALLOWED - FIXTURE_READS, 1_000_000);
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_too_many_files", params: { count: String(READS_ALLOWED + 1) } });
  });

  it("leaves the text files out of the count when the rename can rewrite nothing in them", async () => {
    files.set(OBJECTS_CSV, "object_id,title\nplano,Plano\nplano.jpg,Plano imagen\n");
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key) VALUES (12, ${PROJECT_ID}, 'plano.jpg', 'a00003')`);
    for (let i = 0; i < READS_ALLOWED; i += 1) tree.push(treeBlob(`telar-content/texts/pages/p${i}.md`, `sha-p${i}`, 100));
    const res = await renameObject();
    expect(res).toMatchObject({ ok: true, committed: true });
    expect(events.filter((e) => e.startsWith("read:telar-content/texts/"))).toEqual([]);
  });

  it("counts the text files when the rename can rewrite them", async () => {
    for (let i = 0; i < READS_ALLOWED; i += 1) tree.push(treeBlob(`telar-content/texts/pages/p${i}.md`, `sha-p${i}`, 100));
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_too_many_files" });
    expect(events.filter((e) => e.startsWith("read:telar-content/texts/"))).toEqual([]);
  });
});

describe("a page that showed an ID the object no longer holds", () => {
  it("refuses before the lease when D1 holds another ID, renaming nothing", async () => {
    const res = await renameObject(NEW_ID, { shownObjectId: "plano-viejo" });
    expect(res).toMatchObject({ ok: false, error: "rename_stale_object" });
    expect(events).toEqual([]);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(OLD_ID);
  });

  it("refuses under the lease when finishing an earlier rename changed the ID, committing nothing", async () => {
    const earlier = { from: OLD_ID, to: "plano-b", doc_id: OBJECT_DB_ID, step_values: [OLD_ID], rules: { moved: [], carouselShadowed: [], tiles: null, oldSiteId: OLD_ID } };
    memory.raw
      .prepare("INSERT INTO pending_object_ops (project_id, kind, state, payload, parent_sha, commit_sha, actor_id, created_at) VALUES (?, 'rename', 'committed', ?, NULL, NULL, ?, ?)")
      .run(PROJECT_ID, JSON.stringify([earlier]), CONVENOR, new Date().toISOString());
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_stale_object" });
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe("plano-b");
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(events).not.toContain("cache:list");
  });
});

describe("a retry for an ID an earlier rename already gave the object", () => {
  it("answers rename_unchanged under the lease when finishing that rename gives the object the new ID, committing nothing", async () => {
    const earlier = { from: OLD_ID, to: NEW_ID, doc_id: OBJECT_DB_ID, step_values: [OLD_ID], rules: { moved: [], carouselShadowed: [], tiles: null, oldSiteId: OLD_ID } };
    memory.raw
      .prepare("INSERT INTO pending_object_ops (project_id, kind, state, payload, parent_sha, commit_sha, actor_id, created_at) VALUES (?, 'rename', 'committed', ?, NULL, NULL, ?, ?)")
      .run(PROJECT_ID, JSON.stringify([earlier]), CONVENOR, new Date().toISOString());
    const res = await renameObject(NEW_ID);
    expect(res).toMatchObject({ ok: false, error: "rename_unchanged" });
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(NEW_ID);
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(events).not.toContain("cache:list");
  });

  it("answers rename_unchanged before the lease when D1 already holds the new ID, though the page showed the old one", async () => {
    memory.raw.prepare("UPDATE objects SET object_id = ? WHERE id = ?").run(NEW_ID, OBJECT_DB_ID);
    const res = await renameObject(NEW_ID);
    expect(res).toMatchObject({ ok: false, error: "rename_unchanged" });
    expect(events).toEqual([]);
  });
});

describe("a rename with no row in objects.csv on a site that reads Google Sheets", () => {
  const SHEETS_ON = "title: Sitio\ngoogle_sheets:\n  enabled: true\n  published_url: \"https://docs.google.com/x\"\n";

  beforeEach(() => {
    files.set(OBJECTS_CSV, "object_id,title\notro,Otro\n");
    files.set("_config.yml", SHEETS_ON);
    tree = tree.filter((entry) => entry.path !== "telar-content/objects/plano.jpg");
    tree.push(treeBlob("_config.yml"));
  });

  it("refuses without the author's agreement to switch Sheets off, renaming nothing", async () => {
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_sheets_on" });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(renameRecords()).toEqual([]);
    expect(ingestBodies).toEqual([]);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(OLD_ID);
  });

  it("commits _config.yml alone with Sheets off, repairs the configuration, then renames in the document", async () => {
    const res = await renameObject(NEW_ID, { disableSheets: true });
    expect(res).toMatchObject({ ok: true, pending: false, committed: false, dispatchRunId: null });
    const request = sentRenameCommit();
    expect(request).toMatchObject({ parentSha: HEAD, branch: "main", placements: [], deletions: [] });
    expect(request.texts.map((t) => t.path)).toEqual(["_config.yml"]);
    expect(committedTextOf(request, "_config.yml")).toContain("enabled: false");
    expect(repairSiteConfig).toHaveBeenCalledWith(expect.anything(), expect.anything(), PROJECT_ID, { google_sheets_enabled: false });
    expect(heads()).toEqual({ head_sha: COMMITTED, objects_read_sha: COMMITTED });
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(NEW_ID);
    expect(renameRecords()).toEqual([]);
    expect(events.filter((e) => e.startsWith("cache") || e === "dispatch")).toEqual([]);
    expect(events.indexOf("commit:prepared")).toBeLessThan(events.indexOf("ingest:committed"));
  });

  it("finishes the rename at the next run when the commit landed but its answer was lost", async () => {
    vi.mocked(commitTreeOnHead).mockImplementationOnce(async (request) => {
      events.push(`commit:${renameRecords().map((r) => r.state).join(",")}`);
      files.set("_config.yml", request.texts[0].content);
      throw new Error("Updating the branch failed: 502 Bad Gateway");
    });
    const first = await renameObject(NEW_ID, { disableSheets: true });
    expect(first).toMatchObject({ ok: false, error: "rename_failed" });
    expect(events).toContain("commit:prepared");
    expect(renameRecords()).toEqual([expect.objectContaining({ kind: "rename", state: "prepared", parent_sha: HEAD })]);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(OLD_ID);

    const next = await renameObject(NEW_ID, { disableSheets: true });
    expect(next).toMatchObject({ ok: false, error: "rename_unchanged" });
    expect(commitTreeOnHead).toHaveBeenCalledTimes(1);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(NEW_ID);
    expect(files.get("_config.yml")).toContain("enabled: false");
    expect(renameRecords()).toEqual([]);
  });

  it("repairs the stored configuration when it finishes, at the next run, a rename whose commit's answer was lost", async () => {
    vi.mocked(commitTreeOnHead).mockImplementationOnce(async (request) => {
      files.set("_config.yml", request.texts[0].content);
      throw new Error("Updating the branch failed: 502 Bad Gateway");
    });
    await renameObject(NEW_ID, { disableSheets: true });
    expect(repairSiteConfig).not.toHaveBeenCalled();

    await renameObject(NEW_ID, { disableSheets: true });
    expect(repairSiteConfig).toHaveBeenCalledWith(expect.anything(), expect.anything(), PROJECT_ID, { google_sheets_enabled: false });
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(NEW_ID);
  });

  it("finishes the author's later rename, not an earlier one from the same ID whose commit never reached the branch", async () => {
    vi.mocked(commitTreeOnHead).mockImplementationOnce(async () => {
      throw new Error("Updating the branch failed: 502 Bad Gateway");
    });
    const first = await renameObject("plano-nuevo", { disableSheets: true });
    expect(first).toMatchObject({ ok: false, error: "rename_failed" });

    vi.mocked(commitTreeOnHead).mockImplementationOnce(async (request) => {
      files.set("_config.yml", request.texts[0].content);
      return { commitSha: COMMITTED };
    });
    ingestAnswer = () => new Response("snapshot_failed", { status: 503 });
    const second = await renameObject("plano-final", { disableSheets: true });
    expect(second).toMatchObject({ ok: true, newId: "plano-final", pending: true });
    expect(renameRecords()).toEqual([
      expect.objectContaining({ state: "prepared" }),
      expect.objectContaining({ state: "committed", commit_sha: COMMITTED }),
    ]);

    ingestAnswer = renamingIngest;
    const next = await renameObject("plano-final");
    expect(next).toMatchObject({ ok: false, error: "rename_unchanged" });
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe("plano-final");
    expect(renameRecords()).toEqual([]);
  });

  it("recovers an earlier rename whose commit landed with its answer lost while a later one from the same ID met a stale head", async () => {
    let later: Record<string, unknown> | undefined;
    vi.mocked(commitTreeOnHead)
      .mockImplementationOnce(async (request) => {
        // The later request runs while this commit is in flight, past a lease that did not hold it off.
        later = await renameObject("plano-final", { disableSheets: true });
        files.set("_config.yml", request.texts[0].content);
        throw new Error("Updating the branch failed: 502 Bad Gateway");
      })
      .mockImplementationOnce(async () => {
        throw new StaleHeadError("moved");
      });
    const first = await renameObject("plano-nuevo", { disableSheets: true });
    expect(first).toMatchObject({ ok: false, error: "rename_failed" });
    expect(later).toMatchObject({ ok: false, error: "rename_stale_head" });
    expect(renameRecords()).toEqual([expect.objectContaining({ state: "prepared" })]);

    const next = await renameObject("plano-nuevo");
    expect(next).toMatchObject({ ok: false, error: "rename_unchanged" });
    expect(commitTreeOnHead).toHaveBeenCalledTimes(2);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe("plano-nuevo");
    expect(repairSiteConfig).toHaveBeenCalledWith(expect.anything(), expect.anything(), PROJECT_ID, { google_sheets_enabled: false });
    expect(renameRecords()).toEqual([]);
  });

  it("does not treat the commit as landed at the next run when it never reached the branch", async () => {
    vi.mocked(commitTreeOnHead).mockImplementationOnce(async () => {
      events.push(`commit:${renameRecords().map((r) => r.state).join(",")}`);
      throw new Error("Updating the branch failed: 502 Bad Gateway");
    });
    const first = await renameObject(NEW_ID, { disableSheets: true });
    expect(first).toMatchObject({ ok: false, error: "rename_failed" });
    expect(renameRecords()).toEqual([expect.objectContaining({ kind: "rename", state: "prepared", parent_sha: HEAD })]);

    const next = await renameObject(NEW_ID, { disableSheets: true });
    expect(next).toMatchObject({ ok: true, pending: false, committed: false });
    expect(commitTreeOnHead).toHaveBeenCalledTimes(2);
    // The first record was kept, not applied: the only ingest follows the second commit.
    expect(events.filter((e) => e.startsWith("ingest:"))).toEqual(["ingest:prepared,committed"]);
    expect(events).toContain("commit:prepared,prepared");
    expect(events.indexOf("commit:prepared,prepared")).toBeLessThan(events.indexOf("ingest:prepared,committed"));
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(NEW_ID);
    expect(renameRecords()).toEqual([expect.objectContaining({ kind: "rename", state: "prepared", parent_sha: HEAD })]);
  });

  it("answers rename_stale_head with no record and nothing renamed when the head moved", async () => {
    vi.mocked(commitTreeOnHead).mockRejectedValueOnce(new StaleHeadError("moved"));
    const res = await renameObject(NEW_ID, { disableSheets: true });
    expect(res).toMatchObject({ ok: false, error: "rename_stale_head" });
    expect(renameRecords()).toEqual([]);
    expect(ingestBodies).toEqual([]);
    expect(repairSiteConfig).not.toHaveBeenCalled();
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(OLD_ID);
  });
});

describe("facts the page showed that the head does not give", () => {
  // The head's objects.csv has `plano.jpg` after `plano`, a row D1 has not
  // synced: the site shows `plano.jpg` for the step valued `plano`. D1 alone
  // says the step shows this object and is rewritten; the head says it is
  // rewritten away from `plano.jpg`.
  const COLLIDING_SHEET = "object_id,title,thumbnail\nplano,Plano,telar-content/objects/plano.jpg\notro,Otro,\nplano.jpg,Plano imagen,\n";

  it("are counted apart: a rewritten step that shows another row today is taken over, not rewritten", () => {
    const rows = [{ object_id: "plano" }, { object_id: "otro" }, { object_id: "plano.jpg" }];
    const facts = objectRenameFacts({ object_id: OLD_ID }, { sheet: rows, d1: rows.slice(0, 2), version: null }, [OLD_ID, "otro"]);
    expect(facts).toMatchObject({ stepsRewritten: 0, stepsTakenOver: 1, takenOverFrom: ["plano.jpg"], stepsKept: 0 });
  });

  it("stop the commit with nothing written, answering the head's facts", async () => {
    files.set(OBJECTS_CSV, COLLIDING_SHEET);
    const posted = pageFacts();
    expect(posted).toMatchObject({ stepsRewritten: 1, stepsTakenOver: 0 });
    const res = await renameObject();
    expect(res).toMatchObject({
      ok: false,
      error: "rename_facts_changed",
      facts: { stepsRewritten: 0, stepsTakenOver: 1, takenOverFrom: ["plano.jpg"] },
    });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(events.filter((e) => e.startsWith("cache") || e === "dispatch")).toEqual([]);
    expect(renameRecords()).toEqual([]);
    expect(ingestBodies).toEqual([]);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(OLD_ID);
  });

  it("let the commit proceed once the head's facts are posted back", async () => {
    files.set(OBJECTS_CSV, COLLIDING_SHEET);
    const first = await renameObject();
    const confirmedFacts = renameFactsFingerprint(first.facts as ObjectRenameFacts, NEW_ID);
    const res = await renameObject(NEW_ID, { confirmedFacts });
    expect(res).toMatchObject({ ok: true, committed: true });
    expect(commitTreeOnHead).toHaveBeenCalledTimes(1);
  });

  it("stop a rename in the document alone with nothing written", async () => {
    files.set(OBJECTS_CSV, "object_id,title\notro,Otro\nplano.jpg,Plano imagen\n");
    tree = tree.filter((entry) => entry.path !== "telar-content/objects/plano.jpg");
    const res = await renameObject();
    expect(res).toMatchObject({ ok: false, error: "rename_facts_changed", facts: { stepsRewritten: 0, stepsTakenOver: 1 } });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
    expect(renameRecords()).toEqual([]);
    expect(ingestBodies).toEqual([]);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(OLD_ID);
  });
});

describe("facts the page showed that the head gives too", () => {
  it("let the rename proceed as before", async () => {
    const posted = renameFactsFingerprint(pageFacts(), NEW_ID);
    const res = await renameObject(NEW_ID, { confirmedFacts: posted });
    expect(res).toMatchObject({ ok: true, committed: true });
    expect(commitTreeOnHead).toHaveBeenCalledTimes(1);
    expect(d1ObjectIdOf(OBJECT_DB_ID)).toBe(NEW_ID);
  });

  it("are required: a post without them is answered with the facts, renaming nothing", async () => {
    const res = await renameObject(NEW_ID, { confirmedFacts: "" });
    expect(res).toMatchObject({ ok: false, error: "rename_facts_changed", facts: { stepsRewritten: 1 } });
    expect(commitTreeOnHead).not.toHaveBeenCalled();
  });
});
