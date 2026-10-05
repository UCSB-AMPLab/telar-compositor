/**
 * The log retired below the row's sequence, against the real class, real D1
 * and real workerd.
 *
 * The unit project proves the branching, the bounds and the ordering against
 * scripted storage. This proves what that harness cannot: that the keys the
 * object's own storage holds after a landed write are exactly the records above
 * the sequence the row carries, and that an eviction at that point still serves
 * every edit.
 *
 * Instrumentation does not survive an eviction, so a wrapper installed before
 * one is gone after it and is reinstalled on the instance that has to be
 * observed.
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
import { logPrefix, parseKey } from "../../workers/doc-log";
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
  docSeq: number | null;
  ydoc: Y.Doc;
  env: { DB: D1Database };
  ctx: DurableObjectState;
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

async function signed(fixture: Fixture, path: string, action: string): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(fixture.projectId, TEST_SECRET, action);
  return new Request(`https://internal${path}`, {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(fixture.projectId),
    },
  });
}

/**
 * Force a snapshot through the route that exists for it, and READ its body.
 *
 * An object cannot be evicted while a response body of its own is unread, so a
 * status-only assertion here would hang the eviction the window depends on.
 */
async function forceSnapshot(fixture: Fixture): Promise<number> {
  const response = await trackedStub(fixture.projectId)
    .fetch(await signed(fixture, "/snapshot", "snapshot"));
  await response.text();
  return response.status;
}

/** Every key under the current generation's log prefix, in order. */
async function logKeys(stub: DurableObjectStub, generation = 0): Promise<string[]> {
  return runInDurableObject(stub, async (_instance, state) => {
    const page = await state.storage.list<unknown>({ prefix: logPrefix(generation) });
    return [...page.keys()];
  });
}

/** The sequence each key under the log prefix belongs to, deduplicated. */
function sequencesOf(keys: string[]): number[] {
  const seen = new Set<number>();
  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed?.seq !== undefined) seen.add(parsed.seq);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Cancel whatever alarm the object armed, so no snapshot runs behind a test. */
async function disarm(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
}

/**
 * The document a row's blob decodes to, built outside the object.
 *
 * A snapshot's own claim is about the blob it wrote, and reading it back
 * through the instance that wrote it would prove the instance instead.
 */
async function decodedRow(projectId: number): Promise<Y.Doc> {
  const row = await baseRow(projectId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row!.yjs_state as unknown as ArrayLike<number>));
  return doc;
}

/** The sequence the instance stands at, which is what an encoding captures. */
async function capturedSeq(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub, (instance) => (instance as unknown as Internals).docSeq);
}

/** The document the object serves, as a copy. */
async function servedDoc(stub: DurableObjectStub): Promise<Y.Doc> {
  const bytes = await runInDurableObject(stub, (instance) =>
    Y.encodeStateAsUpdate((instance as unknown as Internals).ydoc),
  );
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}

/** Send one client update built from the state the server last sent. */
function sendUpdate(socket: Socket, state: Uint8Array, mutate: (doc: Y.Doc) => void): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, state);
  const before = Y.encodeStateVector(client);
  client.transact(() => mutate(client));
  const update = Y.encodeStateAsUpdate(client, before);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  socket.ws.send(encoding.toUint8Array(encoder));
  return Y.encodeStateAsUpdate(client);
}

/** Wait until the object's own document satisfies `holds`. */
async function until(
  stub: DurableObjectStub,
  holds: (doc: Y.Doc) => boolean,
  timeout = 5000,
): Promise<void> {
  await vi.waitFor(async () => {
    expect(holds(await servedDoc(stub))).toBe(true);
  }, { timeout });
}

/**
 * Drop the object from memory with its sockets retained.
 *
 * Closing the last socket first runs the disconnect snapshot, which can carry a
 * record to D1 before the eviction and leave a broken wake-time replay looking
 * correct. The eviction has to happen over exactly the state the test has just
 * inspected, so the socket is hibernated rather than closed.
 */
async function evictHolding(stub: DurableObjectStub): Promise<void> {
  await disarm(stub);
  await hibernate(stub);
}

/** Close whatever sockets a test opened, once its assertions are done. */
function closeAll(...sockets: Socket[]): void {
  for (const socket of sockets) {
    try { socket.ws.close(); } catch { /* already closed */ }
  }
}

function firstStory(doc: Y.Doc): Y.Map<unknown> {
  return doc.getArray<Y.Map<unknown>>("stories").get(0);
}

/**
 * A promise a test resolves, and a flag saying the caller reached it.
 *
 * A flag rather than a promise for the arrival: a promise resolved from inside
 * the object would continue the test's own await in the object's I/O context,
 * where a socket belonging to the test cannot be written to. Polling the flag
 * keeps the test on its own stack.
 */
function holdPoint() {
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  const state = { reached: false };
  return {
    reached: () => state.reached,
    release: () => open(),
    hold: () => { state.reached = true; return held; },
  };
}

interface DbHooks {
  /** Runs before the blob write executes. */
  beforeBlobWrite?: () => Promise<void> | void;
  /**
   * Statements spliced into the batch after the entity statements and before
   * the guard delete, so they run inside the same transaction and after the
   * guard, the advance and every real entity statement have succeeded.
   */
  appendToBatch?: (db: D1Database) => D1PreparedStatement[];
}

/**
 * Wrap ONE instance's D1 binding.
 *
 * The binding belongs to the instance, never to the shared environment, so
 * nothing another test in this isolate can reach is touched.
 */
async function wrapInstanceDb(stub: DurableObjectStub, hooks: DbHooks): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals;
    const inner = internals.env.DB;
    const isBlobWrite = /^UPDATE projects SET yjs_state/;
    const wrapper = {
      prepare(sql: string) {
        const stmt = inner.prepare(sql);
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop !== "bind") {
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (...args: unknown[]) => {
              const bound = target.bind(...args);
              return new Proxy(bound, {
                get(boundTarget, boundProp) {
                  if (boundProp === "run") {
                    return async () => {
                      if (isBlobWrite.test(sql)) await hooks.beforeBlobWrite?.();
                      return await boundTarget.run();
                    };
                  }
                  const value = Reflect.get(boundTarget, boundProp);
                  return typeof value === "function" ? value.bind(boundTarget) : value;
                },
              });
            };
          },
        });
      },
      batch(statements: unknown[]) {
        const appended = hooks.appendToBatch?.(inner) ?? [];
        // The guard delete is the batch's last statement, and the splice keeps
        // it there: what is added runs after the entity statements and inside
        // the same transaction.
        const sequence = appended.length === 0
          ? statements
          : [...statements.slice(0, -1), ...appended, statements[statements.length - 1]];
        return inner.batch(sequence as never);
      },
    };
    internals.env = { ...internals.env, DB: wrapper as unknown as D1Database };
  });
}

describe("a landed snapshot leaves the log holding only what stands above the row", () => {
  it("retires sixty-five records and serves every edit after an eviction", async () => {
    const fixture = await seedProject("retire-many");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    let state = await drainAcceptanceFrames(socket);

    for (let n = 1; n <= 65; n++) {
      state = sendUpdate(socket, state, (doc) => {
        firstStory(doc).set(`field_${n}`, String(n));
      });
    }
    // The last edit observed in the served document: every message before it
    // has been processed, so the snapshot below runs over the whole tail.
    await until(stub, (doc) => firstStory(doc).get("field_65") === "65");
    await disarm(stub);
    expect(await logKeys(stub)).toHaveLength(65);
    let blobWrites = 0;
    await wrapInstanceDb(stub, { beforeBlobWrite: () => { blobWrites += 1; } });

    expect(await forceSnapshot(fixture)).toBe(200);
    await disarm(stub);

    const row = await baseRow(fixture.projectId);
    expect(row!.yjs_generation).toBe(0);
    // The blob the snapshot wrote, decoded outside the object, and the sequence
    // the encoding captured: nothing stands between them and the wake below.
    expect(row!.yjs_seq).toBe(await capturedSeq(stub));
    expect(row!.yjs_seq).toBeGreaterThanOrEqual(65);
    const written = firstStory(await decodedRow(fixture.projectId));
    for (let n = 1; n <= 65; n++) expect(written.get(`field_${n}`)).toBe(String(n));
    const remaining = sequencesOf(await logKeys(stub));
    for (const seq of remaining) expect(seq).toBeGreaterThan(row!.yjs_seq as number);
    const inspected = blobWrites;

    await evictHolding(stub);

    // No blob write between the state inspected above and the eviction: what
    // the readmission serves is the row plus the log, not a later snapshot's.
    expect(blobWrites).toBe(inspected);

    const readmitted = await openSocket(fixture, "0");
    const served = await drainAcceptanceFrames(readmitted);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, served);
    for (let n = 1; n <= 65; n++) expect(firstStory(doc).get(`field_${n}`)).toBe(String(n));

    closeAll(readmitted, socket);
  }, 30_000);

  it("retires only what the second snapshot's own sequence covers", async () => {
    const fixture = await seedProject("retire-twice");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    let state = await drainAcceptanceFrames(socket);

    let blobWrites = 0;
    await wrapInstanceDb(stub, { beforeBlobWrite: () => { blobWrites += 1; } });

    state = sendUpdate(socket, state, (doc) => { firstStory(doc).set("first", "1"); });
    await until(stub, (doc) => firstStory(doc).get("first") === "1");
    await disarm(stub);
    expect(await forceSnapshot(fixture)).toBe(200);
    await disarm(stub);

    const afterFirst = (await baseRow(fixture.projectId))!.yjs_seq as number;
    // The first snapshot's own blob, decoded outside the object: it carries the
    // edit it covered and nothing that came after it.
    const firstBlob = firstStory(await decodedRow(fixture.projectId));
    expect(firstBlob.get("first")).toBe("1");
    expect(firstBlob.get("second")).toBeUndefined();
    expect(afterFirst).toBe(await capturedSeq(stub));
    const keptFirst = sequencesOf(await logKeys(stub));
    for (const seq of keptFirst) expect(seq).toBeGreaterThan(afterFirst);

    state = sendUpdate(socket, state, (doc) => { firstStory(doc).set("second", "2"); });
    await until(stub, (doc) => firstStory(doc).get("second") === "2");
    await disarm(stub);
    const between = sequencesOf(await logKeys(stub));
    expect(between.some((seq) => seq > afterFirst)).toBe(true);

    expect(await forceSnapshot(fixture)).toBe(200);
    await disarm(stub);

    const afterSecond = (await baseRow(fixture.projectId))!.yjs_seq as number;
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(afterSecond).toBe(await capturedSeq(stub));
    for (const seq of sequencesOf(await logKeys(stub))) {
      expect(seq).toBeGreaterThan(afterSecond);
    }
    const inspected = blobWrites;

    await evictHolding(stub);

    expect(blobWrites).toBe(inspected);

    const readmitted = await openSocket(fixture, "0");
    const served = await drainAcceptanceFrames(readmitted);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, served);
    expect(firstStory(doc).get("first")).toBe("1");
    expect(firstStory(doc).get("second")).toBe("2");
    closeAll(readmitted, socket);
  }, 30_000);

  it("keeps a message that arrived while the blob write was held", async () => {
    const fixture = await seedProject("retire-held");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    const state = await drainAcceptanceFrames(socket);
    await disarm(stub);

    const gate = holdPoint();
    let blobWrites = 0;
    await wrapInstanceDb(stub, {
      beforeBlobWrite: () => {
        blobWrites += 1;
        return blobWrites === 1 ? gate.hold() : undefined;
      },
    });

    const snapshot = trackedStub(fixture.projectId)
      .fetch(await signed(fixture, "/snapshot", "snapshot"));
    await vi.waitFor(() => { expect(gate.reached()).toBe(true); }, { timeout: 5000 });
    // Sent while the snapshot holds the gate: the object cannot take delivery
    // until the gate opens, so the record this becomes is above the sequence
    // the encoding already captured.
    sendUpdate(socket, state, (doc) => { firstStory(doc).set("late", "yes"); });
    gate.release();

    const response = await snapshot;
    await response.text();
    expect(response.status).toBe(200);

    await until(stub, (doc) => firstStory(doc).get("late") === "yes");
    await disarm(stub);

    const row = await baseRow(fixture.projectId);
    // The held write's own blob: the late edit is not in it, which is why the
    // record that carries it stands above the sequence it was written at.
    expect(firstStory(await decodedRow(fixture.projectId)).get("late")).toBeUndefined();
    const remaining = sequencesOf(await logKeys(stub));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBeGreaterThan(row!.yjs_seq as number);
    const inspected = blobWrites;

    await evictHolding(stub);

    expect(blobWrites).toBe(inspected);

    const readmitted = await openSocket(fixture, "0");
    const served = await drainAcceptanceFrames(readmitted);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, served);
    expect(firstStory(doc).get("late")).toBe("yes");
    closeAll(readmitted, socket);
  }, 30_000);

  it("retires the log for a landed blob write whose entity batch is rolled back", async () => {
    const fixture = await seedProject("retire-batch-rollback");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    const state = await drainAcceptanceFrames(socket);

    sendUpdate(socket, state, (doc) => {
      (firstStory(doc).get("title") as Y.Text).insert(0, "edited ");
    });
    await until(stub, (doc) => String(firstStory(doc).get("title")).startsWith("edited "));
    await disarm(stub);
    // What the batch's entity UPDATE would put back, so a batch that landed is
    // visible here and one that rolled back is not.
    await env.DB.prepare("UPDATE stories SET title = 'regressed' WHERE project_id = ?")
      .bind(fixture.projectId)
      .run();

    // A constraint the real schema refuses, spliced in once: the UNIQUE index
    // on (project_id, story_id) admits one row per key, and this is a second.
    let armed = true;
    await wrapInstanceDb(stub, {
      appendToBatch: (db) => {
        if (!armed) return [];
        armed = false;
        return [
          db
            .prepare("INSERT INTO stories (project_id, story_id, title) VALUES (?, 's1', ?)")
            .bind(fixture.projectId, "a second row under the same key"),
        ];
      },
    });

    const before = (await baseRow(fixture.projectId))!.yjs_write;
    const refused = await trackedStub(fixture.projectId)
      .fetch(await signed(fixture, "/snapshot", "snapshot"));
    await refused.text();
    expect(refused.status).toBe(500);
    await disarm(stub);

    const after = await baseRow(fixture.projectId);
    // The blob write's revision, and no advance from the batch: the guard's own
    // advance commits only with the statements it protects.
    expect(after!.yjs_write).toBe(before + 1);
    for (const seq of sequencesOf(await logKeys(stub))) {
      expect(seq).toBeGreaterThan(after!.yjs_seq as number);
    }
    const rolledBack = await env.DB.prepare(
      "SELECT title FROM stories WHERE project_id = ? ORDER BY id",
    ).bind(fixture.projectId).all<{ title: string }>();
    expect(rolledBack.results.map((r) => r.title)).toEqual(["regressed"]);

    expect(await forceSnapshot(fixture)).toBe(200);
    await disarm(stub);

    const settled = await env.DB.prepare(
      "SELECT title FROM stories WHERE project_id = ? ORDER BY id",
    ).bind(fixture.projectId).all<{ title: string }>();
    expect(settled.results).toHaveLength(1);
    expect(settled.results[0].title).toMatch(/^edited /);

    socket.ws.close();
  }, 30_000);
});
