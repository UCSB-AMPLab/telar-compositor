/**
 * Two stories that exchange IDs inside one snapshot window. D1 checks
 * UNIQUE(project_id, story_id) per statement, so the first UPDATE of the
 * exchange collides with the row that has not moved yet, whichever the walk
 * order, and every retry re-issues the same pair.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  },
}));

import { ProjectCollaborationDO } from "../workers/collaboration";
import { markLoaded } from "./helpers/claimed-document";
import { trackBaseRow } from "./helpers/base-row";
import { checkD1Bind, createMemoryD1 } from "./helpers/d1-memory";

const PROJECT_ID = 42;

type Row = { id: number; story_id: string; source_path: string | null };

const isStoryWrite = (sql: string) => /^(UPDATE|DELETE FROM) stories\b/.test(sql);

/**
 * The stories table is a real SQLite table built from the migrations, and the
 * snapshot's stories statements run against it as written, in one transaction
 * per batch as D1 runs them. Everything else the snapshot reads or writes is
 * a stub.
 */
function makeDo(initial: Array<{ id: number; story_id: string }>) {
  const mem = createMemoryD1();
  mem.raw.exec("PRAGMA foreign_keys = OFF");
  for (const r of initial) {
    mem.raw.prepare("INSERT INTO stories (id, project_id, story_id) VALUES (?, ?, ?)").run(r.id, PROJECT_ID, r.story_id);
  }
  const read = (): Row[] =>
    mem.raw.prepare("SELECT id, story_id, source_path FROM stories ORDER BY id").all() as unknown as Row[];
  const row = trackBaseRow();
  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return bound; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); bound = args; return stmt; },
      async run() {
        row.note(sql);
        if (isStoryWrite(sql)) await mem.prepare(sql).bind(...bound).run();
        return { meta: { last_row_id: 1, changes: 1 }, success: true as const };
      },
      async all<T = unknown>() {
        const results = /FROM stories WHERE project_id/.test(sql)
          ? read().map(({ id, story_id }) => ({ id, story_id }))
          : [];
        return { results: results as T[], success: true as const };
      },
      async first<T = unknown>() {
        const base = row.read(sql);
        if (base) return base as T;
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) return { id: 1 } as T;
        return null as T | null;
      },
    };
    return stmt;
  }
  const DB = {
    prepare,
    async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
      return mem.batch(
        statements.filter((s) => isStoryWrite(s.sql)).map((s) => mem.prepare(s.sql).bind(...s.boundArgs)),
      );
    },
  };
  const ctx = {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null, setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {}, list: async () => new Map(), delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: DB as unknown, SESSION_SECRET: "test", COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  return { doInstance, read, ydoc: (doInstance as unknown as { ydoc: Y.Doc }).ydoc };
}

function makeStory(id: number, story_id: string, extra: Record<string, unknown> = {}) {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(extra)) m.set(k, v);
  m.set("_id", id);
  m.set("story_id", story_id);
  m.set("created_by", 1);
  m.set("title", new Y.Text(story_id));
  m.set("subtitle", new Y.Text(""));
  m.set("byline", new Y.Text(""));
  m.set("steps", new Y.Array<Y.Map<unknown>>());
  return m;
}

function seeded(held: Array<[number, string]>, doc: Array<[number, string]>, extra: Record<number, Record<string, unknown>> = {}) {
  const t = makeDo(held.map(([id, story_id]) => ({ id, story_id })));
  t.ydoc.transact(() => {
    const c = t.ydoc.getMap<unknown>("config");
    c.set("title", new Y.Text("Demo"));
    c.set("lang", "en");
    t.ydoc.getArray<Y.Map<unknown>>("stories").push(doc.map(([id, sid]) => makeStory(id, sid, extra[id])));
  }, null);
  return t;
}

const snapshot = (d: unknown) => (d as { snapshotToD1: () => Promise<void> }).snapshotToD1();
const held = (rows: Array<{ id: number; story_id: string }>) => rows.map((r) => `${r.id}:${r.story_id}`);
const files = (rows: Row[]) => rows.map((r) => r.source_path);
const SH = "telar-content/spreadsheets/";

describe("stories that exchange IDs in one snapshot window", () => {
  it("lands a two-story exchange", async () => {
    const { doInstance, read } = seeded([[1, "a"], [2, "b"]], [[1, "b"], [2, "a"]]);
    await snapshot(doInstance);
    expect(held(read())).toEqual(["1:b", "2:a"]);
    expect(files(read())).toEqual([`${SH}a.csv`, `${SH}b.csv`]);
  });

  it("lands a chain (a to b, b to c) in either walk order", async () => {
    const { doInstance, read } = seeded([[1, "a"], [2, "b"]], [[1, "b"], [2, "c"]]);
    await snapshot(doInstance);
    expect(held(read())).toEqual(["1:b", "2:c"]);
  });

  it("writes an ordinary rename as before", async () => {
    const { doInstance, read } = seeded([[1, "a"], [2, "b"]], [[1, "a2"], [2, "b"]]);
    await snapshot(doInstance);
    expect(held(read())).toEqual(["1:a2", "2:b"]);
  });

  it("leaves a story the snapshot skips under its own ID, never parked", async () => {
    const { doInstance, read } = seeded(
      [[1, "a"], [2, "b"], [3, "c"]],
      [[1, "x"], [2, "c"], [3, "b"]],
      { 1: { draft: "not-a-flag" } },
    );
    await snapshot(doInstance);
    expect(held(read())).toEqual(["1:a", "2:c", "3:b"]);
    expect(files(read())).toEqual([null, `${SH}b.csv`, `${SH}c.csv`]);
  });

  it("does not park a skipped story when the swap collides with it", async () => {
    const { doInstance, read } = seeded([[1, "a"], [2, "b"]], [[1, "b"], [2, "a"]], { 1: { draft: "not-a-flag" } });
    await snapshot(doInstance).catch(() => {});
    expect(read().map((r) => r.story_id).some((id) => id.startsWith("~"))).toBe(false);
  });

  it("reuses the ID of a story deleted in the same window", async () => {
    const { doInstance, read } = seeded([[1, "a"], [2, "b"]], [[1, "b"]]);
    await snapshot(doInstance);
    expect(held(read())).toEqual(["1:b"]);
    expect(files(read())).toEqual([`${SH}a.csv`]);
  });
});
