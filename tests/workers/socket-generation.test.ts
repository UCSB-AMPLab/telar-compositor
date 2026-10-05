/**
 * The socket generation fence, against the real class, real D1 and real
 * workerd — the only harness that can evict a Durable Object and leave its
 * hibernated sockets attached.
 *
 * The post-reset state is PLANTED rather than produced by a live `/reset`: the
 * harness's eviction drains in-flight requests, so a reset cannot be
 * interrupted at its switch. What a reset leaves behind is an advanced
 * generation in Durable Object storage AND a cleared D1 blob, so both are
 * planted; planting the generation alone would leave the loader preferring the
 * old blob and the "rebuilt document" assertions would be about the wrong
 * document. For the resident case the instance's cached generation is advanced
 * too, and the document rebuilt, which is what `/reset` does inside its gate.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { hibernate } from "./helpers/hibernate";
import {
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  attemptUpgrade,
  clientSyncStep1,
  drainAcceptanceFrames,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";

const STALE_CLOSE = { code: 1012, reason: "State reset" };

/** The instance internals the plants below reach for. */
interface Internals {
  docGeneration: number | null;
  docLoaded: boolean;
  ydoc: Y.Doc;
  replaceDocument: () => void;
  ensureDocLoaded: () => Promise<void>;
}

/** A sync-update message carrying one marker written into `config`. */
function markerUpdate(serverState: Uint8Array, marker: string): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, serverState);
  const before = Y.encodeStateVector(client);
  client.getMap("config").set("harness_marker", marker);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client, before));
  return encoding.toUint8Array(encoder);
}

/** The marker the Durable Object's document holds, if any. */
function serverMarker(stub: DurableObjectStub): Promise<unknown> {
  return runInDurableObject(stub, (instance) =>
    (instance as unknown as Internals).ydoc.getMap("config").get("harness_marker"),
  );
}

/**
 * The seeded story's title, read out of whatever document the instance
 * currently holds — undefined if the document has no story at all, which is
 * what an empty, unloaded document would also show.
 */
function serverStoryTitle(stub: DurableObjectStub): Promise<string | undefined> {
  return runInDurableObject(stub, (instance) => {
    const stories = (instance as unknown as Internals).ydoc.getArray<Y.Map<unknown>>("stories");
    return stories.length === 0 ? undefined : String(stories.get(0).get("title"));
  });
}

/**
 * What a reset leaves durable, PLANTED: the next generation in storage, and a
 * row whose base the next load rebuilds from these same D1 rows — which is what
 * the reset's own rebuild produces.
 *
 * The D1 half is written as a hand repair, moving the revision as the fence
 * trigger requires of any write that touches the blob or the tags. The move
 * itself stands in for a replacement's claim, which this harness cannot
 * produce: it cannot run two instances of one object.
 */
async function plantPostSwitchState(
  stub: DurableObjectStub,
  projectId: number,
  generation: number,
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("docGeneration", generation);
  });
  await env.DB.prepare(
    "UPDATE projects SET yjs_state = NULL, yjs_generation = NULL, yjs_seq = NULL, " +
      "yjs_write = yjs_write + 1 WHERE id = ?",
  )
    .bind(projectId)
    .run();
}

/** The rest of what a resident reset leaves: the cache, and a rebuilt document. */
async function plantResidentSwitch(
  stub: DurableObjectStub,
  generation: number,
): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    const internals = instance as unknown as Internals;
    internals.docGeneration = generation;
    internals.replaceDocument();
    await internals.ensureDocLoaded();
  });
}

/** Wait for the server's close to reach the client end. */
async function closedWith(socket: Socket, close: { code: number; reason: string }) {
  await vi.waitFor(() => expect(socket.closes.length).toBeGreaterThan(0), { timeout: 5000 });
  expect(socket.closes[0]).toEqual(close);
}

/**
 * Prove the handler ran: the reply to a sync step 1 cannot overtake a message
 * sent before it, because the handler is serialised.
 */
async function awaitServerReply(socket: Socket): Promise<void> {
  socket.ws.send(clientSyncStep1(new Y.Doc()));
  const reply = decoding.createDecoder(await socket.next());
  expect(decoding.readVarUint(reply)).toBe(MESSAGE_SYNC);
  expect(decoding.readVarUint(reply)).toBe(syncProtocol.messageYjsSyncStep2);
}

/** One attached socket's serialised attachment. */
function attachmentIn(stub: DurableObjectStub): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) =>
    state.getWebSockets()[0]?.deserializeAttachment(),
  );
}

async function openAdmittedSocket(fixture: Fixture, generation = "0"): Promise<{
  socket: Socket;
  state: Uint8Array;
}> {
  const socket = await openSocket(fixture, generation);
  const state = await drainAcceptanceFrames(socket, Number(generation));
  return { socket, state };
}

describe("a socket carries the generation it was admitted under", () => {
  it("applies an update sent after an eviction and wake", async () => {
    const fixture = await seedProject("gen-wake-ok");
    const stub = stubFor(fixture.projectId);
    const { socket, state } = await openAdmittedSocket(fixture);

    await hibernate(stub);
    socket.ws.send(markerUpdate(state, "applied"));
    await awaitServerReply(socket);

    expect(socket.closes).toEqual([]);
    expect(await serverMarker(stub)).toBe("applied");
  });

  it("is closed on wake when the generation moved, and its message is not applied", async () => {
    const fixture = await seedProject("gen-wake-stale");
    const stub = stubFor(fixture.projectId);
    const { socket, state } = await openAdmittedSocket(fixture);

    // One edit before the switch, so the rebuilt document is distinguishable
    // from the one the socket was synced with. Confirmed applied before the
    // switch, so the absence checked after it means the switch happened
    // rather than that the edit never landed.
    socket.ws.send(markerUpdate(state, "before-reset"));
    await awaitServerReply(socket);
    expect(await serverMarker(stub)).toBe("before-reset");

    // What a reset clears (the blob) forces the wake's rebuild to read D1
    // rather than prefer the pre-switch document; the seeded story row is
    // what that rebuild produces, and content an empty, unloaded document
    // could not also show.
    await plantPostSwitchState(stub, fixture.projectId, 1);
    await hibernate(stub);

    socket.ws.send(markerUpdate(state, "after-reset"));
    await closedWith(socket, STALE_CLOSE);

    const docLoaded = await runInDurableObject(
      stub,
      (instance) => (instance as unknown as Internals).docLoaded,
    );
    expect(docLoaded).toBe(true);
    expect(await serverStoryTitle(stub)).toBe(fixture.storyTitle);
    expect(await serverMarker(stub)).toBeUndefined();
    const generation = await runInDurableObject(
      stub,
      (instance) => (instance as unknown as Internals).docGeneration,
    );
    expect(generation).toBe(1);
  });

  it("is closed by the message fence when the reset was resident", async () => {
    const fixture = await seedProject("gen-resident");
    const stub = stubFor(fixture.projectId);
    const { socket, state } = await openAdmittedSocket(fixture);

    socket.ws.send(markerUpdate(state, "before-reset"));
    await awaitServerReply(socket);

    await plantPostSwitchState(stub, fixture.projectId, 1);
    await plantResidentSwitch(stub, 1);

    socket.ws.send(markerUpdate(state, "after-reset"));
    await closedWith(socket, STALE_CLOSE);

    expect(await serverMarker(stub)).toBeUndefined();
  });

  it("closes an attachment that carries no generation, on a message and on a wake", async () => {
    const fixture = await seedProject("gen-missing");
    const stub = stubFor(fixture.projectId);
    const { socket, state } = await openAdmittedSocket(fixture);

    await runInDurableObject(stub, (_instance, state_) => {
      for (const ws of state_.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as Record<string, unknown>;
        delete attachment.generation;
        ws.serializeAttachment(attachment);
      }
    });

    socket.ws.send(markerUpdate(state, "unfenced"));
    await closedWith(socket, STALE_CLOSE);
    expect(await serverMarker(stub)).toBeUndefined();

    // The same attachment on a wake: the constructor's fence closes it before
    // the load, without a message being needed to provoke it.
    const woken = await seedProject("gen-missing-wake");
    const wokenStub = stubFor(woken.projectId);
    const second = await openAdmittedSocket(woken);
    await runInDurableObject(wokenStub, (_instance, state_) => {
      for (const ws of state_.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as Record<string, unknown>;
        delete attachment.generation;
        ws.serializeAttachment(attachment);
      }
    });
    await hibernate(wokenStub);

    second.socket.ws.send(markerUpdate(second.state, "unfenced"));
    await closedWith(second.socket, STALE_CLOSE);
    expect(await serverMarker(wokenStub)).toBeUndefined();
  });

  it("leaves a socket admitted after the reset alone at both fences", async () => {
    const fixture = await seedProject("gen-readmitted");
    const stub = stubFor(fixture.projectId);
    const { socket: old } = await openAdmittedSocket(fixture);

    await plantPostSwitchState(stub, fixture.projectId, 1);
    await plantResidentSwitch(stub, 1);
    old.ws.close();

    const { socket, state } = await openAdmittedSocket(fixture, "1");
    socket.ws.send(markerUpdate(state, "post-reset-edit"));
    await awaitServerReply(socket);
    expect(await serverMarker(stub)).toBe("post-reset-edit");

    // And through an eviction, where the wake fence reads the same attachment.
    await hibernate(stub);
    socket.ws.send(clientSyncStep1(new Y.Doc()));
    const reply = decoding.createDecoder(await socket.next());
    expect(decoding.readVarUint(reply)).toBe(MESSAGE_SYNC);
    expect(socket.closes).toEqual([]);
  });

  it("keeps the role and the awareness client id beside the generation", async () => {
    const fixture = await seedProject("gen-awareness");
    const stub = stubFor(fixture.projectId);
    const { socket } = await openAdmittedSocket(fixture);

    const clientDoc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(clientDoc);
    awareness.setLocalState({ user: { name: "editor" } });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [clientDoc.clientID]),
    );
    socket.ws.send(encoding.toUint8Array(encoder));
    // The object answers the sender with its own entry first.
    const echo = decoding.createDecoder(await socket.next());
    expect(decoding.readVarUint(echo)).toBe(MESSAGE_AWARENESS);
    await awaitServerReply(socket);
    clearInterval(
      (awareness as unknown as { _checkInterval: number })._checkInterval,
    );

    expect(await attachmentIn(stub)).toEqual({
      userId: fixture.userId,
      projectId: fixture.projectId,
      role: "convenor",
      generation: 0,
      awarenessClientId: clientDoc.clientID,
      awarenessUpdate: expect.any(Uint8Array),
      awarenessUpdatedAt: expect.any(Number),
      membershipCheckedAt: expect.any(Number),
    });
  });

  it("refuses the upgrade with 503 while the generation cannot be read", async () => {
    const fixture = await seedProject("gen-unreadable");
    const stub = stubFor(fixture.projectId);
    // The instance has to exist before its storage can be wrapped, and the
    // cache has to be emptied first: a cached number never consults storage.
    await openAdmittedSocket(fixture);
    await runInDurableObject(stub, (instance, state) => {
      (instance as unknown as Internals).docGeneration = null;
      Object.defineProperty(state.storage, "get", {
        configurable: true,
        value: async () => { throw new Error("storage unavailable"); },
      });
    });

    const before = await runInDurableObject(stub, (_i, state) => state.getWebSockets().length);
    const refused = await attemptUpgrade(fixture, "0");
    expect(refused.status).toBe(503);
    expect(refused.webSocket).toBeNull();
    const after = await runInDurableObject(stub, (_i, state) => state.getWebSockets().length);
    expect(after).toBe(before);

    // With storage answering again the same client is admitted normally.
    await runInDurableObject(stub, (_instance, state) => {
      delete (state.storage as unknown as Record<string, unknown>).get;
    });
    const readmitted = await openSocket(fixture, "0");
    await drainAcceptanceFrames(readmitted);
    expect(readmitted.closes).toEqual([]);
  });
});
