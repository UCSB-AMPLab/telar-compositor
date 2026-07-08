/**
 * Pins the preserve-from-D1 behaviour of the flat-entity snapshot re-INSERT
 * branch (workers/collaboration.ts `snapshotFlatEntity`).
 *
 * Some columns live only in D1 and are never carried on the Y.Map: an object's
 * `origin` and a glossary term's `related_terms`. The snapshot UPDATE path
 * preserves them by omission (it never names the column), but the stale-`_id`
 * re-INSERT rebuilds the row from scratch and so would reset them to their
 * INSERT default (`origin = "iiif"`, `related_terms = NULL`). The fix reads the
 * surviving row's value back from D1 keyed by the id being recreated and binds
 * it into the re-INSERT.
 *
 * Harness mirrors object-config-fields-persist.test.ts: the DO is exercised
 * directly with a stubbed ctx/env and a hand-rolled DB that records every
 * prepare/bind and routes SELECTs by SQL substring. To reach the re-INSERT
 * branch the flat listing SELECT returns no rows (the Y.Map's _id is stale),
 * while the targeted preserve read returns the value being carried forward.
 *
 * @version v1.4.1-beta
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

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Glossary — related_terms survives a stale-id re-INSERT
// ---------------------------------------------------------------------------

describe("snapshotToD1 preserves glossary related_terms across a stale-id re-INSERT", () => {
  it("reads the surviving row's related_terms from D1 and binds it into the re-INSERT", async () => {
    const { doInstance, binds } = makeDO((sql) => {
      // Flat listing: no live rows -> the Y.Map's _id (33) is stale -> re-INSERT.
      if (/SELECT id(?:, term_id)? FROM glossary_terms WHERE project_id/.test(sql)) return [];
      // Targeted preserve read keyed by the id being recreated.
      if (/SELECT related_terms FROM glossary_terms WHERE id/.test(sql)) {
        return [{ related_terms: "cognate|synonym" }];
      }
      return [];
    });

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const term = new Y.Map<unknown>();
      term.set("_id", 33); // stale — no live row with this id
      term.set("term_id", "maize");
      term.set("title", new Y.Text("Maize"));
      term.set("definition", new Y.Text("A cereal grain."));
      ydoc.getArray<Y.Map<unknown>>("glossary").push([term]);
    }, null);

    await snapshot(doInstance);

    const insert = binds.find((b) => b.sql.includes("INSERT INTO glossary_terms"));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain("related_terms");
    expect(insert!.args).toContain("cognate|synonym");
  });

  it("binds NULL related_terms when no surviving row is found (nothing to preserve)", async () => {
    const { doInstance, binds } = makeDO((sql) => {
      if (/SELECT id(?:, term_id)? FROM glossary_terms WHERE project_id/.test(sql)) return [];
      return []; // targeted read also empty
    });

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const term = new Y.Map<unknown>();
      term.set("_id", 33);
      term.set("term_id", "maize");
      term.set("title", new Y.Text("Maize"));
      term.set("definition", new Y.Text("A cereal grain."));
      ydoc.getArray<Y.Map<unknown>>("glossary").push([term]);
    }, null);

    await snapshot(doInstance);

    const insert = binds.find((b) => b.sql.includes("INSERT INTO glossary_terms"));
    expect(insert).toBeDefined();
    // related_terms bind sits between definition and created_by; it is NULL.
    expect(insert!.args).toContain(null);
    expect(insert!.args).not.toContain("cognate|synonym");
  });
});

// ---------------------------------------------------------------------------
// Objects — origin survives a stale-id re-INSERT (not reset to "iiif")
// ---------------------------------------------------------------------------

describe("snapshotToD1 preserves object origin across a stale-id re-INSERT", () => {
  it("reads the surviving row's origin from D1 and binds it into the re-INSERT", async () => {
    const { doInstance, binds } = makeDO((sql) => {
      // Flat listing: no live rows -> the Y.Map's _id (77) is stale -> re-INSERT.
      if (/SELECT id(?:, object_id)? FROM objects WHERE project_id/.test(sql)) return [];
      // Targeted preserve read keyed by the id being recreated.
      if (/SELECT origin FROM objects WHERE id/.test(sql)) return [{ origin: "repo" }];
      return [];
    });

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const o = new Y.Map<unknown>();
      o.set("_id", 77); // stale — no live row with this id
      o.set("object_id", "obj-77");
      o.set("title", new Y.Text("Pot"));
      o.set("creator", new Y.Text(""));
      o.set("description", new Y.Text(""));
      o.set("alt_text", new Y.Text(""));
      o.set("source_url", "");
      o.set("period", new Y.Text(""));
      o.set("year", new Y.Text(""));
      o.set("object_type", new Y.Text(""));
      o.set("subjects", new Y.Text(""));
      o.set("source", new Y.Text(""));
      o.set("credit", new Y.Text(""));
      o.set("featured", false);
      o.set("image_available", false);
      // origin deliberately absent — the cold build never loads it onto the Y.Map.
      ydoc.getArray<Y.Map<unknown>>("objects").push([o]);
    }, null);

    await snapshot(doInstance);

    const insert = binds.find((b) => b.sql.includes("INSERT INTO objects"));
    expect(insert).toBeDefined();
    expect(insert!.args).toContain("repo");
    expect(insert!.args).not.toContain("iiif");
  });

  it("defaults origin to 'iiif' when no surviving row is found (nothing to preserve)", async () => {
    const { doInstance, binds } = makeDO((sql) => {
      if (/SELECT id(?:, object_id)? FROM objects WHERE project_id/.test(sql)) return [];
      return []; // targeted read also empty
    });

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const o = new Y.Map<unknown>();
      o.set("_id", 77);
      o.set("object_id", "obj-77");
      o.set("title", new Y.Text("Pot"));
      o.set("creator", new Y.Text(""));
      o.set("description", new Y.Text(""));
      o.set("alt_text", new Y.Text(""));
      o.set("source_url", "");
      o.set("period", new Y.Text(""));
      o.set("year", new Y.Text(""));
      o.set("object_type", new Y.Text(""));
      o.set("subjects", new Y.Text(""));
      o.set("source", new Y.Text(""));
      o.set("credit", new Y.Text(""));
      o.set("featured", false);
      o.set("image_available", false);
      ydoc.getArray<Y.Map<unknown>>("objects").push([o]);
    }, null);

    await snapshot(doInstance);

    const insert = binds.find((b) => b.sql.includes("INSERT INTO objects"));
    expect(insert).toBeDefined();
    expect(insert!.args).toContain("iiif");
  });
});
