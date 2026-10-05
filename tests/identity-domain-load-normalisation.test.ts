/**
 * A value at an identity key that is not the KIND of thing that key holds is
 * refused at the socket by `extractIdentityDomainViolations` and at the
 * `/ingest-sync` boundary by `partitionOnIdentityDomain` — but blocking new
 * plants does not remove old ones. A document carrying one from before those
 * guards shipped restores it from its `yjs_state` blob on every load.
 *
 * The substrate half of the rule is DETECTION, not repair. Repairing one at
 * load time means choosing a replacement, and every replacement available is a
 * guess: only D1 can say which row owns a key, that read can fail, and the
 * fallbacks each either invent a reference or read identity out of the value's
 * own rendering. A repair also runs before the document opens, so a value
 * whose rendering throws refuses the document to every editor of the project.
 * So the load scans, names what it finds by POSITION, and changes nothing.
 *
 * This suite therefore asserts three things: that the value is left exactly as
 * it stands, that the report names arm, root and position and never the value,
 * and — the part that is easy to leave untested — what the standing plant then
 * does downstream, which is a known state rather than a hidden one.
 *
 * @version v1.5.0-beta
 */


import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { checkD1Bind } from "./helpers/d1-memory";

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

const PROJECT_ID = 42;

/** The `project_config` row D1 answers with. */
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
  /** `objects` rows as `id -> object_id`. */
  objects?: Array<{ id: number; object_id: string }>;
  pages?: Array<{ id: number; slug: string }>;
  glossary?: Array<{ id: number; term_id: string }>;
  stories?: Array<{ id: number; story_id: string }>;
  stepIds?: number[];
  layerIds?: number[];
  /** When set, every entity-key SELECT rejects with this error. */
  entityReadError?: Error;
}

function makeDb(seed: DbSeed) {
  const queries: string[] = [];
  // Mutable so a test can let D1 recover between two loads, which is the whole
  // point of deferring a repair rather than guessing one.
  const state = { entityReadError: seed.entityReadError ?? null as Error | null };

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return bound; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); bound = args; return stmt; },
      async run() { queries.push(sql); return { meta: { last_row_id: 1, changes: 1 }, success: true as const }; },
      async all<T = unknown>() {
        queries.push(sql);
        if (/FROM objects o?\s*WHERE|FROM objects WHERE/.test(sql) && /SELECT id, object_id/.test(sql)) {
          if (state.entityReadError) throw state.entityReadError;
          return { results: (seed.objects ?? []) as T[], success: true as const };
        }
        if (/SELECT id, slug FROM project_pages/.test(sql)) {
          if (state.entityReadError) throw state.entityReadError;
          return { results: (seed.pages ?? []) as T[], success: true as const };
        }
        if (/SELECT id, term_id FROM glossary_terms/.test(sql)) {
          if (state.entityReadError) throw state.entityReadError;
          return { results: (seed.glossary ?? []) as T[], success: true as const };
        }
        if (/SELECT id, story_id FROM stories/.test(sql)) {
          if (state.entityReadError) throw state.entityReadError;
          return { results: (seed.stories ?? []) as T[], success: true as const };
        }
        if (/FROM steps st /.test(sql) && /SELECT st\.id AS id/.test(sql)) {
          return { results: (seed.stepIds ?? []).map((id) => ({ id })) as T[], success: true as const };
        }
        if (/FROM layers l /.test(sql) && /SELECT l\.id AS id/.test(sql)) {
          return { results: (seed.layerIds ?? []).map((id) => ({ id })) as T[], success: true as const };
        }
        return { results: [] as T[], success: true as const };
      },
      async first<T = unknown>() {
        queries.push(sql);
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
    queries,
    state,
    DB: {
      prepare,
      async batch(statements: Array<{ sql: string }>) {
        for (const s of statements) queries.push(s.sql);
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
  flushSnapshotNow: () => Promise<boolean>;
  reportIdentityDomainPlants: () => void;
};

function makeDo(seed: DbSeed) {
  const db = makeDb(seed);
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: db.DB, SESSION_SECRET: "s", COLLABORATION: {} } as unknown as Env,
  );
  const internals = doInstance as unknown as Internals;
  internals.projectId = PROJECT_ID;
  return { db, doInstance, internals };
}

/** Every statement that would change D1, in the order the DO issued it. */
function d1Writes(queries: string[]): string[] {
  return queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q));
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

let errors: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  });
});

/** The one `[identity][detected]` line, or "" when the scan said nothing. */
function detection(): string {
  const lines = errors.filter((e) => e.includes("[identity][detected]"));
  expect(lines.length, "the scan must emit at most one line").toBeLessThanOrEqual(1);
  return lines[0] ?? "";
}

// ---------------------------------------------------------------------------
// 1. The value is left exactly as it stands
// ---------------------------------------------------------------------------

describe("a load-time identity plant is detected and left alone", () => {
  it("leaves an out-of-domain _id standing, and the human key with it", async () => {
    const { internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "objects", { _id: new Y.Text("7"), object_id: "a-pot" });
      }),
      objects: [{ id: 7, object_id: "a-pot" }],
    });

    await internals.ensureDocLoaded();

    const obj = internals.ydoc.getArray<Y.Map<unknown>>("objects").get(0);
    // D1 holds row 7 for "a-pot", so a repair had an answer available here.
    // Detection does not take it: an answer for this map is not an answer for
    // the map whose human key is planted too, and one rule covers both.
    expect(obj.get("_id")).toBeInstanceOf(Y.Text);
    expect(obj.get("object_id")).toBe("a-pot");
    expect(detection()).toContain("objects[0]._id");
  });

  it("writes nothing to the document at all", async () => {
    const { internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "objects", { _id: ["9"], object_id: new Y.Text("victim-pot") });
        push(doc, "pages", { _id: {}, slug: ["about"] });
      }),
      objects: [{ id: 9, object_id: "victim-pot" }],
      pages: [{ id: 3, slug: "about" }],
    });

    await internals.ensureDocLoaded();

    // Every planted value is the shape it was planted as. The load's other
    // passes — the blob-gap seed and the order-key backfill — do write, so the
    // scan is re-run on the settled document and the state vector taken across
    // that run alone. A write by the scan would add items under the DO's own
    // client id and move the vector; an unchanged vector is the scan writing
    // nothing, over the whole document rather than only where it looked.
    const obj = internals.ydoc.getArray<Y.Map<unknown>>("objects").get(0);
    const page = internals.ydoc.getArray<Y.Map<unknown>>("pages").get(0);
    expect(obj.get("_id")).toEqual(["9"]);
    expect(obj.get("object_id")).toBeInstanceOf(Y.Text);
    expect(page.get("_id")).toEqual({});
    expect(page.get("slug")).toEqual(["about"]);

    const before = Y.encodeStateVector(internals.ydoc);
    internals.reportIdentityDomainPlants();
    expect(Y.encodeStateVector(internals.ydoc)).toEqual(before);
  });

  it("consults no authority, so an outage cannot change the outcome", async () => {
    const { db, internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "pages", { _id: new Y.Text("3"), slug: ["about"] });
      }),
      entityReadError: new Error("D1 unavailable"),
    });

    await internals.ensureDocLoaded();

    // The scan reads no entity keys whether D1 is up or down, so there is no
    // read whose failure could defer it and no state to carry out of the load.
    // This is why findings 2 and 4 have no site here: there is no recovery to
    // resolve a forged rename key through, and no repaired value to broadcast.
    expect(db.queries.some((q) => /SELECT id, slug FROM project_pages/.test(q))).toBe(false);
    expect(db.queries.some((q) => /SELECT id, object_id/.test(q))).toBe(false);
    expect(internals.docLoaded).toBe(true);
    expect(errors.join("\n")).not.toContain("[snapshot][halted]");
  });

  it.each([NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "detects a numeric _id of %s that is not a row id",
    async (planted) => {
      const { internals } = makeDo({
        yjsState: blobWith((doc) => {
          push(doc, "objects", { _id: planted, object_id: "a-pot" });
        }),
        objects: [{ id: 5, object_id: "a-pot" }],
      });

      await internals.ensureDocLoaded();

      const obj = internals.ydoc.getArray<Y.Map<unknown>>("objects").get(0);
      expect(Object.is(obj.get("_id"), planted)).toBe(true);
      expect(detection()).toContain("objects[0]._id");
    },
  );

  it("leaves a healthy document silent and untouched", async () => {
    const { db, internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "objects", { _id: 1, _temp_id: "t-1", object_id: "a-pot" });
        push(doc, "pages", { _id: null, _temp_id: "t-2", slug: "about" });
      }),
      objects: [{ id: 1, object_id: "a-pot" }],
    });

    await internals.ensureDocLoaded();

    expect(detection()).toBe("");
    expect(db.queries.some((q) => /SELECT id, slug FROM project_pages/.test(q))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The report: arm, root and position, and never the value
// ---------------------------------------------------------------------------

describe("the detection log names the position and never the value", () => {
  it("carries arm, roots and every position in one line", async () => {
    const { internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "objects", { _id: ["9"], object_id: "a-pot" });
        push(doc, "pages", { _id: 3, slug: ["about"] });
        const story = push(doc, "stories", { _id: 1, story_id: "a-story" });
        const steps = new Y.Array<Y.Map<unknown>>();
        const step = new Y.Map<unknown>();
        step.set("_id", ["9"]);
        const layers = new Y.Array<Y.Map<unknown>>();
        const layer = new Y.Map<unknown>();
        layer.set("_temp_id", []);
        layers.push([layer]);
        step.set("layers", layers);
        steps.push([step]);
        story.set("steps", steps);
      }),
    });

    await internals.ensureDocLoaded();

    const line = detection();
    expect(line).toContain("arm=identity-domain");
    expect(line).toContain("roots=");
    // Nested entries are reached through their parent, so their position
    // carries the whole path: which story, which step, which layer.
    for (const position of [
      "objects[0]._id",
      "pages[0].slug",
      "stories[0].steps[0]._id",
      "stories[0].steps[0].layers[0]._temp_id",
    ]) {
      expect(line, position).toContain(position);
    }
    for (const root of ["objects", "pages", "stories"]) {
      expect(line).toMatch(new RegExp(`roots=[^ ]*\\b${root}\\b`));
    }
  });

  it("does not render the value, whatever the value renders to", async () => {
    const secret = "victim-pot";
    const { internals } = makeDo({
      yjsState: blobWith((doc) => {
        // `String(["victim-pot"])` is "victim-pot" and `String(Y.Text)` is its
        // content. Naming either in the report would be the same read that
        // hands a forged map a colleague's key.
        push(doc, "objects", { _id: 1, object_id: [secret] });
        push(doc, "pages", { _id: 2, slug: new Y.Text(secret) });
      }),
    });

    await internals.ensureDocLoaded();

    const line = detection();
    expect(line).toContain("objects[0].object_id");
    expect(line).toContain("pages[0].slug");
    expect(line).not.toContain(secret);
  });

  it("loads a document whose planted value cannot be rendered at all", async () => {
    const { internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "objects", { _id: 1, object_id: { toString: null } });
      }),
      objects: [{ id: 1, object_id: "a-pot" }],
    });

    await internals.ensureDocLoaded();

    // `{toString: null}` survives the Yjs round trip with its own `toString`
    // shadowing the prototype's, so `String(value)` finds nothing callable and
    // throws. Any load-time step that rendered the value would throw here,
    // before `docLoaded` is set — and the document would refuse to open, for
    // everyone, on every later attempt. Detection reads no value, so it does
    // not: this test IS the finding, standing as a regression pin.
    const obj = internals.ydoc.getArray<Y.Map<unknown>>("objects").get(0);
    expect(() => String(obj.get("object_id"))).toThrow(TypeError);
    expect(internals.docLoaded).toBe(true);
    expect(detection()).toContain("objects[0].object_id");
  });
});

// ---------------------------------------------------------------------------
// 3. No halt: the document is admitted and keeps persisting
// ---------------------------------------------------------------------------

describe("a planted document is admitted on ordinary terms", () => {
  it("opens the document and snapshots it", async () => {
    const { db, doInstance, internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "pages", { _id: new Y.Text("3"), slug: "about" });
      }),
      pages: [{ id: 3, slug: "about" }],
    });

    expect(internals.docLoaded).toBe(false);
    await internals.ensureDocLoaded();
    expect(internals.docLoaded).toBe(true);

    const before = db.queries.length;
    await doInstance.snapshotToD1();

    // Nothing withholds the snapshot, so there is no window in which editors
    // are admitted and their edits are accepted but never persisted.
    expect(d1Writes(db.queries.slice(before)).length).toBeGreaterThan(0);
    expect(await internals.flushSnapshotNow()).toBe(true);
  });

  it("does not carry a deferral out of a load that met a failing read", async () => {
    const { db, doInstance, internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "pages", { _id: new Y.Text("3"), slug: "about" });
      }),
      pages: [{ id: 3, slug: "about" }],
      entityReadError: new Error("D1 unavailable"),
    });

    await internals.ensureDocLoaded();
    db.state.entityReadError = null;
    await doInstance.snapshotToD1();

    // The load never asked D1 anything, so the outage left no state behind and
    // the first snapshot after it is an ordinary one.
    expect(d1Writes(db.queries).length).toBeGreaterThan(0);
    expect(await internals.flushSnapshotNow()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. What the standing plant does downstream — recorded, not hidden
// ---------------------------------------------------------------------------

describe("the downstream state a detected plant is left in", () => {
  it("lets the snapshot settle an out-of-domain _id from the human key", async () => {
    const { doInstance, internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "pages", { _id: new Y.Text("3"), slug: "about" });
      }),
      pages: [{ id: 3, slug: "about" }],
    });

    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    // The adopt-or-reinsert branch matches on the human key, which is in
    // domain here, so the entity is reunited with row 3 by the pipeline that
    // already owns that question — no load-time guess required.
    const page = internals.ydoc.getArray<Y.Map<unknown>>("pages").get(0);
    expect(page.get("_id")).toBe(3);
    expect(page.get("slug")).toBe("about");
  });

  it("re-keys a forged human key rather than granting it the row", async () => {
    const { doInstance, internals } = makeDo({
      yjsState: blobWith((doc) => {
        // `String(["real-pot"])` is "real-pot", the key D1 says row 7 owns.
        push(doc, "objects", { _id: null, object_id: ["real-pot"] });
        push(doc, "objects", { _id: 7, object_id: "real-pot" });
      }),
      objects: [{ id: 7, object_id: "real-pot" }],
    });

    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    const arr = internals.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(2);
    // D1 already says which row owns "real-pot", and `deduplicateYArray` gives
    // the key to that row's entry wherever it sits. The forged map keeps its
    // content under a fresh key instead of taking the victim's.
    expect(arr.get(1).get("_id")).toBe(7);
    expect(arr.get(1).get("object_id")).toBe("real-pot");
    expect(arr.get(0).get("object_id")).not.toBe("real-pot");
  });

  it("still loses the legitimate map to an exact-_id duplicate", async () => {
    const { doInstance, internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "objects", { _id: 7, object_id: ["real-pot"] });
        push(doc, "objects", { _id: 7, object_id: "real-pot" });
      }),
      objects: [{ id: 7, object_id: "real-pot" }],
    });

    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    // Both entries render to "real-pot" AND both claim row 7, so the pair is
    // one persisted row claimed twice and the exact-`_id` rule collapses it —
    // first entry wins, which here is the planted one. This is the accepted
    // cost of detecting rather than guessing, and it is pinned rather than
    // left to be discovered: it is what the log exists to make answerable.
    const arr = internals.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(arr.length).toBe(1);
    expect(Array.isArray(arr.get(0).get("object_id"))).toBe(true);
  });

  it("keeps snapshotting on a human key nothing can render", async () => {
    const { db, doInstance, internals } = makeDo({
      yjsState: blobWith((doc) => {
        push(doc, "objects", { _id: 1, object_id: { toString: null } });
      }),
      objects: [{ id: 1, object_id: "a-pot" }],
    });

    await internals.ensureDocLoaded();
    const before = db.queries.length;

    // Reconciliation reads the human key by rendering it, and it must — it is
    // reconciling against the same rendered key D1 stores. `renderedKey` makes
    // that reading total: the one value class nothing can render is read as
    // unkeyed rather than throwing, because a throw here rejects every
    // snapshot the project will ever take while the document goes on accepting
    // edits. The plant is left standing, as this pass requires; what it may
    // not do is stop the project persisting.
    await expect(doInstance.snapshotToD1()).resolves.toBeUndefined();
    expect(d1Writes(db.queries.slice(before)).length).toBeGreaterThan(0);
    const obj = internals.ydoc.getArray<Y.Map<unknown>>("objects").get(0);
    expect(obj.get("object_id")).toEqual({ toString: null });
  });
});
