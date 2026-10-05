/**
 * The halt made durable, the storage base and the paged replay, against the
 * real class, real D1 and real workerd — the only harness where an eviction,
 * a hibernated socket and Durable Object storage are all the real thing.
 *
 * Every planted state is written through the codec that writes it in
 * production, and is labelled as planted: a marker at `halt:<generation>`, a
 * base at `base:<generation>`, records under `log:<generation>:`.
 *
 * Instrumentation does not survive an eviction. Where a test needs an
 * application trace it evicts WITHOUT an attached socket, installs the trace on
 * the fresh unloaded instance, and then upgrades, which is the sequence
 * `tests/workers/exact-base.test.ts` documents in its header. Where a socket
 * must be attached through the eviction, the test asserts on observable state
 * after the wake and claims nothing about order.
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
  encodeBase,
  encodeHalt,
  encodeRecord,
  haltKey,
  logKey,
  writeGroup,
  type LogStorage,
} from "../../workers/doc-log";
import { RouterContextProvider } from "react-router";
import { createSessionStorage } from "~/lib/session.server";
import { userContext } from "~/middleware/auth.server";
import { repairConfigThroughDocument } from "~/lib/config-repair.server";
import { action as persistenceAction } from "~/routes/api.persistence";
import { hibernate } from "./helpers/hibernate";
import {
  MESSAGE_SYNC,
  attemptUpgrade,
  drainAcceptanceFrames,
  mintToken,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";
const UNAVAILABLE = { code: 1013, reason: "Try again later" };

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
  persistenceHalted: { generation: number; marker: { reason: string; at: number } } | null;
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

function signed(fixture: Fixture, path: string, action: string, method = "POST"): Promise<Request> {
  return signInternalMarker(fixture.projectId, TEST_SECRET, action).then(
    ({ sigHex, timestamp }) =>
      new Request(`https://internal${path}`, {
        method,
        headers: {
          "X-Internal-Auth": sigHex,
          "X-Internal-Timestamp": String(timestamp),
          "X-Internal-Project": String(fixture.projectId),
        },
      }),
  );
}

async function post(fixture: Fixture, path: string, action: string): Promise<Response> {
  return trackedStub(fixture.projectId).fetch(await signed(fixture, path, action));
}

/** What `GET /persistence-state` answers for this project right now. */
async function persistenceState(fixture: Fixture): Promise<{
  halted: boolean;
  reason?: string;
  generation: number;
}> {
  const response = await trackedStub(fixture.projectId).fetch(
    await signed(fixture, "/persistence-state", "persistence-state", "GET"),
  );
  expect(response.status).toBe(200);
  return await response.json();
}

/** Plant a state into an object's own storage, through the codec that writes it. */
async function plant(stub: DurableObjectStub, group: Record<string, unknown>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await writeGroup(state.storage as unknown as LogStorage, group);
  });
}

/** Evict `stub` once no socket is attached, so the next instance loads cold. */
async function evictWithoutSockets(stub: DurableObjectStub): Promise<void> {
  await vi.waitFor(async () => {
    expect(await runInDurableObject(stub, (_i, state) => state.getWebSockets().length)).toBe(0);
  }, { timeout: 5000 });
  await hibernate(stub);
}

async function closedWith(socket: Socket, close: { code: number; reason: string }) {
  await vi.waitFor(() => expect(socket.closes.length).toBeGreaterThan(0), { timeout: 5000 });
  expect(socket.closes[0]).toEqual(close);
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

function storyTitles(doc: Y.Doc): string[] {
  return doc.getArray<Y.Map<unknown>>("stories").toArray().map((m) => String(m.get("title")));
}

/** A base of this test's own: one story, with the fixture's row id. */
async function baseFor(fixture: Fixture, title: string, extraStory?: string): Promise<Uint8Array> {
  const rows = await env.DB.prepare("SELECT id, story_id FROM stories WHERE project_id = ? ORDER BY id")
    .bind(fixture.projectId)
    .all<{ id: number; story_id: string }>();
  const doc = new Y.Doc();
  const stories = doc.getArray<Y.Map<unknown>>("stories");
  doc.transact(() => {
    for (const [index, row] of rows.results.entries()) {
      const map = new Y.Map<unknown>();
      map.set("_id", row.id);
      map.set("story_id", row.story_id);
      map.set("title", new Y.Text(index === 0 ? title : (extraStory ?? row.story_id)));
      map.set("order_key", `a${index}`);
      stories.push([map]);
    }
  }, null);
  return Y.encodeStateAsUpdate(doc);
}

/** One record: a field set on the first story, distinguishable by its value. */
function recordSetting(base: Uint8Array, key: string, value: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base);
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>("stories").get(0).set(key, value);
  }, null);
  return Y.encodeStateAsUpdate(doc, before);
}

// ---------------------------------------------------------------------------
// The enforcement halt, made durable
// ---------------------------------------------------------------------------

/**
 * A second member of the fixture's project, as a `collaborator`: the role the
 * delete rule applies to, so a story the convenor created is one this socket
 * may not remove.
 */
async function collaboratorOn(fixture: Fixture): Promise<Fixture> {
  const now = new Date().toISOString();
  const githubId = Math.floor(Math.random() * 2 ** 48) + Date.now();
  const user = await env.DB.prepare(
    `INSERT INTO users (
       github_id, github_login, encrypted_access_token, encrypted_refresh_token,
       access_token_expires_at, refresh_token_expires_at, created_at, updated_at
     ) VALUES (?, ?, 'x', 'x', ?, ?, ?, ?) RETURNING id`,
  )
    .bind(githubId, `collab-${githubId}`, now, now, now, now)
    .first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?, ?, 'collaborator', ?)`,
  )
    .bind(fixture.projectId, user!.id, now)
    .run();
  return { ...fixture, userId: user!.id, token: await mintToken(user!.id) };
}

/**
 * A failure seam scoped to ONE instance: the next staged broadcast this object
 * queues throws, so the guard's post-revert broadcast fails and its enforcement
 * callback reports a revert it could not complete.
 *
 * Installed on the instance rather than on a prototype, so nothing another test
 * in this isolate can reach is touched, and removed by the first throw.
 */
async function breakTheNextBroadcast(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as Record<string, unknown>;
    let current = target.stagedEffects as { sends: { push: unknown } };
    let armed = true;
    Object.defineProperty(target, "stagedEffects", {
      configurable: true,
      get: () => current,
      set: (next: { sends: { push: unknown } }) => {
        if (armed) {
          next.sends.push = () => {
            armed = false;
            throw new Error("staged broadcast refused (test seam)");
          };
        }
        current = next;
      },
    });
  });
}

/** The one deletion this socket may not make, as the update that carries it. */
function deleteFirstStory(state: Uint8Array): Uint8Array {
  const client = new Y.Doc();
  Y.applyUpdate(client, state);
  const before = Y.encodeStateVector(client);
  client.transact(() => {
    client.getArray<Y.Map<unknown>>("stories").delete(0, 1);
  });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client, before));
  return encoding.toUint8Array(encoder);
}

describe("a halt survives the eviction that forgot the flag", () => {
  it("is produced by the guard, closes the sockets, refuses the next upgrade, and is recovered by /reset", async () => {
    const fixture = await seedProject("halt-enforced");
    const stub = trackedStub(fixture.projectId);
    // The story belongs to the convenor, and the socket below belongs to a
    // collaborator: its deletion is one the guard refuses.
    await env.DB.prepare("UPDATE stories SET created_by = ? WHERE project_id = ?")
      .bind(fixture.userId, fixture.projectId)
      .run();
    const collaborator = await collaboratorOn(fixture);
    const socket = await openSocket(collaborator, "new");
    const state = await drainAcceptanceFrames(socket);

    // Instance-scoped, and nothing about the halt is planted: the guard reverts
    // the refused deletion, its broadcast fails, and its own enforcement
    // callback is what enters the halt.
    await breakTheNextBroadcast(stub);
    socket.ws.send(deleteFirstStory(state));

    // The SERVER closed this socket, with the halt's code.
    await closedWith(socket, UNAVAILABLE);
    const marker = await runInDurableObject(stub, (_instance, objectState) =>
      objectState.storage.get<{ reason: string }>(haltKey(0)));
    expect(marker).toMatchObject({ reason: "enforcement_failed" });
    expect(await persistenceState(fixture)).toMatchObject({
      halted: true,
      reason: "enforcement_failed",
      generation: 0,
    });

    socket.ws.close();
    await evictWithoutSockets(stub);
    const revisionBefore = (await baseRow(fixture.projectId))!.yjs_write;

    const refused = await attemptUpgrade(fixture, "0");
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("persistence_halted");
    // The document never loaded: nothing claimed the row.
    expect((await baseRow(fixture.projectId))!.yjs_write).toBe(revisionBefore);
    expect(await persistenceState(fixture)).toMatchObject({ halted: true, generation: 0 });

    expect((await post(fixture, "/reset", "reset")).status).toBe(200);
    expect(await persistenceState(fixture)).toMatchObject({ halted: false, generation: 1 });

    const readmitted = await openSocket(fixture, "new");
    await drainAcceptanceFrames(readmitted, 1);
    readmitted.ws.close();
    // Two upgrades, an eviction and a reset in one case; the default budget is
    // one wait shorter than the sequence.
  }, 20_000);

  it("closes a healthy attached socket on the wake, and loads nothing", async () => {
    const fixture = await seedProject("halt-wake");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket);

    // Planted while the object is healthy and the socket attached, then evicted
    // with the socket still on it.
    await plant(stub, encodeHalt(0, "apply_failed"));
    const revisionBefore = (await baseRow(fixture.projectId))!.yjs_write;
    await hibernate(stub);

    // The wake meets the marker: the socket is closed and nothing is claimed.
    const client = new Y.Doc();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, client);
    socket.ws.send(encoding.toUint8Array(encoder));

    await closedWith(socket, UNAVAILABLE);
    expect((await baseRow(fixture.projectId))!.yjs_write).toBe(revisionBefore);
    expect(await persistenceState(fixture)).toMatchObject({
      halted: true,
      reason: "apply_failed",
    });

    expect((await post(fixture, "/reset", "reset")).status).toBe(200);
    expect(await persistenceState(fixture)).toMatchObject({ halted: false, generation: 1 });
  });
});

// ---------------------------------------------------------------------------
// The storage base and the replay
// ---------------------------------------------------------------------------

describe("a storage base for the current generation is what the client receives", () => {
  it("serves the base's content and not the D1 blob's, and claims the row", async () => {
    const fixture = await seedProject("storage-base");
    const stub = trackedStub(fixture.projectId);

    // A D1 blob holding two stories, and a storage base holding one: the base
    // was written after the second was deleted.
    await env.DB.prepare("INSERT INTO stories (project_id, story_id, title) VALUES (?, 's2', ?)")
      .bind(fixture.projectId, "D1 blob's own story")
      .run();
    const withBoth = await baseFor(fixture, fixture.storyTitle, "D1 blob's own story");
    await env.DB.prepare("UPDATE projects SET yjs_state = ?, yjs_generation = 0, yjs_seq = 0 WHERE id = ?")
      .bind(withBoth, fixture.projectId)
      .run();

    const storageDoc = new Y.Doc();
    Y.applyUpdate(storageDoc, withBoth);
    storageDoc.transact(() => {
      storageDoc.getArray<Y.Map<unknown>>("stories").delete(1, 1);
      storageDoc.getArray<Y.Map<unknown>>("stories").get(0).set("byline", "from the storage base");
    }, null);
    // Planted: a base at (0, 4) for this generation.
    await plant(stub, encodeBase(0, 4, Y.encodeStateAsUpdate(storageDoc)));
    const revisionBefore = (await baseRow(fixture.projectId))!.yjs_write;

    const socket = await openSocket(fixture, "new");
    const state = await drainAcceptanceFrames(socket);

    const client = new Y.Doc();
    Y.applyUpdate(client, state);
    expect(storyTitles(client)).toEqual([fixture.storyTitle]);
    expect(client.getArray<Y.Map<unknown>>("stories").get(0).get("byline"))
      .toBe("from the storage base");
    // Re-applying the base to the served document changes neither its snapshot,
    // its state, nor its pending state: nothing in the base is missing from
    // what the document holds, and nothing it carried is waiting on structs
    // that never arrived.
    const served = await servedDoc(stub);
    const before = Y.snapshot(served);
    const stateBefore = Y.encodeStateAsUpdate(served);
    Y.applyUpdate(served, Y.encodeStateAsUpdate(storageDoc));
    expect(Y.equalSnapshots(before, Y.snapshot(served))).toBe(true);
    expect(Y.encodeStateAsUpdate(served)).toEqual(stateBefore);
    expect(served.store.pendingStructs).toBeNull();
    expect(served.store.pendingDs).toBeNull();
    expect((await baseRow(fixture.projectId))!.yjs_write).toBe(revisionBefore + 1);
    // One above the base and its tail: the repairs a load runs unsuppressed
    // are logged, and `backfillBlobGaps` seeds the config toggles.
    expect(await runInDurableObject(stub, (i) => (i as unknown as Internals).docSeq)).toBe(5);

    socket.ws.close();
  });

  it("applies three planted records above the base's sequence, and seeds the sequence from the last", async () => {
    const fixture = await seedProject("replay-three");
    const stub = trackedStub(fixture.projectId);
    const base = await baseFor(fixture, fixture.storyTitle);
    await env.DB.prepare("UPDATE projects SET yjs_state = ?, yjs_generation = 0, yjs_seq = 0 WHERE id = ?")
      .bind(base, fixture.projectId)
      .run();
    // Planted records, each carrying content of its own.
    // Keys the load-time repairs do not rewrite: `order_key` is backfilled on
    // every load, so a record carrying one proves nothing about the replay.
    for (const [seq, key] of [[1, "byline"], [2, "subtitle"], [3, "credit"]] as const) {
      await plant(stub, encodeRecord(logKey(0, seq), recordSetting(base, key, `record ${seq}`)));
    }

    const socket = await openSocket(fixture, "new");
    const state = await drainAcceptanceFrames(socket);

    // Completeness and convergence: the served document carries every record's
    // content. Nothing is claimed here about the order they were applied in.
    const client = new Y.Doc();
    Y.applyUpdate(client, state);
    const story = client.getArray<Y.Map<unknown>>("stories").get(0);
    expect(story.get("byline")).toBe("record 1");
    expect(story.get("subtitle")).toBe("record 2");
    expect(story.get("credit")).toBe("record 3");
    // One above the base and its tail: the repairs a load runs unsuppressed
    // are logged, and `backfillBlobGaps` seeds the config toggles.
    expect(await runInDurableObject(stub, (i) => (i as unknown as Internals).docSeq)).toBe(4);

    socket.ws.close();
  });

  it("replays sixty-five records completely", async () => {
    const fixture = await seedProject("replay-many");
    const stub = trackedStub(fixture.projectId);
    const base = await baseFor(fixture, fixture.storyTitle);
    await env.DB.prepare("UPDATE projects SET yjs_state = ?, yjs_generation = 0, yjs_seq = 0 WHERE id = ?")
      .bind(base, fixture.projectId)
      .run();
    for (let seq = 1; seq <= 65; seq++) {
      await plant(stub, encodeRecord(logKey(0, seq), recordSetting(base, `field_${seq}`, String(seq))));
    }

    const socket = await openSocket(fixture, "new");
    const state = await drainAcceptanceFrames(socket);

    const client = new Y.Doc();
    Y.applyUpdate(client, state);
    const story = client.getArray<Y.Map<unknown>>("stories").get(0);
    // Every one of the sixty-five, not a sample: completeness is the claim.
    const replayed: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (let seq = 1; seq <= 65; seq++) {
      replayed[`field_${seq}`] = story.get(`field_${seq}`);
      expected[`field_${seq}`] = String(seq);
    }
    expect(replayed).toEqual(expected);
    // One above the base and its tail: the repairs a load runs unsuppressed
    // are logged, and `backfillBlobGaps` seeds the config toggles.
    expect(await runInDurableObject(stub, (i) => (i as unknown as Internals).docSeq)).toBe(66);

    socket.ws.close();
  });

  it("applies the records in sequence order, traced on an unloaded instance", async () => {
    const fixture = await seedProject("replay-order");
    const stub = trackedStub(fixture.projectId);
    const base = await baseFor(fixture, fixture.storyTitle);
    await env.DB.prepare("UPDATE projects SET yjs_state = ?, yjs_generation = 0, yjs_seq = 0 WHERE id = ?")
      .bind(base, fixture.projectId)
      .run();
    const records = [1, 2, 3].map((seq) => recordSetting(base, `field_${seq}`, `value ${seq}`));
    for (const [index, bytes] of records.entries()) {
      await plant(stub, encodeRecord(logKey(0, index + 1), bytes));
    }

    // Evicted WITHOUT a socket, so the trace can be installed on the fresh,
    // unloaded instance before the upgrade that makes it load.
    await evictWithoutSockets(stub);
    const applied: Uint8Array[] = [];
    await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as Internals & {
        applyBase: (bytes: Uint8Array, generation: number) => void;
      };
      const real = internals.applyBase.bind(internals);
      internals.applyBase = (bytes: Uint8Array, generation: number) => {
        applied.push(bytes);
        return real(bytes, generation);
      };
    });

    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket);

    // The base first, then every record in the order of its sequence.
    expect(applied).toEqual([base, ...records]);
    // One above the base and its tail: the repairs a load runs unsuppressed
    // are logged, and `backfillBlobGaps` seeds the config toggles.
    expect(await runInDurableObject(stub, (i) => (i as unknown as Internals).docSeq)).toBe(4);
    socket.ws.close();
  });

  it("halts as log_corrupt on a header whose part is missing, and /reset recovers", async () => {
    const fixture = await seedProject("replay-corrupt");
    const stub = trackedStub(fixture.projectId);
    const base = await baseFor(fixture, fixture.storyTitle);
    await env.DB.prepare("UPDATE projects SET yjs_state = ?, yjs_generation = 0, yjs_seq = 0 WHERE id = ?")
      .bind(base, fixture.projectId)
      .run();
    await plant(stub, encodeRecord(logKey(0, 1), recordSetting(base, "byline", "one")));
    // A planted header for a record whose parts were never written, met by the
    // first load that reaches it — so nothing the log carried has been
    // persisted, and the reset's rebuild cannot restore it from D1.
    await plant(stub, { [logKey(0, 2)]: { v: 1, parts: 2, length: 200, checksum: 0 } });

    const refused = await attemptUpgrade(fixture, "0");
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("persistence_halted");
    expect(await persistenceState(fixture)).toMatchObject({
      halted: true,
      reason: "log_corrupt",
    });

    expect((await post(fixture, "/reset", "reset")).status).toBe(200);
    // The planted records are unreachable from the new generation's prefix.
    const readmitted = await openSocket(fixture, "new");
    const state = await drainAcceptanceFrames(readmitted, 1);
    const client = new Y.Doc();
    Y.applyUpdate(client, state);
    // The rebuild takes its fields from the D1 columns, so the value the
    // planted record carried is nowhere in the replacement.
    expect(String(client.getArray<Y.Map<unknown>>("stories").get(0).get("byline"))).not.toBe("one");
    readmitted.ws.close();
  });

  it("halts as apply_failed on a record whose bytes are not a Yjs update", async () => {
    const fixture = await seedProject("replay-apply-failed");
    const stub = trackedStub(fixture.projectId);
    const base = await baseFor(fixture, fixture.storyTitle);
    await env.DB.prepare("UPDATE projects SET yjs_state = ?, yjs_generation = 0, yjs_seq = 0 WHERE id = ?")
      .bind(base, fixture.projectId)
      .run();
    await plant(stub, encodeRecord(logKey(0, 1), new Uint8Array([9, 9, 9, 9, 9, 9])));

    const refused = await attemptUpgrade(fixture, "0");

    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("persistence_halted");
    expect(await persistenceState(fixture)).toMatchObject({
      halted: true,
      reason: "apply_failed",
    });
    expect(await runInDurableObject(stub, (i) => (i as unknown as Internals).docLoaded)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A route under the halt
// ---------------------------------------------------------------------------

describe("a mutating route under the halt", () => {
  it("answers /restore-orphans 503 and leaves the document unchanged", async () => {
    const fixture = await seedProject("halt-restore");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket);

    const before = await runInDurableObject(stub, (instance) =>
      Y.encodeStateAsUpdate((instance as unknown as Internals).ydoc),
    );
    await plant(stub, encodeHalt(0, "fence_refused"));
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as Internals).persistenceHalted = {
        generation: 0,
        marker: { v: 1, reason: "fence_refused", at: Date.now() } as never,
      };
    });

    const response = await trackedStub(fixture.projectId).fetch(
      new Request(
        (await signed(fixture, "/restore-orphans", "restore-orphans")).url,
        {
          method: "POST",
          headers: (await signed(fixture, "/restore-orphans", "restore-orphans")).headers,
          body: JSON.stringify({ stories: [{ storyId: "lost", steps: [], layers: [] }] }),
        },
      ),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("persistence_halted");
    const after = await runInDurableObject(stub, (instance) =>
      Y.encodeStateAsUpdate((instance as unknown as Internals).ydoc),
    );
    const beforeDoc = new Y.Doc();
    Y.applyUpdate(beforeDoc, before);
    const afterDoc = new Y.Doc();
    Y.applyUpdate(afterDoc, after);
    expect(Y.equalSnapshots(Y.snapshot(beforeDoc), Y.snapshot(afterDoc))).toBe(true);

    socket.ws.close();
  });
});

// ---------------------------------------------------------------------------
// Action-to-object integration
// ---------------------------------------------------------------------------

/**
 * The convenor's restore, driven through the route's own action against this
 * project's real object.
 *
 * This is NOT middleware or dispatch coverage: the Workers entry routes only
 * upgrades, so the action is invoked directly with the context the `_app` layout
 * would have built — a `RouterContextProvider` carrying `cloudflare.env`, the
 * exported `userContext` set to a seeded user, and a real cookie minted through
 * the session storage with the active project and a valid lifetime. What only
 * this harness can prove is that the signature the action mints verifies inside
 * a real object, that the generation it bound is the one the object compared,
 * and that a restored project admits the next upgrade with the handshake.
 */

/** A real session cookie carrying this fixture's user and active project. */
async function cookieFor(fixture: Fixture): Promise<string> {
  const storage = createSessionStorage(TEST_SECRET);
  const session = await storage.getSession();
  session.set("userId", fixture.userId);
  session.set("activeProjectId", fixture.projectId);
  session.set("createdAt", new Date().toISOString());
  return (await storage.commitSession(session)).split(";")[0];
}

/** The context the `_app` layout hands a route: the env plus the resolved user. */
async function contextFor(fixture: Fixture) {
  const context = new RouterContextProvider();
  (context as unknown as { cloudflare: unknown }).cloudflare = { env, ctx: {} };
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(fixture.userId)
    .first();
  context.set(userContext, user as never);
  return context;
}

interface RestoreReport {
  projectId: number;
  reset: { kind: string; generation?: number };
  state: { halted?: boolean | null; generation?: number } | { unreadable: true };
}

async function restoreThrough(
  fixture: Fixture,
  expectedGeneration: number,
): Promise<RestoreReport> {
  const body = new FormData();
  body.set("intent", "reset");
  body.set("projectId", String(fixture.projectId));
  body.set("expectedGeneration", String(expectedGeneration));
  const request = new Request("https://compositor.telar.org/api/persistence", {
    method: "POST",
    headers: { Cookie: await cookieFor(fixture) },
    body,
  });
  const response = await persistenceAction({
    request,
    context: await contextFor(fixture),
    params: {},
  } as never);
  return (await response.json()) as RestoreReport;
}

async function storedGeneration(fixture: Fixture): Promise<number | undefined> {
  return await runInDurableObject(trackedStub(fixture.projectId), (_instance, state) =>
    state.storage.get<number>("docGeneration"),
  );
}

/** Every key this project's object holds, as the storage returns them. */
async function storedKeys(fixture: Fixture): Promise<string[]> {
  const held = await runInDurableObject(trackedStub(fixture.projectId), (_instance, state) =>
    state.storage.list(),
  );
  return [...held.keys()].sort();
}

/**
 * Every key this project's object holds, paired with its stored value, as a
 * plain record. A `Uint8Array` value is normalised to a plain number array so
 * that the comparison reads bytes, not buffer views: the record form keeps the
 * assertion's failure output legible, and the number arrays make a changed
 * byte a visible difference rather than an equal-length blob.
 */
async function storedEntries(fixture: Fixture): Promise<Record<string, unknown>> {
  const held = await runInDurableObject(trackedStub(fixture.projectId), (_instance, state) =>
    state.storage.list(),
  );
  const entries: Record<string, unknown> = {};
  for (const [key, value] of held) {
    entries[key] = value instanceof Uint8Array ? Array.from(value) : value;
  }
  return entries;
}

/** An `ArrayBuffer` column value, normalised to a byte array for comparison. */
function bytesOf(buffer: ArrayBuffer | null | undefined): number[] | null {
  return buffer == null ? null : Array.from(new Uint8Array(buffer));
}

/**
 * The env the automatic helper is handed, with every request that reaches this
 * project's object recorded by path.
 *
 * The helper reaches the object through `env.COLLABORATION` and not through any
 * stub a test holds, so a test that only inspects the aftermath cannot tell a
 * reset that was never sent from one the object refused. This can.
 */
function countingEnv(projectId: number): { paths: string[]; env: unknown } {
  const paths: string[] = [];
  const real = trackedStub(projectId);
  const counting = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: (request: Request) => {
        paths.push(new URL(request.url).pathname);
        return real.fetch(request);
      },
    }),
  };
  const proxied = new Proxy(env as unknown as Record<string, unknown>, {
    get: (target, prop) =>
      prop === "COLLABORATION" ? counting : Reflect.get(target, prop),
  });
  return { paths, env: proxied };
}

describe("action-to-object integration: the convenor's restore", () => {
  it("lands against a planted halt, reads the next generation, and is readmitted", async () => {
    const fixture = await seedProject("action-restore");
    const stub = trackedStub(fixture.projectId);
    await plant(stub, encodeHalt(0, "apply_failed"));

    // The halt is real enough to refuse an upgrade before the action runs.
    const refused = await attemptUpgrade(fixture, "new");
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("persistence_halted");

    const report = await restoreThrough(fixture, 0);

    expect(report.projectId).toBe(fixture.projectId);
    expect(report.reset).toEqual({ kind: "landed" });
    expect(report.state).toMatchObject({ halted: false, generation: 1 });

    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket, 1);
    socket.ws.close();
  }, 20_000);

  it("calls a second confirmation of the same generation stale, and moves nothing", async () => {
    const fixture = await seedProject("action-restore-stale");
    await plant(trackedStub(fixture.projectId), encodeHalt(0, "log_corrupt"));

    const first = await restoreThrough(fixture, 0);
    expect(first.reset).toEqual({ kind: "landed" });
    expect(await storedGeneration(fixture)).toBe(1);

    // What the landed reset left, against which the refusal is measured: the
    // generation alone would not see a second replacement of the row.
    const rowBefore = await baseRow(fixture.projectId);
    const keysBefore = await storedKeys(fixture);
    const entriesBefore = await storedEntries(fixture);

    const second = await restoreThrough(fixture, 0);

    expect(second.reset).toEqual({ kind: "stale", generation: 1 });
    expect(await storedGeneration(fixture)).toBe(1);
    const rowAfter = await baseRow(fixture.projectId);
    expect(rowAfter?.yjs_write).toBe(rowBefore?.yjs_write);
    expect(rowAfter?.yjs_generation).toBe(rowBefore?.yjs_generation);
    expect(rowAfter?.yjs_seq).toBe(rowBefore?.yjs_seq);
    expect(bytesOf(rowAfter?.yjs_state)).toEqual(bytesOf(rowBefore?.yjs_state));
    expect(await storedKeys(fixture)).toEqual(keysBefore);
    expect(await storedEntries(fixture)).toEqual(entriesBefore);
  }, 20_000);

  it("refuses a config repair, resets nothing, and the marker survives", async () => {
    const fixture = await seedProject("helper-halted");
    const stub = trackedStub(fixture.projectId);
    await plant(stub, encodeHalt(0, "fence_refused"));
    const { paths, env: counted } = countingEnv(fixture.projectId);

    const result = await repairConfigThroughDocument(counted as never, fixture.projectId, {
      google_sheets_enabled: false,
    });

    // Refused, not uncertain: a halted document persists nothing, so the
    // caller's D1 write is what sticks. The repair went to the ingest alone.
    expect(result).toBe("refused");
    expect(paths).toEqual(["/ingest-sync"]);
    expect(await storedGeneration(fixture)).toBeUndefined();
    const marker = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ reason: string }>(haltKey(0)),
    );
    expect(marker).toMatchObject({ reason: "fence_refused" });
  }, 20_000);
});
