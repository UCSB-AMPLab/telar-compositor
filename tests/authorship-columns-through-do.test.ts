/**
 * The authorship columns, as the Durable Object writes them.
 *
 * Four subjects, one harness: `last_edited_by`, each row's own `updated_at`,
 * `created_by_actor` being unwritable from the document, and the
 * `entity_contributors` UPSERT. They share a snapshot fixture and answer one
 * question between them — who wrote what, and when — so they live together
 * rather than duplicating a 300-line D1 fake four times.
 *
 * Recovering authorship from a document is NOT here. It is planned by a pure
 * function an operator script drives, with no route and no endpoint, so it is
 * tested against that function in `authorship-recovery.test.ts`.
 *
 * `created_by` answers who MADE an entity, and every consumer that matters
 * wants who wrote what is in it. The two diverge the moment a second person
 * touches an entity, which in a real-time collaborative editor is the ordinary
 * case: measured over one cohort, steps created against steps written in ran
 * 0 against 3, 1 against 3, 2 against 3, 16 against 10, 7 against 3. A
 * creation-only reading reports the person who wrote 837 words as having built
 * nothing.
 *
 * These are a spec, not characterization pins. What they hold to:
 *
 *   - The actor is the SERVER-resolved user from the socket attachment, never
 *     a value the client wrote into the document. `created_by` is
 *     client-authored and this column must not inherit its trust.
 *   - A row this window saw no edit to binds NULL, so COALESCE keeps whatever
 *     the column already held. A cold instance has seen nothing, and must not
 *     read as everyone having stopped editing.
 *   - A row created and written into before the first snapshot names its
 *     editor at INSERT, resolved through the client `_temp_id` its field paths
 *     carry until the DO numbers it.
 *   - An edit inside a row is an edit to the rows holding it: a panel's rewrite
 *     is the last edit to its step and to its story.
 *   - A contributor row is the narrower claim, and is written only for the
 *     deepest row of a prose path: `edited` means the person wrote text in
 *     that row, so it agrees with the words counted against it.
 *
 * Harness: same conventions as `snapshot-characterization-gaps.test.ts` —
 * `cloudflare:workers` mocked to a plain class, `env.DB` a hand-rolled
 * recording D1, a real `Y.Doc`, and each file hand-rolling its own fake per
 * this repo's convention. Edits arrive through the real afterTransaction
 * handler, driven by an origin carrying a socket attachment, so these exercise
 * the wiring end to end rather than seeding the map the snapshot reads.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";

// Mock the cloudflare:workers DurableObject base so the import resolves in Node
// and the constructor stores ctx/env on `this`.
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
import { splitTopLevel } from "./helpers/sql-set-list";
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

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
  run(): Promise<{ meta: { last_row_id: number; changes: number }; success: true }>;
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
        checkD1Bind(sql, args);
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
        return { meta: { last_row_id: rid, changes: 1 }, success: true as const };
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
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      setAlarm: async (t: number) => { alarms.push(t); },
      delete: async () => 0,
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
  markLoaded(doInstance);
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
  // The client's own id for a step D1 has not numbered yet. Carried here
  // because it is the key the field paths of a brand-new step are filed under,
  // which is how its INSERT finds the person who wrote into it.
  if (fields._temp_id !== undefined) m.set("_temp_id", fields._temp_id);
  if (fields.created_by !== undefined) m.set("created_by", fields.created_by);
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

/**
 * A transaction origin the DO reads as a signed-in collaborator. `getUserContext`
 * takes the userId off the socket attachment, which is the whole point: the
 * document cannot state who is editing it, and the socket can.
 */
function asUser(userId: number, role = "collaborator") {
  return { deserializeAttachment: () => ({ userId, role }) };
}

/**
 * The value bound to one named column of a recorded statement.
 *
 * By name rather than by counting placeholders: a bind index shifts whenever a
 * column is added anywhere to its left, and a test pinned to an index quietly
 * starts asserting about its neighbour instead of failing.
 */
function boundTo(stmt: { sql: string; binds: unknown[] }, column: string): unknown {
  const insert = /INSERT INTO \w+ \(([^)]*)\)/.exec(stmt.sql);
  if (insert) {
    const cols = insert[1].split(",").map((c) => c.trim().replace(/"/g, ""));
    const i = cols.indexOf(column);
    return i === -1 ? undefined : stmt.binds[i];
  }
  const set = /SET (.*) WHERE /.exec(stmt.sql);
  if (!set) return undefined;
  // Every assignment's binds count toward the position, whatever its
  // right-hand side: a key written through a subquery takes a bind too.
  let index = 0;
  for (const part of splitTopLevel(set[1])) {
    if (part.slice(0, part.indexOf("=")).trim().replace(/"/g, "") === column) return stmt.binds[index];
    index += (part.match(/\?/g) ?? []).length;
  }
  return undefined;
}

function findUpdate(
  db: { ops: RecordedOp[] },
  table: string,
): { sql: string; binds: unknown[] } | undefined {
  return batchStatements(db).find((s) => s.sql.startsWith(`UPDATE ${table} SET`));
}

describe("last_edited_by — stories, steps and layers", () => {
  it("names the person who edited the story", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);

    const story = ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    ydoc.transact(() => {
      (story.get("title") as Y.Text).insert(0, "Edited ");
    }, asUser(4));

    await snapshot(doInstance);

    expect(boundTo(findUpdate(db, "stories")!, "last_edited_by")).toBe(4);
  });

  it("binds NULL for a story nobody edited, so SQL keeps the editor it had", async () => {
    // The case that matters most after an eviction: a fresh Durable Object has
    // seen no edits, and every row it writes must leave the stored answer
    // alone rather than blanking it.
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);

    await snapshot(doInstance);

    const upd = findUpdate(db, "stories")!;
    expect(upd.sql).toContain("last_edited_by = COALESCE(?, last_edited_by)");
    expect(boundTo(upd, "last_edited_by")).toBe(null);
  });

  it("names the person who edited the step", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text", answer: "Draft" },
    );

    const step = (ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => {
      (step.get("answer") as Y.Text).insert(0, "More. ");
    }, asUser(6));

    await snapshot(doInstance);

    expect(boundTo(findUpdate(db, "steps")!, "last_edited_by")).toBe(6);
  });

  it("reads a panel's rewrite as the last edit to its step and its story", async () => {
    // Deliberate, and the alternative is worse: a step that reads as untouched
    // while the writing inside it moves.
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
      { _id: 31, title: "Panel", content: "Body" },
    );

    const step = (ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    const layer = (step.get("layers") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => {
      (layer.get("content") as Y.Text).insert(0, "Rewritten. ");
    }, asUser(5));

    await snapshot(doInstance);

    expect(boundTo(findUpdate(db, "layers")!, "last_edited_by")).toBe(5);
    expect(boundTo(findUpdate(db, "steps")!, "last_edited_by")).toBe(5);
    expect(boundTo(findUpdate(db, "stories")!, "last_edited_by")).toBe(5);
  });

  it("names the later of two editors, not the first", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Story One" }),
      ]);
    }, null);

    const story = ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    ydoc.transact(() => { (story.get("title") as Y.Text).insert(0, "A"); }, asUser(4));
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    ydoc.transact(() => { (story.get("byline") as Y.Text).insert(0, "B"); }, asUser(8));

    await snapshot(doInstance);

    expect(boundTo(findUpdate(db, "stories")!, "last_edited_by")).toBe(8);
  });

  it("does not take the actor from the document, which the client writes", async () => {
    // The spoofing mitigation, stated as a test. `created_by` is written by the
    // editor into the Y.Map, so it is a claim; the socket attachment is not.
    // A row whose document says one person and whose edit came from another
    // must credit the editor for the edit and leave the claim where it is.
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      const story = makeStory({ _id: 11, story_id: "s1", title: "Story One" });
      story.set("created_by", 99);
      ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
    }, null);

    const story = ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    ydoc.transact(() => {
      (story.get("title") as Y.Text).insert(0, "Edited ");
    }, asUser(4));

    await snapshot(doInstance);

    expect(boundTo(findUpdate(db, "stories")!, "last_edited_by")).toBe(4);
  });
});

describe("last_edited_by — a row created and written in before the first snapshot", () => {
  it("names the editor at INSERT, through the temp id its paths carry", async () => {
    // The ordinary case: somebody adds a step and immediately writes into it.
    // Without this the row INSERTs with no editor and waits for a later window,
    // and a row created and filled and never touched again waits forever.
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: null, _temp_id: "3f2a91c4-8e1d-4b7a-9c3e-2d5f7a1b4c8e", kind: "text" },
    );

    const step = (ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => {
      (step.get("answer") as Y.Text).insert(0, "First words.");
    }, asUser(7));

    await snapshot(doInstance);

    const ins = db.runsMatching(/INSERT INTO steps/)[0];
    expect(boundTo(ins, "last_edited_by")).toBe(7);
  });

  it("binds NULL at INSERT for a row nobody wrote into", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: null, _temp_id: "3f2a91c4-8e1d-4b7a-9c3e-2d5f7a1b4c8e", kind: "text" },
    );

    await snapshot(doInstance);

    const ins = db.runsMatching(/INSERT INTO steps/)[0];
    expect(boundTo(ins, "last_edited_by")).toBe(null);
  });
});

describe("last_edited_by — objects, glossary and pages", () => {
  it("names the person who edited the object", async () => {
    const seed = emptySeed();
    seed.objectIds = [51];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 51, object_id: "o1", title: "Object One" }),
      ]);
    }, null);

    const obj = ydoc.getArray<Y.Map<unknown>>("objects").get(0);
    ydoc.transact(() => {
      (obj.get("title") as Y.Text).insert(0, "Catalogued ");
    }, asUser(9));

    await snapshot(doInstance);

    expect(boundTo(findUpdate(db, "objects")!, "last_edited_by")).toBe(9);
  });

  it("names the person who edited the glossary term", async () => {
    const seed = emptySeed();
    seed.glossaryIds = [61];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("glossary").push([
        makeTerm({ _id: 61, term_id: "t1", title: "Term", definition: "Def" }),
      ]);
    }, null);

    const term = ydoc.getArray<Y.Map<unknown>>("glossary").get(0);
    ydoc.transact(() => {
      (term.get("definition") as Y.Text).insert(0, "Better. ");
    }, asUser(3));

    await snapshot(doInstance);

    expect(boundTo(findUpdate(db, "glossary_terms")!, "last_edited_by")).toBe(3);
  });

  it("names the person who edited the page", async () => {
    const seed = emptySeed();
    seed.pageIds = [71];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: 71, slug: "about", title: "About", body: "Body" }),
      ]);
    }, null);

    const page = ydoc.getArray<Y.Map<unknown>>("pages").get(0);
    ydoc.transact(() => {
      (page.get("body") as Y.Text).insert(0, "More. ");
    }, asUser(2));

    await snapshot(doInstance);

    expect(boundTo(findUpdate(db, "project_pages")!, "last_edited_by")).toBe(2);
  });
});

describe("updated_at means the row too, on every entity kind", () => {
  // The layer column was fixed first; the same snapshot clock was still bound
  // for the other five, so `stories.updated_at` and `steps.updated_at` read as
  // one instant across a whole project exactly as `layers.updated_at` had.
  // The edit happens at the frozen clock; the snapshot then runs LATER. Without
  // the gap the two instants coincide and the assertion passes whether the bind
  // is the row's time or the snapshot's, which is no assertion at all.
  const EDIT_AT = "2026-01-01T00:00:00.000Z";
  const SNAPSHOT_AT = "2026-01-01T00:30:00.000Z";

  it("binds the row's own edit time for every table", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    seed.layerIdsByStep.set(21, [31]);
    seed.objectIds = [51];
    seed.glossaryIds = [61];
    seed.pageIds = [71];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
      { _id: 31, title: "Panel", content: "Body" },
    );
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 51, object_id: "o1", title: "Object One" }),
      ]);
      ydoc.getArray<Y.Map<unknown>>("glossary").push([
        makeTerm({ _id: 61, term_id: "t1", title: "Term", definition: "Def" }),
      ]);
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: 71, slug: "about", title: "About", body: "Body" }),
      ]);
    }, null);

    const story = ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    const step = (story.get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    const layer = (step.get("layers") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => {
      (layer.get("content") as Y.Text).insert(0, "x");
      (ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title") as Y.Text).insert(0, "x");
      (ydoc.getArray<Y.Map<unknown>>("glossary").get(0).get("definition") as Y.Text).insert(0, "x");
      (ydoc.getArray<Y.Map<unknown>>("pages").get(0).get("body") as Y.Text).insert(0, "x");
    }, asUser(4));
    vi.setSystemTime(new Date(SNAPSHOT_AT));

    await snapshot(doInstance);

    for (const table of ["stories", "steps", "layers", "objects", "glossary_terms", "project_pages"]) {
      const upd = findUpdate(db, table)!;
      expect(upd.sql, table).toContain("updated_at = COALESCE(?, updated_at)");
      expect(boundTo(upd, "updated_at"), table).toBe(EDIT_AT);
    }
  });

  it("binds NULL for every table when nobody edited, so SQL keeps the stored time", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    seed.layerIdsByStep.set(21, [31]);
    seed.objectIds = [51];
    seed.glossaryIds = [61];
    seed.pageIds = [71];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
      { _id: 31, title: "Panel", content: "Body" },
    );
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 51, object_id: "o1", title: "Object One" }),
      ]);
      ydoc.getArray<Y.Map<unknown>>("glossary").push([
        makeTerm({ _id: 61, term_id: "t1", title: "Term", definition: "Def" }),
      ]);
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: 71, slug: "about", title: "About", body: "Body" }),
      ]);
    }, null);

    await snapshot(doInstance);

    for (const table of ["stories", "steps", "layers", "objects", "glossary_terms", "project_pages"]) {
      expect(boundTo(findUpdate(db, table)!, "updated_at"), table).toBe(null);
    }
  });
});

describe("created_by_actor is not a value the document can state", () => {
  // Kept out of the Yjs document on purpose. `created_by` is in the document
  // and is therefore a claim the identity guard has to police; this column
  // cannot be claimed at all, because no snapshot statement reads the map for
  // it. The attack it closes is a collaborator writing 'telar_template' onto
  // their own step to disclaim it — or onto somebody else's, to erase them.
  it("ignores the key entirely when a collaborator writes it onto a row", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    seed.objectIds = [51];
    seed.glossaryIds = [61];
    seed.pageIds = [71];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
    );
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 51, object_id: "o1", title: "Object One" }),
      ]);
      ydoc.getArray<Y.Map<unknown>>("glossary").push([
        makeTerm({ _id: 61, term_id: "t1", title: "Term", definition: "Def" }),
      ]);
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: 71, slug: "about", title: "About", body: "Body" }),
      ]);
    }, null);

    const story = ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    const step = (story.get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => {
      for (const m of [
        story,
        step,
        ydoc.getArray<Y.Map<unknown>>("objects").get(0),
        ydoc.getArray<Y.Map<unknown>>("glossary").get(0),
        ydoc.getArray<Y.Map<unknown>>("pages").get(0),
      ]) {
        m.set("created_by_actor", "telar_template");
      }
    }, asUser(4));

    await snapshot(doInstance);

    // No statement anywhere in the snapshot assigns the column, so the value
    // sitting in the document reaches D1 by no route at all.
    for (const stmt of batchStatements(db)) {
      expect(stmt.sql, stmt.sql).not.toMatch(/created_by_actor\s*=/);
    }
    for (const table of ["stories", "steps", "objects", "glossary_terms", "project_pages"]) {
      expect(findUpdate(db, table)!.sql, table).not.toContain("created_by_actor");
    }
  });
});

describe("entity_contributors — everyone who wrote in a row", () => {
  /** The contributor UPSERTs a snapshot emitted, decoded from their binds. */
  function contributorRows(db: { ops: RecordedOp[] }): Array<{
    kind: string;
    entityId: number;
    userId: number;
    first: string;
    last: string;
    words: number | null;
  }> {
    return batchStatements(db)
      .filter((s) => s.sql.startsWith("INSERT INTO entity_contributors"))
      .map((s) => ({
        kind: String(s.binds[1]),
        entityId: Number(s.binds[2]),
        userId: Number(s.binds[3]),
        first: String(s.binds[4]),
        last: String(s.binds[5]),
        words: s.binds[6] as number | null,
      }));
  }

  it("writes a row per person per entity, keyed by the entity's D1 id", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text", answer: "Draft" },
    );

    const story = ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    const step = (story.get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => { (step.get("answer") as Y.Text).insert(0, "A"); }, asUser(4));
    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    ydoc.transact(() => { (step.get("answer") as Y.Text).insert(0, "B"); }, asUser(8));

    await snapshot(doInstance);

    const rows = contributorRows(db);
    const stepRows = rows.filter((r) => r.kind === "step");
    expect(stepRows.map((r) => ({ entityId: r.entityId, userId: r.userId }))).toEqual([
      { entityId: 21, userId: 4 },
      { entityId: 21, userId: 8 },
    ]);
    // Both people are present with their own times — the second writer does not
    // displace the first.
    expect(stepRows.find((r) => r.userId === 4)!.last).toBe("2026-01-01T00:00:00.000Z");
    expect(stepRows.find((r) => r.userId === 8)!.last).toBe("2026-01-01T00:10:00.000Z");
  });

  it("UPSERTs so a snapshot adds contributors rather than replacing the set", async () => {
    // The property the table exists for. This instance holds only what it has
    // seen since it started, so an assignment would drop everyone who wrote
    // before the last eviction — which is exactly how fields_edited came to
    // overwrite a stored count with one lifetime's tally.
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
    );
    const step = (ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => { (step.get("answer") as Y.Text).insert(0, "A"); }, asUser(4));

    await snapshot(doInstance);

    const sql = batchStatements(db)
      .find((s) => s.sql.startsWith("INSERT INTO entity_contributors"))!.sql;
    expect(sql).toContain("ON CONFLICT (project_id, entity_kind, entity_id, user_id) DO UPDATE");
    // Neither stamp can move backwards: two instances can snapshot out of order.
    expect(sql).toContain("first_edit_at = MIN(");
    expect(sql).toContain("last_edit_at = MAX(");
    expect(sql).not.toMatch(/DO UPDATE SET[^)]*first_edit_at = excluded/);
  });

  it("credits a panel's writer to the panel and to nothing holding it", async () => {
    // `edited` is what a person wrote text in. Panels are their own kind on the
    // record, so a panel-only writer is a contributor to the panel; an `edited`
    // on the step would stand beside a dash in that step's `words`.
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
      { _id: 31, title: "Panel", content: "Body" },
    );
    const step = (ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    const layer = (step.get("layers") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => {
      (layer.get("content") as Y.Text).insert(0, "Written by 12. ");
    }, asUser(12));

    await snapshot(doInstance);

    const rows = contributorRows(db).filter((r) => r.userId === 12);
    expect(rows.map((r) => `${r.kind}:${r.entityId}`).sort()).toEqual(["layer:31"]);
  });

  it("writes nothing for a change that is not writing", async () => {
    // Framing an image is a change to the site, not prose. It still moves the
    // step's `updated_at` and `last_edited_by`; it makes nobody a contributor.
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "image" },
    );
    const step = (ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => { step.set("zoom", 3); }, asUser(4));

    await snapshot(doInstance);

    expect(contributorRows(db)).toEqual([]);
    expect(boundTo(findUpdate(db, "steps")!, "last_edited_by")).toBe(4);
  });

  it("keeps a step's writer off the story holding it", async () => {
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
    );
    const step = (ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => { (step.get("answer") as Y.Text).insert(0, "Written."); }, asUser(6));

    await snapshot(doInstance);

    expect(contributorRows(db).map((r) => `${r.kind}:${r.entityId}`)).toEqual(["step:21"]);
  });

  it("leaves a row somebody added and never typed in with a creator and no contributor", async () => {
    // Added, not edited — which is the definition the record shows.
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
    );
    seed.stepIdsByStory.set(11, [21]);
    const steps = ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>;
    ydoc.transact(() => {
      steps.push([makeStep({
        _id: null,
        _temp_id: "8c1d4e2a-5b30-4f6c-9a71-0e3d2b8f6a54",
        kind: "text",
        created_by: 5,
      })]);
    }, asUser(5));

    await snapshot(doInstance);

    const inserted = db.ops
      .filter((o): o is Extract<RecordedOp, { op: "run" }> => o.op === "run")
      .filter((o) => o.sql.startsWith("INSERT INTO steps"));
    expect(inserted).toHaveLength(1);
    expect(boundTo(inserted[0], "created_by")).toBe(5);
    expect(boundTo(inserted[0], "last_edited_by")).toBeNull();
    expect(contributorRows(db)).toEqual([]);
  });

  it("writes a counted nought for a prose edit that added no words", async () => {
    // The zero the record renders grey against an em dash. NULL would mean
    // nobody counted, and the UPSERT would keep whatever was stored.
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text", answer: "One two three" },
    );
    const step = (ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    const answer = step.get("answer") as Y.Text;
    ydoc.transact(() => { answer.insert(0, "x"); }, asUser(4));   // baseline established
    ydoc.transact(() => { answer.delete(0, 1); }, asUser(4));     // and put back

    await snapshot(doInstance);

    const rows = contributorRows(db).filter((r) => r.kind === "step");
    expect(rows).toHaveLength(1);
    expect(rows[0].words).toBe(0);
  });

  it("resolves a row created and written into this window through its temp id", async () => {
    // The contributor is accumulated against the `_temp_id` the field path
    // carried; the INSERT in sections 5-8 backfills the real `_id` before this
    // runs, which is why the ordering there is load-bearing.
    const seed = emptySeed();
    seed.storyIds = [11];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: null, _temp_id: "3f2a91c4-8e1d-4b7a-9c3e-2d5f7a1b4c8e", kind: "text" },
    );
    const step = (ydoc.getArray<Y.Map<unknown>>("stories").get(0)
      .get("steps") as Y.Array<Y.Map<unknown>>).get(0);
    ydoc.transact(() => {
      (step.get("answer") as Y.Text).insert(0, "First words.");
    }, asUser(7));

    await snapshot(doInstance);

    const backfilledId = step.get("_id") as number;
    expect(typeof backfilledId).toBe("number");
    const rows = contributorRows(db).filter((r) => r.kind === "step");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityId: backfilledId, userId: 7 });
  });

  it("writes nothing when this instance has seen no edits", async () => {
    // Every freshly started Durable Object. Writing here would be writing an
    // empty set, and an empty set assigned over a real one is data loss.
    const seed = emptySeed();
    seed.storyIds = [11];
    seed.stepIdsByStory.set(11, [21]);
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    pushStoryWithStep(
      ydoc,
      { _id: 11, story_id: "s1", title: "Story One" },
      { _id: 21, kind: "text" },
    );

    await snapshot(doInstance);

    expect(contributorRows(db)).toEqual([]);
  });

  it("covers objects, glossary terms and pages", async () => {
    const seed = emptySeed();
    seed.objectIds = [51];
    seed.glossaryIds = [61];
    seed.pageIds = [71];
    const { doInstance, db, ydoc } = makeDo(seed);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 51, object_id: "o1", title: "Object One" }),
      ]);
      ydoc.getArray<Y.Map<unknown>>("glossary").push([
        makeTerm({ _id: 61, term_id: "t1", title: "Term", definition: "Def" }),
      ]);
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: 71, slug: "about", title: "About", body: "Body" }),
      ]);
    }, null);
    ydoc.transact(() => {
      (ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("title") as Y.Text).insert(0, "x");
      (ydoc.getArray<Y.Map<unknown>>("glossary").get(0).get("definition") as Y.Text).insert(0, "x");
      (ydoc.getArray<Y.Map<unknown>>("pages").get(0).get("body") as Y.Text).insert(0, "x");
    }, asUser(9));

    await snapshot(doInstance);

    expect(contributorRows(db).map((r) => `${r.kind}:${r.entityId}`).sort()).toEqual([
      "object:51",
      "page:71",
      "term:61",
    ]);
  });
});
