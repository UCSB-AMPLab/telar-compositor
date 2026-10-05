/**
 * An `_id: null` entity is unsaved, not disposable (R2-2).
 *
 * Before a project's first snapshot every top-level Y.Map carries `_id: null`,
 * so "no D1 row behind it" does not mean "nothing behind it" — it means the
 * work has not reached D1 yet. A null `_id` is therefore no licence to delete a
 * same-key non-keeper: the key and the array position are both client-writable,
 * so a peer who could trade a null on that branch would need only to place a
 * hollow map carrying someone else's key above their real one to have the DO
 * remove the real one.
 *
 * The duplicate-key rule settles this too: deletion is right only for an
 * exact-`_id` duplicate — one persisted row claimed twice. Anything else that
 * carries a key is an entity somebody is writing, and the collision is settled
 * by re-keying the loser.
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

interface D1Seed {
  stories?: Array<{ id: number; story_id: string }>;
  steps?: Map<number, number[]>;
  layers?: Map<number, number[]>;
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
    insertsInto: (table: string) =>
      writes.filter((w) => new RegExp(`^INSERT INTO ${table}[ (]`).test(w.sql)).map((w) => w.binds),
    deletesOf: (table: string) =>
      writes.filter((w) => new RegExp(`^DELETE FROM ${table} `).test(w.sql)).map((w) => w.binds),
    updatesOf: (table: string) =>
      writes.filter((w) => new RegExp(`^UPDATE ${table} `).test(w.sql)).map((w) => w.binds),
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

function makeStory(fields: { _id: number | null; story_id: string; title?: string; created_by?: number }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("story_id", fields.story_id);
  m.set("created_by", fields.created_by ?? 1);
  m.set("title", new Y.Text(fields.title ?? ""));
  m.set("subtitle", new Y.Text(""));
  m.set("byline", new Y.Text(""));
  m.set("steps", new Y.Array<Y.Map<unknown>>());
  return m;
}

function makePage(fields: { _id: number | null; slug: string; title?: string; created_by?: number }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("slug", fields.slug);
  m.set("created_by", fields.created_by ?? 1);
  m.set("title", new Y.Text(fields.title ?? ""));
  m.set("body", new Y.Text(""));
  return m;
}

function makeObject(fields: { _id: number | null; object_id: string; title?: string; created_by?: number }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("_temp_id", `t-${fields.object_id}-${fields._id}`);
  m.set("object_id", fields.object_id);
  m.set("created_by", fields.created_by ?? 1);
  m.set("title", new Y.Text(fields.title ?? fields.object_id));
  for (const f of ["creator", "description", "alt_text", "period", "year", "object_type", "subjects", "source", "credit"]) {
    m.set(f, new Y.Text(""));
  }
  return m;
}

function seedConfig(ydoc: Y.Doc) {
  ydoc.transact(() => {
    const c = ydoc.getMap<unknown>("config");
    c.set("title", new Y.Text("Demo"));
    c.set("lang", "en");
  }, null);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------
// R2-2 — the reported probe
// ---------------------------------------------------------------------------

describe("R2-2 — an unsaved same-key entity is re-keyed, never deleted", () => {
  it("keeps a peer's unsaved story when a hollow map claims its slug from above", () => {
    // Before the first snapshot every map is _id: null and D1 knows no keys, so
    // nothing but the array position separates the two — and a client writes that.
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: null, story_id: "shared-slug", title: "", created_by: 7 }),
        makeStory({ _id: null, story_id: "shared-slug", title: "A whole afternoon of work", created_by: 9 }),
      ]);
    }, null);

    dedupe(doInstance, "stories", "story_id", new Map());

    const survivors = ydoc.getArray<Y.Map<unknown>>("stories").toArray();
    expect(survivors.map((m) => ({ by: m.get("created_by"), title: String(m.get("title")) })))
      .toEqual([
        { by: 7, title: "" },
        { by: 9, title: "A whole afternoon of work" },
      ]);
    // The loser keeps its content under a fresh, collision-free key.
    expect(survivors[0].get("story_id")).toBe("shared-slug");
    expect(survivors[1].get("story_id")).not.toBe("shared-slug");
    expect(String(survivors[1].get("story_id"))).toMatch(/^shared-slug-\d+$/);
  });

  it("keeps an unsaved page whose slug a live D1 row already owns", () => {
    // D1 answers the collision (row 42 owns the slug), so the persisted page is
    // the keeper — but the unsaved claimant is still somebody's draft.
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: null, slug: "about", title: "Draft nobody has saved", created_by: 7 }),
        makePage({ _id: 42, slug: "about", title: "Live page", created_by: 9 }),
      ]);
    }, null);

    dedupe(doInstance, "pages", "slug", new Map([["about", 42]]));

    const survivors = ydoc.getArray<Y.Map<unknown>>("pages").toArray();
    expect(survivors).toHaveLength(2);
    expect(survivors.find((m) => m.get("_id") === 42)!.get("slug")).toBe("about");
    const draft = survivors.find((m) => m.get("_id") === null)!;
    expect(String(draft.get("title"))).toBe("Draft nobody has saved");
    expect(draft.get("slug")).not.toBe("about");
  });

  it("does the same for objects", () => {
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: null, object_id: "vasija", title: "", created_by: 7 }),
        makeObject({ _id: null, object_id: "vasija", title: "Vasija muisca", created_by: 9 }),
      ]);
    }, null);

    dedupe(doInstance, "objects", "object_id", new Map());

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors).toHaveLength(2);
    expect(String(survivors[1].get("title"))).toBe("Vasija muisca");
  });

  it("mints a key that avoids both the document's keys and D1's", () => {
    // "shared-slug-2" is taken in the document and "shared-slug-3" in D1, so a
    // naive suffix would collide with a UNIQUE index and abort the batch.
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: null, slug: "p", title: "Keeper" }),
        makePage({ _id: null, slug: "p", title: "Loser" }),
        makePage({ _id: null, slug: "p-2", title: "Already taken here" }),
      ]);
    }, null);

    dedupe(doInstance, "pages", "slug", new Map([["p-3", 77]]));

    const slugs = ydoc.getArray<Y.Map<unknown>>("pages").toArray().map((m) => m.get("slug"));
    expect(slugs).toEqual(["p", "p-4", "p-2"]);
  });

  it("re-keying reports true so the mutated doc is broadcast", () => {
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: null, story_id: "s" }),
        makeStory({ _id: null, story_id: "s" }),
      ]);
    }, null);

    expect(dedupe(doInstance, "stories", "story_id", new Map())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What two same-key unsaved maps produce downstream
// ---------------------------------------------------------------------------

describe("R2-2 — through a full snapshot", () => {
  it("INSERTs two rows with distinct slugs and deletes nothing", async () => {
    const { doInstance, db, ydoc } = makeDo({});
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: null, slug: "about", title: "Mine", created_by: 7 }),
        makePage({ _id: null, slug: "about", title: "Theirs", created_by: 9 }),
      ]);
    }, null);

    await snapshot(doInstance);

    const slugs = ydoc.getArray<Y.Map<unknown>>("pages").toArray().map((m) => m.get("slug"));
    expect(slugs).toEqual(["about", "about-2"]);
    // Both got a row, and both kept their _id backfilled.
    expect(db.insertsInto("project_pages")).toHaveLength(2);
    expect(ydoc.getArray<Y.Map<unknown>>("pages").toArray().map((m) => m.get("_id")))
      .not.toContain(null);
    expect(db.deletesOf("project_pages")).toEqual([]);
  });

  it("INSERTs two stories with distinct story_ids and deletes nothing", async () => {
    const { doInstance, db, ydoc } = makeDo({});
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: null, story_id: "shared-slug", title: "", created_by: 7 }),
        makeStory({ _id: null, story_id: "shared-slug", title: "A whole afternoon of work", created_by: 9 }),
      ]);
    }, null);

    await snapshot(doInstance);

    const stories = ydoc.getArray<Y.Map<unknown>>("stories").toArray();
    expect(stories.map((m) => String(m.get("title"))))
      .toEqual(["", "A whole afternoon of work"]);
    expect(stories.map((m) => m.get("story_id"))).toEqual(["shared-slug", "shared-slug-2"]);
    expect(db.insertsInto("stories")).toHaveLength(2);
    expect(db.deletesOf("stories")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The honest paths — these must not change
// ---------------------------------------------------------------------------

describe("ordinary editing is untouched", () => {
  it("leaves a single new entity alone (no dedupe, one INSERT)", async () => {
    const { doInstance, db, ydoc } = makeDo({});
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: null, slug: "about", title: "About" }),
      ]);
    }, null);

    await snapshot(doInstance);

    expect(ydoc.getArray<Y.Map<unknown>>("pages").toArray().map((m) => m.get("slug")))
      .toEqual(["about"]);
    expect(db.insertsInto("project_pages")).toHaveLength(1);
    expect(db.deletesOf("project_pages")).toEqual([]);
  });

  it("leaves two people's simultaneous, differently-keyed additions alone", () => {
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: null, object_id: "one", created_by: 7 }),
        makeObject({ _id: null, object_id: "two", created_by: 9 }),
      ]);
    }, null);

    expect(dedupe(doInstance, "objects", "object_id", new Map())).toBe(false);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").toArray().map((m) => m.get("object_id")))
      .toEqual(["one", "two"]);
  });

  it("still collapses a genuine same-row duplicate by delete, not re-key", () => {
    // Two Y.Maps claiming one persisted row: re-keying would mint a phantom row
    // out of one real one, so this stays a delete in every mode.
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 42, object_id: "vasija", title: "First" }),
        makeObject({ _id: 42, object_id: "vasija", title: "Second" }),
      ]);
    }, null);

    dedupe(doInstance, "objects", "object_id", new Map([["vasija", 42]]));

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors).toHaveLength(1);
    expect(survivors[0].get("object_id")).toBe("vasija");
    expect(survivors[0].get("_id")).toBe(42);
  });

  it("collapses same-_id maps that disagree about the key, keeping D1's key", () => {
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 42, object_id: "stolen", title: "Renamed" }),
        makeObject({ _id: 42, object_id: "vasija", title: "Victim" }),
      ]);
    }, null);

    dedupe(doInstance, "objects", "object_id", new Map([["vasija", 42]]));

    const survivors = ydoc.getArray<Y.Map<unknown>>("objects").toArray();
    expect(survivors).toHaveLength(1);
    expect(String(survivors[0].get("title"))).toBe("Victim");
    expect(survivors[0].get("object_id")).toBe("vasija");
  });

  it("leaves a cold rebuild from D1 completely untouched", async () => {
    // Every map carries its D1 id and a distinct key: nothing to dedupe, no
    // re-key broadcast, no INSERT, no DELETE.
    const { doInstance, db, ydoc } = makeDo({
      stories: [{ id: 11, story_id: "s1" }],
      steps: new Map([[11, []]]),
      objects: [{ id: 31, object_id: "o1" }],
      pages: [{ id: 51, slug: "p1" }],
    });
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("stories").push([makeStory({ _id: 11, story_id: "s1" })]);
      ydoc.getArray<Y.Map<unknown>>("objects").push([makeObject({ _id: 31, object_id: "o1" })]);
      ydoc.getArray<Y.Map<unknown>>("pages").push([makePage({ _id: 51, slug: "p1" })]);
    }, null);

    await snapshot(doInstance);

    expect(ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("story_id")).toBe("s1");
    expect(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("object_id")).toBe("o1");
    expect(ydoc.getArray<Y.Map<unknown>>("pages").get(0).get("slug")).toBe("p1");
    expect(db.insertsInto("stories")).toEqual([]);
    expect(db.insertsInto("objects")).toEqual([]);
    expect(db.insertsInto("project_pages")).toEqual([]);
    expect(db.deletesOf("stories")).toEqual([]);
    expect(db.deletesOf("objects")).toEqual([]);
    expect(db.deletesOf("project_pages")).toEqual([]);
  });

  it("never touches maps that carry no key at all", () => {
    const { doInstance, ydoc } = makeDo({});
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: null, object_id: "" }),
        makeObject({ _id: null, object_id: "" }),
      ]);
    }, null);

    expect(dedupe(doInstance, "objects", "object_id", new Map())).toBe(false);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").toArray()).toHaveLength(2);
  });
});
