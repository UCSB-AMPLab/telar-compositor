/**
 * The log write against the real class, real D1 and real workerd: what an
 * eviction leaves behind after a message, and what the next instance serves
 * from it.
 *
 * The unit project proves the branching and the ordering against scripted
 * storage. This proves the thing that harness cannot: that an object evicted
 * between a committed INSERT and the blob write comes back holding the row it
 * inserted, on every table that has one.
 *
 * Instrumentation does not survive an eviction, so a wrapper installed before
 * one is gone after it and is reinstalled on the instance that has to be
 * observed. The halt after a failed group is not reachable here — nothing can
 * make workerd's `put` throw without a seam on the platform — and is covered in
 * `tests/persistence-halt.test.ts`.
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
import { MAX_RECORD_BYTES, logKey, logPrefix } from "../../workers/doc-log";
import { hibernate } from "./helpers/hibernate";
import {
  MESSAGE_SYNC,
  drainAcceptanceFrames,
  mintToken,
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
  docLoaded: boolean;
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

/** Cancel whatever alarm the object armed, so no snapshot runs behind a test. */
async function disarm(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
}

/**
 * The blob, the generation and the sequence a row holds, as one comparable
 * value.
 *
 * The revision is left out: a fresh admission claims the row, which moves it
 * legitimately, and an eviction case is about the three that must NOT move
 * until the snapshot it names.
 */
async function baseState(projectId: number) {
  const row = await baseRow(projectId);
  return {
    generation: row!.yjs_generation,
    seq: row!.yjs_seq,
    blob: new Uint8Array(row!.yjs_state as unknown as ArrayLike<number>),
  };
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

function storyTitles(doc: Y.Doc): string[] {
  return doc.getArray<Y.Map<unknown>>("stories").toArray().map((m) => String(m.get("title")));
}

describe("an edit survives an eviction that happens before any blob write", () => {
  it("serves it from the log, and the next snapshot's blob carries it", async () => {
    const fixture = await seedProject("log-edit");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    const state = await drainAcceptanceFrames(socket);

    sendUpdate(socket, state, (doc) => {
      (doc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text).insert(0, "edited ");
    });
    await until(stub, (doc) => storyTitles(doc)[0].startsWith("edited "));
    await disarm(stub);

    // The cold build wrote its initial blob at sequence 0 with logging still
    // suppressed, so the log holds exactly one record: this message's.
    expect(await logKeys(stub)).toEqual([logKey(0, 1)]);
    const before = await baseState(fixture.projectId);
    expect(before.seq).toBe(0);

    // Evicted with the socket retained: closing the last one runs a disconnect
    // snapshot, and the blob it writes is what the replay is meant to supply.
    await hibernate(stub);

    // A fresh admission: base plus log, and nothing asked of any client.
    const readmitted = await openSocket(fixture, "0");
    const served = await drainAcceptanceFrames(readmitted);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, served);
    expect(storyTitles(doc)[0]).toMatch(/^edited /);
    // Recovered from the log: the blob and its sequence stand where the cold
    // build left them.
    expect(await baseState(fixture.projectId)).toEqual(before);

    expect(await forceSnapshot(fixture)).toBe(200);
    const after = await baseRow(fixture.projectId);
    const blob = new Y.Doc();
    Y.applyUpdate(blob, new Uint8Array(after!.yjs_state as unknown as ArrayLike<number>));
    expect(storyTitles(blob)[0]).toMatch(/^edited /);
    expect(after!.yjs_seq).toBeGreaterThan(0);

    readmitted.ws.close();
    try { socket.ws.close(); } catch { /* already closed */ }
  }, 20_000);

  it("serves all of sixty-five edits after an eviction, replaying across pages", async () => {
    const fixture = await seedProject("log-many");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    let state = await drainAcceptanceFrames(socket);

    for (let n = 1; n <= 65; n++) {
      state = sendUpdate(socket, state, (doc) => {
        doc.getArray<Y.Map<unknown>>("stories").get(0).set(`field_${n}`, String(n));
      });
    }
    await until(stub, (doc) =>
      doc.getArray<Y.Map<unknown>>("stories").get(0).get("field_65") === "65");
    await disarm(stub);
    expect(await logKeys(stub)).toHaveLength(65);
    const before = await baseState(fixture.projectId);

    // The socket is kept through the eviction, so no disconnect snapshot writes
    // the blob the replay is meant to supply.
    await hibernate(stub);

    const readmitted = await openSocket(fixture, "0");
    const served = await drainAcceptanceFrames(readmitted);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, served);
    const story = doc.getArray<Y.Map<unknown>>("stories").get(0);
    for (let n = 1; n <= 65; n++) expect(story.get(`field_${n}`)).toBe(String(n));
    expect(await baseState(fixture.projectId)).toEqual(before);

    readmitted.ws.close();
    try { socket.ws.close(); } catch { /* already closed */ }
  }, 30_000);
});

/**
 * A second member of the fixture's project, as a `collaborator`: the role the
 * delete rule applies to, so a story the convenor created is one this socket
 * may not remove.
 */
async function collaboratorMember(fixture: Fixture): Promise<Fixture> {
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

describe("a revert the guard issued is in the log beside what provoked it", () => {
  it("serves the corrected document after an eviction", async () => {
    const fixture = await seedProject("log-revert");
    const stub = trackedStub(fixture.projectId);
    await env.DB.prepare("UPDATE stories SET created_by = ? WHERE project_id = ?")
      .bind(fixture.userId, fixture.projectId)
      .run();
    const collaborator = await collaboratorMember(fixture);
    const socket = await openSocket(collaborator, "new");
    const state = await drainAcceptanceFrames(socket);

    // A deletion the guard refuses: the correction is a transaction of its own,
    // and it is logged in the same group as the payload that provoked it.
    sendUpdate(socket, state, (doc) => {
      doc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    });
    await vi.waitFor(async () => {
      expect((await logKeys(stub)).length).toBeGreaterThan(1);
    }, { timeout: 5000 });
    await disarm(stub);
    expect(storyTitles(await servedDoc(stub))).toEqual([fixture.storyTitle]);
    const before = await baseState(fixture.projectId);

    // The collaborator's socket is kept through the eviction, so the correction
    // is recovered from the log rather than from a disconnect snapshot's blob.
    await hibernate(stub);

    // The replay is origin-less, so it reaches neither the guard nor the
    // accumulator: the corrected document is what the log alone reconstructs.
    const readmitted = await openSocket(fixture, "0");
    const served = await drainAcceptanceFrames(readmitted);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, served);
    expect(storyTitles(doc)).toEqual([fixture.storyTitle]);
    expect(await baseState(fixture.projectId)).toEqual(before);

    readmitted.ws.close();
    try { socket.ws.close(); } catch { /* already closed */ }
  }, 20_000);
});

describe("an update above the record ceiling is refused by the real class", () => {
  it("closes the socket 1009 and leaves the document unchanged", async () => {
    const fixture = await seedProject("log-oversized");
    const stub = trackedStub(fixture.projectId);
    const socket = await openSocket(fixture, "new");
    await drainAcceptanceFrames(socket);
    const before = storyTitles(await servedDoc(stub));

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, new Uint8Array(MAX_RECORD_BYTES + 1));
    socket.ws.send(encoding.toUint8Array(encoder));

    await vi.waitFor(() => {
      expect(socket.closes.length).toBeGreaterThan(0);
    }, { timeout: 10_000 });
    expect(socket.closes[0]).toEqual({ code: 1009, reason: "Message too big" });
    await disarm(stub);

    // Nothing applied, nothing logged, and no halt: a fresh admission serves
    // exactly what the object served before.
    expect(await logKeys(stub)).toEqual([]);
    // The server issued the close; the client end is closed here so the
    // handshake finishes and the object is left with no socket to evict around.
    try { socket.ws.close(); } catch { /* already closed */ }
    await vi.waitFor(async () => {
      expect(await runInDurableObject(stub, (_i, s) => s.getWebSockets().length)).toBe(0);
    }, { timeout: 5000 });
    await disarm(stub);
    await hibernate(stub);

    const readmitted = await openSocket(fixture, "0");
    const served = await drainAcceptanceFrames(readmitted);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, served);
    expect(storyTitles(doc)).toEqual(before);

    readmitted.ws.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The INSERT window, on each of the six tables
// ---------------------------------------------------------------------------

interface DbWrapper {
  /** Every statement prepared and bound through this wrapper, in order. */
  issued: Array<{ sql: string; args: unknown[] }>;
  /** How many statements matching `count` executed through it. */
  counted: () => number;
}

/**
 * Wrap ONE instance's D1 binding, recording every bound statement and
 * optionally throwing once before a chosen one executes.
 *
 * The binding belongs to the instance, never to the shared environment, so
 * nothing another test in this isolate can reach is touched — and it does not
 * survive an eviction, which is why it is installed again on the instance that
 * has to be observed after one.
 */
async function wrapInstanceDb(
  stub: DurableObjectStub,
  options: { throwOnce?: RegExp; count?: RegExp } = {},
): Promise<DbWrapper> {
  const issued: Array<{ sql: string; args: unknown[] }> = [];
  const state = { armed: options.throwOnce !== undefined, counted: 0 };
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals;
    const inner = internals.env.DB;
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
              issued.push({ sql, args });
              const bound = target.bind(...args);
              return new Proxy(bound, {
                get(boundTarget, boundProp) {
                  if (boundProp === "run") {
                    return async () => {
                      if (options.count?.test(sql)) state.counted += 1;
                      if (options.throwOnce?.test(sql) && state.armed) {
                        state.armed = false;
                        throw new Error("D1_ERROR: blob write refused (test seam)");
                      }
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
        return inner.batch(statements as never);
      },
    };
    internals.env = { ...internals.env, DB: wrapper as unknown as D1Database };
  });
  return { issued, counted: () => state.counted };
}

/** One table's window: how the entity is made, and how D1 is asked about it. */
interface WindowCase {
  label: string;
  table: string;
  /** Anything that must already exist in D1 before the window opens. */
  prepare?: (socket: Socket, state: Uint8Array) => Uint8Array;
  create: (doc: Y.Doc) => void;
  /** Whether the served document holds the entity, by its human key. */
  holds: (doc: Y.Doc) => boolean;
  /** The `_id` the served document carries for it, or undefined. */
  servedId: (doc: Y.Doc) => number | undefined;
  /** The rows D1 holds for it. */
  rows: (projectId: number) => Promise<Array<{ id: number }>>;
}

const KEY = "windowed";

function firstStory(doc: Y.Doc): Y.Map<unknown> {
  return doc.getArray<Y.Map<unknown>>("stories").get(0);
}

function nestedArray(map: Y.Map<unknown>, key: string): Y.Array<Y.Map<unknown>> {
  const existing = map.get(key);
  if (existing instanceof Y.Array) return existing as Y.Array<Y.Map<unknown>>;
  const created = new Y.Array<Y.Map<unknown>>();
  map.set(key, created);
  return created;
}

function entityMap(entries: Record<string, unknown>): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(entries)) map.set(key, value);
  return map;
}

async function rowsBy(sql: string, ...binds: unknown[]): Promise<Array<{ id: number }>> {
  const answer = await env.DB.prepare(sql).bind(...binds).all<{ id: number }>();
  return answer.results;
}

const WINDOWS: WindowCase[] = [
  {
    label: "stories",
    table: "stories",
    create: (doc) => {
      doc.getArray<Y.Map<unknown>>("stories").push([
        entityMap({ story_id: KEY, title: new Y.Text("Windowed"), order_key: "z0" }),
      ]);
    },
    holds: (doc) => doc.getArray<Y.Map<unknown>>("stories").toArray()
      .some((m) => m.get("story_id") === KEY),
    servedId: (doc) => doc.getArray<Y.Map<unknown>>("stories").toArray()
      .find((m) => m.get("story_id") === KEY)?.get("_id") as number | undefined,
    rows: (projectId) =>
      rowsBy("SELECT id FROM stories WHERE project_id = ? AND story_id = ?", projectId, KEY),
  },
  {
    label: "objects",
    table: "objects",
    create: (doc) => {
      doc.getArray<Y.Map<unknown>>("objects").push([
        entityMap({ object_id: KEY, title: new Y.Text("Windowed"), order_key: "z0" }),
      ]);
    },
    holds: (doc) => doc.getArray<Y.Map<unknown>>("objects").toArray()
      .some((m) => m.get("object_id") === KEY),
    servedId: (doc) => doc.getArray<Y.Map<unknown>>("objects").toArray()
      .find((m) => m.get("object_id") === KEY)?.get("_id") as number | undefined,
    rows: (projectId) =>
      rowsBy("SELECT id FROM objects WHERE project_id = ? AND object_id = ?", projectId, KEY),
  },
  {
    label: "glossary terms",
    table: "glossary_terms",
    create: (doc) => {
      doc.getArray<Y.Map<unknown>>("glossary").push([
        entityMap({ term_id: KEY, term: new Y.Text("Windowed"), order_key: "z0" }),
      ]);
    },
    holds: (doc) => doc.getArray<Y.Map<unknown>>("glossary").toArray()
      .some((m) => m.get("term_id") === KEY),
    servedId: (doc) => doc.getArray<Y.Map<unknown>>("glossary").toArray()
      .find((m) => m.get("term_id") === KEY)?.get("_id") as number | undefined,
    rows: (projectId) =>
      rowsBy("SELECT id FROM glossary_terms WHERE project_id = ? AND term_id = ?", projectId, KEY),
  },
  {
    label: "pages",
    table: "project_pages",
    create: (doc) => {
      doc.getArray<Y.Map<unknown>>("pages").push([
        entityMap({ slug: KEY, title: new Y.Text("Windowed"), order_key: "z0" }),
      ]);
    },
    holds: (doc) => doc.getArray<Y.Map<unknown>>("pages").toArray()
      .some((m) => m.get("slug") === KEY),
    servedId: (doc) => doc.getArray<Y.Map<unknown>>("pages").toArray()
      .find((m) => m.get("slug") === KEY)?.get("_id") as number | undefined,
    rows: (projectId) =>
      rowsBy("SELECT id FROM project_pages WHERE project_id = ? AND slug = ?", projectId, KEY),
  },
  {
    label: "steps",
    table: "steps",
    create: (doc) => {
      nestedArray(firstStory(doc), "steps").push([
        entityMap({ kind: "media", order_key: "z0", question: new Y.Text(KEY) }),
      ]);
    },
    holds: (doc) => nestedArray(firstStory(doc), "steps").length > 0,
    servedId: (doc) => nestedArray(firstStory(doc), "steps").get(0)?.get("_id") as
      number | undefined,
    rows: (projectId) => rowsBy(
      "SELECT s.id FROM steps s JOIN stories t ON s.story_id = t.id WHERE t.project_id = ?",
      projectId,
    ),
  },
  {
    label: "layers",
    table: "layers",
    // The step is persisted by a snapshot of its own, so the window below is
    // about the layer alone.
    prepare: (socket, state) => sendUpdate(socket, state, (doc) => {
      nestedArray(firstStory(doc), "steps").push([
        entityMap({ kind: "media", order_key: "y0" }),
      ]);
    }),
    create: (doc) => {
      nestedArray(nestedArray(firstStory(doc), "steps").get(0), "layers").push([
        entityMap({ order_key: "z0", title: new Y.Text(KEY) }),
      ]);
    },
    holds: (doc) =>
      nestedArray(nestedArray(firstStory(doc), "steps").get(0), "layers").length > 0,
    servedId: (doc) =>
      nestedArray(nestedArray(firstStory(doc), "steps").get(0), "layers").get(0)?.get("_id") as
        number | undefined,
    rows: (projectId) => rowsBy(
      "SELECT l.id FROM layers l JOIN steps s ON l.step_id = s.id " +
      "JOIN stories t ON s.story_id = t.id WHERE t.project_id = ?",
      projectId,
    ),
  },
];

describe("the INSERT window closes on every table", () => {
  it.each(WINDOWS.map((w) => [w.label, w] as const))(
    "serves the committed row id for %s after an eviction, and inserts it once",
    async (_label, windowCase) => {
      const fixture = await seedProject(`window-${windowCase.table}`);
      const stub = trackedStub(fixture.projectId);
      const socket = await openSocket(fixture, "new");
      let state = await drainAcceptanceFrames(socket);

      if (windowCase.prepare) {
        state = windowCase.prepare(socket, state);
        await until(stub, (doc) => nestedArray(firstStory(doc), "steps").length > 0);
        expect(await forceSnapshot(fixture)).toBe(200);
      }

      state = sendUpdate(socket, state, windowCase.create);
      await until(stub, windowCase.holds);
      await disarm(stub);

      // The blob write is made to throw ONCE, before it executes: the INSERT
      // landed and its backfill ran, the blob did not, and the row is unmoved,
      // so the failure is retryable and marker-less.
      const failing = await wrapInstanceDb(stub, {
        throwOnce: /^UPDATE projects SET yjs_state/,
      });
      expect(await forceSnapshot(fixture)).toBe(500);
      expect(failing.issued.some((s) => new RegExp(`^INSERT INTO ${windowCase.table} `)
        .test(s.sql))).toBe(true);
      await disarm(stub);

      const committed = await windowCase.rows(fixture.projectId);
      expect(committed).toHaveLength(1);
      const rowAfterFailure = await baseRow(fixture.projectId);

      // Evicted with the socket retained: closing the last one would run
      // another snapshot, which is the write this window is about.
      await hibernate(stub);

      const readmitted = await openSocket(fixture, "0");
      const served = await drainAcceptanceFrames(readmitted);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, served);
      expect(windowCase.holds(doc)).toBe(true);
      // The INSERT's ACTUAL row id, recovered from the log rather than minted
      // again.
      expect(windowCase.servedId(doc)).toBe(committed[0].id);

      // The blob, the generation and the sequence stand where the failed
      // snapshot left them; only the revision moved, which the fresh
      // admission's claim legitimately does.
      const rowBeforeRetry = await baseRow(fixture.projectId);
      expect(rowBeforeRetry!.yjs_generation).toBe(rowAfterFailure!.yjs_generation);
      expect(rowBeforeRetry!.yjs_seq).toBe(rowAfterFailure!.yjs_seq);
      expect(new Uint8Array(rowBeforeRetry!.yjs_state as unknown as ArrayLike<number>))
        .toEqual(new Uint8Array(rowAfterFailure!.yjs_state as unknown as ArrayLike<number>));

      // The wrapper is installed again, because the eviction lost the first one.
      const counting = await wrapInstanceDb(stub, {
        count: new RegExp(`^INSERT INTO ${windowCase.table} `),
      });
      expect(await forceSnapshot(fixture)).toBe(200);

      // The snapshot ran through this wrapper, and attempted no second INSERT.
      expect(counting.issued.some((s) => /^UPDATE projects SET yjs_state/.test(s.sql))).toBe(true);
      expect(counting.counted()).toBe(0);
      // No sweep aimed at the entity either: every DELETE the batch carried is
      // asserted against the id D1 holds.
      const sweptIds = counting.issued
        .filter((s) => /^DELETE FROM /.test(s.sql))
        .flatMap((s) => s.args);
      expect(sweptIds).not.toContain(committed[0].id);
      expect(await windowCase.rows(fixture.projectId)).toEqual(committed);

      readmitted.ws.close();
      try { socket.ws.close(); } catch { /* already closed */ }
    },
    30_000,
  );
});
