/**
 * `/reset` is the documented recovery for a document the DO refuses to
 * persist. Recovery only holds if the rebuilt server document is the one the
 * editors end up on — and a Yjs client that survives the reset does not
 * discard its copy. y-websocket reconnects on any close code, and the sync
 * exchange merges whatever the client still holds into whatever the server
 * now holds, so a rebuilt document is re-poisoned by the first client back.
 *
 * The first block pins that mechanism against the real y-websocket and
 * y-protocols, so the guard below is anchored to observed behaviour rather
 * than to a reading of the vendored source. The rest drives the DO's socket
 * handshake: a client that cannot show its document postdates the last reset —
 * one presenting a generation the server has left behind, or presenting none at
 * all on a project that has been reset — is refused and told to rebuild, while
 * a client at the current generation and one that says it has just built its
 * document are admitted and synced exactly as before.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
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

import { ProjectCollaborationDO, mayRejoinGeneration } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { checkD1Bind } from "./helpers/d1-memory";

const TEST_SECRET = "test-session-secret";
const TEST_PROJECT_ID = 42;
const TEST_USER_ID = 7;

const MSG_SYNC = 0;
const MSG_SESSION_CONTROL = 2;
const SUB_STATE_RESET = 0x03;
const SUB_DOC_GENERATION = 0x04;
/** What a client presents for a document it has just built. */
const FRESH = "new";

/** One story row, standing in for the D1 truth a reset rebuilds from. */
const STORY_ROWS = [
  {
    id: 10, story_id: "victim", title: "Victim", subtitle: "", byline: "",
    order: 0, private: 0, draft: 0, show_sections: 0, created_by: 1,
  },
];

// ---------------------------------------------------------------------------
// Evidence: what a surviving client does to a rebuilt server document
// ---------------------------------------------------------------------------

describe("y-websocket resync after a reset (mechanism)", () => {
  it("reconnects after a 1012 close, reusing the same Y.Doc", async () => {
    vi.useFakeTimers();
    const constructed: FakeWS[] = [];

    class FakeWS {
      static CONNECTING = 0;
      static OPEN = 1;
      binaryType = "arraybuffer";
      readyState = 0;
      onmessage: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onclose: ((e: unknown) => void) | null = null;
      onopen: (() => void) | null = null;
      sent: unknown[] = [];
      constructor(public url: string) {
        constructed.push(this);
      }
      send(data: unknown) { this.sent.push(data); }
      close() { /* driven by the test */ }
    }

    const { WebsocketProvider } = await import("y-websocket");
    const doc = new Y.Doc();
    const provider = new WebsocketProvider("ws://localhost", "ws/1", doc, {
      WebSocketPolyfill: FakeWS as unknown as typeof WebSocket,
      disableBc: true,
    });

    expect(constructed).toHaveLength(1);
    const first = constructed[0];
    first.readyState = 1;
    first.onopen?.();

    // The server's /reset closes every socket with 1012.
    first.onclose?.({ code: 1012, reason: "State reset" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(constructed.length).toBeGreaterThan(1);
    // The same document is carried into the new connection — nothing about the
    // close code makes the client drop what it holds.
    expect(provider.doc).toBe(doc);

    provider.destroy();
    doc.destroy();
    vi.useRealTimers();
  });

  it("merges a pre-reset client document back into a rebuilt server document", () => {
    // A server document holding one story, and a client synced to it.
    const preReset = new Y.Doc();
    preReset.getArray<Y.Map<unknown>>("stories").push([new Y.Map()]);
    preReset.getArray<Y.Map<unknown>>("stories").get(0).set("story_id", "victim");

    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(preReset));

    // The client deletes the story; the server refuses the deletion and stops
    // persisting, so D1 still holds the row. The client keeps the deletion.
    client.getArray("stories").delete(0, 1);
    expect(client.getArray("stories").length).toBe(0);

    // /reset: the server document is destroyed and rebuilt from D1.
    const rebuilt = new Y.Doc();
    rebuilt.getArray<Y.Map<unknown>>("stories").push([new Y.Map()]);
    rebuilt.getArray<Y.Map<unknown>>("stories").get(0).set("story_id", "victim");
    expect(rebuilt.getArray("stories").length).toBe(1);

    // The client reconnects. The server opens with sync step 1 (its state
    // vector); the client answers with sync step 2 — everything the server's
    // vector does not cover, which is its whole pre-reset document.
    const step1 = encoding.createEncoder();
    syncProtocol.writeSyncStep1(step1, rebuilt);
    const reply = encoding.createEncoder();
    syncProtocol.readSyncMessage(
      decoding.createDecoder(encoding.toUint8Array(step1)),
      reply,
      client,
      null,
    );
    syncProtocol.readSyncMessage(
      decoding.createDecoder(encoding.toUint8Array(reply)),
      encoding.createEncoder(),
      rebuilt,
      null,
    );

    // The rebuilt document has stopped describing D1 alone: the client's
    // pre-reset copy of the story is in it, and in it deleted.
    const stories = rebuilt.getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(1);
    expect(stories.get(0).get("story_id")).toBe("victim");
    // The merge is additive, so the reset's own rebuild survives alongside the
    // client's deleted copy — the server document is now the union of both.
    expect(Y.encodeStateVector(rebuilt).length)
      .toBeGreaterThan(Y.encodeStateVector(preReset).length);
  });
});

// ---------------------------------------------------------------------------
// The guard: the DO decides which documents may rejoin
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
 * D1 stand-in that records the statements it runs, so a test can ask whether a
 * reset actually cleared the blob rather than only whether it answered 200.
 * `failRunsMatching` and `failFirstMatching` make one statement shape fail the
 * way an outage would.
 */
function makeDb() {
  const runs: string[] = [];
  const db = {
    runs,
    failRunsMatching: null as string | null,
    failFirstMatching: null as string | null,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          checkD1Bind(sql, args);
          return {
          first: async () => {
            if (db.failFirstMatching !== null && sql.includes(db.failFirstMatching)) {
              throw new Error("d1 unavailable");
            }
            if (sql.includes("FROM project_members")) return { role: "convenor" };
            // The base row: no blob, no tags, no claim yet, which is the cold
            // build; the same shape answers re-acquisition's narrower read.
            if (/^SELECT yjs_state|^SELECT yjs_generation/.test(sql)) {
              return { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 };
            }
            return null;
          },
          all: async () => ({
            results: sql.includes("FROM stories") ? STORY_ROWS : [],
          }),
          run: async () => {
            if (db.failRunsMatching !== null && sql.includes(db.failRunsMatching)) {
              throw new Error("d1 unavailable");
            }
            runs.push(sql);
            return { meta: { last_row_id: 1, changes: 1 }, success: true as const };
          },
          };
        },
      };
    },
    batch: async () => [],
  };
  return db;
}

/** A socket the DO can accept, send on, and close, with everything recorded. */
function makeSocket() {
  const sent: Uint8Array[] = [];
  const closes: number[] = [];
  return {
    sent,
    closes,
    accept: vi.fn(),
    send: (data: Uint8Array) => { sent.push(data); },
    close: (code: number) => { closes.push(code); },
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => null,
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness() {
  const storage = new Map<string, unknown>();
  const liveSockets: ReturnType<typeof makeSocket>[] = [];
  const ctx = {
    getWebSockets: () => liveSockets,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (k: string) => storage.get(k),
      put: async (k: string, v: unknown) => { storage.set(k, v); },
      // A load lists the log prefix before it builds a document for a row
      // without one.
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const db = makeDb();
  const env = { DB: db, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  return { doInstance, storage, liveSockets, db, acceptWebSocket: ctx.acceptWebSocket };
}

/**
 * Drive one socket upgrade. The 101 Response the DO returns cannot be built by
 * Node's `Response`, so the RangeError it throws is swallowed: everything the
 * handshake does to the socket has already happened by then.
 */
async function upgrade(h: Harness, gen?: string) {
  return (await attemptUpgrade(h, gen)).socket;
}

/**
 * The same drive, keeping the response beside the socket: a refusal answers
 * with a status rather than by writing to a socket, so both have to be
 * readable to tell "refused" from "admitted and told nothing".
 */
async function attemptUpgrade(h: Harness, gen?: string) {
  const socket = makeSocket();
  (globalThis as Record<string, unknown>).WebSocketPair = function () {
    return { 0: socket, 1: socket };
  };
  const token = await mintToken(TEST_USER_ID);
  const genParam = gen === undefined ? "" : `&gen=${gen}`;
  const req = new Request(
    `https://internal/ws/${TEST_PROJECT_ID}?token=${token}${genParam}`,
    { headers: { Upgrade: "websocket" } },
  );
  const response = await h.doInstance.fetch(req).catch(() => null);
  return { socket, response };
}

async function resetRequest(projectId: number = TEST_PROJECT_ID): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(projectId, TEST_SECRET, "reset");
  return new Request("https://internal/reset", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(projectId),
    },
  });
}

/** Decode a session-control message, or null if this is not one. */
function readControl(msg: Uint8Array): { subtype: number; value: number | null } | null {
  const decoder = decoding.createDecoder(msg);
  if (decoding.readVarUint(decoder) !== MSG_SESSION_CONTROL) return null;
  const subtype = decoding.readUint8(decoder);
  let value: number | null = null;
  try { value = decoding.readVarUint(decoder); } catch { value = null; }
  return { subtype, value };
}

function controlsIn(socket: ReturnType<typeof makeSocket>) {
  return socket.sent.map(readControl).filter((c) => c !== null);
}

function syncMessagesIn(socket: ReturnType<typeof makeSocket>) {
  return socket.sent.filter((m) => decoding.readVarUint(decoding.createDecoder(m)) === MSG_SYNC);
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { delete (globalThis as Record<string, unknown>).WebSocketPair; });

describe("document generation handshake", () => {
  it("tells a newly connected client which generation it is holding", async () => {
    const h = makeHarness();
    const socket = await upgrade(h);
    const gen = controlsIn(socket).find((c) => c!.subtype === SUB_DOC_GENERATION);
    expect(gen).toBeDefined();
    expect(gen!.value).toBe(0);
    expect(socket.closes).toEqual([]);
  });

  it("advances the generation on reset", async () => {
    const h = makeHarness();
    await upgrade(h);
    const res = await h.doInstance.fetch(await resetRequest());
    expect(res.status).toBe(200);

    const socket = await upgrade(h, FRESH);
    const gen = controlsIn(socket).find((c) => c!.subtype === SUB_DOC_GENERATION);
    expect(gen!.value).toBe(1);
  });

  it("refuses a client still holding a pre-reset document", async () => {
    const h = makeHarness();
    await upgrade(h); // learns generation 0
    await h.doInstance.fetch(await resetRequest());

    // The client's provider reconnects on its own, still presenting the
    // generation it synced at and still holding the pre-reset document.
    const socket = await upgrade(h, "0");

    // No sync exchange is opened with it at all — the refused document never
    // gets the chance to answer sync step 1 with its own state.
    expect(syncMessagesIn(socket)).toHaveLength(0);
    expect(controlsIn(socket).some((c) => c!.subtype === SUB_STATE_RESET)).toBe(true);
    expect(socket.closes).toEqual([1012]);
  });

  it("keeps ordinary reconnection lossless for a client at the current generation", async () => {
    const h = makeHarness();
    await upgrade(h);

    // A dropped connection: same document, same generation, straight back in.
    const socket = await upgrade(h, "0");
    expect(controlsIn(socket).some((c) => c!.subtype === SUB_STATE_RESET)).toBe(false);
    expect(socket.closes).toEqual([]);
    // Sync step 1 and sync step 2, exactly as before the guard existed.
    expect(syncMessagesIn(socket)).toHaveLength(2);
  });

  it("admits a client that says it has just built its document", async () => {
    const h = makeHarness();
    await upgrade(h);
    await h.doInstance.fetch(await resetRequest());

    // A fresh document — the client rebuilt, or is opening the project for the
    // first time — belongs to no generation and holds nothing that could
    // predate the rebuild, so it says so and is synced normally.
    const socket = await upgrade(h, FRESH);
    expect(controlsIn(socket).some((c) => c!.subtype === SUB_STATE_RESET)).toBe(false);
    expect(socket.closes).toEqual([]);
    expect(syncMessagesIn(socket)).toHaveLength(2);
    const gen = controlsIn(socket).find((c) => c!.subtype === SUB_DOC_GENERATION);
    expect(gen!.value).toBe(1);
  });

  it("refuses every client when the generation cannot be read", async () => {
    const h = makeHarness();
    // Durable Object storage is unavailable. The socket's attachment carries
    // the generation it was admitted under, and an unreadable one leaves
    // nothing honest to stamp: the upgrade is refused rather than admitted on
    // a guess, and the client's own reconnect schedule brings it back.
    (h.doInstance as unknown as { ctx: { storage: { get: () => Promise<unknown> } } })
      .ctx.storage.get = async () => { throw new Error("storage down"); };

    const { socket, response } = await attemptUpgrade(h, "9");
    expect(response?.status).toBe(503);
    expect(h.acceptWebSocket).not.toHaveBeenCalled();
    expect(syncMessagesIn(socket)).toHaveLength(0);
    // No reset frame either: a client is never told to discard its document on
    // the authority of a generation nothing read.
    expect(controlsIn(socket)).toHaveLength(0);
  });

  it("refuses the reset outright when the generation cannot be advanced", async () => {
    const h = makeHarness();
    await upgrade(h);
    (h.doInstance as unknown as { ctx: { storage: { put: () => Promise<void> } } })
      .ctx.storage.put = async () => { throw new Error("storage down"); };

    const res = await h.doInstance.fetch(await resetRequest());
    // A reset that cannot arm the guard would rebuild the document and then let
    // the pre-reset clients straight back in, so it stops before the rebuild.
    // Only the blob clear has run, which the retry repeats harmlessly.
    expect(res.status).toBe(503);
    const socket = await upgrade(h);
    const gen = controlsIn(socket).find((c) => c!.subtype === SUB_DOC_GENERATION);
    expect(gen!.value).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What a socket presenting no generation may do
// ---------------------------------------------------------------------------

describe("a socket that presents no generation", () => {
  it("is refused once the document has been reset", async () => {
    const h = makeHarness();
    await upgrade(h);
    await h.doInstance.fetch(await resetRequest());

    // Omitting the parameter is the whole of the attack. The guard's only
    // question is which document the socket holds, and a socket that declines
    // to answer must not reach the sync exchange, where it would answer sync
    // step 1 with its entire pre-reset document.
    const socket = await upgrade(h);
    expect(syncMessagesIn(socket)).toHaveLength(0);
    expect(controlsIn(socket).some((c) => c!.subtype === SUB_STATE_RESET)).toBe(true);
    expect(socket.closes).toEqual([1012]);
  });

  it("is admitted on a project that has never been reset", async () => {
    const h = makeHarness();
    // Nothing has been fenced off, so nothing a client holds can predate a
    // fence. Refusing here would lock out every client built before the guard
    // existed, on the projects where the guard has nothing to protect.
    const socket = await upgrade(h);
    expect(controlsIn(socket).some((c) => c!.subtype === SUB_STATE_RESET)).toBe(false);
    expect(socket.closes).toEqual([]);
    expect(syncMessagesIn(socket)).toHaveLength(2);
  });

  it("is refused when the generation cannot be read", async () => {
    const h = makeHarness();
    (h.doInstance as unknown as { ctx: { storage: { get: () => Promise<unknown> } } })
      .ctx.storage.get = async () => { throw new Error("storage down"); };
    const { socket, response } = await attemptUpgrade(h);
    expect(response?.status).toBe(503);
    expect(h.acceptWebSocket).not.toHaveBeenCalled();
    expect(syncMessagesIn(socket)).toHaveLength(0);
  });
});

describe("a client that has just built a document", () => {
  it("is admitted on a project that has never been reset", async () => {
    const h = makeHarness();
    const socket = await upgrade(h, FRESH);
    expect(socket.closes).toEqual([]);
    expect(syncMessagesIn(socket)).toHaveLength(2);
  });

  it("is admitted while another tab is already synced at the current generation", async () => {
    const h = makeHarness();
    await upgrade(h);
    await h.doInstance.fetch(await resetRequest());
    const rebuilt = await upgrade(h, FRESH);
    expect(rebuilt.closes).toEqual([]);

    // A second tab opens the same project and builds its own document.
    const secondTab = await upgrade(h, FRESH);
    expect(secondTab.closes).toEqual([]);
    expect(syncMessagesIn(secondTab)).toHaveLength(2);
  });

  it("is refused when the generation cannot be read", async () => {
    const h = makeHarness();
    (h.doInstance as unknown as { ctx: { storage: { get: () => Promise<unknown> } } })
      .ctx.storage.get = async () => { throw new Error("storage down"); };
    const { socket, response } = await attemptUpgrade(h, FRESH);
    expect(response?.status).toBe(503);
    expect(h.acceptWebSocket).not.toHaveBeenCalled();
    expect(syncMessagesIn(socket)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The reset itself: a cold instance, and a reset D1 refuses
// ---------------------------------------------------------------------------

describe("resetting an instance no client is connected to", () => {
  it("replaces the base in one conditioned write and advances the generation", async () => {
    const h = makeHarness();
    // The instance restores its project id from a live socket attachment and
    // has none: it was evicted, which is the state a project whose persistence
    // has halted is most likely to be in when its convenor asks for a reset.
    const res = await h.doInstance.fetch(await resetRequest());
    expect(res.status).toBe(200);
    // One write, carrying the new base and the revision it claims; the row
    // never passes through a NULL blob a writer from before the fence could
    // reach.
    expect(
      h.db.runs.filter((sql) =>
        /^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?, yjs_write = \?/.test(sql),
      ),
    ).toHaveLength(1);
    expect(h.db.runs.some((sql) => sql.includes("yjs_state = NULL"))).toBe(false);
    expect(h.storage.get("docGeneration")).toBe(1);
  });

  it("refuses a marker naming no usable project rather than reporting a reset it did not do", async () => {
    const h = makeHarness();
    const res = await h.doInstance.fetch(await resetRequest(0));
    expect(res.status).toBe(400);
    expect(h.db.runs.some((sql) => sql.startsWith("UPDATE projects"))).toBe(false);
  });
});

describe("a reset that cannot read the row it must replace", () => {
  it("leaves the generation where it was", async () => {
    const h = makeHarness();
    await upgrade(h); // a client synced at generation 0
    h.db.failFirstMatching = "SELECT yjs_state";

    const res = await h.doInstance.fetch(await resetRequest());
    expect(res.status).toBe(503);
    // Nothing was rebuilt, so nothing may be fenced off. A generation raised
    // over a reset that did not happen refuses every connected editor on its
    // next ordinary reconnection and discards whatever it queued offline.
    expect(h.storage.get("docGeneration")).toBeUndefined();
  });

  it("leaves a connected client's next reconnection ordinary", async () => {
    const h = makeHarness();
    await upgrade(h);
    h.db.failFirstMatching = "SELECT yjs_state";
    await h.doInstance.fetch(await resetRequest());

    const socket = await upgrade(h, "0");
    expect(controlsIn(socket).some((c) => c!.subtype === SUB_STATE_RESET)).toBe(false);
    expect(socket.closes).toEqual([]);
    expect(syncMessagesIn(socket)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The decision itself, stated as a table
// ---------------------------------------------------------------------------

describe("mayRejoinGeneration", () => {
  it("admits the three claims that cannot predate the last reset", () => {
    expect(mayRejoinGeneration("3", 3)).toBe(true);   // a reconnection
    expect(mayRejoinGeneration(FRESH, 3)).toBe(true); // a document just built
    expect(mayRejoinGeneration(null, 0)).toBe(true);  // nothing has been reset
    expect(mayRejoinGeneration("0", 0)).toBe(true);
  });

  it("refuses every claim that cannot show which side of a reset it is on", () => {
    expect(mayRejoinGeneration("2", 3)).toBe(false);  // a pre-reset document
    expect(mayRejoinGeneration(null, 3)).toBe(false); // declines to answer
    expect(mayRejoinGeneration("", 3)).toBe(false);
    expect(mayRejoinGeneration("newer", 3)).toBe(false);
    expect(mayRejoinGeneration("4", 3)).toBe(false);  // ahead of the document
  });
});
