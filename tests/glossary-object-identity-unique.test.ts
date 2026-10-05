/**
 * Glossary term ids and object ids are unique within a project in D1:
 * objects(project_id, object_id) by migration 0071, and
 * glossary_terms(project_id, term_id) by migration 0072 for every id but a
 * held one (blank, or opening `#`), which publishes no term and may repeat.
 *
 * The collaboration object is the only writer of either table during editing,
 * so it has to keep a duplicate the document can hold — two clients each
 * creating `untitled-term` — from reaching D1, and it has to write renames,
 * swaps and a key taken over from a deleted row in an order the indexes
 * accept: the snapshot batch is atomic, and one refused statement discards
 * every entity's writes.
 *
 * Every case runs the real object against the migration chain in memory.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
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

import { asD1, createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";
import { PROJECT_ID, SECRET, proseFields, seedEmptyProject, snapshot } from "./helpers/collaboration-fixture";
import { makeUniqueTermId } from "~/lib/glossary-slug";
import { ProjectCollaborationDO } from "../workers/collaboration";

let opened: MemoryD1[] = [];
afterEach(() => {
  for (const memory of opened) memory.close();
  opened = [];
});

function database(): MemoryD1 {
  const memory = createMemoryD1();
  opened.push(memory);
  seedEmptyProject(memory);
  return memory;
}

type Entry = { id: number | null; key: string; title?: string };

function termMap(e: Entry, order: number): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", e.id);
  m.set("_temp_id", `temp-${order}`);
  m.set("term_id", e.key);
  m.set("order_key", `a${String(order).padStart(5, "0")}`);
  for (const { key } of proseFields("glossary")) m.set(key, new Y.Text(key === "title" ? (e.title ?? e.key) : ""));
  return m;
}

function objectMap(e: Entry, order: number): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set("_id", e.id);
  m.set("_temp_id", `temp-${order}`);
  m.set("object_id", e.key);
  m.set("order_key", `a${String(order).padStart(5, "0")}`);
  m.set("_validation_state", "valid");
  for (const { key } of proseFields("objects")) m.set(key, new Y.Text(key === "title" ? (e.title ?? e.key) : ""));
  return m;
}

/** A blob holding these terms and objects, and nothing else the snapshot writes. */
function blob(terms: Entry[], objects: Entry[] = []): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>("glossary").push(terms.map((t, i) => termMap(t, i + 1)));
    doc.getArray<Y.Map<unknown>>("objects").push(objects.map((o, i) => objectMap(o, i + 1)));
  });
  return Y.encodeStateAsUpdate(doc);
}

function seedTerms(memory: MemoryD1, rows: Array<[number, string]>): void {
  const insert = memory.raw.prepare(
    "INSERT INTO glossary_terms (id, project_id, term_id, order_key, title, definition) VALUES (?, ?, ?, ?, ?, '')",
  );
  for (const [id, key] of rows) insert.run(id, PROJECT_ID, key, `a${String(id).padStart(5, "0")}`, key);
}

function seedObjects(memory: MemoryD1, rows: Array<[number, string]>): void {
  const insert = memory.raw.prepare(
    "INSERT INTO objects (id, project_id, object_id, order_key, title) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [id, key] of rows) insert.run(id, PROJECT_ID, key, `a${String(id).padStart(5, "0")}`, key);
}

const heldTerms = (memory: MemoryD1) =>
  (memory.raw.prepare("SELECT id, term_id FROM glossary_terms ORDER BY id").all() as Array<{ id: number; term_id: string }>)
    .map((r) => `${r.id}:${r.term_id}`);
const heldObjects = (memory: MemoryD1) =>
  (memory.raw.prepare("SELECT id, object_id, title FROM objects ORDER BY id").all() as Array<{ id: number; object_id: string; title: string }>)
    .map((r) => `${r.id}:${r.object_id}:${r.title}`);

/**
 * `loadProject` from the fixture, without its `locate`: these documents hold
 * no story for it to find.
 */
async function loadProject(memory: MemoryD1, state: Uint8Array): Promise<{ doInstance: ProjectCollaborationDO }> {
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(state, PROJECT_ID);
  const ctx = {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
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
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  return { doInstance };
}

const ydocOf = (d: ProjectCollaborationDO) => (d as unknown as { ydoc: Y.Doc }).ydoc;
const docKeys = (d: ProjectCollaborationDO, root: string, field: string) =>
  ydocOf(d).getArray<Y.Map<unknown>>(root).toArray().map((m) => m.get(field));

/**
 * What one client does on "New term": `addGlossaryTerm` in
 * use-structural-ops.ts, which dedupes against the terms that client sees.
 */
function clientAddsTerm(client: Y.Doc, title: string): void {
  client.transact(() => {
    const glossary = client.getArray<Y.Map<unknown>>("glossary");
    const existing = glossary.toArray().map((m) => m.get("term_id")).filter((v): v is string => typeof v === "string");
    const m = termMap({ id: null, key: makeUniqueTermId(title, existing), title: "" }, glossary.length + 1);
    m.set("_temp_id", crypto.randomUUID());
    glossary.push([m]);
  });
}

function clientOf(server: Y.Doc): Y.Doc {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  return client;
}

describe("two clients creating a term at once", () => {
  it("end with distinct term ids in the document and in D1 after a snapshot", async () => {
    const memory = database();
    const { doInstance } = await loadProject(memory, blob([]));
    const server = ydocOf(doInstance);
    const a = clientOf(server);
    const b = clientOf(server);
    const before = Y.encodeStateVector(server);
    clientAddsTerm(a, "untitled term");
    clientAddsTerm(b, "untitled term");
    Y.applyUpdate(server, Y.encodeStateAsUpdate(a, before));
    Y.applyUpdate(server, Y.encodeStateAsUpdate(b, before));
    expect(docKeys(doInstance, "glossary", "term_id")).toEqual(["untitled-term", "untitled-term"]);

    await snapshot(doInstance);

    expect(heldTerms(memory).map((r) => r.split(":")[1]).sort()).toEqual(["untitled-term", "untitled-term-2"]);
    expect([...docKeys(doInstance, "glossary", "term_id")].sort()).toEqual(["untitled-term", "untitled-term-2"]);
  });
});

describe("a document loaded holding a duplicate term id", () => {
  it("is repaired before anyone is admitted, keeping the id on the term D1 holds it under", async () => {
    const memory = database();
    seedTerms(memory, [[1, "untitled-term"]]);
    const { doInstance } = await loadProject(memory, blob([
      { id: null, key: "untitled-term" },
      { id: 1, key: "untitled-term" },
    ]));

    const ids = ydocOf(doInstance).getArray<Y.Map<unknown>>("glossary").toArray()
      .map((m) => `${m.get("_id")}:${m.get("term_id")}`);
    expect(ids).toEqual(["null:untitled-term-2", "1:untitled-term"]);
  });

  it("leaves migration 0072's index buildable after one load and snapshot, the lower D1 id keeping the id", async () => {
    const memory = database();
    // A database from before 0072, holding the pair concurrent creation left.
    memory.raw.exec("DROP INDEX glossary_terms_project_term_unique");
    seedTerms(memory, [[7, "untitled-term"], [3, "untitled-term"]]);
    const { doInstance } = await loadProject(memory, blob([
      { id: 7, key: "untitled-term" },
      { id: 3, key: "untitled-term" },
    ]));
    await snapshot(doInstance);

    expect(heldTerms(memory)).toEqual(["3:untitled-term", "7:untitled-term-2"]);
    expect(() => memory.raw.exec(
      "CREATE UNIQUE INDEX glossary_terms_project_term_unique ON glossary_terms(project_id, term_id) " +
      "WHERE trim(term_id) <> '' AND substr(trim(term_id), 1, 1) <> '#'",
    )).not.toThrow();
  });
});

describe("held term ids", () => {
  it("are never re-keyed and may repeat, at load and through a snapshot", async () => {
    const memory = database();
    seedTerms(memory, [[1, "#note"], [2, "#note"], [3, ""], [4, ""], [5, "  #x"], [6, "  #x"]]);
    const keys = ["#note", "#note", "", "", "  #x", "  #x"];
    const { doInstance } = await loadProject(memory, blob(keys.map((key, i) => ({ id: i + 1, key }))));
    expect(docKeys(doInstance, "glossary", "term_id")).toEqual(keys);

    await snapshot(doInstance);

    expect(docKeys(doInstance, "glossary", "term_id")).toEqual(keys);
    expect(heldTerms(memory)).toEqual(keys.map((key, i) => `${i + 1}:${key}`));
  });
});

describe("the snapshot under the identity indexes", () => {
  it("lets a new term take the id of a term deleted in the same window", async () => {
    const memory = database();
    seedTerms(memory, [[1, "untitled-term"]]);
    const { doInstance } = await loadProject(memory, blob([{ id: 1, key: "untitled-term" }]));
    const glossary = ydocOf(doInstance).getArray<Y.Map<unknown>>("glossary");
    ydocOf(doInstance).transact(() => {
      glossary.delete(0, 1);
      glossary.push([termMap({ id: null, key: "untitled-term", title: "New" }, 2)]);
    }, null);

    await snapshot(doInstance);

    const rows = memory.raw.prepare("SELECT id, term_id, title FROM glossary_terms").all() as Array<{ id: number; term_id: string; title: string }>;
    expect(rows.map((r) => `${r.term_id}:${r.title}`)).toEqual(["untitled-term:New"]);
    expect(rows[0].id).not.toBe(1);
    expect(glossary.get(0).get("_id")).toBe(rows[0].id);
  });

  it("lands two terms exchanging ids", async () => {
    const memory = database();
    seedTerms(memory, [[1, "a"], [2, "b"]]);
    const { doInstance } = await loadProject(memory, blob([{ id: 1, key: "a" }, { id: 2, key: "b" }]));
    const [one, two] = ydocOf(doInstance).getArray<Y.Map<unknown>>("glossary").toArray();
    ydocOf(doInstance).transact(() => { one.set("term_id", "b"); two.set("term_id", "a"); }, null);

    await snapshot(doInstance);

    expect(heldTerms(memory)).toEqual(["1:b", "2:a"]);
  });

  it("lands two objects exchanging ids, and a rename onto the id of an object deleted in the same window", async () => {
    const memory = database();
    seedObjects(memory, [[1, "a"], [2, "b"], [3, "c"], [4, "d"]]);
    const { doInstance } = await loadProject(memory, blob([], [
      { id: 1, key: "a" }, { id: 2, key: "b" }, { id: 3, key: "c" }, { id: 4, key: "d" },
    ]));
    const objects = ydocOf(doInstance).getArray<Y.Map<unknown>>("objects");
    ydocOf(doInstance).transact(() => {
      objects.get(0).set("object_id", "b");
      objects.get(1).set("object_id", "a");
      objects.get(2).set("object_id", "d");
      objects.delete(3, 1);
    }, null);

    await snapshot(doInstance);

    expect(heldObjects(memory)).toEqual(["1:b:a", "2:a:b", "3:d:c"]);
  });

  it("does not fail when an UPDATE's id is still held, and writes everything else", async () => {
    const memory = database();
    seedObjects(memory, [[1, "a"], [2, "b"]]);
    const { doInstance } = await loadProject(memory, blob([], [{ id: 1, key: "a" }, { id: 2, key: "b" }]));
    const objects = ydocOf(doInstance).getArray<Y.Map<unknown>>("objects");
    // An empty id is outside every dedupe, so two objects can state one.
    ydocOf(doInstance).transact(() => {
      objects.get(0).set("object_id", "");
      objects.get(1).set("object_id", "");
      (objects.get(1).get("title") as Y.Text).insert(0, "edited ");
    }, null);

    await snapshot(doInstance);

    // The first UPDATE takes the empty id; the second finds it held and the
    // row keeps its own, while its title edit still lands.
    expect(heldObjects(memory)).toEqual(["1::a", "2:b:edited b"]);
  });

  it("lands a swap beside a term whose id is the shape a parked row once took", async () => {
    const memory = database();
    seedTerms(memory, [[1, "a"], [2, "b"], [3, "~1"]]);
    const { doInstance } = await loadProject(memory, blob([{ id: 1, key: "a" }, { id: 2, key: "b" }, { id: 3, key: "~1" }]));
    const [one, two] = ydocOf(doInstance).getArray<Y.Map<unknown>>("glossary").toArray();
    ydocOf(doInstance).transact(() => { one.set("term_id", "b"); two.set("term_id", "a"); }, null);

    await snapshot(doInstance);

    expect(heldTerms(memory)).toEqual(["1:b", "2:a", "3:~1"]);
  });

  it("lands an object swap beside an object whose id is the shape a parked row once took", async () => {
    const memory = database();
    seedObjects(memory, [[1, "a"], [2, "b"], [3, "~1"]]);
    const { doInstance } = await loadProject(memory, blob([], [{ id: 1, key: "a" }, { id: 2, key: "b" }, { id: 3, key: "~1" }]));
    const objects = ydocOf(doInstance).getArray<Y.Map<unknown>>("objects");
    ydocOf(doInstance).transact(() => { objects.get(0).set("object_id", "b"); objects.get(1).set("object_id", "a"); }, null);

    await snapshot(doInstance);

    expect(heldObjects(memory)).toEqual(["1:b:a", "2:a:b", "3:~1:~1"]);
  });

  it("leaves no parking key in D1 when a rename's id stays held by an object the snapshot skips", async () => {
    const memory = database();
    seedObjects(memory, [[1, "a"], [2, "b"], [3, "c"], [4, "d"], [5, "e"]]);
    const { doInstance } = await loadProject(memory, blob([], [
      { id: 1, key: "a" }, { id: 2, key: "b" }, { id: 3, key: "c" }, { id: 4, key: "d" }, { id: 5, key: "e" },
    ]));
    const objects = ydocOf(doInstance).getArray<Y.Map<unknown>>("objects");
    ydocOf(doInstance).transact(() => {
      // Object 3 is renamed and withheld from this snapshot by a flag no
      // reader takes, so D1 keeps it at `c` through the batch: 1 cannot take
      // `c`, and 2 cannot take 1's `a`. 4 and 5 exchange ids, which parks
      // the rows that can move.
      objects.get(2).set("object_id", "z");
      objects.get(2).set("featured", "not-a-flag");
      objects.get(0).set("object_id", "c");
      objects.get(1).set("object_id", "a");
      objects.get(3).set("object_id", "e");
      objects.get(4).set("object_id", "d");
    }, null);

    await snapshot(doInstance);

    expect(heldObjects(memory).map((r) => r.split(":").slice(0, 2).join(":"))).toEqual(["1:a", "2:b", "3:c", "4:e", "5:d"]);
  });

  it("leaves no placeholder in D1 when a new term's id stays held through the batch", async () => {
    const memory = database();
    seedTerms(memory, [[1, "a"]]);
    const { doInstance } = await loadProject(memory, blob([]));
    const glossary = ydocOf(doInstance).getArray<unknown>("glossary");
    // An entry the snapshot cannot read suspends the orphan sweep, so term 1
    // keeps `a` though the document no longer holds it.
    ydocOf(doInstance).transact(() => {
      glossary.push(["not a term"]);
      glossary.push([termMap({ id: null, key: "a", title: "New" }, 2)]);
    }, null);

    await snapshot(doInstance);

    expect(heldTerms(memory)).toEqual(["1:a"]);
  });

  it("parks nothing for a rename onto the empty id a withheld object still holds, across snapshots", async () => {
    const memory = database();
    seedObjects(memory, [[1, "a"], [2, "b"], [3, ""]]);
    const { doInstance } = await loadProject(memory, blob([], [{ id: 1, key: "a" }, { id: 2, key: "b" }, { id: 3, key: "" }]));
    const objects = ydocOf(doInstance).getArray<Y.Map<unknown>>("objects");
    ydocOf(doInstance).transact(() => {
      // Object 3 is withheld, so D1 keeps it at "": 1 cannot take "", so it
      // keeps `a`, and 2 cannot take `a`. Both renames wait for a snapshot
      // that finds their ids free.
      objects.get(0).set("object_id", "");
      objects.get(1).set("object_id", "a");
      objects.get(2).set("object_id", "z");
      objects.get(2).set("featured", "not-a-flag");
    }, null);

    await snapshot(doInstance);
    const first = heldObjects(memory).map((r) => r.split(":").slice(0, 2).join(":"));
    await snapshot(doInstance);
    const second = heldObjects(memory).map((r) => r.split(":").slice(0, 2).join(":"));

    expect(first).toEqual(["1:a", "2:b", "3:"]);
    expect(second).toEqual(["1:a", "2:b", "3:"]);
  });
});

