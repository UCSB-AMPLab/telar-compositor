/**
 * Pins the snapshot-blob atomicity contract in `doSnapshot`
 * (workers/collaboration.ts).
 *
 * New entities (stories/steps/objects/glossary/pages with _id === null) are
 * INSERTed via standalone `.run()` calls that commit IMMEDIATELY and backfill
 * the real D1 id onto the in-memory Y.Map. All UPDATE/DELETE/contribution rows
 * are collected and run together via `DB.batch(statements)` at the end.
 *
 * The `projects.yjs_state` blob write MUST be a standalone `.run()` executed
 * BEFORE that batch — never inside it. Otherwise a batch failure (transient D1
 * error, or a deterministic UNIQUE collision in some UPDATE) leaves the INSERTs
 * committed but the blob unwritten: a later cold-start restore loads the STALE
 * blob (missing the inserted entities) and the next snapshot orphan-DELETEs the
 * just-created rows — silent permanent loss.
 *
 * This test seeds a new story (_id === null), forces `DB.batch` to REJECT, and
 * asserts the blob UPDATE was still persisted via a standalone `.run()`
 * independent of the failing batch.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
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

interface RunCall {
  sql: string;
}

/**
 * A minimal D1 mock. Records the SQL of every prepared statement on which
 * `.run()` is called (these are the standalone, immediately-committed writes:
 * entity INSERTs and — post-fix — the blob UPDATE). Statements that are only
 * `.bind()`-ed and pushed onto the batch are NOT recorded here. SELECTs resolve
 * empty so the orphan-reconciler finds nothing. `.batch()` always REJECTS.
 */
function makeRejectingDb() {
  const runCalls: RunCall[] = [];
  let lastRowId = 100;
  let batchCalls = 0;

  function prepare(sql: string) {
    const stmt = {
      sql,
      bind(..._args: unknown[]) {
        return stmt;
      },
      async run() {
        runCalls.push({ sql });
        lastRowId += 1;
        return { meta: { last_row_id: lastRowId }, success: true };
      },
      async all<T = unknown>() {
        return { results: [] as T[], success: true };
      },
      async first<T = unknown>() {
        return null as T | null;
      },
    };
    return stmt;
  }

  const DB = {
    prepare,
    async batch(_statements: unknown[]) {
      batchCalls += 1;
      throw new Error("simulated transient D1 batch failure");
    },
  };

  return {
    DB,
    runCalls,
    blobRunCalls: () => runCalls.filter((c) => /UPDATE projects SET yjs_state/.test(c.sql)),
    batchCallCount: () => batchCalls,
  };
}

/** ctx stub with no sockets so the constructor skips hibernation recovery. */
function makeCtx() {
  const alarms: Array<number> = [];
  return {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => (alarms.length ? alarms[alarms.length - 1] : null),
      setAlarm: async (t: number) => {
        alarms.push(t);
      },
    },
    acceptWebSocket: vi.fn(),
  };
}

/**
 * Build a DO instance ready to snapshot: projectId set, doc marked loaded, and
 * one new story (_id === null) seeded into the live Y.Doc so the INSERT path
 * runs and commits before the batch. userFieldSets/newSessions stay empty so
 * the contribution/activity block is skipped (keeps the DB surface minimal).
 */
function makeDoReadyToSnapshot() {
  const db = makeRejectingDb();
  const env = {
    DB: db.DB as unknown,
    SESSION_SECRET: "test",
    COLLABORATION: {} as unknown,
  };
  const ctx = makeCtx();
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  (doInstance as unknown as { docLoaded: boolean }).docLoaded = true;

  // Seed a brand-new story (no D1 id yet) into the DO's live Y.Doc.
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  const stories = ydoc.getArray<Y.Map<unknown>>("stories");
  ydoc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("_id", null);
    story.set("story_id", "draft-new");
    story.set("title", new Y.Text("New story"));
    story.set("subtitle", new Y.Text(""));
    story.set("byline", new Y.Text(""));
    story.set("private", false);
    story.set("draft", true);
    story.set("show_sections", false);
    story.set("steps", new Y.Array<Y.Map<unknown>>());
    stories.push([story]);
  });

  return { doInstance, db, ydoc };
}

describe("doSnapshot — blob is persisted before (independent of) the UPDATE/DELETE batch", () => {
  it("writes the yjs_state blob via a standalone .run() even when DB.batch rejects", async () => {
    const { doInstance, db } = makeDoReadyToSnapshot();

    // The batch rejects, so snapshotToD1 must rethrow — but the blob must
    // already be durable by then.
    await expect(
      (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1(),
    ).rejects.toThrow(/batch failure/);

    // The batch was attempted (so we are exercising the failure path)...
    expect(db.batchCallCount()).toBe(1);

    // ...and the blob UPDATE was written exactly once, standalone, NOT swept
    // away by the failing batch. Pre-fix this is 0: the blob lives inside
    // `statements`, never reaching a standalone .run().
    expect(db.blobRunCalls()).toHaveLength(1);
  });

  it("the new story was INSERTed (committed) before the failing batch — the loss scenario", async () => {
    const { doInstance, db } = makeDoReadyToSnapshot();

    await expect(
      (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1(),
    ).rejects.toThrow();

    // The story INSERT committed via standalone .run() (this is the
    // already-durable write the blob must reflect).
    const storyInserts = db.runCalls.filter((c) => /INSERT INTO stories/.test(c.sql));
    expect(storyInserts).toHaveLength(1);

    // And the blob standalone-run happened in the same snapshot, so the
    // persisted blob includes the backfilled story _id.
    expect(db.blobRunCalls()).toHaveLength(1);
  });
});
