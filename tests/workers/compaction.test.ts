/**
 * The log folded into a storage base, against the real class, real D1 and real
 * workerd.
 *
 * The unit project proves the branching, the ordering and the bounds against
 * scripted storage. This proves what that harness cannot: that the keys the
 * object's own storage holds after a compaction are a base the codec reads back
 * and the records above it, that an eviction at that point still serves every
 * edit, that a bounded retirement's remainder is drained by a later alarm from
 * what storage and the row say, and that a transaction whose later batch throws
 * leaves the previous base whole on the platform's own storage.
 *
 * Instrumentation does not survive an eviction: the policy seam, the retirement
 * budget, the D1 wrapper and the transaction seam all belong to one instance,
 * and each is reinstalled on the instance that has to carry it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";

import { logPrefix, parseKey, readBase } from "../../workers/doc-log";
import type { LogStorage } from "../../workers/doc-log";
import { hibernate } from "./helpers/hibernate";
import {
  drainAcceptanceFrames,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";
import {
  SEAM_RECORDS,
  cancelAlarm,
  clientEdit,
  docOf,
  failBlobWrite,
  installProbe,
  installSeams,
  signedFor,
  waitUntil,
  type Internals,
} from "./helpers/instrumentation";

const opened = new Set<DurableObjectStub>();

function compactionStub(projectId: number): DurableObjectStub {
  opened.add(stubFor(projectId));
  return stubFor(projectId);
}

afterEach(async () => {
  for (const stub of opened) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
      for (const ws of state.getWebSockets()) {
        try { ws.close(1000, "test over"); } catch { /* already closed */ }
      }
    });
  }
  opened.clear();
});

async function rowOf(projectId: number) {
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

/** Force a snapshot through its route, reading the body so an eviction can follow. */
async function snapshotNow(fixture: Fixture): Promise<number> {
  const response = await compactionStub(fixture.projectId)
    .fetch(await signedFor(fixture, "/snapshot", "snapshot"));
  await response.text();
  return response.status;
}

/** Every key under the current generation's log prefix, in order. */
async function keysUnderLog(stub: DurableObjectStub, generation = 0): Promise<string[]> {
  return runInDurableObject(stub, async (_instance, state) => {
    const page = await state.storage.list<unknown>({ prefix: logPrefix(generation) });
    return [...page.keys()];
  });
}

/** The sequence each listed key belongs to, deduplicated and ordered. */
function seqsIn(keys: string[]): number[] {
  const seen = new Set<number>();
  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed?.seq !== undefined) seen.add(parsed.seq);
  }
  return [...seen].sort((a, b) => a - b);
}

/** The storage base the object holds, read back through the codec. */
async function storedBase(stub: DurableObjectStub, generation = 0) {
  return runInDurableObject(stub, (_instance, state) =>
    readBase(state.storage as unknown as LogStorage, generation),
  );
}

async function alarmDeadline(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/** Run the object's own alarm, and report whether it completed normally. */
async function runAlarm(stub: DurableObjectStub): Promise<boolean> {
  return runInDurableObject(stub, async (instance) => {
    try {
      await (instance as unknown as Internals).alarm();
      return true;
    } catch {
      return false;
    }
  });
}

function story0(doc: Y.Doc): Y.Map<unknown> {
  return doc.getArray<Y.Map<unknown>>("stories").get(0);
}

/** Wait for every socket to be gone, then drop the object from memory. */
async function evictObject(stub: DurableObjectStub, socket: Socket): Promise<void> {
  socket.ws.close();
  await vi.waitFor(async () => {
    expect(await runInDurableObject(stub, (_i, s) => s.getWebSockets().length)).toBe(0);
  }, { timeout: 5000 });
  await cancelAlarm(stub);
  await hibernate(stub);
}

/**
 * Make the base transaction's LATER batch throw, on this instance's storage.
 *
 * The first batch is issued through the real transaction and the second throws
 * synchronously, which is exactly the shape `writeGroup` has no rollback of its
 * own for. What is asserted afterwards is the platform's: the transaction is
 * what makes the group whole or absent.
 */
async function throwOnLaterBatch(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const storage = state.storage as unknown as Record<string, unknown>;
    const real = (storage.transaction as (c: unknown) => Promise<unknown>).bind(storage);
    storage.transaction = (closure: (txn: unknown) => Promise<unknown>) =>
      real(async (txn: Record<string, unknown>) => {
        let issued = 0;
        const guarded = new Proxy(txn, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (prop !== "put") {
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (...args: unknown[]) => {
              issued += 1;
              if (issued > 1) throw new Error("the binding went away mid-group");
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        });
        return await closure(guarded);
      });
  });
}

describe("an alarm folds a log past the record threshold into a storage base", () => {
  it("writes the base, keeps the tail above it, and serves every edit after an eviction", async () => {
    const fixture = await seedProject("compact-threshold");
    const stub = compactionStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    let state = await drainAcceptanceFrames(socket);
    await cancelAlarm(stub);
    await installSeams(stub);

    for (let n = 1; n <= 25; n++) {
      state = clientEdit(socket, state, (doc) => { story0(doc).set(`field_${n}`, String(n)); });
    }
    await waitUntil(stub, (doc) => story0(doc).get("field_25") === "25");
    await cancelAlarm(stub);

    // The snapshot half's blob write is refused, so the row does not move and
    // no header is retired: what the compaction leaves is what is asserted.
    const failing = { on: true };
    await failBlobWrite(stub, failing);
    await runAlarm(stub);
    await cancelAlarm(stub);

    const base = await storedBase(stub);
    expect(base).not.toBeNull();
    expect(base!.generation).toBe(0);
    const foldedAt = base!.seq;
    for (const seq of seqsIn(await keysUnderLog(stub))) expect(seq).toBeGreaterThan(foldedAt);

    // A tail above the base, then an eviction: the wake has to apply the base
    // and replay what stands above it.
    state = clientEdit(socket, state, (doc) => { story0(doc).set("after_one", "1"); });
    clientEdit(socket, state, (doc) => { story0(doc).set("after_two", "2"); });
    await waitUntil(stub, (doc) => story0(doc).get("after_two") === "2");
    await cancelAlarm(stub);
    expect(seqsIn(await keysUnderLog(stub)).length).toBeGreaterThan(0);

    await evictObject(stub, socket);

    const readmitted = await openSocket(fixture, "0");
    const served = new Y.Doc();
    Y.applyUpdate(served, await drainAcceptanceFrames(readmitted));
    for (let n = 1; n <= 25; n++) expect(story0(served).get(`field_${n}`)).toBe(String(n));
    expect(story0(served).get("after_one")).toBe("1");
    expect(story0(served).get("after_two")).toBe("2");

    // The blob write allowed again: the landed snapshot retires the header and
    // the log below its own sequence, and the row is the base from then on.
    failing.on = false;
    await cancelAlarm(stub);
    expect(await snapshotNow(fixture)).toBe(200);
    await cancelAlarm(stub);

    expect(await storedBase(stub)).toBeNull();
    const row = await rowOf(fixture.projectId);
    expect(row!.yjs_generation).toBe(0);
    for (const seq of seqsIn(await keysUnderLog(stub))) {
      expect(seq).toBeGreaterThan(row!.yjs_seq as number);
    }

    await evictObject(stub, readmitted);

    const third = await openSocket(fixture, "0");
    const fromRow = new Y.Doc();
    Y.applyUpdate(fromRow, await drainAcceptanceFrames(third));
    expect(story0(fromRow).get("field_1")).toBe("1");
    expect(story0(fromRow).get("after_two")).toBe("2");
    third.ws.close();
  }, 60_000);
});

describe("a bounded retirement's remainder is drained by the alarms that follow", () => {
  it("continues from the header, and then from the row on a socketless wake", async () => {
    const fixture = await seedProject("compact-continue");
    const stub = compactionStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    let state = await drainAcceptanceFrames(socket);
    await cancelAlarm(stub);
    // One deletion per budget, so a range of more than one key cannot drain in
    // one alarm and the continuation is what finishes it.
    await installSeams(stub, { retirement: { deletes: 1, lists: 1 } });

    const failing = { on: true };
    await failBlobWrite(stub, failing);
    for (let n = 1; n <= 25; n++) {
      state = clientEdit(socket, state, (doc) => { story0(doc).set(`field_${n}`, String(n)); });
    }
    await waitUntil(stub, (doc) => story0(doc).get("field_25") === "25");
    await cancelAlarm(stub);

    await runAlarm(stub);
    await cancelAlarm(stub);
    const base = await storedBase(stub);
    expect(base).not.toBeNull();
    const owedAfterFirst = seqsIn(await keysUnderLog(stub)).filter((seq) => seq <= base!.seq);
    expect(owedAfterFirst.length).toBeGreaterThan(0);

    // Each alarm spends one budget, and the range drains over as many as it
    // takes; the seams are this instance's and survive until it is evicted.
    for (let run = 0; run < 40; run++) {
      const owed = seqsIn(await keysUnderLog(stub)).filter((seq) => seq <= base!.seq);
      if (owed.length === 0) break;
      await runAlarm(stub);
      await cancelAlarm(stub);
    }
    expect(seqsIn(await keysUnderLog(stub)).filter((seq) => seq <= base!.seq)).toEqual([]);

    // A landed snapshot retires the header, so the row becomes the floor; more
    // records than one budget can take are left below it.
    failing.on = false;
    for (let n = 26; n <= 40; n++) {
      state = clientEdit(socket, state, (doc) => { story0(doc).set(`field_${n}`, String(n)); });
    }
    await waitUntil(stub, (doc) => story0(doc).get("field_40") === "40");
    await cancelAlarm(stub);
    expect(await snapshotNow(fixture)).toBe(200);
    await cancelAlarm(stub);

    expect(await storedBase(stub)).toBeNull();
    const row = await rowOf(fixture.projectId);
    const eligible = seqsIn(await keysUnderLog(stub)).filter(
      (seq) => seq <= (row!.yjs_seq as number),
    );
    expect(eligible.length).toBeGreaterThan(0);

    // A socketless wake over the same storage and row, with no seam assigning
    // its identity: the durable binding is what lets it read the row's floor.
    await evictObject(stub, socket);
    await installSeams(stub, { retirement: { deletes: 1, lists: 1 } });

    for (let run = 0; run < 60; run++) {
      const owed = seqsIn(await keysUnderLog(stub)).filter(
        (seq) => seq <= (row!.yjs_seq as number),
      );
      if (owed.length === 0) break;
      await runAlarm(stub);
      await cancelAlarm(stub);
    }

    expect(
      seqsIn(await keysUnderLog(stub)).filter((seq) => seq <= (row!.yjs_seq as number)),
    ).toEqual([]);
  }, 60_000);
});

describe("a base transaction whose later batch throws leaves the previous base whole", () => {
  it("completes the alarm, records the rejection, and changes nothing durable", async () => {
    const fixture = await seedProject("compact-rollback");
    const stub = compactionStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    let state = await drainAcceptanceFrames(socket);
    await cancelAlarm(stub);
    // Parted one byte at a time, so the group spans more than one batch of the
    // backend's 128-key limit and the throw lands on a later one.
    await installSeams(stub, { partLimit: 1 });
    // The storage probe stands between the object and its storage everywhere,
    // the transaction's own handle included. What the transaction guarantees
    // has to hold with it installed, or the seam has changed the thing it is
    // there to observe.
    const probe = await installProbe(stub);

    const failing = { on: true };
    await failBlobWrite(stub, failing);
    for (let n = 1; n <= 25; n++) {
      state = clientEdit(socket, state, (doc) => { story0(doc).set(`field_${n}`, String(n)); });
    }
    await waitUntil(stub, (doc) => story0(doc).get("field_25") === "25");
    await cancelAlarm(stub);

    // One compaction that lands, so there is a previous base to preserve.
    await runAlarm(stub);
    await cancelAlarm(stub);
    const before = await storedBase(stub);
    expect(before).not.toBeNull();

    // More debt above it, then the socket closed so the instance is loaded and
    // socketless: the snapshot half does not run, and the alarm's outcome is
    // the compaction's alone.
    for (let n = 26; n <= 60; n++) {
      state = clientEdit(socket, state, (doc) => { story0(doc).set(`field_${n}`, String(n)); });
    }
    await waitUntil(stub, (doc) => story0(doc).get("field_60") === "60");
    socket.ws.close();
    await vi.waitFor(async () => {
      expect(await runInDurableObject(stub, (_i, s) => s.getWebSockets().length)).toBe(0);
    }, { timeout: 5000 });
    await cancelAlarm(stub);

    await throwOnLaterBatch(stub);
    const accountingBefore = await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as Internals;
      return { base: internals.baseSeq, bytes: internals.logBytesSinceBase };
    });
    // The debt this alarm is about, so a compaction that never ran could not
    // pass the assertions below by leaving everything alone.
    const debt = await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as Internals;
      return (internals.docSeq ?? 0) - (internals.baseSeq ?? 0);
    });
    expect(debt).toBeGreaterThanOrEqual(SEAM_RECORDS);
    const at = await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as Internals;
      return { seq: internals.docSeq, generation: internals.docGeneration };
    });

    const refusals: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      refusals.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      expect(await runAlarm(stub)).toBe(true);
    } finally {
      errors.mockRestore();
    }

    // The refusal names the project, the generation and the sequence it was
    // refused at: an alarm that completed normally says nothing else about it.
    const refused = refusals.filter((line) => line.includes("[persistence][compaction]"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain(`project ${fixture.projectId}`);
    expect(refused[0]).toContain(`generation ${at.generation}`);
    expect(refused[0]).toContain(`sequence ${at.seq}`);
    expect(refused[0]).toContain("nothing was changed");

    const after = await storedBase(stub);
    expect(after!.seq).toBe(before!.seq);
    expect(new Uint8Array(after!.bytes)).toEqual(new Uint8Array(before!.bytes));
    const accountingAfter = await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as Internals;
      return { base: internals.baseSeq, bytes: internals.logBytesSinceBase };
    });
    expect(accountingAfter).toEqual(accountingBefore);

    // The probe saw the transaction's own batches, which is what makes the
    // assertions above assertions about the instrumented path.
    expect(probe.calls.some((call) => call.operation === "put")).toBe(true);

    // A rejected outcome waits the full interval rather than coming straight
    // back at the maintenance delay.
    const deadline = await alarmDeadline(stub);
    expect(deadline).not.toBeNull();
    expect((deadline as number) - Date.now()).toBeGreaterThan(20_000);
  }, 60_000);
});

describe("a D1 binding that refuses the snapshot does not prevent the fold", () => {
  it("compacts on the alarm and serves every edit from the base after an eviction", async () => {
    const fixture = await seedProject("compact-d1-down");
    const stub = compactionStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    let state = await drainAcceptanceFrames(socket);
    await cancelAlarm(stub);
    await installSeams(stub);

    const failing = { on: true };
    await failBlobWrite(stub, failing);
    for (let n = 1; n <= 22; n++) {
      state = clientEdit(socket, state, (doc) => { story0(doc).set(`edit_${n}`, String(n)); });
    }
    await waitUntil(stub, (doc) => story0(doc).get("edit_22") === "22");
    await cancelAlarm(stub);

    await runAlarm(stub);
    await cancelAlarm(stub);

    const base = await storedBase(stub);
    expect(base).not.toBeNull();
    // The row never moved, so the storage base is the only exact base there is.
    expect((await rowOf(fixture.projectId))!.yjs_seq).toBe(0);

    clientEdit(socket, state, (doc) => { story0(doc).set("edit_23", "23"); });
    await waitUntil(stub, (doc) => story0(doc).get("edit_23") === "23");
    await evictObject(stub, socket);

    const readmitted = await openSocket(fixture, "0");
    const served = new Y.Doc();
    Y.applyUpdate(served, await drainAcceptanceFrames(readmitted));
    for (let n = 1; n <= 22; n++) expect(story0(served).get(`edit_${n}`)).toBe(String(n));
    expect(story0(served).get("edit_23")).toBe("23");
    expect(await storedBase(stub, 0)).not.toBeNull();
    expect(await keysUnderLog(stub)).not.toHaveLength(0);
    readmitted.ws.close();
  }, 60_000);
});
