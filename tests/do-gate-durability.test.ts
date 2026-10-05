/**
 * A throw inside `blockConcurrencyWhile` resets the Durable Object.
 *
 * Cloudflare terminates and discards a DO when an exception escapes a gate
 * callback, so a `catch` wrapped AROUND the gate never protects anything — it
 * only shapes the response of an instance that has already been thrown away.
 * Every gated route in `workers/collaboration.ts` awaits D1 inside its
 * callback, so a transient D1 failure is enough to drop every socket and lose
 * the unflushed Y.Doc.
 *
 * Each test below drives one gated route with the failure it can actually
 * meet, through `fetchAsRuntime`, and asserts two things together:
 *   - the route answers with its intended status, and
 *   - `gate.terminated` is still false — the callback resolved, so the
 *     instance survived and its document is intact.
 *
 * Asserting only the status is what let the pre-fix `/snapshot` test pass
 * against a path production could not reach.
 *
 * @version v1.5.0-beta
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
import { signInternalMarker } from "../workers/auth";
import { makeGate, makeGateState, fetchAsRuntime, type GateState } from "./helpers/do-gate";
import { markLoaded } from "./helpers/claimed-document";
import { checkD1Bind } from "./helpers/d1-memory";

/**
 * Durable Object key-value storage. The DO reads the document generation from
 * it on every socket upgrade and writes it on `/reset`, so a stub that only
 * answers the alarm calls leaves the reset unable to arm its guard. Each
 * harness gets its own store.
 */
function makeStorageStub(extra: Record<string, unknown> = {}) {
  const kv = new Map<string, unknown>();
  return {
    getAlarm: async () => null,
    setAlarm: async () => {},
    get: async (key: string) => kv.get(key),
    put: async (key: string, value: unknown) => { kv.set(key, value); },
    // A load lists the log prefix before it tags an untagged blob or builds one.
    list: async () => new Map(),
    // The snapshot and the reset retire a storage base header by deleting it.
    delete: async (keys: string[]) => keys.filter((key) => kv.delete(key)).length,
    ...extra,
  };
}


const TEST_SECRET = "test-session-secret";
const TEST_PROJECT_ID = 42;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeSocket {
  attachment: {
    userId: number;
    projectId: number;
    role: "convenor" | "collaborator";
    generation: number;
  };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  serializeAttachment: ReturnType<typeof vi.fn>;
  deserializeAttachment: () => FakeSocket["attachment"];
}

function fakeSocket(userId: number): FakeSocket {
  const attachment = {
    userId,
    projectId: TEST_PROJECT_ID,
    role: "collaborator" as const,
    // The generation `makeStorageStub` answers with. The wake path closes any
    // socket attached to another one before it loads, so a fixture without
    // this is a socket the constructor evicts rather than one it keeps.
    generation: 0,
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
 * A D1 stub whose reads and writes are fine by default. `failRun` makes every
 * `.run()` whose SQL matches reject, and `failFirst` every `.first()`, which is
 * the transient-D1 shape each gated callback has to survive.
 */
function makeDb(opts: { failRun?: RegExp; failFirst?: RegExp } = {}) {
  const seen: string[] = [];
  return {
    seen,
    DB: {
      prepare(sql: string) {
        const stmt = {
          bind: (...args: unknown[]) => { checkD1Bind(sql, args); return stmt; },
          async run() {
            seen.push(sql);
            if (opts.failRun?.test(sql)) throw new Error("D1_ERROR: injected write failure");
            return { meta: { last_row_id: 1, changes: 1 }, success: true as const };
          },
          async all() {
            return { results: [] as unknown[], success: true as const };
          },
          async first() {
            if (opts.failFirst?.test(sql)) throw new Error("D1_ERROR: injected read failure");
            // The base row every load and every reset reads: no blob, no tags,
            // no claim yet, which is the cold build.
            return /^SELECT yjs_state|^SELECT yjs_generation/.test(sql)
              ? { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: 0 }
              : null;
          },
        };
        return stmt;
      },
      async batch() {
        return [];
      },
    },
  };
}

function makeDo(
  opts: {
    sockets?: FakeSocket[];
    failRun?: RegExp;
    failFirst?: RegExp;
    /** Leave the doc unloaded so the route's own ensureDocLoaded runs for real. */
    realEnsureDocLoaded?: boolean;
  } = {},
) {
  const gate: GateState = makeGateState();
  const live: FakeSocket[] = [];
  const alarms: number[] = [];
  const ctx = {
    getWebSockets: () => live,
    blockConcurrencyWhile: makeGate(gate),
    storage: makeStorageStub({
      getAlarm: async () => (alarms.length ? alarms[alarms.length - 1] : null),
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      setAlarm: async (t: number) => {
        alarms.push(t);
      },
    }),
    acceptWebSocket: vi.fn(),
  };
  const db = makeDb({ failRun: opts.failRun, failFirst: opts.failFirst });
  const env = { DB: db.DB as unknown, SESSION_SECRET: TEST_SECRET, COLLABORATION: {} as unknown };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  live.push(...(opts.sockets ?? []));
  (doInstance as unknown as { projectId: number }).projectId = TEST_PROJECT_ID;
  if (!opts.realEnsureDocLoaded) {
    (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded =
      async () => {
        markLoaded(doInstance);
      };
  }
  const snapshotSpy = vi
    .spyOn(doInstance as unknown as { snapshotToD1: () => Promise<void> }, "snapshotToD1")
    .mockResolvedValue(undefined);
  const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
  return { doInstance, gate, db, ydoc, snapshotSpy, ctx };
}

async function signedRequest(
  pathname: string,
  op: string,
  body?: unknown,
): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(TEST_PROJECT_ID, TEST_SECRET, op);
  const headers: Record<string, string> = {
    "X-Internal-Auth": sigHex,
    "X-Internal-Timestamp": String(timestamp),
    "X-Internal-Project": String(TEST_PROJECT_ID),
  };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return new Request(`https://internal${pathname}`, { method: "POST", headers, body: payload });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /snapshot — the publish pipeline's fail-closed signal
// ---------------------------------------------------------------------------

describe("gate durability — POST /snapshot", () => {
  it("answers 500 snapshot_failed WITHOUT resetting the DO when the snapshot throws", async () => {
    const { doInstance, gate, snapshotSpy } = makeDo();
    snapshotSpy.mockRejectedValueOnce(new Error("D1_ERROR: batch failed"));

    const res = await fetchAsRuntime(
      doInstance,
      gate,
      await signedRequest("/snapshot", "snapshot"),
    );

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("snapshot_failed");
    expect(gate.terminated).toBe(false);
  });

  it("binds from the marker and flushes when no project is bound (no live editing session)", async () => {
    // The publish action's "publish from D1" case. A stub fetch instantiates
    // the DO on demand, so an absent instance is created and answers here —
    // and it answers by flushing, because the blob is written ahead of the row
    // batch and an unbound instance says nothing about which of the two D1
    // holds. The gate still has to survive it.
    const { doInstance, gate, snapshotSpy } = makeDo();
    (doInstance as unknown as { projectId: number | null }).projectId = null;

    const res = await fetchAsRuntime(
      doInstance,
      gate,
      await signedRequest("/snapshot", "snapshot"),
    );

    expect(res.status).toBe(200);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(gate.terminated).toBe(false);
  });

  it("still answers 200 when the snapshot succeeds", async () => {
    const { doInstance, gate, snapshotSpy } = makeDo();

    const res = await fetchAsRuntime(
      doInstance,
      gate,
      await signedRequest("/snapshot", "snapshot"),
    );

    expect(res.status).toBe(200);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(gate.terminated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /reset — the recovery path. It must survive its own failures, and it
// must never refuse on the broken state it exists to clear.
// ---------------------------------------------------------------------------

describe("gate durability — POST /reset", () => {
  it("answers 503 reset_failed WITHOUT resetting the DO when the row read throws", async () => {
    const { doInstance, gate, ydoc } = makeDo({ failFirst: /^SELECT yjs_state/ });
    ydoc.transact(() => {
      ydoc.getMap<unknown>("config").set("title", new Y.Text("Before"));
    }, null);

    const res = await fetchAsRuntime(doInstance, gate, await signedRequest("/reset", "reset"));

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("reset_failed");
    expect(gate.terminated).toBe(false);
    // The row read comes before the generation is advanced and before the
    // document is replaced: nothing was destroyed, so a retry starts clean.
    const stillLive = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    expect(stillLive.getMap<unknown>("config").get("title")).toBeDefined();
  });

  it("answers 503 and still closes every socket when the rebuild throws", async () => {
    const ws = fakeSocket(1);
    const { doInstance, gate } = makeDo({ sockets: [ws] });
    (doInstance as unknown as { buildFromD1Rows: () => Promise<void> }).buildFromD1Rows =
      async () => {
        throw new Error("D1_ERROR: rebuild read failed");
      };

    const res = await fetchAsRuntime(doInstance, gate, await signedRequest("/reset", "reset"));

    expect(res.status).toBe(503);
    expect(gate.terminated).toBe(false);
    // Clients must be pushed off a half-rebuilt document rather than left
    // talking to it.
    expect(ws.close).toHaveBeenCalled();
  });

  it("still answers 200 and rebuilds when D1 is healthy", async () => {
    const { doInstance, gate } = makeDo();

    const res = await fetchAsRuntime(doInstance, gate, await signedRequest("/reset", "reset"));

    expect(res.status).toBe(200);
    expect(gate.terminated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /restore-orphans and POST /ingest-sync — both mutate the Y.Doc inside
// the gate and then snapshot. A reset here loses the mutation outright.
// ---------------------------------------------------------------------------

describe("gate durability — POST /restore-orphans", () => {
  it("answers 503 and keeps the restored story in the document when the snapshot throws", async () => {
    const { doInstance, gate, ydoc, snapshotSpy } = makeDo();
    snapshotSpy.mockRejectedValueOnce(new Error("D1_ERROR: batch failed"));

    const res = await fetchAsRuntime(
      doInstance,
      gate,
      await signedRequest("/restore-orphans", "restore-orphans", {
        stories: [{ storyId: "draft-foo", steps: [], layers: [] }],
      }),
    );

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("snapshot_failed");
    expect(gate.terminated).toBe(false);
    // The in-memory mutation survives, so the next snapshot persists it.
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(1);
    expect(stories.get(0).get("story_id")).toBe("draft-foo");
  });
});

describe("gate durability — POST /ingest-sync", () => {
  it("answers 503 and keeps the applied config edit when the snapshot throws", async () => {
    const { doInstance, gate, ydoc, snapshotSpy } = makeDo();
    snapshotSpy.mockRejectedValueOnce(new Error("D1_ERROR: batch failed"));

    const res = await fetchAsRuntime(
      doInstance,
      gate,
      await signedRequest("/ingest-sync", "ingest-sync", {
        config: [{ key: "title", value: "Ingested title" }],
      }),
    );

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("snapshot_failed");
    expect(gate.terminated).toBe(false);
    expect(String(ydoc.getMap<unknown>("config").get("title"))).toBe("Ingested title");
  });
});

// ---------------------------------------------------------------------------
// POST /clear-course-markers — already refuses rather than lying when the
// flush does not run. A THROWN flush must land in the same refusal.
// ---------------------------------------------------------------------------

describe("gate durability — POST /clear-course-markers", () => {
  it("answers 503 snapshot_blocked WITHOUT resetting the DO when the flush throws", async () => {
    const { doInstance, gate, ydoc, snapshotSpy } = makeDo();
    // Every flush attempt must fail, so the route exhausts its retry budget.
    snapshotSpy.mockRejectedValue(new Error("D1_ERROR: batch failed"));
    ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", 5);
      m.set("object_id", "obj-course");
      m.set("course_project_id", 99);
      ydoc.getArray<Y.Map<unknown>>("objects").push([m]);
    }, null);

    const res = await fetchAsRuntime(
      doInstance,
      gate,
      await signedRequest("/clear-course-markers", "clear-course-markers", {
        courseProjectId: 99,
      }),
    );

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("snapshot_blocked");
    expect(gate.terminated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WebSocket upgrade — the cold-start load sits in its own gate.
// ---------------------------------------------------------------------------

describe("gate durability — WebSocket upgrade cold start", () => {
  it("answers 503 WITHOUT resetting the DO when the cold-start load throws", async () => {
    const gate = makeGateState();
    const live: FakeSocket[] = [];
    const ctx = {
      getWebSockets: () => live,
      blockConcurrencyWhile: makeGate(gate),
      storage: makeStorageStub(),
      acceptWebSocket: vi.fn(),
    };
    const env = {
      DB: {
        prepare(sql: string) {
          const stmt = {
            bind: (...args: unknown[]) => { checkD1Bind(sql, args); return stmt; },
            async first() {
              return sql.includes("FROM project_members") ? { role: "collaborator" } : null;
            },
            async all() {
              return { results: [] as unknown[] };
            },
            async run() {
              return { meta: { last_row_id: 1, changes: 1 } };
            },
          };
          return stmt;
        },
        async batch() {
          return [];
        },
      } as unknown,
      SESSION_SECRET: TEST_SECRET,
      COLLABORATION: {} as unknown,
    };
    const doInstance = new ProjectCollaborationDO(
      ctx as unknown as DurableObjectState,
      env as unknown as Env,
    );
    (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded =
      async () => {
        throw new Error("D1_ERROR: cold-start read failed");
      };

    const token = await mintSessionToken(1);
    const req = new Request(`https://internal/ws/${TEST_PROJECT_ID}?token=${token}`, {
      headers: { Upgrade: "websocket" },
    });

    const res = await fetchAsRuntime(doInstance, gate, req);

    expect(res.status).toBe(503);
    expect(gate.terminated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constructor — the hibernation-wake load. There is no response to shape here,
// but a throw still discards the instance and drops every hibernated socket.
// ---------------------------------------------------------------------------

describe("gate durability — constructor hibernation wake", () => {
  it("does not reset the DO when the wake-time document load throws", async () => {
    const gate = makeGateState();
    const ws = fakeSocket(1);
    const live: FakeSocket[] = [ws];
    const ctx = {
      getWebSockets: () => live,
      blockConcurrencyWhile: makeGate(gate),
      storage: makeStorageStub(),
      acceptWebSocket: vi.fn(),
    };
    const env = {
      DB: {
        prepare() {
          const stmt = {
            bind: (...args: unknown[]) => { checkD1Bind(undefined, args); return stmt; },
            async first(): Promise<unknown> {
              throw new Error("D1_ERROR: wake read failed");
            },
            async all() {
              return { results: [] as unknown[] };
            },
            async run() {
              return { meta: { last_row_id: 1, changes: 1 } };
            },
          };
          return stmt;
        },
        async batch() {
          return [];
        },
      } as unknown,
      SESSION_SECRET: TEST_SECRET,
      COLLABORATION: {} as unknown,
    };

    const doInstance = new ProjectCollaborationDO(
      ctx as unknown as DurableObjectState,
      env as unknown as Env,
    );
    // The constructor's gate is deliberately not awaited; give its microtasks a
    // turn before asserting.
    await new Promise((r) => setTimeout(r, 0));

    expect(gate.terminated).toBe(false);
    // The load did not happen, so it must remain outstanding for a later
    // ensureDocLoaded rather than be recorded as done.
    expect((doInstance as unknown as { docLoaded: boolean }).docLoaded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token minting for the upgrade path (mirrors workers/auth's session format).
// ---------------------------------------------------------------------------

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function mintSessionToken(userId: number): Promise<string> {
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
