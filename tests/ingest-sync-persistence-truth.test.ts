/**
 * `/ingest-sync` and `/restore-orphans` answer the caller with what they
 * applied. Two things stand between that answer and D1, and neither was
 * checked:
 *
 *   - `snapshotToD1()` returns SILENTLY when persistence is halted (a refused
 *     deletion sits in the document) or the lock is held. Both routes read
 *     that return as persistence, so a page import into a halted project
 *     reports success and broadcasts a page that is not in D1 — which the
 *     reset required to clear the halt then discards. `/snapshot` and
 *     `/clear-course-markers` already answer 503 on the same silence;
 *     `flushSnapshotNow` exists to turn it into a boolean.
 *
 *   - A failed entity INSERT is swallowed by `insertRow` as `{id: 0}` — right,
 *     because a snapshot must not abort mid-flush — so `applied.pageInsert: 1`
 *     can come back with no `project_pages` row behind it. The count is a
 *     claim about D1 and must be established from D1's own answer: the `_id`
 *     backfill the successful INSERT writes onto the Y.Map.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
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
import { plantHalt } from "./helpers/halted-document";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const TEST_SECRET = "test-session-secret";

interface Op {
  kind: "select" | "run" | "batch";
  sql: string;
  binds: unknown[];
}

interface DbSeed {
  /** Rows `project_pages` already holds, enforced as UNIQUE(project_id, slug). */
  pages?: Array<{ id: number; slug: string }>;
}

/**
 * A D1 fake that ENFORCES `UNIQUE(project_id, slug)` at execution time, so a
 * colliding INSERT fails here exactly where it fails in production. Adapted
 * from tests/pages-import-through-do.test.ts.
 */
function makeDb(seed: DbSeed) {
  const ops: Op[] = [];
  const pageRows = new Map<number, string>();
  for (const p of seed.pages ?? []) pageRows.set(p.id, p.slug);
  let nextId = 5000;

  const slugOwner = (slug: string): number | undefined => {
    for (const [id, s] of pageRows) if (s === slug) return id;
    return undefined;
  };

  function resolve(sql: string): unknown[] {
    if (/FROM project_pages WHERE project_id/.test(sql)) {
      return [...pageRows].map(([id, slug]) => ({
        id,
        slug,
        title: "",
        body: "",
        order: 0,
        order_key: null,
        created_by: null,
      }));
    }
    return [];
  }

  function apply(sql: string, binds: unknown[]): number | null {
    const insertPage = /^INSERT INTO project_pages \(([^)]*)\)/.exec(sql);
    if (insertPage) {
      const cols = insertPage[1].split(",").map((c) => c.trim().replace(/"/g, ""));
      const slug = String(binds[cols.indexOf("slug")] ?? "");
      if (slugOwner(slug) !== undefined) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: project_pages.project_id, project_pages.slug",
        );
      }
      const idCol = cols.indexOf("id");
      const id = idCol >= 0 ? Number(binds[idCol]) : (nextId += 1);
      pageRows.set(id, slug);
      return id;
    }
    // The page UPDATE writes the slug second; one that leaves the slug alone
    // (an adopted page's creator) changes nothing this model holds.
    if (/^UPDATE project_pages SET/.test(sql) && /\bslug =/.test(sql)) {
      const slug = String(binds[1] ?? "");
      const targetId = Number(binds[binds.length - 1]);
      const owner = slugOwner(slug);
      if (owner !== undefined && owner !== targetId) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: project_pages.project_id, project_pages.slug",
        );
      }
      if (pageRows.has(targetId)) pageRows.set(targetId, slug);
      return null;
    }
    if (/^DELETE FROM project_pages/.test(sql)) {
      pageRows.delete(Number(binds[0]));
      return null;
    }
    return null;
  }

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() {
        return bound;
      },
      bind(...args: unknown[]) {
        checkD1Bind(sql, args);
        bound = args;
        return stmt;
      },
      async run() {
        ops.push({ kind: "run", sql, binds: bound });
        const id = apply(sql, bound);
        return { meta: { last_row_id: id ?? (nextId += 1), changes: 1 }, success: true as const };
      },
      async all<T = unknown>() {
        ops.push({ kind: "select", sql, binds: bound });
        return { results: resolve(sql) as T[], success: true as const };
      },
      async first<T = unknown>() {
        ops.push({ kind: "select", sql, binds: bound });
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) {
          return { id: 1 } as T;
        }
        // The base row: no blob and no tags, which is the cold build.
        if (/^SELECT yjs_state/.test(sql)) {
          return { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 } as T;
        }
        return ((resolve(sql) as T[])[0] ?? null) as T | null;
      },
    };
    return stmt;
  }

  return {
    ops,
    DB: {
      prepare,
      async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
        ops.push({ kind: "batch", sql: "BATCH", binds: [] });
        const restore = new Map(pageRows);
        try {
          for (const s of statements) apply(s.sql, s.boundArgs);
        } catch (err) {
          pageRows.clear();
          for (const [k, v] of restore) pageRows.set(k, v);
          throw err;
        }
        for (const s of statements) ops.push({ kind: "run", sql: s.sql, binds: s.boundArgs });
        return statements.map(() => ({ success: true }));
      },
    },
    liveSlugs: () => [...pageRows.values()].sort(),
    pageRowIds: () => [...pageRows.keys()].sort((a, b) => a - b),
  };
}

function makeCtx() {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const running = chain.then(() => fn());
      chain = running.catch(() => {});
      return running;
    },
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
}

type Internals = {
  projectId: number | null;
  docLoaded: boolean;
  persistenceHalted: unknown;
  ydoc: Y.Doc;
};

function makeDo(seed: DbSeed = {}) {
  const db = makeDb(seed);
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: db.DB, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} } as unknown as Env,
  );
  const internals = doInstance as unknown as Internals;
  internals.projectId = PROJECT_ID;
  markLoaded(internals);
  return { doInstance, db, internals };
}

async function post(
  doInstance: ProjectCollaborationDO,
  route: "ingest-sync" | "restore-orphans",
  body: unknown,
): Promise<Response> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, TEST_SECRET, route);
  return doInstance.fetch(
    new Request(`https://internal/${route}`, {
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
}

const ONE_PAGE = {
  pages: { insert: [{ slug: "about", title: "About", body: "About body.", created_by: 7 }] },
};

// ---------------------------------------------------------------------------
// R5-2 — a silent snapshot is not persistence
// ---------------------------------------------------------------------------

describe("/ingest-sync refuses rather than reporting a snapshot that did not run", () => {
  it("answers 503 on a halted project instead of 200 with a page D1 never got", async () => {
    const { doInstance, db, internals } = makeDo();
    plantHalt(internals);

    const res = await post(doInstance, "ingest-sync", ONE_PAGE);

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("persistence_halted");
    expect(db.liveSlugs()).toEqual([]);
  });

  it("still reports accurately on a healthy project", async () => {
    const { doInstance, db } = makeDo();

    const res = await post(doInstance, "ingest-sync", ONE_PAGE);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: { pageInsert: number } };
    expect(body.applied.pageInsert).toBe(1);
    expect(db.liveSlugs()).toEqual(["about"]);
  });
});

describe("/restore-orphans shares the omission", () => {
  it("answers 503 on a halted project instead of reporting the restore persisted", async () => {
    const { doInstance, internals } = makeDo();
    plantHalt(internals);

    const res = await post(doInstance, "restore-orphans", {
      stories: [{ storyId: "lost-story", steps: [], layers: [] }],
    });

    expect(res.status).toBe(503);
  });

  it("still reports accurately on a healthy project", async () => {
    const { doInstance } = makeDo();

    const res = await post(doInstance, "restore-orphans", {
      stories: [{ storyId: "lost-story", steps: [], layers: [] }],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: 1 });
  });
});

// ---------------------------------------------------------------------------
// R5-3 — a swallowed INSERT is not an applied insert
// ---------------------------------------------------------------------------

describe("a page INSERT the snapshot could not land is not reported as applied", () => {
  it("does not count a slug whose INSERT lost to the UNIQUE index", async () => {
    // D1 holds `about` on a row the snapshot keeps though the document does
    // not claim it: an entry it cannot read suspends the orphan sweep. The
    // document decides presence, so the ingest inserts, and the snapshot's
    // INSERT is refused and swallowed.
    const { doInstance, db, internals } = makeDo({ pages: [{ id: 900, slug: "about" }] });
    internals.ydoc.getArray<unknown>("pages").push(["not a page"]);

    const res = await post(doInstance, "ingest-sync", ONE_PAGE);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: { pageInsert: number };
      failed?: { pageInsert?: string[] };
    };
    expect(body.applied.pageInsert).toBe(0);
    expect(body.failed?.pageInsert).toEqual(["about"]);
    // The live row is untouched — a refused INSERT must never become a DELETE.
    expect(db.liveSlugs()).toEqual(["about"]);
  });

  it("counts one applied and one failed when only part of the batch lands", async () => {
    const { doInstance, db, internals } = makeDo({ pages: [{ id: 900, slug: "about" }] });
    internals.ydoc.getArray<unknown>("pages").push(["not a page"]);

    const res = await post(doInstance, "ingest-sync", {
      pages: {
        insert: [
          { slug: "about", title: "About", body: "A", created_by: 7 },
          { slug: "team", title: "Team", body: "T", created_by: 7 },
        ],
      },
    });

    const body = (await res.json()) as {
      applied: { pageInsert: number };
      failed?: { pageInsert?: string[] };
    };
    expect(body.applied.pageInsert).toBe(1);
    expect(body.failed?.pageInsert).toEqual(["about"]);
    expect(db.liveSlugs()).toEqual(["about", "team"]);
  });

  it("gives a page whose row an evicted instance left unclaimed that row back, and counts it applied", async () => {
    // D1 holds `about` but the document does not — an instance evicted between
    // a committed INSERT and the blob write comes back exactly like this. The
    // page the ingest inserts takes the row over rather than replacing it.
    const { doInstance, db } = makeDo({ pages: [{ id: 900, slug: "about" }] });

    const res = await post(doInstance, "ingest-sync", ONE_PAGE);

    const body = (await res.json()) as {
      applied: { pageInsert: number };
      failed?: { pageInsert?: string[] };
    };
    expect(body.applied.pageInsert).toBe(1);
    expect(body.failed?.pageInsert ?? []).toEqual([]);
    expect(db.liveSlugs()).toEqual(["about"]);
    expect(db.pageRowIds()).toEqual([900]);
  });

  it("reports no failures when every INSERT lands", async () => {
    const { doInstance } = makeDo();

    const res = await post(doInstance, "ingest-sync", ONE_PAGE);

    const body = (await res.json()) as { failed?: { pageInsert?: string[] } };
    expect(body.failed?.pageInsert ?? []).toEqual([]);
  });

  it("leaves an already-present slug in `skipped`, not in `failed`", async () => {
    // A slug the DOCUMENT already holds is skipped before any INSERT is
    // attempted. That is "already present", which the caller reports as such —
    // a different answer from "we tried and D1 refused".
    const { doInstance, internals } = makeDo();
    const m = new Y.Map<unknown>();
    m.set("_id", 900);
    m.set("slug", "about");
    m.set("title", new Y.Text("About"));
    m.set("body", new Y.Text(""));
    m.set("created_by", null);
    internals.ydoc.getArray<Y.Map<unknown>>("pages").push([m]);

    const res = await post(doInstance, "ingest-sync", ONE_PAGE);

    const body = (await res.json()) as {
      applied: { pageInsert: number };
      skipped: { pageInsert: string[] };
      failed?: { pageInsert?: string[] };
    };
    expect(body.applied.pageInsert).toBe(0);
    expect(body.skipped.pageInsert).toEqual(["about"]);
    expect(body.failed?.pageInsert ?? []).toEqual([]);
  });
});
