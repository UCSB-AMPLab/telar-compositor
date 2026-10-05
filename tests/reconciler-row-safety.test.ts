/**
 * The reconciler must never delete another member's persisted D1 row, whatever
 * shape the document takes.
 *
 * Two ways the snapshot reconciler reaches a `DELETE` it was never asked for:
 *
 * 1. **Dedupe by key (F1).** Two Y.Maps carrying DISTINCT non-null `_id`s — two
 *    live rows — collide on a human key. `pages.slug` and `glossary.term_id`
 *    are rename features, so a collision is reachable by an ordinary,
 *    permitted edit. Deleting the non-keeper drops a live Y.Map out of the
 *    document, and the orphan sweep then deletes its D1 row. A mangled key is
 *    recoverable; a deleted entity is not — so the non-keeper is RE-KEYED.
 *
 * 2. **A failed INSERT (F4).** A Y.Map with `_id: null` whose key already
 *    belongs to a live D1 row cannot be inserted: the UNIQUE index refuses it.
 *    `insertRow` swallows that (a snapshot must not abort mid-flush) and
 *    returns id 0 — after which the colliding row is still sitting in the
 *    orphan set, and the sweep deletes the very row the INSERT collided with.
 *
 * The invariant both halves pin: no document shape a collaborator can author
 * causes another member's persisted row to be deleted.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";

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
import { signInternalMarker } from "../workers/auth";
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const SECRET = "test-session-secret";

// ---------------------------------------------------------------------------
// A D1 that answers the four entity SELECTs from a seed, records every write,
// and — this is what the F4 half needs — REFUSES an INSERT whose human key is
// already taken, exactly as the UNIQUE indexes do (stories(project_id,
// story_id) from migration 0002, project_pages(project_id, slug) from 0021).
// ---------------------------------------------------------------------------

interface D1Seed {
  stories?: Array<{ id: number; story_id: string }>;
  objects?: Array<{ id: number; object_id: string }>;
  glossary?: Array<{ id: number; term_id: string }>;
  pages?: Array<{ id: number; slug: string }>;
}

function makeDb(seed: D1Seed) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  let lastRowId = 5000;

  // Columns guarded by a UNIQUE(project_id, key) index in the real schema.
  const uniqueKeyColumn: Record<string, string> = {
    stories: "story_id",
    project_pages: "slug",
  };

  function takenKeys(table: string): Set<string> {
    if (table === "stories") return new Set((seed.stories ?? []).map((r) => r.story_id));
    if (table === "project_pages") return new Set((seed.pages ?? []).map((r) => r.slug));
    return new Set();
  }

  function resolve(sql: string, binds: unknown[]): unknown[] {
    if (/FROM stories WHERE project_id/.test(sql)) return seed.stories ?? [];
    if (/FROM steps WHERE story_id/.test(sql)) return [];
    if (/FROM layers WHERE step_id/.test(sql)) return [];
    if (/FROM objects WHERE project_id/.test(sql)) return seed.objects ?? [];
    if (/FROM glossary_terms WHERE project_id/.test(sql)) return seed.glossary ?? [];
    if (/FROM project_pages WHERE project_id/.test(sql)) return seed.pages ?? [];
    void binds;
    return [];
  }

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return bound; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); bound = args; return stmt; },
      async run() {
        const insert = /^INSERT INTO (\w+) \(([^)]*)\)/.exec(sql);
        if (insert) {
          const table = insert[1];
          const cols = insert[2].split(",").map((c) => c.trim().replace(/"/g, ""));
          const keyCol = uniqueKeyColumn[table];
          if (keyCol) {
            const at = cols.indexOf(keyCol);
            const value = at >= 0 ? String(bound[at] ?? "") : "";
            if (takenKeys(table).has(value)) {
              throw new Error(`D1_ERROR: UNIQUE constraint failed: ${table}.${keyCol}`);
            }
          }
        }
        writes.push({ sql, binds: bound });
        const explicit = /^INSERT INTO \w+ \(id,/.test(sql) ? Number(bound[0]) : null;
        return {
          meta: {
            last_row_id:
              explicit !== null && Number.isFinite(explicit) ? explicit : (lastRowId += 1),
            changes: 1,
          },
          success: true as const,
        };
      },
      async all<T = unknown>() {
        return { results: resolve(sql, bound) as T[], success: true as const };
      },
      async first<T = unknown>() {
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) {
          return { id: 1 } as T;
        }
        return ((resolve(sql, bound) as T[])[0] ?? null) as T | null;
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
    writes,
    deletedIdsFrom: (table: string) =>
      writes
        .filter((w) => new RegExp(`^DELETE FROM ${table} `).test(w.sql))
        .map((w) => w.binds[0]),
    updatesOf: (table: string) =>
      writes.filter((w) => new RegExp(`^UPDATE ${table} SET`).test(w.sql)),
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
    { DB: db.DB as unknown, SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  seedConfig(ydoc);
  return { doInstance, db, ydoc };
}

function seedConfig(ydoc: Y.Doc) {
  ydoc.transact(() => {
    const c = ydoc.getMap<unknown>("config");
    c.set("title", new Y.Text("Demo"));
    c.set("lang", "en");
  }, null);
}

function snapshot(doInstance: ProjectCollaborationDO): Promise<void> {
  return (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

function makePage(fields: { _id: number | null; slug: string; title?: string }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("slug", fields.slug);
  m.set("title", new Y.Text(fields.title ?? fields.slug));
  m.set("body", new Y.Text("body"));
  m.set("created_by", 1);
  return m;
}

function makeObject(fields: { _id: number | null; object_id: string; title?: string }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("object_id", fields.object_id);
  m.set("created_by", 1);
  for (const k of [
    "title", "creator", "description", "alt_text", "period", "year",
    "object_type", "subjects", "source", "credit",
  ]) {
    m.set(k, new Y.Text(k === "title" ? (fields.title ?? fields.object_id) : ""));
  }
  return m;
}

function makeStory(fields: { _id: number | null; story_id: string; title?: string }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("story_id", fields.story_id);
  m.set("title", new Y.Text(fields.title ?? fields.story_id));
  m.set("subtitle", new Y.Text(""));
  m.set("byline", new Y.Text(""));
  m.set("created_by", 1);
  m.set("steps", new Y.Array<Y.Map<unknown>>());
  return m;
}

function push(ydoc: Y.Doc, root: string, maps: Y.Map<unknown>[]) {
  ydoc.transact(() => {
    ydoc.getArray<Y.Map<unknown>>(root).push(maps);
  }, null);
}

function keysOf(ydoc: Y.Doc, root: string, key: string): unknown[] {
  return ydoc.getArray<Y.Map<unknown>>(root).toArray().map((m) => m.get(key));
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  warn = vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
});
afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

// ---------------------------------------------------------------------------
// F1 — a key collision between two LIVE rows is re-keyed, never deleted
// ---------------------------------------------------------------------------

describe("F1 — a key collision between two persisted rows never deletes one", () => {
  it("pages: renaming a page onto another's slug keeps BOTH rows", async () => {
    // The attack that survives D1's keeper rule. `slug` is a rename
    // feature, so writing the victim's page onto the attacker's slug is a
    // permitted edit. D1's keeper rule then correctly names the attacker's map
    // owner of "attacker" — and the victim's map, a distinct live row, was
    // pushed to indicesToDelete and its D1 row orphan-swept.
    const { doInstance, db, ydoc } = makeDo({
      pages: [{ id: 10, slug: "attacker" }, { id: 20, slug: "victim" }],
    });
    push(ydoc, "pages", [
      makePage({ _id: 10, slug: "attacker", title: "Attacker" }),
      makePage({ _id: 20, slug: "attacker", title: "Victim" }),
    ]);

    await snapshot(doInstance);

    expect(db.deletedIdsFrom("project_pages")).not.toContain(20);
    expect(db.deletedIdsFrom("project_pages")).toEqual([]);
    const pages = ydoc.getArray<Y.Map<unknown>>("pages").toArray();
    expect(pages).toHaveLength(2);
    const victim = pages.find((p) => p.get("_id") === 20)!;
    expect(victim).toBeDefined();
    expect(victim.get("slug")).not.toBe("attacker");
    expect(String(victim.get("title"))).toBe("Victim");
    // The re-key must reach D1 too, or the next snapshot re-runs the collision.
    const slugWrites = db.updatesOf("project_pages").map((w) => w.binds);
    expect(slugWrites.some((b) => b[1] === victim.get("slug"))).toBe(true);
  });

  it("pages: the minted slug avoids every live key, in the doc and in D1", async () => {
    // project_pages(project_id, slug) is UNIQUE (migration 0021), so a re-key
    // onto a slug D1 already holds would abort the whole snapshot batch.
    const { doInstance, ydoc } = makeDo({
      pages: [
        { id: 10, slug: "about" },
        { id: 20, slug: "about-2" },
        { id: 30, slug: "about-3" },
      ],
    });
    push(ydoc, "pages", [
      makePage({ _id: 10, slug: "about" }),
      makePage({ _id: 20, slug: "about" }),
      makePage({ _id: 30, slug: "about-3" }),
    ]);

    await snapshot(doInstance);

    const slugs = keysOf(ydoc, "pages", "slug");
    expect(new Set(slugs).size).toBe(3);
    const rekeyed = ydoc.getArray<Y.Map<unknown>>("pages").toArray()
      .find((p) => p.get("_id") === 20)!;
    expect(rekeyed.get("slug")).not.toBe("about");
    expect(rekeyed.get("slug")).not.toBe("about-2"); // D1 row 20's own live slug
    expect(rekeyed.get("slug")).not.toBe("about-3"); // D1 row 30's live slug
  });

  it("objects: a slug collision between two live rows keeps BOTH", async () => {
    const { doInstance, db, ydoc } = makeDo({
      objects: [{ id: 42, object_id: "vasija" }, { id: 99, object_id: "mine" }],
    });
    push(ydoc, "objects", [
      makeObject({ _id: 99, object_id: "vasija", title: "Attacker" }),
      makeObject({ _id: 42, object_id: "vasija", title: "Victim" }),
    ]);

    await snapshot(doInstance);

    expect(db.deletedIdsFrom("objects")).toEqual([]);
    expect(ydoc.getArray<Y.Map<unknown>>("objects").length).toBe(2);
  });

  it("stories: a story_id collision between two live rows keeps BOTH", async () => {
    const { doInstance, db, ydoc } = makeDo({
      stories: [{ id: 42, story_id: "cronica" }, { id: 99, story_id: "mine" }],
    });
    push(ydoc, "stories", [
      makeStory({ _id: 99, story_id: "cronica", title: "Attacker" }),
      makeStory({ _id: 42, story_id: "cronica", title: "Victim" }),
    ]);

    await snapshot(doInstance);

    expect(db.deletedIdsFrom("stories")).toEqual([]);
    expect(ydoc.getArray<Y.Map<unknown>>("stories").length).toBe(2);
  });
});

describe("F1 — the one collision that stays a deletion", () => {
  it("an exact-_id duplicate (the same persisted row twice) still collapses", async () => {
    const { doInstance, db, ydoc } = makeDo({
      pages: [{ id: 10, slug: "about" }],
    });
    push(ydoc, "pages", [
      makePage({ _id: 10, slug: "about", title: "One" }),
      makePage({ _id: 10, slug: "about", title: "Two" }),
    ]);

    await snapshot(doInstance);

    expect(ydoc.getArray<Y.Map<unknown>>("pages").length).toBe(1);
    expect(db.deletedIdsFrom("project_pages")).toEqual([]);
  });

  it("an unsaved `_id: null` twin keeps its content under a fresh slug", async () => {
    // An `_id: null` map is unsaved, not disposable — before a project's first
    // snapshot every map carries one — so it is re-keyed like any other loser
    // (R2-2). The persisted row keeps the slug, which is what keeps it out of
    // the orphan sweep.
    const { doInstance, db, ydoc } = makeDo({
      pages: [{ id: 10, slug: "about" }],
    });
    push(ydoc, "pages", [
      makePage({ _id: 10, slug: "about", title: "Saved" }),
      makePage({ _id: null, slug: "about", title: "Unsaved twin" }),
    ]);

    await snapshot(doInstance);

    const pages = ydoc.getArray<Y.Map<unknown>>("pages").toArray();
    expect(pages).toHaveLength(2);
    expect(pages[0].get("_id")).toBe(10);
    expect(pages[0].get("slug")).toBe("about");
    expect(String(pages[1].get("title"))).toBe("Unsaved twin");
    expect(pages[1].get("slug")).not.toBe("about");
    expect(db.deletedIdsFrom("project_pages")).toEqual([]);
  });
});

describe("F1 — ordinary editing is untouched", () => {
  it("a plain rename to a free slug is neither re-keyed nor deleted", async () => {
    const { doInstance, db, ydoc } = makeDo({
      pages: [{ id: 10, slug: "about" }, { id: 20, slug: "contact" }],
    });
    push(ydoc, "pages", [
      makePage({ _id: 10, slug: "about-us" }), // the rename under test
      makePage({ _id: 20, slug: "contact" }),
    ]);

    await snapshot(doInstance);

    expect(keysOf(ydoc, "pages", "slug")).toEqual(["about-us", "contact"]);
    expect(db.deletedIdsFrom("project_pages")).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Deduplicated"));
  });

  it("a brand-new page with a free slug is inserted, and nothing is swept", async () => {
    const { doInstance, db, ydoc } = makeDo({
      pages: [{ id: 10, slug: "about" }],
    });
    push(ydoc, "pages", [
      makePage({ _id: 10, slug: "about" }),
      makePage({ _id: null, slug: "credits" }),
    ]);

    await snapshot(doInstance);

    expect(ydoc.getArray<Y.Map<unknown>>("pages").length).toBe(2);
    expect(db.deletedIdsFrom("project_pages")).toEqual([]);
    expect(db.writes.some((w) => /^INSERT INTO project_pages/.test(w.sql))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F4 — a refused INSERT must not turn into a DELETE of the colliding row
// ---------------------------------------------------------------------------

describe("F4 — an INSERT the UNIQUE index refuses never orphans the row it hit", () => {
  it("stories: the live row survives, and its steps are not cascaded away", async () => {
    // The document has lost the map for row 55 (a Durable Object evicted
    // between the committed INSERT and the blob write comes back from a blob
    // that predates it) while D1 still holds the row. A fresh map claiming the
    // same story_id cannot be inserted — and the sweep then deleted row 55.
    const { doInstance, db, ydoc } = makeDo({
      stories: [{ id: 55, story_id: "orphan-1" }],
    });
    push(ydoc, "stories", [makeStory({ _id: null, story_id: "orphan-1" })]);

    await snapshot(doInstance);

    expect(db.deletedIdsFrom("stories")).not.toContain(55);
    expect(db.deletedIdsFrom("stories")).toEqual([]);
  });

  it("pages: the live row survives a refused re-INSERT of its slug", async () => {
    const { doInstance, db, ydoc } = makeDo({
      pages: [{ id: 77, slug: "about" }],
    });
    push(ydoc, "pages", [makePage({ _id: null, slug: "about" })]);

    await snapshot(doInstance);

    expect(db.deletedIdsFrom("project_pages")).toEqual([]);
  });

  it("/restore-orphans does not destroy a story D1 already holds", async () => {
    const { doInstance, db } = makeDo({
      stories: [{ id: 55, story_id: "orphan-1" }],
    });

    const { sigHex, timestamp } = await signInternalMarker(
      PROJECT_ID, SECRET, "restore-orphans",
    );
    const res = await doInstance.fetch(new Request("https://internal/restore-orphans", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stories: [{ storyId: "orphan-1", steps: [], layers: [] }] }),
    }));

    expect(res.status).toBe(200);
    expect(db.deletedIdsFrom("stories")).toEqual([]);
  });

  it("/restore-orphans still restores a story D1 does not hold", async () => {
    const { doInstance, db, ydoc } = makeDo({ stories: [] });

    const { sigHex, timestamp } = await signInternalMarker(
      PROJECT_ID, SECRET, "restore-orphans",
    );
    const res = await doInstance.fetch(new Request("https://internal/restore-orphans", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stories: [{ storyId: "brand-new", steps: [], layers: [] }] }),
    }));

    expect(res.status).toBe(200);
    expect((await res.json() as { restored: number }).restored).toBe(1);
    expect(keysOf(ydoc, "stories", "story_id")).toEqual(["brand-new"]);
    expect(db.writes.some((w) => /^INSERT INTO stories/.test(w.sql))).toBe(true);
  });
});
