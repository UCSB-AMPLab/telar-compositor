/**
 * A container the server cannot read is not an empty container.
 *
 * `steps` and `layers` are read as `storyMap.get("steps") as Y.Array<...>` and
 * handed straight to `orderedMaps`, which calls `.toArray()` on them. Yjs
 * stores plain JSON verbatim, so a collaborator can put `{}` or `[]` at either
 * key and neither has that method: the snapshot throws inside its own batch,
 * which rejects the whole batch while the document stays open and editable —
 * every edit accepted, none persisted, and nothing on screen saying so.
 *
 * The obvious repair is the dangerous one, and this file exists to pin it out.
 * Reading a malformed container as ABSENT is worse than the throw: absence has
 * a meaning here, and the meaning is "this story has no steps", so the orphan
 * pass at the end of the walk deletes every step row D1 holds. That turns a
 * denial of service into silent, permanent data loss, and it is the reason the
 * readers answer `missing` and `wrong_type` separately instead of `null` for
 * both.
 *
 * So both halves are asserted together, because either one alone is satisfied
 * by a fix that breaks the other:
 *
 *   1. the snapshot completes rather than throwing, and
 *   2. the step and layer rows already in D1 are still there afterwards.
 *
 * D1 holds the authoritative row. A value the document cannot state is a
 * reason to not know what the document says, and "I do not know" must never
 * resolve to "delete".
 *
 * @version v1.5.0-beta
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
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

const TEST_PROJECT_ID = 42;
const STORY_ID = 7;
const STEP_IDS = [11, 12];
const LAYER_IDS = [21, 22];

interface BindCall {
  sql: string;
  args: unknown[];
}

function makeDO(rowProvider: (sql: string) => unknown[]) {
  const binds: BindCall[] = [];
  const stmt = (sql: string) => ({
    bind(...args: unknown[]) {
      checkD1Bind(sql, args);
      binds.push({ sql, args });
      return {
        async run() {
          return { meta: { last_row_id: 100, changes: 1 } };
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
  const env = { DB, SESSION_SECRET: "s", COLLABORATION: {} } as unknown;
  const ctx = {
    getWebSockets: () => [] as unknown[],
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
    env as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  markLoaded(doInstance);
  return { doInstance, binds };
}

/** D1 holds the story, its two steps and their two layers. */
function liveRows(sql: string): unknown[] {
  if (/SELECT id, story_id FROM stories WHERE project_id/.test(sql)) {
    return [{ id: STORY_ID, story_id: "the-story" }];
  }
  if (/SELECT id FROM steps WHERE story_id/.test(sql)) {
    return STEP_IDS.map((id) => ({ id }));
  }
  if (/SELECT id FROM layers WHERE step_id/.test(sql)) {
    return LAYER_IDS.map((id) => ({ id }));
  }
  return [];
}

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

/** Ids named by a DELETE against `table`, whatever the statement's shape. */
function deletedIds(binds: BindCall[], table: string): unknown[] {
  return binds
    .filter((b) => new RegExp(`DELETE FROM ${table}\\b`).test(b.sql))
    .flatMap((b) => b.args);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ["a plain object", () => JSON.parse("{}") as unknown],
  ["a plain array", () => JSON.parse("[]") as unknown],
  ["a string", () => "steps"],
  ["a number", () => 0],
  // `null` is the one that looks like nothing and is not: `set("steps", null)`
  // leaves the key PRESENT, and reading it as absence answers "this story has
  // no steps" — on which the orphan pass deletes every step row D1 holds.
  ["null", () => null],
])("a story whose steps key holds %s", (_label, makeValue) => {
  it("snapshots without throwing, and leaves every step and layer row in D1", async () => {
    const { doInstance, binds } = makeDO(liveRows);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;

    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_id", STORY_ID);
      story.set("story_id", "the-story");
      story.set("title", new Y.Text("The story"));
      story.set("steps", makeValue()); // plain JSON, stored verbatim
      ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    expect(deletedIds(binds, "steps")).not.toContain(STEP_IDS[0]);
    expect(deletedIds(binds, "steps")).not.toContain(STEP_IDS[1]);
    expect(deletedIds(binds, "layers")).not.toContain(LAYER_IDS[0]);
    expect(deletedIds(binds, "layers")).not.toContain(LAYER_IDS[1]);
  });
});

describe.each([
  ["a plain object", () => JSON.parse("{}") as unknown],
  ["null", () => null],
])("a step whose layers key holds %s", (_label, makeLayers) => {
  it("snapshots without throwing, and leaves every layer row in D1", async () => {
    const { doInstance, binds } = makeDO(liveRows);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;

    ydoc.transact(() => {
      const step = new Y.Map<unknown>();
      step.set("_id", STEP_IDS[0]);
      step.set("layers", makeLayers());
      const steps = new Y.Array<unknown>();
      steps.push([step]);
      const story = new Y.Map<unknown>();
      story.set("_id", STORY_ID);
      story.set("story_id", "the-story");
      story.set("title", new Y.Text("The story"));
      story.set("steps", steps);
      ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    expect(deletedIds(binds, "layers")).not.toContain(LAYER_IDS[0]);
    expect(deletedIds(binds, "layers")).not.toContain(LAYER_IDS[1]);
  });
});

describe("a refused element may be carrying the id of a live row", () => {
  it("does not sweep the story row a plain-object element claims", async () => {
    // This is the trap one level down from the container case, and the reason
    // `orderedEntries` reports positions instead of quietly dropping members.
    // The element holds `_id: 7` and D1 holds story 7. Drop it silently and no
    // Y.Map claims that row, so the orphan sweep reads it as deleted and
    // cascades away its steps and layers — data loss caused by the guard.
    //
    // Reading the id back off the element is not the answer either: resolving
    // identity out of a value the server refused is the operation this whole
    // class is made of. Not knowing is the honest state, and not knowing means
    // not deleting.
    const { doInstance, binds } = makeDO(liveRows);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;

    ydoc.transact(() => {
      ydoc
        .getArray<unknown>("stories")
        .push([JSON.parse(`{"_id": ${STORY_ID}, "story_id": "the-story"}`) as unknown]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    expect(deletedIds(binds, "stories")).not.toContain(STORY_ID);
    expect(deletedIds(binds, "steps")).not.toContain(STEP_IDS[0]);
    expect(deletedIds(binds, "layers")).not.toContain(LAYER_IDS[0]);
  });

  it("does not sweep the object row a plain-object element claims", async () => {
    // Same rule on the flat reconciler, which walks objects, glossary and
    // pages through one shared pass.
    const OBJECT_ID = 55;
    const { doInstance, binds } = makeDO((sql) => {
      if (/SELECT id, object_id FROM objects WHERE project_id/.test(sql)) {
        return [{ id: OBJECT_ID, object_id: "pot-01" }];
      }
      return [];
    });
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;

    ydoc.transact(() => {
      ydoc
        .getArray<unknown>("objects")
        .push([JSON.parse(`{"_id": ${OBJECT_ID}, "object_id": "pot-01"}`) as unknown]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    expect(deletedIds(binds, "objects")).not.toContain(OBJECT_ID);
  });

  it("reports the position it refused, and never the element", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    const { doInstance } = makeDO(liveRows);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      ydoc
        .getArray<unknown>("stories")
        .push([JSON.parse('{"story_id": "a-forged-key"}') as unknown]);
    }, null);

    await snapshot(doInstance);
    spy.mockRestore();

    const line = errors.find((e) => e.includes("root=stories"));
    expect(line).toBeDefined();
    expect(line).toContain("[shape][detected]");
    expect(line).toContain("stories[0]");
    expect(line).not.toContain("a-forged-key");
  });
});

describe("a stories array holding a plain object at one position", () => {
  it("snapshots without throwing, and does not orphan the story that IS a map", async () => {
    const { doInstance, binds } = makeDO(liveRows);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;

    ydoc.transact(() => {
      const stories = ydoc.getArray<unknown>("stories");
      // A genuine Y.Array can hold plain JSON at a position: guarding the
      // container with `instanceof Y.Array` does not guard its members.
      stories.push([JSON.parse('{"_id": 999}') as unknown]);
      const story = new Y.Map<unknown>();
      story.set("_id", STORY_ID);
      story.set("story_id", "the-story");
      story.set("title", new Y.Text("The story"));
      stories.push([story]);
    }, null);

    await expect(snapshot(doInstance)).resolves.toBeUndefined();

    // The real story is still in the document, so its row is not an orphan.
    expect(deletedIds(binds, "stories")).not.toContain(STORY_ID);
  });
});
