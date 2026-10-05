/**
 * story-order-roundtrip.test.ts — the ordering field's journey through D1.
 *
 * Two things have to hold for a converted document to keep its order across a
 * cold Durable Object. Migration 0043 has to carry the order every existing
 * project already had into the new column, in the sequence its readers were
 * already showing. And a reorder made in the document has to reach D1 through
 * the snapshot and come back through the cold build unchanged — including the
 * story dropped between two others, which is the case an integer column cannot
 * hold.
 *
 * Both run against the repository's own migration chain replayed into an
 * in-memory SQLite (tests/helpers/d1-memory.ts), so the SQL under test is the
 * SQL that will run against production D1.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { isValidOrderKey } from "~/lib/order-key";
import { ORDER_KEY, orderedStoryMaps, reorderByOrderKey } from "~/lib/story-order";

const TEST_PROJECT_ID = 1;

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "app",
  "db",
  "migrations",
);

// ---------------------------------------------------------------------------
// Migration 0043 — the backfill, run on a database that predates it
// ---------------------------------------------------------------------------

describe("migration 0043 carries the existing order across", () => {
  function dbBefore0043(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      if (file.startsWith("0043_")) continue;
      db.exec(readFileSync(join(migrationsDir, file), "utf-8"));
    }
    return db;
  }

  function apply0043(db: DatabaseSync): void {
    db.exec(readFileSync(join(migrationsDir, "0043_story_order_key.sql"), "utf-8"));
  }

  function seed(db: DatabaseSync, rows: Array<[number, string, number]>): void {
    db.exec("INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')");
    db.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1), (2, 1, 'o/b', 1)");
    for (const [projectId, slug, order] of rows) {
      db.prepare('INSERT INTO stories (project_id, story_id, "order") VALUES (?, ?, ?)')
        .run(projectId, slug, order);
    }
  }

  function keysFor(db: DatabaseSync, projectId: number) {
    return db
      .prepare('SELECT story_id, "order", order_key FROM stories WHERE project_id = ? ORDER BY order_key ASC')
      .all(projectId) as Array<{ story_id: string; order: number; order_key: string }>;
  }

  it("ranks each project's stories by its existing order, independently", () => {
    const db = dbBefore0043();
    seed(db, [
      [1, "third", 2],
      [1, "first", 0],
      [1, "second", 1],
      [2, "other-a", 7],
      [2, "other-b", 9],
    ]);
    apply0043(db);

    expect(keysFor(db, 1).map((r) => r.story_id)).toEqual(["first", "second", "third"]);
    expect(keysFor(db, 2).map((r) => r.story_id)).toEqual(["other-a", "other-b"]);
    // Each project starts its own key sequence.
    expect(keysFor(db, 1)[0].order_key).toBe(keysFor(db, 2)[0].order_key);
    db.close();
  });

  it("mints canonical keys the generator would accept as neighbours", () => {
    const db = dbBefore0043();
    seed(db, [[1, "a", 0], [1, "b", 1], [1, "c", 2]]);
    apply0043(db);
    for (const row of keysFor(db, 1)) {
      expect(isValidOrderKey(row.order_key)).toBe(true);
    }
    db.close();
  });

  it("breaks a tie on id when `order` is duplicated or all zero", () => {
    const db = dbBefore0043();
    seed(db, [[1, "alpha", 0], [1, "beta", 0], [1, "gamma", 0]]);
    apply0043(db);
    // Insertion order is id order, which is what a zeroed `order` column left
    // every pre-migration reader looking at.
    expect(keysFor(db, 1).map((r) => r.story_id)).toEqual(["alpha", "beta", "gamma"]);
    const keys = keysFor(db, 1).map((r) => r.order_key);
    expect(new Set(keys).size).toBe(3);
    db.close();
  });

  it("leaves a project with no stories untouched", () => {
    const db = dbBefore0043();
    seed(db, []);
    apply0043(db);
    expect(keysFor(db, 1)).toEqual([]);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Document -> snapshot -> D1 -> cold build
// ---------------------------------------------------------------------------

function makeCtx() {
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => { /* no-op */ },
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

function makeDo(memory: MemoryD1) {
  const env = { DB: asD1(memory), SESSION_SECRET: "test", COLLABORATION: {} as unknown };
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    env as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  return doInstance;
}

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

function load(doInstance: unknown): Promise<void> {
  return (doInstance as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
}

function docOf(doInstance: unknown): Y.Doc {
  return (doInstance as { ydoc: Y.Doc }).ydoc;
}

function slugsInDoc(ydoc: Y.Doc): string[] {
  return orderedStoryMaps(ydoc.getArray<Y.Map<unknown>>("stories")).map(
    (m) => m.get("story_id") as string,
  );
}

function seedProject(memory: MemoryD1, slugs: string[]): void {
  memory.raw.exec("INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')");
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'o/a', 1)");
  memory.raw.exec("INSERT INTO project_config (project_id) VALUES (1)");
  slugs.forEach((slug, i) => {
    memory.raw
      .prepare('INSERT INTO stories (project_id, story_id, title, "order", order_key) VALUES (?, ?, ?, ?, ?)')
      .run(1, slug, slug, i, `a0000${i + 1}1`);
  });
}

describe("a reorder survives the snapshot and the cold rebuild", () => {
  let memory: MemoryD1;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    memory = createMemoryD1();
  });

  afterEach(() => {
    vi.useRealTimers();
    memory.close();
  });

  it("writes the field, ranks `order` from it, and rebuilds the same list", async () => {
    seedProject(memory, ["a", "b", "c", "d"]);

    const first = makeDo(memory);
    await load(first);
    expect(slugsInDoc(docOf(first))).toEqual(["a", "b", "c", "d"]);

    // Drop "d" between "b" and "c" — the move an integer column cannot hold.
    const ydoc = docOf(first);
    ydoc.transact(() => {
      reorderByOrderKey(ydoc.getArray<Y.Map<unknown>>("stories"), 3, 2);
    }, null);
    expect(slugsInDoc(ydoc)).toEqual(["a", "b", "d", "c"]);

    await snapshot(first);

    // D1 now carries the new order in both columns: the field is authoritative,
    // `order` is its dense rank, which is what project.csv publishes.
    const rows = memory.raw
      .prepare('SELECT story_id, "order", order_key FROM stories WHERE project_id = 1 ORDER BY order_key ASC')
      .all() as Array<{ story_id: string; order: number; order_key: string }>;
    expect(rows.map((r) => r.story_id)).toEqual(["a", "b", "d", "c"]);
    expect(rows.map((r) => r.order)).toEqual([0, 1, 2, 3]);
    for (const row of rows) expect(isValidOrderKey(row.order_key)).toBe(true);

    // A second DO, cold: no blob, straight from the rows.
    // The row is enrolled, so clearing the base is a hand repair: it moves the
    // revision as well, which is what the fence trigger requires of any write
    // that touches the blob or the tags.
    memory.raw.exec(
      "UPDATE projects SET yjs_state = NULL, yjs_generation = NULL, yjs_seq = NULL, " +
        "yjs_write = yjs_write + 1 WHERE id = 1",
    );
    const second = makeDo(memory);
    await load(second);
    expect(slugsInDoc(docOf(second))).toEqual(["a", "b", "d", "c"]);
  });

  it("keeps a story between its neighbours across two rounds of snapshot and rebuild", async () => {
    seedProject(memory, ["a", "b", "c", "d"]);

    const first = makeDo(memory);
    await load(first);
    const doc1 = docOf(first);
    doc1.transact(() => reorderByOrderKey(doc1.getArray("stories"), 3, 1), null);
    expect(slugsInDoc(doc1)).toEqual(["a", "d", "b", "c"]);
    await snapshot(first);

    // The row is enrolled, so clearing the base is a hand repair: it moves the
    // revision as well, which is what the fence trigger requires of any write
    // that touches the blob or the tags.
    memory.raw.exec(
      "UPDATE projects SET yjs_state = NULL, yjs_generation = NULL, yjs_seq = NULL, " +
        "yjs_write = yjs_write + 1 WHERE id = 1",
    );
    const second = makeDo(memory);
    await load(second);
    const doc2 = docOf(second);
    expect(slugsInDoc(doc2)).toEqual(["a", "d", "b", "c"]);
    doc2.transact(() => reorderByOrderKey(doc2.getArray("stories"), 0, 3), null);
    expect(slugsInDoc(doc2)).toEqual(["d", "b", "c", "a"]);
    await snapshot(second);

    // The row is enrolled, so clearing the base is a hand repair: it moves the
    // revision as well, which is what the fence trigger requires of any write
    // that touches the blob or the tags.
    memory.raw.exec(
      "UPDATE projects SET yjs_state = NULL, yjs_generation = NULL, yjs_seq = NULL, " +
        "yjs_write = yjs_write + 1 WHERE id = 1",
    );
    const third = makeDo(memory);
    await load(third);
    expect(slugsInDoc(docOf(third))).toEqual(["d", "b", "c", "a"]);
  });

  it("self-heals a warm document whose blob predates the field", async () => {
    seedProject(memory, ["a", "b", "c"]);

    // A blob written before stories carried their own place: the Y.Maps hold
    // the old integer `order` and no key at all, and the list order lives in
    // the array position.
    const legacy = new Y.Doc();
    const stories = legacy.getArray<Y.Map<unknown>>("stories");
    const idBySlug: Record<string, number> = { a: 1, b: 2, c: 3 };
    legacy.transact(() => {
      // The array order — the only order such a blob carries — is c, a, b,
      // which is NOT the order the seeded `order` column implies.
      ["c", "a", "b"].forEach((slug) => {
        const m = new Y.Map<unknown>();
        m.set("_id", idBySlug[slug]);
        m.set("story_id", slug);
        m.set("title", new Y.Text(slug));
        m.set("subtitle", new Y.Text(""));
        m.set("byline", new Y.Text(""));
        m.set("order", 0); // all-zero, as documents in the wild have it
        m.set("private", false);
        m.set("draft", false);
        m.set("show_sections", false);
        m.set("steps", new Y.Array<Y.Map<unknown>>());
        stories.push([m]);
      });
    }, null);
    memory.raw
      .prepare("UPDATE projects SET yjs_state = ? WHERE id = 1")
      .run(Y.encodeStateAsUpdate(legacy));

    const doInstance = makeDo(memory);
    await load(doInstance);

    // The visual order the blob presented — array order — is what survives.
    const ydoc = docOf(doInstance);
    expect(slugsInDoc(ydoc)).toEqual(["c", "a", "b"]);
    for (const m of orderedStoryMaps(ydoc.getArray("stories"))) {
      expect(isValidOrderKey(m.get(ORDER_KEY))).toBe(true);
    }

    // And it reaches D1 on the next snapshot rather than staying doc-only.
    await snapshot(doInstance);
    const rows = memory.raw
      .prepare('SELECT story_id, "order" FROM stories WHERE project_id = 1 ORDER BY "order" ASC')
      .all() as Array<{ story_id: string; order: number }>;
    expect(rows.map((r) => r.story_id)).toEqual(["c", "a", "b"]);
    expect(rows.map((r) => r.order)).toEqual([0, 1, 2]);
  });
});
