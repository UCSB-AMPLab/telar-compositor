/**
 * `/ingest-sync`'s `objects.rename` arm: the document half of an
 * object's ID change, against the collaboration object and an in-memory D1
 * built from the migration chain.
 *
 * The arm finds its object by D1 row id; renames it with every step that names
 * one of the step values, its thumbnail and the text that names its file, in
 * one transaction; re-keys another object a client created under the new id
 * meanwhile; travels alone with an operation id; and earns its `renamed`
 * receipt only once D1 shows the new id under the row id after the flush.
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
import { PROJECT_ID, SECRET, buildDoc, locate, seedProject } from "./helpers/collaboration-fixture";

const RECEIPT_KEY = (opId: number) => `ingestReceipt:${opId}`;
const SITE = "https://example.org/site/iiif/objects/";

let memory: MemoryD1;
let storage: Map<string, unknown>;
let doInstance: ProjectCollaborationDO;

function objectRenameCtx() {
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

function renameDoc(): Y.Doc {
  return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
}

/** A second step on the seeded story, naming `objectId`, with a D1 row of its own. */
function seedSecondStep(objectId: string): void {
  memory.raw
    .prepare("INSERT INTO steps (id, story_id, step_number, order_key, kind, object_id) VALUES (2, 1, 2, 'a00002', 'media', ?)")
    .run(objectId);
}

/**
 * The fixture's document with the renamed object's references planted: the
 * first step names `o1`, the second `bell`; a layer, the page and the glossary
 * term each name `o1.jpg`; the object's thumbnail is its file.
 */
async function loadRenameDoc(): Promise<void> {
  memory = createMemoryD1();
  seedProject(memory, "text");
  seedSecondStep("bell");
  storage = new Map();
  const blob = buildDoc(true);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, blob);
  const maps = locate(doc);
  doc.transact(() => {
    maps.steps.set("object_id", "o1");
    const second = new Y.Map<unknown>();
    second.set("_id", 2);
    second.set("order_key", "a00002");
    second.set("kind", "media");
    second.set("object_id", "bell");
    second.set("layers", new Y.Array());
    (maps.stories.get("steps") as Y.Array<Y.Map<unknown>>).push([second]);
    replaceText(maps.layers.get("content") as Y.Text, "Intro. ![m](o1.jpg) Outro.");
    replaceText(maps.pages.get("body") as Y.Text, `![p](${SITE}o1/page-1/full/max/0/default.jpg)`);
    replaceText(maps.glossary.get("definition") as Y.Text, ":::carousel\nimage: o1.jpg\n:::");
    maps.objects.set("thumbnail", "telar-content/objects/o1.jpg");
  });
  memory.raw.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?").run(Y.encodeStateAsUpdate(doc), PROJECT_ID);
  doInstance = new ProjectCollaborationDO(
    objectRenameCtx() as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
}

function replaceText(text: Y.Text, value: string): void {
  text.delete(0, text.length);
  text.insert(0, value);
}

async function postRenameArm(body: unknown): Promise<{ status: number; body: Record<string, unknown> | string }> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, SECRET, "ingest-sync");
  const response = await doInstance.fetch(
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
  const text = await response.text();
  return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}

const RENAME = {
  from: "o1",
  to: "city-map",
  docId: 1,
  stepValues: ["o1"],
  rules: {
    moved: [{ from: "o1.jpg", to: "city-map.jpg" }],
    carouselShadowed: [],
    tiles: { from: `${SITE}o1/`, to: `${SITE}city-map/` },
    oldSiteId: "o1",
  },
};

const renameBody = (opId: number, entry: Record<string, unknown> = RENAME) => ({ opId, objects: { rename: [entry] } });

function objectsInDoc(): Array<{ id: unknown; objectId: unknown; thumbnail: unknown }> {
  return renameDoc().getArray<Y.Map<unknown>>("objects").toArray()
    .map((m) => ({ id: m.get("_id"), objectId: m.get("object_id"), thumbnail: m.get("thumbnail") }));
}

function stepValuesInDoc(): unknown[] {
  const story = renameDoc().getArray<Y.Map<unknown>>("stories").get(0);
  return (story.get("steps") as Y.Array<Y.Map<unknown>>).toArray().map((m) => m.get("object_id"));
}

function textsInDoc(): { layer: string; page: string; term: string } {
  const maps = locate(renameDoc());
  return {
    layer: String(maps.layers.get("content")),
    page: String(maps.pages.get("body")),
    term: String(maps.glossary.get("definition")),
  };
}

function renamedRowOf(id: number): { object_id: string; thumbnail: string | null } | undefined {
  return memory.raw.prepare("SELECT object_id, thumbnail FROM objects WHERE id = ?").get(id) as
    | { object_id: string; thumbnail: string | null }
    | undefined;
}

function plantInDoc(edit: (doc: Y.Doc) => void): void {
  renameDoc().transact(() => edit(renameDoc()), null);
}

function targetMap(): Y.Map<unknown> {
  return renameDoc().getArray<Y.Map<unknown>>("objects").toArray().find((m) => m.get("_id") === 1)!;
}

beforeEach(async () => {
  await loadRenameDoc();
});

afterEach(() => {
  memory.close();
});

describe("a rename that applies", () => {
  it("renames the object, its steps, its thumbnail and the text naming its file, and D1 follows", async () => {
    const answer = await postRenameArm(renameBody(41));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ renames: { applied: ["city-map"], displaced: [] } });

    expect(objectsInDoc()).toEqual([{ id: 1, objectId: "city-map", thumbnail: "telar-content/objects/city-map.jpg" }]);
    expect(stepValuesInDoc()).toEqual(["city-map", "bell"]);
    expect(textsInDoc()).toEqual({
      layer: "Intro. ![m](city-map.jpg) Outro.",
      page: `![p](${SITE}city-map/page-1/full/max/0/default.jpg)`,
      term: ":::carousel\nimage: city-map.jpg\n:::",
    });
    expect(renamedRowOf(1)).toEqual({ object_id: "city-map", thumbnail: "telar-content/objects/city-map.jpg" });
    const steps = memory.raw.prepare("SELECT id, object_id FROM steps ORDER BY id").all();
    expect(steps).toEqual([{ id: 1, object_id: "city-map" }, { id: 2, object_id: "bell" }]);
    expect(storage.get(RECEIPT_KEY(41))).toEqual({ inserted: [], removed: [], renamed: ["city-map"] });
  });

  it("edits the text at the match offsets, so a concurrent edit elsewhere in it is kept", async () => {
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(renameDoc()));
    const before = Y.encodeStateVector(client);
    const clientLayer = locate(client).layers.get("content") as Y.Text;
    client.transact(() => clientLayer.insert("Intro.".length, " Edited elsewhere."));
    const concurrent = Y.encodeStateAsUpdate(client, before);

    await postRenameArm(renameBody(42));
    renameDoc().transact(() => Y.applyUpdate(renameDoc(), concurrent), null);

    expect(textsInDoc().layer).toBe("Intro. Edited elsewhere. ![m](city-map.jpg) Outro.");
  });

  it("moves an imported audio object's source_url with its file, in the document and in D1", async () => {
    plantInDoc(() => targetMap().set("source_url", "o1.mp3"));
    const audio = { ...RENAME, rules: { ...RENAME.rules, moved: [{ from: "o1.mp3", to: "city-map.mp3" }] } };

    const answer = await postRenameArm(renameBody(44, audio));

    expect(answer.status).toBe(200);
    expect(targetMap().get("source_url")).toBe("city-map.mp3");
    const row = memory.raw.prepare("SELECT source_url FROM objects WHERE id = 1").get() as { source_url: string };
    expect(row.source_url).toBe("city-map.mp3");
  });

  it("leaves a source_url that is not a moved file's name", async () => {
    plantInDoc(() => targetMap().set("source_url", "https://example.org/iiif/manifest.json"));

    await postRenameArm(renameBody(45));

    expect(targetMap().get("source_url")).toBe("https://example.org/iiif/manifest.json");
  });

  it("re-keys another object holding the new id, clear of the document's and D1's keys, and names it", async () => {
    memory.raw.prepare("INSERT INTO objects (id, project_id, object_id, order_key) VALUES (9, ?, 'city-map-2', 'a00009')").run(PROJECT_ID);
    plantInDoc((doc) => {
      const born = new Y.Map<unknown>();
      born.set("_id", null);
      born.set("object_id", "city-map");
      born.set("order_key", "a00002");
      doc.getArray<Y.Map<unknown>>("objects").push([born]);
    });

    const answer = await postRenameArm(renameBody(43));

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      renames: { applied: ["city-map"], displaced: [{ docId: null, objectId: "city-map", rekeyedTo: "city-map-3" }] },
    });
    expect(objectsInDoc().map((o) => o.objectId)).toEqual(["city-map", "city-map-3"]);
    expect(renamedRowOf(1)?.object_id).toBe("city-map");
  });
});

describe("a displaced object's steps", () => {
  it("follow the displaced object to its new key, while the renamed object's steps name the new id", async () => {
    plantInDoc((doc) => {
      const born = new Y.Map<unknown>();
      born.set("_id", null);
      born.set("object_id", "city-map");
      born.set("order_key", "a00002");
      doc.getArray<Y.Map<unknown>>("objects").push([born]);
      const third = new Y.Map<unknown>();
      third.set("_id", 3);
      third.set("order_key", "a00003");
      third.set("kind", "media");
      third.set("object_id", "city-map");
      third.set("layers", new Y.Array());
      const story = doc.getArray<Y.Map<unknown>>("stories").get(0);
      (story.get("steps") as Y.Array<Y.Map<unknown>>).push([third]);
    });

    const answer = await postRenameArm(renameBody(47));

    expect(answer.body).toMatchObject({
      renames: { displaced: [{ objectId: "city-map", rekeyedTo: "city-map-2" }] },
    });
    expect(stepValuesInDoc()).toEqual(["city-map", "bell", "city-map-2"]);
  });
});

describe("a displaced object's new key", () => {
  it("is not a value the rename's step rewrite touches, so its steps stay with it", async () => {
    plantInDoc((doc) => {
      const objects = doc.getArray<Y.Map<unknown>>("objects");
      objects.get(0).set("object_id", "map-2.jpg");
      const born = new Y.Map<unknown>();
      born.set("_id", null);
      born.set("object_id", "map");
      born.set("order_key", "a00002");
      objects.push([born]);
      const story = doc.getArray<Y.Map<unknown>>("stories").get(0);
      const steps = story.get("steps") as Y.Array<Y.Map<unknown>>;
      steps.get(0).set("object_id", "map-2");
      const third = new Y.Map<unknown>();
      third.set("_id", 3);
      third.set("order_key", "a00003");
      third.set("kind", "media");
      third.set("object_id", "map");
      third.set("layers", new Y.Array());
      steps.push([third]);
    });
    const entry = {
      ...RENAME,
      from: "map-2.jpg",
      to: "map",
      stepValues: ["map-2.jpg", "map-2"],
      rules: { ...RENAME.rules, moved: [{ from: "map-2.jpg", to: "map.jpg" }], tiles: { from: `${SITE}map-2/`, to: `${SITE}map/` }, oldSiteId: "map-2" },
    };

    const answer = await postRenameArm(renameBody(48, entry));

    expect(answer.status).toBe(200);
    const rekeyedTo = (answer.body as { renames: { displaced: { rekeyedTo: string }[] } }).renames.displaced[0].rekeyedTo;
    expect(rekeyedTo).not.toBe("map-2");
    expect(objectsInDoc().map((o) => o.objectId)).toEqual(["map", rekeyedTo]);
    expect(stepValuesInDoc()).toEqual(["map", "bell", rekeyedTo]);
  });
});

describe("what the arm meets by row id", () => {
  it("already applied: the map holds the new id, so nothing is written, and the receipt is earned from D1", async () => {
    plantInDoc(() => targetMap().set("object_id", "city-map"));
    const answer = await postRenameArm(renameBody(44));
    expect(answer.body).toMatchObject({ renames: { applied: [], alreadyApplied: ["city-map"] } });
    expect(stepValuesInDoc()).toEqual(["o1", "bell"]);
    expect(textsInDoc().layer).toBe("Intro. ![m](o1.jpg) Outro.");
    expect(storage.get(RECEIPT_KEY(44))).toMatchObject({ renamed: ["city-map"] });
  });

  it("superseded: the row holds another key, and nothing is written", async () => {
    plantInDoc(() => targetMap().set("object_id", "o1-renamed"));
    const answer = await postRenameArm(renameBody(45));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ renames: { superseded: ["city-map"], applied: [] } });
    expect(objectsInDoc().map((o) => o.objectId)).toEqual(["o1-renamed"]);
    expect(stepValuesInDoc()).toEqual(["o1", "bell"]);
    expect(storage.get(RECEIPT_KEY(45))).toBeUndefined();
  });

  it("absent: no map carries the row id, though one holds the old key", async () => {
    const answer = await postRenameArm(renameBody(46, { ...RENAME, docId: 999 }));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ renames: { absent: ["city-map"], applied: [] } });
    expect(objectsInDoc().map((o) => o.objectId)).toEqual(["o1"]);
  });

  it("a course item is refused and left as it is", async () => {
    plantInDoc(() => targetMap().set("course_project_id", PROJECT_ID));
    const answer = await postRenameArm(renameBody(47));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ renames: { course: ["city-map"], applied: [] } });
    expect(objectsInDoc().map((o) => o.objectId)).toEqual(["o1"]);
    expect(stepValuesInDoc()).toEqual(["o1", "bell"]);
  });
});

describe("the receipt", () => {
  it("answers a replay from renamed, writing nothing", async () => {
    await postRenameArm(renameBody(48));
    plantInDoc(() => targetMap().set("object_id", "o1"));

    const replay = await postRenameArm(renameBody(48));

    expect(replay.body).toMatchObject({ alreadyApplied: true, receipted: { objectRename: ["city-map"] } });
    expect(objectsInDoc().map((o) => o.objectId)).toEqual(["o1"]);
  });

  it("is not written when D1 does not show the new id under the row after the flush", async () => {
    memory.raw.exec(
      "CREATE TRIGGER refuse_rename BEFORE UPDATE OF object_id ON objects WHEN NEW.object_id = 'city-map' " +
        "BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const answer = await postRenameArm(renameBody(49));
    expect(answer.status).toBe(503);
    expect(storage.get(RECEIPT_KEY(49))).toBeUndefined();

    memory.raw.exec("DROP TRIGGER refuse_rename");
    const retry = await postRenameArm(renameBody(49));
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ renames: { alreadyApplied: ["city-map"] } });
    expect(storage.get(RECEIPT_KEY(49))).toMatchObject({ renamed: ["city-map"] });
    expect(renamedRowOf(1)?.object_id).toBe("city-map");
  });
});

describe("the wire", () => {
  it.each([
    ["beside another objects arm", { opId: 50, objects: { rename: [RENAME], remove: ["o1"] } }],
    ["beside a top-level arm", { opId: 50, objects: { rename: [RENAME] }, config: [] }],
    ["without an operation id", { objects: { rename: [RENAME] } }],
  ])("refuses a rename %s, writing nothing", async (_label, body) => {
    const answer = await postRenameArm(body);
    expect(answer.status).toBe(400);
    expect(objectsInDoc().map((o) => o.objectId)).toEqual(["o1"]);
  });

  it("refuses an entry out of shape or with a new id out of domain, by position", async () => {
    const answer = await postRenameArm({
      opId: 51,
      objects: { rename: [{ ...RENAME, docId: "1" }, { ...RENAME, to: ["city-map"] }, RENAME] },
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ refused: { objectRename: [0, 1] }, renames: { applied: ["city-map"] } });
  });
});
