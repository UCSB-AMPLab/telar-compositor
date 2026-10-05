/**
 * The syncs make the Compositor's object order GitHub's.
 *
 * The check lists a reorder of the rows both sides hold (`SyncDiff.reordered`),
 * with or without a base, and every path that records GitHub's head as read
 * applies GitHub's order first, or does not record while a reorder is pending:
 * the objects page's apply and the full sync send it as `objects.order`, and
 * "Use Compositor version" sends it alone (`applyGitHubObjectOrder`). A row a
 * sync brings in is placed where GitHub's file has it (`objects.sheet`). A
 * superseded order entry leaves the commit unread.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

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
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(),
    getRepoTree: vi.fn(),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import {
  applyFullSyncChanges,
  applyGitHubObjectOrder,
  applySyncChanges,
  computeSyncDiff,
  hasDivergentChanges,
  resolveFullSyncPayload,
  SyncBaseStale,
  type FullSyncChanges,
  type FullSyncDiff,
  type SyncChanges,
} from "~/lib/sync.server";
import { objectsSheetOrder } from "~/lib/objects.server";
import { getFileAtRef, getRepoHead, getRepoTree } from "~/lib/github.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { hasConflictItems, hasDiffChanges } from "~/components/features/dashboard/sync-changes";
import { aggregateSyncDiff } from "~/components/features/site-status/site-status-diff";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { PROJECT_ID, SECRET, buildDoc, proseFields, seedProject } from "./helpers/collaboration-fixture";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
const USER = 1;

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
/** objects.csv at each commit. */
let sheets: Record<string, string>;
let tree: Array<{ path: string; type: string; sha: string }>;

function csv(...ids: string[]): string {
  return `object_id,title\n${ids.map((id) => `${id},Title ${id}`).join("\n")}\n`;
}

/** D1's rows in the order a publish writes them. */
async function publishedOrder(): Promise<string[]> {
  const rows = await db
    .select({ object_id: schema.objects.object_id })
    .from(schema.objects)
    .where(eq(schema.objects.project_id, PROJECT_ID))
    .orderBy(objectsSheetOrder());
  return rows.map((r) => r.object_id);
}

function projectHeads(): { head_sha: string | null; objects_read_sha: string | null } {
  return memory.raw.prepare("SELECT head_sha, objects_read_sha FROM projects WHERE id = ?").get(PROJECT_ID) as never;
}

/** D1 holds `rows` as the project's objects (the fixture's o1 replaced), each with the key given. */
function seedObjects(rows: Array<[number, string, string]>): void {
  memory.raw.exec("DELETE FROM objects");
  for (const [id, objectId, key] of rows) {
    memory.raw
      .prepare("INSERT INTO objects (id, project_id, object_id, order_key, title, origin) VALUES (?, ?, ?, ?, ?, 'repo')")
      .run(id, PROJECT_ID, objectId, key, `Title ${objectId}`);
  }
}

/** The real collaboration object over D1's objects, loaded from a document holding the same rows. */
async function loadRealDo(): Promise<{ ydoc: Y.Doc; env: Env }> {
  const rows = memory.raw.prepare("SELECT id, object_id, order_key, title FROM objects ORDER BY id").all() as Array<{
    id: number; object_id: string; order_key: string; title: string;
  }>;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, buildDoc(true));
  const arr = doc.getArray<Y.Map<unknown>>("objects");
  doc.transact(() => {
    arr.delete(0, arr.length);
    for (const row of rows) {
      const m = new Y.Map<unknown>();
      m.set("_id", row.id);
      m.set("object_id", row.object_id);
      m.set("order_key", row.order_key);
      m.set("_validation_state", "valid");
      for (const { key } of proseFields("objects")) m.set(key, new Y.Text(key === "title" ? row.title : ""));
      arr.push([m]);
    }
  });
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(Y.encodeStateAsUpdate(doc), PROJECT_ID);
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
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: { idFromName: (n: string) => n, get: () => doInstance },
  } as unknown as Env;
  return { ydoc: (doInstance as unknown as { ydoc: Y.Doc }).ydoc, env };
}

/** A collaboration binding whose ingest is recorded and answered by `answer`. */
function standInEnv(answer: () => unknown = () => ({ applied: {} })) {
  const bodies: Array<{ objects: Record<string, unknown> }> = [];
  const env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          bodies.push(JSON.parse(await req.text()));
          return Response.json(answer());
        },
      }),
    },
  } as unknown as Env;
  return { env, bodies };
}

function changes(overrides: Partial<SyncChanges> = {}): SyncChanges {
  return {
    newObjectIds: [],
    changedObjectIds: [],
    fieldChoices: {},
    removedObjectIds: [],
    unregisteredObjectIds: [],
    headSha: HEAD,
    ...overrides,
  };
}

function fullChanges(objects: Partial<SyncChanges> = {}): FullSyncChanges {
  return {
    objects: changes(objects),
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    headSha: HEAD,
    projectId: PROJECT_ID,
    baseSha: BASE,
    storyContentChecked: true,
    pageContentChecked: true,
  };
}

const SUPERSEDED_ORDER = () => ({ applied: {}, skipped: { objectOrder: ["a"] }, superseded: { objectOrder: ["a"] } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  seedProject(memory, "text");
  memory.raw.prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ? WHERE id = ?").run(BASE, BASE, PROJECT_ID);
  db = drizzle(asD1(memory), { schema });
  seedObjects([[1, "a", "a1"], [2, "b", "a2"], [3, "c", "a3"]]);
  sheets = { [BASE]: csv("a", "b", "c"), [HEAD]: csv("c", "a", "b") };
  tree = [];
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getRepoTree).mockImplementation(async () => ({ tree, truncated: false }) as never);
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
    path === OBJECTS_CSV && sheets[ref] !== undefined ? { status: "ok", content: sheets[ref] } : { status: "absent" },
  );
});

afterEach(() => {
  memory.close();
});

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

describe("the check lists a reorder", () => {
  it("lists a head that only reorders rows, two-way, with no changed object", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, undefined, HEAD);
    expect(diff.reordered).toEqual({
      order: [{ objectId: "c", docId: 3 }, { objectId: "a", docId: 1 }, { objectId: "b", docId: 2 }],
    });
    expect(diff.changedObjects).toEqual([]);
  });

  it("lists the same change three-way, where the base holds the Compositor's order", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, sheets[BASE], HEAD);
    expect(diff.reordered?.order.map((e) => e.objectId)).toEqual(["c", "a", "b"]);
    expect(diff.changedObjects).toEqual([]);
  });

  it("lists nothing when GitHub's order is D1's", async () => {
    sheets[HEAD] = csv("a", "b", "c");
    const diff = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, undefined, HEAD);
    expect(diff.reordered).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The objects page's apply
// ---------------------------------------------------------------------------

describe("the objects page's apply applies GitHub's order", () => {
  it("sends the order in the ingest when it is the only change", async () => {
    const { env, bodies } = standInEnv();

    const res = await applySyncChanges(PROJECT_ID, changes(), "t", "o", "r", db, env, USER);

    expect(bodies).toHaveLength(1);
    expect(bodies[0].objects.order).toEqual([
      { objectId: "c", docId: 3 }, { objectId: "a", docId: 1 }, { objectId: "b", docId: 2 },
    ]);
    expect(res.updateSkipped).toBe(false);
  });

  it("sends no ingest when GitHub's order is already D1's and nothing else was accepted", async () => {
    sheets[HEAD] = csv("a", "b", "c");
    const { env, bodies } = standInEnv();

    await applySyncChanges(PROJECT_ID, changes(), "t", "o", "r", db, env, USER);

    expect(bodies).toEqual([]);
  });

  it("answers the object edited here, recording nothing, when an order entry is superseded", async () => {
    const { env } = standInEnv(SUPERSEDED_ORDER);

    const res = await applySyncChanges(PROJECT_ID, changes(), "t", "o", "r", db, env, USER);

    expect(res).toMatchObject({ appliedCount: 0, changedSinceReview: ["a"] });

    expect(projectHeads().objects_read_sha).toBe(BASE);
  });

  it("puts map and map.jpg in GitHub's order, and a publish writes it", async () => {
    seedObjects([[1, "map", "a1"], [2, "map.jpg", "a2"]]);
    sheets[HEAD] = csv("map.jpg", "map");
    const { env } = await loadRealDo();

    await applySyncChanges(PROJECT_ID, changes(), "t", "o", "r", db, env, USER);

    expect(await publishedOrder()).toEqual(["map.jpg", "map"]);
  });

  it("places a new GitHub row between the rows GitHub has either side of it", async () => {
    sheets[HEAD] = csv("a", "new", "b", "c");
    const { env } = await loadRealDo();

    await applySyncChanges(PROJECT_ID, changes({ newObjectIds: ["new"] }), "t", "o", "r", db, env, USER);

    expect(await publishedOrder()).toEqual(["a", "new", "b", "c"]);
  });

  it("registers the new rows in GitHub's order, whatever order the dialog listed them in", async () => {
    sheets[HEAD] = csv("a", "n1", "n2", "b", "c");
    const { env, bodies } = standInEnv(() => ({ applied: { objectInsert: 2 }, skipped: {}, failed: {} }));

    await applySyncChanges(PROJECT_ID, changes({ newObjectIds: ["n2", "n1"] }), "t", "o", "r", db, env, USER);

    const registration = bodies.find((b) => Array.isArray(b.objects.insert) && (b.objects.insert as unknown[]).length > 0)!;
    expect((registration.objects.insert as Array<{ object_id: string }>).map((i) => i.object_id)).toEqual(["n1", "n2"]);
    expect(registration.objects.sheet).toEqual([
      { objectId: "a", docId: 1 }, { objectId: "n1" }, { objectId: "n2" }, { objectId: "b", docId: 2 }, { objectId: "c", docId: 3 },
    ]);
  });

  it("still applies the order when every new row is unticked", async () => {
    sheets[HEAD] = csv("c", "new", "a", "b");
    const { env } = await loadRealDo();

    await applySyncChanges(PROJECT_ID, changes(), "t", "o", "r", db, env, USER);

    expect(await publishedOrder()).toEqual(["c", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// The full sync
// ---------------------------------------------------------------------------

describe("the full sync applies GitHub's order", () => {
  it("sends the order and GitHub's sheet, and its inserts in the sheet's order", async () => {
    sheets[HEAD] = csv("c", "n1", "a", "n2", "b");

    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, fullChanges({ newObjectIds: ["n2", "n1"] }), "t", "o", "r", db, USER,
    );

    expect(payload.objects.order).toEqual([
      { objectId: "c", docId: 3 }, { objectId: "a", docId: 1 }, { objectId: "b", docId: 2 },
    ]);
    expect(payload.objects.sheet).toEqual([
      { objectId: "c", docId: 3 }, { objectId: "n1" }, { objectId: "a", docId: 1 }, { objectId: "n2" }, { objectId: "b", docId: 2 },
    ]);
    expect(payload.objects.insert.map((i) => i.object_id)).toEqual(["n1", "n2"]);
  });

  it("applies the order and records the head", async () => {
    const { env } = await loadRealDo();

    const res = await applyFullSyncChanges(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER, env);

    expect(await publishedOrder()).toEqual(["c", "a", "b"]);
    expect(res.newHeadSha).toBe(HEAD);
  });

  it("places a new row between held rows, and appends an image file with no row", async () => {
    sheets[HEAD] = csv("a", "new", "b", "c");
    tree = [{ path: "telar-content/objects/loose.jpg", type: "blob", sha: "x" }];
    const { env } = await loadRealDo();

    await applyFullSyncChanges(
      PROJECT_ID, fullChanges({ newObjectIds: ["new"], unregisteredObjectIds: ["loose"] }), "t", "o", "r", db, USER, env,
    );

    expect(await publishedOrder()).toEqual(["a", "new", "b", "c", "loose"]);
  });

  it("refuses the object as edited here, keeping head_sha, when an order entry is superseded", async () => {
    const { env } = standInEnv(SUPERSEDED_ORDER);

    await expect(applyFullSyncChanges(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER, env))
      .rejects.toMatchObject({ name: "ObjectsChangedSinceReview", objectIds: ["a"] });

    expect(projectHeads()).toEqual({ head_sha: BASE, objects_read_sha: BASE });
  });
});

// ---------------------------------------------------------------------------
// "Use Compositor version"
// ---------------------------------------------------------------------------

describe("applyGitHubObjectOrder", () => {
  const access = { token: "t", owner: "o", repo: "r" };

  it("sends an ingest holding only GitHub's order, under the objects lease", async () => {
    const { env, bodies } = standInEnv();

    const res = await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER);

    expect(res).toEqual({ superseded: false });
    expect(bodies).toEqual([{ objects: { update: [], insert: [], remove: [], order: [
      { objectId: "c", docId: 3 }, { objectId: "a", docId: 1 }, { objectId: "b", docId: 2 },
    ] }, allOrNothing: true }]);
    expect(vi.mocked(controlFreezeLease).mock.calls.map(([, , , control]) => control.op)).toEqual(["begin", "end"]);
  });

  // "Use Compositor version" accepts GitHub's version of the site: a row D1
  // holds under the stripped form of an id the recorded version and GitHub
  // both write padded takes GitHub's spelling in the same ingest, before the
  // head is recorded and a publish would write D1's.
  it("gives a row stored stripped GitHub's spelling, and orders it under that spelling", async () => {
    sheets[BASE] = csv("a  ", "b", "c");
    sheets[HEAD] = csv("c", "a  ", "b");
    const { env, bodies } = standInEnv();

    const res = await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER);

    expect(res).toEqual({ superseded: false });
    expect(bodies).toEqual([{ objects: { update: [{ objectId: "a", docId: 1, fields: {}, renameTo: "a  " }], insert: [], remove: [], order: [
      { objectId: "c", docId: 3 }, { objectId: "a  ", docId: 1 }, { objectId: "b", docId: 2 },
    ] }, allOrNothing: true }]);
  });

  it("writes GitHub's spelling to the document and D1", async () => {
    sheets[BASE] = csv("a  ", "b", "c");
    sheets[HEAD] = csv("a  ", "b", "c");
    const { env } = await loadRealDo();

    expect(await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER)).toEqual({ superseded: false });

    expect(await publishedOrder()).toEqual(["a  ", "b", "c"]);
  });

  // With neither commit recorded the ids cannot be judged: nothing is paired,
  // and the answer says so, so the dashboard does not mark them repaired.
  it("respells nothing, and says the ids were not judged, with no record to read", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = NULL, objects_read_sha = NULL WHERE id = ?").run(PROJECT_ID);
    sheets[HEAD] = csv("a  ", "b", "c");
    const { env, bodies } = standInEnv();

    expect(await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, null, db, env, USER))
      .toEqual({ superseded: false, legacyUnjudged: true });
    expect(bodies.flatMap((body) => (body.objects.update as unknown[]) ?? [])).toEqual([]);
  });

  it("respells nothing once the project's ids have been repaired", async () => {
    memory.raw.prepare("UPDATE projects SET legacy_ids_repaired_at = '2026-09-30' WHERE id = ?").run(PROJECT_ID);
    sheets[BASE] = csv("a  ", "b", "c");
    sheets[HEAD] = csv("a  ", "b", "c");
    const { env, bodies } = standInEnv();

    await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER);

    expect(bodies.flatMap((body) => (body.objects.update as unknown[]) ?? [])).toEqual([]);
  });

  it("answers superseded when the row was re-created since, so the head is not recorded", async () => {
    sheets[BASE] = csv("a  ", "b", "c");
    sheets[HEAD] = csv("a  ", "b", "c");
    const { env } = standInEnv(() => ({ applied: {}, skipped: { objectUpdate: ["a"] }, superseded: { objectUpdate: ["a"] } }));

    expect(await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER)).toEqual({ superseded: true });
  });

  it("reads objects.csv at the head it is given, and no other commit, where no id is padded", async () => {
    const { env } = standInEnv();
    await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER);
    expect(vi.mocked(getFileAtRef).mock.calls.map(([, , , , ref]) => ref)).toEqual([HEAD]);
    expect(getRepoHead).not.toHaveBeenCalled();
  });

  // Where an id is padded, the commit D1's object rows are from
  // (objects_read_sha) is read too, as the evidence for ids an earlier import
  // stored stripped (`legacyStrippedIds`); no other commit is.
  it("reads objects.csv at the commit D1's object rows are from, where an id is padded", async () => {
    const READ = "d".repeat(40);
    memory.raw.prepare("UPDATE projects SET objects_read_sha = ? WHERE id = ?").run(READ, PROJECT_ID);
    sheets[READ] = csv("a  ", "b", "c");
    sheets[HEAD] = csv("c", "a  ", "b");
    const { env } = standInEnv();
    await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER);
    const refs = vi.mocked(getFileAtRef).mock.calls.map(([, , , , ref]) => ref);
    expect(refs.every((ref) => ref === HEAD || ref === READ)).toBe(true);
    expect(refs).toContain(HEAD);
    expect(refs).toContain(READ);
  });

  it("sends nothing when GitHub's order is D1's", async () => {
    sheets[HEAD] = csv("a", "b", "c");
    const { env, bodies } = standInEnv();

    expect(await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER)).toEqual({ superseded: false });
    expect(bodies).toEqual([]);
  });

  it("answers a superseded order entry", async () => {
    const { env } = standInEnv(SUPERSEDED_ORDER);
    expect(await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER)).toEqual({ superseded: true });
  });

  it("refuses a base that is no longer the recorded head, writing no order and taking no lease", async () => {
    // Another tab recorded a later head since this check was computed.
    memory.raw.prepare("UPDATE projects SET head_sha = ? WHERE id = ?").run("d".repeat(40), PROJECT_ID);
    const { env, bodies } = standInEnv();

    await expect(applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER)).rejects.toBeInstanceOf(SyncBaseStale);
    expect(bodies).toEqual([]);
    expect(controlFreezeLease).not.toHaveBeenCalled();
    expect(getFileAtRef).not.toHaveBeenCalled();
  });

  // Another writer records a head after the check before the lease,
  // and before this order takes the lease; the base is checked again under it.
  it("refuses a base moved between its first check and the lease, writing no order and recording nothing", async () => {
    vi.mocked(controlFreezeLease).mockImplementationOnce(async () => {
      memory.raw.prepare("UPDATE projects SET head_sha = ? WHERE id = ?").run("d".repeat(40), PROJECT_ID);
      return "applied";
    });
    const { env, bodies } = standInEnv();
    const record = vi.fn(async () => true);

    await expect(applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER, record))
      .rejects.toBeInstanceOf(SyncBaseStale);
    expect(bodies).toEqual([]);
    expect(record).not.toHaveBeenCalled();
    expect(projectHeads().head_sha).toBe("d".repeat(40));
  });

  it("applies over no recorded head for a check computed against none", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = NULL WHERE id = ?").run(PROJECT_ID);
    const { env, bodies } = standInEnv();

    expect(await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, null, db, env, USER)).toEqual({ superseded: false });
    expect(bodies).toHaveLength(1);
  });

  it("throws when objects.csv cannot be read", async () => {
    vi.mocked(getFileAtRef).mockResolvedValue({ status: "error" } as never);
    const { env, bodies } = standInEnv();
    await expect(applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER)).rejects.toThrow();
    expect(bodies).toEqual([]);
  });

  // Keep my version records the head it was shown; a sync apply
  // records what it applied under the same lease, so the record is made
  // before this order's lease is released.
  it("records the head it is given while it holds the objects lease", async () => {
    const order: string[] = [];
    vi.mocked(controlFreezeLease).mockImplementation(async (_env, _project, _user, control) => {
      order.push(control.op);
      return "applied";
    });
    const { env } = standInEnv();

    const res = await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER, async () => {
      order.push("record");
      return true;
    });

    expect(res).toEqual({ superseded: false, recorded: true });
    expect(order).toEqual(["begin", "record", "end"]);
  });

  it("records nothing when the order was superseded", async () => {
    const { env } = standInEnv(SUPERSEDED_ORDER);
    const record = vi.fn(async () => true);
    expect(await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER, record))
      .toEqual({ superseded: true, recorded: false });
    expect(record).not.toHaveBeenCalled();
  });

  it("applies GitHub's order and leaves a field the Compositor holds as it is", async () => {
    memory.raw.exec("UPDATE objects SET title = 'Mine' WHERE id = 1");
    const { env } = await loadRealDo();

    await applyGitHubObjectOrder(PROJECT_ID, access, HEAD, BASE, db, env, USER);

    expect(await publishedOrder()).toEqual(["c", "a", "b"]);
    const row = memory.raw.prepare("SELECT title FROM objects WHERE id = 1").get() as { title: string };
    expect(row.title).toBe("Mine");
  });
});

// ---------------------------------------------------------------------------
// The counts
// ---------------------------------------------------------------------------

describe("a reorder counts as a change, and never as a conflict", () => {
  function diffWith(reordered: FullSyncDiff["objects"]["reordered"]): FullSyncDiff {
    return {
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered },
      stories: { newStories: [], changedStories: [], missingStories: [] },
      config: { changedFields: [], versionChange: null },
      glossary: { added: [], changed: [], removed: [] },
      hasConflicts: false,
      classification: "three-way",
      suppressedEditorOnly: 0,
      unreadableFiles: [],
    };
  }
  const REORDER = { order: [{ objectId: "b", docId: 2 }, { objectId: "a", docId: 1 }] };

  it("makes a head that only reorders objects divergent for the status refresh", () => {
    expect(hasDivergentChanges(diffWith(REORDER))).toBe(true);
    expect(hasDivergentChanges(diffWith(null))).toBe(false);
  });

  it("gives the full sync's dialog something to apply", () => {
    expect(hasDiffChanges(diffWith(REORDER))).toBe(true);
    expect(hasDiffChanges(diffWith(null))).toBe(false);
  });

  it("is counted once among the changed items", () => {
    expect(aggregateSyncDiff(diffWith(REORDER))).toEqual({ added: 0, changed: 1, removed: 0 });
  });

  it("is not a conflict", () => {
    expect(hasConflictItems(diffWith(REORDER))).toBe(false);
  });
});
