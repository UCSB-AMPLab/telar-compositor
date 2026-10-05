/**
 * Every mutation the snapshot makes to its own Y.Doc has to reach the peers.
 * The dedupe passes make two kinds — a re-key and a delete — and only the
 * re-key was reported as a mutation, so a cleanup that only deleted was
 * settled on the server and nowhere else. The peers kept the duplicate,
 * carried on editing it, and had every edit silently discarded by the next
 * snapshot, which has no Y.Map to write them from.
 *
 * The nested step and layer pass had the same gap for the same reason: it
 * reported nothing at all.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
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
import { markLoaded } from "./helpers/claimed-document";

const PROJECT_ID = 42;
const MSG_SYNC = 0;

interface D1Seed {
  stories?: Array<{ id: number; story_id: string }>;
  steps?: Map<number, number[]>;
  layers?: Map<number, number[]>;
  objects?: Array<{ id: number; object_id: string }>;
}

function makeDb(seed: D1Seed) {
  let lastRowId = 5000;

  function resolve(sql: string, binds: unknown[]): unknown[] {
    if (/FROM stories WHERE project_id/.test(sql)) return seed.stories ?? [];
    if (/FROM steps WHERE story_id/.test(sql)) {
      return (seed.steps?.get(binds[0] as number) ?? []).map((id) => ({ id }));
    }
    if (/FROM layers WHERE step_id/.test(sql)) {
      return (seed.layers?.get(binds[0] as number) ?? []).map((id) => ({ id }));
    }
    if (/FROM objects WHERE project_id/.test(sql)) return seed.objects ?? [];
    return [];
  }

  function prepare(sql: string) {
    let bound: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return bound; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); bound = args; return stmt; },
      async run() {
        return { meta: { last_row_id: (lastRowId += 1), changes: 1 }, success: true as const };
      },
      async all<T = unknown>() { return { results: resolve(sql, bound) as T[], success: true as const }; },
      async first<T = unknown>() {
        if (/SELECT id FROM project_(config|landing) WHERE project_id/.test(sql)) {
          return { id: 1 } as T;
        }
        return ((resolve(sql, bound) as T[])[0] ?? null) as T | null;
      },
    };
    return stmt;
  }

  return {
    prepare,
    async batch(statements: unknown[]) { return statements.map(() => ({ success: true })); },
  };
}

/** A connected peer, recording everything the DO pushes at it. */
function makeSocket() {
  const sent: Uint8Array[] = [];
  return {
    sent,
    send: (data: Uint8Array) => { sent.push(data); },
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    // Attached before the instance is built, so the constructor's wake path
    // reads it: a socket carrying no generation is closed there, and this
    // fixture is a peer that stays connected to hear the broadcast.
    deserializeAttachment: () => ({ projectId: PROJECT_ID, generation: 0 }),
  };
}

function makeDo(seed: D1Seed) {
  const socket = makeSocket();
  const ctx = {
    getWebSockets: () => [socket],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    // The generation the wake path reads before it decides whether the
    // attached socket above may stay.
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      list: async () => new Map(),
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: makeDb(seed) as unknown, SESSION_SECRET: "test", COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  ydoc.transact(() => {
    const c = ydoc.getMap<unknown>("config");
    c.set("title", new Y.Text("Demo"));
    c.set("lang", "en");
  }, null);
  return { doInstance, ydoc, socket };
}

function snapshot(doInstance: unknown): Promise<void> {
  return (doInstance as { snapshotToD1: () => Promise<void> }).snapshotToD1();
}

function syncMessages(socket: ReturnType<typeof makeSocket>) {
  return socket.sent.filter(
    (m) => decoding.readVarUint(decoding.createDecoder(m)) === MSG_SYNC,
  );
}

function makeObject(fields: { _id: number | null; object_id: string; title?: string }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("_temp_id", `t-${fields.object_id}-${fields._id}`);
  m.set("object_id", fields.object_id);
  m.set("created_by", 1);
  m.set("title", new Y.Text(fields.title ?? fields.object_id));
  for (const k of [
    "creator", "description", "alt_text", "period", "year",
    "object_type", "subjects", "source", "credit",
  ]) m.set(k, new Y.Text(""));
  return m;
}

function makeStory(fields: { _id: number; story_id: string }) {
  const m = new Y.Map<unknown>();
  m.set("_id", fields._id);
  m.set("story_id", fields.story_id);
  m.set("created_by", 1);
  m.set("title", new Y.Text(fields.story_id));
  m.set("subtitle", new Y.Text(""));
  m.set("byline", new Y.Text(""));
  m.set("steps", new Y.Array<Y.Map<unknown>>());
  return m;
}

function makeStep(id: number) {
  const m = new Y.Map<unknown>();
  m.set("_id", id);
  m.set("kind", "media");
  m.set("object_id", "");
  m.set("question", new Y.Text(""));
  m.set("answer", new Y.Text(""));
  m.set("alt_text", new Y.Text(""));
  m.set("layers", new Y.Array<Y.Map<unknown>>());
  return m;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  vi.spyOn(console, "warn").mockImplementation(() => { /* dedupe logs a warning */ });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("a dedupe that only deletes is still broadcast", () => {
  it("pushes the top-level deletion to connected peers", async () => {
    // Two Y.Maps claiming one persisted row: the exact-`_id` collision, the one
    // collapse that resolves by deletion rather than by a re-key.
    const { doInstance, ydoc, socket } = makeDo({
      objects: [{ id: 42, object_id: "vasija" }],
    });
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 42, object_id: "vasija", title: "Keeper" }),
        makeObject({ _id: 42, object_id: "vasija", title: "Duplicate" }),
      ]);
    }, null);

    await snapshot(doInstance);

    expect(ydoc.getArray("objects").length).toBe(1);
    expect(syncMessages(socket).length).toBeGreaterThan(0);
  });

  it("carries the deletion, so the peer drops the duplicate too", async () => {
    const { doInstance, ydoc, socket } = makeDo({
      objects: [{ id: 42, object_id: "vasija" }],
    });
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 42, object_id: "vasija", title: "Keeper" }),
        makeObject({ _id: 42, object_id: "vasija", title: "Duplicate" }),
      ]);
    }, null);

    // A peer synced before the snapshot ran — it holds both copies.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    expect(peer.getArray("objects").length).toBe(2);

    await snapshot(doInstance);

    for (const msg of syncMessages(socket)) {
      const decoder = decoding.createDecoder(msg);
      decoding.readVarUint(decoder);
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), peer, null);
    }
    // Without this the peer goes on editing a map the server has thrown away,
    // and every one of those edits is discarded by the next snapshot.
    expect(peer.getArray("objects").length).toBe(1);
  });

  it("pushes a nested step deletion to connected peers", async () => {
    const { doInstance, ydoc, socket } = makeDo({
      stories: [{ id: 10, story_id: "s1" }],
      steps: new Map([[10, [7]]]),
      layers: new Map(),
    });
    ydoc.transact(() => {
      const story = makeStory({ _id: 10, story_id: "s1" });
      ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
      (story.get("steps") as Y.Array<Y.Map<unknown>>).push([makeStep(7), makeStep(7)]);
    }, null);

    await snapshot(doInstance);

    const steps = (ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("steps")) as Y.Array<unknown>;
    expect(steps.length).toBe(1);
    expect(syncMessages(socket).length).toBeGreaterThan(0);
  });
});

describe("what is not a mutation is not broadcast", () => {
  it("stays quiet on a snapshot that changed nothing in the document", async () => {
    const { doInstance, ydoc, socket } = makeDo({
      objects: [{ id: 42, object_id: "vasija" }],
    });
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 42, object_id: "vasija" }),
      ]);
    }, null);

    await snapshot(doInstance);

    // Broadcasting every idle snapshot would push the whole document at every
    // editor every thirty seconds.
    expect(syncMessages(socket)).toHaveLength(0);
  });

  it("still broadcasts a re-key", async () => {
    const { doInstance, ydoc, socket } = makeDo({
      objects: [{ id: 42, object_id: "vasija" }],
    });
    ydoc.transact(() => {
      ydoc.getArray<Y.Map<unknown>>("objects").push([
        makeObject({ _id: 42, object_id: "vasija" }),
        makeObject({ _id: 99, object_id: "vasija" }),
      ]);
    }, null);

    await snapshot(doInstance);

    expect(syncMessages(socket).length).toBeGreaterThan(0);
  });
});
