/**
 * Pins the snapshot round-trip for object + config fields that were wired into
 * the schema and editor but never into the DO snapshot, causing silent data
 * loss (reported as telar-compositor#23: an object credit line vanished on
 * reload and never reached the published site).
 *
 * The DO snapshot is the only D1 writer for collaboratively-edited entities, so
 * a field must appear in ALL of: the buildFromD1Rows LOAD (D1 -> Y.Map), the
 * snapshot INSERT (new Y.Map -> D1), and the snapshot UPDATE (existing Y.Map ->
 * D1). These four object fields (object_type, subjects, source, credit) and the
 * config collection_mode toggle were missing from those paths.
 *
 * Mirrors created-by-persist.test.ts: the DO is exercised directly with a
 * stubbed ctx/env and a hand-rolled DB that records every prepare/bind and
 * routes SELECTs by SQL substring.
 *
 * @version v1.3.2-beta
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Objects — INSERT binds the four previously-dropped fields
// ---------------------------------------------------------------------------

describe("snapshotToD1 persists object_type/subjects/source/credit on new objects", () => {
  it("a new object Y.Map binds those four fields into the objects INSERT", async () => {
    const { doInstance, binds } = makeDO(() => []); // all SELECTs empty → INSERT path

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const o = new Y.Map<unknown>();
      o.set("_id", null);
      o.set("object_id", "potatourpu");
      o.set("title", new Y.Text("Potato"));
      o.set("creator", new Y.Text(""));
      o.set("description", new Y.Text(""));
      o.set("alt_text", new Y.Text(""));
      o.set("source_url", "");
      o.set("period", new Y.Text(""));
      o.set("year", new Y.Text(""));
      o.set("object_type", new Y.Text("photograph"));
      o.set("subjects", new Y.Text("agriculture"));
      o.set("source", new Y.Text("Archivo X"));
      o.set("credit", new Y.Text("Photo by Megan"));
      o.set("featured", false);
      o.set("image_available", true);
      o.set("origin", "iiif");
      ydoc.getArray<Y.Map<unknown>>("objects").push([o]);
    }, null);

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    const objInsert = binds.find((b) => b.sql.includes("INSERT INTO objects"));
    expect(objInsert).toBeDefined();
    expect(objInsert!.args).toContain("photograph");
    expect(objInsert!.args).toContain("agriculture");
    expect(objInsert!.args).toContain("Archivo X");
    expect(objInsert!.args).toContain("Photo by Megan");
  });
});

// ---------------------------------------------------------------------------
// Objects — UPDATE binds the four fields for an existing object
// ---------------------------------------------------------------------------

describe("snapshotToD1 persists object_type/subjects/source/credit on existing objects", () => {
  it("an object with a real _id binds those four fields into the objects UPDATE", async () => {
    // The objects SELECT returns the same id so the Y.Map's _id matches a live
    // D1 row → UPDATE (not re-INSERT) path.
    const { doInstance, binds } = makeDO((sql) => {
      if (/SELECT id(?:, object_id)? FROM objects WHERE project_id/.test(sql)) {
        return [{ id: 5, object_id: "potatourpu" }];
      }
      return [];
    });

    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const o = new Y.Map<unknown>();
      o.set("_id", 5);
      o.set("object_id", "potatourpu");
      o.set("title", new Y.Text("Potato"));
      o.set("creator", new Y.Text(""));
      o.set("description", new Y.Text(""));
      o.set("alt_text", new Y.Text(""));
      o.set("source_url", "");
      o.set("period", new Y.Text(""));
      o.set("year", new Y.Text(""));
      o.set("object_type", new Y.Text("photograph"));
      o.set("subjects", new Y.Text("agriculture"));
      o.set("source", new Y.Text("Archivo X"));
      o.set("credit", new Y.Text("Photo by Megan"));
      o.set("featured", false);
      o.set("image_available", true);
      ydoc.getArray<Y.Map<unknown>>("objects").push([o]);
    }, null);

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    const objUpdate = binds.find(
      (b) => b.sql.includes("UPDATE objects SET") && b.args.includes("Photo by Megan"),
    );
    expect(objUpdate).toBeDefined();
    expect(objUpdate!.args).toContain("photograph");
    expect(objUpdate!.args).toContain("agriculture");
    expect(objUpdate!.args).toContain("Archivo X");
  });
});

// ---------------------------------------------------------------------------
// Objects — buildFromD1Rows restores the four fields onto the Y.Map
// ---------------------------------------------------------------------------

describe("buildFromD1Rows restores object_type/subjects/source/credit on cold rebuild", () => {
  it("an objects D1 row yields a Y.Map carrying those four fields", async () => {
    const objectRow = {
      id: 5,
      object_id: "potatourpu",
      title: "Potato",
      creator: null,
      description: null,
      alt_text: null,
      source_url: null,
      period: null,
      year: null,
      object_type: "photograph",
      subjects: "agriculture",
      source: "Archivo X",
      credit: "Photo by Megan",
      featured: 0,
      image_available: 1,
      created_by: 7,
    };
    const { doInstance } = makeDO((sql) => {
      if (sql.includes("FROM objects")) return [objectRow];
      return [];
    });

    await (doInstance as unknown as { buildFromD1Rows: () => Promise<void> }).buildFromD1Rows();

    const objects = (doInstance as unknown as { ydoc: Y.Doc }).ydoc.getArray<Y.Map<unknown>>("objects");
    expect(objects.length).toBe(1);
    const o = objects.get(0);
    expect((o.get("object_type") as Y.Text).toString()).toBe("photograph");
    expect((o.get("subjects") as Y.Text).toString()).toBe("agriculture");
    expect((o.get("source") as Y.Text).toString()).toBe("Archivo X");
    expect((o.get("credit") as Y.Text).toString()).toBe("Photo by Megan");
  });
});

// ---------------------------------------------------------------------------
// Blob-gap backfill — existing projects restore the Y.Doc from the stored blob
// (NOT buildFromD1Rows), and old blobs lack the new object Y.Text keys. The
// backfill seeds them from D1 on load so getYText() stops returning null and
// the snapshot doesn't clobber D1 with empty/default values.
// ---------------------------------------------------------------------------

describe("backfillBlobGaps repairs object Y.Maps restored from an old blob", () => {
  it("seeds object_type/subjects/source/credit (as Y.Text) from D1 onto an object lacking them", async () => {
    const objectRow = {
      id: 5,
      object_type: "photograph",
      subjects: "agriculture",
      source: "Archivo X",
      credit: "Courtesy of Neogranadina",
      thumbnail: "t.jpg",
      dimensions: "10x10",
      extra_columns: "{}",
    };
    const { doInstance } = makeDO((sql) => {
      if (sql.includes("FROM objects")) return [objectRow];
      return [];
    });
    // Old-blob object Y.Map: has the original fields but NONE of the four new ones.
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const o = new Y.Map<unknown>();
      o.set("_id", 5);
      o.set("object_id", "potatourpu");
      o.set("title", new Y.Text("Potato"));
      ydoc.getArray<Y.Map<unknown>>("objects").push([o]);
    }, null);

    await (doInstance as unknown as { backfillBlobGaps: () => Promise<void> }).backfillBlobGaps();

    const o = ydoc.getArray<Y.Map<unknown>>("objects").get(0);
    expect((o.get("credit") as Y.Text).toString()).toBe("Courtesy of Neogranadina");
    expect((o.get("object_type") as Y.Text).toString()).toBe("photograph");
    expect((o.get("subjects") as Y.Text).toString()).toBe("agriculture");
    expect((o.get("source") as Y.Text).toString()).toBe("Archivo X");
    expect(o.get("thumbnail")).toBe("t.jpg");
  });

  it("does NOT clobber a field a user has already edited in the live doc", async () => {
    const { doInstance } = makeDO((sql) => {
      if (sql.includes("FROM objects")) return [{ id: 5, credit: "stale D1 value" }];
      return [];
    });
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      const o = new Y.Map<unknown>();
      o.set("_id", 5);
      o.set("object_id", "potatourpu");
      o.set("credit", new Y.Text("live edit")); // already present
      ydoc.getArray<Y.Map<unknown>>("objects").push([o]);
    }, null);

    await (doInstance as unknown as { backfillBlobGaps: () => Promise<void> }).backfillBlobGaps();

    const o = ydoc.getArray<Y.Map<unknown>>("objects").get(0);
    expect((o.get("credit") as Y.Text).toString()).toBe("live edit");
  });
});

// ---------------------------------------------------------------------------
// Config — collection_mode round-trips through load + snapshot
// ---------------------------------------------------------------------------

describe("config collection_mode round-trips through the snapshot", () => {
  it("buildFromD1Rows restores collection_mode from D1 onto the config Y.Map", async () => {
    const configRow = {
      id: 1,
      project_id: TEST_PROJECT_ID,
      title: "Site",
      lang: "en",
      collection_mode: 1,
      show_object_credits: 1,
    };
    const { doInstance } = makeDO((sql) => {
      if (sql.includes("FROM project_config")) return [configRow];
      return [];
    });

    await (doInstance as unknown as { buildFromD1Rows: () => Promise<void> }).buildFromD1Rows();

    const config = (doInstance as unknown as { ydoc: Y.Doc }).ydoc.getMap("config");
    expect(config.get("collection_mode")).toBe(true);
  });

  it("backfillBlobGaps seeds collection_mode onto a blob-restored config Y.Map from D1", async () => {
    const { doInstance } = makeDO((sql) => {
      if (sql.includes("FROM project_config")) return [{ id: 1, collection_mode: 1 }];
      return [];
    });
    // Simulate a blob-restored config Y.Map that lacks collection_mode (old code
    // never wrote the key).
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => {
      ydoc.getMap("config").set("title", new Y.Text("Site"));
    }, null);

    await (doInstance as unknown as { backfillBlobGaps: () => Promise<void> }).backfillBlobGaps();

    expect(ydoc.getMap("config").get("collection_mode")).toBe(true);
  });

  it("snapshotToD1 binds collection_mode into the config UPSERT", async () => {
    // project_config row exists (first() returns an id) → UPDATE path.
    const { doInstance, binds } = makeDO((sql) => {
      if (/SELECT id FROM project_config WHERE project_id/.test(sql)) return [{ id: 1 }];
      return [];
    });
    const config = (doInstance as unknown as { ydoc: Y.Doc }).ydoc.getMap("config");
    (doInstance as unknown as { ydoc: Y.Doc }).ydoc.transact(() => {
      config.set("title", new Y.Text("Site"));
      config.set("collection_mode", true);
    }, null);

    await (doInstance as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();

    const cfgWrite = binds.find(
      (b) => /project_config/.test(b.sql) && /collection_mode/.test(b.sql),
    );
    expect(cfgWrite).toBeDefined();
  });
});
