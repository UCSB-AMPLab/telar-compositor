/**
 * What `snapshotConfig` writes for each of the twenty-three `project_config`
 * columns, and what it does when it cannot read the document value.
 *
 * The rule is HOLD BY OMISSION: a column whose document value the snapshot
 * cannot read is left out of the UPDATE, so D1 keeps what it holds. No read is
 * made for it, so a plant introduces no read that can fail before the blob is
 * written, and there is no read-then-write window in which a writer that
 * touches `project_config` without going through the document could be
 * overwritten with an older value.
 *
 * Absent is not unreadable. A collaborator may edit every config field outside
 * the six convenor-only ones, so a deleted `title` means "clear", an absent
 * flag takes its declared default and an absent `navigation` writes `[]`. The
 * one place absence has no legitimate author is those six: the guard's revert
 * for an edit inside a planted shared value deletes the whole key, no UI
 * removes them, and collaborators are refused. For those six, and only those
 * six, absent is treated as unreadable.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { getEntity, isExcluded } from "~/lib/field-registry";
import {
  buildConfigManagedBlocks,
  buildConfigManagedFields,
  healConfigYaml,
} from "~/lib/publish.server";
import { parseYaml } from "~/lib/yaml.server";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { markLoaded } from "./helpers/claimed-document";

const PROJECT_ID = 42;

// ---------------------------------------------------------------------------
// Statement-capturing D1
// ---------------------------------------------------------------------------

interface Stmt {
  sql: string;
  args: unknown[];
}

/** A `project_config` row for the reads the snapshot is allowed to make. */
function makeDO(rowProvider: (sql: string) => unknown[]) {
  const stmts: Stmt[] = [];
  const prepare = (sql: string) => ({
    sql,
    bind(...args: unknown[]) {
      stmts.push({ sql, args });
      return {
        sql,
        boundArgs: args,
        async run() { return { meta: { last_row_id: 100, changes: 1 } }; },
        async all<T>() { return { results: rowProvider(sql) as T[] }; },
        async first<T>() { return (rowProvider(sql)[0] ?? null) as T | null; },
      };
    },
  });
  const DB = {
    prepare,
    async batch(statements: Array<{ sql: string; boundArgs: unknown[] }>) {
      for (const s of statements) stmts.push({ sql: s.sql, args: s.boundArgs });
      return statements.map(() => ({ success: true }));
    },
  };
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
    { DB, SESSION_SECRET: "s", COLLABORATION: {} } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  return { doInstance, stmts };
}

/** D1 holds a config row and answers no other config SELECT with data. */
function configExists(sql: string): unknown[] {
  if (/SELECT id FROM project_config WHERE project_id/.test(sql)) return [{ id: 1 }];
  return [];
}

/** The SET list of the config UPDATE, in order. */
function setColumns(stmts: Stmt[]): string[] {
  const update = stmts.find((s) => /^UPDATE project_config SET/.test(s.sql));
  expect(update, "the config UPDATE was not issued").toBeDefined();
  return update!.sql
    .replace(/^UPDATE project_config SET /, "")
    .replace(/ WHERE project_id = \?$/, "")
    .split(", ")
    .map((assignment) => assignment.split(" = ")[0]);
}

/** The bound value of one column of the config UPDATE. */
function boundTo(stmts: Stmt[], column: string): unknown {
  const update = stmts.find((s) => /^UPDATE project_config SET/.test(s.sql))!;
  const index = setColumns(stmts).indexOf(column);
  expect(index, `${column} is not in the UPDATE`).toBeGreaterThanOrEqual(0);
  return update.args[index];
}

/**
 * The document keys and values a healthy config carries, in column order. The
 * four prose keys name their text; `seedConfig` wraps each in its own `Y.Text`,
 * because one built here would be shared between the tests that use it.
 */
const HEALTHY: ReadonlyArray<readonly [key: string, value: unknown, bind: unknown]> = [
  ["title", { text: "Sitio" }, "Sitio"],
  ["description", { text: "Una descripción" }, "Una descripción"],
  ["author", { text: "Autora" }, "Autora"],
  ["email", { text: "autora@example.org" }, "autora@example.org"],
  ["lang", "es", "es"],
  ["baseurl", "/sitio", "/sitio"],
  ["url", "https://real.example.org", "https://real.example.org"],
  ["theme", "trama", "trama"],
  ["logo", "logo.png", "logo.png"],
  ["include_demo_content", true, 1],
  ["google_sheets_enabled", true, 1],
  ["google_sheets_published_url", "https://docs.example.org/pubhtml", "https://docs.example.org/pubhtml"],
  ["show_on_homepage", false, 0],
  ["show_story_steps", false, 0],
  ["show_object_credits", false, 0],
  ["browse_and_search", false, 0],
  ["show_link_on_homepage", false, 0],
  ["show_sample_on_homepage", true, 1],
  ["collection_mode", true, 1],
  ["skip_stories", true, 1],
  ["featured_count", 7, 7],
  ["story_key", "secreto", "secreto"],
  ["navigation", null, null],
];

/** The `project_config` column each document key writes. */
const COLUMN_OF: Record<string, string> = { navigation: "navigation_json" };
function columnOf(key: string): string {
  return COLUMN_OF[key] ?? key;
}

/** Every column the UPDATE writes when the document is healthy, in order. */
const ALL_COLUMNS: string[] = [...HEALTHY.map(([key]) => columnOf(key)), "updated_at"];

/**
 * Seed a full, healthy config, then apply `edit`. Every key is present, which
 * is what a document built from a `project_config` row carries.
 */
function seedConfig(ydoc: Y.Doc, edit: (config: Y.Map<unknown>) => void = () => {}): void {
  ydoc.transact(() => {
    const config = ydoc.getMap<unknown>("config");
    for (const [key, value] of HEALTHY) {
      if (key === "navigation") {
        const nav = new Y.Array<unknown>();
        nav.push([{ type: "builtin", key: "home", label: "Home", visible: true }]);
        config.set("navigation", nav);
        continue;
      }
      const prose = value as { text?: string };
      config.set(key, typeof prose?.text === "string" ? new Y.Text(prose.text) : value);
    }
    edit(config);
  }, null);
}

let errors: string[] = [];

async function snapshotWith(
  edit: (config: Y.Map<unknown>) => void,
  rowProvider: (sql: string) => unknown[] = configExists,
) {
  const { doInstance, stmts } = makeDO(rowProvider);
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  seedConfig(ydoc, edit);
  await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
  return { stmts, ydoc };
}

beforeEach(() => {
  vi.clearAllMocks();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map((x) => String(x)).join(" "));
  });
});

/** The `[shape][detected]` lines the snapshot emitted about config. */
function holds(): string[] {
  return errors.filter((e) => e.includes("[shape][detected]") && e.includes("root=config"));
}

// ---------------------------------------------------------------------------
// 1. `ok` — every column binds what the document holds
// ---------------------------------------------------------------------------

describe("a healthy config writes all twenty-three columns", () => {
  it("keeps today's statement text and binds every value", async () => {
    const { stmts } = await snapshotWith(() => {});

    expect(setColumns(stmts)).toEqual(ALL_COLUMNS);
    for (const [key, , bind] of HEALTHY) {
      if (key === "navigation") continue;
      expect(boundTo(stmts, columnOf(key)), key).toEqual(bind);
    }
    expect(boundTo(stmts, "navigation_json")).toBe(
      '[{"type":"builtin","key":"home","label":"Home","visible":true}]',
    );
    expect(holds()).toEqual([]);
  });

  it("asks D1 for nothing but the row's existence", async () => {
    const { stmts } = await snapshotWith(() => {});

    const configSelects = stmts.filter(
      (s) => /^SELECT/.test(s.sql) && /FROM project_config/.test(s.sql),
    );
    expect(configSelects.map((s) => s.sql)).toEqual([
      "SELECT id FROM project_config WHERE project_id = ?",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. `wrong_type` — every column is dropped and reported
// ---------------------------------------------------------------------------

/** A value that converts to no primitive at all: `String(...)` throws on it. */
function unrenderable(): Record<string, unknown> {
  return { toString: null };
}

/**
 * A value out of domain for each column, as a FACTORY. A shared type belongs
 * to one document once it is integrated, so a fixture built at module scope
 * and reused would carry the first test's document into the second.
 */
const WRONG_TYPE: ReadonlyArray<readonly [key: string, make: () => unknown, found: string]> = [
  ["title", () => "a plain string", "string"],
  ["description", () => new Y.XmlText("x"), "shared-type"],
  ["author", () => JSON.parse("{}"), "plain-object"],
  ["email", () => 7, "number"],
  ["baseurl", () => new Y.Text("/evil"), "Y.Text"],
  ["url", () => unrenderable(), "plain-object"],
  ["google_sheets_published_url", () => new Y.Doc(), "shared-type"],
  ["story_key", () => JSON.parse("[]"), "plain-array"],
  ["include_demo_content", () => "false", "string"],
  ["google_sheets_enabled", () => JSON.parse("{}"), "plain-object"],
  ["show_on_homepage", () => "false", "string"],
  ["show_story_steps", () => JSON.parse("[]"), "plain-array"],
  ["show_object_credits", () => 1, "number"],
  ["browse_and_search", () => JSON.parse("{}"), "plain-object"],
  ["show_link_on_homepage", () => "true", "string"],
  ["show_sample_on_homepage", () => new Y.Map<unknown>(), "Y.Map"],
  ["collection_mode", () => "false", "string"],
  ["skip_stories", () => JSON.parse("{}"), "plain-object"],
  ["navigation", () => JSON.parse("[]"), "plain-array"],
];

describe("a config value the snapshot cannot read drops its column", () => {
  for (const [key, make, found] of WRONG_TYPE) {
    it(`omits ${columnOf(key)} and reports it`, async () => {
      const { stmts } = await snapshotWith((config) => { config.set(key, make()); });

      const columns = setColumns(stmts);
      expect(columns).not.toContain(columnOf(key));
      // Every other column still writes, so one unreadable value costs the
      // project one column and not the row.
      expect(columns).toEqual(ALL_COLUMNS.filter((c) => c !== columnOf(key)));

      const line = holds().find((l) => l.includes(`config.${key} `));
      expect(line, `no report for ${key}`).toBeDefined();
      expect(line).toContain(`config.${key} (a ${found})`);
      expect(line).toContain("the column keeps what D1 holds and nothing is repaired");
    });
  }

  it("makes no D1 read for a column it dropped", async () => {
    const { stmts } = await snapshotWith((config) => {
      config.set("url", new Y.Text("https://evil.example.org"));
      config.set("skip_stories", JSON.parse("{}"));
      config.set("navigation", JSON.parse("[]"));
    });

    // The value D1 keeps is the value already in the row: the snapshot never
    // reads it, so there is no window between a read and the batch.
    const configSelects = stmts.filter(
      (s) => /^SELECT/.test(s.sql) && /FROM project_config/.test(s.sql),
    );
    expect(configSelects.map((s) => s.sql)).toEqual([
      "SELECT id FROM project_config WHERE project_id = ?",
    ]);
  });

  it("keeps the surviving columns and their binds in the same order", async () => {
    const { stmts } = await snapshotWith((config) => {
      config.set("url", new Y.Text("https://evil.example.org"));
      config.set("browse_and_search", "false");
      config.set("navigation", JSON.parse("[]"));
    });

    const columns = setColumns(stmts);
    expect(columns).toEqual(
      ALL_COLUMNS.filter((c) => !["url", "browse_and_search", "navigation_json"].includes(c)),
    );
    // Position is what pairs a bind with its column, so a dropped column that
    // left its bind behind would shift every value after it by one.
    const update = stmts.find((s) => /^UPDATE project_config SET/.test(s.sql))!;
    expect(update.args).toHaveLength(columns.length + 1);
    expect(boundTo(stmts, "baseurl")).toBe("/sitio");
    expect(boundTo(stmts, "story_key")).toBe("secreto");
    expect(boundTo(stmts, "featured_count")).toBe(7);
    expect(boundTo(stmts, "skip_stories")).toBe(1);
    expect(update.args[update.args.length - 1]).toBe(PROJECT_ID);
  });

  it("never renders the value it refused", async () => {
    await snapshotWith((config) => {
      config.set("url", new Y.Text("https://evil.example.org"));
      config.set("story_key", ["stolen-key"]);
    });

    for (const line of holds()) {
      expect(line).not.toContain("evil.example.org");
      expect(line).not.toContain("stolen-key");
    }
  });
});

/** The four character-merged prose keys, in column order. */
const PROSE_KEYS = ["title", "description", "author", "email"] as const;

/**
 * What each column binds when the document does not hold the key: the value an
 * untouched project writes. On the INSERT branch this is what `missing` and
 * `wrong_type` both bind, because there is no row to hold anything.
 *
 * The schema defaults `include_demo_content` to true and this binds false; the
 * INSERT binds its own value for every column, so the two cannot diverge.
 */
const UNSET: Record<string, unknown> = {
  title: "",
  description: "",
  author: "",
  email: "",
  lang: "en",
  baseurl: "",
  url: "",
  theme: "",
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
  story_key: "",
  navigation: "[]",
};

/**
 * A wrong-type value for every column of the matrix, and whether the snapshot
 * reports it. `lang`, `theme`, `logo` and `featured_count` render through a
 * total reader, so no value at those four is ever out of domain.
 */
const INSERT_WRONG_TYPE: ReadonlyArray<readonly [key: string, make: () => unknown, reports: boolean]> = [
  ...WRONG_TYPE.map(([key, make]) => [key, make, true] as const),
  ["lang", () => unrenderable(), false],
  ["theme", () => unrenderable(), false],
  ["logo", () => unrenderable(), false],
  ["featured_count", () => unrenderable(), false],
];

describe("a null at a prose key is a present value, not an absence", () => {
  for (const key of PROSE_KEYS) {
    it(`omits ${key} and reports it`, async () => {
      const { stmts } = await snapshotWith((config) => { config.set(key, null); });

      // `map.set(key, null)` leaves `map.has(key)` true, so the key is present
      // and holds a value that is not the `Y.Text` the config page's editor
      // binds to. Reading it as an absence would bind `""` and blank the
      // column D1 holds a value in.
      expect(setColumns(stmts)).not.toContain(key);
      const line = holds().find((l) => l.includes(`config.${key} `));
      expect(line, `no report for ${key}`).toBeDefined();
      expect(line).toContain(`config.${key} (a null)`);
      expect(line).toContain("the column keeps what D1 holds and nothing is repaired");
    });
  }
});

// ---------------------------------------------------------------------------
// 3. `missing` — absent means what it means today, except for the six
// ---------------------------------------------------------------------------

describe("an absent config key keeps the meaning a collaborator can author", () => {
  it.each([
    ["title", "title", ""],
    ["description", "description", ""],
    ["author", "author", ""],
    ["email", "email", ""],
    ["show_on_homepage", "show_on_homepage", 1],
    ["show_story_steps", "show_story_steps", 1],
    ["show_object_credits", "show_object_credits", 1],
    ["browse_and_search", "browse_and_search", 1],
    ["show_link_on_homepage", "show_link_on_homepage", 1],
    ["show_sample_on_homepage", "show_sample_on_homepage", 0],
    ["collection_mode", "collection_mode", 0],
    ["skip_stories", "skip_stories", 0],
    ["navigation", "navigation_json", "[]"],
  ])("clears or defaults %s", async (key, column, expected) => {
    const { stmts } = await snapshotWith((config) => { config.delete(key); });

    expect(setColumns(stmts)).toContain(column);
    expect(boundTo(stmts, column)).toEqual(expected);
    expect(holds().some((l) => l.includes(`config.${key} `))).toBe(false);
  });

  it.each([
    "url",
    "baseurl",
    "story_key",
    "google_sheets_published_url",
    "google_sheets_enabled",
    "include_demo_content",
  ])("holds %s, which no legitimate author removes", async (key) => {
    const { stmts } = await snapshotWith((config) => { config.delete(key); });

    // The guard's revert for an edit inside a planted shared value deletes the
    // whole key, and a defaults rule would persist that as a blank `url`.
    expect(setColumns(stmts)).not.toContain(key);
    expect(holds().some((l) => l.includes(`config.${key} `))).toBe(true);
  });

  it("still writes an absent lang, theme, logo and featured_count as today", async () => {
    const { stmts } = await snapshotWith((config) => {
      config.delete("lang");
      config.delete("theme");
      config.delete("logo");
      config.delete("featured_count");
    });

    // These four are collaborator-writable and outside this rule: they render
    // through a total reader, so an absence is the declared value and never a
    // held column.
    expect(setColumns(stmts)).toEqual(ALL_COLUMNS);
    expect(boundTo(stmts, "lang")).toBe("en");
    expect(boundTo(stmts, "theme")).toBe("");
    expect(boundTo(stmts, "logo")).toBe("");
    expect(boundTo(stmts, "featured_count")).toBe(4);
    expect(holds()).toEqual([]);
  });

  // The column is D1's alone: the Config action writes it and sync heals it,
  // and no snapshot may touch it. A key planted in the document must not
  // reach the statement at all — reaching it under any value would let a
  // snapshot undo a heal or store a value the action refused.
  it("never writes answer_word_limit, whatever the document holds at that key", async () => {
    const { stmts } = await snapshotWith((config) => {
      config.set("answer_word_limit", 7);
    });

    expect(setColumns(stmts)).not.toContain("answer_word_limit");
    expect(setColumns(stmts)).toEqual(ALL_COLUMNS);
  });

  it("still writes an unrenderable lang, theme, logo and featured_count as today", async () => {
    const { stmts } = await snapshotWith((config) => {
      config.set("lang", unrenderable());
      config.set("theme", unrenderable());
      config.set("logo", unrenderable());
      config.set("featured_count", unrenderable());
    });

    // The render is total: a value `String(...)` throws on takes the same
    // value an absence does, and the column is written either way.
    expect(setColumns(stmts)).toEqual(ALL_COLUMNS);
    expect(boundTo(stmts, "lang")).toBe("en");
    expect(boundTo(stmts, "theme")).toBe("");
    expect(boundTo(stmts, "logo")).toBe("");
    expect(boundTo(stmts, "featured_count")).toBe(4);
    expect(holds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The guard-deletion case, end to end
// ---------------------------------------------------------------------------

describe("the end-to-end path a planted url actually takes", () => {
  let memory: MemoryD1;

  beforeEach(() => {
    memory = createMemoryD1();
    for (const id of [1, 7, 9]) {
      memory.raw
        .prepare(
          "INSERT INTO users (id, github_id, github_login, encrypted_access_token, " +
          "encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
          "VALUES (?, ?, ?, 'e', 'e', '2099-01-01', '2099-01-01')",
        )
        .run(id, id, `u${id}`);
    }
    // The revision a completed load claims, and the one `markLoaded` plants on
    // the instance: every write below is conditioned on it, so the row and the
    // instance have to agree about which revision this document was opened at.
    memory.raw.exec(
      "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id, yjs_write) " +
      "VALUES (42, 1, 'o/a', 1, 1)",
    );
  });

  afterEach(() => { memory.close(); });

  function seedConfigRow(): void {
    memory.raw
      .prepare(
        "INSERT INTO project_config (project_id, url, baseurl, story_key, " +
        "google_sheets_enabled, google_sheets_published_url, include_demo_content) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(PROJECT_ID, "https://real.example.org", "/real", "real-key", 1, "https://docs/pubhtml", 1);
  }

  function configRow(): Record<string, unknown> {
    return memory.raw
      .prepare("SELECT * FROM project_config WHERE project_id = ?")
      .get(PROJECT_ID) as Record<string, unknown>;
  }

  function makeLiveDo(db: D1Database) {
    const ctx = {
      getWebSockets: () => [] as unknown[],
      blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
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
      { DB: db, SESSION_SECRET: "s", COLLABORATION: {} } as unknown as Env,
    );
    (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
    return doInstance;
  }

  /** A socket attachment the delete guard reads a role off. */
  function fakeSocket(userId: number, role: string) {
    return {
      deserializeAttachment: () => ({ userId, role, projectId: PROJECT_ID }),
      send: vi.fn(),
      close: vi.fn(),
    };
  }

  it("leaves D1's url alone after the guard deletes the planted key", async () => {
    seedConfigRow();
    const doInstance = makeLiveDo(asD1(memory));
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    markLoaded(doInstance);
    seedConfig(ydoc);
    const planted = new Y.Text("https://real.example.org");
    ydoc.transact(() => { ydoc.getMap<unknown>("config").set("url", planted); }, null);

    // A collaborator edits INSIDE the plant, which never changes the config
    // root. The guard catches it through the value's own parent chain, and its
    // revert cannot write a shared type back, so it clears the key.
    ydoc.transact(() => {
      planted.delete(0, planted.length);
      planted.insert(0, "https://evil.example.org");
    }, fakeSocket(7, "collaborator"));
    expect(ydoc.getMap<unknown>("config").get("url")).toBeUndefined();

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    expect(configRow().url).toBe("https://real.example.org");
    // The rest of the row is written from the document, so the held column is
    // one column and not the whole row.
    expect(configRow().baseurl).toBe("/sitio");
    expect(configRow().story_key).toBe("secreto");
  });

  it("binds a convenor's scalar set on a planted key", async () => {
    seedConfigRow();
    const doInstance = makeLiveDo(asD1(memory));
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    markLoaded(doInstance);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getMap<unknown>("config").set("url", new Y.Text("https://evil.example.org"));
    }, null);

    // A scalar `set` on the config page is how a convenor undoes a plant, and
    // it is an assignment the guard admits from a convenor.
    ydoc.transact(() => {
      ydoc.getMap<unknown>("config").set("url", "https://fixed.example.org");
    }, fakeSocket(9, "convenor"));

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    expect(configRow().url).toBe("https://fixed.example.org");
  });

  it("does not overwrite a D1-only write that lands during the snapshot", async () => {
    seedConfigRow();
    const direct = "https://direct.example.org";
    const racing = {
      prepare: (sql: string) => memory.prepare(sql),
      exec: (sql: string) => memory.exec(sql),
      batch: async (statements: Array<{ sql: string; boundArgs: unknown[] }>) => {
        // The config action writes `project_config` without going through the
        // document. It lands after the snapshot has read the document and
        // before the batch that carries the UPDATE.
        memory.raw
          .prepare("UPDATE project_config SET url = ? WHERE project_id = ?")
          .run(direct, PROJECT_ID);
        return memory.batch(statements as never);
      },
    } as unknown as D1Database;

    const doInstance = makeLiveDo(racing);
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    markLoaded(doInstance);
    seedConfig(ydoc);
    ydoc.transact(() => {
      ydoc.getMap<unknown>("config").set("url", new Y.Text("https://evil.example.org"));
    }, null);

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    expect(configRow().url).toBe(direct);
  });

  it("keeps the accepted edit across a hibernation wake with the plant already in the blob", async () => {
    seedConfigRow();
    memory.raw
      .prepare('INSERT INTO stories (project_id, story_id, title, "order", order_key) VALUES (?, ?, ?, ?, ?)')
      .run(PROJECT_ID, "a", "a", 0, "a000011");

    // The blob a wake starts from already carries the plant, which is the only
    // way a load can meet one: the entry guards refuse every new one.
    const planting = makeLiveDo(asD1(memory));
    await (planting as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
    const plantingDoc = (planting as unknown as { ydoc: Y.Doc }).ydoc;
    plantingDoc.transact(() => {
      plantingDoc.getMap<unknown>("config").set("url", new Y.Text("https://evil.example.org"));
    }, null);
    await (planting as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    expect(configRow().url).toBe("https://real.example.org");

    // A read of the convenor-only columns is the one read a load must not
    // make: it can fail, and a load that answered a failure by withholding
    // persistence would admit editors while losing their edits to the next
    // wake. Every other read the load makes — the blob-gap `SELECT *`, the
    // course-mode read, the snapshot's `SELECT id` — is permitted.
    const selectsConvenorColumns = (sql: string): boolean => {
      const columns = /^SELECT\s+([\s\S]*?)\s+FROM project_config\b/.exec(sql)?.[1];
      return columns !== undefined
        && /\b(url|baseurl|story_key|google_sheets_enabled|google_sheets_published_url|include_demo_content)\b/
          .test(columns);
    };
    const guarded = {
      prepare: (sql: string) => {
        if (selectsConvenorColumns(sql)) {
          throw new Error("D1_ERROR: the held columns must not be read");
        }
        return memory.prepare(sql);
      },
      exec: (sql: string) => memory.exec(sql),
      batch: (statements: unknown) => memory.batch(statements as never),
    } as unknown as D1Database;

    const woken = makeLiveDo(guarded);
    await (woken as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();

    // The plant stands, and the document is open on the ordinary terms.
    const wokenDoc = (woken as unknown as { ydoc: Y.Doc }).ydoc;
    expect(wokenDoc.getMap<unknown>("config").get("url")).toBeInstanceOf(Y.Text);
    wokenDoc.transact(() => {
      const title = wokenDoc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text;
      title.delete(0, title.length);
      title.insert(0, "Renamed");
    }, null);

    await (woken as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    // The blob was written, so the next wake rebuilds from a document that
    // carries the edit rather than from the state the plant was met in.
    const second = makeLiveDo(asD1(memory));
    await (second as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
    const secondDoc = (second as unknown as { ydoc: Y.Doc }).ydoc;
    expect(String(secondDoc.getArray<Y.Map<unknown>>("stories").get(0).get("title"))).toBe("Renamed");
    expect(configRow().url).toBe("https://real.example.org");
    expect(
      (memory.raw.prepare("SELECT title FROM stories WHERE project_id = ?").get(PROJECT_ID) as
        { title: string }).title,
    ).toBe("Renamed");
  });

  it("INSERTs today's values on a cold build with no project_config row", async () => {
    const doInstance = makeLiveDo(asD1(memory));
    await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
    // A plant standing on the INSERT branch has nothing to hold: the row does
    // not exist, so the column binds the value an untouched project writes.
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      ydoc.getMap<unknown>("config").set("url", new Y.Text("https://evil.example.org"));
    }, null);

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    const row = configRow();
    expect(row.title).toBe("");
    expect(row.description).toBe("");
    expect(row.author).toBe("");
    expect(row.email).toBe("");
    expect(row.lang).toBe("en");
    expect(row.baseurl).toBe("");
    expect(row.url).toBe("");
    expect(row.theme).toBe("");
    expect(row.logo).toBe("");
    // The schema defaults `include_demo_content` to true and the snapshot to
    // false; the INSERT binds its own value, so the two cannot diverge.
    expect(row.include_demo_content).toBe(0);
    expect(row.google_sheets_enabled).toBe(0);
    expect(row.google_sheets_published_url).toBe("");
    expect(row.show_on_homepage).toBe(1);
    expect(row.show_story_steps).toBe(1);
    expect(row.show_object_credits).toBe(1);
    expect(row.browse_and_search).toBe(1);
    expect(row.show_link_on_homepage).toBe(1);
    expect(row.show_sample_on_homepage).toBe(0);
    expect(row.collection_mode).toBe(0);
    expect(row.skip_stories).toBe(0);
    expect(row.featured_count).toBe(4);
    expect(row.story_key).toBe("");
    // The cold build seeds the default navigation from pages and builtins.
    expect(JSON.parse(String(row.navigation_json))).toHaveLength(3);
    expect(
      holds().some((l) => l.includes("config.url (a Y.Text)")
        && l.includes("binds its unset value and nothing is repaired")),
    ).toBe(true);
  });

  describe("every column of the matrix on the INSERT branch", () => {
    /**
     * A healthy document and no `project_config` row, so the snapshot INSERTs.
     * There is nothing to hold on that branch: a value the snapshot cannot
     * read, and a key it does not hold at all, both bind the unset value.
     */
    async function insertWith(edit: (config: Y.Map<unknown>) => void) {
      const doInstance = makeLiveDo(asD1(memory));
      const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
      markLoaded(doInstance);
      seedConfig(ydoc, edit);
      await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
      return configRow();
    }

    for (const [key, make, reports] of INSERT_WRONG_TYPE) {
      it(`binds the unset value for a wrong-type ${key}`, async () => {
        const row = await insertWith((config) => { config.set(key, make()); });

        expect(row[columnOf(key)], key).toEqual(UNSET[key]);
        expect(
          holds().some((l) => l.includes(`config.${key} `)
            && l.includes("binds its unset value and nothing is repaired")),
          key,
        ).toBe(reports);
      });
    }

    for (const key of Object.keys(UNSET)) {
      it(`binds the unset value for an absent ${key}`, async () => {
        const row = await insertWith((config) => { config.delete(key); });

        expect(row[columnOf(key)], key).toEqual(UNSET[key]);
      });
    }

    it("binds the empty string for a null at each prose key", async () => {
      const row = await insertWith((config) => {
        for (const key of PROSE_KEYS) config.set(key, null);
      });

      for (const key of PROSE_KEYS) expect(row[key], key).toBe("");
    });
  });

  it("publishes D1's value for the three publish-managed convenor keys", async () => {
    seedConfigRow();
    const doInstance = makeLiveDo(asD1(memory));
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    markLoaded(doInstance);
    seedConfig(ydoc);
    ydoc.transact(() => {
      const config = ydoc.getMap<unknown>("config");
      config.set("url", new Y.Text("https://evil.example.org"));
      config.set("baseurl", new Y.Text("/evil"));
      config.set("story_key", new Y.Text("stolen"));
    }, null);

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    // Publish reads the D1 column, so a column the snapshot dropped publishes
    // the value it already held.
    const fields = getEntity("config").fields;
    const publishOf = (name: string) => fields.find((f) => f.name === name)!.publish;
    for (const [name, key] of [["url", "url"], ["baseurl", "baseurl"], ["story_key", "protected.key"]]) {
      const publish = publishOf(name);
      expect(isExcluded(publish), name).toBe(false);
      expect((publish as { file: string; key: string }).file).toBe("_config.yml");
      expect((publish as { file: string; key: string }).key).toBe(key);
    }
    const row = configRow();
    expect(row.url).toBe("https://real.example.org");
    expect(row.baseurl).toBe("/real");
    expect(row.story_key).toBe("real-key");

    // End to end: the serialiser that writes `_config.yml` runs on that row,
    // and the file the publish commits carries the three values the plant
    // never reached.
    const config = row as unknown as Parameters<typeof buildConfigManagedFields>[0];
    const yaml = healConfigYaml(
      [
        "title: \"Sitio\"",
        "url: \"https://stale.example.org\"",
        "baseurl: \"/stale\"",
        "story_key: \"stale-key\"",
        "",
      ].join("\n"),
      buildConfigManagedFields(config),
      buildConfigManagedBlocks(config),
    );
    const published = parseYaml(yaml) as Record<string, unknown>;
    expect(published.url).toBe("https://real.example.org");
    expect(published.baseurl).toBe("/real");
    expect(published.story_key).toBe("real-key");
    expect(yaml).not.toContain("evil.example.org");
    expect(yaml).not.toContain("stolen");

    // Neither Sheets field is publish-managed, so for those two the exposure a
    // dropped column prevents is D1's alone.
    expect(isExcluded(publishOf("google_sheets_enabled"))).toBe(true);
    expect(isExcluded(publishOf("google_sheets_published_url"))).toBe(true);
  });
});
