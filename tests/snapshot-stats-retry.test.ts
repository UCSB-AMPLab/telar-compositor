/**
 * Pins the E2 fix: activity-emitted keys and newSessions must NOT be mutated
 * until AFTER the DB.batch(statements) call succeeds. If the batch throws, the
 * in-memory guards must remain un-mutated so the next snapshot retries the
 * inserts.
 *
 * Pre-fix behaviour (the bug):
 *   - `emitted.add(entityKey)` fires INSIDE the activity loop — before the batch.
 *   - `this.newSessions.clear()` fires BEFORE the batch.
 *   → batch throws → entityKey is already marked emitted forever; newSessions
 *     cleared → the activity_log INSERT and session-count UPDATE are permanently
 *     lost for this DO's lifetime.
 *
 * Post-fix behaviour (the contract):
 *   - Deferred mutations are applied only AFTER the batch try/catch completes
 *     without rethrowing.
 *   - On a failed batch the guards remain un-mutated → the next snapshot will
 *     retry the inserts.
 *
 * @version v1.3.0-beta
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

const TEST_PROJECT_ID = 42;
const TEST_USER_ID = 7;

// ---------------------------------------------------------------------------
// DB mocks
// ---------------------------------------------------------------------------

/**
 * A D1 mock whose batch() always rejects.
 * Standalone .run() calls (INSERTs, blob UPDATE) succeed as normal.
 */
function makeRejectingBatchDb() {
  let lastRowId = 200;
  let batchCalls = 0;

  function prepare(sql: string) {
    const stmt = {
      sql,
      bind(..._args: unknown[]) {
        return stmt;
      },
      async run() {
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
    getBatchCalls: () => batchCalls,
  };

  return DB;
}

/**
 * A D1 mock whose batch() always succeeds.
 */
function makeSucceedingDb() {
  let lastRowId = 300;

  function prepare(sql: string) {
    const stmt = {
      sql,
      bind(..._args: unknown[]) {
        return stmt;
      },
      async run() {
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

  return {
    prepare,
    async batch(_statements: unknown[]) {
      // success — no-op
    },
  };
}

// ---------------------------------------------------------------------------
// ctx stub
// ---------------------------------------------------------------------------

function makeCtx() {
  const alarms: Array<number> = [];
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

// ---------------------------------------------------------------------------
// DO factory
// ---------------------------------------------------------------------------

/**
 * Build a DO ready to snapshot with:
 *   - One existing story (D1 id = 999) so the UPDATE path (not INSERT) runs.
 *   - One active user (TEST_USER_ID) with one field edit on that story.
 *   - That user in newSessions so the session-count UPDATE is also queued.
 *
 * This ensures:
 *   (a) a non-empty activity row is derived (so the emitted-add path fires), and
 *   (b) newSessions is non-empty (so its clear() would be observable).
 */
function makeDoWithActivityAndSession(db: ReturnType<typeof makeRejectingBatchDb> | ReturnType<typeof makeSucceedingDb>) {
  const env = {
    DB: db as unknown,
    SESSION_SECRET: "test",
    COLLABORATION: {} as unknown,
  };
  const ctx = makeCtx();
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );

  // Set required DO state
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  (doInstance as unknown as { docLoaded: boolean }).docLoaded = true;

  // Seed a story with a real D1 id (999) into the Y.Doc — no INSERT path needed
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  const stories = ydoc.getArray<Y.Map<unknown>>("stories");
  ydoc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("_id", 999);
    story.set("story_id", "story-abc");
    story.set("title", new Y.Text("Existing story"));
    story.set("subtitle", new Y.Text(""));
    story.set("byline", new Y.Text(""));
    story.set("private", false);
    story.set("draft", false);
    story.set("show_sections", false);
    story.set("steps", new Y.Array<Y.Map<unknown>>());
    stories.push([story]);
  });

  // Simulate that the user edited a field on this story
  const userFieldSets = (doInstance as unknown as { userFieldSets: Map<number, Set<string>> }).userFieldSets;
  userFieldSets.set(TEST_USER_ID, new Set(["stories:999:title"]));

  // Simulate a new session for that user
  const newSessions = (doInstance as unknown as { newSessions: Set<number> }).newSessions;
  newSessions.add(TEST_USER_ID);

  return doInstance;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("doSnapshot — activity emitted / newSessions committed only after batch success", () => {

  it("when batch FAILS: activityEmitted is NOT updated for the entity key", async () => {
    const db = makeRejectingBatchDb();
    const doInstance = makeDoWithActivityAndSession(db);

    const activityEmitted = (doInstance as unknown as {
      activityEmitted: Map<number, Set<string>>;
    }).activityEmitted;

    // Snapshot will throw because batch rejects
    await expect(
      (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1(),
    ).rejects.toThrow(/batch failure/);

    // The entity key must NOT be in activityEmitted — so the next snapshot retries
    const userEmitted = activityEmitted.get(TEST_USER_ID);
    const entityKeyPresent = userEmitted?.has("story:999") ?? false;
    // Also check any variant that buildActivityRows might produce
    // (the helper maps "stories" collection → entity_type "story")
    const anyKeyPresent = userEmitted ? userEmitted.size > 0 : false;
    expect(anyKeyPresent).toBe(false);
  });

  it("when batch FAILS: newSessions is NOT cleared", async () => {
    const db = makeRejectingBatchDb();
    const doInstance = makeDoWithActivityAndSession(db);

    const newSessions = (doInstance as unknown as { newSessions: Set<number> }).newSessions;

    // Confirm the user is in newSessions before the snapshot
    expect(newSessions.has(TEST_USER_ID)).toBe(true);

    // Snapshot throws
    await expect(
      (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1(),
    ).rejects.toThrow(/batch failure/);

    // newSessions must still contain the user — the failed batch didn't clear it
    expect(newSessions.has(TEST_USER_ID)).toBe(true);
  });

  it("when batch SUCCEEDS: activityEmitted is updated so the entity is not re-emitted", async () => {
    const db = makeSucceedingDb();
    const doInstance = makeDoWithActivityAndSession(db);

    const activityEmitted = (doInstance as unknown as {
      activityEmitted: Map<number, Set<string>>;
    }).activityEmitted;

    // Snapshot succeeds
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    // activityEmitted must now contain the user's entity key
    const userEmitted = activityEmitted.get(TEST_USER_ID);
    expect(userEmitted).toBeDefined();
    expect(userEmitted!.size).toBeGreaterThan(0);
  });

  it("when batch SUCCEEDS: newSessions is cleared", async () => {
    const db = makeSucceedingDb();
    const doInstance = makeDoWithActivityAndSession(db);

    const newSessions = (doInstance as unknown as { newSessions: Set<number> }).newSessions;
    expect(newSessions.has(TEST_USER_ID)).toBe(true);

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    expect(newSessions.has(TEST_USER_ID)).toBe(false);
  });
});
