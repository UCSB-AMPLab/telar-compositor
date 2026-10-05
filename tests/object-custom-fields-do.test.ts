/**
 * The Durable Object's side of per-field custom fields: the load
 * converts each object's `extra_columns` string to a `custom_fields` map and
 * folds in a whole blob a browser on the previous bundle wrote; the load's
 * promotion and the sync ingest write a whole blob field by field, so an edit
 * landing beside them stands; and the snapshot writes the map as the same D1
 * blob, byte for byte the stored one for an object nobody edited.
 *
 * Edits made in a browser are made here as the page makes them, on a Y.Text
 * of the map in another copy of the document.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

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
import { applyCustomBlob, customFieldsOf } from "~/lib/object-custom-map";
import { makeObjectYMap } from "~/lib/object-ymap";
import { markLoaded } from "./helpers/claimed-document";
import { signInternalMarker } from "../workers/auth";

interface CustomFieldBind {
  sql: string;
  args: unknown[];
}

/**
 * A loaded DO whose D1 holds objects 5 and 6, recording every bind. `restoring`
 * leaves it in the phase a load replays its log in, where the log is not written.
 */
function customFieldsDO(restoring = false) {
  const binds: CustomFieldBind[] = [];
  const customFieldRows = (sql: string) =>
    /SELECT id(?:, object_id)? FROM objects WHERE project_id/.test(sql)
      ? [{ id: 5, object_id: "o5" }, { id: 6, object_id: "o6" }]
      : [];
  const customFieldStatement = (sql: string) => ({
    bind(...args: unknown[]) {
      binds.push({ sql, args });
      return {
        run: async () => ({ meta: { last_row_id: 100, changes: 1 } }),
        all: async <T>() => ({ results: customFieldRows(sql) as T[] }),
        first: async <T>() => (customFieldRows(sql)[0] ?? null) as T | null,
      };
    },
  });
  const sent: Uint8Array[] = [];
  const peers: unknown[] = [];
  const ctx = {
    getWebSockets: () => peers,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const env = { DB: { prepare: customFieldStatement, batch: async () => [] }, SESSION_SECRET: "s", COLLABORATION: {} };
  const instance = new ProjectCollaborationDO(ctx as never, env as never);
  (instance as unknown as { projectId: number }).projectId = 42;
  markLoaded(instance);
  (instance as unknown as { logSuppressed: boolean }).logSuppressed = restoring;
  // Connected after construction, which reads a waking socket's attachment.
  peers.push({ send: (msg: Uint8Array) => sent.push(msg), deserializeAttachment: () => null });
  const priv = instance as unknown as {
    ydoc: Y.Doc;
    documentRepairs: () => void;
    promoteModelledObjectExtras: () => void;
    applyObjectUpdate: (m: Y.Map<unknown>, upd: { fields: Record<string, string> }) => void;
    buildObjectYMap: (p: unknown, orderKey: string) => Y.Map<unknown>;
    snapshotToD1: () => Promise<void>;
  };
  async function snapshotted(): Promise<CustomFieldBind[]> {
    binds.length = 0;
    await priv.snapshotToD1();
    return binds;
  }
  return {
    doc: priv.ydoc,
    /** What the peers have been sent. */
    sent,
    /** POST one `/ingest-sync` payload, as the sync apply sends it. */
    async postIngest(payload: unknown): Promise<{ status: number; report: { applied: Record<string, number>; heldBack?: boolean } }> {
      const { sigHex, timestamp } = await signInternalMarker(42, "s", "ingest-sync");
      const res = await instance.fetch(
        new Request("https://internal/ingest-sync", {
          method: "POST",
          headers: {
            "X-Internal-Auth": sigHex,
            "X-Internal-Timestamp": String(timestamp),
            "X-Internal-Project": "42",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }),
      );
      return { status: res.status, report: (await res.json()) as never };
    },
    repair: () => priv.documentRepairs(),
    /** An ingest insert's row awaiting its D1 row, as an earlier attempt left it. */
    pendingInsert: (p: unknown) => {
      const m = priv.buildObjectYMap(p, "a9");
      priv.ydoc.transact(() => priv.ydoc.getArray<Y.Map<unknown>>("objects").push([m]), null);
      return m;
    },
    promote: () => priv.promoteModelledObjectExtras(),
    ingestUpdate: (m: Y.Map<unknown>, blob: string) =>
      priv.ydoc.transact(() => priv.applyObjectUpdate(m, { fields: { extra_columns: blob } })),
    /** The `extra_columns` the next snapshot's UPDATE binds for object `id`. */
    async updatedBlob(id = 5): Promise<unknown> {
      const update = (await snapshotted()).find((b) => b.sql.includes("UPDATE objects SET") && b.args[b.args.length - 1] === id);
      expect(update, "no objects UPDATE was bound").toBeDefined();
      const at = update!.sql.slice(0, update!.sql.indexOf("extra_columns = ?")).split("?").length - 1;
      return update!.args[at];
    },
    /** The `extra_columns` the next snapshot's INSERT binds. */
    async insertedBlob(): Promise<unknown> {
      const insert = (await snapshotted()).find((b) => b.sql.includes("INSERT INTO objects"));
      expect(insert, "no objects INSERT was bound").toBeDefined();
      const columns = insert!.sql.replace(/^[\s\S]*?\(/, "").replace(/\)[\s\S]*$/, "").split(",").map((c) => c.trim());
      return insert!.args[columns.indexOf("extra_columns")];
    },
  };
}

/** An object as the cold load builds it from D1: `extra_columns` a plain string. */
function coldObject(doc: Y.Doc, id: number, blob: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  doc.transact(() => {
    m.set("_id", id);
    m.set("object_id", `o${id}`);
    m.set("title", new Y.Text(`Object ${id}`));
    m.set("extra_columns", blob);
    doc.getArray<Y.Map<unknown>>("objects").push([m]);
  }, null);
  return m;
}

function cloneDoc(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

function objectOf(doc: Y.Doc, id: number): Y.Map<unknown> {
  return doc.getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("_id") === id)!;
}

/** A browser's edit of one custom field, as the page binds it: delete and insert on its Y.Text. */
function editInCopy(doc: Y.Doc, key: string, value: string): Y.Doc {
  const copy = cloneDoc(doc);
  const text = customFieldsOf(objectOf(copy, 5))!.get(key)!;
  copy.transact(() => {
    text.delete(0, text.length);
    text.insert(0, value);
  });
  return copy;
}

const pair = JSON.stringify({ material: "wood", technique: "carved" });

describe("the load converts and folds", () => {
  it("gives each column its own Y.Text and the snapshot writes the stored blob byte for byte", async () => {
    // Restoring, as a cold load's repairs run: the load's own pass converts.
    const h = customFieldsDO(true);
    const stored = '{"b": "2", "a": 1, "n": null}';
    coldObject(h.doc, 5, stored);
    h.repair();
    const fields = customFieldsOf(objectOf(h.doc, 5))!;
    expect([...fields.keys()].sort()).toEqual(["a", "b", "n"]);
    expect(fields.get("a")).toBeInstanceOf(Y.Text);
    expect(fields.get("a")!.toString()).toBe("1");
    expect(fields.get("n")!.toString()).toBe("");
    const customBlobDigest = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(customBlobDigest((await h.updatedBlob()) as string)).toBe(customBlobDigest(stored));
  });

  it("writes nothing on a second load of a converted document", () => {
    const h = customFieldsDO();
    coldObject(h.doc, 5, pair);
    h.repair();
    const before = Y.encodeStateVector(h.doc);
    h.repair();
    expect(Y.encodeStateVector(h.doc)).toEqual(before);
  });

  it("the snapshot writes two edits to different fields made in two copies", async () => {
    const h = customFieldsDO();
    coldObject(h.doc, 5, pair);
    h.repair();
    const a = editInCopy(h.doc, "material", "oak");
    const b = editInCopy(h.doc, "technique", "inlaid");
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(b));
    expect(JSON.parse((await h.updatedBlob()) as string)).toEqual({ material: "oak", technique: "inlaid" });
  });

  it("the next snapshot carries a whole blob a browser on the previous bundle wrote, beside an edit made in the map", async () => {
    const h = customFieldsDO();
    coldObject(h.doc, 5, pair);
    h.repair();
    const current = editInCopy(h.doc, "material", "oak");
    const previous = cloneDoc(h.doc);
    objectOf(previous, 5).set("extra_columns", JSON.stringify({ material: "wood", technique: "inlaid" }));
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(current));
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(previous));
    expect(JSON.parse((await h.updatedBlob()) as string)).toEqual({ material: "oak", technique: "inlaid" });
  });
});

describe("a whole blob from an older browser is folded as it arrives", () => {
  it("a later edit to the same field in the map stands at the snapshot", async () => {
    const h = customFieldsDO();
    coldObject(h.doc, 5, pair);
    h.repair();
    const older = cloneDoc(h.doc);
    objectOf(older, 5).set("extra_columns", JSON.stringify({ material: "inlaid", technique: "carved" }));
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(older));
    expect(customFieldsOf(objectOf(h.doc, 5))!.get("material")!.toString()).toBe("inlaid");
    // The current browser has the older write and types after it.
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(editInCopy(h.doc, "material", "oak")));
    expect(JSON.parse((await h.updatedBlob()) as string)).toEqual({ material: "oak", technique: "carved" });
  });

  it("is not folded again when the log is replayed, so the replica holds the same text", () => {
    const live = customFieldsDO();
    coldObject(live.doc, 5, pair);
    live.repair();
    const start = Y.encodeStateAsUpdate(live.doc);
    const older = cloneDoc(live.doc);
    objectOf(older, 5).set("extra_columns", JSON.stringify({ material: "inlaid", technique: "carved" }));
    const payload = Y.encodeStateAsUpdate(older, Y.encodeStateVector(live.doc));
    // A message's records as the log holds them: the payload as received, then
    // each update the server's own transactions emitted while it was applied.
    const fromSocket = {};
    const records: Uint8Array[] = [payload];
    live.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin !== fromSocket) records.push(u);
    });
    Y.applyUpdate(live.doc, payload, fromSocket);
    expect(records.length).toBeGreaterThan(1);

    const replica = customFieldsDO(true);
    Y.applyUpdate(replica.doc, start);
    for (const record of records) Y.applyUpdate(replica.doc, record);
    expect(customFieldsOf(objectOf(replica.doc, 5))!.get("material")!.toString()).toBe("inlaid");
    expect(Y.encodeStateVector(replica.doc)).toEqual(Y.encodeStateVector(live.doc));
  });

  it("a column it adds has an empty entry on every other object at once", () => {
    const h = customFieldsDO();
    coldObject(h.doc, 5, JSON.stringify({ a: "1" }));
    coldObject(h.doc, 6, JSON.stringify({ a: "1" }));
    h.repair();
    const older = cloneDoc(h.doc);
    objectOf(older, 6).set("extra_columns", JSON.stringify({ a: "1", c: "3" }));
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(older));
    expect(customFieldsOf(objectOf(h.doc, 5))!.get("c")!.toString()).toBe("");
    expect(customFieldsOf(objectOf(h.doc, 6))!.get("c")!.toString()).toBe("3");
  });
});

describe("every object has an entry for every column before anyone types", () => {
  it("an object a browser on the previous bundle adds gets its map and entries as it lands", () => {
    const h = customFieldsDO();
    coldObject(h.doc, 5, JSON.stringify({ a: "1" }));
    h.repair();
    coldObject(h.doc, 7, JSON.stringify({ a: "1", d: "4" }));
    expect(customFieldsOf(objectOf(h.doc, 7))!.get("d")!.toString()).toBe("4");
    expect(customFieldsOf(objectOf(h.doc, 5))!.get("d")!.toString()).toBe("");
  });

  it("the snapshot converts an object no fold has reached", async () => {
    const h = customFieldsDO(true);
    coldObject(h.doc, 5, pair);
    expect(customFieldsOf(objectOf(h.doc, 5))).toBeNull();
    h.sent.length = 0;
    expect(await h.updatedBlob()).toBe(pair);
    expect(customFieldsOf(objectOf(h.doc, 5))!.get("material")!.toString()).toBe("wood");
    // The peers are sent the conversion.
    const peer = new Y.Doc();
    for (const msg of h.sent) {
      const decoder = decoding.createDecoder(msg);
      decoding.readVarUint(decoder);
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), peer, null);
    }
    expect(customFieldsOf(objectOf(peer, 5))?.get("material")?.toString()).toBe("wood");
  });

  it("the load gives an object an empty entry for a column it lacked, and two copies typing in it both keep their text", async () => {
    const h = customFieldsDO();
    const stored = JSON.stringify({ a: "1" });
    coldObject(h.doc, 5, stored);
    coldObject(h.doc, 6, JSON.stringify({ a: "1", b: "2" }));
    h.repair();
    expect(customFieldsOf(objectOf(h.doc, 5))!.get("b")!.toString()).toBe("");
    expect(await h.updatedBlob()).toBe(stored);
    const first = editInCopy(h.doc, "b", "oak");
    const second = editInCopy(h.doc, "b", "pine");
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(first));
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(second));
    const b = JSON.parse((await h.updatedBlob()) as string).b as string;
    expect(b).toContain("oak");
    expect(b).toContain("pine");
  });

  it("a column a sync ingest adds has its entry on every object at once, which writes nothing", async () => {
    const h = customFieldsDO();
    const stored = JSON.stringify({ a: "1" });
    coldObject(h.doc, 5, stored);
    coldObject(h.doc, 6, stored);
    h.repair();
    h.ingestUpdate(objectOf(h.doc, 6), JSON.stringify({ a: "1", c: "3" }));
    expect(customFieldsOf(objectOf(h.doc, 5))!.get("c")!.toString()).toBe("");
    expect(await h.updatedBlob(5)).toBe(stored);
  });
});

describe("whole-blob writes go field by field", () => {
  it("a sync ingest landing beside an editor's save keeps the save", async () => {
    const h = customFieldsDO();
    coldObject(h.doc, 5, pair);
    h.repair();
    const editor = editInCopy(h.doc, "material", "oak");
    h.ingestUpdate(objectOf(h.doc, 5), JSON.stringify({ material: "wood", technique: "inlaid" }));
    // In the field at once, not at the next snapshot.
    expect(customFieldsOf(objectOf(h.doc, 5))!.get("technique")!.toString()).toBe("inlaid");
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(editor));
    expect(JSON.parse((await h.updatedBlob()) as string)).toEqual({ material: "oak", technique: "inlaid" });
  });

  it("the load's promotion of a modelled column keeps an editor's save beside it", async () => {
    // Restoring, as a cold load's repairs run, so no arrival fold stands in for it.
    const h = customFieldsDO(true);
    const blob = JSON.stringify({ medium: "oil", material: "wood" });
    const m = coldObject(h.doc, 5, blob);
    // A map set before `medium` was modelled, so the promotion still has it to move.
    h.doc.transact(() => applyCustomBlob(m, blob), null);
    const editor = editInCopy(h.doc, "material", "oak");
    h.promote();
    expect(customFieldsOf(objectOf(h.doc, 5))!.has("medium")).toBe(false);
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(editor));
    expect(JSON.parse((await h.updatedBlob()) as string)).toEqual({ material: "oak" });
  });
});

describe("the sync's check of what the author reviewed", () => {
  it("reads an edited object's blob as the snapshot wrote it, so GitHub's change still applies", async () => {
    const h = customFieldsDO();
    coldObject(h.doc, 5, pair);
    h.repair();
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(editInCopy(h.doc, "material", "oak")));
    const inD1 = (await h.updatedBlob()) as string;
    const fromGitHub = JSON.stringify({ material: "oak", technique: "inlaid" });
    const { status, report } = await h.postIngest({
      objects: { update: [{ objectId: "o5", docId: 5, fields: { extra_columns: fromGitHub }, seen: { extra_columns: inD1 } }] },
    });
    expect(status).toBe(200);
    expect(report).toMatchObject({ applied: { objectUpdate: 1 }, changedSinceReview: { objectUpdate: [] } });
    expect(JSON.parse((await h.updatedBlob()) as string)).toEqual({ material: "oak", technique: "inlaid" });
  });
});

describe("the all-or-nothing apply's check", () => {
  it("reads an edited object's blob as the snapshot wrote it, and does not hold the apply back", async () => {
    const h = customFieldsDO();
    coldObject(h.doc, 5, pair);
    h.repair();
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(editInCopy(h.doc, "material", "oak")));
    const inD1 = (await h.updatedBlob()) as string;
    const { report } = await h.postIngest({
      allOrNothing: true,
      objects: { update: [{ objectId: "o5", docId: 5, fields: { extra_columns: pair }, seen: { extra_columns: inD1 } }] },
    });
    expect(report.heldBack).toBeFalsy();
    expect(report.applied.objectUpdate).toBe(1);
  });

  it("takes a retried insert's own row as the insert's until a custom field in it is edited", async () => {
    const insert = { object_id: "o7", title: "Seven", extra_columns: pair, created_by: null, origin: "repo" };
    const h = customFieldsDO();
    h.pendingInsert(insert);
    const retry = await h.postIngest({ allOrNothing: true, objects: { insert: [insert] } });
    expect(retry.report.heldBack).toBeFalsy();

    const edited = customFieldsDO();
    const own = edited.pendingInsert(insert);
    const text = customFieldsOf(own)!.get("material")!;
    edited.doc.transact(() => text.insert(0, "dark "));
    const held = await edited.postIngest({ allOrNothing: true, objects: { insert: [insert] } });
    expect(held.report.heldBack).toBe(true);
  });
});

describe("objects made in the browser", () => {
  it("carry the map from the start, and the INSERT writes it", async () => {
    const h = customFieldsDO();
    const m = makeObjectYMap({ objectId: "new", extraColumns: '{"x": "1", "y": "2"}', validationState: "valid", origin: "compositor", orderKey: "a0" });
    h.doc.transact(() => h.doc.getArray<Y.Map<unknown>>("objects").push([m]));
    const x = customFieldsOf(m)!.get("x")!;
    expect(x.toString()).toBe("1");
    h.doc.transact(() => x.insert(1, "0"));
    expect(await h.insertedBlob()).toBe('{"x":"10","y":"2"}');
  });
});
