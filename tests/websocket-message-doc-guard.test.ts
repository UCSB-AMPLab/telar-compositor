/**
 * `webSocketMessage` must not apply a client update to an unloaded document
 *.
 *
 * Every other entry point into the Durable Object — the control routes, the
 * socket upgrade, the hibernation-wake constructor — reaches the document
 * through `ensureDocLoaded` inside `blockConcurrencyWhile`. `webSocketMessage`
 * did not, and `docLoaded` is reachable as false with sockets live: the
 * constructor's wake-time load swallows a failed D1 read on purpose, because a
 * throw escaping that callback would discard the Durable Object and evict every
 * editor.
 *
 * Applied against an empty document, a sync message makes the DO answer sync
 * step 1 from nothing and relay an update computed against nothing, while
 * `canDelete` enforcement sees a document with no entities to protect. So: load
 * first; if the document still cannot be loaded, drop the message rather than
 * act on an empty one.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";

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
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const messageSync = 0;

function fakeSocket(userId: number) {
  // Attached to the generation `makeDo` caches: the handler's fence closes a
  // socket that names any other one before the load this file is about.
  const attachment = {
    userId,
    projectId: PROJECT_ID,
    role: "collaborator" as const,
    generation: 0,
    // Admitted just now, so the membership recheck is not yet due.
    membershipCheckedAt: Date.now(),
  };
  return {
    attachment,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

/**
 * The blob D1 hands back on load: a document holding one story. The message
 * under test edits that story's title, which only resolves if the load ran.
 */
function storedBlob(): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const m = new Y.Map<unknown>();
    m.set("_id", 11);
    m.set("story_id", "s1");
    m.set("title", new Y.Text("Story One"));
    doc.getArray<Y.Map<unknown>>("stories").push([m]);
  }, null);
  return Y.encodeStateAsUpdate(doc);
}

/** A sync-update message appending to the first story's title. */
function titleEdit(base: Uint8Array, appended: string): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, base);
  const before = Y.encodeStateVector(client);
  client.transact(() => {
    const title = client.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text;
    title.insert(title.length, appended);
  });
  const update = Y.encodeStateAsUpdate(client, before);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

function makeDo(opts: { blob: Uint8Array | null; loadThrows?: boolean }) {
  const sockets: unknown[] = [];
  let depth = 0;
  const ctx = {
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => {
      depth += 1;
      try { return await fn(); } finally { depth -= 1; }
    },
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
    gateDepth: () => depth,
  };
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        checkD1Bind(sql, args);
        return {
          async run() { return { meta: { last_row_id: 1, changes: 1 }, success: true as const }; },
          async all() { return { results: [], success: true as const }; },
          async first() {
            if (opts.loadThrows) throw new Error("D1_ERROR: read failed");
            if (/^SELECT yjs_state/.test(sql)) {
              return opts.blob
                ? { yjs_state: opts.blob.buffer, yjs_generation: 0, yjs_seq: 0, yjs_write: 0 }
                : { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 };
            }
            return null;
          },
        };
      },
    }),
    async batch() { return []; },
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: DB as unknown, SESSION_SECRET: "test", COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  (doInstance as unknown as { docGeneration: number }).docGeneration = 0;
  return { doInstance, sockets, ctx };
}

function deliver(doInstance: ProjectCollaborationDO, ws: unknown, msg: Uint8Array) {
  return (doInstance as unknown as {
    webSocketMessage: (ws: unknown, m: Uint8Array) => Promise<void>;
  }).webSocketMessage(ws, msg);
}

function ydocOf(doInstance: ProjectCollaborationDO): Y.Doc {
  return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("webSocketMessage — the docLoaded guard", () => {
  it("loads the document before applying a message that arrives unloaded", async () => {
    const blob = storedBlob();
    const { doInstance, sockets } = makeDo({ blob });
    const ws = fakeSocket(7);
    sockets.push(ws);
    expect((doInstance as unknown as { docLoaded: boolean }).docLoaded).toBe(false);

    await deliver(doInstance, ws, titleEdit(blob, "!"));

    expect((doInstance as unknown as { docLoaded: boolean }).docLoaded).toBe(true);
    const stories = ydocOf(doInstance).getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(1);
    expect(String(stories.get(0).get("title"))).toBe("Story One!");
  });

  it("drops the message when the document still cannot be loaded", async () => {
    const blob = storedBlob();
    const { doInstance, sockets } = makeDo({ blob, loadThrows: true });
    const ws = fakeSocket(7);
    const peer = fakeSocket(8);
    sockets.push(ws, peer);
    const error = vi.spyOn(console, "error").mockImplementation(() => { /* silence */ });

    await deliver(doInstance, ws, titleEdit(blob, "!"));

    // Nothing applied, nothing relayed, nothing answered from an empty doc.
    expect(ydocOf(doInstance).getArray<Y.Map<unknown>>("stories").length).toBe(0);
    expect(peer.send).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("a message on an already-loaded document takes no gate", async () => {
    // The warm path is every keystroke. It must not pay a blockConcurrencyWhile.
    const blob = storedBlob();
    const { doInstance, sockets, ctx } = makeDo({ blob });
    const ws = fakeSocket(7);
    sockets.push(ws);
    await deliver(doInstance, ws, titleEdit(blob, "!"));

    const gates: number[] = [];
    const wrapped = ctx.blockConcurrencyWhile;
    ctx.blockConcurrencyWhile = async (fn: () => Promise<unknown>) => {
      gates.push(1);
      return wrapped(fn);
    };
    await deliver(doInstance, ws, titleEdit(Y.encodeStateAsUpdate(ydocOf(doInstance)), "?"));

    expect(gates).toEqual([]);
    expect(String(
      ydocOf(doInstance).getArray<Y.Map<unknown>>("stories").get(0).get("title"),
    )).toBe("Story One!?");
  });
});
