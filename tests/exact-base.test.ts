/**
 * The base is exact, and the loader can tell.
 *
 * Every load reads the row, proves this invocation still owns the object with a
 * fresh storage access, and claims the row by moving its revision; every write
 * afterwards is conditioned on that revision and moves it; and a write whose
 * outcome cannot be reconciled with the row puts the instance into a terminal
 * refusal that closes its sockets and admits nobody until a reset lands.
 *
 * The fake context here proves the object's BRANCHING on scripted statement
 * results, its logging and its socket behaviour. It proves nothing about SQL:
 * that is `tests/yjs-write-fence.test.ts`, against real SQLite, and
 * `tests/workers/exact-base.test.ts`, against workerd. Claims below are counted
 * — statements issued, rows affected, log lines, closes — never inferred from
 * `updated_at`.
 *
 * Where a test says "the bytes written are the state served" it applies the
 * bound bytes into a fresh document and compares snapshots, and checks nothing
 * is pending on either side. That pending check is a property of these
 * round-trip fixtures, not a rule about documents in general.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";

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

import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import {
  ExactBaseError,
  FenceRefusedError,
  MAX_RECORD_BYTES,
  MAX_SEQ,
  baseKey,
  encodeBase,
} from "../workers/doc-log";
import { plantHalt } from "./helpers/halted-document";
import { checkD1Bind } from "./helpers/d1-memory";
import type { TimeLedger, WordsByRow } from "../workers/contribution-metrics";

const PROJECT_ID = 42;
const USER_ID = 7;
const TEST_SECRET = "test-session-secret";
const H = Number.MAX_SAFE_INTEGER;
const UNAVAILABLE = { code: 1013, reason: "Try again later" };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A document holding one story, encoded as a base would be. */
function storyBlob(title: string): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("_id", 11);
    story.set("story_id", "s1");
    story.set("title", new Y.Text(title));
    story.set("order_key", "a0");
    doc.getArray<Y.Map<unknown>>("stories").push([story]);
  }, null);
  return Y.encodeStateAsUpdate(doc);
}

const BASE_A = storyBlob("Story A");
const BASE_B = storyBlob("Story B");

const DELETED_TITLE = "Story deleted in the base";

/**
 * A base carrying a DELETION: two stories were written and the second removed,
 * so the bytes hold a delete set as well as a state vector.
 *
 * A load that applied the structs and dropped the delete set would satisfy every
 * state-vector comparison and still serve an entity the base says is gone, which
 * is why the identity check below compares snapshots rather than vectors.
 */
function deletionBlob(): Uint8Array {
  const doc = new Y.Doc();
  const stories = doc.getArray<Y.Map<unknown>>("stories");
  doc.transact(() => {
    for (const [id, key, title] of [
      [11, "s1", "Story A"],
      [12, "s2", DELETED_TITLE],
    ] as const) {
      const story = new Y.Map<unknown>();
      story.set("_id", id);
      story.set("story_id", key);
      story.set("title", new Y.Text(title));
      story.set("order_key", "a0");
      stories.push([story]);
    }
  }, null);
  doc.transact(() => { stories.delete(1, 1); }, null);
  return Y.encodeStateAsUpdate(doc);
}

const BASE_WITH_DELETION = deletionBlob();

/**
 * The identity rule: the bound bytes and the served document are the same
 * state. Two cold builds of the same rows differ in client ids, so state
 * vectors cannot compare them and bytes identify content, never a writer.
 */
function assertSameState(bound: unknown, served: Y.Doc): void {
  expect(bound).toBeInstanceOf(Uint8Array);
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, bound as Uint8Array);
  expect(Y.equalSnapshots(Y.snapshot(fresh), Y.snapshot(served))).toBe(true);
  expect(fresh.store.pendingStructs).toBeNull();
  expect(fresh.store.pendingDs).toBeNull();
  expect(served.store.pendingStructs).toBeNull();
  expect(served.store.pendingDs).toBeNull();
}

/**
 * Record the document at the one point where it must be the base and nothing
 * else: after the base is applied and before the load-time repairs, which are
 * real changes — `backfillBlobGaps` seeds the config keys an older blob lacks —
 * and so cannot be included in an identity check.
 *
 * The hook goes on `backfillBlobGaps`, the first thing `openStoredBase` runs
 * after `Y.applyUpdate`, and reads `internals.ydoc` at call time so a document
 * replaced by a contention retry is the one recorded.
 */
function captureAppliedBase(internals: Internals): { snapshot: Y.Snapshot | null } {
  const captured: { snapshot: Y.Snapshot | null } = { snapshot: null };
  const hooked = internals as unknown as { backfillBlobGaps: () => Promise<void> };
  const original = hooked.backfillBlobGaps;
  hooked.backfillBlobGaps = async function (this: unknown) {
    captured.snapshot = Y.snapshot(internals.ydoc);
    return original.call(this);
  };
  return captured;
}

/**
 * The base was applied exactly, DELETE SET included.
 *
 * A state-vector comparison cannot say this: a document that took the base's
 * structs and dropped its deletions covers the same vector while serving
 * entities the base says are gone. Snapshot equality carries both.
 */
function assertBaseApplied(captured: { snapshot: Y.Snapshot | null }, base: Uint8Array): void {
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, base);
  expect(captured.snapshot).not.toBeNull();
  expect(Y.equalSnapshots(captured.snapshot as Y.Snapshot, Y.snapshot(fresh))).toBe(true);
  expect(fresh.store.pendingStructs).toBeNull();
  expect(fresh.store.pendingDs).toBeNull();
}

/** What the load-time repairs are expected to leave on top of the base. */
function assertRepairsRan(served: Y.Doc, title: string): void {
  expect(storyTitle(served)).toBe(title);
  // `backfillBlobGaps` seeds the config keys an older blob never carried, which
  // is what makes the served document more than the base.
  expect(served.getMap("config").has("collection_mode")).toBe(true);
  expect(served.store.pendingStructs).toBeNull();
  expect(served.store.pendingDs).toBeNull();
}

// ---------------------------------------------------------------------------
// The fake context
// ---------------------------------------------------------------------------

interface BaseRowShape {
  yjs_state: Uint8Array | null;
  yjs_generation: number | null | unknown;
  yjs_seq: number | null | unknown;
  yjs_write: number | unknown;
}

/** A tagged base at `(generation, seq)` on a row at `revision`. */
function tagged(
  blob: Uint8Array,
  generation: number,
  seq: number,
  revision: number,
): BaseRowShape {
  return { yjs_state: blob, yjs_generation: generation, yjs_seq: seq, yjs_write: revision };
}

/** An untagged blob no instance has claimed. */
function untagged(blob: Uint8Array, revision = 0): BaseRowShape {
  return { yjs_state: blob, yjs_generation: null, yjs_seq: null, yjs_write: revision };
}

/** A row with no blob and no tags: the cold build. */
function cold(revision = 0): BaseRowShape {
  return { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: revision };
}

interface Issued {
  sql: string;
  binds: unknown[];
}

type RunOutcome = { changes: number } | { throws: unknown } | { hold: Promise<void> };

interface DbScript {
  /** Answers to the loader's row read, in order; the last repeats. */
  base?: Array<BaseRowShape | null | { throws: unknown }>;
  /** Answers to re-acquisition's read, in order; the last repeats. */
  reacquire?: Array<BaseRowShape | null | { throws: unknown }>;
  /** What each conditioned write does, decided from its SQL and call count. */
  run?: (sql: string, binds: unknown[], nth: number) => RunOutcome | undefined;
  /** What `batch` does; returning nothing means it succeeded. */
  batch?: (statements: Issued[], nth: number) => void;
  /** Rows `buildFromD1Rows` reads, by table. */
  rows?: Record<string, unknown[]>;
}

function makeDb(script: DbScript, events: string[]) {
  const issued: Issued[] = [];
  const base = [...(script.base ?? [cold()])];
  const reacquire = [...(script.reacquire ?? [])];
  let runCount = 0;
  let batchCount = 0;

  function nextFrom<T>(queue: T[], label: string): T {
    if (queue.length === 0) throw new Error(`no scripted ${label} left`);
    return queue.length === 1 ? queue[0] : (queue.shift() as T);
  }

  function tableOf(sql: string): string {
    return sql.match(/FROM\s+"?(\w+)"?/)?.[1] ?? "";
  }

  function prepare(sql: string) {
    let binds: unknown[] = [];
    const stmt = {
      sql,
      get boundArgs() { return binds; },
      bind(...args: unknown[]) { checkD1Bind(sql, args); binds = args; return stmt; },
      async run() {
        issued.push({ sql, binds });
        events.push(`run:${sql.slice(0, 40)}`);
        runCount += 1;
        const outcome = script.run?.(sql, binds, runCount) ?? { changes: 1 };
        if ("throws" in outcome) throw outcome.throws;
        if ("hold" in outcome) {
          await outcome.hold;
          return { meta: { last_row_id: 1, changes: 1 }, success: true as const };
        }
        return { meta: { last_row_id: 1, changes: outcome.changes }, success: true as const };
      },
      async all<T = unknown>() {
        return { results: ((script.rows ?? {})[tableOf(sql)] ?? []) as T[], success: true as const };
      },
      async first<T = unknown>() {
        if (/^SELECT yjs_state/.test(sql)) {
          events.push("read-base");
          const answer = nextFrom(base, "base row");
          if (answer && typeof answer === "object" && "throws" in answer) throw answer.throws;
          return answer as T | null;
        }
        if (/^SELECT yjs_generation/.test(sql)) {
          events.push("read-reacquire");
          const answer = nextFrom(reacquire, "re-acquisition row");
          if (answer && typeof answer === "object" && "throws" in answer) throw answer.throws;
          return answer as T | null;
        }
        if (/FROM project_members/.test(sql)) return { role: "collaborator" } as T;
        if (/SELECT id FROM project_(config|landing)/.test(sql)) return { id: 1 } as T;
        return null;
      },
    };
    return stmt;
  }

  return {
    issued,
    batchCalls: () => batchCount,
    DB: {
      prepare,
      async batch(statements: Array<Issued & { boundArgs?: unknown[] }>) {
        batchCount += 1;
        events.push("batch");
        issued.push({ sql: "BATCH", binds: statements.map((s) => s.sql) });
        for (const s of statements) issued.push({ sql: s.sql, binds: s.boundArgs ?? s.binds });
        script.batch?.(statements, batchCount);
        return statements.map(() => ({ success: true }));
      },
    },
  };
}

interface StorageScript {
  /** Answers to each generation read, in order; the last repeats. */
  generations?: Array<number | undefined | null | { throws: unknown }>;
  /** Keys the log prefix listing returns. */
  logKeys?: string[];
  /** Rejects every `put`. */
  putThrows?: unknown;
  /** Rejects the nth `put` whose keys this answers for, and no other. */
  putFails?: (keys: string[], nth: number) => unknown | undefined;
}

/**
 * Storage as a keyed store, with every put and delete recorded by exact key.
 *
 * The reset writes a group of keys through the codec and one key beside its
 * value for the switch, so `put` answers to both shapes and `puts` records one
 * entry per KEY: a claim about what was staged names the keys, never a call
 * count.
 */
function makeStorage(script: StorageScript, events: string[]) {
  const answers = [...(script.generations ?? [0])];
  const puts: Array<[string, unknown]> = [];
  const deletes: string[][] = [];
  const alarms: number[] = [];
  const kv = new Map<string, unknown>();
  let putCount = 0;
  let alarmAt: number | null = null;
  return {
    puts,
    deletes,
    alarms,
    kv,
    storage: {
      getAlarm: async () => alarmAt,
      setAlarm: async (at: number) => { alarmAt = at; alarms.push(at); },
      async get(keyOrKeys: string | string[]) {
        // A record's parts, which the codec reads a batch at a time and expects
        // back as a map of the keys it found.
        if (Array.isArray(keyOrKeys)) {
          events.push("storage-parts");
          const found = new Map<string, unknown>();
          for (const partKey of keyOrKeys) {
            if (kv.has(partKey)) found.set(partKey, kv.get(partKey));
          }
          return found;
        }
        const key = keyOrKeys;
        // Named per phase, so an assertion about the generation reads is not
        // also counting the halt and base reads every load makes.
        if (key.startsWith("halt:")) { events.push("storage-halt"); return undefined; }
        if (key.startsWith("base:")) { events.push("storage-base"); return kv.get(key); }
        events.push("storage-get");
        if (key !== "docGeneration") return kv.get(key);
        const answer = answers.length === 1 ? answers[0] : answers.shift();
        if (answer && typeof answer === "object" && "throws" in answer) throw answer.throws;
        // A landed put is what storage holds from then on, which is what the
        // reset's own re-acquisition reads back.
        if (kv.has(key)) return kv.get(key) as number;
        return answer as number | undefined;
      },
      async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
        events.push("storage-put");
        putCount += 1;
        if (script.putThrows !== undefined) throw script.putThrows;
        const entries = typeof keyOrEntries === "string"
          ? { [keyOrEntries]: value }
          : keyOrEntries;
        const failure = script.putFails?.(Object.keys(entries), putCount);
        if (failure !== undefined) throw failure;
        for (const [key, entry] of Object.entries(entries)) {
          kv.set(key, entry);
          puts.push([key, entry]);
        }
      },
      async delete(keys: string[]) {
        events.push("storage-delete");
        deletes.push([...keys]);
        return keys.filter((key) => kv.delete(key)).length;
      },
      async list(
        options: {
          prefix?: string;
          startAfter?: string;
          end?: string;
          limit?: number;
          reverse?: boolean;
        } = {},
      ) {
        const all = new Map<string, unknown>();
        for (const key of script.logKeys ?? []) all.set(key, {});
        for (const [key, value] of kv) all.set(key, value);
        // `startAfter` is an exclusive lower bound and `end` an exclusive upper
        // one, as the real binding types them: the replay pages the log with
        // `startAfter`, so a listing that ignored it would answer the same page
        // for ever.
        const chosen = [...all.keys()]
          .filter((key) => options.prefix === undefined || key.startsWith(options.prefix))
          .filter((key) => options.startAfter === undefined || key > options.startAfter)
          .filter((key) => options.end === undefined || key < options.end)
          .sort();
        if (options.reverse) chosen.reverse();
        return new Map(
          chosen.slice(0, options.limit ?? Infinity).map((key) => [key, all.get(key)]),
        );
      },
    },
  };
}

/** Plant a storage base for one generation, through the codec that writes it. */
function plantStorageBase(
  storage: ReturnType<typeof makeStorage>,
  generation: number,
  seq: number,
  bytes: Uint8Array,
): void {
  for (const [key, value] of Object.entries(encodeBase(generation, seq, bytes))) {
    storage.kv.set(key, value);
  }
}

function fakeSocket(events: string[], generation: number | undefined = 0, opts: { closeThrows?: boolean } = {}) {
  // Admitted just now, so the membership recheck is not yet due.
  const attachment = { userId: USER_ID, projectId: PROJECT_ID, role: "collaborator", generation, membershipCheckedAt: Date.now() };
  const closes: Array<{ code: number; reason: string }> = [];
  const sent: Uint8Array[] = [];
  return {
    attachment,
    closes,
    sent,
    send: (data: Uint8Array) => { sent.push(data); },
    close: (code: number, reason: string) => {
      events.push(`close:${code}`);
      if (opts.closeThrows) throw new Error("already closed");
      closes.push({ code, reason });
    },
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

type FakeSocket = ReturnType<typeof fakeSocket>;

interface Internals {
  projectId: number | null;
  bindProjectIdFromMarker: (request: Request) => Promise<Response | null>;
  docLoaded: boolean;
  docGeneration: number | null;
  docSeq: number | null;
  docWrite: number | null;
  persistenceHalted: { generation: number; marker: { reason: string; at: number } } | null;
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  newSessions: Set<number>;
  activityEmitted: Map<number, Set<string>>;
  userFieldSets: Map<number, Set<string>>;
  timeLedger: TimeLedger;
  wordsByRow: WordsByRow;
  getDocGeneration: () => Promise<number | null>;
  ensureDocLoaded: () => Promise<void>;
  doSnapshot: () => Promise<void>;
  webSocketClose: (ws: unknown, code: number) => Promise<void>;
  snapshotToD1: () => Promise<void>;
  flushSnapshotNow: () => Promise<boolean>;
  buildFromD1Rows: () => Promise<void>;
  alarm: () => Promise<void>;
  webSocketMessage: (ws: unknown, message: ArrayBuffer) => Promise<void>;
  fetch: (request: Request) => Promise<Response>;
}

function makeDo(
  db: DbScript = {},
  storage: StorageScript = {},
  sockets: FakeSocket[] = [],
  events: string[] = [],
) {
  const dbFake = makeDb(db, events);
  const storageFake = makeStorage(storage, events);
  const ctx = {
    getWebSockets: () => sockets,
    lastGate: Promise.resolve() as Promise<unknown>,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      const gate = fn();
      ctx.lastGate = gate;
      return gate;
    },
    storage: storageFake.storage,
    acceptWebSocket: vi.fn(),
  };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    {
      DB: dbFake.DB as unknown,
      SESSION_SECRET: TEST_SECRET,
      COLLABORATION: {} as unknown,
    } as unknown as Env,
  );
  const internals = doInstance as unknown as Internals;
  // Through one of the three production bindings rather than by assignment, so
  // the instance carries the durable binding a route or an alarm would find.
  // The binding's own put is then taken back out: what a fixture spent to reach
  // its starting state is not what any of these tests is about.
  void internals.bindProjectIdFromMarker(
    new Request("https://internal/marker", {
      headers: { "X-Internal-Project": String(PROJECT_ID) },
    }),
  );
  dropIdentityPut(storageFake.puts, events);
  return { doInstance, internals, db: dbFake, storage: storageFake, ctx, events, sockets };
}

/** Take every `projectId` put, and one `storage-put` for each, out of the trace. */
function dropIdentityPut(puts: Array<[string, unknown]>, events: string[]): void {
  for (;;) {
    const at = puts.findIndex(([key]) => key === "projectId");
    if (at < 0) return;
    puts.splice(at, 1);
    const event = events.indexOf("storage-put");
    if (event >= 0) events.splice(event, 1);
  }
}

/** Statements issued against `projects`, in order, ignoring reads. */
function writes(issued: Issued[]): Issued[] {
  return issued.filter((s) => /^UPDATE projects|^INSERT INTO yjs_write_guard|^DELETE FROM yjs_write_guard/.test(s.sql));
}

function claims(issued: Issued[]): Issued[] {
  return issued.filter((s) => /^UPDATE projects SET yjs_write = \? WHERE id = \? AND/.test(s.sql));
}

function tags(issued: Issued[]): Issued[] {
  return issued.filter((s) => /^UPDATE projects SET yjs_generation = \?/.test(s.sql));
}

function initialWrites(issued: Issued[]): Issued[] {
  return issued.filter((s) => /^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = 0/.test(s.sql));
}

function baseWrites(issued: Issued[]): Issued[] {
  return issued.filter((s) => /^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(s.sql));
}

function storyTitle(doc: Y.Doc): string | undefined {
  const stories = doc.getArray<Y.Map<unknown>>("stories");
  return stories.length === 0 ? undefined : String(stories.get(0).get("title"));
}

async function refusal(load: Promise<unknown>): Promise<ExactBaseError> {
  const err = await load.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ExactBaseError);
  return err as ExactBaseError;
}

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

function exactBaseLines(): string[] {
  return errors.filter((line) => line.includes("[exact-base]"));
}

/** The one line a halt writes, wherever it was entered. */
function haltLines(): string[] {
  return errors.filter((line) => line.includes("[persistence][halted]"));
}

/** Whether the instance holds a halt right now. */
function isHalted(internals: Internals): boolean {
  return internals.persistenceHalted !== null;
}

// ---------------------------------------------------------------------------
// The tagged base
// ---------------------------------------------------------------------------

describe("a base tagged with the current generation", () => {
  it("claims the row with a bare claim, in the order read, validate, claim", async () => {
    const events: string[] = [];
    const { internals, db } = makeDo(
      { base: [tagged(BASE_A, 3, 7, 5)] },
      { generations: [3] },
      [],
      events,
    );

    await internals.ensureDocLoaded();

    // The second `storage-get` is the maintenance floor, read once the document
    // is open: at generation 3 with the floor at 0 there are superseded
    // generations to sweep, and the load is what arms the sweep an eviction
    // could have left unscheduled.
    expect(events.filter((e) => e === "read-base" || e === "storage-get" || e.startsWith("run:"))).toEqual([
      "read-base",
      "storage-get",
      "run:UPDATE projects SET yjs_write = ? WHERE ",
      "storage-get",
    ]);
    expect(claims(db.issued)).toHaveLength(1);
    expect(claims(db.issued)[0].binds).toEqual([6, PROJECT_ID, 5]);
    expect(tags(db.issued)).toHaveLength(0);
    expect(internals.docLoaded).toBe(true);
    // One above the base's sequence: the load's `backfillBlobGaps` seeds the
    // two config toggles, and that transaction is a logged record.
    expect(internals.docSeq).toBe(8);
    expect(internals.docWrite).toBe(6);
    expect(storyTitle(internals.ydoc)).toBe("Story A");
  });

  it("carries the stored sequence and the claimed revision into the next blob write", async () => {
    const { internals, db } = makeDo({ base: [tagged(BASE_A, 3, 7, 5)] }, { generations: [3] });
    await internals.ensureDocLoaded();

    await internals.doSnapshot();

    const write = baseWrites(db.issued)[0];
    expect(write.binds[1]).toBe(3);
    // The base's 7 plus the load's own repair record.
    expect(write.binds[2]).toBe(8);
    expect(write.binds[3]).toBe(7); // docWrite + 1
    expect(write.binds[6]).toBe(6); // docWrite
  });

  it("issues no statement at all for a second connection to a loaded instance", async () => {
    const { internals, db } = makeDo({ base: [tagged(BASE_A, 0, 0, 0)] });
    await internals.ensureDocLoaded();
    const after = db.issued.length;

    // The early return: a loaded document is not read, validated or claimed
    // again, whatever asks for it.
    await internals.ensureDocLoaded();

    expect(db.issued.length).toBe(after);
  });

  it("re-reads and revalidates when the claim lands zero rows, and refuses after three reads", async () => {
    const events: string[] = [];
    const { internals, db } = makeDo(
      { base: [tagged(BASE_A, 0, 0, 0)], run: () => ({ changes: 0 }) },
      {},
      [],
      events,
    );

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("claim_contended");
    expect(events.filter((e) => e === "read-base" || e === "storage-get")).toEqual([
      "read-base", "storage-get", "read-base", "storage-get", "read-base", "storage-get",
    ]);
    expect(claims(db.issued)).toHaveLength(3);
    expect(internals.docLoaded).toBe(false);
    expect(storyTitle(internals.ydoc)).toBeUndefined();
    expect(exactBaseLines()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The untagged base
// ---------------------------------------------------------------------------

describe("an untagged base is tagged on the bytes read, before they are applied", () => {
  it("issues exactly one tagging statement, bound to those bytes and the revision", async () => {
    const { internals, db } = makeDo({ base: [untagged(BASE_A, 4)] }, { generations: [2] });

    await internals.ensureDocLoaded();

    expect(tags(db.issued)).toHaveLength(1);
    expect(tags(db.issued)[0].binds).toEqual([2, 5, PROJECT_ID, BASE_A, 4]);
    expect(claims(db.issued)).toHaveLength(0);
    // One above the base's sequence: the load's `backfillBlobGaps` seeds the
    // two config toggles, and that transaction is a logged record.
    expect(internals.docSeq).toBe(1);
    expect(internals.docWrite).toBe(5);
    expect(storyTitle(internals.ydoc)).toBe("Story A");
  });

  it("tags the bytes it read the second time when the row changed under it", async () => {
    let nth = 0;
    const { internals, db } = makeDo({
      base: [untagged(BASE_A, 0), untagged(BASE_B, 0)],
      run: () => (++nth === 1 ? { changes: 0 } : { changes: 1 }),
    });
    const applied = captureAppliedBase(internals);

    await internals.ensureDocLoaded();

    expect(tags(db.issued)).toHaveLength(2);
    expect(tags(db.issued)[0].binds[3]).toBe(BASE_A);
    expect(tags(db.issued)[1].binds[3]).toBe(BASE_B);
    assertBaseApplied(applied, BASE_B);
    assertRepairsRan(internals.ydoc, "Story B");
  });

  it("claims rather than tags when the second read finds the row already enrolled", async () => {
    let nth = 0;
    const { internals, db } = makeDo({
      base: [untagged(BASE_A, 0), tagged(BASE_B, 0, 9, 1)],
      run: () => (++nth === 1 ? { changes: 0 } : { changes: 1 }),
    });
    const applied = captureAppliedBase(internals);

    await internals.ensureDocLoaded();

    expect(tags(db.issued)).toHaveLength(1);
    expect(claims(db.issued)).toHaveLength(1);
    // One above the base's sequence: the load's `backfillBlobGaps` seeds the
    // two config toggles, and that transaction is a logged record.
    expect(internals.docSeq).toBe(10);
    assertBaseApplied(applied, BASE_B);
    assertRepairsRan(internals.ydoc, "Story B");
  });

  it("applies the base's deletions, so an entity deleted in it is not served", async () => {
    const { internals } = makeDo(
      { base: [tagged(BASE_WITH_DELETION, 0, 0, 0)], rows: TWO_STORIES },
      { generations: [0] },
    );
    const applied = captureAppliedBase(internals);

    await internals.ensureDocLoaded();

    assertBaseApplied(applied, BASE_WITH_DELETION);
    const stories = internals.ydoc.getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(1);
    expect(stories.toArray().map((s) => String(s.get("title")))).not.toContain(DELETED_TITLE);
    assertRepairsRan(internals.ydoc, "Story A");
  });

  it("refuses after three zero-row rounds without applying anything", async () => {
    const { internals, db } = makeDo({ base: [untagged(BASE_A, 0)], run: () => ({ changes: 0 }) });

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("tag_contended");
    expect(tags(db.issued)).toHaveLength(3);
    expect(internals.docLoaded).toBe(false);
    expect(storyTitle(internals.ydoc)).toBeUndefined();
  });

  it("refuses an untagged base met under a log, writing nothing", async () => {
    const { internals, db } = makeDo(
      { base: [untagged(BASE_A, 0)] },
      { logKeys: ["log:0:000000000000004"] },
    );

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("untagged_under_log");
    expect(writes(db.issued)).toHaveLength(0);
    expect(internals.docLoaded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("the loader validates every value it reads", () => {
  it.each([
    ["one NULL tag", { yjs_state: BASE_A, yjs_generation: 1, yjs_seq: null, yjs_write: 0 }],
    ["the other NULL tag", { yjs_state: BASE_A, yjs_generation: null, yjs_seq: 0, yjs_write: 0 }],
    ["a negative generation", tagged(BASE_A, -1, 0, 0)],
    ["a non-integer sequence", { yjs_state: BASE_A, yjs_generation: 0, yjs_seq: 1.5, yjs_write: 0 }],
    ["an unsafe generation", tagged(BASE_A, H + 2, 0, 0)],
    ["a sequence above the key width", tagged(BASE_A, 0, MAX_SEQ + 1, 0)],
  ])("refuses %s as bad_tags", async (_label, row) => {
    const { internals, db } = makeDo({ base: [row as BaseRowShape] });

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("bad_tags");
    expect(writes(db.issued)).toHaveLength(0);
  });

  it.each([
    ["lower", 2],
    ["higher", 9],
  ])("refuses a base tagged with a %s generation", async (_label, generation) => {
    const { internals, db } = makeDo({ base: [tagged(BASE_A, generation, 0, 0)] }, { generations: [5] });

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("base_generation_mismatch");
    expect(writes(db.issued)).toHaveLength(0);
  });

  it("refuses a NULL blob under tags rather than building one", async () => {
    const { internals, db } = makeDo({
      base: [{ yjs_state: null, yjs_generation: 0, yjs_seq: 0, yjs_write: 1 }],
    });

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("blob_missing_tagged");
    expect(db.issued.filter((s) => /FROM stories/.test(s.sql))).toHaveLength(0);
  });

  it.each([
    ["a negative revision", -1],
    ["a non-integer revision", 2.5],
    ["a text revision", "3"],
  ])("refuses %s as bad_revision", async (_label, revision) => {
    const { internals, db } = makeDo({
      base: [{ yjs_state: BASE_A, yjs_generation: 0, yjs_seq: 0, yjs_write: revision }],
    });

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("bad_revision");
    expect(writes(db.issued)).toHaveLength(0);
  });

  it("refuses a missing project row rather than cold-building for it", async () => {
    const { internals, db } = makeDo({ base: [null] });

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("missing_project");
    expect(writes(db.issued)).toHaveLength(0);
    expect(db.issued.filter((s) => /FROM stories/.test(s.sql))).toHaveLength(0);
  });

  it("reads an absent generation key as 0", async () => {
    const absent = makeDo({ base: [tagged(BASE_A, 0, 0, 0)] }, { generations: [undefined] });

    await absent.internals.ensureDocLoaded();

    expect(absent.internals.docLoaded).toBe(true);
  });

  it.each([
    ["a negative value", -2],
    // A stored `null` is NOT an absent key. Only the absent key is 0; every
    // other value outside the domain is a value nothing here wrote, and reading
    // it as 0 would load and tag under a generation the document does not have.
    ["a stored null", null],
  ])("refuses %s as generation_malformed at the load", async (_label, stored) => {
    const { internals, db } = makeDo({ base: [tagged(BASE_A, 0, 0, 0)] }, { generations: [stored] });

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("generation_malformed");
    expect(writes(db.issued)).toHaveLength(0);
    expect(internals.docLoaded).toBe(false);
  });

  it("answers null from the accessor for a stored null, and logs it once", async () => {
    const { internals } = makeDo({}, { generations: [null] });

    expect(await internals.getDocGeneration()).toBeNull();

    expect(errors.filter((l) => l.includes("generation is not a generation"))).toHaveLength(1);
  });

  it("stops the snapshot's fresh read on a stored null, after the load read a number", async () => {
    // The load reads 0 from an absent key; the key is then damaged, which is
    // the state a hand repair or another writer can leave behind.
    const { internals, db } = await loadedInstance({}, { generations: [0, null] });

    const err = await internals.doSnapshot().then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ExactBaseError);
    expect((err as ExactBaseError).reason).toBe("generation_malformed");
    expect(db.issued).toHaveLength(0);
  });

  it("answers /reset 503 with nothing touched when the generation reads null", async () => {
    const socket = fakeSocket([]);
    const harness = makeDo({ base: [cold(4)], rows: ONE_STORY }, { generations: [null] });
    harness.sockets.push(socket);

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(harness.db.issued).toHaveLength(0);
    expect(harness.storage.puts).toHaveLength(0);
    expect(socket.closes).toEqual([]);
  });

  it("refuses a generation storage cannot answer, claiming nothing", async () => {
    const { internals, db } = makeDo(
      { base: [tagged(BASE_A, 0, 0, 0)] },
      { generations: [{ throws: new Error("storage down") }] },
    );

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("generation_unreadable");
    expect(writes(db.issued)).toHaveLength(0);
    expect(internals.docLoaded).toBe(false);
  });
});

describe("the revision has a ceiling, and a load claims only with room below it", () => {
  it("claims at H - 3, completes one snapshot, and refuses the next", async () => {
    const { internals, db, sockets } = (() => {
      const socket = fakeSocket([]);
      return { ...makeDo({ base: [tagged(BASE_A, 0, 0, H - 3)] }, {}, [socket]), sockets: [socket] };
    })();

    await internals.ensureDocLoaded();
    expect(internals.docWrite).toBe(H - 2);

    await internals.doSnapshot();
    expect(baseWrites(db.issued)[0].binds[3]).toBe(H - 1);
    const guard = db.issued.find((s) => /^INSERT INTO yjs_write_guard/.test(s.sql));
    expect(guard!.binds).toEqual([PROJECT_ID, H - 1]);
    expect(internals.docWrite).toBe(H);

    const before = db.issued.length;
    const err = await internals.doSnapshot().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ExactBaseError);
    expect((err as ExactBaseError).reason).toBe("revision_exhausted");
    expect(db.issued.length).toBe(before);
    expect(sockets[0].closes).toEqual([UNAVAILABLE]);
  });

  it("refuses a load at H - 2 before any statement", async () => {
    const { internals, db } = makeDo({ base: [tagged(BASE_A, 0, 0, H - 2)] });

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("revision_exhausted");
    expect(db.issued.filter((s) => !/^SELECT yjs_state/.test(s.sql))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The cold build
// ---------------------------------------------------------------------------

const ONE_STORY = {
  stories: [{ id: 11, story_id: "s1", title: "Story A", order: 0, order_key: "a0" }],
};

/** The rows a deletion-bearing base contradicts: both stories are still here. */
const TWO_STORIES = {
  stories: [
    { id: 11, story_id: "s1", title: "Story A", order: 0, order_key: "a0" },
    { id: 12, story_id: "s2", title: DELETED_TITLE, order: 1, order_key: "a1" },
  ],
};

describe("the cold build writes its blob before it opens", () => {
  it("refuses under a tail without reading a single entity row", async () => {
    const { internals, db } = makeDo(
      { base: [cold()], rows: ONE_STORY },
      { logKeys: ["log:0:000000000000001"] },
    );

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("tail_without_base");
    expect(db.issued.filter((s) => /FROM stories/.test(s.sql))).toHaveLength(0);
  });

  it("holds the upgrade's acceptance until the initial write resolves", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { doInstance, ctx, db } = makeDo({
      base: [cold()],
      rows: ONE_STORY,
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation/.test(sql) ? { hold: held } : undefined),
    });

    const upgraded = upgrade(doInstance);
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.acceptWebSocket).not.toHaveBeenCalled();

    release();
    await upgraded;

    expect(ctx.acceptWebSocket).toHaveBeenCalledTimes(1);
    const internals = doInstance as unknown as Internals;
    assertSameState(initialWrites(db.issued)[0].binds[0], internals.ydoc);
  });

  it("builds once when the initial write rejects and the retry succeeds", async () => {
    let nth = 0;
    const { internals, db } = makeDo({
      base: [cold()],
      rows: ONE_STORY,
      run: (sql) =>
        /^UPDATE projects SET yjs_state = \?, yjs_generation/.test(sql) && ++nth === 1
          ? { throws: new Error("D1_ERROR: write failed") }
          : undefined,
    });

    await expect(internals.ensureDocLoaded()).rejects.toThrow(/write failed/);
    expect(internals.docLoaded).toBe(false);
    await internals.ensureDocLoaded();

    expect(internals.ydoc.getArray("stories").length).toBe(1);
    assertSameState(initialWrites(db.issued)[1].binds[0], internals.ydoc);
  });

  it("builds once when a post-build repair throws and the retry succeeds", async () => {
    const { internals, db } = makeDo({ base: [cold()], rows: ONE_STORY });
    const original = (internals as unknown as { seedEditingTime: () => Promise<void> }).seedEditingTime;
    let thrown = false;
    (internals as unknown as { seedEditingTime: () => Promise<void> }).seedEditingTime = async function (this: unknown) {
      if (!thrown) { thrown = true; throw new Error("repair failed"); }
      return original.call(this);
    };

    await expect(internals.ensureDocLoaded()).rejects.toThrow(/repair failed/);
    await internals.ensureDocLoaded();

    expect(internals.ydoc.getArray("stories").length).toBe(1);
    assertSameState(initialWrites(db.issued)[0].binds[0], internals.ydoc);
  });

  it("refuses after three zero-row initial writes", async () => {
    const { internals, db } = makeDo({
      base: [cold()],
      rows: ONE_STORY,
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation/.test(sql) ? { changes: 0 } : undefined),
    });

    const err = await refusal(internals.ensureDocLoaded());

    expect(err.reason).toBe("initial_write_contended");
    expect(initialWrites(db.issued)).toHaveLength(3);
    expect(internals.docLoaded).toBe(false);
    expect(internals.ydoc.getArray("stories").length).toBe(0);
  });

  it("applies a peer's blob rather than building a second time when it loses the write", async () => {
    let nth = 0;
    const { internals, db } = makeDo({
      base: [cold(), tagged(BASE_B, 0, 2, 1)],
      rows: ONE_STORY,
      run: (sql) =>
        /^UPDATE projects SET yjs_state = \?, yjs_generation/.test(sql) && ++nth === 1
          ? { changes: 0 }
          : undefined,
    });
    const applied = captureAppliedBase(internals);

    await internals.ensureDocLoaded();

    expect(initialWrites(db.issued)).toHaveLength(1);
    // One above the base's sequence: the load's `backfillBlobGaps` seeds the
    // two config toggles, and that transaction is a logged record.
    expect(internals.docSeq).toBe(3);
    assertBaseApplied(applied, BASE_B);
    assertRepairsRan(internals.ydoc, "Story B");
  });
});

// ---------------------------------------------------------------------------
// The fenced snapshot
// ---------------------------------------------------------------------------

async function loadedInstance(overrides: Partial<DbScript> = {}, storage: StorageScript = {}, sockets: FakeSocket[] = []) {
  const harness = makeDo(
    { base: [tagged(BASE_A, 0, 3, 5)], rows: ONE_STORY, ...overrides },
    storage,
    sockets,
  );
  await harness.internals.ensureDocLoaded();
  harness.db.issued.length = 0;
  return harness;
}

/**
 * One prose edit through an editor's socket, so every ledger a snapshot settles
 * carries something: words against the story's row, editing and writing time,
 * a session, and a field path the activity feed emits a row for.
 *
 * A batch assertion against empty ledgers proves nothing — settling nothing and
 * settling twice look alike.
 */
function driveOneEdit(internals: Internals): void {
  const editor = fakeSocket([]);
  const story = internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
  internals.ydoc.transact(() => {
    (story.get("title") as Y.Text).insert(0, "many more words written here ");
  }, editor);
  internals.newSessions.add(USER_ID);
}

/** A loaded instance whose ledgers are not empty. */
async function loadedWithLedgers(
  overrides: Partial<DbScript> = {},
  storage: StorageScript = {},
  sockets: FakeSocket[] = [],
) {
  const harness = await loadedInstance(overrides, storage, sockets);
  driveOneEdit(harness.internals);
  harness.db.issued.length = 0;
  return harness;
}

interface LedgerState {
  words: number | undefined;
  editingMs: number | undefined;
  sessions: number;
  emitted: number;
}

/** What the four ledgers hold right now. */
function ledgers(internals: Internals): LedgerState {
  const accrual = internals.timeLedger.get(USER_ID) as { pendingEditingMs: number } | undefined;
  return {
    words: internals.wordsByRow.get("stories")?.get("11")?.get(USER_ID),
    editingMs: accrual?.pendingEditingMs,
    sessions: internals.newSessions.size,
    emitted: internals.activityEmitted.get(USER_ID)?.size ?? 0,
  };
}

/** Nothing has been taken: the work is still owed and the next batch pays it. */
function expectUnsettled(internals: Internals): void {
  const state = ledgers(internals);
  expect(state.words).toBeGreaterThan(0);
  expect(state.editingMs).toBeGreaterThan(0);
  expect(state.sessions).toBe(1);
  expect(state.emitted).toBe(0);
}

/**
 * Given up with the halt: nothing is owed, and nothing was written for it
 * either. A halted document's snapshot never runs, and its rebuild has no
 * relation to what these ledgers held, so the credit of the span goes with it.
 */
function expectAbandoned(internals: Internals): void {
  const state = ledgers(internals);
  expect(state.words).toBeUndefined();
  expect(state.editingMs).toBeUndefined();
  expect(state.sessions).toBe(0);
  expect(state.emitted).toBe(0);
}

/** Taken once, and once only: every ledger is down to nothing owed. */
function expectSettledOnce(internals: Internals): void {
  const state = ledgers(internals);
  expect(state.words).toBeUndefined();
  expect(state.editingMs).toBe(0);
  expect(state.sessions).toBe(0);
  expect(state.emitted).toBe(1);
}

describe("the snapshot writes under the revision it claimed", () => {
  it("binds the fresh generation, the captured sequence and the revision, and moves it twice", async () => {
    const { internals, db } = await loadedInstance();

    await internals.doSnapshot();

    const write = baseWrites(db.issued)[0];
    // Sequence 4: the base's 3 and the load's own repair record.
    expect(write.binds.slice(1, 4)).toEqual([0, 4, 7]);
    expect(write.binds[6]).toBe(6);
    const batched = db.issued.filter((s) => s.sql === "BATCH")[0].binds as string[];
    expect(batched[0]).toMatch(/^INSERT INTO yjs_write_guard/);
    expect(batched[1]).toBe("UPDATE projects SET yjs_write = ? WHERE id = ?");
    expect(batched[batched.length - 1]).toMatch(/^DELETE FROM yjs_write_guard/);
    const guard = db.issued.find((s) => /^INSERT INTO yjs_write_guard/.test(s.sql))!;
    expect(guard.binds).toEqual([PROJECT_ID, 7]);
    const advance = db.issued.find((s) => s.sql === "UPDATE projects SET yjs_write = ? WHERE id = ?")!;
    expect(advance.binds).toEqual([8, PROJECT_ID]);
    expect(internals.docWrite).toBe(8);
  });

  it("binds the sequence the document reached during the snapshot, not the one it began with", async () => {
    const harness = await loadedInstance();
    const internals = harness.internals;
    const hooked = internals as unknown as {
      snapshotContributions: (...args: unknown[]) => Promise<unknown>;
    };
    const original = hooked.snapshotContributions;
    // A backfill between the top of the snapshot and the encoding is a
    // transaction, and the sequence has to name the state the encoded bytes
    // hold — which is the state after it, not the one the snapshot started from.
    hooked.snapshotContributions = async function (this: unknown, ...args: unknown[]) {
      internals.docSeq = 9;
      return original.apply(this, args);
    };

    await internals.doSnapshot();

    expect(baseWrites(harness.db.issued)[0].binds[2]).toBe(9);
  });

  it("stops before any statement when the fresh generation read fails", async () => {
    const { internals, db } = await loadedInstance({}, { generations: [0, { throws: new Error("storage down") }] });

    await expect(internals.doSnapshot()).rejects.toThrow(/no exact base/);

    expect(db.issued).toHaveLength(0);
  });
});

describe("re-acquisition observes, then proves ownership, then decides", () => {
  it("retries a thrown blob write whose row had not moved", async () => {
    const events: string[] = [];
    const harness = makeDo(
      {
        base: [tagged(BASE_A, 0, 3, 5)],
        rows: ONE_STORY,
        reacquire: [{ yjs_generation: 0, yjs_seq: 3, yjs_write: 6 } as BaseRowShape],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          ? { throws: new Error("D1_ERROR: blob write failed") }
          : undefined),
      },
      {},
      [],
      events,
    );
    await harness.internals.ensureDocLoaded();
    events.length = 0;

    await expect(harness.internals.doSnapshot()).rejects.toThrow(/blob write failed/);

    expect(events.filter((e) => e === "read-reacquire" || e === "storage-get")).toEqual([
      "storage-get", "read-reacquire", "storage-get",
    ]);
    expect(harness.internals.docWrite).toBe(6);
    expect(isHalted(harness.internals)).toBe(false);
    expect(harness.db.batchCalls()).toBe(0);
  });

  it("adopts a blob write whose acknowledgement was lost, and issues the batch", async () => {
    const harness = await loadedInstance({
      reacquire: [{ yjs_generation: 0, yjs_seq: 4, yjs_write: 7 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });

    await harness.internals.doSnapshot();

    expect(harness.internals.docWrite).toBe(8);
    expect(harness.db.batchCalls()).toBe(1);
    expect(isHalted(harness.internals)).toBe(false);
  });

  it("stops without adopting when the storage validation after the read rejects", async () => {
    const harness = makeDo(
      {
        base: [tagged(BASE_A, 0, 3, 5)],
        rows: ONE_STORY,
        // The shape of a replacement's claim: the revision this instance's own
        // landed write would have left, with the tags unchanged.
        reacquire: [{ yjs_generation: 0, yjs_seq: 3, yjs_write: 7 } as BaseRowShape],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          ? { changes: 0 }
          : undefined),
      },
      { generations: [0, 0, { throws: new Error("replaced") }] },
    );
    await harness.internals.ensureDocLoaded();

    await expect(harness.internals.doSnapshot()).rejects.toThrow(/no exact base/);

    expect(harness.internals.docWrite).toBe(6);
    expect(isHalted(harness.internals)).toBe(false);
    expect(harness.db.batchCalls()).toBe(0);
  });

  it.each([
    ["a guard abort", "D1_ERROR: yjs_write_guard: SQLITE_CONSTRAINT"],
    ["any other batch error", "D1_ERROR: simulated batch failure"],
  ])("reschedules %s whose row had not moved, with every ledger still owed", async (_label, message) => {
    const harness = await loadedWithLedgers({
      reacquire: [{ yjs_generation: 0, yjs_seq: 3, yjs_write: 7 } as BaseRowShape],
      batch: () => { throw new Error(message); },
    });

    await expect(harness.internals.doSnapshot()).rejects.toThrow(message);

    // The blob's revision, not the batch's: the batch did not land.
    expect(harness.internals.docWrite).toBe(7);
    expect(isHalted(harness.internals)).toBe(false);
    expectUnsettled(harness.internals);
  });

  it.each([
    ["a guard abort", "D1_ERROR: yjs_write_guard: SQLITE_CONSTRAINT"],
    ["any other batch error", "D1_ERROR: network"],
  ])("adopts a batch that landed under %s, settling every ledger once", async (_label, message) => {
    const harness = await loadedWithLedgers({
      reacquire: [{ yjs_generation: 0, yjs_seq: 4, yjs_write: 8 } as BaseRowShape],
      batch: () => { throw new Error(message); },
    });

    await harness.internals.doSnapshot();

    expect(harness.internals.docWrite).toBe(8);
    expect(isHalted(harness.internals)).toBe(false);
    expectSettledOnce(harness.internals);
  });

  it("adopts the blob write, then refuses when the batch's re-acquisition fails the storage validation, with every ledger still owed", async () => {
    // No socket at construction: the wake path only fires when one is present
    // when the instance is built, and this test is about doSnapshot's own
    // sequence of storage reads, not a race with a concurrent wake load.
    const socket = fakeSocket([]);
    const harness = await loadedWithLedgers(
      {
        // The blob write's acknowledgement is lost and the first re-acquisition
        // observes p + 1 under this instance's own tags with the storage
        // validation agreeing, so it adopts. The batch then aborts, and the
        // second re-acquisition observes the row unmoved from that adopted
        // revision but under a generation storage disagrees with — a foreign
        // lineage, not a failed read.
        reacquire: [
          { yjs_generation: 0, yjs_seq: 4, yjs_write: 7 } as BaseRowShape,
          { yjs_generation: 0, yjs_seq: 4, yjs_write: 7 } as BaseRowShape,
        ],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          ? { changes: 0 }
          : undefined),
        batch: () => { throw new Error("D1_ERROR: yjs_write_guard: SQLITE_CONSTRAINT"); },
      },
      { generations: [0, 0, 0, 4] },
    );
    harness.sockets.push(socket);

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(FenceRefusedError);

    expect(isHalted(harness.internals)).toBe(true);
    expect(harness.db.batchCalls()).toBe(1);
    expectAbandoned(harness.internals);
    expect(socket.closes).toEqual([UNAVAILABLE]);
    expect(haltLines()).toHaveLength(1);
  });

  it("refuses a guard-marker error at the revision it holds under a foreign generation", async () => {
    const socket = fakeSocket([]);
    const harness = await loadedWithLedgers(
      {
        // The revision this instance holds, under a lineage that is not its
        // own: unmoved says nothing on its own, and adopting "nothing landed"
        // here would leave the instance serving editors it can never persist.
        reacquire: [{ yjs_generation: 4, yjs_seq: 3, yjs_write: 7 } as BaseRowShape],
        batch: () => { throw new Error("D1_ERROR: yjs_write_guard: SQLITE_CONSTRAINT"); },
      },
      {},
      [socket],
    );

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(FenceRefusedError);

    expect(isHalted(harness.internals)).toBe(true);
    expectAbandoned(harness.internals);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("adopts at p + 1 and is refused by the guard when a replacement claims before the batch", async () => {
    const socket = fakeSocket([]);
    const harness = await loadedWithLedgers(
      {
        // The blob write's acknowledgement is lost and the row is observed at
        // p + 1 under this instance's own tags, so a still-owning instance is
        // right to adopt it. A replacement then claims the row and writes its
        // own blob before this instance's batch, whose guard aborts; the
        // replacement's own batch has not yet landed, and the second
        // observation is a revision the batch phase cannot name.
        //
        // The replacement's writes are scripted as more than one move on
        // purpose: a single move is exactly what this instance's own landed
        // batch leaves, and only the storage validation tells those apart —
        // which the sibling test above exercises.
        reacquire: [
          { yjs_generation: 0, yjs_seq: 4, yjs_write: 7 } as BaseRowShape,
          { yjs_generation: 0, yjs_seq: 4, yjs_write: 9 } as BaseRowShape,
        ],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          ? { changes: 0 }
          : undefined),
        batch: () => { throw new Error("D1_ERROR: yjs_write_guard: SQLITE_CONSTRAINT"); },
      },
      {},
      [socket],
    );

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(FenceRefusedError);

    expect(harness.db.batchCalls()).toBe(1);
    expect(isHalted(harness.internals)).toBe(true);
    expectAbandoned(harness.internals);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it.each([
    ["a revision the phase does not name", { yjs_generation: 0, yjs_seq: 3, yjs_write: 9 }],
    // p + 2 after a blob write that has not issued its batch: no write of this
    // instance's own could have produced it.
    ["the revision the batch would have left", { yjs_generation: 0, yjs_seq: 3, yjs_write: 8 }],
    ["another generation", { yjs_generation: 4, yjs_seq: 3, yjs_write: 7 }],
    ["the revision it holds under another generation", { yjs_generation: 4, yjs_seq: 3, yjs_write: 6 }],
    ["a row that is gone", null],
  ])("refuses the fence on %s", async (_label, observed) => {
    const socket = fakeSocket([]);
    const harness = await loadedInstance(
      {
        reacquire: [observed as BaseRowShape | null],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          ? { throws: new Error("D1_ERROR: blob write failed") }
          : undefined),
      },
      {},
      [socket],
    );

    const err = await harness.internals.doSnapshot().then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(FenceRefusedError);
    expect(isHalted(harness.internals)).toBe(true);
    expect(harness.db.batchCalls()).toBe(0);
    expect(socket.closes).toEqual([UNAVAILABLE]);
    expect(haltLines()).toHaveLength(1);
  });

  it("closes every socket even when one close throws", async () => {
    const bad = fakeSocket([], 0, { closeThrows: true });
    const good = fakeSocket([]);
    const harness = await loadedInstance(
      {
        reacquire: [null],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          ? { changes: 0 }
          : undefined),
      },
      {},
      [bad, good],
    );

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(FenceRefusedError);

    expect(bad.closes).toEqual([]);
    expect(good.closes).toEqual([UNAVAILABLE]);
  });
});

// ---------------------------------------------------------------------------
// What the refusal state refuses
// ---------------------------------------------------------------------------

async function refusedInstance(sockets: FakeSocket[] = []) {
  const harness = await loadedInstance(
    {
      reacquire: [null],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    },
    {},
    sockets,
  );
  await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(FenceRefusedError);
  errors.length = 0;
  harness.db.issued.length = 0;
  return harness;
}

describe("re-acquisition's predecessor shapes, for an unmoved row", () => {
  /**
   * A snapshot whose blob write matched no row, so re-acquisition has to say
   * whether the row it observes is one of this instance's own predecessors.
   *
   * The instance was loaded at generation 0 from a base at sequence 3 and
   * claimed revision 5 to 6, so an unmoved row is revision 6 and the write
   * expects generation 0.
   */
  async function unmovedAt(row: Record<string, unknown>) {
    return await loadedInstance({
      reacquire: [row as unknown as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });
  }

  it.each([
    ["tagged at the expected generation", { yjs_generation: 0, yjs_seq: 3, yjs_write: 6 }],
    ["tagged at the expected generation with sequence 0", { yjs_generation: 0, yjs_seq: 0, yjs_write: 6 }],
    // The shape a bare claim over a storage-base recovery leaves behind, blob
    // and all: the tags say nothing, so they cannot say the row is foreign.
    ["untagged, both tags NULL", { yjs_generation: null, yjs_seq: null, yjs_write: 6 }],
  ])("treats a row %s as its own predecessor, and retries", async (_label, row) => {
    const harness = await unmovedAt(row);

    await expect(harness.internals.doSnapshot()).rejects.toThrow(/matched no row/);

    // Retryable, not terminal: the next snapshot writes again.
    expect(isHalted(harness.internals)).toBe(false);
    expect(harness.internals.docWrite).toBe(6);
    expect(harness.db.batchCalls()).toBe(0);
  });

  it.each([
    ["a generation above the expected one", { yjs_generation: 1, yjs_seq: 3, yjs_write: 6 }],
    ["a NULL generation beside a sequence", { yjs_generation: null, yjs_seq: 7, yjs_write: 6 }],
    ["a generation beside a NULL sequence", { yjs_generation: 3, yjs_seq: null, yjs_write: 6 }],
    ["a malformed generation", { yjs_generation: "0", yjs_seq: 3, yjs_write: 6 }],
    ["a malformed sequence beside a valid generation", { yjs_generation: 0, yjs_seq: -1, yjs_write: 6 }],
    ["a fractional sequence beside a valid generation", { yjs_generation: 0, yjs_seq: 1.5, yjs_write: 6 }],
  ])("refuses a row carrying %s, with no coercion", async (_label, row) => {
    const socket = fakeSocket([]);
    const harness = await unmovedAt(row);
    harness.sockets.push(socket);

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(FenceRefusedError);

    expect(isHalted(harness.internals)).toBe(true);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("retries a document recovered above the row's generation, and lands with the current tags", async () => {
    let failing = true;
    const harness = makeDo(
      {
        // The state a reset that switched without landing leaves: the row is
        // honestly one generation behind the document being served.
        base: [tagged(BASE_A, 0, 0, 5)],
        rows: ONE_STORY,
        reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 6 } as BaseRowShape],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          && failing ? { changes: 0 } : undefined),
      },
      { generations: [1] },
    );
    plantStorageBase(harness.storage, 1, 0, BASE_B);

    await harness.internals.ensureDocLoaded();

    // The staged base is what is served, at the generation the switch named,
    // over a row bare-claimed from revision 5 to 6.
    expect(harness.internals.docGeneration).toBe(1);
    expect(harness.internals.docWrite).toBe(6);
    expect(tags(harness.db.issued)).toHaveLength(0);

    await expect(harness.internals.doSnapshot()).rejects.toThrow(/matched no row/);

    // A predecessor a generation below the expected one is retryable, not
    // terminal, and the revision it holds is unchanged.
    expect(isHalted(harness.internals)).toBe(false);
    expect(harness.internals.docWrite).toBe(6);

    failing = false;
    await harness.internals.doSnapshot();

    const landed = writes(harness.db.issued)
      .filter((s) => /^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(s.sql));
    expect(landed).toHaveLength(2);
    // Generation 1, sequence 0, revision 6 to 7: the retry writes the current
    // tags over the predecessor it was allowed to expect.
    expect(landed[1].binds.slice(1, 4)).toEqual([1, 1, 7]);
    expect(landed[1].binds[6]).toBe(6);
    // Seven for the blob, eight for the entity batch that follows it under the
    // revision the blob write moved to.
    expect(harness.db.batchCalls()).toBe(1);
    expect(harness.internals.docWrite).toBe(8);
    expect(harness.storage.kv.has(baseKey(1))).toBe(false);
  });

  it("refuses an unmoved row when storage names another generation", async () => {
    const socket = fakeSocket([]);
    const harness = await loadedInstance(
      {
        reacquire: [{ yjs_generation: 0, yjs_seq: 3, yjs_write: 6 } as BaseRowShape],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          ? { changes: 0 }
          : undefined),
      },
      // The row's own tags are a predecessor's; what refuses this is the
      // storage validation, which is the ownership question and not the row's.
      // Three reads answer this instance: the load's, the snapshot's early
      // exit, and re-acquisition's own — and the socket is attached after the
      // load, so no wake reads ahead of them.
      { generations: [0, 0, 4] },
    );
    harness.sockets.push(socket);

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(FenceRefusedError);

    expect(isHalted(harness.internals)).toBe(true);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("still fails the next write on the old revision when a replacement claims after the validation", async () => {
    const harness = await loadedInstance({
      // The row observed unmoved, so this snapshot retries later; the
      // replacement's claim lands after the observation and moves the revision
      // this instance still holds, so the retry's CAS matches no row.
      reacquire: [
        { yjs_generation: 0, yjs_seq: 3, yjs_write: 6 } as BaseRowShape,
        { yjs_generation: 0, yjs_seq: 3, yjs_write: 9 } as BaseRowShape,
      ],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });

    await expect(harness.internals.doSnapshot()).rejects.toThrow(/matched no row/);
    expect(harness.internals.docWrite).toBe(6);

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(FenceRefusedError);
    expect(isHalted(harness.internals)).toBe(true);
  });
});

describe("a refused fence is terminal until a reset lands", () => {
  it("refuses the next flush before any statement, and logs nothing more", async () => {
    const harness = await refusedInstance();

    expect(await harness.internals.flushSnapshotNow()).toBe(false);

    expect(harness.db.issued).toHaveLength(0);
    expect(haltLines()).toHaveLength(0);
  });

  it("closes a socket that still sends, and applies nothing", async () => {
    const socket = fakeSocket([]);
    const harness = await refusedInstance([socket]);
    socket.closes.length = 0;
    const before = storyTitle(harness.internals.ydoc);

    await harness.internals.webSocketMessage(socket, new Uint8Array([0, 2, 0]).buffer);

    expect(socket.closes).toEqual([UNAVAILABLE]);
    expect(storyTitle(harness.internals.ydoc)).toBe(before);
  });

  it("answers an upgrade 503 before accepting anything", async () => {
    const harness = await refusedInstance();

    const response = await upgrade(harness.doInstance);

    expect(response?.status).toBe(503);
    expect(harness.ctx.acceptWebSocket).not.toHaveBeenCalled();
  });

  it("names the halt on the call that entered it and on every call after", async () => {
    const harness = await loadedInstance({
      reacquire: [null],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });

    // The halt is the state, and one answer names it: a snapshot that failed for
    // any other reason still takes this route's 500.
    const entering = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));
    expect(entering.status).toBe(503);
    expect(await entering.text()).toBe("persistence_halted");

    const after = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));
    expect(after.status).toBe(503);
    expect(await after.text()).toBe("persistence_halted");
  });

  it("answers a mutating route 503 after its gate and before its first mutation", async () => {
    const harness = await refusedInstance();

    const response = await harness.doInstance.fetch(
      await signedRequest("/clear-course-markers", "clear-course-markers", { courseProjectId: 5 }),
    );

    expect(response.status).toBe(503);
    expect(harness.db.issued).toHaveLength(0);
  });

  it("answers a read-only route as usual and makes the alarm issue nothing", async () => {
    const harness = await refusedInstance();

    const count = await harness.doInstance.fetch(
      await signedRequest("/active-ws-count", "active-ws-count", undefined, "GET"),
    );
    expect(count.status).toBe(200);

    await harness.internals.alarm();
    expect(harness.db.issued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// One logging owner per refusal
// ---------------------------------------------------------------------------

/**
 * A refusal that arises while a handler is suspended on the load gate: the
 * handler has passed its first check, and the state is entered underneath it.
 */
function refuseDuringLoad(internals: Internals): void {
  internals.ensureDocLoaded = async () => {
    await Promise.resolve();
    internals.docLoaded = true;
    plantHalt(internals);
  };
}

/** An awareness message carrying one client's state. */
function awarenessMessage(): ArrayBuffer {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState({ user: { name: "editor" } });
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1); // messageAwareness
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
  );
  return encoding.toUint8Array(encoder).buffer as ArrayBuffer;
}

describe("a refusal is logged once by the one place that owns it", () => {
  it("logs the snapshot's own failed generation read, and answers /snapshot 500", async () => {
    const harness = await loadedInstance({}, { generations: [0, { throws: new Error("storage down") }] });

    const response = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("snapshot_failed");
    expect(exactBaseLines()).toEqual([`[exact-base] project ${PROJECT_ID}: generation_unreadable`]);
    expect(errors).toHaveLength(1);
  });

  it("logs the snapshot's own exhausted revision once, and never twice", async () => {
    const socket = fakeSocket([]);
    const harness = await loadedInstance({ base: [tagged(BASE_A, 0, 3, H - 2 - 1)] }, {}, [socket]);
    // The load claimed the last revision that leaves room for a snapshot; the
    // snapshot after this one does not fit.
    harness.internals.docWrite = H - 1;

    const response = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));

    expect(response.status).toBe(500);
    expect(exactBaseLines()).toEqual([`[exact-base] project ${PROJECT_ID}: revision_exhausted`]);
    expect(errors).toHaveLength(1);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("logs re-acquisition's failed storage read on the blob phase, refusing before any batch", async () => {
    const events: string[] = [];
    const harness = makeDo(
      {
        base: [tagged(BASE_A, 0, 3, 5)],
        rows: ONE_STORY,
        reacquire: [{ yjs_generation: 0, yjs_seq: 3, yjs_write: 6 } as BaseRowShape],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          ? { throws: new Error("D1_ERROR: blob write failed") }
          : undefined),
      },
      { generations: [0, 0, { throws: new Error("storage down") }] },
      [],
      events,
    );
    await harness.internals.ensureDocLoaded();
    driveOneEdit(harness.internals);
    harness.db.issued.length = 0;
    events.length = 0;

    const response = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("snapshot_failed");
    expect(exactBaseLines()).toEqual([`[exact-base] project ${PROJECT_ID}: generation_unreadable`]);
    expect(isHalted(harness.internals)).toBe(false);
    expect(harness.db.batchCalls()).toBe(0);
    expectUnsettled(harness.internals);
    // The snapshot's own fresh read succeeds; only re-acquisition's fails.
    expect(events.filter((e) => e === "storage-get" || e === "read-reacquire")).toEqual([
      "storage-get", "read-reacquire", "storage-get",
    ]);
  });

  it("logs re-acquisition's failed storage read on the batch phase, after the blob landed", async () => {
    const events: string[] = [];
    const harness = makeDo(
      {
        base: [tagged(BASE_A, 0, 3, 5)],
        rows: ONE_STORY,
        reacquire: [{ yjs_generation: 0, yjs_seq: 3, yjs_write: 7 } as BaseRowShape],
        batch: () => { throw new Error("D1_ERROR: yjs_write_guard: SQLITE_CONSTRAINT"); },
      },
      { generations: [0, 0, { throws: new Error("storage down") }] },
      [],
      events,
    );
    await harness.internals.ensureDocLoaded();
    driveOneEdit(harness.internals);
    harness.db.issued.length = 0;
    events.length = 0;

    const response = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("snapshot_failed");
    expect(exactBaseLines()).toEqual([`[exact-base] project ${PROJECT_ID}: generation_unreadable`]);
    expect(isHalted(harness.internals)).toBe(false);
    expect(harness.db.batchCalls()).toBe(1);
    expectUnsettled(harness.internals);
    // The blob lands, the batch aborts, and only re-acquisition's read fails.
    expect(events.filter((e) => e === "storage-get" || e === "read-reacquire" || e === "batch")).toEqual([
      "storage-get", "batch", "read-reacquire", "storage-get",
    ]);
  });

  it("adds no second line when the last disconnect meets a refused fence", async () => {
    const harness = await loadedInstance({
      reacquire: [null],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });

    await harness.internals.webSocketClose(fakeSocket([]), 1000);

    // One line for the halt and nothing else from the snapshot: the catch that
    // carries it recognises the class and adds nothing. (The snapshot's
    // unrelated `[shape]` reports about this fixture's config are not its.)
    expect(haltLines()).toHaveLength(1);
    expect(errors.filter((l) => l.includes("[snapshot]"))).toEqual([]);
  });

  it("suppresses /clear-course-markers' terminal line for a base the loader refused", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 9, 0, 0)] }, { generations: [0] });

    const response = await harness.doInstance.fetch(
      await signedRequest("/clear-course-markers", "clear-course-markers", { courseProjectId: 5 }),
    );

    expect(response.status).toBe(503);
    // One line per failed attempt, and none for the terminal refusal on top.
    expect(errors).toEqual(exactBaseLines());
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// A refusal that arises while a handler is suspended on the gate
// ---------------------------------------------------------------------------

describe("a refusal raised during the awaited load catches the handler past its first check", () => {
  it("closes an awareness sender with 1013, applying and relaying nothing", async () => {
    const sender = fakeSocket([]);
    const other = fakeSocket([]);
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 0)] }, {}, [sender, other]);
    harness.internals.docGeneration = 0;
    harness.internals.docLoaded = false;
    refuseDuringLoad(harness.internals);
    const before = harness.internals.awareness.getStates().size;

    await harness.internals.webSocketMessage(sender, awarenessMessage());

    expect(sender.closes).toEqual([UNAVAILABLE]);
    expect(harness.internals.awareness.getStates().size).toBe(before);
    expect(other.sent).toHaveLength(0);
  });

  it("closes a sync sender with 1013, applying and relaying nothing", async () => {
    const sender = fakeSocket([]);
    const other = fakeSocket([]);
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 0)] }, {}, [sender, other]);
    harness.internals.docGeneration = 0;
    harness.internals.docLoaded = false;
    refuseDuringLoad(harness.internals);

    await harness.internals.webSocketMessage(sender, new Uint8Array([0, 2, 0]).buffer);

    expect(sender.closes).toEqual([UNAVAILABLE]);
    expect(storyTitle(harness.internals.ydoc)).toBeUndefined();
    expect(other.sent).toHaveLength(0);
  });

  it("answers an upgrade already past its own gate 503, accepting nothing", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 0)] });
    refuseDuringLoad(harness.internals);

    const response = await upgrade(harness.doInstance);

    expect(response?.status).toBe(503);
    expect(harness.ctx.acceptWebSocket).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The wake and the message-time load
// ---------------------------------------------------------------------------

describe("a document that cannot be loaded does not keep its editors attached", () => {
  it("closes every socket with 1013 at the wake, logging once", async () => {
    const events: string[] = [];
    const bad = fakeSocket(events, 0, { closeThrows: true });
    const good = fakeSocket(events, 0);
    const harness = makeDo(
      { base: [tagged(BASE_A, 9, 0, 0)] },
      { generations: [0] },
      [bad, good],
      events,
    );
    await harness.ctx.lastGate;

    expect(exactBaseLines()).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(good.closes).toEqual([UNAVAILABLE]);
    expect(harness.internals.docLoaded).toBe(false);
  });

  it("closes the sockets when the row read itself throws at the wake", async () => {
    const socket = fakeSocket([]);
    const harness = makeDo(
      { base: [{ throws: new Error("D1_ERROR: wake read failed") }] },
      {},
      [socket],
    );
    await harness.ctx.lastGate;

    expect(socket.closes).toEqual([UNAVAILABLE]);
    expect(errors.some((l) => l.includes("hibernation-wake doc load failed"))).toBe(true);
  });

  it("logs exactly once at the message-time load, the dropped line included", async () => {
    const socket = fakeSocket([]);
    const harness = makeDo({ base: [tagged(BASE_A, 9, 0, 0)] }, { generations: [0] }, []);
    harness.sockets.push(socket);
    // The socket fence reads the cached generation, and a fresh instance has
    // not read one; without it the message never reaches the load.
    harness.internals.docGeneration = 0;

    await harness.internals.webSocketMessage(socket, new Uint8Array([0, 2, 0]).buffer);

    expect(exactBaseLines()).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("issues no statement of any kind on a wake into an unknown generation", async () => {
    const socket = fakeSocket([]);
    const harness = makeDo(
      { base: [tagged(BASE_A, 0, 0, 0)] },
      { generations: [{ throws: new Error("down") }, { throws: new Error("down") }] },
      [socket],
    );
    await harness.ctx.lastGate;

    expect(harness.db.issued).toHaveLength(0);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });
});

// ---------------------------------------------------------------------------
// The reset
// ---------------------------------------------------------------------------

/**
 * A reset run on an instance that already serves a document, so what each
 * failure class leaves behind — a populated document retained or disposed — is
 * observable at all. An unloaded instance's empty document cannot show it.
 */
async function resetHarness(
  base: Array<BaseRowShape | null | { throws: unknown }>,
  storage: StorageScript = { generations: [0] },
  overrides: Partial<DbScript> = {},
) {
  const harness = makeDo({ base, rows: ONE_STORY, ...overrides }, storage, []);
  await harness.internals.ensureDocLoaded();
  const socket = fakeSocket([]);
  harness.sockets.push(socket);
  harness.db.issued.length = 0;
  // The load's own repairs are logged, so what the load wrote is not what the
  // reset spent: the inventory starts empty at the reset's first operation.
  harness.storage.puts.length = 0;
  errors.length = 0;
  return { ...harness, socket };
}

describe("/reset leaves each failure class in exactly one state", () => {
  it.each([
    ["a generation read that fails", { generations: [0, { throws: new Error("storage down") }] }],
    ["a malformed generation", { generations: [0, -2] }],
    ["a stored null generation", { generations: [0, null] }],
    ["an exhausted generation", { generations: [0, H] }],
  ])("answers 503 to %s with the document and both flags untouched", async (_label, storage) => {
    const harness = await resetHarness([tagged(BASE_A, 0, 0, 4)], storage as StorageScript);
    plantHalt(harness.internals);

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(harness.db.issued).toHaveLength(0);
    expect(harness.storage.puts).toHaveLength(0);
    expect(harness.socket.closes).toEqual([]);
    expect(harness.internals.docLoaded).toBe(true);
    expect(storyTitle(harness.internals.ydoc)).toBe("Story A");
    expect(harness.internals.docWrite).toBe(5);
    expect(isHalted(harness.internals)).toBe(true);
  });

  it("answers 503 to a row read that fails, with the document and the halt untouched", async () => {
    const harness = await resetHarness(
      [tagged(BASE_A, 0, 0, 4), { throws: new Error("D1_ERROR: row read failed") }],
      { generations: [0, 0] },
    );
    plantHalt(harness.internals);

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(harness.db.issued).toHaveLength(0);
    expect(harness.storage.puts).toHaveLength(0);
    expect(harness.socket.closes).toEqual([]);
    expect(harness.internals.docLoaded).toBe(true);
    expect(storyTitle(harness.internals.ydoc)).toBe("Story A");
    expect(harness.internals.docWrite).toBe(5);
    expect(isHalted(harness.internals)).toBe(true);
  });

  it("answers 503 to a revision without headroom, before the put and before any write", async () => {
    const harness = await resetHarness([tagged(BASE_A, 0, 0, 4), tagged(BASE_A, 0, 0, H - 2)]);
    plantHalt(harness.internals);

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(writes(harness.db.issued)).toHaveLength(0);
    expect(harness.storage.puts).toHaveLength(0);
    expect(harness.socket.closes).toEqual([]);
    expect(storyTitle(harness.internals.ydoc)).toBe("Story A");
    expect(harness.internals.docWrite).toBe(5);
    expect(isHalted(harness.internals)).toBe(true);
  });

  it("spends nothing when the build fails, and disposes the document it destroyed", async () => {
    const harness = await resetHarness([tagged(BASE_A, 0, 0, 4), tagged(BASE_A, 0, 0, 5)]);
    plantHalt(harness.internals);
    harness.internals.buildFromD1Rows = async () => { throw new Error("D1_ERROR: rebuild failed"); };

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    // Before the staging and before the switch: no key was written, the
    // generation stands, and the D1 row was only read.
    expect(harness.storage.puts).toHaveLength(0);
    expect(harness.internals.docGeneration).toBe(0);
    expect(writes(harness.db.issued)).toHaveLength(0);
    // `replaceDocument` destroyed the served document before the build ran, so
    // the failure still owes a disposal and a close.
    expect(harness.internals.docLoaded).toBe(false);
    expect(storyTitle(harness.internals.ydoc)).toBeUndefined();
    expect(harness.socket.closes).toEqual([UNAVAILABLE]);
    // Only a landed replacement clears a halt.
    expect(isHalted(harness.internals)).toBe(true);
  });

  it("serves the old base on the load after a failed build", async () => {
    const harness = await resetHarness([tagged(BASE_A, 0, 0, 4), tagged(BASE_A, 0, 0, 5)]);
    const build = harness.internals.buildFromD1Rows.bind(harness.internals);
    let failing = true;
    harness.internals.buildFromD1Rows = async () => {
      if (failing) throw new Error("D1_ERROR: rebuild failed");
      return build();
    };

    expect((await harness.doInstance.fetch(await signedRequest("/reset", "reset"))).status).toBe(503);

    failing = false;
    await harness.internals.ensureDocLoaded();

    expect(harness.internals.docLoaded).toBe(true);
    expect(harness.internals.docGeneration).toBe(0);
    expect(storyTitle(harness.internals.ydoc)).toBe("Story A");
  });
});

/** How a replacement's own conditioned write can present without a successful acknowledgement. */
const REPLACEMENT_WRITE_OUTCOMES: Array<[string, RunOutcome]> = [
  ["the acknowledgement is lost", { changes: 0 }],
  ["the write throws", { throws: new Error("D1_ERROR: replacement failed") }],
];

describe("/reset replaces the row atomically, under the ownership rules", () => {
  it("reads the generation and the row, stages the base, then switches and writes", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    // Attached after construction: a wake would load and claim first, and this
    // is about what the reset itself does.
    const harness = makeDo({ base: [cold(4)], rows: ONE_STORY }, { generations: [2] }, [], events);
    harness.sockets.push(socket);
    // Halted under the generation this reset supersedes, which is what its
    // landed replacement clears.
    plantHalt(harness.internals, "fence_refused", 2);

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    // Two puts: the staged base's group, then the switch. Nothing names
    // `base:3` until the generation does, and the switch is issued only once
    // the whole group has resolved.
    expect(events.filter((e) => ["storage-get", "read-base", "storage-put"].includes(e))).toEqual([
      "storage-get", "read-base", "storage-put", "storage-put",
    ]);
    expect(harness.storage.puts.map(([key]) => key)).toEqual([
      "base:3:0001", "base:3", "docGeneration",
    ]);
    // And the header the staging wrote is retired by the landed replacement.
    expect(harness.storage.deletes).toEqual([["base:3"]]);
    expect(harness.storage.kv.has("base:3")).toBe(false);
    const write = baseWrites(harness.db.issued)[0];
    expect(write.binds.slice(1, 4)).toEqual([3, 0, 5]);
    expect(write.binds[6]).toBe(4);
    expect(harness.internals.docWrite).toBe(5);
    expect(harness.internals.docSeq).toBe(0);
    expect(isHalted(harness.internals)).toBe(false);
    expect(harness.internals.docLoaded).toBe(true);
    expect(errors.filter((l) => l.includes("[reset] project 42: rebuilt at generation 3, revision 5"))).toHaveLength(1);
  });

  it("answers 503 with nothing touched when the generation cannot be read", async () => {
    const socket = fakeSocket([]);
    const harness = makeDo(
      { base: [cold(4)], rows: ONE_STORY },
      { generations: [{ throws: new Error("storage down") }] },
    );
    harness.sockets.push(socket);

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(harness.db.issued).toHaveLength(0);
    expect(socket.closes).toEqual([]);
    expect(harness.internals.docWrite).toBeNull();
    expect(errors.some((l) => l.includes("rebuilt at generation"))).toBe(false);
  });

  it("answers 503 with D1 untouched and the generation unmoved when the staging throws", async () => {
    const harness = await resetHarness([tagged(BASE_A, 0, 0, 4)], {
      generations: [0],
      putThrows: new Error("storage down"),
    });
    plantHalt(harness.internals);

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(writes(harness.db.issued)).toHaveLength(0);
    // Nothing was spent: the staging is the first write a reset makes, and the
    // switch is issued only once the whole group has resolved.
    expect(harness.storage.puts).toHaveLength(0);
    expect(harness.internals.docGeneration).toBe(0);
    // The served document was destroyed to build the replacement, so it goes
    // with the failure and the editors are told to come back.
    expect(harness.internals.docLoaded).toBe(false);
    expect(harness.socket.closes).toEqual([UNAVAILABLE]);
    expect(errors.some((l) => l.includes("the staged base could not be written"))).toBe(true);
    // A reset that could not prove its ownership clears no halt.
    expect(isHalted(harness.internals)).toBe(true);
  });

  it("answers 503 with one line naming the size when the replacement is above the ceiling", async () => {
    const harness = await resetHarness([tagged(BASE_A, 0, 0, 4)]);
    const build = harness.internals.buildFromD1Rows.bind(harness.internals);
    harness.internals.buildFromD1Rows = async () => {
      await build();
      // A document whose encoded state passes the codec's ceiling: the encoder
      // refuses it before it allocates a single part.
      harness.internals.ydoc.getArray<unknown>("stories").push(["x".repeat(MAX_RECORD_BYTES + 1)]);
    };

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(harness.storage.puts).toHaveLength(0);
    expect(harness.internals.docGeneration).toBe(0);
    const named = errors.filter((l) => /project 42: the replacement of \d+ bytes is above the/.test(l));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("record ceiling");
  });

  it("disposes the document and closes the sockets when the rebuild fails before staging", async () => {
    const socket = fakeSocket([]);
    const harness = makeDo({ base: [cold(4)], rows: ONE_STORY });
    harness.sockets.push(socket);
    harness.internals.buildFromD1Rows = async () => { throw new Error("D1_ERROR: rebuild failed"); };

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    // Nothing was staged and nothing was switched: the build is what failed,
    // and it runs before either.
    expect(harness.storage.puts).toHaveLength(0);
    expect(await harness.internals.getDocGeneration()).toBe(0);
    // The document the build replaced goes all the same, and the editors are
    // told to come back to the base that still stands.
    expect(harness.internals.docLoaded).toBe(false);
    expect(socket.closes).toEqual([UNAVAILABLE]);
    expect(errors.some((l) => l.includes("rebuilt at generation"))).toBe(false);
  });

  it.each(REPLACEMENT_WRITE_OUTCOMES)(
    "adopts a replacement when %s",
    async (_label, outcome) => {
      const harness = makeDo(
        {
          base: [cold(4)],
          rows: ONE_STORY,
          reacquire: [{ yjs_generation: 1, yjs_seq: 0, yjs_write: 5 } as BaseRowShape],
          run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
            ? outcome
            : undefined),
        },
        { generations: [0] },
      );

      const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

      expect(response.status).toBe(200);
      expect(harness.internals.docWrite).toBe(5);
      expect(errors.filter((l) => l.includes("rebuilt at generation 1, revision 5"))).toHaveLength(1);
    },
  );

  it.each(REPLACEMENT_WRITE_OUTCOMES)(
    "refuses the fence when the row is no longer this instance's, and %s",
    async (_label, outcome) => {
      const harness = makeDo(
        {
          base: [cold(4)],
          rows: ONE_STORY,
          reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 5 } as BaseRowShape],
          run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
            ? outcome
            : undefined),
        },
        { generations: [0] },
      );

      const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

      expect(response.status).toBe(503);
      expect(isHalted(harness.internals)).toBe(true);
      expect(errors.some((l) => l.includes("rebuilt at generation"))).toBe(false);
    },
  );

  it.each(REPLACEMENT_WRITE_OUTCOMES)(
    "adopts a replacement at r + 1 under the new generation and clears the fence, when %s",
    async (_label, outcome) => {
      const harness = await resetHarness([tagged(BASE_A, 0, 0, 4), tagged(BASE_A, 0, 0, 5)], {
        generations: [0],
      }, {
        reacquire: [{ yjs_generation: 1, yjs_seq: 0, yjs_write: 6 } as BaseRowShape],
        run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
          ? outcome
          : undefined),
      });
      plantHalt(harness.internals, "fence_refused", 0);

      const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

      expect(response.status).toBe(200);
      expect(harness.internals.docWrite).toBe(6);
      expect(isHalted(harness.internals)).toBe(false);
    },
  );

  it("keeps a failed replacement a retryable failure when the old base is still at r", async () => {
    const harness = await resetHarness([tagged(BASE_A, 0, 0, 4), tagged(BASE_A, 0, 0, 5)], {
      generations: [0],
    }, {
      // The reset's own case: it expects the OLD generation at r and the NEW one
      // at r + 1, so an unmoved row still carrying the old tag says its
      // replacement did not land — a failure to retry, not a foreign row.
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 5 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(isHalted(harness.internals)).toBe(false);
    // Past the put: the generation is spent, so the document cannot be served.
    expect(harness.internals.docLoaded).toBe(false);
    expect(storyTitle(harness.internals.ydoc)).toBeUndefined();
    expect(harness.socket.closes).toEqual([UNAVAILABLE]);
  });

  it("settles nothing while the replacement is unresolved, and everything when it lands", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const harness = await resetHarness([tagged(BASE_A, 0, 0, 4), tagged(BASE_A, 0, 0, 5)], {
      generations: [0],
    }, {
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { hold: held }
        : undefined),
    });
    plantHalt(harness.internals, "fence_refused", 0);

    const pending = harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    for (let i = 0; i < 100 && baseWrites(harness.db.issued).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(baseWrites(harness.db.issued)).toHaveLength(1);

    // The write is the one act that proves the row is this instance's again, so
    // nothing it authorises may happen before it is acknowledged.
    expect(isHalted(harness.internals)).toBe(true);
    expect(harness.internals.docWrite).toBeNull();
    expect(harness.internals.docLoaded).toBe(false);

    release();
    expect((await pending).status).toBe(200);
    expect(isHalted(harness.internals)).toBe(false);
    expect(harness.internals.docWrite).toBe(6);
    expect(harness.internals.docSeq).toBe(0);
  });

  it("succeeds with a halt the rebuild raised under the new generation still standing", async () => {
    const harness = makeDo({ base: [cold(4)], rows: ONE_STORY }, { generations: [0] });
    plantHalt(harness.internals, "fence_refused", 0);
    const build = harness.internals.buildFromD1Rows.bind(harness.internals);
    harness.internals.buildFromD1Rows = async () => {
      await build();
      // The rebuilt document raises a halt of its own, under the generation the
      // reset has already advanced to: a different halt from the one this reset
      // supersedes, and nothing has replaced the document it names.
      plantHalt(harness.internals, "enforcement_failed", 1);
    };

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(harness.internals.persistenceHalted).toMatchObject({
      generation: 1,
      marker: { reason: "enforcement_failed" },
    });
  });
});

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedRequest(
  path: string,
  action: string,
  body?: unknown,
  method = "POST",
): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, TEST_SECRET, action);
  return new Request(`https://internal${path}`, {
    method,
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(PROJECT_ID),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function mintToken(): Promise<string> {
  const enc = new TextEncoder();
  const payload = base64urlEncode(
    enc.encode(JSON.stringify({ userId: USER_ID, createdAt: new Date().toISOString() })),
  );
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(TEST_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${base64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Drive one upgrade. Node cannot build the 101 the admitted path returns, so
 * the error it throws there is swallowed — everything the handshake does has
 * already happened by then.
 */
async function upgrade(doInstance: ProjectCollaborationDO): Promise<Response | null> {
  const socket = fakeSocket([]);
  (globalThis as Record<string, unknown>).WebSocketPair = function () {
    return { 0: socket, 1: socket };
  };
  const token = await mintToken();
  const request = new Request(
    `https://internal/ws/${PROJECT_ID}?token=${token}&gen=new`,
    { headers: { Upgrade: "websocket" } },
  );
  return doInstance.fetch(request).catch(() => null);
}
