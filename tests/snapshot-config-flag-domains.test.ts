/**
 * A config flag is a boolean, and truthiness is not a domain.
 *
 * The boolean columns of `project_config` were bound two ways — `v ? 1 : 0`
 * for a key that defaults off, `v !== false ? 1 : 0` for one that defaults on
 * — and both read whatever the document holds through JavaScript truthiness.
 * Yjs stores plain JSON verbatim, so the value at `skip_stories` can be the
 * string `"false"`, which is non-empty and therefore true; or `{}`, which is
 * also true. Under the `!== false` idiom a plain object cannot even express
 * OFF: nothing a collaborator can write except the boolean `false` itself
 * turns those settings off.
 *
 * That is the third form of the value-domain class, and it is not a crash. It
 * is a convenor's setting silently reverting, and these columns decide what a
 * built site publishes — `skip_stories` and `collection_mode` most of all.
 *
 * Out of domain keeps what D1 already holds rather than the key's default,
 * and keeps it by OMISSION: the column is dropped from the SET list, so the
 * row is untouched and no read is made for it. Resolving to the default would
 * let a plant undo a choice the convenor made, which is the whole outcome in
 * miniature; reading the row and binding it back would add a read that can
 * fail before the blob is written, and a window in which a value read early
 * and bound late overwrites a save that landed in between.
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

/** The bound value of one column of the config UPDATE. */
function boundConfigValue(binds: BindCall[], column: string): unknown {
  const update = binds.find((b) => /UPDATE project_config SET/.test(b.sql));
  expect(update, "the config UPDATE was not issued").toBeDefined();
  const columns = update!.sql
    .replace(/^UPDATE project_config SET /, "")
    .replace(/ WHERE project_id = \?$/, "")
    .split(", ")
    .map((assignment) => assignment.split(" = ")[0]);
  const index = columns.indexOf(column);
  expect(index, `${column} is not in the UPDATE`).toBeGreaterThanOrEqual(0);
  return update!.args[index];
}

/** D1 holds a config row; `held` supplies the columns a preserve read asks for. */
function configRows(held: Record<string, unknown> = {}) {
  return (sql: string): unknown[] => {
    if (/SELECT id FROM project_config WHERE project_id/.test(sql)) {
      return [{ id: 1 }];
    }
    if (/^SELECT .+ FROM project_config WHERE project_id/.test(sql)) {
      return [held];
    }
    return [];
  };
}

async function snapshotWithConfig(
  value: unknown,
  key: string,
  held: Record<string, unknown> = {},
) {
  const { doInstance, binds } = makeDO(configRows(held));
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  ydoc.transact(() => {
    ydoc.getMap<unknown>("config").set(key, value);
  }, null);
  await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
  return binds;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a boolean config key holding a real boolean", () => {
  it("binds it, both ways round", async () => {
    expect(
      boundConfigValue(await snapshotWithConfig(false, "skip_stories"), "skip_stories"),
    ).toBe(0);
    expect(
      boundConfigValue(await snapshotWithConfig(true, "skip_stories"), "skip_stories"),
    ).toBe(1);
    expect(
      boundConfigValue(await snapshotWithConfig(false, "browse_and_search"), "browse_and_search"),
    ).toBe(0);
  });
});

/** The columns the config UPDATE does not write. */
function omittedFrom(binds: BindCall[], column: string): boolean {
  const update = binds.find((b) => /UPDATE project_config SET/.test(b.sql));
  expect(update, "the config UPDATE was not issued").toBeDefined();
  return !new RegExp(`\\b${column} = \\?`).test(update!.sql);
}

describe("a boolean config key the document cannot state", () => {
  it.each([
    ["the string 'false'", "false"],
    ["a plain object", JSON.parse("{}")],
    ["a plain array", JSON.parse("[]")],
    ["a number", 1],
  ])("keeps D1's OFF for a default-off key rather than reading %s as ON", async (_l, value) => {
    // Truthiness reads every one of these as ON. The column is dropped from
    // the SET list instead, so D1 keeps the OFF it holds without the snapshot
    // reading it — a read here is one that can fail before the blob is
    // written, and a value read early and bound late can overwrite a save
    // that landed in between.
    expect(Boolean(value)).toBe(true);
    const binds = await snapshotWithConfig(value, "skip_stories", { skip_stories: 0 });
    expect(omittedFrom(binds, "skip_stories")).toBe(true);
  });

  it.each([
    ["the string 'false'", "false"],
    ["a plain object", JSON.parse("{}")],
  ])("keeps D1's OFF for a default-ON key rather than reading %s as ON", async (_l, value) => {
    // The `!== false` idiom cannot express OFF for any of these.
    expect(value !== false).toBe(true);
    const binds = await snapshotWithConfig(value, "browse_and_search", {
      browse_and_search: 0,
    });
    expect(omittedFrom(binds, "browse_and_search")).toBe(true);
  });

  it("holds the column whatever D1 turns out to hold", async () => {
    // Omission asks D1 nothing, so what the row holds cannot change what the
    // snapshot does; the whole answer is "this column is not written".
    const off = await snapshotWithConfig(JSON.parse("{}"), "skip_stories", {});
    expect(omittedFrom(off, "skip_stories")).toBe(true);
    const on = await snapshotWithConfig(JSON.parse("{}"), "browse_and_search", {});
    expect(omittedFrom(on, "browse_and_search")).toBe(true);
    const reads = on.filter(
      (b) => /^SELECT/.test(b.sql) && /FROM project_config/.test(b.sql),
    );
    expect(reads.map((b) => b.sql)).toEqual([
      "SELECT id FROM project_config WHERE project_id = ?",
    ]);
  });

  it("reads the plant by position and never renders it", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    await snapshotWithConfig(["a-forged-value"], "skip_stories", { skip_stories: 0 });
    spy.mockRestore();
    const line = errors.find((e) => e.includes("config.skip_stories"));
    expect(line).toBeDefined();
    expect(line).toContain("[shape][detected]");
    expect(line).toContain("the column keeps what D1 holds and nothing is repaired");
    expect(line).not.toContain("a-forged-value");
  });
});

describe("an unset boolean config key", () => {
  it("takes the key's declared default, which is not the same answer as malformed", async () => {
    // Nothing is set on the config map at all.
    const { doInstance, binds } = makeDO(configRows());
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    expect(boundConfigValue(binds, "skip_stories")).toBe(0);
    expect(boundConfigValue(binds, "browse_and_search")).toBe(1);
  });
});

describe("config.navigation", () => {
  it("keeps the navigation D1 holds when the key is malformed", async () => {
    const { doInstance, binds } = makeDO(configRows());
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      // A plain array: `instanceof Y.Array` is false and `?.toArray()` is a
      // TypeError, because `?.` guards the receiver and not the member.
      ydoc.getMap<unknown>("config").set("navigation", JSON.parse("[]"));
    }, null);
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    // `navigation_json` is dropped from the SET list, so the row keeps the
    // navigation it holds and the snapshot never reads it back to bind it.
    expect(omittedFrom(binds, "navigation_json")).toBe(true);
    expect(
      binds.some((b) => /SELECT navigation_json FROM project_config/.test(b.sql)),
    ).toBe(false);
  });

  it("writes an empty navigation when the key is genuinely unset", async () => {
    const { doInstance, binds } = makeDO(configRows());
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    expect(boundConfigValue(binds, "navigation_json")).toBe("[]");
  });
});

/**
 * The column binds — the other half of the third form.
 *
 * Every one of these columns was bound by casting the document's value to what
 * the column wanted (`stepMap.get("x") as number | null`). A cast is a
 * compile-time claim about a run-time value, and the value is whatever a
 * collaborator wrote. Two consequences, and the second is not hypothetical:
 * an out-of-domain value reached SQLite, and an UNSET key bound `undefined`,
 * which is not a value SQLite takes at all.
 */
describe("column binds take the column's domain", () => {
  async function snapshotStep(fields: Record<string, unknown>) {
    const { doInstance, binds } = makeDO(() => []);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const step = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(fields)) step.set(k, v);
      const steps = new Y.Array<unknown>();
      steps.push([step]);
      const story = new Y.Map<unknown>();
      story.set("story_id", "s");
      story.set("title", new Y.Text("S"));
      story.set("steps", steps);
      ydoc.getArray<unknown>("stories").push([story]);
    }, null);
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    const insert = binds.find((b) => /INSERT INTO steps/.test(b.sql));
    expect(insert, "the step INSERT was not issued").toBeDefined();
    const columns = insert!.sql
      .replace(/^INSERT INTO steps \(/, "")
      .replace(/\).*$/, "")
      .split(", ");
    return (column: string) => insert!.args[columns.indexOf(column)];
  }

  it("binds a coordinate that is a finite number", async () => {
    const at = await snapshotStep({ x: 0.25, y: -3, zoom: 2 });
    expect(at("x")).toBe(0.25);
    expect(at("y")).toBe(-3);
    expect(at("zoom")).toBe(2);
  });

  it("binds NULL — never undefined — for a coordinate the step does not carry", async () => {
    // SQLite has no `undefined`. The cast said `number | null` and an unset
    // key is neither.
    const at = await snapshotStep({});
    expect(at("x")).toBeNull();
    expect(at("y")).toBeNull();
    expect(at("zoom")).toBeNull();
  });

  it.each([
    ["a plain object", JSON.parse("{}")],
    ["a plain array", JSON.parse("[]")],
    ["a string", "12"],
    ["NaN", NaN],
  ])("binds NULL for a coordinate holding %s", async (_l, value) => {
    const at = await snapshotStep({ x: value });
    expect(at("x")).toBeNull();
  });

  it.each([
    ["a plain object", JSON.parse("{}")],
    ["a string", "abc"],
    ["a negative number", -1],
    ["a fraction", 1.5],
  ])("binds NULL for created_by holding %s", async (_l, value) => {
    const at = await snapshotStep({ created_by: value });
    expect(at("created_by")).toBeNull();
  });

  it("binds a real user id for created_by", async () => {
    const at = await snapshotStep({ created_by: 9 });
    expect(at("created_by")).toBe(9);
  });

  it.each([
    ["a plain object", JSON.parse("{}")],
    ["a plain array", JSON.parse("[]")],
    ["the empty string", ""],
    ["a number", 3],
  ])("binds NULL for order_key holding %s", async (_l, value) => {
    const at = await snapshotStep({ order_key: value });
    expect(at("order_key")).toBeNull();
  });

  async function snapshotStory(fields: Record<string, unknown>) {
    const { doInstance, binds } = makeDO(() => []);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("story_id", "s");
      story.set("title", new Y.Text("S"));
      for (const [k, v] of Object.entries(fields)) story.set(k, v);
      ydoc.getArray<unknown>("stories").push([story]);
    }, null);
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    const insert = binds.find((b) => /INSERT INTO stories/.test(b.sql));
    expect(insert, "the story INSERT was not issued").toBeDefined();
    const columns = insert!.sql
      .replace(/^INSERT INTO stories \(/, "")
      .replace(/\).*$/, "")
      .split(", ");
    return (column: string) => insert!.args[columns.indexOf(column)];
  }

  it("binds a story's booleans as booleans", async () => {
    expect((await snapshotStory({ private: true }))("private")).toBe(1);
    expect((await snapshotStory({ private: false }))("private")).toBe(0);
    expect((await snapshotStory({}))("private")).toBe(0);
  });

  it.each([
    ["the string 'false'", "false"],
    ["a plain object", JSON.parse("{}")],
    ["a plain array", JSON.parse("[]")],
    ["a number", 1],
  ])("writes nothing for a story whose private holds %s", async (_l, value) => {
    // There is no default that is safe in both directions, and that is the
    // finding rather than an inconvenience. `private = 1` withholds a story,
    // so binding the column's default of 0 for a value the server cannot read
    // PUBLISHES work its author kept back — on the strength of a value a
    // collaborator wrote. Binding 1 instead would hide a story nobody asked to
    // hide. So the entity is not written at all, and the plant is reported.
    expect(Boolean(value)).toBe(true);
    const { doInstance, binds } = makeDO(() => []);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("story_id", "s");
      story.set("title", new Y.Text("S"));
      story.set("private", value);
      ydoc.getArray<unknown>("stories").push([story]);
    }, null);
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    expect(binds.find((b) => /INSERT INTO stories/.test(b.sql))).toBeUndefined();
    expect(binds.find((b) => /UPDATE stories SET/.test(b.sql))).toBeUndefined();
  });

  it("does not sweep the row of a story it declined to write", async () => {
    const STORY_ID = 7;
    const { doInstance, binds } = makeDO((sql) => {
      if (/SELECT id, story_id FROM stories WHERE project_id/.test(sql)) {
        return [{ id: STORY_ID, story_id: "s" }];
      }
      return [];
    });
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_id", STORY_ID);
      story.set("story_id", "s");
      story.set("title", new Y.Text("S"));
      story.set("private", JSON.parse("{}"));
      ydoc.getArray<unknown>("stories").push([story]);
    }, null);
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    const deletes = binds
      .filter((b) => /DELETE FROM stories\b/.test(b.sql))
      .flatMap((b) => b.args);
    expect(deletes).not.toContain(STORY_ID);
  });

  it("writes nothing for an object whose featured flag is unreadable, and keeps its row", async () => {
    // The flat reconciler walks objects, glossary and pages through one pass;
    // objects are the arm that carries booleans.
    const OBJECT_ID = 55;
    const { doInstance, binds } = makeDO((sql) => {
      if (/SELECT id, object_id FROM objects WHERE project_id/.test(sql)) {
        return [{ id: OBJECT_ID, object_id: "pot-01" }];
      }
      return [];
    });
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const obj = new Y.Map<unknown>();
      obj.set("_id", OBJECT_ID);
      obj.set("object_id", "pot-01");
      obj.set("title", new Y.Text("Pot"));
      obj.set("featured", JSON.parse("{}"));
      ydoc.getArray<unknown>("objects").push([obj]);
    }, null);
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    expect(binds.find((b) => /UPDATE objects SET/.test(b.sql))).toBeUndefined();
    expect(binds.find((b) => /INSERT INTO objects/.test(b.sql))).toBeUndefined();
    const deletes = binds
      .filter((b) => /DELETE FROM objects\b/.test(b.sql))
      .flatMap((b) => b.args);
    expect(deletes).not.toContain(OBJECT_ID);
  });

  it("reports the field by name and never the value", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
    const { doInstance } = makeDO(() => []);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("story_id", "s");
      story.set("title", new Y.Text("S"));
      story.set("private", ["a-forged-value"]);
      ydoc.getArray<unknown>("stories").push([story]);
    }, null);
    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    spy.mockRestore();

    const line = errors.find((e) => e.includes("root=stories"));
    expect(line).toBeDefined();
    expect(line).toContain("[shape][detected]");
    expect(line).toContain("private");
    expect(line).not.toContain("a-forged-value");
  });
});
