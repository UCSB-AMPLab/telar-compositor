/**
 * The staged reset and the maintenance alarm against the real class, real D1
 * and real workerd — the only harness where an eviction, a hibernated socket
 * and Durable Object storage are all the real thing.
 *
 * What proves a document is SERVED is a fresh admission after an eviction: an
 * unloaded instance's `ydoc` is an empty document that no assertion about
 * content can tell from a wrong one, and the state a client is given at sync
 * step 2 is what the object actually holds.
 *
 * Every interleaving this harness cannot produce — it cannot run two instances
 * of one object — is PLANTED or SCRIPTED through a seam installed on ONE
 * instance and removed at once, and is labelled as such.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

import { signInternalMarker } from "../../workers/auth";
import {
  baseKey,
  encodeBase,
  encodeHalt,
  encodeRecord,
  haltKey,
  logKey,
  writeGroup,
  type LogStorage,
} from "../../workers/doc-log";
import { hibernate } from "./helpers/hibernate";
import {
  MESSAGE_SYNC,
  drainAcceptanceFrames,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";
const MAINTENANCE_FLOOR_KEY = "maintenanceFloor";

const touched = new Set<DurableObjectStub>();

function trackedStub(projectId: number): DurableObjectStub {
  touched.add(stubFor(projectId));
  return stubFor(projectId);
}

afterEach(async () => {
  for (const stub of touched) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      for (const ws of state.getWebSockets()) {
        try { ws.close(1000, "test over"); } catch { /* already closed */ }
      }
    });
  }
  touched.clear();
});

interface Internals {
  docLoaded: boolean;
  docSeq: number | null;
  docWrite: number | null;
  ydoc: Y.Doc;
  ctx: DurableObjectState;
  alarm: () => Promise<void>;
  forceSnapshot: () => Promise<void>;
  writeBaseRow: (
    blob: Uint8Array,
    generation: number,
    seq: number,
    held: number,
    now: string,
  ) => Promise<boolean>;
}

function signed(fixture: Fixture, path: string, action: string): Promise<Request> {
  return signInternalMarker(fixture.projectId, TEST_SECRET, action).then(
    ({ sigHex, timestamp }) =>
      new Request(`https://internal${path}`, {
        method: "POST",
        headers: {
          "X-Internal-Auth": sigHex,
          "X-Internal-Timestamp": String(timestamp),
          "X-Internal-Project": String(fixture.projectId),
        },
      }),
  );
}

/**
 * One signed request to the object, with its body read.
 *
 * The body is read even where nothing asserts on it: an unread response body is
 * an open stream, and an object holding one has an active reference the harness
 * cannot evict past.
 */
async function post(
  fixture: Fixture,
  path: string,
  action: string,
): Promise<{ status: number; body: string }> {
  const response = await trackedStub(fixture.projectId).fetch(await signed(fixture, path, action));
  return { status: response.status, body: await response.text() };
}

async function baseRow(projectId: number) {
  return env.DB.prepare(
    "SELECT yjs_state, yjs_generation, yjs_seq, yjs_write FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{
      yjs_state: ArrayBuffer | null;
      yjs_generation: number | null;
      yjs_seq: number | null;
      yjs_write: number;
    }>();
}

/** Plant a state into an object's own storage, through the codec that writes it. */
async function plant(stub: DurableObjectStub, group: Record<string, unknown>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await writeGroup(state.storage as unknown as LogStorage, group);
  });
}

/** What storage holds at one key right now. */
async function stored<T>(stub: DurableObjectStub, key: string): Promise<T | undefined> {
  return await runInDurableObject(stub, (_instance, state) => state.storage.get<T>(key));
}

/** Which of `keys` storage still holds. */
async function present(stub: DurableObjectStub, keys: string[]): Promise<string[]> {
  return await runInDurableObject(stub, async (_instance, state) => {
    const found = await state.storage.get<unknown>(keys);
    return keys.filter((key) => found.has(key));
  });
}

/** Evict `stub` once no socket is attached, so the next instance loads cold. */
async function evictWithoutSockets(stub: DurableObjectStub): Promise<void> {
  await vi.waitFor(async () => {
    expect(await runInDurableObject(stub, (_i, state) => state.getWebSockets().length)).toBe(0);
  }, { timeout: 5000 });
  // The alarm a landed reset arms is disarmed first: every run below is driven
  // by the test, and one firing on its own schedule would race what follows.
  await runInDurableObject(stub, (_i, state) => state.storage.deleteAlarm());
  await hibernate(stub);
}

/**
 * Admit a client after an eviction and read what the server gives it, which is
 * the document the object actually serves.
 */
async function freshAdmission(
  fixture: Fixture,
  generation: number,
): Promise<{ socket: Socket; doc: Y.Doc }> {
  const socket = await openSocket(fixture, "new");
  const state = await drainAcceptanceFrames(socket, generation);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return { socket, doc };
}

function storyTitles(doc: Y.Doc): string[] {
  return doc.getArray<Y.Map<unknown>>("stories").toArray().map((m) => String(m.get("title")));
}

/** One field set on the first story, as the sync message a client sends. */
function setFieldMessage(state: Uint8Array, key: string, value: string): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, state);
  const before = Y.encodeStateVector(client);
  client.transact(() => {
    client.getArray<Y.Map<unknown>>("stories").get(0).set(key, value);
  });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client, before));
  return encoding.toUint8Array(encoder);
}

/** A base of this project's own rows, for planting under a superseded generation. */
async function baseFor(fixture: Fixture, title: string): Promise<Uint8Array> {
  const rows = await env.DB.prepare("SELECT id, story_id FROM stories WHERE project_id = ?")
    .bind(fixture.projectId)
    .all<{ id: number; story_id: string }>();
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const row of rows.results) {
      const map = new Y.Map<unknown>();
      map.set("_id", row.id);
      map.set("story_id", row.story_id);
      map.set("title", new Y.Text(title));
      map.set("order_key", "a0");
      doc.getArray<Y.Map<unknown>>("stories").push([map]);
    }
  }, null);
  return Y.encodeStateAsUpdate(doc);
}

/** Everything one superseded generation holds, planted in one group. */
async function plantGeneration(
  stub: DurableObjectStub,
  fixture: Fixture,
  generation: number,
  records: number,
): Promise<string[]> {
  const group: Record<string, unknown> = {
    ...encodeBase(generation, 0, await baseFor(fixture, `base ${generation}`)),
    ...encodeHalt(generation, "enforcement_failed"),
  };
  for (let seq = 1; seq <= records; seq++) {
    Object.assign(group, encodeRecord(logKey(generation, seq), new Uint8Array([generation, seq % 251])));
  }
  await plant(stub, group);
  return Object.keys(group);
}

/** Run the alarm on the instance that holds the object right now. */
async function runAlarm(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (instance) => (instance as unknown as Internals).alarm());
}

async function floorOf(stub: DurableObjectStub): Promise<number> {
  return (await stored<number>(stub, MAINTENANCE_FLOOR_KEY)) ?? 0;
}

// ---------------------------------------------------------------------------
// A reset that lands
// ---------------------------------------------------------------------------

describe("a reset that lands leaves one base and one generation's keys", () => {
  it("serves the rebuilt document after an eviction, and the alarm sweeps what it superseded", async () => {
    const fixture = await seedProject("staged-reset-lands");
    const stub = trackedStub(fixture.projectId);
    const old = await plantGeneration(stub, fixture, 0, 3);

    expect((await post(fixture, "/reset", "reset")).status).toBe(200);

    // The staged header is retired by the landed replacement; its parts are
    // maintenance's.
    expect(await stored(stub, baseKey(1))).toBeUndefined();
    const row = await baseRow(fixture.projectId);
    expect(row!.yjs_generation).toBe(1);
    expect(row!.yjs_seq).toBe(0);

    await evictWithoutSockets(stub);
    const admitted = await freshAdmission(fixture, 1);
    expect(storyTitles(admitted.doc)).toEqual([fixture.storyTitle]);
    admitted.socket.ws.close();
    await evictWithoutSockets(stub);

    await runAlarm(stub);

    expect(await present(stub, old)).toEqual([]);
    expect(await present(stub, [`${baseKey(1)}:0001`])).toEqual([]);
    expect(await floorOf(stub)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A replacement refused
// ---------------------------------------------------------------------------

/**
 * Move the row's revision from inside the reset, after it has read the revision
 * and before its own CAS.
 *
 * The stand-in for a replacement's claim, which this harness cannot produce: it
 * cannot run two instances of one object. Installed on the instance and removed
 * by its first use.
 */
async function claimBeforeTheCas(
  stub: DurableObjectStub,
  projectId: number,
  moves: number,
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals;
    const real = internals.writeBaseRow.bind(internals);
    internals.writeBaseRow = async (blob, generation, seq, held, now) => {
      internals.writeBaseRow = real;
      await env.DB.prepare("UPDATE projects SET yjs_write = yjs_write + ? WHERE id = ?")
        .bind(moves, projectId)
        .run();
      return real(blob, generation, seq, held, now);
    };
  });
}

describe("a replacement another instance's claim has overtaken", () => {
  it("refuses the fence, halts the new generation, and leaves the staged base standing", async () => {
    const fixture = await seedProject("staged-reset-refused");
    const stub = trackedStub(fixture.projectId);
    const before = await baseRow(fixture.projectId);
    await claimBeforeTheCas(stub, fixture.projectId, 2);

    const response = await post(fixture, "/reset", "reset");

    expect(response.status).toBe(503);
    expect(await stored<{ reason: string }>(stub, haltKey(1)))
      .toMatchObject({ reason: "fence_refused" });
    // The staged base stands, unreachable to this instance.
    expect(await stored(stub, baseKey(1))).toMatchObject({ generation: 1, seq: 0 });
    const after = await baseRow(fixture.projectId);
    expect(after!.yjs_generation).toBe(before!.yjs_generation);
    expect(after!.yjs_seq).toBe(before!.yjs_seq);
    expect(after!.yjs_write).toBe(before!.yjs_write + 2);
  });
});

// ---------------------------------------------------------------------------
// A replacement that did not land
// ---------------------------------------------------------------------------

/**
 * Make the reset's own conditioned write answer as it does when it matched no
 * row, WITHOUT executing it, so the row is genuinely unmoved.
 *
 * `throwAfter` runs the statement first and then throws, which is the lost
 * acknowledgement over a write that did land — the adoption case.
 */
async function refuseTheReplacement(
  stub: DurableObjectStub,
  opts: { throwAfter?: boolean } = {},
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals;
    const real = internals.writeBaseRow.bind(internals);
    internals.writeBaseRow = async (blob, generation, seq, held, now) => {
      internals.writeBaseRow = real;
      if (opts.throwAfter !== true) return false;
      await real(blob, generation, seq, held, now);
      throw new Error("D1_ERROR: the acknowledgement was lost (test seam)");
    };
  });
}

describe("a replacement that lands zero rows with the row unmoved", () => {
  it("is recovered from the staged base, and the first snapshot retires it", async () => {
    const fixture = await seedProject("staged-reset-recovery");
    const stub = trackedStub(fixture.projectId);
    await refuseTheReplacement(stub);

    expect((await post(fixture, "/reset", "reset")).status).toBe(503);

    // The generation is spent and the row is honestly at the old one.
    expect(await stored(stub, "docGeneration")).toBe(1);
    expect((await baseRow(fixture.projectId))!.yjs_generation).toBeNull();
    expect(await stored(stub, baseKey(1))).toMatchObject({ generation: 1, seq: 0 });

    await evictWithoutSockets(stub);

    // No second reset: the staged base is what the next load serves.
    const admitted = await freshAdmission(fixture, 1);
    expect(storyTitles(admitted.doc)).toEqual([fixture.storyTitle]);

    admitted.socket.ws.send(setFieldMessage(
      Y.encodeStateAsUpdate(admitted.doc),
      "byline",
      "written after the recovery",
    ));
    await vi.waitFor(async () => {
      const served = await runInDurableObject(stub, (instance) =>
        String((instance as unknown as Internals).ydoc
          .getArray<Y.Map<unknown>>("stories").get(0).get("byline")));
      expect(served).toBe("written after the recovery");
    }, { timeout: 5000 });

    await runInDurableObject(stub, (instance) => (instance as unknown as Internals).forceSnapshot());

    const row = await baseRow(fixture.projectId);
    expect(row!.yjs_generation).toBe(1);
    // The staged base's 0, the repair record the recovering load wrote above
    // it, and the edit above that.
    expect(row!.yjs_seq).toBe(2);
    expect(await stored(stub, baseKey(1))).toBeUndefined();

    admitted.socket.ws.close();
    await evictWithoutSockets(stub);
    const again = await freshAdmission(fixture, 1);
    expect(String(again.doc.getArray<Y.Map<unknown>>("stories").get(0).get("byline")))
      .toBe("written after the recovery");
    again.socket.ws.close();
  });

  it("adopts a replacement whose acknowledgement was lost, and retires the header", async () => {
    const fixture = await seedProject("staged-reset-adopted");
    const stub = trackedStub(fixture.projectId);
    await refuseTheReplacement(stub, { throwAfter: true });

    expect((await post(fixture, "/reset", "reset")).status).toBe(200);

    const row = await baseRow(fixture.projectId);
    expect(row!.yjs_generation).toBe(1);
    expect(row!.yjs_seq).toBe(0);
    expect(await stored(stub, baseKey(1))).toBeUndefined();

    await evictWithoutSockets(stub);
    const admitted = await freshAdmission(fixture, 1);
    expect(storyTitles(admitted.doc)).toEqual([fixture.storyTitle]);
    admitted.socket.ws.close();
  });
});

// ---------------------------------------------------------------------------
// Maintenance across an eviction
// ---------------------------------------------------------------------------

describe("maintenance survives the eviction between its runs", () => {
  it("sweeps 1,500 planted keys over as many runs as it takes, with the floor as its only record", async () => {
    const fixture = await seedProject("staged-reset-maintenance");
    const stub = trackedStub(fixture.projectId);
    await runInDurableObject(stub, (_instance, state) => state.storage.put("docGeneration", 3));
    const planted = [
      // Three keys apart from the records: a parted base's header and its one
      // part, and the halt marker.
      ...await plantGeneration(stub, fixture, 0, 597),
      ...await plantGeneration(stub, fixture, 1, 497),
      ...await plantGeneration(stub, fixture, 2, 397),
    ];
    expect(planted).toHaveLength(1_500);

    await runAlarm(stub);

    // Work remains, and the floor is the whole of what the next instance needs.
    expect(await floorOf(stub)).toBeLessThan(3);
    await evictWithoutSockets(stub);

    for (let run = 0; run < 5 && (await floorOf(stub)) < 3; run++) await runAlarm(stub);

    expect(await floorOf(stub)).toBe(3);
    expect(await present(stub, planted)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The reset and the alarm serialise
// ---------------------------------------------------------------------------
