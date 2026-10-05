/**
 * The pre-snapshot dedupe picks its keeper from D1, not from array position
 *.
 *
 * `deduplicateYArray` decided a human-key collision by first occurrence, on a
 * key a client can write. That made array position a weapon: put a map
 * carrying a victim's slug above the victim's own and the DO removes the
 * victim's Y.Map, after which the orphan sweep deletes their D1 row. The
 * attacker issues no delete, so no revert and no strike ever fire.
 *
 * The fix is to ask D1 which row owns the key and keep that one. D1 is the
 * only party to the collision the client cannot write to, and the answer is
 * already on hand — `snapshotFlatEntity` performs the same `SELECT id, <key>`
 * a few statements later — so the query moves rather than multiplying. The
 * query-count test below is what holds that promise to account.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { checkD1Bind } from "./helpers/d1-memory";

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
import { markLoaded } from "./helpers/claimed-document";

const PROJECT_ID = 42;

// ---------------------------------------------------------------------------
// Recording D1: resolves the four entity SELECTs from a seed of id -> key, and
// records every prepared SQL string so reads can be counted as well as writes.
// ---------------------------------------------------------------------------

interface D1Seed {
  stories?: Array<{ id: number; story_id: string }>;
  steps?: Map<number, number[]>;      // story id -> step ids
  layers?: Map<number, number[]>;     // step id -> layer ids
  objects?: Array<{ id: number; object_id: string }>;
  glossary?: Array<{ id: number; term_id: string }>;
  pages?: Array<{ id: number; slug: string }>;
}

function makeDb(seed: D1Seed) {
  const prepared: string[] = [];
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  let lastRowId = 5000;

  function resolve(sql: string, binds: unknown[]): unknown[] {
    if (/FROM stories WHERE project_id/.test(sql)) return seed.stories ?? [];
    if (/FROM steps WHERE story_id/.test(sql)) {
      return (seed.steps?.get(binds[0] as number) ?? []).map((id) => ({ id }));
    }
    if (/FROM layers WHERE step_id/.test(sql)) {
      return (seed.layers?.get(binds[0] as number) ?? []).map((id) => ({ id }));
    }
    if (/FROM objects WHERE project_id/.test(sql)) return seed.objects ?? [];
    if (/FROM glossary_terms WHERE project_id/.test(sql)) return seed.glossary ?? [];
    if (/FROM project_pages WHERE project_id/.test(sql)) return seed.pages ?? [];
    if (/FROM project_members/.test(sql)) return [];
    return [];
  }

  function prepare(sql: string) {
    prepared.push(sql);
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return bound; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); bound = args; return stmt; },
      async run() {
        writes.push({ sql, binds: bound });
        const explicit = /^INSERT INTO \w+ \(id,/.test(sql) ? Number(bound[0]) : null;
        return {
          meta: { last_row_id: explicit !== null && Number.isFinite(explicit) ? explicit : (lastRowId += 1), changes: 1 },
          success: true as const,
        };
      },
      async all<T = unknown>() { return { results: resolve(sql, bound) as T[], success: true as const }; },
      async first<T = unknown>() {
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) {
          return { id: 1 } as T;
        }
        const rows = resolve(sql, bound) as T[];
        return (rows[0] ?? null) as T | null;
      },
    };
    return stmt;
  }

  const DB = {
    prepare,
    async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
      for (const s of statements) writes.push({ sql: s.sql, binds: s.boundArgs });
      return statements.map(() => ({ success: true }));
    },
  };

  return {
    DB,
    prepared,
    writes,
    selects: () => prepared.filter((s) => /^\s*SELECT/i.test(s)),
    deletesOf: (table: string) =>
      writes.filter((w) => new RegExp(`^DELETE FROM ${table} `).test(w.sql)).map((w) => w.binds),
  };
}

function makeDo(seed: D1Seed) {
  const db = makeDb(seed);
  const ctx = {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: db.DB as unknown, SESSION_SECRET: "test", COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  return { doInstance, db, ydoc };
}

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

function makeObject(fields: { _id: number | null; object_id: string; title?: string; created_by?: number }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("_temp_id", `t-${fields.object_id}-${fields._id}`);
  m.set("object_id", fields.object_id);
  m.set("created_by", fields.created_by ?? 1);
  m.set("title", new Y.Text(fields.title ?? fields.object_id));
  m.set("creator", new Y.Text(""));
  m.set("description", new Y.Text(""));
  m.set("alt_text", new Y.Text(""));
  m.set("period", new Y.Text(""));
  m.set("year", new Y.Text(""));
  m.set("object_type", new Y.Text(""));
  m.set("subjects", new Y.Text(""));
  m.set("source", new Y.Text(""));
  m.set("credit", new Y.Text(""));
  return m;
}

function seedConfig(ydoc: Y.Doc) {
  ydoc.transact(() => {
    const c = ydoc.getMap<unknown>("config");
    c.set("title", new Y.Text("Demo"));
    c.set("lang", "en");
  }, null);
}

/** Call the private deduplicateYArray. */
function dedupe(
  doInstance: ProjectCollaborationDO,
  arrayName: string,
  key: string,
  d1KeyToId?: Map<string, number>,
): boolean {
  return (doInstance as unknown as {
    deduplicateYArray: (
      a: string, k: string, d?: Map<string, number>,
    ) => boolean;
  }).deduplicateYArray(arrayName, key, d1KeyToId);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
// The keeper rule
// ---------------------------------------------------------------------------

describe("deduplicateYArray — keeper comes from D1", () => {
  it("gives the key to the row D1 already has, and re-keys the other", () => {
    // Both claimants are live rows, so neither may be deleted: the keeper is
    // D1's, and the loser keeps its content under a fresh key.
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 99, object_id: "vasija-muisca", title: "Attacker" }),
        makeObject({ _id: 42, object_id: "vasija-muisca", title: "Victim" }),
      ]);
    }, null);

    dedupe(doInstance, "objects", "object_id", new Map([["vasija-muisca", 42]]));

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors).toHaveLength(2);
    const victim = survivors.find((m) => m.get("_id") === 42)!;
    const attacker = survivors.find((m) => m.get("_id") === 99)!;
    expect(victim.get("object_id")).toBe("vasija-muisca");
    expect(String(victim.get("title"))).toBe("Victim");
    expect(attacker.get("object_id")).not.toBe("vasija-muisca");
  });

  it("falls back to first-with-_id when D1 knows nothing about the key", () => {
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: null, object_id: "unsaved", title: "Pending" }),
        makeObject({ _id: 7, object_id: "unsaved", title: "Persisted" }),
      ]);
    }, null);

    dedupe(doInstance, "objects", "object_id", new Map());

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    // The keeper is the persisted copy however late it sits — keeping the
    // unsaved one would re-key the entity and orphan-delete its D1 row. The
    // loser is unsaved rather than unreal, so it keeps its content under a
    // fresh key (R2-2).
    expect(survivors).toHaveLength(2);
    expect(survivors.find((m) => m.get("object_id") === "unsaved")!.get("_id")).toBe(7);
    const pending = survivors.find((m) => m.get("_id") === null)!;
    expect(String(pending.get("title"))).toBe("Pending");
    expect(pending.get("object_id")).not.toBe("unsaved");
  });

  it("gives the key to first occurrence when D1's row id matches neither claimant", () => {
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 8, object_id: "dup", title: "First" }),
        makeObject({ _id: 9, object_id: "dup", title: "Second" }),
      ]);
    }, null);

    dedupe(doInstance, "objects", "object_id", new Map([["dup", 1234]]));

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors).toHaveLength(2);
    expect(survivors[0].get("_id")).toBe(8);
    expect(survivors[0].get("object_id")).toBe("dup");
    expect(survivors[1].get("object_id")).not.toBe("dup");
  });

  it("resolves an exact-_id collision by D1's key for that row", () => {
    // Two maps claim row 42. D1 says row 42 is "vasija-muisca"; the claimant
    // that renamed itself is the loser however early it sits.
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 42, object_id: "stolen", title: "Attacker" }),
        makeObject({ _id: 42, object_id: "vasija-muisca", title: "Victim" }),
      ]);
    }, null);

    dedupe(doInstance, "objects", "object_id", new Map([["vasija-muisca", 42]]));

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors).toHaveLength(1);
    expect(String(survivors[0].get("title"))).toBe("Victim");
  });

  it("still re-keys rather than deletes in glossary mode", () => {
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      const g = ydoc.getArray<Y.Map<unknown>>("glossary");
      for (const [id, title] of [[5, "Keeper"], [6, "Loser"]] as Array<[number, string]>) {
        const m = new Y.Map<unknown>();
        m.set("_id", id);
        m.set("term_id", "muisca");
        m.set("title", new Y.Text(title));
        m.set("definition", new Y.Text(""));
        g.push([m]);
      }
    }, null);

    const rekeyed = dedupe(doInstance, "glossary", "term_id", new Map([["muisca", 6]]));

    const terms = ydoc.getArray<Y.Map<unknown>>("glossary").toArray();
    expect(rekeyed).toBe(true);
    expect(terms).toHaveLength(2);
    // D1 says row 6 owns "muisca", so row 5 is the one re-keyed.
    expect(terms.find((t) => t.get("_id") === 6)!.get("term_id")).toBe("muisca");
    expect(terms.find((t) => t.get("_id") === 5)!.get("term_id")).not.toBe("muisca");
  });

  it("falls back to first occurrence when no D1 answer is supplied at all", () => {
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 99, object_id: "dup", title: "First" }),
        makeObject({ _id: 42, object_id: "dup", title: "Second" }),
      ]);
    }, null);

    dedupe(doInstance, "objects", "object_id");

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors).toHaveLength(2);
    expect(survivors[0].get("_id")).toBe(99);
    expect(survivors[0].get("object_id")).toBe("dup");
    expect(survivors[1].get("object_id")).not.toBe("dup");
  });
});

// ---------------------------------------------------------------------------
// The duplicate-key rule through a full snapshot against the real DO
// ---------------------------------------------------------------------------

describe("The whole shape, against the real Durable Object", () => {
  it("reverts the rename, keeps both rows, and records a strike", async () => {
    const { doInstance, db, ydoc } = makeDo({
      objects: [
        { id: 42, object_id: "vasija-muisca" },
        { id: 99, object_id: "my-thing" },
      ],
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 42, object_id: "vasija-muisca", title: "Victim", created_by: 1 }),
        makeObject({ _id: 99, object_id: "my-thing", title: "Attacker", created_by: 7 }),
      ]);
    }, null);

    const attackerSocket = {
      deserializeAttachment: () => ({ userId: 7, role: "collaborator" as const }),
      send: vi.fn(),
      close: vi.fn(),
    };
    const objects = ydoc.getArray<Y.Map<unknown>>("objects");

    // 1. Rename the attacker's own object onto the victim's slug.
    ydoc.transact(() => { objects.get(1).set("object_id", "vasija-muisca"); }, attackerSocket);
    // 2. Drag it above the victim's — a faithful clone-delete-insert reorder.
    ydoc.transact(() => {
      const source = objects.get(1);
      const clone = new Y.Map<unknown>();
      for (const [k, v] of source.entries()) {
        clone.set(k, v instanceof Y.Text ? new Y.Text(v.toString()) : v);
      }
      objects.delete(1, 1);
      objects.insert(0, [clone]);
    }, attackerSocket);
    // 3. Snapshot.
    await snapshot(doInstance);

    // The rename never landed, so nothing collides and nothing is swept.
    expect(objects.toArray().map((m) => m.get("object_id"))).toEqual([
      "my-thing", "vasija-muisca",
    ]);
    expect(objects.toArray().map((m) => m.get("_id"))).toEqual([99, 42]);
    expect(db.deletesOf("objects")).toEqual([]);
    // And the attempt cost the attacker a strike. The close is STAGED rather
    // than issued: it belongs behind the write that records what the document
    // now holds, and the message handler's drain is what issues it. These
    // transactions are driven straight at the document, so the queue is where
    // the strike is observable.
    const staged = (doInstance as unknown as {
      stagedEffects: { closes: Array<{ ws: unknown; code: number; reason: string }> };
    }).stagedEffects;
    expect(attackerSocket.close).not.toHaveBeenCalled();
    expect(staged.closes).toEqual([]);
    ydoc.transact(() => { objects.get(0).set("object_id", "x"); }, attackerSocket);
    ydoc.transact(() => { objects.get(0).set("object_id", "y"); }, attackerSocket);
    expect(staged.closes).toContainEqual({
      ws: attackerSocket,
      code: 1008,
      reason: "Repeated unauthorised delete attempts",
    });
  });
});

describe("The victim's D1 row survives a slug collision", () => {
  it("does not orphan-delete the victim's row when a rival claims its slug", async () => {
    const { doInstance, db, ydoc } = makeDo({
      objects: [
        { id: 42, object_id: "vasija-muisca" },
        { id: 99, object_id: "my-thing" },
      ],
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 99, object_id: "vasija-muisca", title: "Attacker", created_by: 7 }),
        makeObject({ _id: 42, object_id: "vasija-muisca", title: "Victim", created_by: 1 }),
      ]);
    }, null);

    await snapshot(doInstance);

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    // Neither row may be swept: both are live, and the rival's claim on the
    // slug is settled by re-keying the rival, not by deleting anybody.
    expect(survivors).toHaveLength(2);
    expect(survivors.find((m) => m.get("_id") === 42)!.get("object_id"))
      .toBe("vasija-muisca");
    expect(survivors.find((m) => m.get("_id") === 99)!.get("object_id"))
      .not.toBe("vasija-muisca");
    expect(db.deletesOf("objects")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The traffic promise
// ---------------------------------------------------------------------------

describe("snapshot D1 traffic", () => {
  it("issues exactly one keyed SELECT per top-level entity table", async () => {
    const { doInstance, db, ydoc } = makeDo({
      stories: [{ id: 11, story_id: "s1" }],
      steps: new Map([[11, [21]]]),
      layers: new Map([[21, []]]),
      objects: [{ id: 31, object_id: "o1" }],
      glossary: [{ id: 41, term_id: "g1" }],
      pages: [{ id: 51, slug: "p1" }],
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_id", 11);
      story.set("story_id", "s1");
      story.set("title", new Y.Text("S"));
      story.set("subtitle", new Y.Text(""));
      story.set("byline", new Y.Text(""));
      const steps = new Y.Array<Y.Map<unknown>>();
      const step = new Y.Map<unknown>();
      step.set("_id", 21);
      step.set("object_id", "o1");
      step.set("layers", new Y.Array<Y.Map<unknown>>());
      steps.push([step]);
      story.set("steps", steps);
      ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
      ydoc.getArray<Y.Map<unknown>>("objects").push([makeObject({ _id: 31, object_id: "o1" })]);
      const term = new Y.Map<unknown>();
      term.set("_id", 41);
      term.set("term_id", "g1");
      term.set("title", new Y.Text("G"));
      term.set("definition", new Y.Text(""));
      ydoc.getArray<Y.Map<unknown>>("glossary").push([term]);
      const page = new Y.Map<unknown>();
      page.set("_id", 51);
      page.set("slug", "p1");
      page.set("title", new Y.Text("P"));
      page.set("body", new Y.Text(""));
      ydoc.getArray<Y.Map<unknown>>("pages").push([page]);
    }, null);

    await snapshot(doInstance);

    const count = (re: RegExp) => db.selects().filter((s) => re.test(s)).length;
    // One per table, each already carrying its human key — the dedupe keeper
    // and the adopt-or-reinsert branch share the single read.
    expect(count(/FROM stories WHERE project_id/)).toBe(1);
    expect(count(/FROM objects WHERE project_id/)).toBe(1);
    expect(count(/FROM glossary_terms WHERE project_id/)).toBe(1);
    expect(count(/FROM project_pages WHERE project_id/)).toBe(1);
    // The nested walkers are per-parent and untouched by the keeper change.
    expect(count(/FROM steps WHERE story_id/)).toBe(1);
    expect(count(/FROM layers WHERE step_id/)).toBe(1);
    // And every entity SELECT fetches the human key alongside the id.
    expect(db.selects().filter((s) => /FROM stories WHERE project_id/.test(s))[0])
      .toMatch(/SELECT id, story_id FROM stories/);
    expect(db.selects().filter((s) => /FROM objects WHERE project_id/.test(s))[0])
      .toMatch(/SELECT id, object_id FROM objects/);
  });
});
