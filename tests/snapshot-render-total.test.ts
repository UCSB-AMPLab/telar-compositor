/**
 * Every render the snapshot performs on a document value is TOTAL — a value
 * nothing can convert to a primitive is read as ABSENT rather than throwing.
 *
 * `String` and `Number` are partial functions. A plain object whose `toString`
 * is null converts to no primitive at all and throws `TypeError`, and Yjs
 * stores plain JSON as a map value verbatim, so such a value survives the
 * `yjs_state` round trip and any collaborator can put one at any key. Rendered
 * raw anywhere on the snapshot path, one such value stops the project
 * persisting for good: `doSnapshot` throws before it writes the blob, every
 * later snapshot throws in the same place, and the document stays open and
 * editable throughout — edits accepted, nothing persisted, nothing on screen
 * to say so.
 *
 * `renderedKey` closed that for the four human keys. This suite covers the
 * rest of the surface, which is most of it: the prose columns bound through
 * `yTextToString`, the plain config and entity columns, and the activity
 * resolver — which scans EVERY map in a collection, so a plant standing
 * anywhere in the project throws while resolving an unrelated entity's row.
 *
 * The reading is `whenAbsent`: an unrenderable value is read exactly as a
 * missing one, so `lang` reads `"en"`, a step's `kind` reads `"media"`, an
 * object's `origin` reads `"iiif"`, and everything else reads `""`. That is
 * the row the project would have written before anyone put the value there,
 * which is the only reading that invents nothing.
 *
 * The last section covers the residual: two pages whose slugs both render to
 * the unkeyed sentinel would issue two `UPDATE … SET slug = ''` against a
 * UNIQUE column in one atomic batch, which aborts every entity's writes in the
 * snapshot. Reachable with two literal empty slugs before any of this, and the
 * route the total render would otherwise map the attack into.
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
import {
  makeAfterTransactionHandler,
  readProseField,
  renderedValue,
  resolveActivityEntity,
  yTextToString,
} from "../workers/collaboration-helpers";
import { updateAssignment, updateSetColumns } from "./helpers/sql-set-list";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;

/** A value that converts to no primitive at all: `String(...)` throws on it. */
function unrenderable(): Record<string, unknown> {
  return { toString: null };
}

/**
 * Put a `Y.XmlText` whose OWN render throws at `key`, and hand it back.
 *
 * `Y.XmlText` extends `Y.Text`, so `instanceof Y.Text` admits it, and it is the
 * subclass whose render walks an embed: `Y.Text`'s skips one, while
 * `Y.XmlText`'s converts every one of them to a string, so an embed that
 * converts to no primitive raises from the value's own code. It survives the
 * `yjs_state` round trip like any other embed.
 *
 * The characters are what the document is read as saying — the embed
 * contributes none — so `"una"` is the answer every path here expects.
 *
 * The map must already be in the document: an embed is a document write.
 */
function plantUnrenderableText(map: Y.Map<unknown>, key: string): Y.XmlText {
  const text = new Y.XmlText();
  map.set(key, text);
  text.insert(0, "una");
  text.insertEmbed(3, unrenderable());
  return text;
}

// ---------------------------------------------------------------------------
// D1 fake
// ---------------------------------------------------------------------------

interface Write {
  sql: string;
  binds: unknown[];
}

/** The value an UPDATE bound to `column`, read by the column's place in SET. */
function boundTo(write: Write, column: string): unknown {
  const cols = updateSetColumns(write.sql);
  if (cols.length === 0) throw new Error(`not an UPDATE: ${write.sql}`);
  const at = cols.indexOf(column);
  if (at < 0) throw new Error(`no column "${column}" in ${write.sql}`);
  return write.binds[at];
}

/** The value an INSERT bound to `column`, read by the column's place. */
function insertedTo(write: Write, column: string): unknown {
  const m = write.sql.match(/INSERT INTO \w+ \(([^)]+)\)/);
  if (!m) throw new Error(`not an INSERT: ${write.sql}`);
  const cols = m[1].split(",").map((c) => c.trim().replace(/"/g, ""));
  const at = cols.indexOf(column);
  if (at < 0) throw new Error(`no column "${column}" in ${write.sql}`);
  return write.binds[at];
}

const CONFIG_ROW: Record<string, unknown> = {
  id: 1,
  project_id: PROJECT_ID,
  title: "Real site",
  lang: "en",
  baseurl: "/real",
  url: "https://real.example.org",
  theme: "default",
  logo: "",
  google_sheets_enabled: 0,
  google_sheets_published_url: "",
  story_key: "real-story-key",
  include_demo_content: 0,
};

interface DbSeed {
  yjsState: Uint8Array;
  objects?: Array<{ id: number; object_id: string }>;
  pages?: Array<{ id: number; slug: string }>;
  glossary?: Array<{ id: number; term_id: string }>;
  stories?: Array<{ id: number; story_id: string }>;
  stepIds?: number[];
  layerIds?: number[];
  members?: Array<{ user_id: number; contributions: string | null }>;
  /** Enforce `project_pages(project_id, slug)` UNIQUE across the batch. */
  enforcePageSlugUnique?: boolean;
}

function makeDb(seed: DbSeed) {
  const writes: Write[] = [];
  // Live slug per page row, so the UNIQUE index has something to be about.
  const pageSlugs = new Map<number, string>(
    (seed.pages ?? []).map((p) => [p.id, p.slug]),
  );

  /**
   * Apply one page UPDATE to the modelled index, or throw as D1 does.
   *
   * An empty bind leaves the slug a row has unless that is a parking key
   * (`UNPARKED_BLANK_SLUG_SQL`), which no seeded row holds, so
   * this has to read the SQL rather than the bind alone — a model that always
   * wrote the bind would report the guarded statement as colliding and a model
   * that never wrote it would report a real rename as a no-op.
   */
  function applyPageWrite(w: Write): void {
    if (!seed.enforcePageSlugUnique) return;
    if (!/^UPDATE project_pages SET/.test(w.sql)) return;
    const id = w.binds[w.binds.length - 1] as number;
    const bound = boundTo(w, "slug") as string;
    const guarded = /slug = CASE WHEN slug GLOB '~new-/.test(w.sql);
    const next = guarded && bound === "" ? pageSlugs.get(id) ?? "" : bound;
    for (const [otherId, otherSlug] of pageSlugs) {
      if (otherId !== id && otherSlug === next) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: project_pages.project_id, project_pages.slug",
        );
      }
    }
    pageSlugs.set(id, next);
  }

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
        if (/SELECT id FROM layers WHERE step_id/.test(sql)) {
          return { results: (seed.layerIds ?? []).map((id) => ({ id })) as T[], success: true as const };
        }
        if (/FROM project_members/.test(sql)) {
          return { results: (seed.members ?? []) as T[], success: true as const };
        }
        return { results: [] as T[], success: true as const };
      },
      async first<T = unknown>() {
        if (/^SELECT yjs_state/.test(sql)) {
          return { yjs_state: seed.yjsState, yjs_generation: 0, yjs_seq: 0, yjs_write: 0 } as T;
        }
        if (/FROM project_config/.test(sql)) return CONFIG_ROW as T;
        if (/FROM project_landing/.test(sql)) return { id: 1 } as T;
        return null;
      },
    };
    return stmt;
  }

  return {
    writes,
    pageSlugs,
    DB: {
      prepare,
      async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
        // D1 runs a batch sequentially and transactionally: the first refusal
        // discards every write in it, which is exactly the damage under test.
        const staged: Write[] = [];
        for (const s of statements) {
          const w = { sql: s.sql, binds: s.boundArgs };
          applyPageWrite(w);
          staged.push(w);
        }
        writes.push(...staged);
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
  userFieldSets: Map<number, Set<string>>;
  wordBaseline: Map<string, number>;
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

// ---------------------------------------------------------------------------
// A whole project, so a plant is one field of an otherwise healthy document
// ---------------------------------------------------------------------------

const SEEDED_ROWS: DbSeed = {
  yjsState: new Uint8Array(),
  stories: [{ id: 1, story_id: "la-vasija" }],
  stepIds: [5],
  layerIds: [8],
  objects: [{ id: 2, object_id: "el-cantaro" }],
  glossary: [{ id: 3, term_id: "chicha" }],
  pages: [{ id: 4, slug: "creditos" }],
};

/** A `yjs_state` blob holding one entity of every kind, plus `plant`'s edit. */
function blobWith(plant: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const config = doc.getMap<unknown>("config");
    config.set("title", new Y.Text("Real site"));
    config.set("description", new Y.Text("A real description"));
    config.set("author", new Y.Text("Una autora"));
    config.set("email", new Y.Text("autora@example.org"));
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

    const landing = new Y.Map<unknown>();
    landing.set("stories_heading", new Y.Text("Historias"));
    landing.set("stories_intro", new Y.Text("Un texto"));
    landing.set("objects_heading", new Y.Text("Objetos"));
    landing.set("objects_intro", new Y.Text("Otro texto"));
    landing.set("welcome_body", new Y.Text("Bienvenida"));
    config.set("landing", landing);

    const layer = new Y.Map<unknown>();
    layer.set("_id", 8);
    layer.set("title", new Y.Text("Una capa"));
    layer.set("button_label", new Y.Text("Ver"));
    layer.set("content", new Y.Text("El contenido"));
    const layers = new Y.Array<Y.Map<unknown>>();
    layers.push([layer]);

    const step = new Y.Map<unknown>();
    step.set("_id", 5);
    step.set("kind", "media");
    step.set("object_id", "el-cantaro");
    step.set("page", "");
    step.set("clip_start", "");
    step.set("clip_end", "");
    step.set("loop", "");
    step.set("question", new Y.Text("¿Qué se ve?"));
    step.set("answer", new Y.Text("Una vasija"));
    step.set("alt_text", new Y.Text("Vasija de barro"));
    step.set("layers", layers);
    const steps = new Y.Array<Y.Map<unknown>>();
    steps.push([step]);

    push(doc, "stories", {
      _id: 1, story_id: "la-vasija", title: new Y.Text("La vasija"),
      subtitle: new Y.Text("Un subtítulo"), byline: new Y.Text("Una autora"), steps,
    });
    push(doc, "objects", {
      _id: 2, object_id: "el-cantaro", _validation_state: "valid",
      title: new Y.Text("El cántaro"), creator: new Y.Text("Anónimo"),
      description: new Y.Text("Una descripción"), alt_text: new Y.Text("Un cántaro"),
      period: new Y.Text("Colonial"), year: new Y.Text("1650"),
      object_type: new Y.Text("Cerámica"), subjects: new Y.Text("Alfarería"),
      source: new Y.Text("Museo"), credit: new Y.Text("Museo"),
      source_url: "", thumbnail: "", dimensions: "", extra_columns: "",
    });
    push(doc, "glossary", {
      _id: 3, term_id: "chicha", title: new Y.Text("Chicha"),
      definition: new Y.Text("Una bebida"),
    });
    push(doc, "pages", { _id: 4, slug: "creditos", title: new Y.Text("Créditos"), body: new Y.Text("El cuerpo") });

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

/** The first Y.Map in a root array. */
function first(doc: Y.Doc, root: string): Y.Map<unknown> {
  return doc.getArray<Y.Map<unknown>>(root).get(0);
}

/** The first step of the first story. */
function firstStep(doc: Y.Doc): Y.Map<unknown> {
  return (first(doc, "stories").get("steps") as Y.Array<Y.Map<unknown>>).get(0);
}

/** The write against `table` whose last bound value is `id`, or undefined. */
function writeFor(writes: Write[], pattern: RegExp, id: number): Write | undefined {
  return writes.find((w) => pattern.test(w.sql) && w.binds[w.binds.length - 1] === id);
}

/** Snapshot a document carrying `plant` and hand back what reached D1. */
async function snapshotWith(plant: (doc: Y.Doc) => void, extra: Partial<DbSeed> = {}) {
  const { db, doInstance, internals } = makeDoFromBlob({
    ...SEEDED_ROWS, ...extra, yjsState: blobWith(plant),
  });
  await internals.ensureDocLoaded();
  await doInstance.snapshotToD1();
  return { db, doInstance, internals };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// 1. Prose columns — the `yTextToString` surface
// ---------------------------------------------------------------------------

/**
 * One case per prose column family. Each seeds the plant at one field of an
 * otherwise healthy project and asserts three things: the snapshot ran to
 * completion (the blob reached D1), the column HELD — it bound null against a
 * `COALESCE(?, col)` assignment, so D1 keeps the value it has — and the
 * document still carries the planted value, because detection is not repair.
 */
const PROSE_CASES: Array<{
  name: string;
  plant: (doc: Y.Doc) => void;
  update: RegExp;
  rowId: number;
  column: string;
}> = [
  {
    name: "landing.welcome_body",
    plant: (doc) => {
      (doc.getMap<unknown>("config").get("landing") as Y.Map<unknown>)
        .set("welcome_body", unrenderable());
    },
    update: /UPDATE project_landing SET/, rowId: PROJECT_ID, column: "welcome_body",
  },
  {
    name: "stories.title",
    plant: (doc) => { first(doc, "stories").set("title", unrenderable()); },
    update: /UPDATE stories SET/, rowId: 1, column: "title",
  },
  {
    name: "stories.byline",
    plant: (doc) => { first(doc, "stories").set("byline", unrenderable()); },
    update: /UPDATE stories SET/, rowId: 1, column: "byline",
  },
  {
    name: "steps.question",
    plant: (doc) => { firstStep(doc).set("question", unrenderable()); },
    update: /UPDATE steps SET/, rowId: 5, column: "question",
  },
  {
    name: "steps.alt_text",
    plant: (doc) => { firstStep(doc).set("alt_text", unrenderable()); },
    update: /UPDATE steps SET/, rowId: 5, column: "alt_text",
  },
  {
    name: "layers.content",
    plant: (doc) => {
      const layers = firstStep(doc).get("layers") as Y.Array<Y.Map<unknown>>;
      layers.get(0).set("content", unrenderable());
    },
    update: /UPDATE layers SET/, rowId: 8, column: "content",
  },
  {
    name: "objects.description",
    plant: (doc) => { first(doc, "objects").set("description", unrenderable()); },
    update: /UPDATE objects SET/, rowId: 2, column: "description",
  },
  {
    name: "objects.creator",
    plant: (doc) => { first(doc, "objects").set("creator", unrenderable()); },
    update: /UPDATE objects SET/, rowId: 2, column: "creator",
  },
  {
    name: "objects.year",
    plant: (doc) => { first(doc, "objects").set("year", unrenderable()); },
    update: /UPDATE objects SET/, rowId: 2, column: "year",
  },
  {
    name: "glossary_terms.definition",
    plant: (doc) => { first(doc, "glossary").set("definition", unrenderable()); },
    update: /UPDATE glossary_terms SET/, rowId: 3, column: "definition",
  },
  {
    name: "project_pages.body",
    plant: (doc) => { first(doc, "pages").set("body", unrenderable()); },
    update: /UPDATE project_pages SET/, rowId: 4, column: "body",
  },
];

describe("a prose value nothing can render leaves the project persisting", () => {
  for (const c of PROSE_CASES) {
    it(`snapshots a document carrying one at ${c.name}`, async () => {
      const { db } = await snapshotWith(c.plant);

      // The blob reached D1 — the whole point: the snapshot ran to completion
      // rather than being refused on a value it could not read.
      expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
      const write = writeFor(db.writes, c.update, c.rowId);
      expect(write).toBeDefined();
      expect(boundTo(write!, c.column)).toBeNull();
      // The null only holds because the assignment coalesces onto the column
      // itself; bound against a plain `col = ?` it would blank the column.
      expect(updateAssignment(write!.sql, c.column)).toBe(`COALESCE(?, ${c.column})`);
    });
  }

  it("leaves the planted value in the document and its neighbours untouched", async () => {
    const { db, internals } = await snapshotWith((doc) => {
      first(doc, "objects").set("description", unrenderable());
    });

    // Detection does not repair, and an unreadable value is not licence to
    // invent a readable one.
    expect(first(internals.ydoc, "objects").get("description")).toEqual(unrenderable());
    // Every other column of the same row still carries its own value.
    const write = writeFor(db.writes, /UPDATE objects SET/, 2)!;
    expect(boundTo(write, "title")).toBe("El cántaro");
    expect(boundTo(write, "creator")).toBe("Anónimo");
    expect(db.writes.some((w) => /DELETE FROM objects/.test(w.sql))).toBe(false);
  });

  it("still renders a Y.Text to its text", async () => {
    // The totality must not cost the render its actual job. A Y.Text at a
    // prose key is the ordinary case, and it renders to its content.
    const { db } = await snapshotWith(() => { /* healthy document */ });
    const write = writeFor(db.writes, /UPDATE stories SET/, 1)!;
    expect(boundTo(write, "title")).toBe("La vasija");
    expect(boundTo(write, "subtitle")).toBe("Un subtítulo");
  });
});

// ---------------------------------------------------------------------------
// 2. Plain columns — config, step and object fields with no Y.Text
// ---------------------------------------------------------------------------

/**
 * Each of these binds `whenAbsent`, not `""`: an unrenderable value is read as
 * a missing one, so the column takes the value this project would have written
 * had nobody set the key at all.
 */
const PLAIN_CASES: Array<{
  name: string;
  plant: (doc: Y.Doc) => void;
  update: RegExp;
  rowId: number;
  column: string;
  expected: unknown;
}> = [
  {
    name: "config.lang",
    plant: (doc) => { doc.getMap<unknown>("config").set("lang", unrenderable()); },
    update: /UPDATE project_config SET/, rowId: PROJECT_ID, column: "lang", expected: "en",
  },
  {
    name: "config.theme",
    plant: (doc) => { doc.getMap<unknown>("config").set("theme", unrenderable()); },
    update: /UPDATE project_config SET/, rowId: PROJECT_ID, column: "theme", expected: "",
  },
  {
    name: "config.logo",
    plant: (doc) => { doc.getMap<unknown>("config").set("logo", unrenderable()); },
    update: /UPDATE project_config SET/, rowId: PROJECT_ID, column: "logo", expected: "",
  },
  {
    name: "config.featured_count",
    plant: (doc) => { doc.getMap<unknown>("config").set("featured_count", unrenderable()); },
    update: /UPDATE project_config SET/, rowId: PROJECT_ID, column: "featured_count", expected: 4,
  },
  {
    name: "steps.kind",
    plant: (doc) => { firstStep(doc).set("kind", unrenderable()); },
    update: /UPDATE steps SET/, rowId: 5, column: "kind", expected: "media",
  },
  {
    name: "steps.page",
    plant: (doc) => { firstStep(doc).set("page", unrenderable()); },
    update: /UPDATE steps SET/, rowId: 5, column: "page", expected: "",
  },
  {
    name: "steps.clip_start",
    plant: (doc) => { firstStep(doc).set("clip_start", unrenderable()); },
    update: /UPDATE steps SET/, rowId: 5, column: "clip_start", expected: "",
  },
  {
    name: "steps.clip_end",
    plant: (doc) => { firstStep(doc).set("clip_end", unrenderable()); },
    update: /UPDATE steps SET/, rowId: 5, column: "clip_end", expected: "",
  },
  {
    name: "steps.loop",
    plant: (doc) => { firstStep(doc).set("loop", unrenderable()); },
    update: /UPDATE steps SET/, rowId: 5, column: "loop", expected: "",
  },
  {
    name: "objects.source_url",
    plant: (doc) => { first(doc, "objects").set("source_url", unrenderable()); },
    update: /UPDATE objects SET/, rowId: 2, column: "source_url", expected: "",
  },
  {
    name: "objects.thumbnail",
    plant: (doc) => { first(doc, "objects").set("thumbnail", unrenderable()); },
    update: /UPDATE objects SET/, rowId: 2, column: "thumbnail", expected: "",
  },
  {
    name: "objects.dimensions",
    plant: (doc) => { first(doc, "objects").set("dimensions", unrenderable()); },
    update: /UPDATE objects SET/, rowId: 2, column: "dimensions", expected: "",
  },
  {
    name: "objects.extra_columns",
    plant: (doc) => { first(doc, "objects").set("extra_columns", unrenderable()); },
    update: /UPDATE objects SET/, rowId: 2, column: "extra_columns", expected: "",
  },
];

describe("a plain column value nothing can render leaves the project persisting", () => {
  for (const c of PLAIN_CASES) {
    it(`snapshots a document carrying one at ${c.name}`, async () => {
      const { db } = await snapshotWith(c.plant);

      expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
      const write = writeFor(db.writes, c.update, c.rowId);
      expect(write).toBeDefined();
      expect(boundTo(write!, c.column)).toBe(c.expected);
    });
  }

  /**
   * The five config columns whose reader is a DOMAIN rather than a render.
   *
   * `title` holds a `Y.Text` and the four convenor-only text keys hold plain
   * strings; an unrenderable value is in neither domain. Blanking the column
   * would be an answer invented for a value the snapshot cannot read, and for
   * the four it would publish a blank `url` into `_config.yml`. So the column
   * is left out of the UPDATE, D1 keeps what it holds, and the rest of the row
   * still writes — the totality that matters here is that the snapshot RUNS.
   */
  it.each([
    "title", "baseurl", "url", "google_sheets_published_url", "story_key",
  ])("drops config.%s rather than blanking it", async (key) => {
    const { db } = await snapshotWith((doc) => {
      doc.getMap<unknown>("config").set(key, unrenderable());
    });

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const write = writeFor(db.writes, /UPDATE project_config SET/, PROJECT_ID)!;
    expect(write.sql).not.toMatch(new RegExp(`\\b${key} = \\?`));
    expect(() => boundTo(write, key)).toThrow();
    expect(boundTo(write, "lang")).toBe("en");
  });

  it("binds an object's origin as iiif when nothing can render it", async () => {
    // `origin` is written on INSERT only — the column is D1-only and the
    // objects UPDATE omits it — so the plant has to ride a new object.
    const { db } = await snapshotWith((doc) => {
      push(doc, "objects", {
        _id: null, object_id: "olla-nueva", _validation_state: "valid",
        title: new Y.Text("Una olla"), origin: unrenderable(),
      });
    });

    const insert = db.writes.find((w) => /^INSERT INTO objects/.test(w.sql));
    expect(insert).toBeDefined();
    expect(insertedTo(insert!, "origin")).toBe("iiif");
  });

  it("binds a new step's plain columns absent when nothing can render them", async () => {
    // The INSERT pipeline renders the same fields from its own bind list, so
    // an entity that has never reached D1 is a second way in.
    const { db } = await snapshotWith((doc) => {
      const steps = first(doc, "stories").get("steps") as Y.Array<Y.Map<unknown>>;
      const fresh = new Y.Map<unknown>();
      fresh.set("_id", null);
      fresh.set("kind", unrenderable());
      fresh.set("clip_start", unrenderable());
      fresh.set("loop", unrenderable());
      fresh.set("page", unrenderable());
      steps.push([fresh]);
    });

    const insert = db.writes.find((w) => /^INSERT INTO steps/.test(w.sql));
    expect(insert).toBeDefined();
    expect(insertedTo(insert!, "kind")).toBe("media");
    expect(insertedTo(insert!, "clip_start")).toBe("");
    expect(insertedTo(insert!, "loop")).toBe("");
    expect(insertedTo(insert!, "page")).toBe("");
  });

  it("binds a new object's plain columns absent when nothing can render them", async () => {
    const { db } = await snapshotWith((doc) => {
      push(doc, "objects", {
        _id: null, object_id: "olla-nueva", _validation_state: "valid",
        title: new Y.Text("Una olla"), source_url: unrenderable(),
        thumbnail: unrenderable(), dimensions: unrenderable(),
        extra_columns: unrenderable(),
      });
    });

    const insert = db.writes.find((w) => /^INSERT INTO objects/.test(w.sql));
    expect(insert).toBeDefined();
    expect(insertedTo(insert!, "source_url")).toBe("");
    expect(insertedTo(insert!, "thumbnail")).toBe("");
    expect(insertedTo(insert!, "dimensions")).toBe("");
    expect(insertedTo(insert!, "extra_columns")).toBe("");
  });

  it("still binds an ordinary plain value unchanged", async () => {
    const { db } = await snapshotWith((doc) => {
      firstStep(doc).set("kind", "text");
      doc.getMap<unknown>("config").set("lang", "es");
      doc.getMap<unknown>("config").set("featured_count", 7);
    });

    expect(boundTo(writeFor(db.writes, /UPDATE steps SET/, 5)!, "kind")).toBe("text");
    const config = writeFor(db.writes, /UPDATE project_config SET/, PROJECT_ID)!;
    expect(boundTo(config, "lang")).toBe("es");
    expect(boundTo(config, "featured_count")).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 3. The activity resolver — a plant standing anywhere in the collection
// ---------------------------------------------------------------------------

describe("the activity resolver reads every map totally", () => {
  it("snapshots when a story elsewhere in the array carries an unrenderable _id", async () => {
    // The resolver SCANS: it renders `_id` and `_temp_id` on every map until
    // it finds the one the field path named. So the plant does not have to be
    // on the entity being resolved — a standing out-of-domain `_id`, which is
    // exactly what the load pass deliberately leaves in place, throws while
    // resolving somebody else's edit.
    const { db, internals } = makeDoFromBlob({
      ...SEEDED_ROWS,
      yjsState: blobWith((doc) => {
        // AHEAD of the story the field path names, so the scan meets the plant
        // before it finds its match — a plant behind the match is never read
        // and would leave this test green on the raw render.
        const planted = new Y.Map<unknown>();
        planted.set("_id", unrenderable());
        planted.set("story_id", "otra-historia");
        planted.set("title", new Y.Text("Otra historia"));
        planted.set("steps", new Y.Array<Y.Map<unknown>>());
        doc.getArray<Y.Map<unknown>>("stories").insert(0, [planted]);
      }),
      members: [{ user_id: 9, contributions: null }],
    });
    await internals.ensureDocLoaded();
    internals.userFieldSets.set(9, new Set(["stories:1:title"]));

    await (internals as unknown as ProjectCollaborationDO).snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const activity = db.writes.find((w) => /INSERT INTO activity_log/.test(w.sql));
    expect(activity).toBeDefined();
    // The row still names the story the path meant, resolved past the plant.
    expect(activity!.binds).toContain("la-vasija");
  });

  it("snapshots when the resolved entity's own slug cannot be rendered", async () => {
    const { db, internals } = makeDoFromBlob({
      ...SEEDED_ROWS,
      yjsState: blobWith((doc) => { first(doc, "stories").set("story_id", unrenderable()); }),
      members: [{ user_id: 9, contributions: null }],
    });
    await internals.ensureDocLoaded();
    internals.userFieldSets.set(9, new Set(["stories:1:title"]));

    await (internals as unknown as ProjectCollaborationDO).snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const activity = db.writes.find((w) => /INSERT INTO activity_log/.test(w.sql));
    expect(activity).toBeDefined();
    // Unresolvable falls back to the field-path id, as a deleted entity does.
    expect(activity!.binds).toContain("1");
  });

  it("matches nothing on a value nothing can render", () => {
    // The sentinel is not a match. Rendering is the reading for a SEARCH, and
    // two values that merely happen to be equally unrenderable are not thereby
    // the same id — filing one entity's edit under another's name is the cost.
    const doc = new Y.Doc();
    const arr = doc.getArray<Y.Map<unknown>>("stories");
    doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", unrenderable());
      m.set("story_id", "la-vasija");
      m.set("title", new Y.Text("La vasija"));
      arr.push([m]);
    });

    expect(resolveActivityEntity(doc, "story", "")).toEqual({
      entityId: "", entityLabel: null,
    });
    expect(resolveActivityEntity(doc, "story", "1")).toEqual({
      entityId: "1", entityLabel: null,
    });
  });

  it("resolves an ordinary entity exactly as before", () => {
    const doc = new Y.Doc();
    const arr = doc.getArray<Y.Map<unknown>>("objects");
    doc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", 7);
      m.set("_temp_id", "e6f8b1a2-0000-4000-8000-000000000000");
      m.set("object_id", "el-cantaro");
      m.set("title", new Y.Text("El cántaro"));
      arr.push([m]);
    });

    expect(resolveActivityEntity(doc, "object", "7")).toEqual({
      entityId: "el-cantaro", entityLabel: "El cántaro",
    });
    expect(resolveActivityEntity(doc, "object", "e6f8b1a2-0000-4000-8000-000000000000")).toEqual({
      entityId: "el-cantaro", entityLabel: "El cántaro",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The contribution tracker — a render inside `afterTransaction`
// ---------------------------------------------------------------------------

describe("the field-path tracker reads an entity id totally", () => {
  /** A tracked document holding one story whose `_id` is `id`. */
  function trackedStory(id: unknown) {
    const ydoc = new Y.Doc();
    const userFieldSets = new Map<number, Set<string>>();
    ydoc.on("afterTransaction", makeAfterTransactionHandler(
      ydoc, userFieldSets, () => 9,
    ));
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    // Seeded under the runtime's own origin, as a blob load does, so the edit
    // below is the first thing the tracker attributes.
    ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", id);
      m.set("title", new Y.Text("La vasija"));
      stories.push([m]);
    }, null);
    return {
      ydoc,
      story: stories.get(0),
      paths: () => [...(userFieldSets.get(9) ?? [])],
    };
  }

  it("does not throw out of the transaction that carried the value", () => {
    // This handler runs on `afterTransaction`, so a throw escapes the apply of
    // the update — taking the socket's whole message with it, ahead of any
    // snapshot.
    const h = trackedStory(unrenderable());

    expect(() => {
      h.ydoc.transact(() => { h.story.set("subtitle", new Y.Text("Un subtítulo")); }, { userId: 9 });
    }).not.toThrow();

    // The unreadable id reads as the empty segment, which `buildActivityRows`
    // declines to attribute — better than a segment that means something else,
    // which is what dropping the segment entirely would produce.
    expect(h.paths()).toEqual(["stories::subtitle"]);
  });

  it("still addresses an ordinary entity by its id", () => {
    const h = trackedStory(11);

    h.ydoc.transact(() => { h.story.set("subtitle", new Y.Text("Un subtítulo")); }, { userId: 9 });

    expect(h.paths()).toEqual(["stories:11:subtitle"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Two pages at one empty slug do not abort the batch
// ---------------------------------------------------------------------------

describe("two pages rendering to the unkeyed sentinel", () => {
  it("does not abort every entity's writes on the UNIQUE slug column", async () => {
    // `project_pages(project_id, slug)` is UNIQUE and this UPDATE rides in the
    // atomic batch, so two pages writing `''` discard the whole snapshot and
    // every retry re-issues the same pair. `deduplicateYArray` cannot resolve
    // it: it skips the empty key by design, because two entries nothing can
    // key are not thereby one entity.
    const { db } = await snapshotWith(
      (doc) => {
        first(doc, "pages").set("slug", unrenderable());
        push(doc, "pages", { _id: 6, slug: "", title: new Y.Text("Sin ruta"), body: new Y.Text("") });
      },
      {
        pages: [{ id: 4, slug: "creditos" }, { id: 6, slug: "borrador" }],
        enforcePageSlugUnique: true,
      },
    );

    // Both rows were written, and the batch that carried them was not refused.
    expect(writeFor(db.writes, /UPDATE project_pages SET/, 4)).toBeDefined();
    expect(writeFor(db.writes, /UPDATE project_pages SET/, 6)).toBeDefined();
    // Neither took the empty string; each kept the slug D1 already held.
    expect(db.pageSlugs.get(4)).toBe("creditos");
    expect(db.pageSlugs.get(6)).toBe("borrador");
    // Nothing else in the snapshot was lost with it.
    expect(writeFor(db.writes, /UPDATE stories SET/, 1)).toBeDefined();
    expect(writeFor(db.writes, /UPDATE objects SET/, 2)).toBeDefined();
  });

  it("still lands an ordinary rename", async () => {
    const { db } = await snapshotWith(
      (doc) => { first(doc, "pages").set("slug", "creditos-2"); },
      { enforcePageSlugUnique: true },
    );

    expect(boundTo(writeFor(db.writes, /UPDATE project_pages SET/, 4)!, "slug")).toBe("creditos-2");
    expect(db.pageSlugs.get(4)).toBe("creditos-2");
  });
});

// ---------------------------------------------------------------------------
// 6. The primitive itself
// ---------------------------------------------------------------------------

describe("renderedValue", () => {
  it("answers whenAbsent for a missing value and for one nothing can render", () => {
    expect(renderedValue(undefined, "en")).toBe("en");
    expect(renderedValue(null, "en")).toBe("en");
    expect(renderedValue(unrenderable(), "en")).toBe("en");
    expect(renderedValue(unrenderable())).toBe("");
  });

  it("renders every value that has a rendering", () => {
    expect(renderedValue("about")).toBe("about");
    expect(renderedValue(7)).toBe("7");
    expect(renderedValue(false)).toBe("false");
    expect(renderedValue(["about"])).toBe("about");
    expect(renderedValue({})).toBe("[object Object]");
  });
});

// ---------------------------------------------------------------------------
// 7. A shared text whose own render throws
// ---------------------------------------------------------------------------

/**
 * `renderedValue` closes the fallback branch of `yTextToString`. The
 * shared-type branch is the other half, and it is where a subclass arrives:
 * `Y.XmlText` satisfies `instanceof Y.Text`, and its own render states more
 * than the characters — every embed converted to a string, formatting
 * serialised as markup, and a throw where an embed converts to no primitive at
 * all. Any collaborator can write one through a `yjs_state` blob.
 *
 * `proseString` renders the branch through the delta instead, so what the
 * subclass reads as is its characters: the same answer the plain type gives
 * for the same content, which is what makes the type holding a key irrelevant
 * to what the key says. An embed standing alone leaves no characters, so the
 * field reads EMPTY — the reading `changedText` already takes for the same
 * call, and the one an empty `Y.Text` has always had.
 *
 * The two paths this render reaches are both ahead of any persistence. The
 * word baseline walks every prose key through it before the document is
 * admitted, so what it answers decides whether a project opens; the activity
 * resolver is the other, and it runs before both the blob and the batch.
 */
describe("a shared text that is not the type the editor writes", () => {
  it("opens a document whose blob carries one at a prose field", async () => {
    const { internals } = makeDoFromBlob({
      ...SEEDED_ROWS,
      yjsState: blobWith((doc) => { plantUnrenderableText(first(doc, "stories"), "title"); }),
    });

    await internals.ensureDocLoaded();

    expect(internals.docLoaded).toBe(true);
    // The field counts the word it really holds and not the embed beside it.
    expect(internals.wordBaseline.get("stories:1:title")).toBe(1);
    // And the walk was not abandoned at the plant: the fields after it still
    // hold what the document actually says.
    expect(internals.wordBaseline.get("stories:1:byline")).toBe(2);
    expect(internals.wordBaseline.get("stories:1:subtitle")).toBe(2);
    expect(internals.wordBaseline.get("objects:2:description")).toBe(2);
  });

  it("writes the characters of the prose column and not the embed", async () => {
    const { db, internals } = await snapshotWith((doc) => {
      plantUnrenderableText(first(doc, "stories"), "title");
    });

    // The blob reached D1: the snapshot ran to completion, which it can only do
    // because the load let the document open first.
    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const write = writeFor(db.writes, /UPDATE stories SET/, 1)!;
    expect(boundTo(write, "title")).toBe("una");
    // The hold is still what the assignment is written for, and the column
    // binds through it: a value with no reading at all still keeps D1's.
    expect(updateAssignment(write.sql, "title")).toBe("COALESCE(?, title)");
    // Every other column of the same row still carries its own value, and the
    // planted value is still in the document — reading is not repair.
    expect(boundTo(write, "byline")).toBe("Una autora");
    expect(first(internals.ydoc, "stories").get("title")).toBeInstanceOf(Y.XmlText);
  });

  it("labels the activity row with the characters the title holds", async () => {
    const { db, internals } = makeDoFromBlob({
      ...SEEDED_ROWS,
      yjsState: blobWith((doc) => { plantUnrenderableText(first(doc, "stories"), "title"); }),
      members: [{ user_id: 9, contributions: null }],
    });
    await internals.ensureDocLoaded();
    internals.userFieldSets.set(9, new Set(["stories:1:title"]));

    await (internals as unknown as ProjectCollaborationDO).snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const activity = db.writes.find((w) => /INSERT INTO activity_log/.test(w.sql));
    expect(activity).toBeDefined();
    // The row names the story it meant and labels it with what the field
    // says, rather than with the embed standing in it.
    expect(activity!.binds).toContain("la-vasija");
    expect(activity!.binds[5]).toBe("una");
  });

  it("writes it for a value that arrives after the document is open", async () => {
    // The resolver is reachable on its own and not only behind the load: a
    // value a collaborator sends into an open document never passes the word
    // baseline, which runs once, before anybody is admitted.
    const { db, internals } = makeDoFromBlob({
      ...SEEDED_ROWS,
      yjsState: blobWith(() => { /* healthy document */ }),
      members: [{ user_id: 9, contributions: null }],
    });
    await internals.ensureDocLoaded();
    internals.ydoc.transact(() => {
      plantUnrenderableText(first(internals.ydoc, "stories"), "title");
    });
    internals.userFieldSets.set(9, new Set(["stories:1:title"]));

    await (internals as unknown as ProjectCollaborationDO).snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const activity = db.writes.find((w) => /INSERT INTO activity_log/.test(w.sql));
    expect(activity).toBeDefined();
    expect(activity!.binds).toContain("la-vasija");
    expect(activity!.binds[5]).toBe("una");
  });

  it("writes the activity row a site title labels", async () => {
    const { db, internals } = makeDoFromBlob({
      ...SEEDED_ROWS,
      yjsState: blobWith((doc) => { plantUnrenderableText(doc.getMap<unknown>("config"), "title"); }),
      members: [{ user_id: 9, contributions: null }],
    });
    await internals.ensureDocLoaded();
    internals.userFieldSets.set(9, new Set(["config:title"]));

    await (internals as unknown as ProjectCollaborationDO).snapshotToD1();

    expect(db.writes.some((w) => /UPDATE projects SET yjs_state/.test(w.sql))).toBe(true);
    const activity = db.writes.find((w) => /INSERT INTO activity_log/.test(w.sql));
    expect(activity).toBeDefined();
    expect(activity!.binds[3]).toBe("config");
    expect(activity!.binds[5]).toBe("una");
  });

  it("leaves a shared text that renders untouched", async () => {
    const { db, internals } = await snapshotWith((doc) => {
      const text = new Y.XmlText();
      first(doc, "stories").set("subtitle", text);
      text.insert(0, "Un subtítulo nuevo");
    });

    expect(boundTo(writeFor(db.writes, /UPDATE stories SET/, 1)!, "subtitle"))
      .toBe("Un subtítulo nuevo");
    expect(internals.wordBaseline.get("stories:1:subtitle")).toBe(3);
    expect(internals.wordBaseline.get("stories:1:title")).toBe(2);
  });

  it("reads each shared text as its characters, and every other value as before", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("config");
    // A Y.Text holds its initial string as a pending op until the document
    // integrates it, so both of these are set into the map before being read.
    doc.transact(() => {
      plantUnrenderableText(map, "title");
      map.set("description", new Y.Text("La vasija"));
    });

    expect(yTextToString(map.get("title"))).toBe("una");
    expect(yTextToString(map.get("description"))).toBe("La vasija");
    expect(yTextToString("una cadena")).toBe("una cadena");
    expect(yTextToString(undefined)).toBe("");
  });

  it("states the characters of a subclass and neither its embeds nor its markup", () => {
    // A render that SUCCEEDS is the caller's business however poor its result,
    // which is why the fix is not a guard around the render: `[object Object]`
    // and `<bold>` are what the SUBCLASS's own render says, and the reading
    // here is the plain type's instead.
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("config");
    const embedded = new Y.XmlText();
    const formatted = new Y.XmlText();
    doc.transact(() => {
      map.set("title", embedded);
      map.set("description", formatted);
      embedded.insert(0, "hola");
      embedded.insertEmbed(4, { src: "una.png" });
      formatted.insert(0, "hola", { bold: true });
    });

    expect((map.get("title") as Y.Text).toString()).toBe("hola[object Object]");
    expect((map.get("description") as Y.Text).toString()).toBe("<bold>hola</bold>");
    expect(yTextToString(map.get("title"))).toBe("hola");
    expect(yTextToString(map.get("description"))).toBe("hola");
  });

  it("reads a plain Y.Text exactly as its own render does", () => {
    // The fast path in `proseString` is only allowed because the two agree on
    // the exact type. A value carrying formatting and an embed is where they
    // could part company, so that is the value it is pinned on.
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("config");
    const text = new Y.Text();
    doc.transact(() => {
      map.set("title", text);
      text.insert(0, "hola", { bold: true });
      text.insertEmbed(4, { src: "una.png" });
      text.insert(text.length, " mundo");
    });

    expect(yTextToString(map.get("title"))).toBe((map.get("title") as Y.Text).toString());
    expect(yTextToString(map.get("title"))).toBe("hola mundo");
  });

  it("catches the render and nothing around it", () => {
    // The guard is the render alone. The caller's own read of the key happens
    // outside it, so a map that is not a map still fails where it always did
    // rather than being reported as an empty field.
    expect(() => readProseField("stories", undefined as unknown as Y.Map<unknown>, "title"))
      .toThrow();
    expect(() => readProseField("stories", {} as unknown as Y.Map<unknown>, "title"))
      .toThrow();
  });
});
