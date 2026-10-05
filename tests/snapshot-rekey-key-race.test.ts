/**
 * What a minted page slug costs when a writer outside the DO takes it first
 * (R2-5) — a characterization of D1's semantics, not of a reachable state.
 *
 * `fetchEntityKeys` reads `project_pages.slug` at the top of a snapshot; the
 * re-key it seeds lands in D1 as an `UPDATE project_pages SET ... slug = ?` in
 * the batch at the very end. Nothing serialises that window, and D1 exposes no
 * interactive transaction across statements, so the seed cannot be made to
 * reserve the key; the only atomic unit is the batch itself, and the read is
 * outside it.
 *
 * That is why the fix removed the writer rather than widening the
 * read: page import now goes through the DO's /ingest-sync `pages.insert` arm,
 * which mutates the document and snapshots inside `blockConcurrencyWhile`, so
 * no page write can interleave with a snapshot at all
 * (`tests/pages-import-through-do.test.ts`). The two properties below are what
 * a reintroduced outside writer would cost, and are pinned so the cost stays
 * legible.
 *
 * Two properties matter and both are pinned below:
 *
 *   1. BLAST RADIUS. `DB.batch` is one transaction, so a UNIQUE violation on
 *      one page's slug discards every other statement in it — every story,
 *      object and glossary UPDATE, and every orphan DELETE — and the snapshot
 *      throws.
 *   2. NO SELF-HEAL. The re-key is already in the Y.Doc and in the standalone
 *      blob write that precedes the batch, so nothing is lost; but the next
 *      snapshot sees no document-internal collision to dedupe and re-issues the
 *      same colliding UPDATE. Dedupe settles doc-vs-doc collisions; this one is
 *      doc-vs-D1, which no pass owns.
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
import { markLoaded } from "./helpers/claimed-document";
import { trackBaseRow } from "./helpers/base-row";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;

interface Seed {
  stories?: Array<{ id: number; story_id: string }>;
  pages?: Array<{ id: number; slug: string }>;
  /**
   * Slugs the UNIQUE index enforces but the SELECT does not report — rows a
   * writer outside the DO created after this snapshot took its seed.
   */
  slugsTakenAfterRead?: string[];
}

function makeDb(seed: Seed) {
  const writes: Array<{ sql: string; binds: unknown[] }> = [];
  const applied: Array<{ sql: string; binds: unknown[] }> = [];
  let lastRowId = 5000;

  function resolve(sql: string): unknown[] {
    if (/FROM stories WHERE project_id/.test(sql)) return seed.stories ?? [];
    if (/FROM steps WHERE story_id/.test(sql)) return [];
    if (/FROM layers WHERE step_id/.test(sql)) return [];
    if (/FROM objects WHERE project_id/.test(sql)) return [];
    if (/FROM glossary_terms WHERE project_id/.test(sql)) return [];
    if (/FROM project_pages WHERE project_id/.test(sql)) return seed.pages ?? [];
    if (/FROM project_members/.test(sql)) return [];
    return [];
  }

  const taken = new Set(seed.slugsTakenAfterRead ?? []);
  const violates = (s: { sql: string; binds: unknown[] }): boolean =>
    /project_pages/.test(s.sql) && s.binds.some((b) => typeof b === "string" && taken.has(b));

  const row = trackBaseRow();

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return bound; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); bound = args; return stmt; },
      async run() {
        writes.push({ sql, binds: bound });
        if (violates({ sql, binds: bound })) {
          throw new Error("D1_ERROR: UNIQUE constraint failed: project_pages.project_id, project_pages.slug");
        }
        applied.push({ sql, binds: bound });
        row.note(sql);
        return { meta: { last_row_id: (lastRowId += 1), changes: 1 }, success: true as const };
      },
      async all<T = unknown>() { return { results: resolve(sql) as T[], success: true as const }; },
      async first<T = unknown>() {
        const base = row.read(sql);
        if (base) return base as T;
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) return { id: 1 } as T;
        return ((resolve(sql) as T[])[0] ?? null) as T | null;
      },
    };
    return stmt;
  }

  const DB = {
    prepare,
    async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
      for (const s of statements) writes.push({ sql: s.sql, binds: s.boundArgs });
      // D1 documents a batch as one transaction: any statement failing rolls
      // the whole thing back, so nothing in it reaches `applied`.
      if (statements.some((s) => violates({ sql: s.sql, binds: s.boundArgs }))) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: project_pages.project_id, project_pages.slug");
      }
      for (const s of statements) applied.push({ sql: s.sql, binds: s.boundArgs });
      return statements.map(() => ({ success: true }));
    },
  };

  return {
    DB,
    appliedMatching: (re: RegExp) => applied.filter((w) => re.test(w.sql)),
    attemptedMatching: (re: RegExp) => writes.filter((w) => re.test(w.sql)),
  };
}

function makeDo(seed: Seed) {
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
  return { doInstance, db, ydoc: (doInstance as unknown as { ydoc: Y.Doc }).ydoc };
}

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

function makePage(fields: { _id: number | null; slug: string; title?: string }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("slug", fields.slug);
  m.set("created_by", 1);
  m.set("title", new Y.Text(fields.title ?? ""));
  m.set("body", new Y.Text(""));
  return m;
}

function makeStory(fields: { _id: number; story_id: string; title: string }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("story_id", fields.story_id);
  m.set("created_by", 1);
  m.set("title", new Y.Text(fields.title));
  m.set("subtitle", new Y.Text(""));
  m.set("byline", new Y.Text(""));
  m.set("steps", new Y.Array<Y.Map<unknown>>());
  return m;
}

/**
 * Two collaborators have renamed their pages onto one slug, and something
 * outside the DO holds `about-2` — the suffix the re-key mints — by the time
 * the batch runs. No live path produces this any more; the fixture stands for
 * the shape.
 */
function collidingProject() {
  const { doInstance, db, ydoc } = makeDo({
    stories: [{ id: 11, story_id: "s1" }],
    pages: [
      { id: 42, slug: "about" },
      { id: 43, slug: "notes" },
    ],
    slugsTakenAfterRead: ["about-2"],
  });
  ydoc.transact(() => {
    const c = ydoc.getMap<unknown>("config");
    c.set("title", new Y.Text("Demo"));
    c.set("lang", "en");
    ydoc.getArray<Y.Map<unknown>>("stories").push([
      makeStory({ _id: 11, story_id: "s1", title: "Unrelated story" }),
    ]);
    ydoc.getArray<Y.Map<unknown>>("pages").push([
      makePage({ _id: 42, slug: "about", title: "Mine" }),
      makePage({ _id: 43, slug: "about", title: "Theirs" }),
    ]);
  }, null);
  return { doInstance, db, ydoc };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => { vi.useRealTimers(); });

describe("R2-5 — a minted slug taken between the seed read and the batch", () => {
  it("aborts the whole batch, taking every unrelated entity's write with it", async () => {
    const { doInstance, db, ydoc } = collidingProject();

    await expect(snapshot(doInstance)).rejects.toThrow(/UNIQUE constraint failed/);

    // The re-key was minted from the stale seed and collided.
    expect(ydoc.getArray<Y.Map<unknown>>("pages").toArray().map((m) => m.get("slug")))
      .toEqual(["about", "about-2"]);
    expect(db.attemptedMatching(/^UPDATE project_pages/).some((w) => w.binds.includes("about-2")))
      .toBe(true);

    // Nothing in the batch landed — including the story nobody touched.
    expect(db.appliedMatching(/^UPDATE stories/)).toEqual([]);
    expect(db.appliedMatching(/^UPDATE project_pages/)).toEqual([]);

    // The blob write precedes the batch and is standalone, so the re-keyed
    // document itself is durable: the collision costs the snapshot, not the work.
    expect(db.appliedMatching(/^UPDATE projects SET yjs_state/)).toHaveLength(1);
  });

  it("keeps failing on retry — dedupe settles doc-vs-doc, not doc-vs-D1", async () => {
    const { doInstance, db } = collidingProject();

    await expect(snapshot(doInstance)).rejects.toThrow(/UNIQUE constraint failed/);
    // On the second pass the document holds two distinct slugs, so dedupe has
    // nothing to settle and mints no fresh key — the same UPDATE is re-issued.
    await expect(snapshot(doInstance)).rejects.toThrow(/UNIQUE constraint failed/);

    expect(db.appliedMatching(/^UPDATE project_pages/)).toEqual([]);
    expect(db.appliedMatching(/^UPDATE stories/)).toEqual([]);
  });

  it("snapshots cleanly when nothing outside the DO has taken the minted slug", async () => {
    // The same collision, without the concurrent writer: the re-key applies and
    // every other statement lands with it.
    const { doInstance, db, ydoc } = makeDo({
      stories: [{ id: 11, story_id: "s1" }],
      pages: [{ id: 42, slug: "about" }, { id: 43, slug: "notes" }],
    });
    ydoc.transact(() => {
      const c = ydoc.getMap<unknown>("config");
      c.set("title", new Y.Text("Demo"));
      c.set("lang", "en");
      ydoc.getArray<Y.Map<unknown>>("stories").push([
        makeStory({ _id: 11, story_id: "s1", title: "Unrelated story" }),
      ]);
      ydoc.getArray<Y.Map<unknown>>("pages").push([
        makePage({ _id: 42, slug: "about", title: "Mine" }),
        makePage({ _id: 43, slug: "about", title: "Theirs" }),
      ]);
    }, null);

    await snapshot(doInstance);

    expect(ydoc.getArray<Y.Map<unknown>>("pages").toArray().map((m) => m.get("slug")))
      .toEqual(["about", "about-2"]);
    expect(db.appliedMatching(/^UPDATE project_pages/)).toHaveLength(2);
    expect(db.appliedMatching(/^UPDATE stories/)).toHaveLength(1);
  });
});
