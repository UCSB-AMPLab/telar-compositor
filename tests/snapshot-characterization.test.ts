/**
 * Golden-master characterization tests for `doSnapshot` (workers/collaboration.ts).
 *
 * These pin the exact ordered stream of D1 WRITE operations (standalone `.run()`
 * calls and the contents of the final `DB.batch([...])`) that a snapshot emits,
 * for a set of representative Y.Doc states. The golden `.snap` file is generated
 * against the CURRENT code and committed; the collaboration.ts refactor must
 * reproduce it byte-for-byte. If a snapshot changes, the refactor changed
 * behaviour and is wrong.
 *
 * Reads (`.all()` SELECTs) are NOT recorded — only writes, which is what
 * "byte-identical D1 writes" means. The yjs_state blob's binary bind is
 * normalised to a marker (its bytes depend on Y.Doc clientID randomness and are
 * out of scope for this refactor, which never touches blob encoding); its SQL
 * and position in the stream ARE pinned.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

// Mock the cloudflare:workers DurableObject base so the import resolves in Node
// and the constructor stores ctx/env on `this` (mirrors collaboration-do.test.ts).
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

import { ProjectCollaborationDO } from "../workers/collaboration";

const TEST_PROJECT_ID = 42;

// ---------------------------------------------------------------------------
// Seed: what the SELECTs in doSnapshot resolve to. Drives orphan detection.
// ---------------------------------------------------------------------------
interface Seed {
  storyIds: number[];                 // SELECT id FROM stories WHERE project_id
  stepIdsByStory: Map<number, number[]>;  // SELECT id FROM steps WHERE story_id
  layerIdsByStep: Map<number, number[]>;  // SELECT id FROM layers WHERE step_id
  objectIds: number[];                // SELECT id FROM objects WHERE project_id
  glossaryIds: number[];              // SELECT id FROM glossary_terms WHERE project_id
  pageIds: number[];                  // SELECT id FROM project_pages WHERE project_id
  members: Array<{ user_id: number; contributions: string | null }>;
  // Human-key maps (id ← human key) for the adopt-or-reinsert SELECTs that now
  // also fetch the key column. Optional; absent → keys resolve to null.
  storyKeyToId?: Map<string, number>;   // story_id -> id
  objectKeyToId?: Map<string, number>;  // object_id -> id
  glossaryKeyToId?: Map<string, number>;// term_id -> id
  pageKeyToId?: Map<string, number>;    // slug -> id
  // Singleton-row existence for the config/landing UPSERT SELECT-guard. Default
  // (undefined) → the row EXISTS (the `.first()` returns a stub) so the snapshot
  // takes the UPDATE path, matching every pre-existing scenario.
  configMissing?: boolean;
  landingMissing?: boolean;
}

function emptySeed(): Seed {
  return {
    storyIds: [],
    stepIdsByStory: new Map(),
    layerIdsByStep: new Map(),
    objectIds: [],
    glossaryIds: [],
    pageIds: [],
    members: [],
  };
}

// ---------------------------------------------------------------------------
// Normalisation: make binds deterministic + serialisable for the golden file.
// ---------------------------------------------------------------------------
function normaliseBind(v: unknown): unknown {
  if (v instanceof Uint8Array) return `<uint8array:${v.byteLength > 0 ? "nonempty" : "empty"}>`;
  return v;
}

type RecordedOp =
  | { op: "run"; sql: string; binds: unknown[] }
  | { op: "batch"; statements: Array<{ sql: string; binds: unknown[] }> };

interface RecordingStmt {
  sql: string;
  boundArgs: unknown[];
  bind(...args: unknown[]): RecordingStmt;
  run(): Promise<{ meta: { last_row_id: number }; success: true }>;
  all<T = unknown>(): Promise<{ results: T[]; success: true }>;
  first<T = unknown>(): Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Recording D1: records the SQL+binds of every `.run()` and every statement
// inside `.batch([...])`, in execution order. `.all()` resolves from the seed.
// `.batch()` succeeds (returns one success row per statement). Set
// `failBatch: true` to make `.batch()` reject (batch-failure scenario).
// ---------------------------------------------------------------------------
function makeRecordingDb(
  seed: Seed,
  opts: {
    failBatch?: boolean;
    // Fault injection: when this returns true for a `.run()`, that statement
    // throws (simulating a constraint failure) WITHOUT the mock pretending to be
    // SQLite. Lets crash-proofing/fallback tests target a specific INSERT.
    failRunMatching?: (sql: string, binds: unknown[]) => boolean;
  } = {},
) {
  const ops: RecordedOp[] = [];
  let lastRowId = 1000;
  let batchCalls = 0;

  // id -> human-key reverse lookups for the SELECTs that now also fetch the key.
  function reverse(map?: Map<string, number>): Map<number, string> {
    const out = new Map<number, string>();
    if (map) for (const [k, v] of map) out.set(v, k);
    return out;
  }
  const storyIdToKey = reverse(seed.storyKeyToId);
  const objectIdToKey = reverse(seed.objectKeyToId);
  const glossaryIdToKey = reverse(seed.glossaryKeyToId);
  const pageIdToKey = reverse(seed.pageKeyToId);

  // Regexes tolerate the optional human-key column the adopt-or-reinsert code
  // adds (e.g. `SELECT id, story_id FROM stories …`). The SELECT text is NOT
  // recorded in the golden snapshot, so this change is invisible to it.
  function resolveSelect(sql: string, binds: unknown[]): { results: unknown[] } {
    if (/SELECT id(?:, story_id)? FROM stories WHERE project_id/.test(sql)) {
      return { results: seed.storyIds.map((id) => ({ id, story_id: storyIdToKey.get(id) ?? null })) };
    }
    if (/SELECT id FROM steps WHERE story_id/.test(sql)) {
      const storyId = binds[0] as number;
      return { results: (seed.stepIdsByStory.get(storyId) ?? []).map((id) => ({ id })) };
    }
    if (/SELECT id FROM layers WHERE step_id/.test(sql)) {
      const stepId = binds[0] as number;
      return { results: (seed.layerIdsByStep.get(stepId) ?? []).map((id) => ({ id })) };
    }
    if (/SELECT id(?:, object_id)? FROM objects WHERE project_id/.test(sql)) {
      return { results: seed.objectIds.map((id) => ({ id, object_id: objectIdToKey.get(id) ?? null })) };
    }
    if (/SELECT id(?:, term_id)? FROM glossary_terms WHERE project_id/.test(sql)) {
      return { results: seed.glossaryIds.map((id) => ({ id, term_id: glossaryIdToKey.get(id) ?? null })) };
    }
    if (/SELECT id(?:, slug)? FROM project_pages WHERE project_id/.test(sql)) {
      return { results: seed.pageIds.map((id) => ({ id, slug: pageIdToKey.get(id) ?? null })) };
    }
    if (/SELECT user_id, contributions FROM project_members/.test(sql)) {
      return { results: seed.members };
    }
    return { results: [] };
  }

  function prepare(sql: string): RecordingStmt {
    const stmt: RecordingStmt = {
      sql,
      boundArgs: [],
      bind(...args: unknown[]) {
        stmt.boundArgs = args;
        return stmt;
      },
      async run() {
        if (opts.failRunMatching?.(sql, stmt.boundArgs)) {
          throw new Error("UNIQUE constraint failed (injected)");
        }
        ops.push({ op: "run", sql, binds: stmt.boundArgs.map(normaliseBind) });
        // An explicit-id INSERT (`INSERT INTO <t> (id, …)`) reports its explicit
        // id as last_row_id (real-SQLite semantics); autoincrement uses the
        // counter.
        const explicitId = /^INSERT INTO \w+ \(id,/.test(sql) ? Number(stmt.boundArgs[0]) : null;
        const rid = explicitId !== null && Number.isFinite(explicitId) ? explicitId : (lastRowId += 1);
        return { meta: { last_row_id: rid }, success: true as const };
      },
      async all<T = unknown>() {
        return { results: resolveSelect(sql, stmt.boundArgs).results as T[], success: true as const };
      },
      async first<T = unknown>() {
        // Singleton existence for the config/landing UPSERT SELECT-guard. Default
        // (flag undefined) → the row exists, so the snapshot UPDATEs (matching
        // every pre-existing scenario).
        if (/SELECT id FROM project_config WHERE project_id/.test(sql)) {
          return (seed.configMissing ? null : { id: 1 }) as T | null;
        }
        if (/SELECT id FROM project_landing WHERE project_id/.test(sql)) {
          return (seed.landingMissing ? null : { id: 1 }) as T | null;
        }
        return null as T | null;
      },
    };
    return stmt;
  }

  const DB = {
    prepare,
    async batch(statements: RecordingStmt[]) {
      batchCalls += 1;
      if (opts.failBatch) throw new Error("simulated transient D1 batch failure");
      ops.push({
        op: "batch",
        statements: statements.map((s) => ({ sql: s.sql, binds: s.boundArgs.map(normaliseBind) })),
      });
      return statements.map(() => ({ success: true }));
    },
  };

  return {
    DB,
    ops,
    batchCallCount: () => batchCalls,
    blobRunCount: () =>
      ops.filter((o) => o.op === "run" && /UPDATE projects SET yjs_state/.test(o.sql)).length,
  };
}

// ctx stub: no sockets (constructor skips hibernation recovery), alarm store.
function makeCtx() {
  const alarms: number[] = [];
  return {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => (alarms.length ? alarms[alarms.length - 1] : null),
      setAlarm: async (t: number) => { alarms.push(t); },
    },
    acceptWebSocket: vi.fn(),
  };
}

// Build a snapshot-ready DO: projectId set, docLoaded, seed-backed DB.
function makeDo(
  seed: Seed,
  opts: { failBatch?: boolean; failRunMatching?: (sql: string, binds: unknown[]) => boolean } = {},
) {
  const db = makeRecordingDb(seed, opts);
  const env = { DB: db.DB as unknown, SESSION_SECRET: "test", COLLABORATION: {} as unknown };
  const ctx = makeCtx();
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  (doInstance as unknown as { docLoaded: boolean }).docLoaded = true;
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  return { doInstance, db, ydoc };
}

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

// --- Y.Doc builders (server-side cold-start shape: null origin) -------------
function makeStory(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id ?? null);
  m.set("story_id", fields.story_id ?? "story-x");
  m.set("title", new Y.Text((fields.title as string) ?? ""));
  m.set("subtitle", new Y.Text((fields.subtitle as string) ?? ""));
  m.set("byline", new Y.Text((fields.byline as string) ?? ""));
  m.set("private", fields.private ?? false);
  m.set("draft", fields.draft ?? false);
  m.set("show_sections", fields.show_sections ?? false);
  m.set("steps", new Y.Array<Y.Map<unknown>>());
  return m;
}

function seedConfig(ydoc: Y.Doc) {
  const config = ydoc.getMap<unknown>("config");
  ydoc.transact(() => {
    config.set("title", new Y.Text("Demo"));
    config.set("description", new Y.Text("Desc"));
    config.set("author", new Y.Text("Author"));
    config.set("email", new Y.Text("a@b.c"));
    config.set("lang", "en");
  }, null);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("doSnapshot characterization — Scenario 1: all-existing entities", () => {
  it("pins the D1-write stream for a doc whose entities all have real _id", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      const stories = ydoc.getArray<Y.Map<unknown>>("stories");
      stories.push([makeStory({ _id: 11, story_id: "s1", title: "Story One" })]);
    }, null);

    await snapshot(doInstance);

    // No INSERTs (all entities existing); blob written once standalone; one batch.
    expect(db.ops.filter((o) => o.op === "run")).toHaveLength(1); // blob only
    expect(db.blobRunCount()).toBe(1);
    expect(db.batchCallCount()).toBe(1);
    expect(db.ops).toMatchSnapshot();
  });
});

describe("doSnapshot characterization — Scenario 2: new entities (INSERT + backfill)", () => {
  it("pins the interleaved INSERT/run() stream and blob-after-inserts ordering", async () => {
    const seed = emptySeed(); // nothing in D1 yet
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);

    ydoc.transact(() => {
      // New story with a new step + new layer. NOTE: in Yjs 13.6.30, reading a
      // nested shared type (`.get("layers")`) from a DETACHED Y.Map returns
      // undefined — each parent must be integrated into the doc before its
      // nested types are read. So we push-then-read at each level.
      const story = makeStory({ _id: null, story_id: "new-s", title: "New Story" });
      ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
      const steps = story.get("steps") as Y.Array<Y.Map<unknown>>;
      const step = new Y.Map<unknown>();
      step.set("_id", null);
      step.set("step_number", 0); // overwritten from Y.Array index on INSERT
      step.set("kind", "text");
      step.set("layers", new Y.Array<Y.Map<unknown>>());
      steps.push([step]);
      const layers = step.get("layers") as Y.Array<Y.Map<unknown>>;
      const layer = new Y.Map<unknown>();
      layer.set("_id", null);
      layer.set("layer_number", 0); // overwritten from Y.Array index on INSERT
      layer.set("title", new Y.Text("Layer"));
      layers.push([layer]);

      // New object.
      const obj = new Y.Map<unknown>();
      obj.set("_id", null);
      obj.set("object_id", "new-o");
      obj.set("title", new Y.Text("Obj"));
      ydoc.getArray<Y.Map<unknown>>("objects").push([obj]);

      // New glossary term.
      const term = new Y.Map<unknown>();
      term.set("_id", null);
      term.set("term_id", "new-t");
      term.set("title", new Y.Text("Term"));
      term.set("definition", new Y.Text("Def"));
      ydoc.getArray<Y.Map<unknown>>("glossary").push([term]);

      // New page.
      const page = new Y.Map<unknown>();
      page.set("_id", null);
      page.set("slug", "new-p");
      page.set("title", new Y.Text("Page"));
      page.set("body", new Y.Text("Body"));
      ydoc.getArray<Y.Map<unknown>>("pages").push([page]);
    }, null);

    await snapshot(doInstance);

    // INSERTs ran standalone; the blob run() comes AFTER all INSERT run()s.
    const runSqls = db.ops.filter((o) => o.op === "run").map((o) => (o as { sql: string }).sql);
    const blobIdx = runSqls.findIndex((s) => /UPDATE projects SET yjs_state/.test(s));
    const lastInsertIdx = runSqls.map((s) => /INSERT INTO/.test(s)).lastIndexOf(true);
    expect(lastInsertIdx).toBeGreaterThanOrEqual(0);
    expect(blobIdx).toBeGreaterThan(lastInsertIdx);
    expect(db.batchCallCount()).toBe(1);
    expect(db.ops).toMatchSnapshot();
  });
});

describe("doSnapshot characterization — Scenario 3: cascade delete", () => {
  it("pins the story+steps+layers DELETE statements for an orphaned story", async () => {
    // D1 has story 11 with step 21 and layer 31; the Y.Doc is empty (config only),
    // so story 11 is an orphan and must cascade-delete.
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    seed.layerIdsByStep.set(21, [31]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);

    await snapshot(doInstance);

    // The batch carries the cascade DELETEs.
    const batchOp = db.ops.find((o) => o.op === "batch") as
      | { op: "batch"; statements: Array<{ sql: string }> }
      | undefined;
    expect(batchOp).toBeDefined();
    const batchSqls = batchOp!.statements.map((s) => s.sql);
    expect(batchSqls.some((s) => /DELETE FROM stories WHERE id = \?/.test(s))).toBe(true);
    expect(batchSqls.some((s) => /DELETE FROM steps WHERE story_id/.test(s))).toBe(true);
    expect(batchSqls.some((s) => /DELETE FROM layers WHERE step_id/.test(s))).toBe(true);
    expect(db.ops).toMatchSnapshot();
  });
});

describe("doSnapshot characterization — Scenario 4: contributions + activity", () => {
  it("pins project_members UPDATEs, activity_log INSERTs, and the retention prune", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.members = [{ user_id: 7, contributions: null }];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);

    // Populate userFieldSets directly: user 7 edited stories:11:title. The
    // afterTransaction handler only fires for WebSocket-origin transactions,
    // absent in this harness, so we populate the section-9 trigger maps directly.
    const fieldSets = (doInstance as unknown as { userFieldSets: Map<number, Set<string>> })
      .userFieldSets;
    fieldSets.set(7, new Set(["stories:11:title"]));
    const newSessions = (doInstance as unknown as { newSessions: Set<number> }).newSessions;
    newSessions.add(7);

    await snapshot(doInstance);

    const batchOp = db.ops.find((o) => o.op === "batch") as
      | { op: "batch"; statements: Array<{ sql: string }> }
      | undefined;
    expect(batchOp).toBeDefined();
    const batchSqls = batchOp!.statements.map((s) => s.sql);
    expect(batchSqls.some((s) => /UPDATE project_members SET contributions/.test(s))).toBe(true);
    expect(batchSqls.some((s) => /INSERT INTO activity_log/.test(s))).toBe(true);
    expect(batchSqls.some((s) => /DELETE FROM activity_log/.test(s))).toBe(true);
    expect(db.ops).toMatchSnapshot();
  });
});

describe("doSnapshot characterization — Scenario 5: batch failure defers in-memory mutations", () => {
  it("blob commits, scheduleSnapshot fires, error rethrows, activityEmitted/newSessions unchanged", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.members = [{ user_id: 7, contributions: null }];
    const { doInstance, db, ydoc } = makeDo(seed, { failBatch: true });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);
    const fieldSets = (doInstance as unknown as { userFieldSets: Map<number, Set<string>> })
      .userFieldSets;
    fieldSets.set(7, new Set(["stories:11:title"]));
    const newSessions = (doInstance as unknown as { newSessions: Set<number> }).newSessions;
    newSessions.add(7);

    // Spy on scheduleSnapshot (private) via the instance.
    const scheduleSpy = vi.spyOn(
      doInstance as unknown as { scheduleSnapshot: () => void },
      "scheduleSnapshot",
    );

    await expect(snapshot(doInstance)).rejects.toThrow(/batch failure/);

    // Blob was written standalone before the failing batch.
    expect(db.blobRunCount()).toBe(1);
    expect(db.batchCallCount()).toBe(1);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    // Deferred mutations NOT applied: newSessions still holds 7.
    expect(newSessions.has(7)).toBe(true);
    const activityEmitted = (doInstance as unknown as { activityEmitted: Map<number, Set<string>> })
      .activityEmitted;
    expect(activityEmitted.get(7)?.size ?? 0).toBe(0);
  });
});

describe("doSnapshot characterization — Scenario 6: idempotent re-snapshot", () => {
  it("a second snapshot with no doc change emits no INSERTs and no duplicate activity rows", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.members = [{ user_id: 7, contributions: null }];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);
    const fieldSets = (doInstance as unknown as { userFieldSets: Map<number, Set<string>> })
      .userFieldSets;
    fieldSets.set(7, new Set(["stories:11:title"]));
    (doInstance as unknown as { newSessions: Set<number> }).newSessions.add(7);

    await snapshot(doInstance); // first snapshot — emits activity INSERT
    const firstBatch = db.ops.find((o) => o.op === "batch") as
      | { op: "batch"; statements: Array<{ sql: string }> }
      | undefined;
    expect(firstBatch).toBeDefined();
    const firstActivityInserts = firstBatch!.statements.filter((s) =>
      /INSERT INTO activity_log/.test(s.sql),
    ).length;
    expect(firstActivityInserts).toBe(1); // first snapshot DID emit the activity row

    // Snapshot again on the same DB; inspect only ops appended by the 2nd run.
    const opsBefore = db.ops.length;
    await snapshot(doInstance); // second snapshot — no doc change
    const secondBatch = db.ops
      .slice(opsBefore)
      .find((o) => o.op === "batch") as
      | { op: "batch"; statements: Array<{ sql: string }> }
      | undefined;
    expect(secondBatch).toBeDefined();
    const secondActivityInserts = secondBatch!.statements.filter((s) =>
      /INSERT INTO activity_log/.test(s.sql),
    ).length;
    expect(secondActivityInserts).toBe(0); // activityEmitted suppression holds
  });
});

// ---------------------------------------------------------------------------
// Fix A — stranded entities: a Y.Map whose _id points to a deleted D1 row must
// be re-INSERTed (not a no-op UPDATE). Stories re-INSERT only (no adopt — they
// own FK children); the same-slug collision degrades to caught+logged+stranded.
// ---------------------------------------------------------------------------
describe("doSnapshot Fix A — stranded stories", () => {
  it("re-INSERTs a story whose _id references a missing D1 row (same id, no backfill)", async () => {
    const seed = emptySeed(); // D1 has NO story 452
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 452, story_id: "s452", title: "Restored" }),
      ]);
    }, null);

    await snapshot(doInstance);

    const inserts = db.ops.filter(
      (o) => o.op === "run" && /^INSERT INTO stories \(id,/.test((o as { sql: string }).sql),
    );
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as { binds: unknown[] }).binds[0]).toBe(452); // explicit id preserved
    expect(ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("_id")).toBe(452); // unchanged
  });

  it("falls back to an autoincrement INSERT + backfill when the explicit-id story INSERT fails", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO stories \(id,/.test(sql),
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 452, story_id: "s452", title: "Restored" }),
      ]);
    }, null);

    await snapshot(doInstance);

    const autoInserts = db.ops.filter(
      (o) => o.op === "run" && /^INSERT INTO stories \(project_id,/.test((o as { sql: string }).sql),
    );
    expect(autoInserts).toHaveLength(1); // fell back to autoincrement
    const newId = ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("_id");
    expect(typeof newId).toBe("number");
    expect(newId).not.toBe(452); // backfilled to the new id
  });

  it("never throws out of doSnapshot when a story INSERT fails repeatedly (crash-proof)", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO stories/.test(sql),
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 452, story_id: "s452", title: "Restored" }),
      ]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();
    expect(db.blobRunCount()).toBe(1); // blob still persisted
    expect(db.batchCallCount()).toBe(1); // batch still ran
  });
});

describe("doSnapshot Fix A — stranded objects", () => {
  function pushObject(ydoc: Y.Doc, fields: Record<string, unknown>) {
    ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", fields._id ?? null);
      m.set("object_id", fields.object_id ?? "obj-x");
      m.set("title", new Y.Text((fields.title as string) ?? ""));
      if (fields._validation_state) m.set("_validation_state", fields._validation_state);
      ydoc.getArray<Y.Map<unknown>>("objects").push([m]);
    }, null);
  }

  it("re-INSERTs an object whose _id references a missing D1 row (same id)", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushObject(ydoc, { _id: 77, object_id: "obj-77", title: "Pot" });

    await snapshot(doInstance);

    const inserts = db.ops.filter(
      (op) => op.op === "run" && /^INSERT INTO objects \(id,/.test((op as { sql: string }).sql),
    );
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as { binds: unknown[] }).binds[0]).toBe(77);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("_id")).toBe(77);
  });

  it("adopts a live same-object_id row (UPDATEs it; no re-INSERT; Y.Map converges)", async () => {
    const seed = emptySeed();
    seed.objectIds = [555];
    seed.objectKeyToId = new Map([["obj-77", 555]]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushObject(ydoc, { _id: 77, object_id: "obj-77", title: "Pot" }); // _id 77 is stale

    await snapshot(doInstance);

    expect(
      db.ops.some((op) => op.op === "run" && /^INSERT INTO objects \(id,/.test((op as { sql: string }).sql)),
    ).toBe(false);
    const batch = db.ops.find((op) => op.op === "batch") as
      | { statements: Array<{ sql: string; binds: unknown[] }> }
      | undefined;
    const upd = batch!.statements.find((s) => /UPDATE objects SET/.test(s.sql));
    expect(upd).toBeDefined();
    expect(upd!.binds[upd!.binds.length - 1]).toBe(555); // WHERE id = the live row
    expect(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("_id")).toBe(555);
  });

  it("skips a pending object even when its _id is stale (no insert)", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushObject(ydoc, { _id: 88, object_id: "obj-88", _validation_state: "pending", title: "Pending" });

    await snapshot(doInstance);

    expect(
      db.ops.some((op) => op.op === "run" && /INSERT INTO objects/.test((op as { sql: string }).sql)),
    ).toBe(false);
  });
});

describe("doSnapshot Fix A — stranded glossary terms", () => {
  function pushTerm(ydoc: Y.Doc, fields: Record<string, unknown>) {
    ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", fields._id ?? null);
      m.set("term_id", fields.term_id ?? "term-x");
      m.set("title", new Y.Text((fields.title as string) ?? ""));
      m.set("definition", new Y.Text((fields.definition as string) ?? ""));
      ydoc.getArray<Y.Map<unknown>>("glossary").push([m]);
    }, null);
  }

  it("re-INSERTs a term whose _id references a missing D1 row (same id)", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushTerm(ydoc, { _id: 33, term_id: "maize", title: "Maize" });

    await snapshot(doInstance);

    const inserts = db.ops.filter(
      (op) => op.op === "run" && /^INSERT INTO glossary_terms \(id,/.test((op as { sql: string }).sql),
    );
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as { binds: unknown[] }).binds[0]).toBe(33);
    expect(ydoc.getArray<Y.Map<unknown>>("glossary").get(0).get("_id")).toBe(33);
  });

  it("adopts a live same-term_id row (UPDATE; no re-INSERT)", async () => {
    const seed = emptySeed();
    seed.glossaryIds = [444];
    seed.glossaryKeyToId = new Map([["maize", 444]]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushTerm(ydoc, { _id: 33, term_id: "maize", title: "Maize" });

    await snapshot(doInstance);

    expect(
      db.ops.some((op) => op.op === "run" && /^INSERT INTO glossary_terms \(id,/.test((op as { sql: string }).sql)),
    ).toBe(false);
    expect(ydoc.getArray<Y.Map<unknown>>("glossary").get(0).get("_id")).toBe(444);
  });
});

describe("doSnapshot Fix A — stranded pages", () => {
  function pushPage(ydoc: Y.Doc, fields: Record<string, unknown>) {
    ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", fields._id ?? null);
      m.set("slug", fields.slug ?? "slug-x");
      m.set("title", new Y.Text((fields.title as string) ?? ""));
      m.set("body", new Y.Text((fields.body as string) ?? ""));
      ydoc.getArray<Y.Map<unknown>>("pages").push([m]);
    }, null);
  }

  it("re-INSERTs a page whose _id references a missing D1 row (same id)", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushPage(ydoc, { _id: 22, slug: "about", title: "About" });

    await snapshot(doInstance);

    const inserts = db.ops.filter(
      (op) => op.op === "run" && /^INSERT INTO project_pages \(id,/.test((op as { sql: string }).sql),
    );
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as { binds: unknown[] }).binds[0]).toBe(22);
    expect(ydoc.getArray<Y.Map<unknown>>("pages").get(0).get("_id")).toBe(22);
  });

  it("adopts a live same-slug page row (UPDATE; UNIQUE-safe; no re-INSERT)", async () => {
    const seed = emptySeed();
    seed.pageIds = [666];
    seed.pageKeyToId = new Map([["about", 666]]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushPage(ydoc, { _id: 22, slug: "about", title: "About" });

    await snapshot(doInstance);

    expect(
      db.ops.some((op) => op.op === "run" && /^INSERT INTO project_pages \(id,/.test((op as { sql: string }).sql)),
    ).toBe(false);
    expect(ydoc.getArray<Y.Map<unknown>>("pages").get(0).get("_id")).toBe(666);
  });
});

describe("doSnapshot Fix A — stranded nested steps/layers", () => {
  it("re-INSERTs a stranded story's stale-_id steps and layers under the same ids", async () => {
    const seed = emptySeed(); // D1 empty: story 452 + step 700 + layer 900 all missing
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      const story = makeStory({ _id: 452, story_id: "s452", title: "Restored" });
      ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
      const steps = story.get("steps") as Y.Array<Y.Map<unknown>>;
      const step = new Y.Map<unknown>();
      step.set("_id", 700); // stale
      step.set("kind", "media");
      step.set("layers", new Y.Array<Y.Map<unknown>>());
      steps.push([step]);
      const layers = step.get("layers") as Y.Array<Y.Map<unknown>>;
      const layer = new Y.Map<unknown>();
      layer.set("_id", 900); // stale
      layer.set("title", new Y.Text("L"));
      layers.push([layer]);
    }, null);

    await snapshot(doInstance);

    const ins = (re: RegExp) =>
      db.ops.filter((o) => o.op === "run" && re.test((o as { sql: string }).sql));
    const storyIns = ins(/^INSERT INTO stories \(id,/);
    const stepIns = ins(/^INSERT INTO steps \(id,/);
    const layerIns = ins(/^INSERT INTO layers \(id,/);
    expect(storyIns).toHaveLength(1);
    expect(stepIns).toHaveLength(1);
    expect(layerIns).toHaveLength(1);
    expect((stepIns[0] as { binds: unknown[] }).binds[0]).toBe(700); // explicit step id
    expect((stepIns[0] as { binds: unknown[] }).binds[1]).toBe(452); // story_id FK = re-created story id
    expect((layerIns[0] as { binds: unknown[] }).binds[0]).toBe(900); // explicit layer id
    expect((layerIns[0] as { binds: unknown[] }).binds[1]).toBe(700); // step_id FK = re-created step id
  });
});

describe("doSnapshot Fix A — crash-proof new-entity INSERTs", () => {
  it("survives a new page INSERT failing (e.g. duplicate slug) without aborting the snapshot", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO project_pages/.test(sql),
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", null);
      m.set("slug", "dup");
      m.set("title", new Y.Text("Dup"));
      m.set("body", new Y.Text(""));
      ydoc.getArray<Y.Map<unknown>>("pages").push([m]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();
    expect(db.blobRunCount()).toBe(1); // blob still persisted
    expect(db.batchCallCount()).toBe(1); // batch still ran
  });
});

describe("doSnapshot Fix A — config/landing UPSERT", () => {
  it("INSERTs project_config when no row exists (instead of a zero-row UPDATE)", async () => {
    const seed = emptySeed();
    seed.configMissing = true;
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    await snapshot(doInstance);
    const batch = db.ops.find((o) => o.op === "batch") as { statements: Array<{ sql: string }> };
    expect(batch.statements.some((s) => /^INSERT INTO project_config/.test(s.sql))).toBe(true);
    expect(batch.statements.some((s) => /^UPDATE project_config/.test(s.sql))).toBe(false);
  });

  it("UPDATEs project_config when the row exists (default — unchanged behaviour)", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    await snapshot(doInstance);
    const batch = db.ops.find((o) => o.op === "batch") as { statements: Array<{ sql: string }> };
    expect(batch.statements.some((s) => /^UPDATE project_config/.test(s.sql))).toBe(true);
    expect(batch.statements.some((s) => /^INSERT INTO project_config/.test(s.sql))).toBe(false);
  });

  it("INSERTs project_landing when no row exists", async () => {
    const seed = emptySeed();
    seed.landingMissing = true;
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      const landing = new Y.Map<unknown>();
      landing.set("stories_heading", new Y.Text("S"));
      ydoc.getMap<unknown>("config").set("landing", landing);
    }, null);
    await snapshot(doInstance);
    const batch = db.ops.find((o) => o.op === "batch") as { statements: Array<{ sql: string }> };
    expect(batch.statements.some((s) => /^INSERT INTO project_landing/.test(s.sql))).toBe(true);
  });
});

describe("doSnapshot Fix A — dedup id-priority", () => {
  it("keeps the persisted (_id-bearing) copy when a same-key duplicate has _id=null", async () => {
    const seed = emptySeed();
    seed.storyIds = [42];
    const { doInstance, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      const arr = ydoc.getArray<Y.Map<unknown>>("stories");
      arr.push([makeStory({ _id: null, story_id: "foo", title: "Dup-null" })]); // index 0 (null)
      arr.push([makeStory({ _id: 42, story_id: "foo", title: "Real" })]);       // index 1 (real)
    }, null);

    await snapshot(doInstance);

    const arr = ydoc.getArray<Y.Map<unknown>>("stories");
    const foos: Y.Map<unknown>[] = [];
    for (let i = 0; i < arr.length; i++) {
      if (String(arr.get(i).get("story_id")) === "foo") foos.push(arr.get(i));
    }
    expect(foos).toHaveLength(1); // duplicate collapsed
    expect(foos[0].get("_id")).toBe(42); // the persisted copy survived (not re-keyed)
  });
});

describe("doSnapshot Bug 2 — activity labels", () => {
  it("writes the entity slug + title (not the numeric id) to activity_log", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.members = [{ user_id: 7, contributions: null }];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);
    const fieldSets = (doInstance as unknown as { userFieldSets: Map<number, Set<string>> }).userFieldSets;
    fieldSets.set(7, new Set(["stories:11:title"])); // user 7 edited the title this window

    await snapshot(doInstance);

    const batch = db.ops.find((o) => o.op === "batch") as
      | { statements: Array<{ sql: string; binds: unknown[] }> }
      | undefined;
    const ins = batch!.statements.find((s) => /INSERT INTO activity_log/.test(s.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).toMatch(/entity_label/); // new column present
    expect(ins!.binds[4]).toBe("s1"); // entity_id is the slug, not "11"
    expect(ins!.binds[5]).toBe("Story One"); // entity_label is the title
  });
});

// ---------------------------------------------------------------------------
// Eager activity emission (the activity-feed-empty fix).
//
// The bug: editor-edit activity was emitted only at snapshot time, deferred to
// a +30s alarm. Because the DO hibernates (is evicted) between events, the
// snapshot almost always runs in a fresh instance whose in-memory userFieldSets
// is empty, so no rows were written — only ~6 rows ever emitted on staging
// across thousands of sessions. The fix: emit the activity row while the DO
// instance is still warm — at webSocketMessage time, the moment the edit
// applies and getUserContext(ws) resolves the actor — instead of deferring it
// to the cold snapshot.
//
// These tests drive the REAL webSocketMessage path with a real y-protocols
// sync update from a fake editor socket, and assert the activity_log INSERT
// reaches D1 immediately, without any snapshotToD1 call.
// ---------------------------------------------------------------------------

const messageSync = 0; // mirrors the constant in workers/collaboration.ts

/** A fake hibernation socket whose attachment getUserContext(ws) accepts. */
function fakeEditorSocket(userId: number, role: "convenor" | "collaborator" = "collaborator") {
  const attachment = { userId, projectId: TEST_PROJECT_ID, role };
  return {
    attachment,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

/**
 * Build a y-protocols sync-update message that, when applied to `serverYdoc`,
 * edits the `title` Y.Text of the story at index 0 — resolving to the field
 * path `stories:<_id>:title`. Mirrors what a real client keystroke sends.
 */
function buildTitleEditMessage(serverYdoc: Y.Doc, appended: string): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(serverYdoc));
  const beforeSV = Y.encodeStateVector(serverYdoc);
  client.transact(() => {
    const title = client.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text;
    title.insert(title.length, appended);
  });
  const update = Y.encodeStateAsUpdate(client, beforeSV);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

function activityInsertsIn(ops: RecordedOp[]): Array<{ sql: string; binds: unknown[] }> {
  const out: Array<{ sql: string; binds: unknown[] }> = [];
  for (const o of ops) {
    if (o.op === "run" && /INSERT INTO activity_log/.test(o.sql)) out.push({ sql: o.sql, binds: o.binds });
    if (o.op === "batch") {
      for (const s of o.statements) if (/INSERT INTO activity_log/.test(s.sql)) out.push(s);
    }
  }
  return out;
}

describe("eager activity emission — emit on webSocketMessage, not the cold snapshot", () => {
  it("writes an activity_log INSERT the moment an editor edit applies (no snapshot)", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.members = [{ user_id: 7, contributions: null }];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);

    const ws = fakeEditorSocket(7);
    const msg = buildTitleEditMessage(ydoc, "!"); // user 7 edits stories:11:title

    await (doInstance as unknown as {
      webSocketMessage: (ws: unknown, m: Uint8Array) => Promise<void>;
    }).webSocketMessage(ws, msg);

    // The edit must be recorded NOW — no snapshotToD1() was called.
    const inserts = activityInsertsIn(db.ops);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].binds[1]).toBe(7); // actor_user_id (server-resolved)
    expect(inserts[0].binds[2]).toBe("edited"); // verb
    expect(inserts[0].binds[3]).toBe("story"); // entity_type
    expect(inserts[0].binds[4]).toBe("s1"); // entity_id = human slug
    expect(inserts[0].binds[5]).toBe("Story One!"); // entity_label = current (post-edit) title
  });

  it("dedups: a second edit to the same entity in the same session emits no new row", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.members = [{ user_id: 7, contributions: null }];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);
    const ws = fakeEditorSocket(7);

    await (doInstance as unknown as {
      webSocketMessage: (ws: unknown, m: Uint8Array) => Promise<void>;
    }).webSocketMessage(ws, buildTitleEditMessage(ydoc, "!"));
    await (doInstance as unknown as {
      webSocketMessage: (ws: unknown, m: Uint8Array) => Promise<void>;
    }).webSocketMessage(ws, buildTitleEditMessage(ydoc, "?"));

    expect(activityInsertsIn(db.ops)).toHaveLength(1); // coarse: one row per (user, entity, session)
  });

  it("dedups under CONCURRENT edits to the same entity (no per-keystroke flood)", async () => {
    // Regression for the staging UAT flood: webSocketMessage handlers interleave
    // at their `await DB.batch`, so a dedup key committed only AFTER the await
    // lets every concurrent keystroke slip past the check and re-emit. Firing
    // two messages WITHOUT awaiting the first between them reproduces the race
    // (the first yields at its batch await while the second's synchronous build
    // runs). Exactly one row must be written.
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.members = [{ user_id: 7, contributions: null }];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);
    const ws = fakeEditorSocket(7);

    const send = (m: Uint8Array) =>
      (doInstance as unknown as {
        webSocketMessage: (ws: unknown, m: Uint8Array) => Promise<void>;
      }).webSocketMessage(ws, m);

    // Fire both concurrently — do NOT await the first before sending the second.
    await Promise.all([send(buildTitleEditMessage(ydoc, "!")), send(buildTitleEditMessage(ydoc, "?"))]);

    expect(activityInsertsIn(db.ops)).toHaveLength(1);
  });

  it("does not emit for a transaction with no resolvable actor (non-socket origin)", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.members = [{ user_id: 7, contributions: null }];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);

    // A DO-internal edit (origin null) must not produce an activity row.
    ydoc.transact(() => {
      const title = ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text;
      title.insert(title.length, "!");
    }, null);
    await (doInstance as unknown as { flushActivityRows: () => Promise<void> }).flushActivityRows();

    expect(activityInsertsIn(db.ops)).toHaveLength(0);
  });
});
