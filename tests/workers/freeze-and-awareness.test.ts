/**
 * The freeze lease and awareness ownership, against the real class and real
 * workerd sockets.
 *
 * An awareness field is something any member can set, and an awareness entry
 * names whichever client its sender chooses, so neither can carry a freeze or
 * be trusted to describe another member. These cases hold the object to that:
 * a freeze exists only as a lease a signed request started, every socket
 * hears of it, a socket arriving later hears of it on admission, and a
 * socket's awareness reaches the others only for its own client id.
 *
 * The awareness holds no timer, so the object can be evicted, and what it
 * held is rebuilt on a wake from the update each socket's attachment keeps
 *. An entry that says its page is hidden is kept for longer, on the
 * same rule as the clients.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import type * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { signInternalMarker } from "../../workers/auth";
import { hibernate } from "./helpers/hibernate";
import { HIDDEN_PRESENCE_LIMIT_MS } from "~/lib/presence-expiry";
import {
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  addMember,
  clientSyncStep1,
  drainAcceptanceFrames,
  openSocket,
  readFreezeFrame,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";

/** Send one lease control to the project's object, signed as the actions sign it. */
async function control(fixture: Fixture, text: string, userId = fixture.userId, sign = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (sign) {
    const { sigHex, timestamp } = await signInternalMarker(
      fixture.projectId,
      env.SESSION_SECRET,
      "freeze",
      userId,
      text,
    );
    headers["X-Internal-Auth"] = sigHex;
    headers["X-Internal-Timestamp"] = String(timestamp);
    headers["X-Internal-Project"] = String(fixture.projectId);
  }
  const query = new URLSearchParams({ control: text, userId: String(userId) });
  const res = await stubFor(fixture.projectId).fetch(
    new Request(`https://internal/freeze?${query}`, { method: "POST", headers }),
  );
  // Read whole: a body left unread holds the object open, and it could then
  // never be evicted.
  await res.text();
  return res;
}

/** Open a socket and read past its acceptance frames. */
async function admit(fixture: Fixture, awarenessClientId?: number) {
  const socket = await openSocket(fixture, "0", awarenessClientId);
  await drainAcceptanceFrames(socket);
  return socket;
}

/** The freeze a fresh socket is told about on admission. */
async function admittedFreeze(fixture: Fixture) {
  const socket = await openSocket(fixture, "0");
  await socket.next(); // generation
  const frame = readFreezeFrame(await socket.next());
  socket.ws.close();
  return frame;
}

/** An awareness message carrying exactly these entries. */
function awarenessMessage(entries: Array<{ id: number; clock: number; state: unknown }>): Uint8Array {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(update, entry.id);
    encoding.writeVarUint(update, entry.clock);
    encoding.writeVarString(update, JSON.stringify(entry.state));
  }
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
  return encoding.toUint8Array(message);
}

/** The client ids an awareness frame carries. */
async function relayedIds(socket: Socket): Promise<number[]> {
  const decoder = decoding.createDecoder(await socket.next());
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_AWARENESS);
  const update = decoding.createDecoder(decoding.readVarUint8Array(decoder));
  const count = decoding.readVarUint(update);
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(decoding.readVarUint(update));
    decoding.readVarUint(update);
    decoding.readVarString(update);
  }
  return ids;
}

/**
 * Wait until the object has processed everything `socket` sent: a sync step 1
 * is answered in order, after every message ahead of it. Frames already
 * queued for the socket are skipped on the way.
 */
async function processed(socket: Socket): Promise<void> {
  socket.ws.send(clientSyncStep1(new Y.Doc()));
  for (;;) {
    const decoder = decoding.createDecoder(await socket.next());
    if (decoding.readVarUint(decoder) === MESSAGE_SYNC) return;
  }
}

function serverAwareness(fixture: Fixture): Promise<Record<number, unknown>> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) => {
    const awareness = (instance as unknown as { awareness: awarenessProtocol.Awareness }).awareness;
    return Object.fromEntries(awareness.getStates());
  });
}

function attachments(fixture: Fixture): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(stubFor(fixture.projectId), (_instance, state) =>
    state.getWebSockets().map((ws) => ws.deserializeAttachment() as Record<string, unknown>),
  );
}

describe("the freeze lease", () => {
  it("is told to every socket when it begins, and to a socket admitted after", async () => {
    const fixture = await seedProject("lease-begin");
    const watcher = await admit(fixture);

    expect((await control(fixture, "begin:publish:op-1")).status).toBe(200);

    const told = readFreezeFrame(await watcher.next());
    expect(told.leases).toEqual([
      { rev: 1, kind: "publish", userId: fixture.userId, remainingMs: expect.any(Number) },
    ]);
    expect(told.leases[0].remainingMs).toBeLessThanOrEqual(15 * 60 * 1000);

    const late = await admittedFreeze(fixture);
    expect(late.leases.map((l) => l.kind)).toEqual(["publish"]);
    watcher.ws.close();
  });

  it("refuses to begin a second operation while one holds the lock, and lets the next begin after", async () => {
    const fixture = await seedProject("lease-lock");
    const other = await addMember(fixture, "lease-lock-other");
    await control(fixture, "begin:upgrade:op-1");

    expect((await control(other, "begin:publish:op-2", other.userId)).status).toBe(409);
    expect((await control(fixture, "begin:publish:op-3")).status).toBe(409);

    await control(fixture, "end:op-1:succeeded");
    expect((await control(other, "begin:publish:op-2", other.userId)).status).toBe(200);
  });

  it("refuses a control that was not signed", async () => {
    const fixture = await seedProject("lease-unsigned");
    const res = await control(fixture, "begin:upgrade:op-1", fixture.userId, false);
    expect(res.status).toBe(401);
    expect((await admittedFreeze(fixture)).leases).toEqual([]);
  });

  it("refuses to renew or end a lease another user holds", async () => {
    const fixture = await seedProject("lease-other-user");
    const other = await addMember(fixture, "lease-other");
    await control(fixture, "begin:upgrade:op-1");

    expect((await control(other, "renew:op-1", other.userId)).status).toBe(409);
    expect((await control(other, "end:op-1:succeeded", other.userId)).status).toBe(409);
    expect((await admittedFreeze(fixture)).leases).toHaveLength(1);
  });

  it("ends with its outcome, which a socket admitted afterwards is replayed", async () => {
    const fixture = await seedProject("lease-end");
    await control(fixture, "begin:upgrade:op-1");
    expect((await control(fixture, "end:op-1:succeeded")).status).toBe(200);

    const frame = await admittedFreeze(fixture);
    expect(frame.leases).toEqual([]);
    expect(frame.ended).toEqual([
      { rev: 1, kind: "upgrade", userId: fixture.userId, outcome: "succeeded" },
    ]);
  });

  it("survives the object being evicted", async () => {
    const fixture = await seedProject("lease-evict");
    const held = await admit(fixture);
    await control(fixture, "begin:publish:op-1");
    readFreezeFrame(await held.next());

    await hibernate(stubFor(fixture.projectId));

    expect((await admittedFreeze(fixture)).leases.map((l) => l.kind)).toEqual(["publish"]);
    held.ws.close();
  });
});

describe("awareness ownership", () => {
  const A_ID = 1001;
  const B_ID = 2002;

  it("relays only the entry naming the sender's own client id", async () => {
    const fixture = await seedProject("aw-forge");
    const other = await addMember(fixture, "aw-forger");
    const a = await admit(fixture, A_ID);
    const b = await admit(other, B_ID);

    a.ws.send(awarenessMessage([{ id: A_ID, clock: 1, state: { user: { name: "a" } } }]));
    expect(await relayedIds(b)).toEqual([A_ID]);
    // The sender hears its own entry back, and only that.
    expect(await relayedIds(a)).toEqual([A_ID]);

    // B overwrites A's presence with a higher clock, alongside its own entry.
    b.ws.send(
      awarenessMessage([
        { id: A_ID, clock: 9, state: { user: { name: "forged" }, publishing: true } },
        { id: B_ID, clock: 1, state: { user: { name: "b" } } },
      ]),
    );
    expect(await relayedIds(a)).toEqual([B_ID]);
    expect((await serverAwareness(fixture))[A_ID]).toEqual({ user: { name: "a" } });

    // An update carrying only a foreign entry is relayed not at all: the next
    // frame A sees is B's own following update.
    b.ws.send(awarenessMessage([{ id: A_ID, clock: 10, state: null }]));
    b.ws.send(awarenessMessage([{ id: B_ID, clock: 2, state: { user: { name: "b2" } } }]));
    expect(await relayedIds(a)).toEqual([B_ID]);
    expect((await serverAwareness(fixture))[A_ID]).toEqual({ user: { name: "a" } });

    a.ws.close();
    b.ws.close();
  });

  it("lets the same user's reconnect take the id over, and the old socket's close remove nothing", async () => {
    const fixture = await seedProject("aw-takeover");
    const first = await admit(fixture, A_ID);
    first.ws.send(awarenessMessage([{ id: A_ID, clock: 1, state: { user: { name: "a" } } }]));

    const second = await admit(fixture, A_ID);
    second.ws.send(awarenessMessage([{ id: A_ID, clock: 2, state: { user: { name: "a-again" } } }]));
    await expect.poll(async () => (await serverAwareness(fixture))[A_ID]).toEqual({ user: { name: "a-again" } });

    const held = (await attachments(fixture)).filter((att) => att.awarenessClientId === A_ID);
    expect(held).toHaveLength(1);

    // A late removal from the displaced socket, read back once the object has
    // processed it: the successor's state stands and the id stays the
    // successor's.
    first.ws.send(awarenessMessage([{ id: A_ID, clock: 3, state: null }]));
    await processed(first);
    expect((await serverAwareness(fixture))[A_ID]).toEqual({ user: { name: "a-again" } });
    expect((await attachments(fixture)).filter((att) => att.awarenessClientId === A_ID)).toHaveLength(1);

    first.ws.close();
    await expect.poll(async () => (await attachments(fixture)).length).toBe(1);
    expect((await serverAwareness(fixture))[A_ID]).toEqual({ user: { name: "a-again" } });
    second.ws.close();
  });

  it("refuses another user's claim to an id already held", async () => {
    const fixture = await seedProject("aw-claim");
    const other = await addMember(fixture, "aw-claimer");
    const a = await admit(fixture, A_ID);
    a.ws.send(awarenessMessage([{ id: A_ID, clock: 1, state: { user: { name: "a" } } }]));
    expect(await relayedIds(a)).toEqual([A_ID]);

    const impostor = await admit(other, A_ID);
    impostor.ws.send(awarenessMessage([{ id: A_ID, clock: 5, state: { user: { name: "forged" } } }]));
    const b = await admit(other, B_ID);
    b.ws.send(awarenessMessage([{ id: B_ID, clock: 1, state: { user: { name: "b" } } }]));
    // A hears B, and nothing from the impostor before it.
    expect(await relayedIds(a)).toEqual([B_ID]);
    expect((await serverAwareness(fixture))[A_ID]).toEqual({ user: { name: "a" } });

    a.ws.close();
    impostor.ws.close();
    b.ws.close();
  });

  it("closes a socket whose awareness the object no longer holds after eviction", async () => {
    const fixture = await seedProject("aw-evicted-close");
    const a = await admit(fixture, A_ID);
    // An update too large for the attachment to keep, so the wake has nothing
    // to rebuild A's entry from.
    const large = { user: { name: "a" }, padding: "x".repeat(9000) };
    a.ws.send(awarenessMessage([{ id: A_ID, clock: 1, state: large }]));
    await expect.poll(async () => (await serverAwareness(fixture))[A_ID]).toBeDefined();
    expect((await attachments(fixture))[0].awarenessUpdate).toBeUndefined();

    await hibernate(stubFor(fixture.projectId));
    expect((await serverAwareness(fixture))[A_ID]).toBeUndefined();

    // The woken instance's awareness has never seen A_ID; the attachment
    // still names it. Encoding a removal for it would throw.
    await runInDurableObject(stubFor(fixture.projectId), async (instance, state) => {
      const ws = state.getWebSockets()[0];
      await expect(
        (instance as unknown as { webSocketClose: (ws: WebSocket, code: number) => Promise<void> })
          .webSocketClose(ws, 1000),
      ).resolves.toBeUndefined();
    });
    a.ws.close();
  });
});

/** The entries an awareness frame carries, with each state parsed. */
function entriesIn(frame: Uint8Array): Array<{ id: number; state: unknown }> {
  const decoder = decoding.createDecoder(frame);
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_AWARENESS);
  const update = decoding.createDecoder(decoding.readVarUint8Array(decoder));
  const count = decoding.readVarUint(update);
  const entries: Array<{ id: number; state: unknown }> = [];
  for (let i = 0; i < count; i++) {
    const id = decoding.readVarUint(update);
    decoding.readVarUint(update);
    entries.push({ id, state: JSON.parse(decoding.readVarString(update)) });
  }
  return entries;
}

/**
 * Admit a socket and return the awareness snapshot it is sent, the fifth
 * acceptance frame, as a map from client id to state.
 */
async function admittedSnapshot(fixture: Fixture, generation = "0"): Promise<{
  socket: Socket;
  snapshot: Map<number, unknown>;
}> {
  const socket = await openSocket(fixture, generation);
  for (let i = 0; i < 4; i++) await socket.next();
  const snapshot = new Map(entriesIn(await socket.next()).map((e) => [e.id, e.state]));
  return { socket, snapshot };
}

/** The object's own awareness client id. */
function serverClientId(fixture: Fixture): Promise<number> {
  return runInDurableObject(stubFor(fixture.projectId), (instance) =>
    (instance as unknown as { awareness: awarenessProtocol.Awareness }).awareness.clientID,
  );
}

/** Two members, each with a socket that has set its awareness, relays and echoes drained. */
async function twoPresent(
  label: string,
  aState: Record<string, unknown> = { user: { name: "a" } },
  bState: Record<string, unknown> = { user: { name: "b" } },
) {
  const fixture = await seedProject(label);
  const other = await addMember(fixture, `${label}-other`);
  const a = await admit(fixture, 1001);
  const b = await admit(other, 2002);
  a.ws.send(awarenessMessage([{ id: 1001, clock: 1, state: aState }]));
  expect(await relayedIds(b)).toEqual([1001]);
  expect(await relayedIds(a)).toEqual([1001]);
  b.ws.send(awarenessMessage([{ id: 2002, clock: 1, state: bState }]));
  expect(await relayedIds(a)).toEqual([2002]);
  expect(await relayedIds(b)).toEqual([2002]);
  return { fixture, other, a, b };
}

/** A signed `/reset`, as the app's reset action sends it. */
async function reset(fixture: Fixture): Promise<Response> {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, env.SESSION_SECRET, "reset");
  const res = await stubFor(fixture.projectId).fetch(
    new Request("https://internal/reset", {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(fixture.projectId),
      },
    }),
  );
  await res.text();
  return res;
}

/**
 * Set the time kept beside `clientId`'s entry in its socket's attachment, as
 * though the client last renewed at `updatedAt` and has sent nothing since.
 */
async function ageKeptEntry(fixture: Fixture, clientId: number, updatedAt: number): Promise<void> {
  await runInDurableObject(stubFor(fixture.projectId), (_instance, state) => {
    const ws = state
      .getWebSockets()
      .find((socket) => (socket.deserializeAttachment() as { awarenessClientId?: number }).awarenessClientId === clientId)!;
    const attachment = ws.deserializeAttachment() as Record<string, unknown>;
    expect(attachment.awarenessUpdatedAt).toEqual(expect.any(Number));
    attachment.awarenessUpdatedAt = updatedAt;
    ws.serializeAttachment(attachment);
  });
}

// A timer the object holds makes `evictDurableObject` time out at 30 seconds;
// the cases that evict allow for that, so a regression fails on its own
// assertion rather than on the test's default timeout.
const EVICTION_TIMEOUT = 60_000;

describe("the awareness holds no timer, and survives a hibernation", () => {
  it("lets the object be evicted with sockets and awareness entries attached", async () => {
    const { fixture, a, b } = await twoPresent("aw-evict-plain");
    const stub = stubFor(fixture.projectId);
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { harnessMarker?: string }).harnessMarker = "before";
    });

    await evictDurableObject(stub);

    const marker = await runInDurableObject(
      stub,
      (instance) => (instance as unknown as { harnessMarker?: string }).harnessMarker,
    );
    expect(marker).toBeUndefined();
    a.ws.close();
    b.ws.close();
  }, EVICTION_TIMEOUT);

  it("lets the object be evicted after a reset has replaced its document", async () => {
    const fixture = await seedProject("aw-evict-reset");
    const stub = stubFor(fixture.projectId);
    const socket = await admit(fixture);

    expect((await reset(fixture)).status).toBe(200);
    await vi.waitFor(() => expect(socket.closes.length).toBeGreaterThan(0), { timeout: 5000 });
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { harnessMarker?: string }).harnessMarker = "before";
    });

    await evictDurableObject(stub);

    const woken = await runInDurableObject(stub, (instance) => ({
      marker: (instance as unknown as { harnessMarker?: string }).harnessMarker,
      generation: (instance as unknown as { docGeneration: number | null }).docGeneration,
    }));
    expect(woken.marker).toBeUndefined();
    const readmitted = await openSocket(fixture, "1");
    await drainAcceptanceFrames(readmitted, 1);
    readmitted.ws.close();
  }, EVICTION_TIMEOUT);

  it("leaves a stale remote entry out of a new socket's snapshot, and keeps a fresh one and its own", async () => {
    const { fixture, a, b } = await twoPresent("aw-stale");
    const ownId = await serverClientId(fixture);

    // A stopped renewing without closing: its entry was last updated past the
    // library's timeout. The object's own entry is as old, and stays.
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const awareness = (instance as unknown as { awareness: awarenessProtocol.Awareness }).awareness;
      const past = Date.now() - 31_000;
      awareness.meta.get(1001)!.lastUpdated = past;
      awareness.meta.get(ownId)!.lastUpdated = past;
      awareness.meta.get(2002)!.lastUpdated = Date.now() - 29_000;
    });

    const { socket, snapshot } = await admittedSnapshot(fixture);
    expect(snapshot.has(1001)).toBe(false);
    expect(snapshot.get(2002)).toEqual({ user: { name: "b" } });
    expect(snapshot.has(ownId)).toBe(true);

    a.ws.close();
    b.ws.close();
    socket.ws.close();
  });

  it("keeps a hidden collaborator's entry in a new socket's snapshot past the visible limit", async () => {
    const { fixture, a, b } = await twoPresent("aw-hidden-snapshot", { user: { name: "a" }, hidden: true });

    // Both last renewed a minute ago: past the visible limit, inside the hidden one.
    await runInDurableObject(stubFor(fixture.projectId), (instance) => {
      const awareness = (instance as unknown as { awareness: awarenessProtocol.Awareness }).awareness;
      awareness.meta.get(1001)!.lastUpdated = Date.now() - 60_000;
      awareness.meta.get(2002)!.lastUpdated = Date.now() - 60_000;
    });

    const { socket, snapshot } = await admittedSnapshot(fixture);
    expect(snapshot.get(1001)).toEqual({ user: { name: "a" }, hidden: true });
    expect(snapshot.has(2002)).toBe(false);

    a.ws.close();
    b.ws.close();
    socket.ws.close();
  });

  it("restores a hidden collaborator's entry after a wake past the visible limit, and not a visible one", async () => {
    const { fixture, a, b } = await twoPresent("aw-hidden-wake", { user: { name: "a" }, hidden: true });
    await ageKeptEntry(fixture, 1001, Date.now() - 60_000);
    await ageKeptEntry(fixture, 2002, Date.now() - 60_000);

    await hibernate(stubFor(fixture.projectId));

    // Read before any connection, whose sweep would decide it either way.
    const woken = await serverAwareness(fixture);
    expect(woken[1001]).toEqual({ user: { name: "a" }, hidden: true });
    expect(woken[2002]).toBeUndefined();

    a.ws.close();
    b.ws.close();
  }, EVICTION_TIMEOUT);

  it("does not restore a hidden collaborator's entry kept past the hidden limit", async () => {
    const { fixture, a, b } = await twoPresent("aw-hidden-wake-old", { user: { name: "a" }, hidden: true });
    await ageKeptEntry(fixture, 1001, Date.now() - HIDDEN_PRESENCE_LIMIT_MS - 1000);

    await hibernate(stubFor(fixture.projectId));

    const woken = await serverAwareness(fixture);
    expect(woken[1001]).toBeUndefined();
    expect(woken[2002]).toEqual({ user: { name: "b" } });

    a.ws.close();
    b.ws.close();
  }, EVICTION_TIMEOUT);

  it("sends a socket admitted after a hibernation the entries of those already connected", async () => {
    const { fixture, a, b } = await twoPresent("aw-wake-snapshot");

    await hibernate(stubFor(fixture.projectId));

    const { socket, snapshot } = await admittedSnapshot(fixture);
    expect(snapshot.get(1001)).toEqual({ user: { name: "a" } });
    expect(snapshot.get(2002)).toEqual({ user: { name: "b" } });

    a.ws.close();
    b.ws.close();
    socket.ws.close();
  }, EVICTION_TIMEOUT);

  it("broadcasts the removal of a collaborator who closes after a hibernation", async () => {
    const { fixture, a, b } = await twoPresent("aw-wake-close");

    await hibernate(stubFor(fixture.projectId));
    a.ws.close();

    expect(entriesIn(await b.next())).toEqual([{ id: 1001, state: null }]);
    b.ws.close();
  }, EVICTION_TIMEOUT);

  it("restores nothing from a socket admitted under another generation", async () => {
    const { fixture, a, b } = await twoPresent("aw-wake-stale-gen");
    const stub = stubFor(fixture.projectId);

    // What a reset whose closes never landed leaves: the next generation in
    // storage and a row the next load rebuilds from D1.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("docGeneration", 1);
    });
    await env.DB.prepare(
      "UPDATE projects SET yjs_state = NULL, yjs_generation = NULL, yjs_seq = NULL, " +
        "yjs_write = yjs_write + 1 WHERE id = ?",
    )
      .bind(fixture.projectId)
      .run();
    await hibernate(stub);

    const { socket, snapshot } = await admittedSnapshot(fixture, "1");
    expect(snapshot.has(1001)).toBe(false);
    expect(snapshot.has(2002)).toBe(false);

    a.ws.close();
    b.ws.close();
    socket.ws.close();
  }, EVICTION_TIMEOUT);

  it("keeps the last update applied, and nothing for a socket whose id was taken over", async () => {
    const fixture = await seedProject("aw-kept");
    const first = await admit(fixture, 1001);
    first.ws.send(awarenessMessage([{ id: 1001, clock: 1, state: { user: { name: "a" } } }]));
    await processed(first);
    const second = await admit(fixture, 1001);
    second.ws.send(awarenessMessage([{ id: 1001, clock: 2, state: { user: { name: "a-again" } } }]));
    await processed(second);

    const kept = await attachments(fixture);
    const refused = kept.find((att) => att.awarenessRefused === true)!;
    const holder = kept.find((att) => att.awarenessClientId === 1001)!;
    expect(refused.awarenessUpdate).toBeUndefined();
    expect(holder.awarenessUpdate).toBeInstanceOf(Uint8Array);

    await hibernate(stubFor(fixture.projectId));
    expect((await serverAwareness(fixture))[1001]).toEqual({ user: { name: "a-again" } });

    first.ws.close();
    second.ws.close();
  }, EVICTION_TIMEOUT);

  it("does not restore an entry whose client stopped renewing past the timeout", async () => {
    const { fixture, a, b } = await twoPresent("aw-wake-outdated");
    await ageKeptEntry(fixture, 1001, Date.now() - 31_000);

    await hibernate(stubFor(fixture.projectId));

    // Read before any connection, whose sweep would remove it either way.
    const woken = await serverAwareness(fixture);
    expect(woken[1001]).toBeUndefined();
    expect(woken[2002]).toEqual({ user: { name: "b" } });
    const { socket, snapshot } = await admittedSnapshot(fixture);
    expect(snapshot.has(1001)).toBe(false);
    expect(snapshot.get(2002)).toEqual({ user: { name: "b" } });

    a.ws.close();
    b.ws.close();
    socket.ws.close();
  }, EVICTION_TIMEOUT);

  it("restores an entry at the age it was kept, so it ages out at the timeout", async () => {
    const { fixture, a, b } = await twoPresent("aw-wake-age");
    const updatedAt = Date.now() - 29_000;
    await ageKeptEntry(fixture, 1001, updatedAt);

    await hibernate(stubFor(fixture.projectId));

    const before = await admittedSnapshot(fixture);
    expect(before.snapshot.get(1001)).toEqual({ user: { name: "a" } });

    // Past the timeout by a margin, measured from the kept time.
    const wait = updatedAt + 30_000 + 100 - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 0)));
    const after = await admittedSnapshot(fixture);
    expect(after.snapshot.has(1001)).toBe(false);
    expect(after.snapshot.get(2002)).toEqual({ user: { name: "b" } });

    a.ws.close();
    b.ws.close();
    before.socket.ws.close();
    after.socket.ws.close();
  }, EVICTION_TIMEOUT);

  it("does not bring back an entry after a stale-clock update that followed its removal", async () => {
    const fixture = await seedProject("aw-stale-clock");
    const a = await admit(fixture, 1001);
    a.ws.send(awarenessMessage([{ id: 1001, clock: 2, state: null }]));
    a.ws.send(awarenessMessage([{ id: 1001, clock: 1, state: { user: { name: "a-old" } } }]));
    await processed(a);
    expect((await serverAwareness(fixture))[1001]).toBeUndefined();

    await hibernate(stubFor(fixture.projectId));

    expect((await serverAwareness(fixture))[1001]).toBeUndefined();
    const { socket, snapshot } = await admittedSnapshot(fixture);
    expect(snapshot.has(1001)).toBe(false);

    a.ws.close();
    socket.ws.close();
  }, EVICTION_TIMEOUT);
});

describe("a socket alone in a project stays connected", () => {
  const A_ID = 1001;

  /** The one entry an awareness frame carries, with its clock. */
  function ownEntry(frame: Uint8Array): { id: number; clock: number; state: unknown } {
    const decoder = decoding.createDecoder(frame);
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_AWARENESS);
    const update = decoding.createDecoder(decoding.readVarUint8Array(decoder));
    expect(decoding.readVarUint(update)).toBe(1);
    return {
      id: decoding.readVarUint(update),
      clock: decoding.readVarUint(update),
      state: JSON.parse(decoding.readVarString(update)),
    };
  }

  // y-websocket drops and reopens a socket that has heard nothing for 30
  // seconds, counting on its own 15-second awareness renewal coming back.
  it("hears its own awareness entry back when nobody else is connected", async () => {
    const fixture = await seedProject("aw-alone-echo");
    const a = await admit(fixture, A_ID);

    a.ws.send(awarenessMessage([{ id: A_ID, clock: 1, state: { user: { name: "a" } } }]));
    expect(ownEntry(await a.next())).toEqual({ id: A_ID, clock: 1, state: { user: { name: "a" } } });

    a.ws.close(1000);
  });

  it("hears every renewal back, not only the first", async () => {
    const fixture = await seedProject("aw-alone-renew");
    const a = await admit(fixture, A_ID);

    for (const clock of [1, 2, 3]) {
      a.ws.send(awarenessMessage([{ id: A_ID, clock, state: { user: { name: "a" } } }]));
      expect(ownEntry(await a.next())).toEqual({ id: A_ID, clock, state: { user: { name: "a" } } });
    }

    a.ws.close(1000);
  });

  it("hears a renewal back after the object has hibernated", async () => {
    const fixture = await seedProject("aw-alone-wake");
    const a = await admit(fixture, A_ID);
    a.ws.send(awarenessMessage([{ id: A_ID, clock: 1, state: { user: { name: "a" } } }]));
    expect(ownEntry(await a.next()).clock).toBe(1);

    await hibernate(stubFor(fixture.projectId));

    a.ws.send(awarenessMessage([{ id: A_ID, clock: 2, state: { user: { name: "a" } } }]));
    expect(ownEntry(await a.next())).toEqual({ id: A_ID, clock: 2, state: { user: { name: "a" } } });

    a.ws.close(1000);
  }, EVICTION_TIMEOUT);

  // y-websocket closes with no status code, which arrives as 1005: a code
  // that may be received but never sent.
  it("answers a close that carried no status code, with a normal closure", async () => {
    const fixture = await seedProject("aw-alone-close");
    const a = await admit(fixture, A_ID);

    a.ws.close();
    await expect.poll(() => a.closes, { timeout: 3000 }).toEqual([
      expect.objectContaining({ code: 1000 }),
    ]);
  });
});

describe("a socket whose awareness client id is 0", () => {
  // Yjs draws client ids from the whole unsigned 32-bit range, 0 included, and
  // the ownership code admits it; the close must treat it as an id like any other.
  it("has its presence removed, and the removal broadcast, when it closes", async () => {
    const fixture = await seedProject("aw-zero-close");
    const other = await addMember(fixture, "aw-zero-close-other");
    const zero = await admit(fixture, 0);
    const b = await admit(other, 2002);

    zero.ws.send(awarenessMessage([{ id: 0, clock: 1, state: { user: { name: "zero" } } }]));
    expect(await relayedIds(b)).toEqual([0]);
    expect(await relayedIds(zero)).toEqual([0]);

    zero.ws.close(1000);

    expect(entriesIn(await b.next())).toEqual([{ id: 0, state: null }]);
    await expect.poll(async () => (await serverAwareness(fixture))[0]).toBeUndefined();
    b.ws.close(1000);
  });
});
