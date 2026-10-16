/**
 * The syncs make the Compositor's object order GitHub's.
 *
 * The check lists a reorder of the rows both sides hold (`SyncDiff.reordered`),
 * with or without a base, and every path that records GitHub's head as read
 * applies GitHub's order first, or does not record while a reorder is pending:
 * the full sync sends it as `objects.order`. A row a
 * sync brings in is placed where GitHub's file has it (`objects.sheet`). A
 * superseded order entry leaves the commit unread.
 *
 * @version v1.5.5-beta
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
import { hasDiffChanges } from "~/components/features/dashboard/sync-changes";
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
// The counts
// ---------------------------------------------------------------------------

describe("a reorder counts as a change", () => {
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
});
