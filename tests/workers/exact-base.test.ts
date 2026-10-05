/**
 * The exact base and the write fence against the real class, real D1 and real
 * workerd — the only harness where the migration's triggers, D1's transactional
 * batch and a hibernated socket are all the real thing.
 *
 * What it cannot do is run two instances of one object, so every interleaving
 * below is PLANTED or SCRIPTED and labelled as such: a revision moved by hand
 * stands in for a replacement's claim, and a storage wrapper that rejects
 * stands in for the platform refusing an invocation it has replaced.
 *
 * Instrumentation rule: an `env.DB` wrapper belongs to one instance, and a wake
 * with an attached socket loads in the constructor before `runInDurableObject`
 * can install anything. So the statement-counting tests evict WITHOUT an
 * attached socket, install the wrapper on the fresh unloaded instance, and then
 * upgrade; the wake-behaviour tests keep a socket attached and assert on the
 * socket and the row instead.
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
import { hibernate } from "./helpers/hibernate";
import {
  MESSAGE_SYNC,
  attemptUpgrade,
  drainAcceptanceFrames,
  openSocket,
  seedProject,
  stubFor,
  type Fixture,
  type Socket,
} from "./helpers/collaboration-client";

const TEST_SECRET = "test-session-secret";
const UNAVAILABLE = { code: 1013, reason: "Try again later" };

/**
 * Every object a test touched. The class schedules a 30-second alarm the moment
 * an edit lands, and an alarm that keeps firing keeps the runtime busy long
 * after the test that armed it has finished — so each test disarms what it
 * armed, and closes what it left open.
 */
const touched = new Set<DurableObjectStub>();

function trackedStub(projectId: number): DurableObjectStub {
  const stub = stubFor(projectId);
  touched.add(stub);
  return stub;
}

interface Internals {
  docLoaded: boolean;
  docSeq: number | null;
  docWrite: number | null;
  persistenceHalted: { generation: number; marker: { reason: string } } | null;
  ydoc: Y.Doc;
  env: { DB: D1Database };
  ctx: DurableObjectState;
}

interface BaseRow {
  yjs_state: ArrayBuffer | null;
  yjs_generation: number | null;
  yjs_seq: number | null;
  yjs_write: number;
}

async function baseRow(projectId: number): Promise<BaseRow | null> {
  return env.DB.prepare(
    "SELECT yjs_state, yjs_generation, yjs_seq, yjs_write FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<BaseRow>();
}

async function guardRowCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM yjs_write_guard").first<{ n: number }>();
  return Number(row!.n);
}

/** The story title the served document holds, or undefined for an empty one. */
function serverStoryTitle(stub: DurableObjectStub): Promise<string | undefined> {
  return runInDurableObject(stub, (instance) => {
    const stories = (instance as unknown as Internals).ydoc.getArray<Y.Map<unknown>>("stories");
    return stories.length === 0 ? undefined : String(stories.get(0).get("title"));
  });
}

/**
 * The base the row holds is already in the state the object serves.
 *
 * Two cold builds of the same rows differ in client ids, so bytes identify
 * content and never a writer, and the served document is the base plus the
 * load-time repairs — which rules out comparing the two directly. What rules
 * out a load that dropped part of the base is this: re-applying the base to a
 * COPY of the served document changes neither its snapshot nor its pending
 * state. A missing struct or a missing deletion would move one of them; a state
 * vector would notice neither.
 */
async function assertBaseIsServed(stub: DurableObjectStub, projectId: number, title: string) {
  const row = await baseRow(projectId);
  expect(row!.yjs_state).not.toBeNull();
  const storedBytes = new Uint8Array(row!.yjs_state as unknown as ArrayLike<number>);
  const servedBytes = await runInDurableObject(stub, (instance) =>
    Y.encodeStateAsUpdate((instance as unknown as Internals).ydoc),
  );

  const copy = new Y.Doc();
  Y.applyUpdate(copy, servedBytes);
  const before = Y.snapshot(copy);
  Y.applyUpdate(copy, storedBytes);

  expect(Y.equalSnapshots(before, Y.snapshot(copy))).toBe(true);
  expect(copy.store.pendingStructs).toBeNull();
  expect(copy.store.pendingDs).toBeNull();
  expect(await serverStoryTitle(stub)).toBe(title);
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

interface DbHooks {
  /** Runs before a matching statement executes. */
  beforeRun?: (sql: string) => Promise<void> | void;
  /** Runs after it executes, before the caller is told anything. */
  afterRun?: (sql: string) => Promise<void> | void;
  /** Runs before the batch executes. */
  beforeBatch?: () => Promise<void> | void;
  /** Runs after it executes, before the caller is told anything. */
  afterBatch?: () => Promise<void> | void;
  /**
   * Statements spliced into the batch after the entity statements and before
   * the guard delete, so they run inside the same transaction and after the
   * guard, the advance and at least one real entity statement have succeeded.
   */
  appendToBatch?: (db: D1Database) => D1PreparedStatement[];
  /** Which statements the run hooks apply to. */
  match?: RegExp;
}

/** Wrap the instance's D1 binding, which belongs to that instance alone. */
async function installDbWrapper(stub: DurableObjectStub, hooks: DbHooks): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals;
    const inner = internals.env.DB;
    const match = hooks.match ?? /^UPDATE projects SET yjs_state/;
    const wrapper = {
      prepare(sql: string) {
        const stmt = inner.prepare(sql);
        return new Proxy(stmt, {
          get(target, prop, receiver) {
            if (prop === "bind") {
              return (...args: unknown[]) => {
                const bound = target.bind(...args);
                return new Proxy(bound, {
                  get(boundTarget, boundProp) {
                    if (boundProp === "run") {
                      return async () => {
                        if (match.test(sql)) await hooks.beforeRun?.(sql);
                        const result = await boundTarget.run();
                        if (match.test(sql)) await hooks.afterRun?.(sql);
                        return result;
                      };
                    }
                    const value = Reflect.get(boundTarget, boundProp);
                    return typeof value === "function" ? value.bind(boundTarget) : value;
                  },
                });
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      async batch(statements: unknown[]) {
        await hooks.beforeBatch?.();
        const appended = hooks.appendToBatch?.(inner) ?? [];
        // The guard delete is the batch's last statement, and the splice keeps
        // it there: what is added runs after the entity statements and inside
        // the same transaction.
        const sequence = appended.length === 0
          ? statements
          : [...statements.slice(0, -1), ...appended, statements[statements.length - 1]];
        const result = await inner.batch(sequence as never);
        await hooks.afterBatch?.();
        return result;
      },
    };
    internals.env = { ...internals.env, DB: wrapper as unknown as D1Database };
  });
}

/**
 * Make one of the instance's storage reads reject, standing in for the platform
 * refusing an invocation it has replaced — which this harness cannot produce.
 *
 * The rejection is bounded rather than permanent: a permanently broken storage
 * makes the object's own alarm fail and retry forever, which the harness cannot
 * drain. What the rule needs is that the read AFTER re-acquisition's observation
 * fails, and one rejection is that.
 */
async function rejectStorageAfter(
  stub: DurableObjectStub,
  healthyReads: number,
  rejections = 1,
): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals;
    const ctx = internals.ctx;
    const storage = ctx.storage;
    let left = healthyReads;
    let refusals = rejections;
    const storageProxy = new Proxy(storage, {
      get(target, prop) {
        if (prop === "get") {
          return async (...args: unknown[]) => {
            if (left <= 0 && refusals > 0) {
              refusals -= 1;
              throw new Error("Durable Object reset because its code was updated");
            }
            if (left > 0) left -= 1;
            return (target.get as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    internals.ctx = new Proxy(ctx, {
      get(target, prop) {
        if (prop === "storage") return storageProxy;
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DurableObjectState;
  });
}

/**
 * Move the row's revision by hand, by `moves`.
 *
 * This is the stand-in for a replacement's writes, which this harness cannot
 * produce: it cannot run two instances of one object. The tags are left exactly
 * as they were, which is the shape a bare claim leaves.
 *
 * One move is deliberately indistinguishable from this instance's own landed
 * write with its acknowledgement lost — that is the whole reason the rule rests
 * on a storage validation rather than on the row alone, and a resident instance
 * that is still the owner is RIGHT to adopt it. Two moves are a revision none
 * of this instance's own writes could have produced, and are refused.
 */
async function plantReplacementWrites(projectId: number, moves: number): Promise<void> {
  await env.DB.prepare("UPDATE projects SET yjs_write = yjs_write + ? WHERE id = ?")
    .bind(moves, projectId)
    .run();
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

async function post(fixture: Fixture, path: string, action: string): Promise<Response> {
  return trackedStub(fixture.projectId).fetch(await signed(fixture, path, action));
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

async function closedWith(socket: Socket, close: { code: number; reason: string }) {
  await vi.waitFor(() => expect(socket.closes.length).toBeGreaterThan(0), { timeout: 5000 });
  expect(socket.closes[0]).toEqual(close);
}

/**
 * Seed a project whose row already carries an untagged blob, as a row written
 * before either tag column existed does. The blob claims the seeded story row
 * by its own id, so a snapshot taken from it updates that row rather than
 * inserting a second one under the same key.
 */
async function seedUntagged(label: string): Promise<Fixture> {
  const fixture = await seedProject(label);
  const story = await env.DB.prepare("SELECT id FROM stories WHERE project_id = ?")
    .bind(fixture.projectId)
    .first<{ id: number }>();
  const doc = new Y.Doc();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("_id", story!.id);
    map.set("story_id", "s1");
    map.set("title", new Y.Text(fixture.storyTitle));
    map.set("order_key", "a0");
    doc.getArray<Y.Map<unknown>>("stories").push([map]);
  }, null);
  await env.DB.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?")
    .bind(Y.encodeStateAsUpdate(doc), fixture.projectId)
    .run();
  return fixture;
}

const DELETED_TITLE = "Story deleted in the base";

/**
 * Seed a project whose untagged base CONTRADICTS its rows: D1 holds two
 * stories, and the base was written after the second was deleted.
 *
 * A load that applied the base's structs and dropped its delete set would serve
 * a story the base says is gone, while covering exactly the same state vector.
 */
async function seedUntaggedWithDeletion(label: string): Promise<Fixture> {
  const fixture = await seedProject(label);
  await env.DB.prepare("INSERT INTO stories (project_id, story_id, title) VALUES (?, 's2', ?)")
    .bind(fixture.projectId, DELETED_TITLE)
    .run();
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
      map.set("title", new Y.Text(row.story_id === "s1" ? fixture.storyTitle : DELETED_TITLE));
      map.set("order_key", `a${index}`);
      stories.push([map]);
    }
  }, null);
  doc.transact(() => { stories.delete(1, 1); }, null);

  await env.DB.prepare("UPDATE projects SET yjs_state = ? WHERE id = ?")
    .bind(Y.encodeStateAsUpdate(doc), fixture.projectId)
    .run();
  return fixture;
}

// ---------------------------------------------------------------------------
// Claiming the row
// ---------------------------------------------------------------------------

describe("every load that opens claims the row", () => {
  it("serves the base's deletions, so an entity deleted in it is not brought back", async () => {
    const fixture = await seedUntaggedWithDeletion("base-with-deletion");
    const stub = trackedStub(fixture.projectId);

    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket);

    const titles = await runInDurableObject(stub, (instance) =>
      (instance as unknown as Internals).ydoc
        .getArray<Y.Map<unknown>>("stories")
        .toArray()
        .map((story) => String(story.get("title"))),
    );
    expect(titles).toEqual([fixture.storyTitle]);
    await assertBaseIsServed(stub, fixture.projectId, fixture.storyTitle);
    socket.ws.close();
  });

  it("tags an untagged blob at the first load and bare-claims it at the second", async () => {
    const fixture = await seedUntagged("untagged");
    const stub = trackedStub(fixture.projectId);

    const first = await openSocket(fixture, "new");
    await drainAcceptanceFrames(first);
    expect(await baseRow(fixture.projectId)).toMatchObject({
      yjs_generation: 0,
      yjs_seq: 0,
      yjs_write: 1,
    });

    // Evicted WITHOUT a socket, so the next instance is unloaded when the
    // wrapper goes on and the upgrade is what makes it load.
    first.ws.close();
    await vi.waitFor(async () => {
      expect(await runInDurableObject(stub, (_i, state) => state.getWebSockets().length)).toBe(0);
    }, { timeout: 5000 });
    await hibernate(stub);

    const issued: string[] = [];
    await installDbWrapper(stub, {
      match: /^UPDATE projects/,
      beforeRun: (sql) => { issued.push(sql); },
    });
    // The last socket's close snapshots, so the revision the second load finds
    // is whatever that left; what this test counts is the one move the load
    // itself makes.
    const beforeSecondLoad = (await baseRow(fixture.projectId))!.yjs_write;

    const second = await openSocket(fixture, "0");
    await drainAcceptanceFrames(second);

    expect(issued.filter((sql) => /^UPDATE projects SET yjs_write = \?/.test(sql))).toHaveLength(1);
    expect(issued.filter((sql) => /^UPDATE projects SET yjs_generation/.test(sql))).toHaveLength(0);
    expect((await baseRow(fixture.projectId))!.yjs_write).toBe(beforeSecondLoad + 1);
    await assertBaseIsServed(stub, fixture.projectId, fixture.storyTitle);
    second.ws.close();
  });

  it("gives a project with no blob a tagged one at its first upgrade", async () => {
    const fixture = await seedProject("cold");
    const stub = trackedStub(fixture.projectId);

    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket);

    expect(await baseRow(fixture.projectId)).toMatchObject({
      yjs_generation: 0,
      yjs_seq: 0,
      yjs_write: 1,
    });
    await assertBaseIsServed(stub, fixture.projectId, fixture.storyTitle);
    socket.ws.close();
  });

  it("refuses a statement from before the fence on the enrolled row, and lands it on a virgin one", async () => {
    const claimed = await seedProject("enrolled");
    const virgin = await seedProject("virgin");
    const socket = await openSocket(claimed, "new");
    await drainAcceptanceFrames(socket);

    await expect(
      env.DB.prepare("UPDATE projects SET yjs_state = ?, updated_at = ? WHERE id = ?")
        .bind(new Uint8Array([1, 2, 3]), new Date().toISOString(), claimed.projectId)
        .run(),
    ).rejects.toThrow(/yjs_fence/);

    const landed = await env.DB.prepare(
      "UPDATE projects SET yjs_state = ?, updated_at = ? WHERE id = ?",
    )
      .bind(new Uint8Array([1, 2, 3]), new Date().toISOString(), virgin.projectId)
      .run();
    expect(landed.meta.changes).toBe(1);
    socket.ws.close();
  });
});

// ---------------------------------------------------------------------------
// The fenced snapshot
// ---------------------------------------------------------------------------

/** Open a project through an admitted socket, and hand back what it needs. */
async function editedProject(label: string) {
  const fixture = await seedProject(label);
  const stub = trackedStub(fixture.projectId);
  const socket = await openSocket(fixture, "new");
  const state = await drainAcceptanceFrames(socket);
  return { fixture, stub, socket, state };
}

/**
 * Write prose into the story's title through the socket, and wait until the
 * served document holds it.
 *
 * The ledgers a snapshot settles are filled by real edits arriving on an
 * authenticated socket — words against the story's row, editing and writing
 * time for their author. Planted ledgers would prove nothing about what the
 * batch takes down.
 */
async function typeIntoStory(
  socket: Socket,
  state: Uint8Array,
  stub: DurableObjectStub,
  text: string,
): Promise<void> {
  const client = new Y.Doc();
  Y.applyUpdate(client, state);
  const before = Y.encodeStateVector(client);
  const story = client.getArray<Y.Map<unknown>>("stories").get(0);
  (story.get("title") as Y.Text).insert(0, text);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(client, before));
  socket.ws.send(encoding.toUint8Array(encoder));

  await vi.waitFor(async () => {
    expect(await serverStoryTitle(stub)).toContain(text.trim());
  }, { timeout: 5000 });
}

interface LedgerRows {
  contributors: Array<{ words_written: number | null }>;
  time: Array<{ editing_seconds: number }>;
}

/** The two ledger tables a settled batch writes, for the fixture's own editor. */
async function ledgerRows(fixture: Fixture): Promise<LedgerRows> {
  const contributors = await env.DB.prepare(
    "SELECT words_written FROM entity_contributors WHERE project_id = ? AND user_id = ?",
  )
    .bind(fixture.projectId, fixture.userId)
    .all<{ words_written: number | null }>();
  const time = await env.DB.prepare(
    "SELECT editing_seconds FROM member_editing_time WHERE project_id = ? AND user_id = ?",
  )
    .bind(fixture.projectId, fixture.userId)
    .all<{ editing_seconds: number }>();
  return { contributors: contributors.results, time: time.results };
}

describe("the snapshot moves the revision twice, and the batch is guarded", () => {
  it("writes the blob, then the guarded batch, leaving the guard table empty", async () => {
    const { fixture, stub, socket } = await editedProject("snapshot-twice");
    const before = (await baseRow(fixture.projectId))!.yjs_write;

    const response = await post(fixture, "/snapshot", "snapshot");
    expect(response.status).toBe(200);

    const after = await baseRow(fixture.projectId);
    expect(after!.yjs_write).toBe(before + 2);
    expect(await guardRowCount()).toBe(0);
    const stories = await env.DB.prepare("SELECT title FROM stories WHERE project_id = ?")
      .bind(fixture.projectId)
      .all<{ title: string }>();
    expect(stories.results.map((r) => r.title)).toEqual([fixture.storyTitle]);
    await assertBaseIsServed(stub, fixture.projectId, fixture.storyTitle);
    socket.ws.close();
  });

  it("rolls the batch back whole when the row moves between the blob write and it", async () => {
    const { fixture, stub, socket } = await editedProject("batch-race");
    await env.DB.prepare("UPDATE stories SET title = 'regressed' WHERE project_id = ?")
      .bind(fixture.projectId)
      .run();

    // Between the blob write and the batch, the row moves to exactly the
    // revision the batch expects plus one, with the tags unchanged: the shape
    // of a replacement's claim.
    await installDbWrapper(stub, {
      match: /^UPDATE projects SET yjs_state/,
      afterRun: () => plantReplacementWrites(fixture.projectId, 1),
    });
    // The storage access after re-acquisition's read rejects, so this instance
    // stops without adopting: the load already paid for one read.
    await rejectStorageAfter(stub, 1);

    const response = await post(fixture, "/snapshot", "snapshot");
    expect(response.status).toBe(500);

    const stories = await env.DB.prepare("SELECT title FROM stories WHERE project_id = ?")
      .bind(fixture.projectId)
      .all<{ title: string }>();
    expect(stories.results.map((r) => r.title)).toEqual(["regressed"]);
    expect(await guardRowCount()).toBe(0);
    expect(
      await runInDurableObject(
        stub,
        (i) => (i as unknown as Internals).persistenceHalted !== null,
      ),
    ).toBe(false);
    socket.ws.close();
  });

  it("rolls a batch back whole when a later statement in it fails", async () => {
    const { fixture, stub, socket } = await editedProject("batch-late-failure");
    // What the batch's own entity UPDATE would put back, so a batch that
    // half-applied would be visible here as the fixture's title.
    await env.DB.prepare("UPDATE stories SET title = 'regressed' WHERE project_id = ?")
      .bind(fixture.projectId)
      .run();

    await installDbWrapper(stub, {
      // A constraint the real schema refuses, spliced in after the guard, the
      // advance and the entity statements have all run: the UNIQUE index on
      // (project_id, story_id) admits one row per key, and this is a second.
      appendToBatch: (db) => [
        db
          .prepare("INSERT INTO stories (project_id, story_id, title) VALUES (?, 's1', ?)")
          .bind(fixture.projectId, "a second row under the same key"),
      ],
    });

    const beforeSnapshot = (await baseRow(fixture.projectId))!.yjs_write;
    const response = await post(fixture, "/snapshot", "snapshot");
    expect(response.status).toBe(500);

    const after = await baseRow(fixture.projectId);
    // The blob write's revision, and no advance from the batch: the guard's own
    // advance commits only with the statements it protects.
    expect(after!.yjs_write).toBe(beforeSnapshot + 1);
    const stories = await env.DB.prepare(
      "SELECT title FROM stories WHERE project_id = ? ORDER BY id",
    )
      .bind(fixture.projectId)
      .all<{ title: string }>();
    expect(stories.results.map((r) => r.title)).toEqual(["regressed"]);
    expect(await guardRowCount()).toBe(0);
    expect(
      await runInDurableObject(
        stub,
        (i) => (i as unknown as Internals).persistenceHalted !== null,
      ),
    ).toBe(false);
    socket.ws.close();
  });

  it("refuses the fence when the project row is deleted before the batch", async () => {
    const { fixture, stub, socket } = await editedProject("row-deleted");

    await installDbWrapper(stub, {
      match: /^UPDATE projects SET yjs_state/,
      afterRun: async () => {
        await env.DB.prepare("DELETE FROM activity_log WHERE project_id = ?").bind(fixture.projectId).run();
        await env.DB.prepare("DELETE FROM project_members WHERE project_id = ?").bind(fixture.projectId).run();
        await env.DB.prepare("DELETE FROM steps WHERE story_id IN (SELECT id FROM stories WHERE project_id = ?)")
          .bind(fixture.projectId).run();
        await env.DB.prepare("DELETE FROM stories WHERE project_id = ?").bind(fixture.projectId).run();
        await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(fixture.projectId).run();
      },
    });

    await post(fixture, "/snapshot", "snapshot");

    expect(
      await runInDurableObject(
        stub,
        (i) => (i as unknown as Internals).persistenceHalted !== null,
      ),
    ).toBe(true);
    expect(await guardRowCount()).toBe(0);
    await closedWith(socket, UNAVAILABLE);
  });

  it("adopts a blob write whose acknowledgement was lost, and completes the batch", async () => {
    const { fixture, stub, socket } = await editedProject("lost-ack");
    const before = (await baseRow(fixture.projectId))!.yjs_write;

    await installDbWrapper(stub, {
      match: /^UPDATE projects SET yjs_state/,
      afterRun: () => { throw new Error("D1_ERROR: acknowledgement lost"); },
    });

    const response = await post(fixture, "/snapshot", "snapshot");
    expect(response.status).toBe(200);

    expect((await baseRow(fixture.projectId))!.yjs_write).toBe(before + 2);
    expect(await guardRowCount()).toBe(0);
    const stories = await env.DB.prepare("SELECT title FROM stories WHERE project_id = ?")
      .bind(fixture.projectId)
      .all<{ title: string }>();
    expect(stories.results.map((r) => r.title)).toEqual([fixture.storyTitle]);
    socket.ws.close();
  });

  it("adopts a batch whose acknowledgement was lost, settling the ledgers once", async () => {
    const { fixture, stub, socket, state } = await editedProject("lost-batch-ack");
    await typeIntoStory(socket, state, stub, "several fresh words typed here ");
    const before = (await baseRow(fixture.projectId))!.yjs_write;

    let batches = 0;
    await installDbWrapper(stub, {
      afterBatch: () => {
        if (++batches === 1) throw new Error("D1_ERROR: acknowledgement lost");
      },
    });

    const response = await post(fixture, "/snapshot", "snapshot");
    expect(response.status).toBe(200);

    expect((await baseRow(fixture.projectId))!.yjs_write).toBe(before + 2);
    expect(await guardRowCount()).toBe(0);

    // The words and the time the edit earned are in D1 exactly once each.
    const settled = await ledgerRows(fixture);
    expect(settled.contributors).toHaveLength(1);
    expect(settled.contributors[0].words_written).toBeGreaterThan(0);
    expect(settled.time).toHaveLength(1);
    expect(settled.time[0].editing_seconds).toBeGreaterThan(0);

    // ONCE, not twice: both columns accumulate, so a credit the adoption
    // settled a second time would show up as a second helping here.
    expect((await post(fixture, "/snapshot", "snapshot")).status).toBe(200);
    expect(await ledgerRows(fixture)).toEqual(settled);
    socket.ws.close();
  });
});

// ---------------------------------------------------------------------------
// The refusal, and the reset that recovers it
// ---------------------------------------------------------------------------

describe("a row moved under a resident instance ends in a refusal a reset recovers", () => {
  it("closes the socket, refuses the upgrade, names the halt, and is recovered by /reset", async () => {
    const { fixture, stub, socket } = await editedProject("fence-recovery");

    // The stand-in for a replacement that claimed the row and wrote its own
    // base: two moves, which no write of this instance's own could have made.
    // Its blob write then lands zero rows and cannot be reconciled.
    await plantReplacementWrites(fixture.projectId, 2);

    const refused = await post(fixture, "/snapshot", "snapshot");
    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("persistence_halted");
    expect(
      await runInDurableObject(
        stub,
        (i) => (i as unknown as Internals).persistenceHalted !== null,
      ),
    ).toBe(true);
    await closedWith(socket, UNAVAILABLE);

    expect((await attemptUpgrade(fixture, "0")).status).toBe(503);

    const beforeReset = await baseRow(fixture.projectId);
    expect((await post(fixture, "/reset", "reset")).status).toBe(200);
    const afterReset = await baseRow(fixture.projectId);
    expect(afterReset!.yjs_state).not.toBeNull();
    expect(afterReset!.yjs_generation).toBe(1);
    expect(afterReset!.yjs_seq).toBe(0);
    expect(afterReset!.yjs_write).toBeGreaterThan(beforeReset!.yjs_write);

    const readmitted = await openSocket(fixture, "new");
    await drainAcceptanceFrames(readmitted, 1);
    readmitted.ws.close();
  });

  it("leaves a non-null base at every point a reset passes through", async () => {
    const fixture = await seedProject("reset-no-null");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket);

    const observed: Array<ArrayBuffer | null> = [];
    await installDbWrapper(stub, {
      match: /^UPDATE projects/,
      beforeRun: async () => { observed.push((await baseRow(fixture.projectId))!.yjs_state); },
      afterRun: async () => { observed.push((await baseRow(fixture.projectId))!.yjs_state); },
    });

    expect((await post(fixture, "/reset", "reset")).status).toBe(200);

    // The row goes straight from one tagged base to the next, so no writer from
    // before the fence ever meets a NULL blob it could claim.
    expect(observed.every((blob) => blob !== null)).toBe(true);
    expect(await baseRow(fixture.projectId)).toMatchObject({ yjs_generation: 1, yjs_seq: 0 });
  });
});

describe("a base the loader cannot prove exact closes its editors and waits for a reset", () => {
  it.each([
    ["a higher generation tag", 5],
    ["a lower generation tag", 0],
  ])("halts on %s and is recovered by /reset", async (_label, plantedGeneration) => {
    const fixture = await seedProject(`mismatch-${plantedGeneration}`);
    const stub = trackedStub(fixture.projectId);
    // The generation is set before anything is admitted, so the socket below is
    // admitted UNDER it: what closes that socket has to be the load refusing
    // the base, not the attachment fence of the socket generation.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("docGeneration", 2);
    });
    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket, 2);

    // The row's tag is moved to another lineage, as a hand repair: it moves the
    // revision too, which is what the fence trigger requires of any write that
    // touches the tags. The move stands in for a replacement's claim.
    await env.DB.prepare(
      "UPDATE projects SET yjs_generation = ?, yjs_write = yjs_write + 1 WHERE id = ?",
    )
      .bind(plantedGeneration, fixture.projectId)
      .run();
    await hibernate(stub);

    // The wake loads, cannot prove the base exact, and closes the socket.
    await attemptUpgrade(fixture, "2");
    await closedWith(socket, UNAVAILABLE);
    expect((await attemptUpgrade(fixture, "2")).status).toBe(503);

    expect((await post(fixture, "/reset", "reset")).status).toBe(200);
    expect(await baseRow(fixture.projectId)).toMatchObject({ yjs_generation: 3, yjs_seq: 0 });

    const readmitted = await openSocket(fixture, "new");
    await drainAcceptanceFrames(readmitted, 3);
    readmitted.ws.close();
  });

  it("halts on an untagged base met under a log, and loads once /reset moves past it", async () => {
    const fixture = await seedUntagged("untagged-under-log");
    const stub = trackedStub(fixture.projectId);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("log:0:000000000000001", { v: 1 });
    });

    expect((await attemptUpgrade(fixture, "new")).status).toBe(503);

    // The reset advances the generation past the planted key, so the log the
    // loader looks for is the new generation's, which is empty.
    expect((await post(fixture, "/reset", "reset")).status).toBe(200);
    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket, 1);
    socket.ws.close();
  });
});
