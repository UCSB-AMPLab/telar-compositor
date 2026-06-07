/**
 * Pins the created_by round-trip added in migration 0029.
 *
 * Collaborators stamp created_by on each entity's Y.Map at creation; the
 * delete-permission gate (use-structural-ops canDelete + workers/can-delete)
 * relies on it. Before 0029 there was no D1 column, so a cold rebuild from D1
 * (buildFromD1Rows, after a convenor reset or blob-loss eviction) reconstructed
 * every entity with created_by: undefined — silently destroying authorship.
 *
 * Two assertions, one per direction of the round-trip:
 *   (a) snapshotToD1 binds the Y.Map's created_by into the entity INSERT
 *   (b) buildFromD1Rows copies a D1 row's created_by onto the rebuilt Y.Map
 *
 * The DO class is exercised directly with a stubbed ctx/env, mirroring
 * collaboration-do.test.ts. The DB is a hand-rolled fake that records every
 * prepare/bind and routes SELECTs by SQL substring.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

interface BindCall {
  sql: string;
  args: unknown[];
}

/**
 * Fake D1 database. Records every bind call. SELECTs are routed by SQL
 * substring to a per-test row provider; everything else (orphan-id SELECTs,
 * INSERT run, the projects blob UPDATE, batch) returns benign defaults.
 */
function makeFakeDB(rowProvider: (sql: string) => unknown[]) {
  const binds: BindCall[] = [];

  const stmt = (sql: string) => ({
    bind(...args: unknown[]) {
      binds.push({ sql, args });
      return {
        async run() {
          return { meta: { last_row_id: 100 } };
        },
        async all<T>() {
          return { results: rowProvider(sql) as T[] };
        },
        async first<T>() {
          return (rowProvider(sql)[0] ?? null) as T | null;
        },
      };
    },
  });

  const DB = {
    prepare: (sql: string) => stmt(sql),
    async batch() {
      return [];
    },
  };

  return { DB, binds };
}

function makeCtx() {
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: { getAlarm: async () => null, setAlarm: async () => {} },
    acceptWebSocket: vi.fn(),
  };
}

function makeDO(rowProvider: (sql: string) => unknown[]) {
  const { DB, binds } = makeFakeDB(rowProvider);
  const env = { DB, SESSION_SECRET: "s", COLLABORATION: {} } as unknown;
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    env as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  (doInstance as unknown as { docLoaded: boolean }).docLoaded = true;
  return { doInstance, binds };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (a) snapshot INSERT binds created_by
// ---------------------------------------------------------------------------

describe("snapshotToD1 persists created_by on new entities", () => {
  it("a new story Y.Map with created_by=7 produces a stories INSERT binding 7", async () => {
    // All SELECTs return empty → no orphans, and the new _id=null story takes
    // the INSERT path.
    const { doInstance, binds } = makeDO(() => []);

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const storyMap = new Y.Map<unknown>();
      storyMap.set("_id", null);
      storyMap.set("created_by", 7);
      storyMap.set("story_id", "draft-authored");
      storyMap.set("title", new Y.Text("Authored Story"));
      storyMap.set("subtitle", new Y.Text(""));
      storyMap.set("byline", new Y.Text(""));
      storyMap.set("order", 0);
      storyMap.set("private", false);
      storyMap.set("draft", true);
      storyMap.set("show_sections", false);
      storyMap.set("steps", new Y.Array<Y.Map<unknown>>());
      ydoc.getArray<Y.Map<unknown>>("stories").push([storyMap]);
    }, null);

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    const storyInsert = binds.find((b) => b.sql.includes("INSERT INTO stories"));
    expect(storyInsert).toBeDefined();
    // Migration 0029 added created_by to the column list; its bind value must
    // be the Y.Map's created_by (7), not null.
    expect(storyInsert!.args).toContain(7);
  });
});

// ---------------------------------------------------------------------------
// (b) buildFromD1Rows restores created_by
// ---------------------------------------------------------------------------

describe("buildFromD1Rows restores created_by on cold rebuild", () => {
  it("a stories D1 row with created_by=7 yields a rebuilt Y.Map with created_by===7", async () => {
    const storyRow = {
      id: 1,
      story_id: "s-1",
      title: "Rebuilt",
      subtitle: null,
      byline: null,
      order: 0,
      private: 0,
      draft: 0,
      show_sections: 0,
      created_by: 7,
    };

    const { doInstance } = makeDO((sql) => {
      if (sql.includes("FROM stories")) return [storyRow];
      // config/landing first(), all other SELECTs → empty
      return [];
    });

    await (
      doInstance as unknown as { buildFromD1Rows: () => Promise<void> }
    ).buildFromD1Rows();

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    const storiesArr = ydoc.getArray<Y.Map<unknown>>("stories");
    expect(storiesArr.length).toBe(1);
    expect(storiesArr.get(0).get("created_by")).toBe(7);
  });
});
