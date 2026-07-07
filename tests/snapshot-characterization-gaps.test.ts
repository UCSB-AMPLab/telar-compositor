/**
 * Characterization tests closing the 15 coverage gaps across
 * the six insert/snapshot pipelines in `workers/collaboration.ts` (stories,
 * steps, layers, objects, glossary, pages). Written BEFORE any generify
 * refactor of those pipelines so the refactor has a gate for the branches
 * that `snapshot-characterization.test.ts` never exercised.
 *
 * These are characterization pins, not a spec: each test records CURRENT
 * behavior (including anything that looks like a wart) so a future refactor
 * can diff against it. None of them assert what the code "should" do.
 *
 * Gap map (pipeline — case):
 *   Stories  1. plain new-insert (_id: null) INSERT fails -> swallow, no throw, id 0
 *   Steps    2. happy-path UPDATE for an existing step matching a live D1 row
 *            3. explicit-id INSERT fails -> fallback to autoincrement + backfill
 *            4. both attempts fail -> warn+reschedule, no throw, layers skipped
 *   Layers   5. happy-path UPDATE for an existing layer matching a live D1 row
 *            6. explicit-id INSERT fails -> fallback to autoincrement + backfill
 *            7. both attempts fail -> warn+reschedule, no throw
 *   Objects  8. stale id, no live object_id match, explicit-id INSERT fails -> fallback
 *            9. both attempts fail -> warn+reschedule, id 0, no throw
 *   Glossary 10. brand-new term, title set, no term_id -> resolvedTermId = slug-<8ch>, backfilled
 *            11. brand-new term, empty title -> falls back to _temp_id, backfilled
 *            12. stale id, existing term_id, explicit-id INSERT fails -> fallback (term_id preserved)
 *   Pages    13. stale id, no live slug match, explicit-id INSERT fails -> fallback
 *            14. both attempts fail -> warn+reschedule, no throw
 *   (13 numbered above map to the doc's 15 cases; Stories/Objects/Pages "both
 *   attempts fail" cases are 1 each, Steps/Layers are 3 each: 1+3+3+2+3+2 = 15)
 *
 * Harness: identical conventions to snapshot-characterization.test.ts —
 * `cloudflare:workers` mocked to a plain class, `env.DB` a hand-rolled
 * recording D1 with regex fault injection via `failRunMatching`, and a real
 * `Y.Doc`. Duplicated here (not imported) because the harness is module-scoped
 * in that file, matching this repo's convention of each characterization test
 * file hand-rolling its own DB fake (see created-by-persist.test.ts,
 * object-config-fields-persist.test.ts).
 *
 * @version v1.4.0-beta
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
// Seed: what the SELECTs in doSnapshot resolve to. Drives orphan/adopt
// detection. Copied from snapshot-characterization.test.ts's Seed shape.
// ---------------------------------------------------------------------------
interface Seed {
  storyIds: number[];
  stepIdsByStory: Map<number, number[]>;
  layerIdsByStep: Map<number, number[]>;
  objectIds: number[];
  glossaryIds: number[];
  pageIds: number[];
  members: Array<{ user_id: number; contributions: string | null }>;
  storyKeyToId?: Map<string, number>;
  objectKeyToId?: Map<string, number>;
  glossaryKeyToId?: Map<string, number>;
  pageKeyToId?: Map<string, number>;
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

// Recording D1: records SQL+binds of every `.run()` and every `.batch([...])`
// statement, in execution order. `.all()` resolves from the seed. `failRunMatching`
// throws a plain Error for any `.run()` whose SQL+binds match, simulating a
// constraint failure without pretending to be SQLite.
function makeRecordingDb(
  seed: Seed,
  opts: {
    failBatch?: boolean;
    failRunMatching?: (sql: string, binds: unknown[]) => boolean;
  } = {},
) {
  const ops: RecordedOp[] = [];
  let lastRowId = 1000;
  let batchCalls = 0;

  function reverse(map?: Map<string, number>): Map<number, string> {
    const out = new Map<number, string>();
    if (map) for (const [k, v] of map) out.set(v, k);
    return out;
  }
  const storyIdToKey = reverse(seed.storyKeyToId);
  const objectIdToKey = reverse(seed.objectKeyToId);
  const glossaryIdToKey = reverse(seed.glossaryKeyToId);
  const pageIdToKey = reverse(seed.pageKeyToId);

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
        const explicitId = /^INSERT INTO \w+ \(id,/.test(sql) ? Number(stmt.boundArgs[0]) : null;
        const rid = explicitId !== null && Number.isFinite(explicitId) ? explicitId : (lastRowId += 1);
        return { meta: { last_row_id: rid }, success: true as const };
      },
      async all<T = unknown>() {
        return { results: resolveSelect(sql, stmt.boundArgs).results as T[], success: true as const };
      },
      async first<T = unknown>() {
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
    runsMatching: (re: RegExp) =>
      ops.filter((o) => o.op === "run" && re.test((o as { sql: string }).sql)) as Array<{
        sql: string;
        binds: unknown[];
      }>,
  };
}

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

// --- Y.Doc entity builders ---------------------------------------------------
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

function makeStep(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id ?? null);
  m.set("kind", fields.kind ?? "text");
  m.set("object_id", fields.object_id ?? "");
  m.set("x", (fields.x as number | null) ?? null);
  m.set("y", (fields.y as number | null) ?? null);
  m.set("zoom", (fields.zoom as number | null) ?? null);
  m.set("page", fields.page ?? "");
  m.set("question", new Y.Text((fields.question as string) ?? ""));
  m.set("answer", new Y.Text((fields.answer as string) ?? ""));
  m.set("alt_text", new Y.Text((fields.alt_text as string) ?? ""));
  m.set("clip_start", fields.clip_start ?? "");
  m.set("clip_end", fields.clip_end ?? "");
  m.set("loop", fields.loop ?? "");
  m.set("layers", new Y.Array<Y.Map<unknown>>());
  return m;
}

function makeLayer(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id ?? null);
  m.set("title", new Y.Text((fields.title as string) ?? ""));
  m.set("button_label", new Y.Text((fields.button_label as string) ?? ""));
  m.set("content", new Y.Text((fields.content as string) ?? ""));
  return m;
}

function makeObject(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id ?? null);
  m.set("object_id", fields.object_id ?? "obj-x");
  m.set("title", new Y.Text((fields.title as string) ?? ""));
  if (fields._validation_state) m.set("_validation_state", fields._validation_state);
  return m;
}

function makeTerm(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id ?? null);
  if (fields.term_id !== undefined) m.set("term_id", fields.term_id);
  if (fields._temp_id !== undefined) m.set("_temp_id", fields._temp_id);
  m.set("title", new Y.Text((fields.title as string) ?? ""));
  m.set("definition", new Y.Text((fields.definition as string) ?? ""));
  return m;
}

function makePage(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id ?? null);
  m.set("slug", fields.slug ?? "slug-x");
  m.set("title", new Y.Text((fields.title as string) ?? ""));
  m.set("body", new Y.Text((fields.body as string) ?? ""));
  return m;
}

/** Pushes a story with one nested step (and optionally one nested layer). The
 * push-then-read pattern is required because a detached Y.Map's nested shared
 * types resolve as undefined until the parent is integrated into the doc. */
function pushStoryWithStep(
  ydoc: Y.Doc,
  storyFields: Record<string, unknown>,
  stepFields: Record<string, unknown>,
  layerFields?: Record<string, unknown>,
): void {
  ydoc.transact(() => {
    const story = makeStory(storyFields);
    ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
    const steps = story.get("steps") as Y.Array<Y.Map<unknown>>;
    const step = makeStep(stepFields);
    steps.push([step]);
    if (layerFields) {
      const layers = step.get("layers") as Y.Array<Y.Map<unknown>>;
      layers.push([makeLayer(layerFields)]);
    }
  }, null);
}

function batchStatements(db: { ops: RecordedOp[] }): Array<{ sql: string; binds: unknown[] }> {
  return db.ops
    .filter((o): o is Extract<RecordedOp, { op: "batch" }> => o.op === "batch")
    .flatMap((o) => o.statements);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// GAP 1 — Stories: plain new-insert (_id === null) failure/swallow branch.
// Only the explicit-id branch's fallback/terminal failure had coverage;
// the single-attempt new-insert catch (workers/collaboration.ts L1597-1605)
// never executed under test.
// ---------------------------------------------------------------------------
describe("doSnapshot gap coverage — stories: new-insert (no explicit id) failure", () => {
  it("swallows a failed new-story INSERT: no throw, no backfill, id stays null, blob+batch still run", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO stories/.test(sql),
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: null, story_id: "new-s", title: "New Story" }),
      ]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    expect(db.runsMatching(/INSERT INTO stories/)).toHaveLength(0); // the one attempt failed and wasn't recorded
    expect(db.blobRunCount()).toBe(1);
    expect(db.batchCallCount()).toBe(1);
    expect(ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("_id")).toBe(null); // never backfilled
  });
});

// ---------------------------------------------------------------------------
// GAPS 2-4 — Steps.
// ---------------------------------------------------------------------------
describe("doSnapshot gap coverage — steps", () => {
  it("GAP: happy-path UPDATE for an existing step matching a live D1 row", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text", object_id: "obj-1", question: "Q?", answer: "A.", alt_text: "Alt" },
    );

    await snapshot(doInstance);

    expect(db.runsMatching(/^INSERT INTO steps/)).toHaveLength(0);
    const upd = batchStatements(db).find((s) => /UPDATE steps SET/.test(s.sql));
    expect(upd).toBeDefined();
    expect(upd!.binds[0]).toBe(1); // step_number = sti+1 (Y.Array index 0)
    expect(upd!.binds[1]).toBe("text"); // kind
    expect(upd!.binds[2]).toBe("obj-1"); // object_id
    expect(upd!.binds[upd!.binds.length - 1]).toBe(21); // WHERE id = the live row
  });

  it("GAP: explicit-id step INSERT fails -> falls back to autoincrement + backfill", async () => {
    const seed = emptySeed();
    seed.storyIds = [11]; // live story; step 700 is not in D1 (no stepIdsByStory entry)
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO steps \(id,/.test(sql),
    });
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 700, kind: "media" },
    );

    await snapshot(doInstance);

    const autoInserts = db.runsMatching(/^INSERT INTO steps \(story_id,/);
    expect(autoInserts).toHaveLength(1); // fell back to autoincrement
    expect(autoInserts[0].binds[0]).toBe(11); // story_id FK preserved on the fallback insert
    const newStepId = ydoc
      .getArray<Y.Map<unknown>>("stories")
      .get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>;
    const backfilledId = newStepId.get(0).get("_id");
    expect(typeof backfilledId).toBe("number");
    expect(backfilledId).not.toBe(700); // backfilled to the new id
  });

  it("GAP: both step INSERT attempts fail -> warn+reschedule, no throw, layers skipped", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO steps/.test(sql),
    });
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 700, kind: "media" },
      { _id: 900, title: "Layer" }, // this layer must never be processed
    );

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    expect(db.runsMatching(/INSERT INTO steps/)).toHaveLength(0);
    expect(db.runsMatching(/INSERT INTO layers/)).toHaveLength(0); // layers skipped (stepId 0)
    expect(db.blobRunCount()).toBe(1); // crash-proof: blob still persisted
    expect(db.batchCallCount()).toBe(1); // batch still ran
    const step = (
      ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>
    ).get(0);
    expect(step.get("_id")).toBe(700); // left stranded, unchanged
    const layer = (step.get("layers") as Y.Array<Y.Map<unknown>>).get(0);
    expect(layer.get("_id")).toBe(900); // untouched — its parent step never resolved an id
  });
});

// ---------------------------------------------------------------------------
// GAPS 5-7 — Layers (same three-case shape as steps, targeting `layers`).
// ---------------------------------------------------------------------------
describe("doSnapshot gap coverage — layers", () => {
  it("GAP: happy-path UPDATE for an existing layer matching a live D1 row", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    seed.layerIdsByStep.set(21, [31]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
      { _id: 31, title: "Layer Title", button_label: "Next", content: "Body" },
    );

    await snapshot(doInstance);

    expect(db.runsMatching(/^INSERT INTO layers/)).toHaveLength(0);
    const upd = batchStatements(db).find((s) => /UPDATE layers SET/.test(s.sql));
    expect(upd).toBeDefined();
    expect(upd!.binds[0]).toBe(1); // layer_number = li+1 (Y.Array index 0)
    expect(upd!.binds[1]).toBe("Layer Title"); // title
    expect(upd!.binds[2]).toBe("Next"); // button_label
    expect(upd!.binds[3]).toBe("Body"); // content
    expect(upd!.binds[upd!.binds.length - 1]).toBe(31); // WHERE id = the live row
  });

  it("GAP: explicit-id layer INSERT fails -> falls back to autoincrement + backfill", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]); // step is live/matching; layer 900 is stale
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO layers \(id,/.test(sql),
    });
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
      { _id: 900, title: "Layer" },
    );

    await snapshot(doInstance);

    const autoInserts = db.runsMatching(/^INSERT INTO layers \(step_id,/);
    expect(autoInserts).toHaveLength(1);
    expect(autoInserts[0].binds[0]).toBe(21); // step_id FK = the existing (resolved) step id
    const step = (
      ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>
    ).get(0);
    const backfilledId = (step.get("layers") as Y.Array<Y.Map<unknown>>).get(0).get("_id");
    expect(typeof backfilledId).toBe("number");
    expect(backfilledId).not.toBe(900);
  });

  it("GAP: both layer INSERT attempts fail -> warn+reschedule, no throw", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO layers/.test(sql),
    });
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
      { _id: 900, title: "Layer" },
    );

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    expect(db.runsMatching(/INSERT INTO layers/)).toHaveLength(0);
    expect(db.blobRunCount()).toBe(1);
    expect(db.batchCallCount()).toBe(1);
    const step = (
      ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps") as Y.Array<Y.Map<unknown>>
    ).get(0);
    const layer = (step.get("layers") as Y.Array<Y.Map<unknown>>).get(0);
    expect(layer.get("_id")).toBe(900); // left stranded, unchanged
  });
});

// ---------------------------------------------------------------------------
// GAPS 8-9 — Objects: the file's only three fault-injection tests target
// stories x2 and project_pages x1; objects has no failRunMatching test at all.
// ---------------------------------------------------------------------------
describe("doSnapshot gap coverage — objects", () => {
  it("GAP: stale-id object, no live object_id match, explicit-id INSERT fails -> falls back to autoincrement + backfill", async () => {
    const seed = emptySeed(); // no live rows, no objectKeyToId match for "obj-77"
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO objects \(id,/.test(sql),
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([makeObject({ _id: 77, object_id: "obj-77", title: "Pot" })]);
    }, null);

    await snapshot(doInstance);

    const autoInserts = db.runsMatching(/^INSERT INTO objects \(project_id,/);
    expect(autoInserts).toHaveLength(1);
    const backfilledId = ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("_id");
    expect(typeof backfilledId).toBe("number");
    expect(backfilledId).not.toBe(77);
  });

  it("GAP: both object INSERT attempts fail -> warn+reschedule, id 0, no throw", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO objects/.test(sql),
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([makeObject({ _id: 77, object_id: "obj-77", title: "Pot" })]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    expect(db.runsMatching(/INSERT INTO objects/)).toHaveLength(0);
    expect(db.blobRunCount()).toBe(1);
    expect(db.batchCallCount()).toBe(1);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("_id")).toBe(77); // unchanged, not adopted
  });
});

// ---------------------------------------------------------------------------
// GAPS 10-12 — Glossary, the sharpest gap: every existing test pre-sets
// term_id, so resolvedTermId's slugify/_temp_id/crypto.randomUUID() branch
// (workers/collaboration.ts L2147-2155) has never executed under test.
// ---------------------------------------------------------------------------
describe("doSnapshot gap coverage — glossary term_id auto-generation", () => {
  it("GAP: brand-new term with a title and no term_id -> resolved id is slugify(title)-<8ch>, backfilled onto the Y.Map", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("glossary").push([
        makeTerm({ _id: null, title: "Maize Corn", definition: "A cereal grain." }),
      ]);
    }, null);

    await snapshot(doInstance);

    const term = ydoc.getArray<Y.Map<unknown>>("glossary").get(0);
    const backfilledId = term.get("_id");
    expect(typeof backfilledId).toBe("number");
    const termId = String(term.get("term_id"));
    expect(termId).toMatch(/^maize-corn-[0-9a-f]{8}$/); // slugified title + 8-char suffix, backfilled

    const insert = db.runsMatching(/^INSERT INTO glossary_terms \(project_id,/)[0];
    expect(insert.binds[1]).toBe(termId); // the INSERT itself carried the resolved term_id
  });

  it("GAP: brand-new term with an empty title -> falls back to _temp_id as the term_id, backfilled", async () => {
    const seed = emptySeed();
    const { doInstance, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("glossary").push([
        makeTerm({ _id: null, title: "", definition: "", _temp_id: "tmp-8f3c2a1b" }),
      ]);
    }, null);

    await snapshot(doInstance);

    const term = ydoc.getArray<Y.Map<unknown>>("glossary").get(0);
    expect(typeof term.get("_id")).toBe("number");
    expect(term.get("term_id")).toBe("tmp-8f3c2a1b"); // no slug base -> _temp_id used verbatim, backfilled
  });

  it("GAP: stale id, existing term_id, explicit-id INSERT fails -> falls back to autoincrement (term_id preserved, not regenerated)", async () => {
    const seed = emptySeed(); // no live row, no glossaryKeyToId match for "maize"
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO glossary_terms \(id,/.test(sql),
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("glossary").push([makeTerm({ _id: 33, term_id: "maize", title: "Maize" })]);
    }, null);

    await snapshot(doInstance);

    const autoInserts = db.runsMatching(/^INSERT INTO glossary_terms \(project_id,/);
    expect(autoInserts).toHaveLength(1);
    const term = ydoc.getArray<Y.Map<unknown>>("glossary").get(0);
    expect(term.get("_id")).not.toBe(33); // backfilled to a new id
    expect(term.get("term_id")).toBe("maize"); // existingTermId was truthy -> not regenerated
  });
});

// ---------------------------------------------------------------------------
// GAPS 13-14 — Pages.
// ---------------------------------------------------------------------------
describe("doSnapshot gap coverage — pages", () => {
  it("GAP: stale-id page, no live slug match, explicit-id INSERT fails -> falls back to autoincrement + backfill", async () => {
    const seed = emptySeed(); // no live rows, no pageKeyToId match for "about"
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO project_pages \(id,/.test(sql),
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("pages").push([makePage({ _id: 22, slug: "about", title: "About" })]);
    }, null);

    await snapshot(doInstance);

    const autoInserts = db.runsMatching(/^INSERT INTO project_pages \(project_id,/);
    expect(autoInserts).toHaveLength(1);
    const backfilledId = ydoc.getArray<Y.Map<unknown>>("pages").get(0).get("_id");
    expect(typeof backfilledId).toBe("number");
    expect(backfilledId).not.toBe(22);
  });

  it("GAP: both page INSERT attempts fail (explicit-id branch) -> warn+reschedule, no throw", async () => {
    const seed = emptySeed();
    const { doInstance, db, ydoc } = makeDo(seed, {
      failRunMatching: (sql) => /^INSERT INTO project_pages/.test(sql),
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("pages").push([makePage({ _id: 22, slug: "about", title: "About" })]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    expect(db.runsMatching(/INSERT INTO project_pages/)).toHaveLength(0);
    expect(db.blobRunCount()).toBe(1);
    expect(db.batchCallCount()).toBe(1);
    expect(ydoc.getArray<Y.Map<unknown>>("pages").get(0).get("_id")).toBe(22); // unchanged, not adopted
  });
});
