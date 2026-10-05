/**
 * What a refused write leaves behind on the wire.
 *
 * Two measures, both through the real `webSocketMessage` with fake sockets. The
 * can-delete harnesses stub broadcasting out entirely, so neither the relay nor
 * the telemetry is observable from them.
 *
 *   - The relay of an UPDATE the guard reverted is dropped. The guard has
 *     already broadcast the corrected full state; applying that and then the
 *     original update leaves a peer exactly where the correction put them, so
 *     the relay costs a transmission and buys nothing. Every other sync subtype
 *     keeps its relay, step 2 included, even when it triggered a revert.
 *   - Edits still addressed to a container the guard displaced are counted.
 *     A client that has not applied the correction holds the displaced
 *     container, and its next edit references ITS items rather than the clone's.
 *     The count is partial by construction — see `workers/displaced-edits.ts`
 *     for exactly what it cannot see — and carries no user id and no values.
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

// A native ESM namespace is not configurable, so `vi.spyOn(Y, "decodeUpdate")`
// cannot redefine it directly. Re-exporting the module with `decodeUpdate`
// wrapped in a `vi.fn` gives every importer of "yjs" in this file's module
// graph — this file and `workers/displaced-edits.ts` alike — the same
// call-counting wrapper around the real implementation, which is what the
// expiry test below needs: proof the decode was never reached, not merely
// that no line was logged.
vi.mock("yjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yjs")>();
  return { ...actual, decodeUpdate: vi.fn(actual.decodeUpdate) };
});

import { ProjectCollaborationDO } from "../workers/collaboration";
import { makeCanDeleteHandler, makeViolationCounter } from "../workers/can-delete";
import {
  collectDisplacedRanges, createDisplacementLog, type DisplacementLog,
} from "../workers/displaced-edits";
import { checkD1Bind } from "./helpers/d1-memory";

const PROJECT_ID = 42;
const messageSync = 0;
const OWNER = 1;
const EDITOR = 2;

type Role = "convenor" | "collaborator" | "instructor";

function fakeSocket(userId: number, role: Role = "collaborator") {
  // The generation matches the instance cache `makeDo` initialises: the
  // message handler fences every socket against it before the document is
  // touched, so an attachment without one is closed rather than applied.
  // Admitted just now, so the membership recheck is not yet due.
  const attachment = { userId, projectId: PROJECT_ID, role, generation: 0, membershipCheckedAt: Date.now() };
  return {
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

type FakeSocket = ReturnType<typeof fakeSocket>;

/** The document D1 hands back: one story, one step, one multi-word question. */
function seedDoc(options: { emptySteps?: boolean; landing?: boolean } = {}): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const story = new Y.Map<unknown>();
    const steps = new Y.Array<unknown>();
    if (!options.emptySteps) {
      const step = new Y.Map<unknown>();
      step.set("_id", 11);
      step.set("created_by", OWNER);
      step.set("question", new Y.Text("hello there"));
      steps.push([step]);
    }
    story.set("_id", 7);
    story.set("story_id", "s1");
    story.set("created_by", OWNER);
    story.set("title", new Y.Text("Story One"));
    story.set("steps", steps);
    doc.getArray<unknown>("stories").push([story]);
    if (options.landing) doc.getMap<unknown>("config").set("landing", new Y.Map<unknown>());
  }, null);
  return doc;
}

function makeDo(blob: Uint8Array) {
  const sockets: FakeSocket[] = [];
  const ctx = {
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
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
  };
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        checkD1Bind(sql, args);
        return {
        async run() { return { meta: { last_row_id: 1, changes: 1 }, success: true as const }; },
        async all() { return { results: [], success: true as const }; },
        async first() {
          return /^SELECT yjs_state/.test(sql)
            ? { yjs_state: blob.buffer, yjs_generation: 0, yjs_seq: 0, yjs_write: 0 }
            : null;
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
  return { doInstance, sockets };
}

const deliver = (doInstance: ProjectCollaborationDO, ws: unknown, msg: Uint8Array) =>
  (doInstance as unknown as {
    webSocketMessage: (ws: unknown, m: Uint8Array) => Promise<void>;
  }).webSocketMessage(ws, msg);

const serverDoc = (doInstance: ProjectCollaborationDO): Y.Doc =>
  (doInstance as unknown as { ydoc: Y.Doc }).ydoc;

const displacementsOf = (doInstance: ProjectCollaborationDO): DisplacementLog =>
  (doInstance as unknown as { displacements: DisplacementLog }).displacements;

/** A client holding the same state the server loaded. */
function clientFrom(blob: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, blob);
  return doc;
}

const firstStory = (doc: Y.Doc): Y.Map<unknown> =>
  doc.getArray<Y.Map<unknown>>("stories").get(0);

/**
 * The update one client edit produces, wrapped as a sync UPDATE message.
 *
 * Taken from the document's own `update` event, which is what the provider
 * sends: it carries the transaction's structs and the transaction's DELETIONS.
 * An `encodeStateAsUpdate` diff would carry the document's whole delete set
 * instead — every deletion the client knows about, on every keystroke — which
 * is a message shape no editor sends and which would make the deletion half of
 * the telemetry fire for any client that has applied the correction.
 */
function updateMessage(client: Y.Doc, edit: () => void): Uint8Array {
  let captured: Uint8Array | null = null;
  const onUpdate = (update: Uint8Array) => {
    captured = captured === null ? update : Y.mergeUpdates([captured, update]);
  };
  client.on("update", onUpdate);
  client.transact(edit);
  client.off("update", onUpdate);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeUpdate(enc, captured ?? new Uint8Array([0, 0]));
  return encoding.toUint8Array(enc);
}

/** A client's whole state, wrapped as a sync step 2 message. */
function step2Message(client: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeSyncStep2(enc, client);
  return encoding.toUint8Array(enc);
}

/** A client's state vector, wrapped as a sync step 1 message. */
function step1Message(client: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, messageSync);
  syncProtocol.writeSyncStep1(enc, client);
  return encoding.toUint8Array(enc);
}

/** Everything a socket was sent, applied to a document of its own. */
function applyReceived(received: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const message of received) {
    const decoder = decoding.createDecoder(message);
    decoding.readVarUint(decoder); // messageSync
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, null);
  }
  return doc;
}

const sentTo = (ws: FakeSocket): Uint8Array[] =>
  ws.send.mock.calls.map((call) => call[0] as Uint8Array);

/** Every warning line this test has seen, in order. */
let warned: string[] = [];

const orphanLines = (): string[] =>
  warned.filter((line) => line.startsWith("[structural][orphaned-edit]"));

beforeEach(() => {
  vi.clearAllMocks();
  warned = [];
  vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
    warned.push(String(message));
  });
  vi.spyOn(console, "error").mockImplementation(() => { /* the containment log */ });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the relay of a reverted update", () => {
  it("is dropped, and the peer converges on the corrected state instead", async () => {
    const blob = Y.encodeStateAsUpdate(seedDoc());
    const { doInstance, sockets } = makeDo(blob);
    const a = fakeSocket(EDITOR);
    const b = fakeSocket(3);
    sockets.push(a, b);

    const client = clientFrom(blob);
    const message = updateMessage(client, () => {
      (firstStory(client).get("title") as Y.Text).insert(9, "!");
      firstStory(client).set("steps", new Y.Map<unknown>());
    });
    await deliver(doInstance, a, message);

    const received = sentTo(b);
    expect(received.length).toBe(1);
    expect(received[0]).not.toEqual(message);

    const peer = applyReceived(received);
    const server = serverDoc(doInstance);
    // The refused write is not in the peer's document, the legitimate one is,
    // and the two documents agree.
    expect((firstStory(peer).get("steps") as Y.Array<unknown>).length).toBe(1);
    expect(String(firstStory(peer).get("title"))).toBe("Story One!");
    expect(String(firstStory(server).get("title"))).toBe("Story One!");
    expect(Y.encodeStateVector(peer)).toEqual(Y.encodeStateVector(server));
  });

  it("is kept for a permitted update", async () => {
    const blob = Y.encodeStateAsUpdate(seedDoc());
    const { doInstance, sockets } = makeDo(blob);
    const a = fakeSocket(EDITOR);
    const b = fakeSocket(3);
    sockets.push(a, b);

    const client = clientFrom(blob);
    const message = updateMessage(client, () => {
      (firstStory(client).get("title") as Y.Text).insert(9, "?");
    });
    await deliver(doInstance, a, message);

    expect(sentTo(b)).toEqual([message]);
  });

  it("is kept for a sync step 2 that triggered a revert", async () => {
    const blob = Y.encodeStateAsUpdate(seedDoc());
    const { doInstance, sockets } = makeDo(blob);
    const a = fakeSocket(EDITOR);
    const b = fakeSocket(3);
    sockets.push(a, b);

    const client = clientFrom(blob);
    client.transact(() => { firstStory(client).set("steps", new Y.Map<unknown>()); });
    const message = step2Message(client);
    await deliver(doInstance, a, message);

    // The relay AND the guard's corrected broadcast.
    expect(sentTo(b)).toContainEqual(message);
    expect(sentTo(b).length).toBe(2);
    expect((firstStory(serverDoc(doInstance)).get("steps") as Y.Array<unknown>).length).toBe(1);
  });

  it("is not suppressed when the corrected state could not be broadcast", () => {
    // Read at the guard's own seam: the relay is the only thing left carrying
    // the transaction's legitimate half when the correction did not go out, so
    // the flag must not be set on that path. Driving this through the message
    // handler would mean breaking the socket list the relay itself walks.
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seedDoc()));
    const reverting = { value: false };
    let noted = 0;
    ydoc.on("afterTransaction", makeCanDeleteHandler({
      ydoc,
      isSnapshotting: () => false,
      isReverting: () => reverting.value,
      setReverting: (v: boolean) => { reverting.value = v; },
      getSockets: () => [] as unknown as Iterable<WebSocket>,
      broadcastUpdate: () => { throw new Error("every socket has gone"); },
      recordViolation: makeViolationCounter(),
      warn: () => { /* asserted through the counter */ },
      noteRevert: () => { noted++; },
    }));

    ydoc.transact(() => {
      firstStory(ydoc).set("steps", new Y.Map<unknown>());
    }, fakeSocket(EDITOR));

    expect((firstStory(ydoc).get("steps") as Y.Array<unknown>).length).toBe(1);
    expect(noted).toBe(0);
  });

  it("starts every message with the flag clear", async () => {
    const blob = Y.encodeStateAsUpdate(seedDoc());
    const { doInstance, sockets } = makeDo(blob);
    const a = fakeSocket(EDITOR);
    const b = fakeSocket(3);
    sockets.push(a, b);

    const client = clientFrom(blob);
    await deliver(doInstance, a, updateMessage(client, () => {
      firstStory(client).set("steps", new Y.Map<unknown>());
    }));
    b.send.mockClear();

    const permitted = updateMessage(client, () => {
      (firstStory(client).get("title") as Y.Text).insert(9, "?");
    });
    await deliver(doInstance, a, permitted);

    expect(sentTo(b)).toEqual([permitted]);
    expect((doInstance as unknown as { revertedThisMessage: boolean })
      .revertedThisMessage).toBe(false);
  });

  it("relays a permitted update after a step 2 that triggered a revert", async () => {
    const blob = Y.encodeStateAsUpdate(seedDoc());
    const { doInstance, sockets } = makeDo(blob);
    const a = fakeSocket(EDITOR);
    const b = fakeSocket(3);
    sockets.push(a, b);

    const client = clientFrom(blob);
    client.transact(() => { firstStory(client).set("steps", new Y.Map<unknown>()); });
    await deliver(doInstance, a, step2Message(client));
    b.send.mockClear();

    const permitted = updateMessage(client, () => {
      (firstStory(client).get("title") as Y.Text).insert(9, "!");
    });
    await deliver(doInstance, a, permitted);

    expect(sentTo(b)).toEqual([permitted]);
    expect((doInstance as unknown as { revertedThisMessage: boolean })
      .revertedThisMessage).toBe(false);
  });

  it("replies to an inbound step 1 and relays it", async () => {
    const blob = Y.encodeStateAsUpdate(seedDoc());
    const { doInstance, sockets } = makeDo(blob);
    const a = fakeSocket(EDITOR);
    const b = fakeSocket(3);
    sockets.push(a, b);

    // An empty client's own state vector — an ordinary connecting peer.
    const message = step1Message(new Y.Doc());
    await deliver(doInstance, a, message);

    // The step 2 reply goes back to the sender...
    expect(a.send).toHaveBeenCalledTimes(1);
    // ...and the step 1 itself, like every subtype but a reverted update, is
    // relayed unchanged to every other socket.
    expect(sentTo(b)).toEqual([message]);
  });

  it("clears the flag on the next message even when a step after the apply throws", async () => {
    const blob = Y.encodeStateAsUpdate(seedDoc());
    const { doInstance, sockets } = makeDo(blob);
    const a = fakeSocket(EDITOR);
    const b = fakeSocket(3);
    sockets.push(a, b);

    const client = clientFrom(blob);
    const reverted = updateMessage(client, () => {
      firstStory(client).set("steps", new Y.Map<unknown>());
    });

    // A step after the apply throwing — flushActivityRows is ordinarily
    // best-effort and non-throwing, so this is a deliberately unusual failure
    // forced to prove the finally covers it, not a realistic one.
    const flushSpy = vi.spyOn(
      doInstance as unknown as { flushActivityRows: () => Promise<void> },
      "flushActivityRows",
    ).mockImplementationOnce(() => { throw new Error("simulated post-apply failure"); });

    await expect(deliver(doInstance, a, reverted)).rejects.toThrow("simulated post-apply failure");
    expect((doInstance as unknown as { revertedThisMessage: boolean })
      .revertedThisMessage).toBe(false);
    flushSpy.mockRestore();
    b.send.mockClear();

    const permitted = updateMessage(client, () => {
      (firstStory(client).get("title") as Y.Text).insert(9, "?");
    });
    await deliver(doInstance, a, permitted);

    expect(sentTo(b)).toEqual([permitted]);
  });
});

describe("edits addressed to a displaced container", () => {
  /**
   * Displace the story's `steps` through the real message path, and hand back a
   * client still holding the container that was taken away.
   */
  async function displace(options: { emptySteps?: boolean } = {}) {
    const blob = Y.encodeStateAsUpdate(seedDoc(options));
    const { doInstance, sockets } = makeDo(blob);
    const a = fakeSocket(EDITOR);
    sockets.push(a);
    const stale = clientFrom(blob);
    const planter = clientFrom(blob);
    await deliver(doInstance, a, updateMessage(planter, () => {
      firstStory(planter).set("steps", new Y.Array<unknown>());
    }));
    warned = [];
    return { doInstance, a, stale };
  }

  it("counts an append after multi-character text inside the subtree", async () => {
    const { doInstance, a, stale } = await displace();
    await deliver(doInstance, a, updateMessage(stale, () => {
      const step = (firstStory(stale).get("steps") as Y.Array<Y.Map<unknown>>).get(0);
      (step.get("question") as Y.Text).insert(11, " friend");
    }));

    const lines = orphanLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(`project ${PROJECT_ID}`);
    expect(lines[0]).toMatch(/1 struct\(s\), 0 deletion range\(s\)/);
  });

  it("counts an interior insertion, which references a split item", async () => {
    const { doInstance, a, stale } = await displace();
    await deliver(doInstance, a, updateMessage(stale, () => {
      const step = (firstStory(stale).get("steps") as Y.Array<Y.Map<unknown>>).get(0);
      (step.get("question") as Y.Text).insert(5, ",");
    }));

    expect(orphanLines().length).toBe(1);
  });

  it("counts an interior deletion inside that text", async () => {
    const { doInstance, a, stale } = await displace();
    await deliver(doInstance, a, updateMessage(stale, () => {
      const step = (firstStory(stale).get("steps") as Y.Array<Y.Map<unknown>>).get(0);
      (step.get("question") as Y.Text).delete(4, 2);
    }));

    const lines = orphanLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/deletion range\(s\)/);
  });

  it("counts a new key set on a map inside the subtree", async () => {
    const { doInstance, a, stale } = await displace();
    await deliver(doInstance, a, updateMessage(stale, () => {
      const step = (firstStory(stale).get("steps") as Y.Array<Y.Map<unknown>>).get(0);
      step.set("alt_text", "a description");
    }));

    expect(orphanLines().length).toBe(1);
  });

  it("counts a first insertion into a displaced empty array", async () => {
    const { doInstance, a, stale } = await displace({ emptySteps: true });
    await deliver(doInstance, a, updateMessage(stale, () => {
      const step = new Y.Map<unknown>();
      step.set("_id", null);
      step.set("_temp_id", "new-step");
      (firstStory(stale).get("steps") as Y.Array<unknown>).push([step]);
    }));

    expect(orphanLines().length).toBe(1);
  });

  it("counts a new key set on a displaced map", async () => {
    // `landing` is the one structural key holding a map rather than an array,
    // and a collaborator may write it, so the structural pass is the only rule
    // that fires here.
    const blob = Y.encodeStateAsUpdate(seedDoc({ landing: true }));
    const { doInstance, sockets } = makeDo(blob);
    const a = fakeSocket(EDITOR);
    sockets.push(a);
    const stale = clientFrom(blob);
    const planter = clientFrom(blob);
    await deliver(doInstance, a, updateMessage(planter, () => {
      planter.getMap<unknown>("config").set("landing", new Y.Array<unknown>());
    }));
    warned = [];

    await deliver(doInstance, a, updateMessage(stale, () => {
      (stale.getMap<unknown>("config").get("landing") as Y.Map<unknown>)
        .set("headline", "a headline");
    }));

    expect(orphanLines().length).toBe(1);
  });

  it("says nothing about an edit addressed to the clone", async () => {
    const { doInstance, a } = await displace();
    // A client that HAS applied the correction: its document is the server's,
    // including the rebuilt `steps` the correction put in the displaced
    // array's place. The edit below lands inside THAT clone — a fresh struct
    // with an id the recorded ranges cannot cover, which is the case this
    // test actually needs: an edit to an unrelated field would say nothing
    // regardless of whether the clone's own ids are matched correctly.
    const fresh = clientFrom(Y.encodeStateAsUpdate(serverDoc(doInstance)));
    await deliver(doInstance, a, updateMessage(fresh, () => {
      const step = (firstStory(fresh).get("steps") as Y.Array<Y.Map<unknown>>).get(0);
      (step.get("question") as Y.Text).insert(11, " friend");
    }));

    expect(orphanLines()).toEqual([]);
  });

  it("says nothing once the window has passed, and never decodes to find out", async () => {
    vi.useFakeTimers();
    const { doInstance, a, stale } = await displace();
    vi.setSystemTime(Date.now() + 61_000);

    // Not only silent — the expired-displacement path returns before it ever
    // reaches `Y.decodeUpdate`, so a stale client flooding the socket after
    // its correction has aged out costs no decode per message, not merely no
    // log line. `Y.decodeUpdate` is the module-mocked, call-counting wrapper
    // declared above; `displace()` above records the displacement without
    // going through it, so the count entering this message is already zero.
    const decodeCallsBefore = (Y.decodeUpdate as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length;
    await deliver(doInstance, a, updateMessage(stale, () => {
      const step = (firstStory(stale).get("steps") as Y.Array<Y.Map<unknown>>).get(0);
      (step.get("question") as Y.Text).insert(11, " friend");
    }));

    expect(orphanLines()).toEqual([]);
    expect(displacementsOf(doInstance).size()).toBe(0);
    expect((Y.decodeUpdate as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length).toBe(decodeCallsBefore);
  });

  it("contains a malformed update while the telemetry is active", async () => {
    const { doInstance, a } = await displace();
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageSync);
    syncProtocol.writeUpdate(enc, new Uint8Array([9, 9, 9, 9, 9, 9]));

    await expect(deliver(doInstance, a, encoding.toUint8Array(enc))).resolves.toBeUndefined();
    expect(orphanLines()).toEqual([]);
    // The document is untouched and still enforceable.
    expect((firstStory(serverDoc(doInstance)).get("steps") as Y.Array<unknown>).length).toBe(1);
  });
});

describe("the telemetry is bounded", () => {
  it("stops recording ranges at the cap", () => {
    const doc = new Y.Doc();
    // Distinct Y.Map keys, not consecutive array pushes: forty `array.push`
    // calls in one transaction merge into a single struct at cleanup, which
    // would leave the cap untested. A key's item chain is its own — it can
    // never merge with a neighbouring key's — so twelve keys are twelve
    // structs, twelve confirmed above the cap below.
    const map = doc.getMap<unknown>("config");
    doc.transact(() => {
      for (let i = 0; i < 12; i++) map.set(`key${i}`, `value ${i}`);
    }, null);
    expect(collectDisplacedRanges(map as unknown as Y.AbstractType<unknown>, 8).length).toBe(8);
  });

  it("holds no more displacements than the cap, evicting the oldest", () => {
    let clock = 1_000;
    const log = createDisplacementLog({ now: () => clock, cap: 3, ttlMs: 60_000 });
    for (let i = 0; i < 10; i++) {
      clock += 1;
      log.record([{ client: i, from: 0, to: 1 }]);
    }
    expect(log.size()).toBe(3);
  });

  it("expires a displacement on read as well as on insert", () => {
    let clock = 1_000;
    const log = createDisplacementLog({ now: () => clock, cap: 64, ttlMs: 60_000 });
    log.record([{ client: 1, from: 0, to: 1 }]);
    expect(log.size()).toBe(1);
    clock += 60_001;
    expect(log.size()).toBe(0);
  });
});
