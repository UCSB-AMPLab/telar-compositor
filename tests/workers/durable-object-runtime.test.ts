/**
 * The four capabilities the persistence work depends on, proved against the
 * real `ProjectCollaborationDO`, real D1 and real workerd. The in-repo harness
 * builds the class over fakes, so it can assert what the code does with a
 * storage object it was handed; it cannot evict an object, and eviction with a
 * hibernated socket still attached is the state every later step reasons about.
 *
 * Storage is shared across this project's files, so each test mints its own
 * user, project and membership and addresses a Durable Object named after that
 * project. Nothing here reads a row another test wrote.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { hibernate } from "./helpers/hibernate";
import {
  MESSAGE_SYNC,
  clientSyncStep1,
  drainAcceptanceFrames,
  openSocket,
  seedProject,
  stubFor,
} from "./helpers/collaboration-client";

describe("Durable Object test runtime", () => {
  it("eviction resets in-memory state and keeps storage", async () => {
    const { projectId } = await seedProject("evict");
    const stub = stubFor(projectId);

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("harness-key", "durable");
      (instance as unknown as { harnessMarker?: string }).harnessMarker = "in-memory";
    });

    await hibernate(stub);

    await runInDurableObject(stub, async (instance, state) => {
      expect(await state.storage.get("harness-key")).toBe("durable");
      expect((instance as unknown as { harnessMarker?: string }).harnessMarker).toBeUndefined();
    });
  });

  it("a hibernated socket survives eviction and wakes the object", async () => {
    const fixture = await seedProject("socket");
    const stub = stubFor(fixture.projectId);

    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket);

    // Marks the instance that admitted the socket, so the assertions below
    // distinguish a woken object from one that was never evicted.
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { harnessMarker?: string }).harnessMarker = "pre-eviction";
    });

    await hibernate(stub);

    socket.ws.send(clientSyncStep1(new Y.Doc()));

    const reply = decoding.createDecoder(await socket.next());
    expect(decoding.readVarUint(reply)).toBe(MESSAGE_SYNC);
    expect(decoding.readVarUint(reply)).toBe(syncProtocol.messageYjsSyncStep2);

    const woken = await runInDurableObject(stub, (instance, state) => ({
      sockets: state.getWebSockets().length,
      marker: (instance as unknown as { harnessMarker?: string }).harnessMarker,
    }));
    expect(woken).toEqual({ sockets: 1, marker: undefined });
  });

  it("the alarm snapshots and reschedules while a socket is attached", async () => {
    const fixture = await seedProject("alarm");
    const stub = stubFor(fixture.projectId);

    const socket = await openSocket(fixture, "new");
    const serverState = await drainAcceptanceFrames(socket);

    // One edit through the socket, sent the way a client sends one: the client
    // document is brought up to the server's state first, so the update it
    // produces applies cleanly on the other side.
    const clientDoc = new Y.Doc();
    Y.applyUpdate(clientDoc, serverState);
    clientDoc.getMap("config").set("harness_marker", "edited");
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, MESSAGE_SYNC);
    syncProtocol.writeUpdate(update, Y.encodeStateAsUpdate(clientDoc));
    socket.ws.send(encoding.toUint8Array(update));

    // The edit is in when the object answers a sync step 1 that follows it:
    // the handler is serialised, so the reply cannot overtake the update.
    socket.ws.send(clientSyncStep1(new Y.Doc()));
    const settled = decoding.createDecoder(await socket.next());
    expect(decoding.readVarUint(settled)).toBe(MESSAGE_SYNC);
    expect(decoding.readVarUint(settled)).toBe(syncProtocol.messageYjsSyncStep2);

    // Before the alarm runs the row already carries a blob: the cold load
    // writes the document it built from these rows as the row's initial base,
    // tagged with the generation it was encoded at and claiming the row, before
    // it opens. What that base does not carry is the socket's edit, which is
    // what the alarm's snapshot is here to add.
    const beforeAlarm = await env.DB.prepare(
      "SELECT yjs_state, yjs_generation, yjs_seq, yjs_write FROM projects WHERE id = ?",
    )
      .bind(fixture.projectId)
      .first<{
        yjs_state: ArrayBuffer | null;
        yjs_generation: number | null;
        yjs_seq: number | null;
        yjs_write: number;
      }>();
    expect(beforeAlarm).not.toBeNull();
    expect(beforeAlarm?.yjs_state).not.toBeNull();
    expect(beforeAlarm?.yjs_generation).toBe(0);
    expect(beforeAlarm?.yjs_seq).toBe(0);
    expect(beforeAlarm?.yjs_write).toBe(1);
    const initialBase = new Y.Doc();
    Y.applyUpdate(
      initialBase,
      new Uint8Array(beforeAlarm!.yjs_state as unknown as ArrayLike<number>),
    );
    expect(initialBase.getMap("config").get("harness_marker")).toBeUndefined();

    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 50),
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // A missing row would also read as "not null" was satisfied, so the row's
    // existence is asserted on its own before the blob is inspected. The blob
    // itself is decoded rather than merely checked for presence, so a snapshot
    // that missed the socket's edit — writing some other non-empty state —
    // would still fail this test.
    const row = await env.DB.prepare("SELECT yjs_state FROM projects WHERE id = ?")
      .bind(fixture.projectId)
      .first<{ yjs_state: ArrayBuffer | null }>();
    expect(row).not.toBeNull();
    expect(row?.yjs_state).not.toBeNull();
    // D1 hands the blob back as an array-like of byte values rather than an
    // ArrayBuffer, the same shape `Y.applyUpdate` below expects it to be
    // wrapped in a `Uint8Array` for — matching the read in `collaboration.ts`.
    const snapshot = new Uint8Array(row!.yjs_state as unknown as ArrayLike<number>);
    expect(snapshot.length).toBeGreaterThan(0);

    const persistedDoc = new Y.Doc();
    Y.applyUpdate(persistedDoc, snapshot);
    expect(persistedDoc.getMap("config").get("harness_marker")).toBe("edited");

    const rescheduled = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(rescheduled).not.toBeNull();
  });

  it("the object reads the same migrated D1 the test does", async () => {
    const fixture = await seedProject("d1");
    const stub = stubFor(fixture.projectId);

    const sql = "SELECT id, github_repo_full_name FROM projects WHERE id = ?";
    const outside = await env.DB.prepare(sql)
      .bind(fixture.projectId)
      .first<{ id: number; github_repo_full_name: string }>();

    // `env` is protected on the base class, so the instance's view of it is
    // reached through a cast rather than by widening the class.
    const inside = await runInDurableObject(stub, (instance) =>
      (instance as unknown as { env: Env }).env.DB
        .prepare(sql)
        .bind(fixture.projectId)
        .first<{ id: number; github_repo_full_name: string }>(),
    );

    expect(outside).not.toBeNull();
    expect(inside).toEqual(outside);
  });
});
