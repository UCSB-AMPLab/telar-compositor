/**
 * The `objects.order` and `objects.sheet` arms of `/ingest-sync`, over the real
 * collaboration object.
 *
 * `order` names the rows a sync pairs with GitHub's, by key and D1 id, in
 * GitHub's order; the document re-keys them to it and the snapshot writes the
 * keys to D1. `sheet` is GitHub's file in order, and places each row the same
 * ingest inserts between the rows GitHub has either side of it. The order
 * runs after the updates and before the inserts, so the held rows are already
 * in GitHub's order when a new row is placed among them.
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
import { signInternalMarker } from "../workers/auth";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { PROJECT_ID, SECRET, buildDoc, proseFields, seedProject } from "./helpers/collaboration-fixture";
import { orderedMaps } from "~/lib/field-order";

let memory: MemoryD1;
let doInstance: ProjectCollaborationDO;

function makeCtx() {
  const storage = new Map<string, unknown>();
  return {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : storage.get(key)),
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        const entries = typeof key === "string" ? { [key]: value } : key;
        for (const [k, v] of Object.entries(entries)) storage.set(k, structuredClone(v));
      },
      list: async (options?: { prefix?: string }) =>
        new Map([...storage].filter(([key]) => key.startsWith(options?.prefix ?? ""))),
      delete: async (keys: string | string[]) => {
        let n = 0;
        for (const key of Array.isArray(keys) ? keys : [keys]) if (storage.delete(key)) n += 1;
        return n;
      },
    },
    acceptWebSocket: vi.fn(),
  };
}

/**
 * A project whose objects are `rows` (after the fixture's o1, which is
 * removed), in D1 and in the document alike, each with the key given.
 */
async function loadWith(rows: Array<[number, string, string]>): Promise<void> {
  memory.raw.exec("DELETE FROM objects");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, buildDoc(true));
  const arr = doc.getArray<Y.Map<unknown>>("objects");
  doc.transact(() => {
    arr.delete(0, arr.length);
    for (const [id, objectId, key] of rows) {
      memory.raw
        .prepare("INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (?, ?, ?, ?, ?)")
        .run(id, PROJECT_ID, objectId, key, `Title ${objectId}`);
      const m = new Y.Map<unknown>();
      m.set("_id", id);
      m.set("object_id", objectId);
      m.set("order_key", key);
      m.set("_validation_state", "valid");
      for (const { key: field } of proseFields("objects")) m.set(field, new Y.Text(field === "title" ? `Title ${objectId}` : ""));
      arr.push([m]);
    }
  });
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(Y.encodeStateAsUpdate(doc), PROJECT_ID);
  doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
}

function ydoc(): Y.Doc {
  return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
}

function docOrder(): string[] {
  return orderedMaps(ydoc().getArray("objects")).map((m) => String(m.get("object_id")));
}

function d1Order(): string[] {
  return (memory.raw.prepare("SELECT object_id FROM objects ORDER BY order_key, id").all() as Array<{ object_id: string }>)
    .map((r) => r.object_id);
}

async function ingest(body: unknown): Promise<Record<string, unknown>> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, SECRET, "ingest-sync");
  const res = await doInstance.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function insertOf(objectId: string) {
  return { object_id: objectId, title: `Title ${objectId}`, created_by: 1, image_available: false };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  seedProject(memory, "text");
});

afterEach(() => {
  memory.close();
});

describe("the objects.order arm", () => {
  it("puts the rows in the arm's order, and the snapshot writes the keys to D1", async () => {
    await loadWith([[1, "a", "a1"], [2, "b", "a2"], [3, "c", "a3"]]);

    const answer = await ingest({
      objects: {
        update: [], insert: [], remove: [],
        order: [{ objectId: "c", docId: 3 }, { objectId: "a", docId: 1 }, { objectId: "b", docId: 2 }],
      },
    });

    expect(docOrder()).toEqual(["c", "a", "b"]);
    expect(d1Order()).toEqual(["c", "a", "b"]);
    expect(answer).toMatchObject({ applied: { objectOrder: 1 } });
  });

  it("answers an entry whose row was re-created under another D1 id as superseded, and orders the rest", async () => {
    await loadWith([[1, "a", "a1"], [2, "b", "a2"], [3, "c", "a3"]]);

    const answer = await ingest({
      objects: {
        update: [], insert: [], remove: [],
        order: [{ objectId: "c", docId: 3 }, { objectId: "b", docId: 2 }, { objectId: "a", docId: 99 }],
      },
    });

    expect(answer).toMatchObject({ skipped: { objectOrder: ["a"] }, superseded: { objectOrder: ["a"] } });
    // c and b are ordered among themselves in the slots they held.
    expect(docOrder()).toEqual(["a", "c", "b"]);
  });

  it("answers an entry no row holds as skipped and not superseded", async () => {
    await loadWith([[1, "a", "a1"], [2, "b", "a2"]]);

    const answer = await ingest({
      objects: { update: [], insert: [], remove: [], order: [{ objectId: "gone", docId: 7 }, { objectId: "b", docId: 2 }] },
    });

    expect(answer).toMatchObject({ skipped: { objectOrder: ["gone"] }, superseded: { objectOrder: [] } });
  });

  it("leaves out an entry refused at the boundary and still orders the others", async () => {
    await loadWith([[1, "a", "a1"], [2, "b", "a2"], [3, "c", "a3"]]);

    const answer = await ingest({
      objects: {
        update: [], insert: [], remove: [],
        order: [{ objectId: "c", docId: 3 }, { objectId: "b", docId: "two" }, { objectId: "a", docId: 1 }],
      },
    });

    expect(answer).toMatchObject({ refused: { objectOrder: [1] } });
    // c and a swap into each other's slots; b keeps its own.
    expect(docOrder()).toEqual(["c", "b", "a"]);
  });
});

describe("the objects.sheet arm places the rows the ingest inserts", () => {
  it("places a new row between the held rows GitHub has either side of it", async () => {
    await loadWith([[1, "a", "a1"], [2, "b", "a2"]]);

    await ingest({
      objects: {
        update: [], insert: [insertOf("new")], remove: [],
        sheet: [{ objectId: "a", docId: 1 }, { objectId: "new" }, { objectId: "b", docId: 2 }],
      },
    });

    expect(docOrder()).toEqual(["a", "new", "b"]);
    expect(d1Order()).toEqual(["a", "new", "b"]);
  });

  it("orders the held rows before it places a new row among them", async () => {
    await loadWith([[1, "a", "a1"], [2, "b", "a2"], [3, "c", "a3"]]);

    // GitHub: c, new, a, b.
    await ingest({
      objects: {
        update: [], insert: [insertOf("new")], remove: [],
        order: [{ objectId: "c", docId: 3 }, { objectId: "a", docId: 1 }, { objectId: "b", docId: 2 }],
        sheet: [{ objectId: "c", docId: 3 }, { objectId: "new" }, { objectId: "a", docId: 1 }, { objectId: "b", docId: 2 }],
      },
    });

    expect(docOrder()).toEqual(["c", "new", "a", "b"]);
  });

  it("keeps GitHub's order for a run of new rows", async () => {
    await loadWith([[1, "a", "a1"], [2, "b", "a2"]]);

    await ingest({
      objects: {
        update: [], insert: [insertOf("n1"), insertOf("n2"), insertOf("n3")], remove: [],
        sheet: [{ objectId: "a", docId: 1 }, { objectId: "n1" }, { objectId: "n2" }, { objectId: "n3" }, { objectId: "b", docId: 2 }],
      },
    });

    expect(docOrder()).toEqual(["a", "n1", "n2", "n3", "b"]);
  });

  it("appends an insert with no entry in the sheet", async () => {
    await loadWith([[1, "a", "a1"], [2, "b", "a2"]]);

    await ingest({
      objects: {
        update: [], insert: [insertOf("image-file")], remove: [],
        sheet: [{ objectId: "b", docId: 2 }, { objectId: "a", docId: 1 }],
      },
    });

    expect(docOrder()).toEqual(["a", "b", "image-file"]);
  });

  it("appends every insert of an ingest that carries no sheet", async () => {
    await loadWith([[1, "a", "a1"], [2, "b", "a2"]]);

    await ingest({ objects: { update: [], insert: [insertOf("upload")], remove: [] } });

    expect(docOrder()).toEqual(["a", "b", "upload"]);
  });
});
