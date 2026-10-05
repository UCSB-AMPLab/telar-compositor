/**
 * A shared value sitting at one of the six convenor-only config keys has its
 * own mutation surface, and editing it never touches the config root — so the
 * assignment guard, which keys off a change to the root, does not fire. Blocking
 * new plants does not remove old ones: a document carrying one from before the
 * guard existed restores it from its `yjs_state` blob on every load.
 *
 * The substrate half of the rule is DETECTION, not repair, on the same terms as
 * `reportIdentityDomainPlants`. A repair has to choose a replacement, and the
 * only authority for one is D1, whose read can fail; a load that halts on a
 * failed read admits editors and withholds their edits, and a hibernation wake
 * inside that halt rebuilds from the pre-halt blob and loses them. So the load
 * scans, names what it finds by KEY, and changes nothing; the snapshot holds the
 * column by leaving it out of the UPDATE, which needs no read at all.
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
import { CONVENOR_ONLY_CONFIG_FIELDS } from "~/lib/config-fields";
import { checkD1Bind } from "./helpers/d1-memory";

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
  google_sheets_enabled: 1,
  google_sheets_published_url: "https://docs.example.org/real/pubhtml",
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

interface Query {
  sql: string;
  binds: unknown[];
}

interface DbSeed {
  yjsState?: Uint8Array | null;
  /** When set, every `project_config` SELECT rejects with this error. */
  configReadError?: Error;
}

function makeDb(seed: DbSeed) {
  const queries: Query[] = [];
  const state = { configReadError: seed.configReadError ?? null as Error | null };

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return bound; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); bound = args; return stmt; },
      async run() {
        queries.push({ sql, binds: bound });
        return { meta: { last_row_id: 1, changes: 1 }, success: true as const };
      },
      async all<T = unknown>() {
        queries.push({ sql, binds: bound });
        return { results: [] as T[], success: true as const };
      },
      async first<T = unknown>() {
        queries.push({ sql, binds: bound });
        if (/^SELECT yjs_state/.test(sql)) {
          // A seeded blob is tagged at the current generation and claimable;
          // an absent one is the cold build.
          return (seed.yjsState
            ? { yjs_state: seed.yjsState, yjs_generation: 0, yjs_seq: 0, yjs_write: 0 }
            : { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 }) as T;
        }
        if (/FROM project_config/.test(sql)) {
          if (state.configReadError) throw state.configReadError;
          return CONFIG_ROW as T;
        }
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
      async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
        for (const s of statements) queries.push({ sql: s.sql, binds: s.boundArgs });
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
  reportConvenorOnlyConfigPlants: () => void;
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

/** A `yjs_state` blob holding a healthy config plus whatever `plant` writes. */
function blobWith(plant: (config: Y.Map<unknown>, doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  const config = doc.getMap<unknown>("config");
  doc.transact(() => {
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
    config.set("google_sheets_enabled", true);
    config.set("google_sheets_published_url", "https://docs.example.org/real/pubhtml");
    config.set("collection_mode", false);
    config.set("skip_stories", false);
    config.set("featured_count", 4);
    config.set("landing", new Y.Map<unknown>());
    config.set("navigation", new Y.Array<unknown>());
    plant(config, doc);
  });
  return Y.encodeStateAsUpdate(doc);
}

function configOf(internals: Internals): Y.Map<unknown> {
  return internals.ydoc.getMap<unknown>("config");
}

let errors: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  });
});

/** The one `[config][detected]` line, or "" when the scan said nothing. */
function detection(): string {
  const lines = errors.filter((e) => e.includes("[config][detected]"));
  expect(lines.length, "the scan must emit at most one line").toBeLessThanOrEqual(1);
  return lines[0] ?? "";
}

/** Every `project_config` SELECT the DO issued. */
function configReads(queries: Query[]): Query[] {
  return queries.filter((q) => /^SELECT/.test(q.sql) && /FROM project_config/.test(q.sql));
}

// ---------------------------------------------------------------------------
// 1. The value is left exactly as it stands
// ---------------------------------------------------------------------------

describe("a load-time convenor-only config plant is detected and left alone", () => {
  it("leaves each of the four shared kinds standing at its key", async () => {
    const { internals } = makeDo({
      yjsState: blobWith((config) => {
        config.set("url", new Y.Text("https://evil.example.org"));
        config.set("story_key", new Y.Map<unknown>());
        config.set("baseurl", new Y.XmlText("/evil"));
        config.set("google_sheets_published_url", new Y.Doc());
      }),
    });

    await internals.ensureDocLoaded();

    const config = configOf(internals);
    expect(config.get("url")).toBeInstanceOf(Y.Text);
    expect(config.get("story_key")).toBeInstanceOf(Y.Map);
    expect(config.get("baseurl")).toBeInstanceOf(Y.XmlText);
    expect(config.get("google_sheets_published_url")).toBeInstanceOf(Y.Doc);
  });

  it("writes nothing to the document at all", async () => {
    const blob = blobWith((config) => {
      config.set("url", new Y.Text("https://evil.example.org"));
      config.set("include_demo_content", new Y.Array<unknown>());
    });
    const { internals } = makeDo({ yjsState: blob });

    await internals.ensureDocLoaded();

    // A write by the DO would put items under its own client id, which the
    // restored blob's state vector does not carry. The scan is re-run on the
    // settled document so the vector is taken across that run alone.
    const before = Y.encodeStateVector(internals.ydoc);
    internals.reportConvenorOnlyConfigPlants();
    expect(Y.encodeStateVector(internals.ydoc)).toEqual(before);
    expect(Y.encodeStateVector(internals.ydoc)).toEqual(Y.encodeStateVectorFromUpdate(blob));
  });

  it("consults no authority, so an outage cannot change the outcome", async () => {
    const { db, internals } = makeDo({
      yjsState: blobWith((config) => {
        config.set("url", new Y.Text("https://evil.example.org"));
      }),
    });

    await internals.ensureDocLoaded();

    // The load's own reads are the blob and the blob-gap seed's single
    // `project_config` row. The scan adds none, so there is no read whose
    // failure could defer it and no state to carry out of the load.
    expect(configReads(db.queries)).toHaveLength(1);
    expect(errors.join("\n")).not.toContain("[snapshot][halted]");
  });

  it("does not report a plain object, which is not a shared value", async () => {
    const { internals } = makeDo({
      yjsState: blobWith((config) => {
        config.set("url", JSON.parse("{}"));
        config.set("story_key", JSON.parse("[]"));
      }),
    });

    await internals.ensureDocLoaded();

    // A plain value at one of the six is out of the column's domain and the
    // snapshot answers for it; the load detector's subject is the value class
    // that carries its own mutation surface past the assignment guard.
    expect(detection()).toBe("");
  });

  it("leaves a healthy document silent and costs it nothing", async () => {
    const big = blobWith((config) => {
      const nav = new Y.Array<unknown>();
      nav.push(Array.from({ length: 400 }, (_, i) => ({ type: "page", slug: `page-${i}` })));
      config.set("navigation", nav);
      for (let i = 0; i < 200; i++) config.set(`extra_${i}`, `value ${i}`);
    });
    const { db, internals } = makeDo({ yjsState: big });

    await internals.ensureDocLoaded();

    // The scan is over the six named keys, not over the config map, so nothing
    // about it grows with the document.
    expect(detection()).toBe("");
    expect(Y.encodeStateVector(internals.ydoc)).toEqual(Y.encodeStateVectorFromUpdate(big));
    expect(configReads(db.queries)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The report: keys and exact type names, never a value
// ---------------------------------------------------------------------------

describe("the detection log names the key and the type and never the value", () => {
  it("names each kind exactly, with the XML type and the subdocument as shared-type", async () => {
    const { internals } = makeDo({
      yjsState: blobWith((config) => {
        config.set("url", new Y.Text("https://evil.example.org"));
        config.set("story_key", new Y.Map<unknown>());
        config.set("baseurl", new Y.XmlText("/evil"));
        config.set("google_sheets_published_url", new Y.Doc());
      }),
    });

    await internals.ensureDocLoaded();

    const line = detection();
    expect(line).toContain("arm=value-domain");
    expect(line).toContain("root=config");
    // `Y.XmlText extends Y.Text` and a subdocument is neither, so an
    // `instanceof` allow-list would report the first as a kind the mirror
    // models and say nothing useful about the second.
    expect(line).toContain("config.url (a Y.Text)");
    expect(line).toContain("config.story_key (a Y.Map)");
    expect(line).toContain("config.baseurl (a shared-type)");
    expect(line).toContain("config.google_sheets_published_url (a shared-type)");
  });

  it("names a Y.Array at a flag key", async () => {
    const { internals } = makeDo({
      yjsState: blobWith((config) => {
        config.set("include_demo_content", new Y.Array<unknown>());
      }),
    });

    await internals.ensureDocLoaded();

    expect(detection()).toContain("config.include_demo_content (a Y.Array)");
  });

  it("does not render the value, whatever the value renders to", async () => {
    const secret = "https://evil.example.org";
    const { internals } = makeDo({
      yjsState: blobWith((config) => {
        config.set("url", new Y.Text(secret));
      }),
    });

    await internals.ensureDocLoaded();

    const line = detection();
    expect(line).toContain("config.url");
    expect(line).not.toContain(secret);
  });

  it("reaches every one of the six", async () => {
    for (const key of CONVENOR_ONLY_CONFIG_FIELDS) {
      errors = [];
      const { internals } = makeDo({
        yjsState: blobWith((config) => { config.set(key, new Y.Text("planted")); }),
      });
      await internals.ensureDocLoaded();
      expect(detection(), key).toContain(`config.${key} (a Y.Text)`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. No halt: the document is admitted and keeps persisting
// ---------------------------------------------------------------------------

describe("a planted config document is admitted on ordinary terms", () => {
  it("opens the document and snapshots it", async () => {
    const { db, doInstance, internals } = makeDo({
      yjsState: blobWith((config) => {
        config.set("url", new Y.Text("https://evil.example.org"));
      }),
    });

    expect(internals.docLoaded).toBe(false);
    await internals.ensureDocLoaded();
    expect(internals.docLoaded).toBe(true);

    await doInstance.snapshotToD1();

    // Nothing withholds the snapshot, so there is no window in which editors
    // are admitted and their edits accepted but never persisted.
    expect(db.queries.some((q) => /^UPDATE projects SET yjs_state/.test(q.sql))).toBe(true);
    expect(await internals.flushSnapshotNow()).toBe(true);
  });

  it("does not carry a deferral out of a load that met a failing config read", async () => {
    const { doInstance, db, internals } = makeDo({
      yjsState: blobWith((config) => {
        config.set("url", new Y.Text("https://evil.example.org"));
      }),
      configReadError: new Error("D1_ERROR: network"),
    });

    // The blob-gap seed's own read is the one that fails here, and it
    // propagates: `docLoaded` stays false and no socket is admitted.
    await expect(internals.ensureDocLoaded()).rejects.toThrow("D1_ERROR: network");
    expect(internals.docLoaded).toBe(false);

    db.state.configReadError = null;
    await internals.ensureDocLoaded();
    await doInstance.snapshotToD1();

    // The scan asked D1 nothing, so the outage left no state behind and the
    // first snapshot after it is an ordinary one.
    expect(db.queries.some((q) => /^UPDATE projects SET yjs_state/.test(q.sql))).toBe(true);
    expect(await internals.flushSnapshotNow()).toBe(true);
  });
});
