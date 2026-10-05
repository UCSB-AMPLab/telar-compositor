/**
 * A socket admitted under one generation can never write into another.
 *
 * `/reset` advances the document generation, rebuilds the document and closes
 * the sockets — but a hibernated socket survives an eviction, so a close that
 * an eviction prevented is not a fence. The attachment carries the generation
 * the socket was admitted under, and three places compare it: the constructor's
 * wake path before it loads, the message handler before it loads, and the
 * message handler again immediately before the apply. The third is the one that
 * establishes the generation at the point of application, because closing a
 * socket does not cancel a handler already running on it.
 *
 * The wake ordering is asserted by call order — closes and the blob SELECT go
 * into one array — and the SELECT is asserted to happen wherever a load is
 * expected, so "the close came first" cannot pass because nothing loaded at all.
 *
 * A generation storage cannot answer is refused rather than guessed: the
 * upgrade answers 503, the wake closes every socket with 1013 and does not
 * load, and a message applies nothing. No client is ever told to discard its
 * document on the authority of a number nothing read.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";

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

// The apply itself, counted. "Nothing was applied" is also visible in the
// document, but only this distinguishes a fence that stopped the handler
// before the apply from an update that ran and changed nothing.
const applies = vi.hoisted(() => ({ count: 0 }));
vi.mock("yjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yjs")>();
  return {
    ...actual,
    // Counted only for an apply that carries an ORIGIN, which is an inbound
    // message and nothing else: a base and a replayed record are applied with
    // none, and counting those would report a load as a message.
    applyUpdate: (doc: Y.Doc, update: Uint8Array, origin?: unknown) => {
      if (origin !== undefined && origin !== null) applies.count += 1;
      return actual.applyUpdate(doc, update, origin);
    },
  };
});

// The apply itself, counted, mirroring the sync mock above so the
// suspended-awareness ordering test can tell a fenced message (never reaches
// this call) from one that ran.
const awarenessApplies = vi.hoisted(() => ({ count: 0 }));
vi.mock("y-protocols/awareness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("y-protocols/awareness")>();
  return {
    ...actual,
    applyAwarenessUpdate: (...args: Parameters<typeof actual.applyAwarenessUpdate>) => {
      awarenessApplies.count += 1;
      return actual.applyAwarenessUpdate(...args);
    },
  };
});

import { ProjectCollaborationDO } from "../workers/collaboration";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const USER_ID = 7;
const TEST_SECRET = "test-session-secret";
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_SESSION_CONTROL = 2;
const SUB_STATE_RESET = 0x03;
const SUB_DOC_GENERATION = 0x04;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeAttachment {
  userId: number;
  projectId: number;
  role: "collaborator";
  generation?: number;
  membershipCheckedAt?: number;
}

/**
 * A hibernated socket. `generation` is left off the attachment when it is
 * passed as undefined, which is the shape a socket admitted without a fence
 * would carry.
 */
function fakeSocket(events: string[], generation: number | undefined, userId = USER_ID) {
  // Admitted just now, so the membership recheck is not yet due.
  const attachment: FakeAttachment = { userId, projectId: PROJECT_ID, role: "collaborator", membershipCheckedAt: Date.now() };
  if (generation !== undefined) attachment.generation = generation;
  const closes: Array<{ code: number; reason: string }> = [];
  const sent: Uint8Array[] = [];
  return {
    attachment,
    closes,
    sent,
    send: (data: Uint8Array) => { sent.push(data); },
    close: (code: number, reason: string) => {
      closes.push({ code, reason });
      events.push(`close:${code}`);
    },
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

type FakeSocket = ReturnType<typeof fakeSocket>;

/** A document holding one story, the blob the load reads. */
function storedBlob(): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("_id", 11);
    story.set("story_id", "s1");
    story.set("title", new Y.Text("Story One"));
    doc.getArray<Y.Map<unknown>>("stories").push([story]);
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
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(client, before));
  return encoding.toUint8Array(enc);
}

/** An awareness-update message for one client's presence state. */
function awarenessUpdate(): Uint8Array {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState({ user: { name: "Test" } });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    enc,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
  );
  return encoding.toUint8Array(enc);
}

interface DoOptions {
  sockets?: FakeSocket[];
  events?: string[];
  blob?: Uint8Array | null;
  /** How many times the generation read rejects before it answers. */
  storageFailures?: number;
  generation?: number;
  /** Runs inside the load gate, after the load, before the caller resumes. */
  duringGate?: () => Promise<void>;
}

function makeDo(opts: DoOptions = {}) {
  const events = opts.events ?? [];
  const sockets = opts.sockets ?? [];
  const blob = opts.blob === undefined ? storedBlob() : opts.blob;
  let failures = opts.storageFailures ?? 0;
  const kv = new Map<string, unknown>();

  const ctx = {
    getWebSockets: () => sockets,
    // The constructor's own wake-path call is fire-and-forget (a DO
    // constructor cannot be async), so a test that needs the load it starts
    // to have finished has nothing else to await. Every call overwrites this
    // with its own promise, so it always names the most recent gate.
    lastGate: Promise.resolve() as Promise<unknown>,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      const gate = (async () => {
        const result = await fn();
        if (opts.duringGate) await opts.duringGate();
        return result;
      })();
      ctx.lastGate = gate;
      return gate;
    },
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("storage unavailable");
        }
        if (kv.has(key)) return kv.get(key);
        // Only the generation key answers: every other key this fake is asked
        // for — the halt marker, a storage base — is absent, and a number
        // standing at one of those would read as damage.
        return key === "docGeneration" ? (opts.generation ?? 0) : undefined;
      },
      put: async (key: string, value: unknown) => { kv.set(key, value); },
      // A load lists the log prefix before it opens an untagged or absent base.
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };

  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        checkD1Bind(sql, args);
        return {
          async run() { return { meta: { last_row_id: 1, changes: 1 }, success: true as const }; },
          async all() { return { results: [], success: true as const }; },
          async first() {
            if (/^SELECT yjs_state/.test(sql)) {
              events.push("select-blob");
              // A seeded blob is tagged with the generation the instance is
              // serving and claimable; an absent one is the cold build.
              return blob
                ? {
                    yjs_state: blob.buffer,
                    yjs_generation: opts.generation ?? 0,
                    yjs_seq: 0,
                    yjs_write: 0,
                  }
                : { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 };
            }
            if (/FROM project_members/.test(sql)) return { role: "collaborator" };
            return null;
          },
        };
      },
    }),
    async batch() { return []; },
  };

  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: DB as unknown, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  return { doInstance, ctx, events, sockets };
}

const internals = (doInstance: ProjectCollaborationDO) =>
  doInstance as unknown as {
    projectId: number | null;
    docLoaded: boolean;
    docGeneration: number | null;
    ydoc: Y.Doc;
    webSocketMessage: (ws: unknown, m: Uint8Array) => Promise<void>;
  };

function titleOf(doInstance: ProjectCollaborationDO): string | undefined {
  const stories = internals(doInstance).ydoc.getArray<Y.Map<unknown>>("stories");
  return stories.length === 0 ? undefined : String(stories.get(0).get("title"));
}

// ---------------------------------------------------------------------------
// Upgrade-path harness
// ---------------------------------------------------------------------------

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintToken(userId: number): Promise<string> {
  const enc = new TextEncoder();
  const payload = base64urlEncode(
    enc.encode(JSON.stringify({ userId, createdAt: new Date().toISOString() })),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${base64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Drive one upgrade. Node cannot build the 101 the admitted path returns, so
 * the RangeError it throws is swallowed — everything the handshake does to the
 * socket has already happened by then.
 */
async function upgrade(doInstance: ProjectCollaborationDO, gen = "0") {
  const events: string[] = [];
  const socket = fakeSocket(events, undefined);
  (globalThis as Record<string, unknown>).WebSocketPair = function () {
    return { 0: socket, 1: socket };
  };
  const token = await mintToken(USER_ID);
  const request = new Request(
    `https://internal/ws/${PROJECT_ID}?token=${token}&gen=${gen}`,
    { headers: { Upgrade: "websocket" } },
  );
  const response = await doInstance.fetch(request).catch(() => null);
  return { socket, response };
}

/** The session-control frames a socket received, decoded. */
function controlsIn(socket: FakeSocket): Array<{ subtype: number; value: number }> {
  const out: Array<{ subtype: number; value: number }> = [];
  for (const frame of socket.sent) {
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== MESSAGE_SESSION_CONTROL) continue;
    out.push({ subtype: decoding.readUint8(decoder), value: decoding.readVarUint(decoder) });
  }
  return out;
}

function syncFramesIn(socket: FakeSocket): number {
  return socket.sent.filter(
    (frame) => decoding.readVarUint(decoding.createDecoder(frame)) === MESSAGE_SYNC,
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  applies.count = 0;
  awarenessApplies.count = 0;
});

// ---------------------------------------------------------------------------
// The wake fence
// ---------------------------------------------------------------------------

describe("the hibernation-wake fence", () => {
  it("closes a socket from another generation before the blob SELECT", async () => {
    const events: string[] = [];
    const stale = fakeSocket(events, 0);
    const { doInstance, ctx } = makeDo({ sockets: [stale], events, generation: 1 });
    await ctx.lastGate;

    expect(stale.closes).toEqual([{ code: 1012, reason: "State reset" }]);
    // The SELECT has to be there, or the ordering below is satisfied by a load
    // that never ran.
    expect(events).toContain("select-blob");
    expect(events.indexOf("close:1012")).toBeLessThan(events.indexOf("select-blob"));
    expect(internals(doInstance).docLoaded).toBe(true);
  });

  it("closes a socket whose attachment carries no generation at all", async () => {
    const events: string[] = [];
    const legacy = fakeSocket(events, undefined);
    const { doInstance, ctx } = makeDo({ sockets: [legacy], events, generation: 0 });
    await ctx.lastGate;

    expect(legacy.closes).toEqual([{ code: 1012, reason: "State reset" }]);
    expect(events).toContain("select-blob");
    expect(events.indexOf("close:1012")).toBeLessThan(events.indexOf("select-blob"));
    expect(internals(doInstance).docLoaded).toBe(true);
  });

  it("leaves a socket admitted under the current generation open", async () => {
    const events: string[] = [];
    const current = fakeSocket(events, 3);
    const { doInstance, ctx } = makeDo({ sockets: [current], events, generation: 3 });
    await ctx.lastGate;

    expect(current.closes).toEqual([]);
    expect(events).toEqual(["select-blob"]);
    expect(internals(doInstance).docLoaded).toBe(true);
  });

  it("closes every socket with 1013 and does not load when the read fails twice", async () => {
    const events: string[] = [];
    const first = fakeSocket(events, 0, 7);
    const second = fakeSocket(events, 0, 8);
    const { doInstance, ctx } = makeDo({
      sockets: [first, second],
      events,
      generation: 0,
      storageFailures: 2,
    });
    await ctx.lastGate;

    expect(first.closes).toEqual([{ code: 1013, reason: "Try again later" }]);
    expect(second.closes).toEqual([{ code: 1013, reason: "Try again later" }]);
    // Nothing is told to discard its document: the generation is unknown, not
    // known to have moved.
    expect(first.sent).toEqual([]);
    expect(events).not.toContain("select-blob");
    expect(internals(doInstance).docLoaded).toBe(false);
  });

  it("loads normally and closes nothing when the read fails once and its retry answers", async () => {
    const events: string[] = [];
    const current = fakeSocket(events, 0);
    const { doInstance, ctx } = makeDo({
      sockets: [current],
      events,
      generation: 0,
      storageFailures: 1,
    });
    await ctx.lastGate;

    expect(current.closes).toEqual([]);
    expect(events).toEqual(["select-blob"]);
    expect(internals(doInstance).docLoaded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The message fences
// ---------------------------------------------------------------------------

describe("the message fences", () => {
  it("closes a stale socket before the load, and applies nothing", async () => {
    const events: string[] = [];
    const blob = storedBlob();
    const { doInstance, sockets } = makeDo({ events, blob });
    const stale = fakeSocket(events, 0);
    sockets.push(stale);
    internals(doInstance).projectId = PROJECT_ID;
    internals(doInstance).docGeneration = 1;

    await internals(doInstance).webSocketMessage(stale, titleEdit(blob, "!"));

    expect(stale.closes).toEqual([{ code: 1012, reason: "State reset" }]);
    expect(applies.count).toBe(0);
    // The fence sits ahead of the load, so a socket already known stale does
    // not make the instance pay for one.
    expect(events).not.toContain("select-blob");
    expect(internals(doInstance).docLoaded).toBe(false);
  });

  it("closes with 1013 and applies nothing when the cached generation is unknown", async () => {
    const events: string[] = [];
    const blob = storedBlob();
    const { doInstance, sockets } = makeDo({ events, blob });
    const ws = fakeSocket(events, 0);
    sockets.push(ws);
    internals(doInstance).projectId = PROJECT_ID;
    // Set explicitly: a cached number never consults storage, so nothing else
    // could produce the unknown state at this point.
    internals(doInstance).docGeneration = null;

    await internals(doInstance).webSocketMessage(ws, titleEdit(blob, "!"));

    expect(ws.closes).toEqual([{ code: 1013, reason: "Try again later" }]);
    expect(ws.sent).toEqual([]);
    expect(applies.count).toBe(0);
    expect(events).not.toContain("select-blob");
  });

  it("closes after the load when the generation moves while the handler is suspended", async () => {
    const events: string[] = [];
    const blob = storedBlob();
    let markEntered: () => void = () => {};
    const suspended = new Promise<void>((resolve) => { markEntered = resolve; });
    let resume: () => void = () => {};
    const deferredGate = new Promise<void>((resolve) => { resume = resolve; });
    const { doInstance, sockets } = makeDo({
      events,
      blob,
      // Signals the moment the handler enters the suspended gate, then holds
      // it there until the test releases it — an explicit ordering point in
      // place of a timer the test would otherwise have to guess is enough.
      duringGate: () => {
        markEntered();
        return deferredGate;
      },
    });
    const ws = fakeSocket(events, 0);
    sockets.push(ws);
    internals(doInstance).projectId = PROJECT_ID;
    internals(doInstance).docGeneration = 0;

    // The handler passes the first fence, then suspends inside the load gate.
    const delivered = internals(doInstance).webSocketMessage(ws, titleEdit(blob, "!"));
    await suspended;
    expect(ws.closes).toEqual([]);

    // A resident `/reset` advances the cache while the handler is suspended.
    // This test proves only the second fence: that a handler resuming after
    // the generation has moved is closed rather than applied. Rebuilding the
    // document and issuing the reset's own close are `/reset`'s job, exercised
    // elsewhere, not this harness's.
    internals(doInstance).docGeneration = 1;
    resume();
    await delivered;

    expect(events).toContain("select-blob");
    expect(internals(doInstance).docLoaded).toBe(true);
    expect(ws.closes).toEqual([{ code: 1012, reason: "State reset" }]);
    expect(applies.count).toBe(0);
    expect(titleOf(doInstance)).toBe("Story One");
  });

  it("closes an awareness message after the load when the generation moves while the handler is suspended", async () => {
    const events: string[] = [];
    const blob = storedBlob();
    let markEntered: () => void = () => {};
    const suspended = new Promise<void>((resolve) => { markEntered = resolve; });
    let resume: () => void = () => {};
    const deferredGate = new Promise<void>((resolve) => { resume = resolve; });
    const { doInstance, sockets } = makeDo({
      events,
      blob,
      duringGate: () => {
        markEntered();
        return deferredGate;
      },
    });
    const ws = fakeSocket(events, 0);
    const other = fakeSocket(events, 0, USER_ID + 1);
    sockets.push(ws, other);
    internals(doInstance).projectId = PROJECT_ID;
    internals(doInstance).docGeneration = 0;

    // The handler passes the first fence, then suspends inside the load gate.
    const delivered = internals(doInstance).webSocketMessage(ws, awarenessUpdate());
    await suspended;
    expect(ws.closes).toEqual([]);

    // A resident `/reset` advances the cache while the handler is suspended.
    internals(doInstance).docGeneration = 1;
    resume();
    await delivered;

    expect(ws.closes).toEqual([{ code: 1012, reason: "State reset" }]);
    expect(awarenessApplies.count).toBe(0);
    expect(other.sent).toEqual([]);
  });

  it("applies a message from a socket attached to the current generation", async () => {
    const events: string[] = [];
    const blob = storedBlob();
    const { doInstance, sockets } = makeDo({ events, blob });
    const ws = fakeSocket(events, 0);
    sockets.push(ws);
    internals(doInstance).projectId = PROJECT_ID;
    internals(doInstance).docGeneration = 0;

    await internals(doInstance).webSocketMessage(ws, titleEdit(blob, "!"));

    expect(ws.closes).toEqual([]);
    expect(applies.count).toBe(1);
    expect(titleOf(doInstance)).toBe("Story One!");
  });
});

// ---------------------------------------------------------------------------
// The upgrade path
// ---------------------------------------------------------------------------

describe("the upgrade path", () => {
  it("stamps the attachment with the generation the client was validated against", async () => {
    const { doInstance } = makeDo({ generation: 2 });
    const { socket } = await upgrade(doInstance, "2");

    expect(socket.serializeAttachment).toHaveBeenCalledWith({
      userId: USER_ID,
      projectId: PROJECT_ID,
      role: "collaborator",
      generation: 2,
      membershipCheckedAt: expect.any(Number),
    });
    // The generation, then the freeze as it stands (its JSON, which this
    // reader does not decode).
    const controls = controlsIn(socket);
    expect(controls[0]).toEqual({ subtype: SUB_DOC_GENERATION, value: 2 });
    expect(controls.map((c) => c.subtype)).toEqual([SUB_DOC_GENERATION, 0x05]);
  });

  it("answers a client stale when the generation moves between the gate and acceptance", async () => {
    // The guard reads the generation before the cold-start gate; a resident
    // `/reset` can advance it inside that gate. The client is answered through
    // the stale path, which accepts a temporary socket only to carry the reset
    // frame, so what is asserted is the absence of an admission rather than the
    // absence of a socket.
    const { doInstance } = makeDo({
      generation: 0,
      duringGate: async () => { internals(doInstance).docGeneration = 1; },
    });
    const { socket } = await upgrade(doInstance, "0");

    expect(controlsIn(socket)).toEqual([{ subtype: SUB_STATE_RESET, value: 1 }]);
    expect(syncFramesIn(socket)).toBe(0);
    expect(socket.closes).toEqual([{ code: 1012, reason: "State reset" }]);
    expect(socket.serializeAttachment).not.toHaveBeenCalled();
  });

  it("refuses with 503 and accepts no socket when the generation cannot be read", async () => {
    const { doInstance, ctx } = makeDo({ generation: 0, storageFailures: 1 });
    const { socket, response } = await upgrade(doInstance, "0");

    expect(response?.status).toBe(503);
    expect(ctx.acceptWebSocket).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([]);
  });

  it("refuses with 503 and accepts no socket when the post-gate cache reads null", async () => {
    // The guard's own pre-gate read answered a number; what the gate leaves
    // behind is unreadable. There is no newer generation to answer stale
    // against, so this is a 503 rather than the reset path.
    const { doInstance, ctx } = makeDo({
      generation: 0,
      duringGate: async () => { internals(doInstance).docGeneration = null; },
    });
    const { socket, response } = await upgrade(doInstance, "0");

    expect(response?.status).toBe(503);
    expect(ctx.acceptWebSocket).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    expect(socket.closes).toEqual([]);
  });
});
