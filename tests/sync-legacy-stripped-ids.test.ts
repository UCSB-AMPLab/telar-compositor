/**
 * A project imported before object ids were read as written holds a padded id
 * stripped: D1 has `o1` where GitHub's objects.csv has `o1  `. Both syncs pair
 * the two as one object when the pairing is unambiguous (one D1 row holds the
 * stripped id, one GitHub spelling strips to it, and no GitHub row claims that
 * D1 id exactly), so the check shows neither a removal nor an addition, and an
 * accepted change to the object takes GitHub's spelling. Where it is ambiguous,
 * nothing is paired but exact ids.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
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
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
    // Every commit named here exists; a read that fails at one is a failed read.
    commitExists: vi.fn(async () => "exists"),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { buildPublishFileSet } from "~/lib/publish.server";
import {
  applyFullSyncChanges,
  computeFullSyncDiff,
  applyGitHubObjectOrder,
  applySyncChanges,
  checkRepairingLegacyIds,
  computeSyncDiff,
  resolveFullSyncPayload,
  type FullSyncChanges,
  type SyncChanges,
} from "~/lib/sync.server";
import { legacyStrippedIds } from "~/lib/objects.server";
import { ObjectsSheetChanged, prepareObjectsCommit } from "~/lib/pending-object-ops.server";
import { legacyRecordRef, markLegacyIdsRepaired } from "~/lib/legacy-object-ids.server";
import { dbObjectToCsvRow, serializeObjectsCsv } from "~/lib/csv-export.server";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { orderedMaps } from "~/lib/field-order";
import { PROJECT_ID, SECRET, buildDoc, seedProject } from "./helpers/collaboration-fixture";
import { readSeenFrom, withChoicesSeen } from "./helpers/object-update-seen";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const OBJECTS_CSV = "telar-content/spreadsheets/objects.csv";
/** A commit GitHub holds, at which every read fails. */
const UNREADABLE = "e".repeat(40);
const USER = 1;

/** GitHub's objects.csv, unchanged since the import: `o1` written with trailing spaces. */
const PADDED = 'object_id,title\n"o1  ",Map\n';
const PADDED_EDITED = 'object_id,title\n"o1  ",Map of the coast\n';
/** Both spellings on GitHub. */
const BOTH = 'object_id,title\no1,Map\n"o1  ",Other map\n';

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sheets: Record<string, string>;

function objectRows(): Array<{ id: number; object_id: string; title: string | null }> {
  return memory.raw.prepare("SELECT id, object_id, title FROM objects ORDER BY id").all() as never;
}

function changes(overrides: Partial<SyncChanges> = {}): SyncChanges {
  return withChoicesSeen({
    newObjectIds: [],
    changedObjectIds: ["o1"],
    fieldChoices: { o1: { title: "repo" } },
    changedDocIds: { o1: 1 },
    removedObjectIds: [],
    unregisteredObjectIds: [],
    headSha: HEAD,
    ...overrides,
  });
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

async function loadRealDo(): Promise<{ ydoc: Y.Doc; env: Env; doInstance: ProjectCollaborationDO }> {
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(buildDoc(true), PROJECT_ID);
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
  readSeenFrom((doInstance as unknown as { ydoc: Y.Doc }).ydoc);
  return { ydoc: (doInstance as unknown as { ydoc: Y.Doc }).ydoc, env, doInstance };
}

/** A second object, `o2`, after `o1` in D1 and in the document. */
function addSecondObject(ydoc: Y.Doc): void {
  memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (2, ${PROJECT_ID}, 'o2', 'a00002', 'Two')`);
  const m = new Y.Map<unknown>();
  ydoc.transact(() => {
    m.set("_id", 2);
    m.set("object_id", "o2");
    m.set("order_key", "a00002");
    m.set("title", new Y.Text("Two"));
    m.set("_validation_state", "valid");
    ydoc.getArray<Y.Map<unknown>>("objects").push([m]);
  }, null);
}

async function postIngest(doInstance: ProjectCollaborationDO, body: unknown): Promise<Record<string, unknown>> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, SECRET, "ingest-sync");
  const res = await doInstance.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function docObject(ydoc: Y.Doc): { objectId: string; title: string } {
  const m = ydoc.getArray<Y.Map<unknown>>("objects").get(0);
  return { objectId: String(m.get("object_id")), title: String(m.get("title")) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  readSeenFrom(null);
  memory = createMemoryD1();
  seedProject(memory, "text");
  memory.raw.exec("UPDATE objects SET title = 'Map' WHERE id = 1");
  memory.raw.prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ? WHERE id = ?").run(BASE, BASE, PROJECT_ID);
  db = drizzle(asD1(memory), { schema });
  sheets = { [BASE]: PADDED, [HEAD]: PADDED };
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) => {
    if (ref === UNREADABLE) return { status: "error" };
    return path === OBJECTS_CSV && sheets[ref] !== undefined ? { status: "ok", content: sheets[ref] } : { status: "absent" };
  });
});

afterEach(() => {
  memory.close();
});

/** D1's object ids. */
const held = (...ids: string[]) => ids;

describe("legacyStrippedIds", () => {
  it("pairs a GitHub id with the one D1 id its stripped form equals, where the recorded version spells it padded", () => {
    expect(legacyStrippedIds(["o1  ", "o2"], held("o1", "o2"), ["o1  ", "o2"])).toEqual(new Map([["o1  ", "o1"]]));
  });

  it("pairs nothing where the recorded version spells it stripped: GitHub changed the id", () => {
    expect(legacyStrippedIds(["o1  "], held("o1"), ["o1"])).toEqual(new Map());
  });

  it("pairs nothing where the recorded version held both spellings, two objects", () => {
    expect(legacyStrippedIds(["o1  "], held("o1"), ["o1", "o1  "])).toEqual(new Map());
  });

  it("pairs nothing where the recorded version does not hold it at all", () => {
    expect(legacyStrippedIds(["o1  "], held("o1"), [])).toEqual(new Map());
  });

  it("pairs nothing with no readable recorded version", () => {
    expect(legacyStrippedIds(["o1  "], held("o1"), null)).toEqual(new Map());
  });

  it("pairs nothing where GitHub also holds the D1 id exactly", () => {
    expect(legacyStrippedIds(["o1", "o1  "], held("o1"), ["o1  "])).toEqual(new Map());
  });

  it("pairs nothing where two GitHub spellings strip to the D1 id", () => {
    expect(legacyStrippedIds(["o1  ", " o1"], held("o1"), ["o1  ", " o1"])).toEqual(new Map());
  });

  it("pairs nothing where two D1 rows hold the stripped id", () => {
    expect(legacyStrippedIds(["o1  "], held("o1", "o1"), ["o1  "])).toEqual(new Map());
  });

  it("pairs one GitHub spelling written in two rows", () => {
    expect(legacyStrippedIds(["o1  ", "o1  "], held("o1"), ["o1  "])).toEqual(new Map([["o1  ", "o1"]]));
  });
});

describe("the objects check pairs an id stored stripped with GitHub's padded spelling", () => {
  it("two-way: shows no removal and no addition", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, undefined, HEAD, true, { d1: null }, BASE);
    expect(diff.newObjects).toEqual([]);
    expect(diff.missingObjects).toEqual([]);
    expect(diff.changedObjects).toEqual([]);
  });

  it("three-way: shows no removal and no addition", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, PADDED, HEAD, true, { d1: null }, BASE);
    expect(diff.newObjects).toEqual([]);
    expect(diff.missingObjects).toEqual([]);
    expect(diff.changedObjects).toEqual([]);
  });

  it("shows a change GitHub made to the object as a change to D1's row", async () => {
    sheets[HEAD] = PADDED_EDITED;
    const diff = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, PADDED, HEAD, true, { d1: null }, BASE);
    expect(diff.newObjects).toEqual([]);
    expect(diff.missingObjects).toEqual([]);
    expect(diff.changedObjects).toMatchObject([
      { object_id: "o1", dbId: 1, changedFields: ["title"], repoValues: { title: "Map of the coast" } },
    ]);
  });

  it("three-way: lists the rows it pairs, for the repair", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, PADDED, HEAD, true, { d1: null }, BASE);
    expect(diff.respelled).toEqual([{ objectId: "o1", docId: 1, githubId: "o1  " }]);
  });

  // The recorded version holds `o1`, and GitHub now holds `o1  `.
  it("shows GitHub's change of `o1` to `o1  ` as the change it is, where the recorded version holds `o1`", async () => {
    const recorded = "object_id,title\no1,Map\n";
    sheets[BASE] = recorded;
    const threeWay = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, recorded, HEAD, true, { d1: null }, BASE);
    expect(threeWay.respelled).toBeUndefined();
    expect(threeWay.newObjects.map((o) => o.object_id)).toEqual(["o1  "]);
    expect(threeWay.missingObjects.map((o) => o.object_id)).toEqual(["o1"]);

    const twoWay = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, undefined, HEAD, true, { d1: null }, BASE);
    expect(twoWay.respelled).toBeUndefined();
    expect(twoWay.newObjects.map((o) => o.object_id)).toEqual(["o1  "]);
  });

  // A recorded commit lost to a force push leaves nothing to tell GitHub's
  // edit of the id from the old import's error.
  it("with no readable recorded version, pairs nothing, shows the addition and the removal, and says so", async () => {
    const diff = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, undefined, HEAD, true, { d1: null }, null);
    expect(diff.respelled).toBeUndefined();
    expect(diff.legacyUnjudged).toBe(true);
    expect(diff.newObjects.map((o) => o.object_id)).toEqual(["o1  "]);
    expect(diff.missingObjects.map((o) => o.object_id)).toEqual(["o1"]);
  });

  it("with both spellings on GitHub, pairs `o1` exactly and lists `o1  ` as new", async () => {
    sheets[HEAD] = BOTH;
    const diff = await computeSyncDiff(PROJECT_ID, "t", "o", "r", db, undefined, HEAD, true, { d1: null }, BASE);
    expect(diff.missingObjects).toEqual([]);
    expect(diff.changedObjects).toEqual([]);
    expect(diff.newObjects.map((o) => o.object_id)).toEqual(["o1  "]);
  });
});

describe("an accepted change to a paired object takes GitHub's spelling", () => {
  beforeEach(() => {
    sheets[HEAD] = PADDED_EDITED;
  });

  it("the objects page's apply renames the object in the document and in D1", async () => {
    const { ydoc, env } = await loadRealDo();

    const res = await applySyncChanges(PROJECT_ID, changes(), "t", "o", "r", db, env, USER);

    expect(res).toMatchObject({ appliedCount: 1, updateSkipped: false, notAdded: [] });
    expect(docObject(ydoc)).toEqual({ objectId: "o1  ", title: "Map of the coast" });
    expect(objectRows()).toEqual([{ id: 1, object_id: "o1  ", title: "Map of the coast" }]);
  });

  it("the objects page's apply orders the renamed row under its new spelling", async () => {
    sheets[HEAD] = 'object_id,title\no2,Two\n"o1  ",Map of the coast\n';
    const { ydoc, env } = await loadRealDo();
    addSecondObject(ydoc);

    const res = await applySyncChanges(PROJECT_ID, changes(), "t", "o", "r", db, env, USER);

    expect(res).toMatchObject({ appliedCount: 1, updateSkipped: false });
    expect(orderedMaps(ydoc.getArray("objects")).map((m) => String(m.get("object_id")))).toEqual(["o2", "o1  "]);
  });

  it("the full sync orders the renamed row under its new spelling", async () => {
    sheets[HEAD] = 'object_id,title\no2,Two\n"o1  ",Map of the coast\n';
    memory.raw.exec(`INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (2, ${PROJECT_ID}, 'o2', 'a00002', 'Two')`);
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER, HEAD);
    expect(payload.objects.order).toEqual([{ objectId: "o2", docId: 2 }, { objectId: "o1  ", docId: 1 }]);
  });

  it("the full sync sends the rename with the update", async () => {
    const { payload } = await resolveFullSyncPayload(PROJECT_ID, fullChanges(), "t", "o", "r", db, USER, HEAD);
    expect(payload.objects.update).toEqual([
      { objectId: "o1", docId: 1, fields: { title: "Map of the coast" }, renameTo: "o1  ", seen: { title: null } },
    ]);
    expect(payload.objects.remove).toEqual([]);
    expect(payload.objects.insert).toEqual([]);
  });
});

// Nothing changed but the spelling, so nothing is offered, and the
// row must still take GitHub's spelling before a publish writes D1's.
/** The commit legacy pairing is judged against, as the routes take it from the project row. */
function recordRef(): string | null {
  return legacyRecordRef(
    memory.raw.prepare("SELECT objects_read_sha, head_sha FROM projects WHERE id = ?").get(PROJECT_ID) as {
      objects_read_sha: string | null; head_sha: string | null;
    },
  );
}

/** When the project's ids were repaired (migration 0063), null for not yet. */
function repairedAt(): string | null {
  return (memory.raw.prepare("SELECT legacy_ids_repaired_at AS at FROM projects WHERE id = ?").get(PROJECT_ID) as { at: string | null }).at;
}

/**
 * The first sync check an author starts against `recorded`: two-way, with the
 * record only as the legacy evidence, or three-way against it, as both sync
 * dialogs run it.
 */
function firstCheck(env: Env, recorded: string | null, threeWay = false) {
  return checkRepairingLegacyIds(
    env, PROJECT_ID, USER,
    (legacyRef) => threeWay
      ? computeSyncDiff(PROJECT_ID, "t", "o", "r", db, recorded, HEAD, true, { d1: null }, legacyRef)
      : computeSyncDiff(PROJECT_ID, "t", "o", "r", db, undefined, HEAD, true, { d1: null }, legacyRef),
    (checked) => checked,
    { db, open: repairedAt() === null, ref: recordRef() },
  );
}

describe("a row stored stripped takes GitHub's spelling with nothing offered", () => {
  it("the check repairs it and then shows nothing, and the next publish writes the padded id", async () => {
    const { ydoc, env } = await loadRealDo();

    const diff = await firstCheck(env, PADDED, true);

    expect(diff.respelled).toBeUndefined();
    expect([diff.newObjects, diff.changedObjects, diff.missingObjects]).toEqual([[], [], []]);
    expect(docObject(ydoc).objectId).toBe("o1  ");
    expect(objectRows().map((r) => [r.id, r.object_id])).toEqual([[1, "o1  "]]);
    const row = memory.raw.prepare("SELECT * FROM objects WHERE id = 1").get();
    expect(serializeObjectsCsv([dbObjectToCsvRow(row as never)])).toContain('\n"o1  ",');
    expect(repairedAt()).not.toBeNull();
  });

  /** The dashboard's first check on a project with no head recorded: two-way, with no base. */
  function firstCheckWithNoHead(env: Env) {
    return checkRepairingLegacyIds(
      env, PROJECT_ID, USER,
      (legacyRef) => computeSyncDiff(PROJECT_ID, "t", "o", "r", db, undefined, HEAD, true, { d1: null }, legacyRef),
      (checked) => checked,
      { db, open: repairedAt() === null, ref: recordRef() },
    );
  }

  // An import from before ids were stripped, whose onboarding made no commit has
  // no head recorded, and objects_read_sha, which the import set, writes the
  // id padded. That commit is the record the repair is judged against.
  it("with no head recorded, repairs against objects_read_sha and marks the ids repaired", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = NULL, objects_read_sha = ? WHERE id = ?").run(BASE, PROJECT_ID);
    const { env } = await loadRealDo();

    const diff = await firstCheckWithNoHead(env);

    expect(diff.respelled).toBeUndefined();
    expect(objectRows()[0].object_id).toBe("o1  ");
    expect(repairedAt()).not.toBeNull();
  });

  // With neither commit recorded nothing can be judged: the check pairs
  // nothing, shows GitHub's id beside D1's, and leaves the ids unrepaired. A
  // publish is not refused (the pairing cannot flag the row) and writes D1's
  // stripped id.
  it("with no record to read, marks nothing, and a publish writes D1's id", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = NULL, objects_read_sha = NULL WHERE id = ?").run(PROJECT_ID);
    const { env } = await loadRealDo();

    const diff = await firstCheckWithNoHead(env);

    expect(diff.legacyUnjudged).toBe(true);
    expect(diff.newObjects.map((o) => o.object_id)).toEqual(["o1  "]);
    expect(diff.missingObjects.map((o) => o.object_id)).toEqual(["o1"]);
    expect(objectRows()[0].object_id).toBe("o1");
    expect(repairedAt()).toBeNull();

    // The publish: its preparation, then the objects.csv it assembles from D1.
    const objectsSheet = await prepareObjectsCommit(env, db as never, PROJECT_ID, { token: "t", owner: "o", repo: "r", head: HEAD });
    expect(objectsSheet).toEqual({ path: "telar-content/spreadsheets/objects.csv", existingCsv: PADDED });
    const files = await buildPublishFileSet({
      token: "t", owner: "o", repo: "r", ref: HEAD, projectId: PROJECT_ID,
      env: { DB: asD1(memory) } as unknown as Env, objectsSheet, configYml: null, config: null,
    });
    const written = files.find((file) => file.path === OBJECTS_CSV)?.content ?? "";
    const ids = written.split("\n").slice(2).filter(Boolean).map((line) => line.split(",")[0]);
    expect(ids).toEqual(["o1"]);
  });

  // The record is read only to judge the ids: a read that fails leaves them
  // unjudged, and the check goes on with every id difference an ordinary change.
  it("with a record that cannot be read, goes on unjudged and marks nothing", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = NULL, objects_read_sha = ? WHERE id = ?").run(UNREADABLE, PROJECT_ID);
    const { env } = await loadRealDo();

    const diff = await firstCheckWithNoHead(env);

    expect(diff.legacyUnjudged).toBe(true);
    expect(diff.newObjects.map((o) => o.object_id)).toEqual(["o1  "]);
    expect(diff.missingObjects.map((o) => o.object_id)).toEqual(["o1"]);
    expect(objectRows()[0].object_id).toBe("o1");
    expect(repairedAt()).toBeNull();
  });

  // Where the same commit is the ordinary three-way base, its failed read still
  // refuses the check, as it did before the legacy read existed.
  it("refuses the check where the record that cannot be read is also the three-way base", async () => {
    memory.raw.prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ? WHERE id = ?").run(UNREADABLE, UNREADABLE, PROJECT_ID);
    const { env } = await loadRealDo();

    await expect(
      checkRepairingLegacyIds(
        env, PROJECT_ID, USER,
        (legacyRef) => computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, UNREADABLE, { headRef: HEAD, legacyRef }),
        (checked) => checked.objects,
        { db, open: true, ref: recordRef() },
      ),
    ).rejects.toBeInstanceOf(SheetUnreadableError);
    expect(repairedAt()).toBeNull();
  });

  it("the first check sets the column when there is nothing to repair", async () => {
    sheets[HEAD] = 'object_id,title\no1,Map\n';
    const { env } = await loadRealDo();
    await firstCheck(env, 'object_id,title\no1,Map\n');
    expect(repairedAt()).not.toBeNull();
  });

  it("a repair that does not land leaves the column unset", async () => {
    const env = supersedingEnv();
    const diff = await firstCheck(env, PADDED);
    expect(diff.respelled).toEqual([{ objectId: "o1", docId: 1, githubId: "o1  " }]);
    expect(repairedAt()).toBeNull();
  });

  it("once the column is set, a padded GitHub id shows as a change", async () => {
    memory.raw.prepare("UPDATE projects SET legacy_ids_repaired_at = '2026-09-30' WHERE id = ?").run(PROJECT_ID);
    const { ydoc, env } = await loadRealDo();

    const diff = await firstCheck(env, PADDED);

    expect(diff.respelled).toBeUndefined();
    expect(diff.newObjects.map((o) => o.object_id)).toEqual(["o1  "]);
    expect(diff.missingObjects.map((o) => o.object_id)).toEqual(["o1"]);
    expect(docObject(ydoc).objectId).toBe("o1");
  });

  it("once the column is set, the applies pair nothing", async () => {
    memory.raw.prepare("UPDATE projects SET legacy_ids_repaired_at = '2026-09-30' WHERE id = ?").run(PROJECT_ID);
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, fullChanges({ changedObjectIds: [], fieldChoices: {}, changedDocIds: {} }), "t", "o", "r", db, USER, HEAD,
    );
    expect(payload.objects.update).toEqual([]);

    const { env } = await loadRealDo();
    await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: [], fieldChoices: {}, changedDocIds: {} }), "t", "o", "r", db, env, USER,
    );
    expect(objectRows()[0].object_id).toBe("o1");
  });

  it("the objects page's apply gives it GitHub's spelling though no field was accepted", async () => {
    const { env } = await loadRealDo();

    const res = await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: [], fieldChoices: {}, changedDocIds: {} }), "t", "o", "r", db, env, USER,
    );

    expect(res).toMatchObject({ appliedCount: 0, updateSkipped: false });
    expect(objectRows()[0].object_id).toBe("o1  ");
  });

  it("the full sync gives it GitHub's spelling though no field was accepted", async () => {
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, fullChanges({ changedObjectIds: [], fieldChoices: {}, changedDocIds: {} }), "t", "o", "r", db, USER, HEAD,
    );
    expect(payload.objects.update).toEqual([{ objectId: "o1", docId: 1, fields: {}, renameTo: "o1  " }]);
  });

  it("the full sync leaves the id alone where the recorded version holds it stripped", async () => {
    sheets[BASE] = "object_id,title\no1,Map\n";
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, fullChanges({ changedObjectIds: [], fieldChoices: {}, changedDocIds: {} }), "t", "o", "r", db, USER, HEAD,
    );
    expect(payload.objects.update).toEqual([]);
  });

  it("the objects page's apply leaves the id alone with no readable recorded version", async () => {
    const { env } = await loadRealDo();

    memory.raw.prepare("UPDATE projects SET head_sha = NULL, objects_read_sha = NULL WHERE id = ?").run(PROJECT_ID);
    await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: [], fieldChoices: {}, changedDocIds: {} }), "t", "o", "r", db, env, USER,
    );

    expect(objectRows()[0].object_id).toBe("o1");
  });

  it("the objects page's apply leaves the id alone where the recorded version holds it stripped", async () => {
    const { env } = await loadRealDo();

    sheets[BASE] = "object_id,title\no1,Map\n";
    await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: [], fieldChoices: {}, changedDocIds: {} }), "t", "o", "r", db, env, USER,
    );

    expect(objectRows()[0].object_id).toBe("o1");
  });
});

/** A collaboration binding that answers every object update as re-created since the check. */
function supersedingEnv(): Env {
  const answer = { applied: {}, skipped: { objectUpdate: ["o1"] }, superseded: { objectUpdate: ["o1"] } };
  return {
    SESSION_SECRET: SECRET,
    COLLABORATION: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json(answer) }) },
  } as unknown as Env;
}

// A respelling that does not land leaves the row stripped, so neither apply may
// record the commit as read: the next publish would write D1's spelling.
describe("an apply whose respelling does not land records nothing", () => {
  it("the objects page's apply answers the object edited here, which keeps objects_read_sha", async () => {
    const res = await applySyncChanges(
      PROJECT_ID, changes({ changedObjectIds: [], fieldChoices: {}, changedDocIds: {} }), "t", "o", "r", db, supersedingEnv(), USER,
    );
    expect(res).toMatchObject({ updateSkipped: true, changedSinceReview: ["o1"] });
    expect(memory.raw.prepare("SELECT objects_read_sha FROM projects WHERE id = ?").get(PROJECT_ID))
      .toEqual({ objects_read_sha: BASE });
  });

  it("the full sync refuses the object as edited here, which keeps head_sha", async () => {
    await expect(applyFullSyncChanges(
      PROJECT_ID, fullChanges({ changedObjectIds: [], fieldChoices: {}, changedDocIds: {} }), "t", "o", "r", db, USER, supersedingEnv(),
    )).rejects.toMatchObject({ name: "ObjectsChangedSinceReview", objectIds: ["o1"] });
    expect(memory.raw.prepare("SELECT head_sha FROM projects WHERE id = ?").get(PROJECT_ID)).toEqual({ head_sha: BASE });
  });
});

describe("the document takes a rename only as GitHub's spelling of the same id", () => {
  it.each([
    ["another id", "o2"],
    ["a blank id", "   "],
    ["the same id", "o1"],
    ["a value that is not text", 7],
  ])("refuses %s", async (_, renameTo) => {
    const { ydoc, doInstance } = await loadRealDo();
    const answer = await postIngest(doInstance, {
      objects: { update: [{ objectId: "o1", docId: 1, fields: {}, renameTo }], insert: [], remove: [] },
    });
    expect(answer).toMatchObject({ refused: { objectUpdate: [0] } });
    expect(docObject(ydoc).objectId).toBe("o1");
  });

  it("takes GitHub's spelling", async () => {
    const { ydoc, doInstance } = await loadRealDo();
    await postIngest(doInstance, {
      objects: { update: [{ objectId: "o1", docId: 1, fields: {}, renameTo: "o1  " }], insert: [], remove: [] },
    });
    expect(docObject(ydoc).objectId).toBe("o1  ");
    expect(objectRows()[0].object_id).toBe("o1  ");
  });
});

// A publish, like an objects commit, writes objects.csv from D1. Before the
// project's first sync check has repaired its ids, a row D1 holds stripped
// where GitHub and the recorded head write it padded is refused, and the
// author is sent to the sync; after it, D1's ids are written as they are.
describe("a publish and a row D1 holds under a stripped id", () => {
  const publishAt = (env: Env) =>
    prepareObjectsCommit(env, db as never, PROJECT_ID, { token: "t", owner: "o", repo: "r", head: HEAD });

  it("before the first check, is refused and sent to the sync", async () => {
    const { env } = await loadRealDo();
    await expect(publishAt(env)).rejects.toBeInstanceOf(ObjectsSheetChanged);
    expect(objectRows()[0].object_id).toBe("o1");
  });

  it("once the column is set, goes on and writes D1's ids", async () => {
    memory.raw.prepare("UPDATE projects SET legacy_ids_repaired_at = '2026-09-30' WHERE id = ?").run(PROJECT_ID);
    const { env } = await loadRealDo();
    await expect(publishAt(env)).resolves.toEqual({ path: "telar-content/spreadsheets/objects.csv", existingCsv: PADDED });
    expect(objectRows()[0].object_id).toBe("o1");
  });

  // The recorded version holds `o1`, GitHub changes the id to
  // `o1  `, and the author keeps their version. Keep my version counts as the
  // project's first check (the dashboard marks the ids repaired once it has
  // recorded the head), so the check after it shows GitHub's edit as a change,
  // and the publish writes the author's `o1`.
  it("after Keep my version on a GitHub id edit, keeps the author's id through a check and a publish", async () => {
    sheets[BASE] = "object_id,title\no1,Map\n";
    const { ydoc, env } = await loadRealDo();

    // Keep my version, as the dashboard runs it.
    expect(await applyGitHubObjectOrder(PROJECT_ID, { token: "t", owner: "o", repo: "r" }, HEAD, BASE, db, env, USER))
      .toEqual({ superseded: false });
    memory.raw.prepare("UPDATE projects SET head_sha = ?, objects_read_sha = ? WHERE id = ?").run(HEAD, HEAD, PROJECT_ID);
    await markLegacyIdsRepaired(db, PROJECT_ID);
    expect(objectRows()[0].object_id).toBe("o1");

    // The sync check after it, against the head it recorded.
    const diff = await firstCheck(env, PADDED);
    expect(diff.respelled).toBeUndefined();
    expect(diff.newObjects.map((o) => o.object_id)).toEqual(["o1  "]);
    expect(diff.missingObjects.map((o) => o.object_id)).toEqual(["o1"]);
    expect(docObject(ydoc).objectId).toBe("o1");

    // The publish.
    await expect(publishAt(env)).resolves.toEqual({ path: "telar-content/spreadsheets/objects.csv", existingCsv: PADDED });
    const row = memory.raw.prepare("SELECT * FROM objects WHERE id = 1").get();
    expect(serializeObjectsCsv([dbObjectToCsvRow(row as never)])).toMatch(/\no1,/);
  });
});
