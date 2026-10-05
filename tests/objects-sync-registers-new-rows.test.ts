/**
 * The objects sync registers the rows it brings in from GitHub.
 *
 * The apply advances `objects_read_sha` to the commit it applied, which says
 * D1 holds every object row of that commit's objects.csv. A row new on GitHub
 * is therefore registered in D1 by the apply itself, under the objects lease,
 * with the author as actor and `repo` as its origin, and is not returned as
 * pending: a commit window closed without committing would otherwise leave the
 * record naming a row D1 does not hold, and the next objects commit, written
 * from D1, would drop it from the site. An accepted row the registration did
 * not add is answered as `notAdded`, and the record does not advance. Image
 * files with no row stay pending for the commit window, and a new row the
 * author left unticked is neither registered nor holds the record.
 *
 * These run the real route action, the real apply and registration, and the
 * real collaboration object against an in-memory database, over a GitHub that
 * keeps each commit's objects.csv.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as Y from "yjs";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { PROJECT_ID, SECRET, buildDoc, seedProject } from "./helpers/collaboration-fixture";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/active-project.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/active-project.server")>();
  const resolveActiveProjectFromRequest = vi.fn();
  return {
    ...actual,
    resolveActiveProjectFromRequest,
    resolvePageProject: vi.fn(async (request: Request, env: unknown, userId: number) => {
      const resolved = await resolveActiveProjectFromRequest(request, env, userId);
      return resolved ? { kind: "ok", ...(resolved as object) } : { kind: "no_project" };
    }),
  };
});
vi.mock("~/lib/upgrade-gate.server", () => ({
  readUploadRefusal: vi.fn(async () => null),
  readRepoWriteRefusal: vi.fn(async () => null),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github-app.server", () => ({ resolveProjectToken: vi.fn(async () => "inst-token") }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(),
    getRepoTree: vi.fn(),
    getFileContent: vi.fn(async () => null),
    getFileAtRef: vi.fn(),
    githubHeaders: vi.fn(() => ({})),
  };
});
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  dispatchWorkflow: vi.fn(async () => ({ runId: 11, htmlUrl: "u" })),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn(),
  verifySiteUrl: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn(async () => "applied") }));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: vi.fn() }));
vi.mock("~/hooks/use-toast", () => ({ useToast: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ findYMapById: vi.fn(), findYMapByIdOrTempId: vi.fn() }));

import { action } from "~/routes/_app.objects";
import { getDb } from "~/lib/db.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { commitFilesToRepo, StaleHeadError } from "~/lib/commit.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { makeObjectYMap } from "~/lib/object-ymap";

const CSV_PATH = "telar-content/spreadsheets/objects.csv";
const USER = 1;
const OTHER_CONVENOR = 2;
const START = "object_id,title\no1,Seeded\n";

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let doInstance: ProjectCollaborationDO;
let ydoc: Y.Doc;

/** objects.csv at each commit GitHub holds. */
let commits: Map<string, string>;
/** Image files at each commit, as `telar-content/objects/` names them. */
let images: Map<string, string[]>;
let githubHead: string;
let commitCount: number;
/** The commit the project's record names before each test. */
let start: string;
const events: string[] = [];
/** Every ingest body the collaboration object was sent, in order. */
let ingests: Array<{ objects?: { update?: unknown[]; remove?: unknown[]; insert?: Array<{ object_id: string }> } }>;
/** Answers an insert ingest in the object's place, when set. */
let insertAnswer: (() => Response) | null;
/** The user whose request the next apply is. */
let actingUser = USER;

function sha(n: number): string {
  return n.toString(16).padStart(40, "0");
}

/** A commit on GitHub, as an author makes one there. */
function githubEdit(objectsCsv: string, imageFiles: string[] = []): string {
  commitCount += 1;
  const head = sha(commitCount);
  commits.set(head, objectsCsv);
  images.set(head, imageFiles);
  githubHead = head;
  return head;
}

/** A commit the Compositor makes, compare-and-set on the head it read. */
function compositorCommit(expectedHead: string, objectsCsv: string): { newHeadSha: string } {
  if (expectedHead !== githubHead) throw new StaleHeadError("moved");
  return { newHeadSha: githubEdit(objectsCsv) };
}

function projectRow(): { objects_read_sha: string | null } {
  return memory.raw.prepare("SELECT objects_read_sha FROM projects WHERE id = ?").get(PROJECT_ID) as never;
}

function objectRow(objectId: string): { title: string | null; origin: string | null; created_by: number | null } | undefined {
  return memory.raw
    .prepare("SELECT title, origin, created_by FROM objects WHERE project_id = ? AND object_id = ?")
    .get(PROJECT_ID, objectId) as never;
}

function context() {
  const user = { id: actingUser, encrypted_access_token: "enc" };
  const stub = {
    fetch: async (req: Request) => {
      const body = (await req.clone().json()) as (typeof ingests)[number];
      ingests.push(body);
      const inserts = (body.objects?.insert?.length ?? 0) > 0;
      events.push(inserts ? "ingest:insert" : "ingest");
      if (insertAnswer && inserts) return insertAnswer();
      return doInstance.fetch(req);
    },
  };
  const env = {
    ENCRYPTION_KEY: "k",
    SESSION_SECRET: SECRET,
    DB: asD1(memory),
    GITHUB_APP_ID: "a",
    GITHUB_PRIVATE_KEY: "p",
    COLLABORATION: { idFromName: (n: string) => n, get: () => stub },
  };
  return { get: vi.fn(() => user), cloudflare: { env } } as never;
}

type Answer = {
  ok: boolean;
  error?: string;
  newHeadSha?: string;
  pendingObjects?: Array<{ object_id: string }>;
  notAdded?: string[];
};

async function run(fields: Record<string, string>): Promise<Answer> {
  const request = new Request("https://compositor.telar.org/objects", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ siteId: String(PROJECT_ID), ...fields }).toString(),
  });
  return (await action({ request, context: context(), params: {} } as never)) as Answer;
}

function syncApply(headSha: string, overrides: Record<string, unknown> = {}): Promise<Answer> {
  const changes = {
    newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [],
    headSha, baseSha: projectRow().objects_read_sha, ...overrides,
  };
  return run({ intent: "sync-apply", changes: JSON.stringify(changes) });
}

const commitObjects = () =>
  run({ intent: "commit-objects", disableSheets: "false", pendingObjects: JSON.stringify([]) });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  events.length = 0;
  ingests = [];
  insertAnswer = null;
  actingUser = USER;
  memory = createMemoryD1();
  seedProject(memory, "text");
  db = drizzle(asD1(memory), { schema });

  commits = new Map();
  images = new Map();
  commitCount = 0;
  start = githubEdit(START);
  memory.raw
    .prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ?, yjs_state = ? WHERE id = ?")
    .run(start, start, buildDoc(true), PROJECT_ID);

  const ctx = {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;

  vi.mocked(getDb).mockReturnValue(db as never);
  vi.mocked(resolveActiveProjectFromRequest).mockImplementation(async () => ({
    project: memory.raw.prepare("SELECT * FROM projects WHERE id = ?").get(PROJECT_ID),
    userRole: "convenor",
  }) as never);
  vi.mocked(getRepoHead).mockImplementation(async () => githubHead);
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) => {
    if (path !== CSV_PATH) return { status: "absent" };
    const content = commits.get(ref);
    return content === undefined ? { status: "error" } : { status: "ok", content, size: content.length } as never;
  });
  vi.mocked(getRepoTree).mockImplementation(async (_t, _o, _r, ref) => ({
    tree: (images.get(ref ?? "") ?? []).map((name) => ({ path: `telar-content/objects/${name}`, type: "blob" })),
    truncated: false,
  }) as never);
  vi.mocked(commitFilesToRepo).mockImplementation((async (...args: unknown[]) => {
    const files = args[4] as Array<{ path: string; content: string }>;
    return compositorCommit(args[9] as string, files.find((f) => f.path === CSV_PATH)!.content);
  }) as never);
  vi.mocked(controlFreezeLease).mockImplementation(async (_e, _p, _u, control) => {
    events.push(control.op === "begin" ? `lease:begin:${control.kind}` : `lease:end:${(control as { outcome?: string }).outcome}`);
    return "applied";
  });
});

afterEach(() => {
  memory.close();
});

describe("an apply bringing in a row new on GitHub", () => {
  it("registers it in D1 as the author, with the repo as its origin, returns nothing pending, and records the commit", async () => {
    const added = githubEdit(`${START}o2,From GitHub\n`);

    const res = await syncApply(added, { newObjectIds: ["o2"] });

    expect(res).toMatchObject({ ok: true, pendingObjects: [], notAdded: [] });
    expect(objectRow("o2")).toEqual({ title: "From GitHub", origin: "repo", created_by: USER });
    expect(projectRow().objects_read_sha).toBe(added);
  });

  it("registers it in the update's ingest, under the objects lease", async () => {
    const added = githubEdit(`object_id,title\no1,Renamed on GitHub\no2,From GitHub\n`);

    await syncApply(added, {
      newObjectIds: ["o2"],
      changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } },
      // The title the check read, as the collaboration object holds it.
      fieldsSeen: { o1: { title: String(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title")) } },
    });

    expect(events).toEqual(["lease:begin:objects", "ingest:insert", "lease:end:succeeded"]);
    expect(ingests[0].objects?.insert?.map((i) => i.object_id)).toEqual(["o2"]);
    expect(ingests[0].objects?.update).toHaveLength(1);
  });

  // The defect's own scenario: the author closes the commit window, or it
  // never opens, and the next objects commit writes objects.csv from D1.
  it("keeps the row in the next objects commit's objects.csv", async () => {
    const added = githubEdit(`${START}o2,From GitHub\n`);
    await syncApply(added, { newObjectIds: ["o2"] });

    const res = await commitObjects();

    expect(res).toMatchObject({ ok: true });
    expect(commits.get(res.newHeadSha!)).toContain("o2,From GitHub");
  });
});

describe("an accepted row the registration did not add", () => {
  // D1 refused the row after the document took it: found only once written,
  // so it cannot hold the apply back, and the record waits on it.
  it.each([
    ["it answers the row as failed", () => Response.json({ applied: { objectInsert: 0 }, failed: { objectInsert: ["o2"] } })],
  ])("when %s: is not added, not pending, and the record does not advance", async (_label, answer) => {
    insertAnswer = answer;
    const added = githubEdit(`${START}o2,From GitHub\n`);

    const res = await syncApply(added, { newObjectIds: ["o2"] });

    expect(res).toMatchObject({ ok: true, pendingObjects: [], notAdded: ["o2"] });
    expect(projectRow().objects_read_sha).toBe(start);
  });

  // The ingest failed: the apply fails, and nothing is recorded.
  it("when the registration fails: the apply fails, and the record does not advance", async () => {
    insertAnswer = () => new Response("snapshot_failed", { status: 503 });
    const added = githubEdit(`${START}o2,From GitHub\n`);

    const res = await syncApply(added, { newObjectIds: ["o2"] });

    expect(res.ok).toBe(false);
    expect(projectRow().objects_read_sha).toBe(start);
  });

  it("when it answers the row's key as held: the row is answered as edited here, and the record does not advance", async () => {
    insertAnswer = () => Response.json({ heldBack: true, applied: { objectInsert: 0 }, skipped: { objectInsert: ["o2"] } });
    const added = githubEdit(`${START}o2,From GitHub\n`);

    const res = await syncApply(added, { newObjectIds: ["o2"] }) as Answer & { changedSinceReview?: string[] };

    expect(res).toMatchObject({ ok: true, pendingObjects: [], notAdded: [], changedSinceReview: ["o2"] });
    expect(projectRow().objects_read_sha).toBe(start);
  });

  // A key the Compositor took since the check holds its own values: the
  // apply is held back whole, and GitHub's row is offered again.
  it("is answered as edited here when the Compositor took its key since the check", async () => {
    const added = githubEdit(`${START}o2,From GitHub\n`);
    const own = new Y.Map<unknown>();
    ydoc.transact(() => {
      own.set("_id", 2);
      own.set("object_id", "o2");
      own.set("title", new Y.Text("The Compositor's own"));
      own.set("_validation_state", "valid");
      ydoc.getArray<Y.Map<unknown>>("objects").push([own]);
    }, null);
    memory.raw
      .prepare("INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ?, 'o2', 'a00002', ?, 'compositor')")
      .run(PROJECT_ID, "The Compositor's own");

    const res = await syncApply(added, { newObjectIds: ["o2"] }) as Answer & { changedSinceReview?: string[] };

    expect(res).toMatchObject({ ok: true, pendingObjects: [], notAdded: [], changedSinceReview: ["o2"] });
    expect(objectRow("o2")).toMatchObject({ title: "The Compositor's own", origin: "compositor" });
    expect(projectRow().objects_read_sha).toBe(start);
  });
});

// The new rows travel in the apply's one all-or-nothing ingest, so a
// title change and a new row land together or not at all.
describe("an apply bringing in a changed row and a new one", () => {
  const changedAndNew = () => ({
    newObjectIds: ["o2"],
    changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } },
    fieldsSeen: { o1: { title: String(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title")) } },
  });
  const heldTitle = () => String(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title"));

  // The real collaboration object refuses the ingest with a 503 before its
  // first write: its persistence is halted. The document and D1 are read
  // afterwards, so a write made before that refusal fails this. A failure
  // after the write (a refused INSERT, a failed flush) is not covered here.
  it("writes neither when the collaboration object refuses the ingest before writing", async () => {
    (doInstance as unknown as { persistenceHalted: unknown }).persistenceHalted = { generation: 0, marker: {} };
    const before = heldTitle();
    const beforeInD1 = objectRow("o1");
    const added = githubEdit(`object_id,title\no1,Renamed on GitHub\no2,From GitHub\n`);

    const res = await syncApply(added, changedAndNew());

    expect(res.ok).toBe(false);
    expect(events).toContain("ingest:insert");
    expect(heldTitle()).toBe(before);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").toArray().some((m) => m.get("object_id") === "o2")).toBe(false);
    expect(objectRow("o1")).toEqual(beforeInD1);
    expect(objectRow("o2")).toBeUndefined();
    expect(projectRow().objects_read_sha).toBe(start);
  });

  it("writes neither, and names the row, when the Compositor took the new row's key since the check", async () => {
    const before = heldTitle();
    const own = new Y.Map<unknown>();
    ydoc.transact(() => {
      own.set("_id", 2);
      own.set("object_id", "o2");
      own.set("title", new Y.Text("The Compositor's own"));
      own.set("_validation_state", "valid");
      ydoc.getArray<Y.Map<unknown>>("objects").push([own]);
    }, null);
    memory.raw
      .prepare("INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ?, 'o2', 'a00002', ?, 'compositor')")
      .run(PROJECT_ID, "The Compositor's own");
    const added = githubEdit(`object_id,title\no1,Renamed on GitHub\no2,From GitHub\n`);

    const res = await syncApply(added, changedAndNew()) as Answer & { changedSinceReview?: string[] };

    expect(res).toMatchObject({ ok: true, notAdded: [], changedSinceReview: ["o2"] });
    expect(heldTitle()).toBe(before);
    expect(objectRow("o2")).toMatchObject({ title: "The Compositor's own", origin: "compositor" });
    expect(projectRow().objects_read_sha).toBe(start);
  });

  it("registers the new row in the same ingest as the update, and records the commit", async () => {
    const added = githubEdit(`object_id,title\no1,Renamed on GitHub\no2,From GitHub\n`);

    const res = await syncApply(added, changedAndNew());

    expect(res).toMatchObject({ ok: true, notAdded: [] });
    expect(ingests).toHaveLength(1);
    expect(heldTitle()).toBe("Renamed on GitHub");
    expect(objectRow("o2")).toEqual({ title: "From GitHub", origin: "repo", created_by: USER });
    expect(projectRow().objects_read_sha).toBe(added);
  });
});

// A row an editor made in the Compositor since the check and D1 has not yet
// taken: no D1 id, and its own values. It is an edit made here, not GitHub's
// row awaiting its insert.
describe("a new row's key held by a saved row of the Compositor's own with GitHub's values", () => {
  // A D1 id is an object D1 holds, made here since the check, whatever its values.
  it("writes nothing, names the row, and keeps the record", async () => {
    const own = new Y.Map<unknown>();
    ydoc.transact(() => {
      own.set("_id", 2);
      own.set("object_id", "o2");
      own.set("title", new Y.Text("Remote"));
      own.set("alt_text", new Y.Text("Remote"));
      own.set("_validation_state", "valid");
      ydoc.getArray<Y.Map<unknown>>("objects").push([own]);
    }, null);
    memory.raw
      .prepare("INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (2, ?, 'o2', 'a00002', 'Remote', 'compositor')")
      .run(PROJECT_ID);
    const o1Title = () => String(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title"));
    const before = o1Title();
    const added = githubEdit(`object_id,title\no1,Renamed on GitHub\no2,Remote\n`);

    const res = await syncApply(added, {
      newObjectIds: ["o2"],
      changedObjectIds: ["o1"], changedDocIds: { o1: 1 }, fieldChoices: { o1: { title: "repo" } },
      fieldsSeen: { o1: { title: before } },
    }) as Answer & { changedSinceReview?: string[] };

    expect(res).toMatchObject({ ok: true, notAdded: [], changedSinceReview: ["o2"] });
    // The whole apply is held back: GitHub's title for o1 is not written either.
    expect(o1Title()).toBe(before);
    expect(objectRow("o2")).toMatchObject({ origin: "compositor" });
    expect(projectRow().objects_read_sha).toBe(start);
  });
});

describe("a new row's key held by an unsaved row of the Compositor's own", () => {
  it("writes nothing, names the row, and keeps the record", async () => {
    const local = new Y.Map<unknown>();
    ydoc.transact(() => {
      local.set("_id", null);
      local.set("object_id", "o2");
      local.set("title", new Y.Text("Local"));
      local.set("_validation_state", "valid");
      ydoc.getArray<Y.Map<unknown>>("objects").push([local]);
    }, null);
    const added = githubEdit(`${START}o2,Remote\n`);

    const res = await syncApply(added, { newObjectIds: ["o2"] }) as Answer & { changedSinceReview?: string[] };

    expect(res).toMatchObject({ ok: true, notAdded: [], changedSinceReview: ["o2"] });
    expect(String(local.get("title"))).toBe("Local");
    expect(objectRow("o2")).toBeUndefined();
    expect(projectRow().objects_read_sha).toBe(start);
  });
});

// GitHub's row and the unsaved row agree in every text field and differ only
// in a value the insert writes beside them.
describe("a new row's key held by an unsaved row equal to GitHub's in its text only", () => {
  it("writes nothing, names the row, and keeps the record when only image_available differs", async () => {
    const local = new Y.Map<unknown>();
    ydoc.transact(() => {
      local.set("_id", null);
      local.set("object_id", "o2");
      for (const field of ["title", "creator", "description", "alt_text", "period", "year", "object_type", "subjects", "source", "credit"]) {
        // GitHub's alt text defaults to the title.
        local.set(field, new Y.Text(field === "title" || field === "alt_text" ? "Remote" : ""));
      }
      for (const field of ["source_url", "thumbnail", "dimensions", "extra_columns"]) local.set(field, "");
      local.set("featured", false);
      local.set("image_available", true);
      local.set("created_by", USER);
      ydoc.getArray<Y.Map<unknown>>("objects").push([local]);
    }, null);
    const added = githubEdit(`${START}o2,Remote\n`, ["o2.jpg"]);

    const res = await syncApply(added, { newObjectIds: ["o2"] }) as Answer & { changedSinceReview?: string[] };

    expect(ingests[0].objects?.insert).toEqual([expect.objectContaining({ object_id: "o2", title: "Remote", image_available: false })]);
    expect(res).toMatchObject({ ok: true, notAdded: [], changedSinceReview: ["o2"] });
    expect(local.get("image_available")).toBe(true);
    expect(objectRow("o2")).toBeUndefined();
    expect(projectRow().objects_read_sha).toBe(start);
  });

  // The editor's own row carries what no insert writes (its client id, its
  // origin), whatever its values.
  it("writes nothing, names the row, and keeps the record when an editor made the row with GitHub's values", async () => {
    const local = makeObjectYMap({
      objectId: "o2", title: "Remote", altText: "Remote", imageAvailable: true, createdBy: USER,
      origin: "compositor", validationState: "valid", orderKey: "a00002",
    });
    ydoc.transact(() => ydoc.getArray<Y.Map<unknown>>("objects").push([local]), null);
    const added = githubEdit(`${START}o2,Remote\n`, ["o2.jpg"]);

    const res = await syncApply(added, { newObjectIds: ["o2"] }) as Answer & { changedSinceReview?: string[] };

    expect(res).toMatchObject({ ok: true, notAdded: [], changedSinceReview: ["o2"] });
    expect(objectRow("o2")).toBeUndefined();
    expect(projectRow().objects_read_sha).toBe(start);
  });
});

// An insert D1 refused waits in the document with no D1 id; the next apply
// sends it again, and the ingest settles it by its receipt rather than reading
// it as an object made in the Compositor.
describe("a new row D1 refused once", () => {
  it("is registered by the next apply", async () => {
    memory.raw.exec(
      "CREATE TRIGGER refuse_o2 BEFORE INSERT ON objects WHEN NEW.object_id = 'o2' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const added = githubEdit(`${START}o2,From GitHub\n`);

    const first = await syncApply(added, { newObjectIds: ["o2"] });

    expect(first).toMatchObject({ ok: true, notAdded: ["o2"] });
    expect(objectRow("o2")).toBeUndefined();
    expect(projectRow().objects_read_sha).toBe(start);

    memory.raw.exec("DROP TRIGGER refuse_o2");
    const second = await syncApply(added, { newObjectIds: ["o2"] }) as Answer & { changedSinceReview?: string[] };

    expect(second).toMatchObject({ ok: true, notAdded: [], changedSinceReview: [] });
    expect(objectRow("o2")).toMatchObject({ title: "From GitHub" });
    expect(projectRow().objects_read_sha).toBe(added);
  });
});

// Attribution records who acted, not what the row holds: another convenor's
// identical retry settles the same pending insert.
describe("a new row D1 refused to one convenor", () => {
  it("is registered by another convenor's identical retry", async () => {
    memory.raw.exec(
      "CREATE TRIGGER refuse_o2 BEFORE INSERT ON objects WHEN NEW.object_id = 'o2' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const added = githubEdit(`${START}o2,From GitHub\n`);
    const first = await syncApply(added, { newObjectIds: ["o2"] });
    expect(first).toMatchObject({ ok: true, notAdded: ["o2"] });

    memory.raw.exec("DROP TRIGGER refuse_o2");
    memory.raw.exec(
      `INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) VALUES (${OTHER_CONVENOR}, 2, 'v', 'e', 'e', '2099-01-01', '2099-01-01')`,
    );
    actingUser = OTHER_CONVENOR;
    const second = await syncApply(added, { newObjectIds: ["o2"] }) as Answer & { changedSinceReview?: string[] };

    expect(second).toMatchObject({ ok: true, notAdded: [], changedSinceReview: [] });
    // The row stays credited to the convenor whose accept made it.
    expect(objectRow("o2")).toEqual({ title: "From GitHub", origin: "repo", created_by: USER });
    expect(projectRow().objects_read_sha).toBe(added);
  });
});

describe("what the apply does not register", () => {
  it("leaves an image file with no row pending, and records the commit", async () => {
    const added = githubEdit(START, ["loose.jpg"]);

    const res = await syncApply(added, { unregisteredObjectIds: ["loose"] });

    expect(res.pendingObjects?.map((p) => p.object_id)).toEqual(["loose"]);
    expect(res.notAdded).toEqual([]);
    expect(objectRow("loose")).toBeUndefined();
    expect(ingests).toEqual([]);
    expect(projectRow().objects_read_sha).toBe(added);
  });

  // A row the author was shown and left unticked is their choice.
  it("leaves a new row the author left unticked out of D1, and records the commit", async () => {
    const added = githubEdit(`${START}o2,From GitHub\n`);

    const res = await syncApply(added);

    expect(res).toMatchObject({ ok: true, pendingObjects: [], notAdded: [] });
    expect(objectRow("o2")).toBeUndefined();
    expect(ingests).toEqual([]);
    expect(projectRow().objects_read_sha).toBe(added);
  });
});
