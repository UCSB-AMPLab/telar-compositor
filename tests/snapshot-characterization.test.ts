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
function makeRecordingDb(seed: Seed, opts: { failBatch?: boolean } = {}) {
  const ops: RecordedOp[] = [];
  let lastRowId = 1000;
  let batchCalls = 0;

  function resolveSelect(sql: string, binds: unknown[]): { results: unknown[] } {
    if (/SELECT id FROM stories WHERE project_id/.test(sql)) {
      return { results: seed.storyIds.map((id) => ({ id })) };
    }
    if (/SELECT id FROM steps WHERE story_id/.test(sql)) {
      const storyId = binds[0] as number;
      return { results: (seed.stepIdsByStory.get(storyId) ?? []).map((id) => ({ id })) };
    }
    if (/SELECT id FROM layers WHERE step_id/.test(sql)) {
      const stepId = binds[0] as number;
      return { results: (seed.layerIdsByStep.get(stepId) ?? []).map((id) => ({ id })) };
    }
    if (/SELECT id FROM objects WHERE project_id/.test(sql)) {
      return { results: seed.objectIds.map((id) => ({ id })) };
    }
    if (/SELECT id FROM glossary_terms WHERE project_id/.test(sql)) {
      return { results: seed.glossaryIds.map((id) => ({ id })) };
    }
    if (/SELECT id FROM project_pages WHERE project_id/.test(sql)) {
      return { results: seed.pageIds.map((id) => ({ id })) };
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
        ops.push({ op: "run", sql, binds: stmt.boundArgs.map(normaliseBind) });
        lastRowId += 1;
        return { meta: { last_row_id: lastRowId }, success: true as const };
      },
      async all<T = unknown>() {
        return { results: resolveSelect(sql, stmt.boundArgs).results as T[], success: true as const };
      },
      async first<T = unknown>() {
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
function makeDo(seed: Seed, opts: { failBatch?: boolean } = {}) {
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
