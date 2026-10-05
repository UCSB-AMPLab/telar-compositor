/**
 * Reading a human key is TOTAL — a value nothing can render to a string is
 * read as unkeyed rather than throwing.
 *
 * `String` is a partial function. A plain object whose `toString` is null
 * converts to no primitive at all and throws `TypeError`, and Yjs stores plain
 * JSON as a map value verbatim, so such a value survives the `yjs_state` round
 * trip and any collaborator can put one at any key. Rendered raw, that value
 * rejects the whole snapshot: `snapshotToD1` throws before it writes anything,
 * every later snapshot throws in the same place, and the document stays open
 * and editable throughout — edits accepted, nothing persisted, nothing on
 * screen to say so.
 *
 * `renderedKey` closes that by answering `""` where it cannot render, which is
 * the value a map that has not been keyed yet already carries and the one
 * `deduplicateYArray` skips. The entry is not deduplicated, not deleted, and
 * cannot claim a colleague's key. What it costs is stated below: the key
 * column for that one entity persists as the empty string, the same as any
 * other unkeyed map, and the document keeps the value the editor can see.
 *
 * The suite asserts three things: that each of the four human keys and the
 * nested reference survive a plant, that the replacement sweep and the dedupe
 * read a key through the SAME function (they resolve one attack between them,
 * so a divergence leaves a replacement standing for the dedupe to act on), and
 * that an ordinary document dedupes exactly as it did.
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
import { makeCanDeleteHandler, makeViolationCounter, renderedKey } from "../workers/can-delete";
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;

/** A value that converts to no primitive at all: `String(...)` throws on it. */
function unrenderable(): Record<string, unknown> {
  return { toString: null };
}

// ---------------------------------------------------------------------------
// D1 fake — records every write with its bound values
// ---------------------------------------------------------------------------

interface Write {
  sql: string;
  binds: unknown[];
}

const CONFIG_ROW: Record<string, unknown> = {
  id: 1,
  project_id: PROJECT_ID,
  title: "Real site",
  description: "",
  author: "",
  email: "",
  lang: "en",
  baseurl: "/real",
  url: "https://real.example.org",
  telar_version: "1.5.0",
  theme: "default",
  logo: "",
  include_demo_content: 0,
  google_sheets_enabled: 0,
  google_sheets_published_url: "",
  show_on_homepage: 1,
  show_story_steps: 1,
  show_object_credits: 1,
  browse_and_search: 1,
  show_link_on_homepage: 1,
  show_sample_on_homepage: 0,
  collection_mode: 0,
  skip_stories: 0,
  featured_count: 4,
  story_key: "real-story-key",
  navigation_json: null,
};

interface DbSeed {
  yjsState: Uint8Array;
  objects?: Array<{ id: number; object_id: string }>;
  pages?: Array<{ id: number; slug: string }>;
  glossary?: Array<{ id: number; term_id: string }>;
  stories?: Array<{ id: number; story_id: string }>;
  stepIds?: number[];
}

function makeDb(seed: DbSeed) {
  const writes: Write[] = [];

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return bound; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); bound = args; return stmt; },
      async run() {
        if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) writes.push({ sql, binds: bound });
        return { meta: { last_row_id: 101, changes: 1 }, success: true as const };
      },
      async all<T = unknown>() {
        if (/SELECT id, object_id FROM objects/.test(sql)) {
          return { results: (seed.objects ?? []) as T[], success: true as const };
        }
        if (/SELECT id, slug FROM project_pages/.test(sql)) {
          return { results: (seed.pages ?? []) as T[], success: true as const };
        }
        if (/SELECT id, term_id FROM glossary_terms/.test(sql)) {
          return { results: (seed.glossary ?? []) as T[], success: true as const };
        }
        if (/SELECT id, story_id FROM stories/.test(sql)) {
          return { results: (seed.stories ?? []) as T[], success: true as const };
        }
        if (/SELECT id FROM steps WHERE story_id/.test(sql)) {
          return { results: (seed.stepIds ?? []).map((id) => ({ id })) as T[], success: true as const };
        }
        return { results: [] as T[], success: true as const };
      },
      async first<T = unknown>() {
        if (/^SELECT yjs_state/.test(sql)) {
          return { yjs_state: seed.yjsState, yjs_generation: 0, yjs_seq: 0, yjs_write: 0 } as T;
        }
        if (/FROM project_config/.test(sql)) return CONFIG_ROW as T;
        if (/FROM project_landing/.test(sql)) return null;
        return null;
      },
    };
    return stmt;
  }

  return {
    writes,
    DB: {
      prepare,
      async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
        for (const s of statements) writes.push({ sql: s.sql, binds: s.boundArgs });
        return statements.map(() => ({ success: true }));
      },
    },
  };
}

function makeCtx() {
  let chain: Promise<unknown> = Promise.resolve();
  const storage = new Map<string, unknown>();
  return {
    acceptWebSocket: vi.fn(),
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      const running = chain.then(() => fn());
      chain = running.catch(() => {});
      return running;
    },
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      list: async () => new Map(),
      get: async (k: string) => storage.get(k),
      put: async (k: string, v: unknown) => { storage.set(k, v); },
      delete: async () => 0,
    },
  };
}

type Internals = {
  projectId: number | null;
  docLoaded: boolean;
  ydoc: Y.Doc;
  ensureDocLoaded: () => Promise<void>;
};

function makeDoFromBlob(seed: DbSeed) {
  const db = makeDb(seed);
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: db.DB, SESSION_SECRET: "s", COLLABORATION: {} } as unknown as Env,
  );
  const internals = doInstance as unknown as Internals;
  internals.projectId = PROJECT_ID;
  return { db, doInstance, internals };
}

/** A `yjs_state` blob holding a healthy config plus whatever `plant` writes. */
function blobWith(plant: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const config = doc.getMap<unknown>("config");
    config.set("title", new Y.Text("Real site"));
    config.set("description", new Y.Text(""));
    config.set("author", new Y.Text(""));
    config.set("email", new Y.Text(""));
    config.set("lang", "en");
    config.set("theme", "default");
    config.set("logo", "");
    config.set("baseurl", "/real");
    config.set("url", "https://real.example.org");
    config.set("story_key", "real-story-key");
    config.set("include_demo_content", false);
    config.set("google_sheets_enabled", false);
    config.set("google_sheets_published_url", "");
    config.set("collection_mode", false);
    config.set("skip_stories", false);
    config.set("featured_count", 4);
    plant(doc);
  });
  return Y.encodeStateAsUpdate(doc);
}

/** Push one Y.Map, built from `fields`, onto a root array. */
function push(doc: Y.Doc, root: string, fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  doc.getArray<Y.Map<unknown>>(root).push([m]);
  return m;
}

/** The write against `table` whose last bound value is `id`, or undefined. */
function writeFor(writes: Write[], pattern: RegExp, id: number): Write | undefined {
  return writes.find((w) => pattern.test(w.sql) && w.binds[w.binds.length - 1] === id);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// 1. A plant at each key still snapshots
// ---------------------------------------------------------------------------

describe("a human key nothing can render leaves the project persisting", () => {
  it("snapshots an objects document carrying one at object_id", async () => {
    const { db, doInstance, internals } = makeDoFromBlob({
      yjsState: blobWith((doc) => {
        push(doc, "objects", { _id: 1, object_id: unrenderable(), title: new Y.Text("Planted") });
        push(doc, "objects", { _id: 2, object_id: "a-pot", title: new Y.Text("A pot") });
      }),
      objects: [{ id: 1, object_id: "el-cantaro" }, { id: 2, object_id: "a-pot" }],
    });

    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    // The blob reached D1 — the whole point: the snapshot ran to completion
    // rather than being refused on a value it could not read.
    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);

    const objects = internals.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(objects.length).toBe(2);
    // The plant is left exactly as it stands. Detection does not repair, and an
    // unreadable key is not licence to invent a readable one.
    expect(objects.get(0).get("object_id")).toEqual(unrenderable());
    // The neighbour is untouched: not deleted, not re-keyed, its row updated.
    expect(objects.get(1).get("object_id")).toBe("a-pot");
    expect(db.writes.some((w) => /DELETE FROM objects/.test(w.sql))).toBe(false);
    expect(writeFor(db.writes, /UPDATE objects SET/, 2)?.binds).toContain("a-pot");
    // The unreadable key persists as the unkeyed sentinel — the same value any
    // map that has not been keyed yet writes.
    expect(writeFor(db.writes, /UPDATE objects SET/, 1)?.binds).toContain("");
  });

  it("snapshots a stories document carrying one at story_id", async () => {
    const { db, doInstance, internals } = makeDoFromBlob({
      yjsState: blobWith((doc) => {
        push(doc, "stories", {
          _id: 1, story_id: unrenderable(), title: new Y.Text("Planted"),
          steps: new Y.Array<Y.Map<unknown>>(),
        });
        push(doc, "stories", {
          _id: 2, story_id: "la-vasija", title: new Y.Text("La vasija"),
          steps: new Y.Array<Y.Map<unknown>>(),
        });
      }),
      stories: [{ id: 1, story_id: "el-cantaro" }, { id: 2, story_id: "la-vasija" }],
    });

    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const stories = internals.ydoc.getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(2);
    expect(stories.get(0).get("story_id")).toEqual(unrenderable());
    expect(stories.get(1).get("story_id")).toBe("la-vasija");
    // Neither row was swept as an orphan.
    expect(db.writes.some((w) => /DELETE FROM stories/.test(w.sql))).toBe(false);
  });

  it("snapshots a glossary document carrying one at term_id", async () => {
    const { db, doInstance, internals } = makeDoFromBlob({
      yjsState: blobWith((doc) => {
        push(doc, "glossary", { _id: 1, term_id: unrenderable(), title: new Y.Text("Planted") });
        push(doc, "glossary", { _id: 2, term_id: "chicha", title: new Y.Text("Chicha") });
      }),
      glossary: [{ id: 1, term_id: "mochuelo" }, { id: 2, term_id: "chicha" }],
    });

    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const glossary = internals.ydoc.getArray<Y.Map<unknown>>("glossary");
    expect(glossary.length).toBe(2);
    expect(glossary.get(0).get("term_id")).toEqual(unrenderable());
    expect(writeFor(db.writes, /UPDATE glossary_terms SET/, 1)?.binds).toContain("");
    expect(writeFor(db.writes, /UPDATE glossary_terms SET/, 2)?.binds).toContain("chicha");
    expect(db.writes.some((w) => /DELETE FROM glossary_terms/.test(w.sql))).toBe(false);
  });

  it("snapshots a pages document carrying one at slug", async () => {
    const { db, doInstance, internals } = makeDoFromBlob({
      yjsState: blobWith((doc) => {
        push(doc, "pages", { _id: 1, slug: unrenderable(), title: new Y.Text("Planted") });
        push(doc, "pages", { _id: 2, slug: "about", title: new Y.Text("About") });
      }),
      pages: [{ id: 1, slug: "creditos" }, { id: 2, slug: "about" }],
    });

    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const pages = internals.ydoc.getArray<Y.Map<unknown>>("pages");
    expect(pages.length).toBe(2);
    expect(pages.get(0).get("slug")).toEqual(unrenderable());
    expect(writeFor(db.writes, /UPDATE project_pages SET/, 2)?.binds).toContain("about");
    expect(db.writes.some((w) => /DELETE FROM project_pages/.test(w.sql))).toBe(false);
  });

  it("snapshots a step carrying one at its object_id reference", async () => {
    // A step's `object_id` points at an object rather than naming the step, so
    // the domain rule deliberately leaves it open for the media picker. It is
    // still rendered into the steps row, so it is still a key read.
    const steps = new Y.Array<Y.Map<unknown>>();
    const { db, doInstance, internals } = makeDoFromBlob({
      yjsState: blobWith((doc) => {
        const step = new Y.Map<unknown>();
        step.set("_id", 5);
        step.set("object_id", unrenderable());
        step.set("kind", "media");
        steps.push([step]);
        push(doc, "stories", {
          _id: 1, story_id: "la-vasija", title: new Y.Text("La vasija"), steps,
        });
      }),
      stories: [{ id: 1, story_id: "la-vasija" }],
      stepIds: [5],
    });

    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    expect(writeFor(db.writes, /UPDATE steps SET/, 5)?.binds).toContain("");
    expect(db.writes.some((w) => /DELETE FROM steps/.test(w.sql))).toBe(false);
  });

  it("snapshots a step carrying one at its nested _id", async () => {
    // A nested `_id` is read by type and by set membership, never rendered, so
    // it cannot throw here. Pinned so that stays true: a render introduced at
    // this level would reopen the same permanent failure on a key no domain
    // rule reaches.
    const steps = new Y.Array<Y.Map<unknown>>();
    const { db, doInstance, internals } = makeDoFromBlob({
      yjsState: blobWith((doc) => {
        const step = new Y.Map<unknown>();
        step.set("_id", unrenderable());
        step.set("object_id", "a-pot");
        step.set("kind", "media");
        steps.push([step]);
        push(doc, "stories", {
          _id: 1, story_id: "la-vasija", title: new Y.Text("La vasija"), steps,
        });
      }),
      stories: [{ id: 1, story_id: "la-vasija" }],
    });

    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The sweep and the dedupe read a key the same way
// ---------------------------------------------------------------------------

type Role = "convenor" | "collaborator" | "instructor";

function fakeSocket(userId: number, role: Role) {
  return { deserializeAttachment: () => ({ userId, role }), send: vi.fn(), close: vi.fn() };
}

/** A bare Y.Doc with the delete handler wired exactly as the DO wires it. */
function makeSweepHarness() {
  const ydoc = new Y.Doc();
  const isReverting = { value: false };
  ydoc.on("afterTransaction", makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => false,
    isReverting: () => isReverting.value,
    setReverting: (v: boolean) => { isReverting.value = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => { /* not under test */ },
    recordViolation: makeViolationCounter(),
    warn: () => { /* not under test */ },
  }));
  return { ydoc, objects: ydoc.getArray<Y.Map<unknown>>("objects") };
}

/** A DO whose in-memory document can be handed straight to the dedupe. */
function makeBareDo() {
  const DB = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        checkD1Bind(undefined, args);
        return {
          async run() { return { meta: { last_row_id: 1, changes: 1 }, success: true as const }; },
          async all() { return { results: [], success: true as const }; },
          async first() { return null; },
        };
      },
    }),
    async batch() { return []; },
  };
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: DB as unknown, SESSION_SECRET: "test", COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  return { doInstance, ydoc: (doInstance as unknown as { ydoc: Y.Doc }).ydoc };
}

function dedupe(
  doInstance: ProjectCollaborationDO,
  arrayName: string,
  entityKey: string,
  d1KeyToId?: Map<string, number>,
): boolean {
  return (doInstance as unknown as {
    deduplicateYArray: (a: string, k: string, d?: Map<string, number>) => boolean;
  }).deduplicateYArray(arrayName, entityKey, d1KeyToId);
}

function makeObject(fields: Record<string, unknown>): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", null);
  m.set("created_by", 9);
  for (const [k, v] of Object.entries(fields)) m.set(k, v);
  return m;
}

const VICTIM_KEY = "vasija-muisca";

/**
 * Did the replacement sweep remove a competitor carrying `claim` at
 * `object_id`?
 *
 * The victim is a marked course item with a row id, the one shape whose sweep
 * reaches past the offending transaction — so the competitor can be seeded
 * under the runtime's own origin, where the value-domain pass never looks. Its
 * removal is then the sweep's reading and nothing else's.
 */
function sweepRemovesClaim(claim: () => unknown): boolean {
  const h = makeSweepHarness();
  h.ydoc.transact(() => {
    h.objects.push([makeObject({
      _id: 10, _temp_id: "uuid-victim", object_id: VICTIM_KEY,
      course_project_id: 3, title: new Y.Text("Course item"),
    })]);
  }, null);
  h.ydoc.transact(() => {
    h.objects.insert(0, [makeObject({
      _id: 11, _temp_id: "uuid-twin", object_id: claim(), title: new Y.Text(""),
    })]);
  }, null);
  h.ydoc.transact(() => {
    const at = h.objects.toArray().findIndex((m) => m.get("_temp_id") === "uuid-victim");
    h.objects.delete(at, 1);
  }, fakeSocket(7, "collaborator"));
  return h.objects.length === 1;
}

/**
 * `renderedKey` of a value as a document holds it. A detached `Y.Text` keeps
 * its content pending and renders empty, so the expectation has to be taken
 * from an integrated copy or it describes the harness rather than the rule.
 */
function renderedInDoc(value: unknown): string {
  const doc = new Y.Doc();
  const m = new Y.Map<unknown>();
  doc.getArray<Y.Map<unknown>>("objects").push([m]);
  m.set("object_id", value);
  return renderedKey(m.get("object_id"));
}

/** Did the pre-snapshot dedupe treat `claim` as a claim on the same key? */
function dedupeCollapsesClaim(claim: () => unknown): boolean {
  const { doInstance, ydoc } = makeBareDo();
  const objects = ydoc.getArray<Y.Map<unknown>>("objects");
  ydoc.transact(() => {
    objects.push([makeObject({ object_id: VICTIM_KEY, title: new Y.Text("Course item") })]);
    objects.push([makeObject({ object_id: claim(), title: new Y.Text("") })]);
  }, null);
  return dedupe(doInstance, "objects", "object_id");
}

describe("the replacement sweep and the pre-snapshot dedupe read one key", () => {
  // A rendering the sweep and the dedupe do not share is the whole attack: the
  // sweep declines to collect a replacement the dedupe will later collapse on,
  // and the replacement is left standing beside the restored victim to finish
  // the substitution. Both go through `renderedKey`, so the expectation here is
  // computed from `renderedKey` too — a change to one reading fails the pair.
  const claims: Array<{ name: string; make: () => unknown }> = [
    { name: "the key itself", make: () => VICTIM_KEY },
    { name: "a one-element array rendering to the key", make: () => [VICTIM_KEY] },
    { name: "a Y.Text rendering to the key", make: () => new Y.Text(VICTIM_KEY) },
    { name: "a different key", make: () => "otra-cosa" },
    { name: "a value nothing can render", make: () => unrenderable() },
  ];

  for (const { name, make } of claims) {
    it(`agrees on ${name}`, () => {
      const claimsTheKey = renderedInDoc(make()) === VICTIM_KEY;
      const swept = sweepRemovesClaim(make);
      const collapsed = dedupeCollapsesClaim(make);
      expect(swept).toBe(collapsed);
      expect(swept).toBe(claimsTheKey);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. An ordinary document dedupes exactly as it did
// ---------------------------------------------------------------------------

describe("an ordinary document is untouched", () => {
  it("re-keys a same-key loser and leaves D1's owner holding the key", () => {
    const { doInstance, ydoc } = makeBareDo();
    const objects = ydoc.getArray<Y.Map<unknown>>("objects");
    ydoc.transact(() => {
      objects.push([makeObject({ object_id: "a-pot", title: new Y.Text("Mine") })]);
      const owner = makeObject({ object_id: "a-pot", title: new Y.Text("Theirs") });
      owner.set("_id", 7);
      objects.push([owner]);
      objects.push([makeObject({ object_id: "b-pot", title: new Y.Text("Other") })]);
    }, null);

    expect(dedupe(doInstance, "objects", "object_id", new Map([["a-pot", 7]]))).toBe(true);
    expect(objects.length).toBe(3);
    // D1 says row 7 owns "a-pot", so it keeps the key wherever it sits.
    expect(objects.get(1).get("object_id")).toBe("a-pot");
    expect(objects.get(0).get("object_id")).toBe("a-pot-2");
    expect(objects.get(2).get("object_id")).toBe("b-pot");
  });

  it("changes nothing when every key is distinct", () => {
    const { doInstance, ydoc } = makeBareDo();
    const objects = ydoc.getArray<Y.Map<unknown>>("objects");
    ydoc.transact(() => {
      objects.push([makeObject({ object_id: "a-pot" })]);
      objects.push([makeObject({ object_id: "b-pot" })]);
    }, null);

    expect(dedupe(doInstance, "objects", "object_id", new Map())).toBe(false);
    expect(objects.length).toBe(2);
    expect(objects.get(0).get("object_id")).toBe("a-pot");
    expect(objects.get(1).get("object_id")).toBe("b-pot");
  });

  it("collapses two maps claiming one persisted row, as before", () => {
    const { doInstance, ydoc } = makeBareDo();
    const objects = ydoc.getArray<Y.Map<unknown>>("objects");
    ydoc.transact(() => {
      const first = makeObject({ object_id: "a-pot", title: new Y.Text("Keeper") });
      first.set("_id", 7);
      const second = makeObject({ object_id: "a-pot", title: new Y.Text("Duplicate") });
      second.set("_id", 7);
      objects.push([first, second]);
    }, null);

    expect(dedupe(doInstance, "objects", "object_id", new Map([["a-pot", 7]]))).toBe(true);
    expect(objects.length).toBe(1);
    expect(objects.get(0).get("_id")).toBe(7);
  });
});
