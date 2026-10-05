/**
 * The load's phases, the paged replay, and the halt made durable.
 *
 * A load reads the row, the generation, the halt marker and the storage base,
 * then claims the row, applies the base, replays the log by pages, runs the
 * repairs with logging enabled, and opens. A halt is one durable marker per
 * generation that an eviction cannot forget. And the guard's effects — the
 * corrected broadcast and the close it issues — are held until the write that
 * records what the document holds has been issued, so nothing a halt discards
 * has already reached a peer.
 *
 * And the write itself: every accepted message is one group — the raw payload
 * and every non-socket transaction it provoked — issued before the drain lets
 * any of it reach a peer; every transaction outside a message is a record of
 * its own; an update the codec could not store is refused before it is applied;
 * and a record that cannot be written halts the document rather than letting a
 * mutation it does not hold be persisted.
 *
 * And the fold: the tail above the exact base counted as it grows, the alarm
 * that writes a storage base for it inside one transaction and retires the log
 * below it, the cleanup a bounded retirement leaves owed and the derivation
 * that finds it again from storage and the row, and the durable identity
 * binding that lets a socketless alarm name the row at all.
 *
 * The fake context here proves the object's branching, its ordering and its
 * socket behaviour against scripted storage, scripted statement results and a
 * codec that can be told to refuse one named record. It
 * proves nothing about workerd's storage or D1: that is
 * `tests/workers/persistence-halt.test.ts`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";

// Every apply the document takes, in order. A native ESM namespace is not
// configurable, so the module is re-exported with `applyUpdate` wrapped: the
// DO's own import and this file's both reach the same recorder.
const applies = vi.hoisted(() => ({ recording: false, updates: [] as Uint8Array[] }));
vi.mock("yjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yjs")>();
  return {
    ...actual,
    applyUpdate: (doc: unknown, update: Uint8Array, origin?: unknown) => {
      if (applies.recording) applies.updates.push(update);
      return (actual.applyUpdate as (...a: unknown[]) => unknown)(doc, update, origin);
    },
  };
});

// The codec's encoder, with one key it can be told to refuse. A record the
// codec cannot encode is the failure that must not leave part of a group
// behind, and nothing in the object's own inputs produces it at a chosen
// record. The module is re-exported so the DO's import and this file's are the
// same one; everything else, the error classes included, is the original.
const encodings = vi.hoisted(() => ({ refuse: null as string | null }));
vi.mock("../workers/doc-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workers/doc-log")>();
  return {
    ...actual,
    // Every argument is forwarded: the part limit the third parameter carries
    // is what the parted fixtures rely on.
    encodeRecord: (...args: Parameters<typeof actual.encodeRecord>) => {
      if (encodings.refuse === args[0]) throw new RangeError(`record ${args[0]} refused`);
      return actual.encodeRecord(...args);
    },
  };
});

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
import { checkD1Bind } from "./helpers/d1-memory";
import {
  ExactBaseError,
  PersistenceHaltedError,
  baseKey,
  encodeBase,
  encodeHalt,
  encodeRecord,
  haltKey,
  logKey,
  logPrefix,
  readBase,
  readRecord,
  MAX_RECORD_BYTES,
  MAX_SEQ,
  type LogListOptions,
  type LogStorage,
  type RecordHeader,
} from "../workers/doc-log";
import type { TimeLedger, WordBaseline, WordsByRow } from "../workers/contribution-metrics";
import type { EditsByPath } from "../workers/collaboration-helpers";

const PROJECT_ID = 42;
/** The storage key the durable identity binding stands at. */
const PROJECT_ID_KEY = "projectId";
const USER_ID = 7;
const OTHER_USER = 9;
const TEST_SECRET = "test-session-secret";
const UNAVAILABLE = { code: 1013, reason: "Try again later" };
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** A document holding one story, encoded as a base would be. */
function storyDoc(title: string, id = 11, createdBy: number | null = null): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("_id", id);
    story.set("story_id", `s${id}`);
    story.set("title", new Y.Text(title));
    story.set("order_key", "a0");
    if (createdBy !== null) story.set("created_by", createdBy);
    doc.getArray<Y.Map<unknown>>("stories").push([story]);
  }, null);
  return doc;
}

function storyBlob(title: string, id = 11): Uint8Array {
  return Y.encodeStateAsUpdate(storyDoc(title, id));
}

const BASE_A = storyBlob("Story A");
const BASE_STORAGE = storyBlob("Story in storage", 21);

/** The update one edit to a fresh document produces, as raw bytes. */
function recordBytes(seed: Uint8Array, edit: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, seed);
  const before = Y.encodeStateVector(doc);
  doc.transact(() => edit(doc), null);
  return Y.encodeStateAsUpdate(doc, before);
}

function titleOf(doc: Y.Doc, index = 0): string | undefined {
  const stories = doc.getArray<Y.Map<unknown>>("stories");
  return stories.length <= index ? undefined : String(stories.get(index).get("title"));
}

function titles(doc: Y.Doc): string[] {
  return doc.getArray<Y.Map<unknown>>("stories").toArray().map((m) => String(m.get("title")));
}

// ---------------------------------------------------------------------------
// The fake storage: a Map the codec can be written into and read back from
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();

function byteCompare(a: string, b: string): number {
  const left = utf8.encode(a);
  const right = utf8.encode(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

function inBounds(key: string, options: LogListOptions): boolean {
  if (options.prefix !== undefined && !key.startsWith(options.prefix)) return false;
  if (options.startAfter !== undefined && byteCompare(key, options.startAfter) <= 0) return false;
  if (options.end !== undefined && byteCompare(key, options.end) >= 0) return false;
  return true;
}

interface StorageOptions {
  /** Rejects the nth `get` of a listed key kind, once. */
  failOn?: (kind: string, nth: number) => Error | undefined;
  /** Thrown SYNCHRONOUSLY by `put`, which is what a broken binding does. */
  putThrows?: unknown;
  /**
   * Thrown SYNCHRONOUSLY by the nth `put`, chosen from the exact keys it
   * carries: the seam a group whose LATER batch fails needs, since a group is
   * issued as several batches and only one of them is made to throw.
   */
  putThrowsOn?: (keys: string[], nth: number) => unknown | undefined;
  /** Rejects the promise `put` returns. */
  putRejects?: unknown;
  /**
   * Rejects the nth `put`, chosen from the exact keys it carries — the seam a
   * partial group needs, since a group is issued as several batches and only
   * one of them is made to fail.
   */
  putFails?: (keys: string[], nth: number) => unknown | undefined;
  /**
   * Holds the nth `put` until the returned promise resolves, with the keys
   * applied only then: what a caller does ACROSS a pending staging is the
   * question wherever the switch is claimed to sit behind it.
   */
  holdPut?: (keys: string[], nth: number) => Promise<void> | undefined;
  /** Rejects the nth `delete`, chosen from the exact keys it carries. */
  deleteFails?: (keys: string[], nth: number) => unknown | undefined;
  /**
   * Holds the nth `delete` until the returned promise resolves, with the keys
   * already applied or not as the test chooses: what a caller does ACROSS a
   * pending deletion is the question wherever an awaited retirement is claimed.
   */
  holdDelete?: (keys: string[], nth: number) => Promise<void> | undefined;
  /** Thrown synchronously by `getAlarm`, which the alarm scheduling reads. */
  alarmGetThrows?: unknown;
  /** Thrown synchronously by `deleteAlarm`. */
  alarmThrows?: unknown;
  /** Rejects the promise `deleteAlarm` returns. */
  alarmRejects?: unknown;
  /** Rejects the promise `setAlarm` returns. */
  setAlarmRejects?: unknown;
}

/** Storage the codec can write into, with every access recorded in order. */
class FakeStorage {
  readonly kv = new Map<string, unknown>();
  readonly events: string[];
  /** The exact keys of every `put`, one entry per call, so batch sizes count. */
  readonly putBatches: string[][] = [];
  /** The exact keys of every `delete`, one entry per call. */
  readonly deleteBatches: string[][] = [];
  /**
   * Every listing's options as they were passed, in order.
   *
   * Every option, not the two a prefix sweep needs: a bound the caller is
   * claimed to carry can only be read off the call that carried it, and a
   * recorder that keeps a subset cannot refuse a listing that dropped one.
   */
  readonly lists: LogListOptions[] = [];
  /** Every deadline `setAlarm` was given, in order. */
  readonly alarms: number[] = [];
  private counts = new Map<string, number>();
  private putCount = 0;
  private deleteCount = 0;
  private alarmAt: number | null = null;
  /**
   * Which instance's storage access is live. A held operation captures it when
   * it is issued and applies only if it still stands when it is released.
   */
  private epoch = 0;

  constructor(events: string[], private opts: StorageOptions = {}) {
    this.events = events;
  }

  /**
   * Put the scripted seams in place from here on, leaving every access count as
   * it stands.
   *
   * A load writes records of its own — the repairs are logged — so a fixture
   * that wants a put to fail for the MESSAGE it is about cannot arm that failure
   * before the load without failing the load instead. The write counters start
   * again, so a script naming the nth put or delete names the fixture's own;
   * the READ counts are kept, because a script naming the nth read of a kind is
   * counting the load's reads deliberately.
   */
  arm(opts: StorageOptions): void {
    this.opts = opts;
    this.putCount = 0;
    this.deleteCount = 0;
  }

  /**
   * Forget the deadline, so a fixture opens with no alarm pending.
   *
   * A pending alarm makes `scheduleSnapshot` a no-op, and a test that reads
   * "the alarm was armed" off the absence of a `set-alarm` event would pass on
   * the strength of the load's own arming rather than the message's.
   */
  disarmAlarm(): void {
    this.alarmAt = null;
  }

  /**
   * Revoke the storage access every operation issued so far holds.
   *
   * An evicted object's pending writes do not land on the storage its
   * successor reads, so a recovery simulation that releases a held deletion
   * after the eviction must see that deletion apply nothing. Operations issued
   * from here on are the next instance's and apply as usual.
   */
  invalidate(): void {
    this.epoch += 1;
  }

  private kindOf(key: string): string {
    if (key === "docGeneration") return "generation";
    if (key.startsWith("halt:")) return "halt";
    if (key.startsWith("base:")) return "base";
    if (key.startsWith("log:")) return "log";
    return "other";
  }

  private note(kind: string): Error | undefined {
    const nth = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, nth);
    this.events.push(`get:${kind}`);
    return this.opts.failOn?.(kind, nth);
  }

  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  get(keyOrKeys: string | string[]): Promise<unknown> {
    if (Array.isArray(keyOrKeys)) {
      const failure = this.note(`${this.kindOf(keyOrKeys[0] ?? "")}-parts`);
      if (failure) return Promise.reject(failure);
      const found = new Map<string, unknown>();
      for (const key of keyOrKeys) {
        if (this.kv.has(key)) found.set(key, this.kv.get(key));
      }
      return Promise.resolve(found);
    }
    const failure = this.note(this.kindOf(keyOrKeys));
    if (failure) return Promise.reject(failure);
    return Promise.resolve(this.kv.get(keyOrKeys));
  }

  list<T = unknown>(options: LogListOptions = {}): Promise<Map<string, T>> {
    this.lists.push({
      prefix: options.prefix,
      start: options.start,
      startAfter: options.startAfter,
      end: options.end,
      limit: options.limit,
      reverse: options.reverse,
    });
    const failure = this.note("list");
    if (failure) return Promise.reject(failure);
    let keys = [...this.kv.keys()].filter((key) => inBounds(key, options));
    keys.sort(byteCompare);
    if (options.reverse) keys.reverse();
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    const page = new Map<string, unknown>();
    for (const key of keys) page.set(key, this.kv.get(key));
    return Promise.resolve(page as unknown as Map<string, T>);
  }

  put(entries: Record<string, unknown>): Promise<void>;
  put(key: string, value: unknown): Promise<void>;
  put(entriesOrKey: Record<string, unknown> | string, value?: unknown): Promise<void> {
    const entries = typeof entriesOrKey === "string"
      ? { [entriesOrKey]: value }
      : entriesOrKey;
    const keys = Object.keys(entries);
    this.putBatches.push(keys);
    this.events.push(`put:${keys.map((k) => this.kindOf(k)).join(",")}`);
    this.putCount += 1;
    // "in" rather than a value check, so a scripted `putThrows: undefined`
    // still throws — the sentinel a caller must not mistake for "no failure".
    if ("putThrows" in this.opts) throw this.opts.putThrows;
    const thrown = this.opts.putThrowsOn?.(keys, this.putCount);
    if (thrown !== undefined) throw thrown;
    if (this.opts.putRejects !== undefined) return Promise.reject(this.opts.putRejects);
    const chosen = this.opts.putFails?.(keys, this.putCount);
    if (chosen !== undefined) return Promise.reject(chosen);
    const held = this.opts.holdPut?.(keys, this.putCount);
    const issuedAt = this.epoch;
    const apply = () => {
      if (issuedAt !== this.epoch) return;
      for (const [key, entry] of Object.entries(entries)) this.kv.set(key, entry);
    };
    if (held === undefined) {
      apply();
      return Promise.resolve();
    }
    return held.then(apply);
  }

  delete(keys: string[]): Promise<number> {
    this.deleteBatches.push([...keys]);
    this.events.push("delete");
    this.deleteCount += 1;
    const chosen = this.opts.deleteFails?.(keys, this.deleteCount);
    if (chosen !== undefined) return Promise.reject(chosen);
    const held = this.opts.holdDelete?.(keys, this.deleteCount);
    const issuedAt = this.epoch;
    const apply = () => {
      if (issuedAt !== this.epoch) return 0;
      let removed = 0;
      for (const key of keys) {
        if (this.kv.delete(key)) removed++;
      }
      return removed;
    };
    return held === undefined ? Promise.resolve(apply()) : held.then(apply);
  }

  getAlarm(): Promise<number | null> {
    if (this.opts.alarmGetThrows !== undefined) throw this.opts.alarmGetThrows;
    return Promise.resolve(this.alarmAt);
  }

  setAlarm(at: number): Promise<void> {
    this.events.push("set-alarm");
    if (this.opts.setAlarmRejects !== undefined) {
      return Promise.reject(this.opts.setAlarmRejects);
    }
    this.alarmAt = at;
    this.alarms.push(at);
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.events.push("delete-alarm");
    if (this.opts.alarmThrows !== undefined) throw this.opts.alarmThrows;
    if (this.opts.alarmRejects !== undefined) return Promise.reject(this.opts.alarmRejects);
    this.alarmAt = null;
    return Promise.resolve();
  }

  /**
   * Run a closure over this storage and keep what it wrote only if it settled.
   *
   * A fake of the runtime's own transaction, and no more than that: every
   * access the closure makes is recorded exactly as an ungated one is, and a
   * throw or a rejection from inside restores the map to what it held before
   * the closure began. What this can show is the CALLER's rollback contract —
   * that a group whose later batch throws leaves the previous base whole. What
   * it cannot show is the platform's atomicity, which the Workers project
   * holds.
   */
  async transaction<T>(closure: (txn: FakeStorage) => Promise<T>): Promise<T> {
    this.events.push("transaction");
    const before = new Map(this.kv);
    try {
      return await closure(this);
    } catch (err) {
      this.kv.clear();
      for (const [key, value] of before) this.kv.set(key, value);
      throw err;
    }
  }
}

/** Plant what a generation's storage holds, through the codec that writes it. */
function plantMarker(storage: FakeStorage, generation: number, reason: string): void {
  for (const [key, value] of Object.entries(encodeHalt(generation, reason))) {
    storage.kv.set(key, value);
  }
}

function plantBase(
  storage: FakeStorage,
  generation: number,
  seq: number,
  bytes: Uint8Array,
): void {
  for (const [key, value] of Object.entries(encodeBase(generation, seq, bytes))) {
    storage.kv.set(key, value);
  }
}

function plantRecord(
  storage: FakeStorage,
  generation: number,
  seq: number,
  bytes: Uint8Array,
): void {
  for (const [key, value] of Object.entries(encodeRecord(logKey(generation, seq), bytes))) {
    storage.kv.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// The fake D1
// ---------------------------------------------------------------------------

interface BaseRowShape {
  yjs_state: Uint8Array | null;
  yjs_generation: number | null | unknown;
  yjs_seq: number | null | unknown;
  yjs_write: number | unknown;
}

function tagged(blob: Uint8Array, generation: number, seq: number, revision: number): BaseRowShape {
  return { yjs_state: blob, yjs_generation: generation, yjs_seq: seq, yjs_write: revision };
}

function untagged(blob: Uint8Array, revision = 0): BaseRowShape {
  return { yjs_state: blob, yjs_generation: null, yjs_seq: null, yjs_write: revision };
}

function cold(revision = 0): BaseRowShape {
  return { yjs_state: null, yjs_generation: null, yjs_seq: null, yjs_write: revision };
}

interface Issued {
  sql: string;
  binds: unknown[];
}

type RunOutcome = { changes: number } | { throws: unknown };

interface DbScript {
  base?: Array<BaseRowShape | null | { throws: unknown }>;
  reacquire?: Array<BaseRowShape | null | { throws: unknown }>;
  run?: (sql: string, binds: unknown[], nth: number) => RunOutcome | undefined;
  batch?: (statements: Issued[], nth: number) => void | Promise<void>;
  rows?: Record<string, unknown[]>;
  /** Rejects the SELECT the editing-time seed makes. */
  stampReadFails?: () => boolean;
  /**
   * Hold a matching statement until the returned promise resolves, and execute
   * it only then.
   *
   * The awaited standalone-statement seam: what a caller does ACROSS a pending
   * statement cannot be asked of a fake that has already applied it, and the
   * window this step closes is exactly the gap between a committed INSERT and
   * the blob write that claims it.
   */
  holdRun?: (sql: string, binds: unknown[], nth: number) => Promise<void> | undefined;
  /** What an INSERT's `last_row_id` answers, so a backfilled id is a distinct one. */
  lastRowId?: number;
  /**
   * The `projects` row as a value that changes: both reads answer from it and
   * every conditioned write applies to it when its own condition holds.
   *
   * A scripted answer says what one read returns; this says what the row IS,
   * which is what a recovery case needs — a load after a reset that did not
   * land has to read what that reset left, not a second scripted answer.
   */
  row?: BaseRowShape;
  /**
   * What the cleanup floor's metadata query answers, when the fixture wants
   * something other than the live row: a shape out of domain, a NULL blob, a
   * missing row, or a rejection.
   */
  metadata?: () => Record<string, unknown> | null | { throws: unknown };
}

/**
 * The fake D1, counting reads and mutations in inventories of their own.
 *
 * A SELECT is not a statement the mutation inventory can answer for, so `all()`
 * and `first()` are recorded in `reads` and `run()`/`batch()` in `mutations`: a
 * "no statement" assertion has to name the inventory it means, or it asserts
 * over a list the statement was never going to reach.
 */
function makeDb(script: DbScript, events: string[]) {
  const mutations: Issued[] = [];
  const reads: Issued[] = [];
  const base = [...(script.base ?? [cold()])];
  const reacquire = [...(script.reacquire ?? [])];
  const live = script.row === undefined ? undefined : { ...script.row };
  let runCount = 0;
  let batchCount = 0;
  let stampReads = 0;

  /**
   * Apply one conditioned statement to the live row, or answer `undefined` when
   * there is no live row to apply it to.
   *
   * Only the revision condition is evaluated, because it is the one every
   * writer here shares and the one the fence turns on; the tag conditions the
   * bootstrap statements carry are the migration's to enforce, and
   * `tests/yjs-write-fence.test.ts` holds them against real SQLite.
   */
  function applyToLive(sql: string, binds: unknown[]): { changes: number } | undefined {
    if (live === undefined || !/^UPDATE projects SET /.test(sql)) return undefined;
    const held = binds[binds.length - 1];
    if (held !== live.yjs_write) return { changes: 0 };
    if (/SET yjs_write = \?/.test(sql)) {
      live.yjs_write = binds[0] as number;
      return { changes: 1 };
    }
    if (/SET yjs_generation = \?, yjs_seq = 0/.test(sql)) {
      live.yjs_generation = binds[0] as number;
      live.yjs_seq = 0;
      live.yjs_write = binds[1] as number;
      return { changes: 1 };
    }
    if (/SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)) {
      live.yjs_state = binds[0] as Uint8Array;
      live.yjs_generation = binds[1] as number;
      live.yjs_seq = binds[2] as number;
      live.yjs_write = binds[3] as number;
      return { changes: 1 };
    }
    if (/SET yjs_state = \?, yjs_generation = \?, yjs_seq = 0/.test(sql)) {
      live.yjs_state = binds[0] as Uint8Array;
      live.yjs_generation = binds[1] as number;
      live.yjs_seq = 0;
      live.yjs_write = binds[2] as number;
      return { changes: 1 };
    }
    return undefined;
  }

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
        mutations.push({ sql, binds });
        events.push(`run:${sql.slice(0, 34)}`);
        runCount += 1;
        const held = script.holdRun?.(sql, binds, runCount);
        // Before the statement is evaluated, never after: a caller released
        // into a row another instance has moved has to meet the row as it
        // stands then.
        if (held !== undefined) await held;
        const scripted = script.run?.(sql, binds, runCount);
        if (scripted !== undefined && "throws" in scripted) throw scripted.throws;
        const outcome = scripted ?? applyToLive(sql, binds) ?? { changes: 1 };
        return {
          meta: { last_row_id: script.lastRowId ?? 1, changes: outcome.changes },
          success: true as const,
        };
      },
      async all<T = unknown>() {
        reads.push({ sql, binds });
        if (/last_change_at/.test(sql)) {
          stampReads += 1;
          events.push("read-stamps");
          if (script.stampReadFails?.()) throw new Error("D1_ERROR: stamp read failed");
        }
        return { results: ((script.rows ?? {})[tableOf(sql)] ?? []) as T[], success: true as const };
      },
      async first<T = unknown>() {
        reads.push({ sql, binds });
        if (/^SELECT yjs_state/.test(sql)) {
          events.push("read-base");
          if (live !== undefined) return { ...live } as T;
          const answer = nextFrom(base, "base row");
          if (answer && typeof answer === "object" && "throws" in answer) throw answer.throws;
          return answer as T | null;
        }
        // The cleanup floor's metadata query, which reads the same first two
        // columns as the re-acquisition's and is a different question: it asks
        // whether the row is a base, and the presence of the blob is the third
        // column that says so.
        if (/^SELECT yjs_generation, yjs_seq, yjs_state IS NOT NULL/.test(sql)) {
          events.push("read-metadata");
          if (script.metadata !== undefined) {
            const answer = script.metadata();
            if (answer && typeof answer === "object" && "throws" in answer) throw answer.throws;
            return answer as T | null;
          }
          if (live === undefined) return null;
          return {
            yjs_generation: live.yjs_generation,
            yjs_seq: live.yjs_seq,
            has_blob: live.yjs_state === null ? 0 : 1,
          } as T;
        }
        if (/^SELECT yjs_generation/.test(sql)) {
          events.push("read-reacquire");
          if (live !== undefined && reacquire.length === 0) {
            const { yjs_generation, yjs_seq, yjs_write } = live;
            return { yjs_generation, yjs_seq, yjs_write } as T;
          }
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
    mutations,
    reads,
    /** The row as it now stands, for a test that asserts on what a write left. */
    row: () => live,
    clear() {
      mutations.length = 0;
      reads.length = 0;
    },
    stampReads: () => stampReads,
    batchCalls: () => batchCount,
    DB: {
      prepare,
      async batch(statements: Array<Issued & { boundArgs?: unknown[] }>) {
        batchCount += 1;
        events.push("batch");
        mutations.push({ sql: "BATCH", binds: statements.map((s) => s.sql) });
        for (const s of statements) mutations.push({ sql: s.sql, binds: s.boundArgs ?? s.binds });
        // Awaited, so a script can hold the batch in flight and act while it is:
        // what a caller does across a pending write is the whole question in the
        // settlement and eager-flush cases.
        await script.batch?.(statements, batchCount);
        return statements.map(() => ({ success: true }));
      },
    },
  };
}

/**
 * A batch the test holds in flight: `issued` resolves when the caller reached
 * it, and the write completes only when the test says so.
 *
 * What a caller does ACROSS a pending write is the question in the settlement
 * and eager-flush cases, and it cannot be asked of a fake that has already
 * returned.
 */
function heldBatch() {
  let reached!: () => void;
  let land!: () => void;
  let fail!: (err: unknown) => void;
  const issued = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve, reject) => { land = resolve; fail = reject; });
  return {
    issued,
    release: () => land(),
    refuse: (err: unknown) => fail(err),
    hold: () => {
      reached();
      return gate;
    },
  };
}

// ---------------------------------------------------------------------------
// Sockets and the instance
// ---------------------------------------------------------------------------

function fakeSocket(
  events: string[],
  opts: { userId?: number; generation?: number; closeThrows?: boolean; sendThrows?: boolean } = {},
) {
  const attachment = {
    userId: opts.userId ?? USER_ID,
    projectId: PROJECT_ID,
    role: "collaborator",
    generation: opts.generation ?? 0,
    // Admitted just now, so the membership recheck is not yet due.
    membershipCheckedAt: Date.now(),
  };
  const closes: Array<{ code: number; reason: string }> = [];
  const sent: Uint8Array[] = [];
  return {
    attachment,
    closes,
    sent,
    send: (data: Uint8Array) => {
      events.push("send");
      if (opts.sendThrows) throw new Error("socket gone");
      sent.push(data);
    },
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
  identityBound: number | null;
  docLoaded: boolean;
  docGeneration: number | null;
  docSeq: number | null;
  docWrite: number | null;
  baseSeq: number | null;
  logBytes: Array<{ seq: number; bytes: number }>;
  logBytesSinceBase: number;
  noteRecordWritten: (seq: number, bytes: number) => void;
  compactionPolicy: { records: number; bytes: number; ceiling: number; partLimit?: number };
  bindProjectIdFromMarker: (request: Request) => Promise<Response | null>;
  logSuppressed: boolean;
  messageFailed: boolean;
  revertedThisMessage: boolean;
  persistenceHalted: { generation: number; marker: { reason: string; at: number } } | null;
  timeSeeded: boolean;
  settleEpoch: number;
  ydoc: Y.Doc;
  ctx: { storage: unknown };
  awareness: awarenessProtocol.Awareness;
  newSessions: Set<number>;
  activityEmitted: Map<number, Set<string>>;
  userFieldSets: Map<number, Set<string>>;
  lastEditAt: Map<number, string>;
  editsByPath: EditsByPath;
  timeLedger: TimeLedger;
  wordsByRow: WordsByRow;
  wordBaseline: WordBaseline;
  stagedEffects: {
    sends: Array<{ ws: unknown; msg: Uint8Array }>;
    closes: Array<{ ws: unknown; code: number; reason: string }>;
  };
  displacements: { size: () => number; record: (ranges: unknown) => void };
  socketMayReachDocument: (ws: unknown) => number | null;
  drainStagedEffects: () => boolean;
  abandonAttribution: () => void;
  seedEditingTime: () => Promise<void>;
  flushActivityRows: () => Promise<void>;
  ensureDocLoaded: () => Promise<void>;
  applyBase: (bytes: Uint8Array, generation: number) => void;
  replaceDocument: () => void;
  seedWordBaseline: () => void;
  announceReset: () => void;
  landReplacement: (
    generation: number,
    revision: number,
    blob: Uint8Array,
    progress: { at: string; step: string },
  ) => Promise<unknown>;
  installReplacement: (
    generation: number,
    revision: number,
    progress: { at: string; step: string },
  ) => Promise<void>;
  doSnapshot: () => Promise<void>;
  retireLogBelow: (
    generation: number,
    seq: number,
  ) => Promise<{ outcome: string; deleted: number }>;
  snapshotToD1: () => Promise<void>;
  buildFromD1Rows: () => Promise<void>;
  backfillBlobGaps: () => Promise<void>;
  runPostLoadRepairs: () => Promise<void>;
  alarm: () => Promise<void>;
  snapshotRetirement: {
    outcome: string;
    deleted: number;
    lists: number;
    deleteCalls: number;
    firstDeleted: string | null;
    lastDeleted: string | null;
  } | null;
  scheduleAfterAlarm: (
    slice: { floor: number; pending: boolean; rejected: boolean; lists: number; deleted: number },
    turn: { owed: boolean; rejected: boolean },
    generation: number,
  ) => Promise<string>;
  webSocketMessage: (ws: unknown, message: ArrayBuffer) => Promise<void>;
  fetch: (request: Request) => Promise<Response>;
}

function makeDo(
  db: DbScript = {},
  storageOpts: StorageOptions = {},
  sockets: FakeSocket[] = [],
  events: string[] = [],
  /**
   * Whether the fixture establishes the identity for the instance it builds.
   * False leaves an object that knows nothing about its project, which is what
   * the identity cases are about and what a socketless wake actually holds.
   */
  bind = true,
) {
  const dbFake = makeDb(db, events);
  const storage = new FakeStorage(events, storageOpts);
  storage.kv.set("docGeneration", 0);
  const ctx = {
    getWebSockets: () => sockets,
    lastGate: Promise.resolve() as Promise<unknown>,
    /** One entry per gate opened, and the deepest nesting reached. */
    gates: 0,
    depth: 0,
    maxDepth: 0,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      ctx.gates += 1;
      ctx.depth += 1;
      ctx.maxDepth = Math.max(ctx.maxDepth, ctx.depth);
      const gate = fn().finally(() => { ctx.depth -= 1; });
      ctx.lastGate = gate;
      return gate;
    },
    storage,
    acceptWebSocket: vi.fn(),
  };
  const env = {
    DB: dbFake.DB as unknown,
    SESSION_SECRET: TEST_SECRET,
    COLLABORATION: {} as unknown,
  } as unknown as Env;
  const doInstance = new ProjectCollaborationDO(ctx as unknown as DurableObjectState, env);
  const internals = doInstance as unknown as Internals;
  if (bind) bindThroughMarker(internals, storage, events);
  return { doInstance, internals, db: dbFake, storage, ctx, env, events, sockets };
}

/**
 * The signed internal routes' own binding, as a fixture step.
 *
 * The id is never assigned onto the instance. Every path that establishes one
 * in production also leaves the durable binding behind it, and a fixture that
 * skipped that would let a socketless alarm read a row it could not have named.
 * The binding's own put is then taken back out of the inventories, exactly as
 * the load's records are: what a fixture did to reach its starting state is not
 * what the test is about.
 */
function bindThroughMarker(internals: Internals, storage: FakeStorage, events: string[]): void {
  void internals.bindProjectIdFromMarker(
    new Request("https://internal/marker", {
      headers: { "X-Internal-Project": String(PROJECT_ID) },
    }),
  );
  dropIdentityTrace(storage, events);
}

/** Take every `projectId` put, and one `put:other` for each, out of the trace. */
function dropIdentityTrace(storage: FakeStorage, events: string[]): void {
  for (;;) {
    const at = storage.putBatches.findIndex(
      (keys) => keys.length === 1 && keys[0] === PROJECT_ID_KEY,
    );
    if (at < 0) return;
    storage.putBatches.splice(at, 1);
    const event = events.indexOf("put:other");
    if (event >= 0) events.splice(event, 1);
  }
}

/**
 * A fresh instance over the same storage and D1: what an eviction leaves behind
 * is exactly what the next instance has to work from, and an instance that
 * kept its own state could not show it.
 */
async function reviveOn(harness: ReturnType<typeof makeDo>) {
  const doInstance = new ProjectCollaborationDO(
    harness.ctx as unknown as DurableObjectState,
    harness.env,
  );
  // The wake's own gated load, when a socket is still attached: awaited here so
  // a test never observes a half-run load beside its own.
  await harness.ctx.lastGate;
  const internals = doInstance as unknown as Internals;
  bindThroughMarker(internals, harness.storage, harness.events);
  return { ...harness, doInstance, internals };
}

/**
 * A fresh instance over the same storage and D1 with NO identity established.
 *
 * What a socketless wake actually holds: the object knows nothing but its own
 * storage, and whether it can name its project is the durable binding's answer
 * rather than a fixture's.
 */
async function reviveWithoutIdentity(harness: ReturnType<typeof makeDo>) {
  const doInstance = new ProjectCollaborationDO(
    harness.ctx as unknown as DurableObjectState,
    harness.env,
  );
  await harness.ctx.lastGate;
  return { ...harness, doInstance, internals: doInstance as unknown as Internals };
}

/** An instance serving a tagged base at (0, 0), with its socket attached. */
async function loaded(
  db: Partial<DbScript> = {},
  storageOpts: StorageOptions = {},
  sockets: FakeSocket[] = [],
  events: string[] = [],
) {
  const harness = makeDo(
    { base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY, ...db },
    // The read-side seams are armed for the load, since a script that names the
    // nth read of a kind is counting the load's own; the write-side ones are
    // armed after it, so a failure meant for the fixture's message does not
    // fail the record the load's repairs write.
    { failOn: storageOpts.failOn },
    sockets,
    events,
  );
  await harness.internals.ensureDocLoaded();
  // The record the load wrote arms the alarm through a promise, so the arming
  // lands a microtask after the load returns: without this the fixture's own
  // ordered record would carry it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.storage.arm(storageOpts);
  // The load writes one record of its own — `backfillBlobGaps` seeds the two
  // config toggles under a null origin — so the inventories start empty at the
  // first thing the fixture does.
  harness.storage.putBatches.length = 0;
  harness.storage.deleteBatches.length = 0;
  harness.storage.lists.length = 0;
  harness.storage.alarms.length = 0;
  harness.storage.disarmAlarm();
  harness.db.clear();
  events.length = 0;
  return harness;
}

const ONE_STORY = {
  stories: [{ id: 11, story_id: "s11", title: "Story A", order: 0, order_key: "a0" }],
};

function writes(issued: Issued[]): Issued[] {
  return issued.filter((s) => /^UPDATE projects|^INSERT INTO yjs_write_guard|^DELETE FROM yjs_write_guard/.test(s.sql));
}

function claims(issued: Issued[]): Issued[] {
  return issued.filter((s) => /^UPDATE projects SET yjs_write = \? WHERE id = \? AND/.test(s.sql));
}

function tags(issued: Issued[]): Issued[] {
  return issued.filter((s) => /^UPDATE projects SET yjs_generation = \?/.test(s.sql));
}

let errors: string[];
let warnings: string[];

beforeEach(() => {
  errors = [];
  warnings = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  applies.recording = false;
  applies.updates.length = 0;
  encodings.refuse = null;
  vi.restoreAllMocks();
});

function haltLines(): string[] {
  return errors.filter((line) => line.includes("[persistence][halted]"));
}

/**
 * Put the halt's line into the same ordered record as the storage and socket
 * effects, so its POSITION among them is what the test reads. A count taken
 * from a separate list can say the line was written and nothing about when.
 */
function traceHaltLine(events: string[]): void {
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
    errors.push(line);
    if (line.includes("[persistence][halted]")) events.push("log:halted");
  });
}

function haltedLoadLines(): string[] {
  return errors.filter((line) => line.includes("[persistence][halted-load]"));
}

function exactBaseLines(): string[] {
  return errors.filter((line) => line.includes("[exact-base]"));
}

/** A sync UPDATE message carrying one client edit. */
function updateMessage(seed: Uint8Array, edit: (doc: Y.Doc) => void): ArrayBuffer {
  const update = recordBytes(seed, edit);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc).buffer as ArrayBuffer;
}

/** One client's awareness state, as the message that carries it. */
function awarenessMessage(): { message: ArrayBuffer; clientId: number } {
  const awareness = new awarenessProtocol.Awareness(new Y.Doc());
  awareness.setLocalState({ user: { name: "somebody" } });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    enc,
    awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
  );
  return {
    message: encoding.toUint8Array(enc).buffer as ArrayBuffer,
    clientId: awareness.clientID,
  };
}

/** A sync step 1 message, which asks for a reply and applies nothing. */
function step1Message(): ArrayBuffer {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, new Y.Doc());
  return encoding.toUint8Array(enc).buffer as ArrayBuffer;
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

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
 * Drive one upgrade. Node cannot build the 101 the admitted path returns, so the
 * error it throws there is swallowed — everything the handshake does has already
 * happened by then.
 */
async function upgrade(harness: { doInstance: ProjectCollaborationDO }): Promise<Response | null> {
  const socket = fakeSocket([]);
  (globalThis as Record<string, unknown>).WebSocketPair = function () {
    return { 0: socket, 1: socket };
  };
  const token = await mintToken();
  const request = new Request(
    `https://internal/ws/${PROJECT_ID}?token=${token}&gen=new`,
    { headers: { Upgrade: "websocket" } },
  );
  return harness.doInstance.fetch(request).catch(() => null);
}

// ---------------------------------------------------------------------------
// The load's phases
// ---------------------------------------------------------------------------

const PHASES = ["read-base", "get:generation", "get:halt", "get:base"];
const CLAIM = "run:UPDATE projects SET yjs_write = ? ";

describe("a load reads the row, the generation, the halt and the base, then claims", () => {
  it("takes the phases in that order, and claims after the last storage access", async () => {
    const events: string[] = [];
    const { internals, db } = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {}, [], events);

    await internals.ensureDocLoaded();

    const phases = events.filter((e) => PHASES.includes(e) || e.startsWith("run:"));
    expect(phases.slice(0, 5)).toEqual([...PHASES, CLAIM]);
    expect(claims(db.mutations)).toHaveLength(1);
    expect(internals.docLoaded).toBe(true);
  });

  it("repeats every phase from the row read on a contention retry", async () => {
    const events: string[] = [];
    let nth = 0;
    const { internals, db } = makeDo(
      { base: [tagged(BASE_A, 0, 0, 4)], run: () => (++nth === 1 ? { changes: 0 } : { changes: 1 }) },
      {},
      [],
      events,
    );

    await internals.ensureDocLoaded();

    const phases = events.filter((e) => PHASES.includes(e) || e.startsWith("run:"));
    expect(phases).toEqual([
      ...PHASES, CLAIM,
      ...PHASES, CLAIM,
    ]);
    expect(claims(db.mutations)).toHaveLength(2);
  });

  it("reads the halt before it writes anything at all", async () => {
    const events: string[] = [];
    const { internals, storage } = makeDo({ base: [untagged(BASE_A, 4)] }, {}, [], events);
    plantMarker(storage, 0, "enforcement_failed");

    await expect(internals.ensureDocLoaded()).rejects.toBeInstanceOf(PersistenceHaltedError);

    // The row SELECT is permitted and expected; nothing else runs.
    expect(events.filter((e) => e.startsWith("run:") || e === "batch")).toEqual([]);
    expect(events.filter((e) => e === "get:base")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The marker met at load
// ---------------------------------------------------------------------------

describe("a planted marker stops the load before anything is claimed", () => {
  it("sets the state, closes every socket, logs one line, and applies nothing", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    // Attached after construction: the wake path is the workers project's to
    // exercise, and this is about what the loader itself does.
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {}, [], events);
    const { internals, db, storage } = harness;
    harness.sockets.push(socket);
    plantMarker(storage, 0, "apply_failed");

    const err = await internals.ensureDocLoaded().then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(PersistenceHaltedError);
    expect(internals.persistenceHalted).toMatchObject({
      generation: 0,
      marker: { reason: "apply_failed" },
    });
    expect(writes(db.mutations)).toHaveLength(0);
    expect(events.filter((e) => e === "read-base")).toHaveLength(1);
    expect(internals.docLoaded).toBe(false);
    expect(titleOf(internals.ydoc)).toBeUndefined();
    expect(socket.closes).toContainEqual(UNAVAILABLE);
    expect(haltedLoadLines()).toHaveLength(1);

    // A second attempt is a second failed load, and says so once more.
    await expect(internals.ensureDocLoaded()).rejects.toBeInstanceOf(PersistenceHaltedError);
    expect(haltedLoadLines()).toHaveLength(2);
  });

  it("halts as bad_halt on a damaged marker, leaving the stored value exactly as it stands", async () => {
    const { internals, storage, doInstance } = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    storage.kv.set(haltKey(0), { v: 1, reason: "" });

    await expect(internals.ensureDocLoaded()).rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(internals.persistenceHalted?.marker.reason).toBe("bad_halt");
    expect(storage.kv.get(haltKey(0))).toEqual({ v: 1, reason: "" });

    const state = await doInstance.fetch(
      await signedRequest("/persistence-state", "persistence-state", undefined, "GET"),
    );
    expect(await state.json()).toEqual({ halted: true, reason: "bad_halt", generation: 0 });
  });
});

// ---------------------------------------------------------------------------
// enterHalt: first halt wins, and its effects are ordered
// ---------------------------------------------------------------------------

/** Drive one enforcement failure through the real guard, on a live document. */
function breakTheRevert(): () => void {
  const realInsert = Y.Array.prototype.insert;
  const spy = vi.spyOn(Y.Array.prototype, "insert").mockImplementation(function (
    this: Y.Array<unknown>,
    index: number,
    content: unknown[],
  ) {
    throw new Error("synthetic revert failure");
  });
  return () => {
    spy.mockRestore();
    void realInsert;
  };
}

/** A document with one story owned by somebody else, so its delete is refused. */
function seedVictim(
  internals: Internals,
  storyId = "victim",
  id = 31,
  owner = OTHER_USER,
): void {
  internals.ydoc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("_id", id);
    story.set("story_id", storyId);
    story.set("created_by", owner);
    story.set("title", new Y.Text("Victim"));
    story.set("order_key", "b0");
    internals.ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
  }, null);
}

/** The message that deletes the victim story, from this socket. */
function deleteVictim(internals: Internals, ws: unknown): void {
  const stories = internals.ydoc.getArray<Y.Map<unknown>>("stories");
  const index = stories.toArray().findIndex((m) => m.get("story_id") === "victim");
  internals.ydoc.transact(() => { stories.delete(index, 1); }, ws);
}

describe("entering the halt", () => {
  it("orders its effects: state and latch, the put, the line, the closes, the alarm", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(socket);
    seedVictim(harness.internals);
    events.length = 0;
    traceHaltLine(events);
    const stateAt: number[] = [];
    // The state and the latch are set before anything is issued, which is what
    // the put's own failure must not be able to undo. Recorded by reading them
    // at the first effect the fake sees.
    const storage = harness.storage;
    const realPut = storage.put.bind(storage);
    (storage as unknown as { put: unknown }).put = (...args: unknown[]) => {
      stateAt.push(harness.internals.persistenceHalted === null ? 0 : 1);
      stateAt.push(harness.internals.messageFailed ? 1 : 0);
      return (realPut as (...a: unknown[]) => Promise<void>)(...args);
    };

    const restore = breakTheRevert();
    try {
      deleteVictim(harness.internals, socket);
    } finally {
      restore();
    }

    expect(stateAt).toEqual([1, 1]);
    // One record for all four effects, the line included, so its position is
    // asserted rather than only its count.
    expect(events.filter((e) => e.startsWith("put:") || e.startsWith("close:")
      || e === "delete-alarm" || e === "log:halted"))
      .toEqual(["put:halt", "log:halted", "close:1013", "delete-alarm"]);
    expect(harness.internals.persistenceHalted?.marker.reason).toBe("enforcement_failed");
    expect(haltLines()).toHaveLength(1);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("carries the put's failure in the same single line", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(socket);
    seedVictim(harness.internals);
    // Armed after the seeding, which is a logged transaction of its own: a put
    // scripted to fail would otherwise fail the fixture rather than the halt.
    harness.storage.arm({ putThrows: new Error("storage gone") });

    const restore = breakTheRevert();
    try {
      deleteVictim(harness.internals, socket);
    } finally {
      restore();
    }

    // One line per halt, whatever the put did — and that line names the failure.
    expect(haltLines()).toHaveLength(1);
    expect(haltLines()[0]).toContain("enforcement_failed");
    expect(haltLines()[0]).toContain("The marker could not be written");
    expect(haltLines()[0]).toContain("storage gone");
  });

  it("keeps its order when the put's failure cannot be printed", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    // No prototype, so `String(value)` on it throws instead of answering
    // "[object Object]" — the failure the conversion has to survive.
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(socket);
    seedVictim(harness.internals);
    // Armed after the seeding, which is a logged transaction of its own: a put
    // scripted to fail would otherwise fail the fixture rather than the halt.
    harness.storage.arm({ putThrows: Object.create(null) });
    events.length = 0;
    traceHaltLine(events);

    const restore = breakTheRevert();
    try {
      expect(() => deleteVictim(harness.internals, socket)).not.toThrow();
    } finally {
      restore();
    }

    expect(events.filter((e) => e.startsWith("put:") || e.startsWith("close:")
      || e === "delete-alarm" || e === "log:halted"))
      .toEqual(["put:halt", "log:halted", "close:1013", "delete-alarm"]);
    expect(haltLines()).toHaveLength(1);
    expect(haltLines()[0]).toContain("an unprintable value");
    expect(harness.internals.persistenceHalted).not.toBeNull();
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("treats a thrown undefined as a failed put", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(socket);
    seedVictim(harness.internals);
    // Armed after the seeding, which is a logged transaction of its own: a put
    // scripted to fail would otherwise fail the fixture rather than the halt.
    harness.storage.arm({ putThrows: undefined });

    const restore = breakTheRevert();
    try {
      deleteVictim(harness.internals, socket);
    } finally {
      restore();
    }

    expect(haltLines()).toHaveLength(1);
    expect(haltLines()[0]).toContain("The marker could not be written");
    expect(socket.closes).toEqual([UNAVAILABLE]);
    expect(harness.storage.events).toContain("delete-alarm");
  });

  it("gives the resident marker and the durable one the same time", async () => {
    const events: string[] = [];
    const harness = await loaded({}, {}, [], events);
    const socket = fakeSocket(events);
    harness.sockets.push(socket);
    seedVictim(harness.internals);
    // A clock that moves on every reading: two readings would differ, and the
    // halt would change its time when the resident state was dropped.
    let tick = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => tick++);

    const restore = breakTheRevert();
    try {
      deleteVictim(harness.internals, socket);
    } finally {
      restore();
    }

    const resident = harness.internals.persistenceHalted?.marker.at;
    const stored = (harness.storage.kv.get(haltKey(0)) as { at: number }).at;
    expect(resident).toBe(stored);

    const fromState = await harness.doInstance.fetch(
      await signedRequest("/persistence-state", "persistence-state", undefined, "GET"),
    );
    expect(await fromState.json()).toMatchObject({ halted: true, at: resident });

    // The resident state dropped: the same halt now answers from storage.
    harness.internals.persistenceHalted = null;
    harness.internals.docLoaded = false;
    const fromStorage = await harness.doInstance.fetch(
      await signedRequest("/persistence-state", "persistence-state", undefined, "GET"),
    );
    expect(await fromStorage.json()).toMatchObject({ halted: true, at: resident });
  });

  it("writes nothing and logs nothing more when the same generation is already halted", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(socket);
    seedVictim(harness.internals);
    const restore = breakTheRevert();
    try {
      deleteVictim(harness.internals, socket);
      const before = harness.internals.persistenceHalted;
      events.length = 0;
      errors.length = 0;
      seedVictim(harness.internals);
      deleteVictim(harness.internals, socket);

      expect(events.filter((e) => e.startsWith("put:"))).toEqual([]);
      expect(haltLines()).toHaveLength(0);
      expect(harness.internals.persistenceHalted).toBe(before);
    } finally {
      restore();
    }
  });

  it("stays halted in memory when the marker put throws synchronously", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(socket);
    seedVictim(harness.internals);
    // Armed after the seeding, which is a logged transaction of its own: a put
    // scripted to fail would otherwise fail the fixture rather than the halt.
    harness.storage.arm({ putThrows: new Error("storage gone") });
    events.length = 0;

    const restore = breakTheRevert();
    try {
      deleteVictim(harness.internals, socket);
    } finally {
      restore();
    }

    expect(harness.internals.persistenceHalted).not.toBeNull();
    expect(harness.internals.messageFailed).toBe(true);
    // One attempt, never a second.
    expect(events.filter((e) => e.startsWith("put:"))).toEqual(["put:halt"]);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it.each([
    ["throws synchronously", { alarmThrows: new Error("alarm binding gone") }],
    ["returns a rejecting promise", { alarmRejects: new Error("alarm delete failed") }],
  ])("returns normally when the alarm deletion %s", async (_label, storageOpts) => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = await loaded({}, storageOpts as StorageOptions, [], events);
    harness.sockets.push(socket);
    seedVictim(harness.internals);

    const restore = breakTheRevert();
    try {
      expect(() => deleteVictim(harness.internals, socket)).not.toThrow();
    } finally {
      restore();
    }

    expect(harness.internals.persistenceHalted).not.toBeNull();
    expect(harness.storage.kv.has(haltKey(0))).toBe(true);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("attempts the next socket's close when one throws", async () => {
    const events: string[] = [];
    const bad = fakeSocket(events, { closeThrows: true });
    const good = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(bad, good);
    seedVictim(harness.internals);

    const restore = breakTheRevert();
    try {
      deleteVictim(harness.internals, good);
    } finally {
      restore();
    }

    expect(bad.closes).toEqual([]);
    expect(good.closes).toEqual([UNAVAILABLE]);
  });
});

// ---------------------------------------------------------------------------
// The storage base is preferred over the D1 blob
// ---------------------------------------------------------------------------

describe("a storage base for the current generation is the document's base", () => {
  it("is applied instead of the D1 blob, seeds the sequence, and claims the row once", async () => {
    const events: string[] = [];
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {}, [], events);
    plantBase(harness.storage, 0, 5, BASE_STORAGE);

    await harness.internals.ensureDocLoaded();

    expect(titles(harness.internals.ydoc)).toEqual(["Story in storage"]);
    // One above the replayed tail: the repairs the load runs unsuppressed are
    // logged, and `backfillBlobGaps` seeds the two config toggles.
    expect(harness.internals.docSeq).toBe(6);
    expect(harness.internals.docWrite).toBe(5);
    expect(claims(harness.db.mutations)).toHaveLength(1);
    expect(tags(harness.db.mutations)).toHaveLength(0);
  });

  it("claims and ignores a D1 row tagged with another generation", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 9, 3, 4)] });
    plantBase(harness.storage, 0, 5, BASE_STORAGE);

    await harness.internals.ensureDocLoaded();

    expect(titles(harness.internals.ydoc)).toEqual(["Story in storage"]);
    expect(claims(harness.db.mutations)).toHaveLength(1);
    expect(harness.internals.docLoaded).toBe(true);
  });

  it("bare-claims an untagged row with its NULL tags retained, and applies the base", async () => {
    const harness = makeDo({ base: [untagged(BASE_A, 4)] });
    plantBase(harness.storage, 0, 5, BASE_STORAGE);

    await harness.internals.ensureDocLoaded();

    // A tag here would confer the current generation on bytes that are not the
    // base's, and the authority rule's tie would then serve them over it. The
    // first fenced snapshot is what tags, with the blob it describes.
    expect(tags(harness.db.mutations)).toHaveLength(0);
    expect(claims(harness.db.mutations)).toHaveLength(1);
    expect(claims(harness.db.mutations)[0].binds).toEqual([5, PROJECT_ID, 4]);
    expect(titles(harness.internals.ydoc)).toEqual(["Story in storage"]);
    expect(titles(harness.internals.ydoc)).not.toContain("Story A");
  });

  it("claims an untagged row with a NULL blob, and neither builds nor tags", async () => {
    const harness = makeDo({ base: [cold(4)], rows: ONE_STORY });
    plantBase(harness.storage, 0, 5, BASE_STORAGE);

    await harness.internals.ensureDocLoaded();

    expect(claims(harness.db.mutations)).toHaveLength(1);
    expect(tags(harness.db.mutations)).toHaveLength(0);
    // The cold build's own SELECT is a READ, so the read inventory is what can
    // answer for its absence.
    expect(harness.db.reads.filter((s) => /FROM stories/.test(s.sql))).toHaveLength(0);
    expect(harness.db.reads.filter((s) => /^SELECT yjs_state/.test(s.sql))).toHaveLength(1);
    expect(titles(harness.internals.ydoc)).toEqual(["Story in storage"]);
  });

  it("halts as log_corrupt on a damaged base, before the claim", async () => {
    const events: string[] = [];
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {}, [], events);
    plantBase(harness.storage, 0, 5, BASE_STORAGE);
    harness.storage.kv.delete(`${baseKey(0)}:0001`);

    await expect(harness.internals.ensureDocLoaded())
      .rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("log_corrupt");
    expect(writes(harness.db.mutations)).toHaveLength(0);
    expect(harness.storage.kv.has(haltKey(0))).toBe(true);
  });

  it.each([
    ["an untagged row with a blob", untagged(BASE_A, 4)],
    ["an untagged row with a NULL blob", cold(4)],
  ])("refuses with no marker when the tail read rejects on %s", async (_label, row) => {
    const harness = makeDo(
      { base: [row], rows: ONE_STORY },
      // The tail read is the load's first listing on both untagged paths.
      { failOn: (kind) => (kind === "list" ? new Error("storage down") : undefined) },
    );

    const err = await harness.internals.ensureDocLoaded().then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ExactBaseError);
    expect((err as ExactBaseError).reason).toBe("generation_unreadable");
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.storage.kv.has(haltKey(0))).toBe(false);
    expect(writes(harness.db.mutations)).toHaveLength(0);
    expect(exactBaseLines()).toEqual([`[exact-base] project ${PROJECT_ID}: generation_unreadable`]);
  });

  it("refuses with no marker when the base read rejects", async () => {
    const harness = makeDo(
      { base: [tagged(BASE_A, 0, 0, 4)] },
      { failOn: (kind) => (kind === "base" ? new Error("storage down") : undefined) },
    );

    const err = await harness.internals.ensureDocLoaded().then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ExactBaseError);
    expect((err as ExactBaseError).reason).toBe("generation_unreadable");
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.storage.kv.has(haltKey(0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suppression, by phase
// ---------------------------------------------------------------------------

/** Record `logSuppressed` as each load-time repair runs. */
function watchSuppression(internals: Internals): { backfill: boolean[]; repairs: boolean[] } {
  const seen = { backfill: [] as boolean[], repairs: [] as boolean[] };
  const backfill = internals.backfillBlobGaps.bind(internals);
  const repairs = internals.runPostLoadRepairs.bind(internals);
  internals.backfillBlobGaps = async () => {
    seen.backfill.push(internals.logSuppressed);
    return backfill();
  };
  internals.runPostLoadRepairs = async () => {
    seen.repairs.push(internals.logSuppressed);
    return repairs();
  };
  return seen;
}

describe("logging is suppressed by phase, and cleared at three points", () => {
  it("is suppressed through the base and the replay, and cleared for the repairs", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    plantRecord(harness.storage, 0, 1, recordBytes(BASE_A, (doc) => {
      doc.getArray<Y.Map<unknown>>("stories").get(0).set("byline", "replayed");
    }));
    const seen = watchSuppression(harness.internals);
    const duringReplay: boolean[] = [];
    harness.internals.ydoc.on("afterTransaction", () => {
      duringReplay.push(harness.internals.logSuppressed);
    });

    await harness.internals.ensureDocLoaded();

    expect(duringReplay.slice(0, 2)).toEqual([true, true]);
    expect(seen.backfill).toEqual([false]);
    expect(seen.repairs).toEqual([false]);
    expect(harness.internals.docGeneration).toBe(0);
    expect(harness.internals.logSuppressed).toBe(false);
  });

  it("stays suppressed through a cold build and clears only when the initial write lands", async () => {
    const harness = makeDo({
      base: [cold(4)],
      rows: ONE_STORY,
      run: (sql, _binds, nth) =>
        (/^UPDATE projects SET yjs_state/.test(sql) && nth === 1 ? { changes: 0 } : undefined),
    });
    const seen = watchSuppression(harness.internals);

    await harness.internals.ensureDocLoaded();

    // The build and its repairs run suppressed on both attempts; only the
    // landed write opens the document to a logger.
    expect(seen.repairs).toEqual([true, true]);
    expect(harness.internals.logSuppressed).toBe(false);
    expect(harness.internals.docGeneration).toBe(0);
  });

  it("stays suppressed after a zero-row initial write and after a thrown one", async () => {
    const contended = makeDo({
      base: [cold(4)],
      rows: ONE_STORY,
      run: (sql) => (/^UPDATE projects SET yjs_state/.test(sql) ? { changes: 0 } : undefined),
    });
    await expect(contended.internals.ensureDocLoaded()).rejects.toBeInstanceOf(ExactBaseError);
    expect(contended.internals.logSuppressed).toBe(true);

    const thrown = makeDo({
      base: [cold(4)],
      rows: ONE_STORY,
      run: (sql) => (/^UPDATE projects SET yjs_state/.test(sql)
        ? { throws: new Error("D1_ERROR: write failed") }
        : undefined),
    });
    await expect(thrown.internals.ensureDocLoaded()).rejects.toThrow(/write failed/);
    expect(thrown.internals.logSuppressed).toBe(true);
  });

  it("is suppressed again through a reset's rebuild, and cleared when the replacement lands", async () => {
    const harness = await loaded({ rows: ONE_STORY });
    expect(harness.internals.logSuppressed).toBe(false);
    const duringRebuild: boolean[] = [];
    const build = harness.internals.buildFromD1Rows.bind(harness.internals);
    harness.internals.buildFromD1Rows = async () => {
      duringRebuild.push(harness.internals.logSuppressed);
      return build();
    };

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(duringRebuild).toEqual([true]);
    expect(harness.internals.logSuppressed).toBe(false);
    // And a transaction on the landed replacement is eligible for logging.
    expect(harness.internals.docLoaded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

/** A record that gives the story a distinguishable field. */
function fieldRecord(key: string, value: string): Uint8Array {
  return recordBytes(BASE_A, (doc) => {
    doc.getArray<Y.Map<unknown>>("stories").get(0).set(key, value);
  });
}

/** Start recording applies, and hand back the array they land in. */
function traceApplies(): Uint8Array[] {
  applies.updates.length = 0;
  applies.recording = true;
  return applies.updates;
}

describe("the replay applies every record above the base's sequence", () => {
  it("applies three planted records in sequence order and ends at the last", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    const records = [
      fieldRecord("byline", "one"),
      fieldRecord("subtitle", "two"),
      fieldRecord("order_key", "three"),
    ];
    records.forEach((bytes, index) => plantRecord(harness.storage, 0, index + 1, bytes));
    const applied = traceApplies();

    await harness.internals.ensureDocLoaded();

    expect(applied.slice(0, 4)).toEqual([BASE_A, ...records]);
    // Two above the replayed tail: the repairs the load runs unsuppressed are
    // logged, and here both change something — `backfillBlobGaps` seeds the two
    // config toggles, and the order-key backfill rewrites the "three" the third
    // record planted.
    expect(harness.internals.docSeq).toBe(5);
    const story = harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    expect(story.get("byline")).toBe("one");
    expect(story.get("subtitle")).toBe("two");
  });

  it("skips records at or below the sequence the base was tagged with", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 2, 4)] });
    plantRecord(harness.storage, 0, 2, fieldRecord("byline", "already in the base"));
    plantRecord(harness.storage, 0, 3, fieldRecord("subtitle", "above it"));
    const applied = traceApplies();

    await harness.internals.ensureDocLoaded();

    expect(applied).toHaveLength(2);
    const story = harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    expect(story.get("byline")).toBeUndefined();
    expect(story.get("subtitle")).toBe("above it");
    // One above the replayed tail: the repairs the load runs unsuppressed are
    // logged, and `backfillBlobGaps` seeds the two config toggles.
    expect(harness.internals.docSeq).toBe(4);
  });

  it("replays completely across more than one listed page", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    // The codec lists 64 keys a page, so 70 records span two pages and a third,
    // empty listing ends the walk.
    for (let seq = 1; seq <= 70; seq++) {
      plantRecord(harness.storage, 0, seq, fieldRecord(`field_${seq}`, String(seq)));
    }
    const applied = traceApplies();

    await harness.internals.ensureDocLoaded();

    expect(applied).toHaveLength(71);
    // One above the replayed tail: the repairs the load runs unsuppressed are
    // logged, and `backfillBlobGaps` seeds the two config toggles.
    expect(harness.internals.docSeq).toBe(71);
    const story = harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    expect(story.get("field_70")).toBe("70");
  });

  it("steps over an orphan part with no header", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    plantRecord(harness.storage, 0, 1, fieldRecord("byline", "one"));
    harness.storage.kv.set(`${logKey(0, 2)}:0001`, new Uint8Array([1, 2, 3]));

    await harness.internals.ensureDocLoaded();

    expect(harness.internals.docLoaded).toBe(true);
    // One above the replayed tail: the repairs the load runs unsuppressed are
    // logged, and `backfillBlobGaps` seeds the two config toggles.
    expect(harness.internals.docSeq).toBe(2);
  });

  it("halts as log_corrupt on a header whose part is missing", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {}, [], events);
    harness.sockets.push(socket);
    const big = new Uint8Array(200 * 1024);
    plantRecord(harness.storage, 0, 1, big);
    harness.storage.kv.delete(`${logKey(0, 1)}:0002`);

    await expect(harness.internals.ensureDocLoaded())
      .rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("log_corrupt");
    expect(harness.internals.docLoaded).toBe(false);
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("refuses with no marker when a replay listing rejects", async () => {
    const harness = makeDo(
      { base: [tagged(BASE_A, 0, 0, 4)] },
      { failOn: (kind) => (kind === "list" ? new Error("storage down") : undefined) },
    );

    const err = await harness.internals.ensureDocLoaded().then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ExactBaseError);
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.storage.kv.has(haltKey(0))).toBe(false);
  });
});

describe("what cannot be applied halts the load and disposes the document", () => {
  const NOT_AN_UPDATE = new Uint8Array([9, 9, 9, 9, 9, 9]);

  it("halts as apply_failed on a replayed record that is not a Yjs update", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {}, [], events);
    harness.sockets.push(socket);
    plantRecord(harness.storage, 0, 1, NOT_AN_UPDATE);

    await expect(harness.internals.ensureDocLoaded())
      .rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted).toMatchObject({
      generation: 0,
      marker: { reason: "apply_failed" },
    });
    expect(harness.storage.kv.get(haltKey(0))).toMatchObject({ reason: "apply_failed" });
    expect(harness.internals.docLoaded).toBe(false);
    expect(titleOf(harness.internals.ydoc)).toBeUndefined();
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("halts as apply_failed on a storage base that is not a Yjs update", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    plantBase(harness.storage, 0, 5, NOT_AN_UPDATE);

    await expect(harness.internals.ensureDocLoaded())
      .rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("apply_failed");
  });

  it("halts as apply_failed on a D1 blob that is not a Yjs update", async () => {
    const harness = makeDo({ base: [tagged(NOT_AN_UPDATE, 0, 0, 4)] });

    await expect(harness.internals.ensureDocLoaded())
      .rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("apply_failed");
    expect(harness.internals.docLoaded).toBe(false);
  });

  it.each([
    ["the base", 0],
    ["a replayed record", 1],
  ])("halts as apply_failed when an observer throws during %s", async (_label, throwOn) => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    plantRecord(harness.storage, 0, 1, fieldRecord("byline", "one"));
    let applies = 0;
    harness.internals.ydoc.on("afterTransaction", () => {
      if (applies++ === throwOn) throw new Error("observer threw after integration");
    });

    await expect(harness.internals.ensureDocLoaded())
      .rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("apply_failed");
    expect(harness.internals.docLoaded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The guard's effects, staged behind the write
// ---------------------------------------------------------------------------

/**
 * An instance serving a document with a victim story, one editor socket and one
 * peer, loaded and with its ledgers ready to be credited.
 */
async function guardHarness(
  storageOpts: StorageOptions = {},
  db: Partial<DbScript> = {},
  events: string[] = [],
) {
  const editor = fakeSocket(events);
  const peer = fakeSocket(events, { userId: OTHER_USER });
  const harness = await loaded(db, {}, [], events);
  harness.sockets.push(editor, peer);
  // Before the seams: seeding the victim is a null-origin transaction, so it is
  // a record of its own, and a put scripted to fail would fail the fixture
  // rather than the halt it is written for.
  seedVictim(harness.internals);
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.storage.arm(storageOpts);
  // Seeding is a logged transaction, and it is the fixture's, not the test's.
  harness.storage.putBatches.length = 0;
  harness.storage.alarms.length = 0;
  harness.storage.disarmAlarm();
  events.length = 0;
  return { ...harness, editor, peer, events };
}

/**
 * Watch every queue the handler installs, since it takes a fresh one for each
 * message: the count is of what the guard asked to be sent, not of what left.
 */
function watchStaged(internals: Internals): { sends: number } {
  const counted = { sends: 0 };
  let current = internals.stagedEffects;
  Object.defineProperty(internals, "stagedEffects", {
    configurable: true,
    get: () => current,
    set: (next: Internals["stagedEffects"]) => {
      const push = next.sends.push.bind(next.sends);
      next.sends.push = (...items: Array<{ ws: unknown; msg: Uint8Array }>) => {
        counted.sends += items.length;
        return push(...items);
      };
      current = next;
    },
  });
  return counted;
}

/**
 * A packet carrying a refused deletion AND a creditable prose edit, as either
 * sync subtype.
 *
 * The subtype matters at the drain: an UPDATE the guard reverted is not
 * relayed, so nothing follows the staged effects, while a step 2 keeps its
 * relay and is therefore the case in which "the sends, then the closes, then
 * the response" is a sequence a test can read.
 */
function refusedDeletePacket(
  internals: Internals,
  storyId: string,
  syncType: number,
): ArrayBuffer {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(internals.ydoc));
  const before = Y.encodeStateVector(client);
  client.transact(() => {
    const stories = client.getArray<Y.Map<unknown>>("stories");
    const index = stories.toArray().findIndex((m) => m.get("story_id") === storyId);
    (stories.get(0).get("title") as Y.Text).insert(0, "many more words written here ");
    stories.delete(index, 1);
  });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  encoding.writeVarUint(enc, syncType);
  encoding.writeVarUint8Array(enc, Y.encodeStateAsUpdate(client, before));
  return encoding.toUint8Array(enc).buffer as ArrayBuffer;
}

/** The message that carries a refused deletion AND a creditable prose edit. */
function refusedDeleteMessage(internals: Internals, storyId = "victim"): ArrayBuffer {
  return refusedDeletePacket(internals, storyId, syncProtocol.messageYjsUpdate);
}

/** The same, as a sync step 2, which keeps its relay past a revert. */
function refusedDeleteStep2(internals: Internals, storyId = "victim"): ArrayBuffer {
  return refusedDeletePacket(internals, storyId, syncProtocol.messageYjsSyncStep2);
}

/**
 * What the staged queue holds when the NEXT message enters the handler, read at
 * the first thing that handler does.
 *
 * The queue a message staged is cleared by the handler's own `finally`; this is
 * what says so from the next message's point of view rather than from the
 * previous one's.
 */
function queueAtEntry(internals: Internals): { seen: Array<{ sends: number; closes: number }> } {
  const seen: Array<{ sends: number; closes: number }> = [];
  const realFence = internals.socketMayReachDocument.bind(internals);
  let first = true;
  internals.socketMayReachDocument = (ws: unknown) => {
    if (first) {
      first = false;
      seen.push({
        sends: internals.stagedEffects.sends.length,
        closes: internals.stagedEffects.closes.length,
      });
    }
    return realFence(ws);
  };
  return { seen };
}

describe("a message whose enforcement fails reaches no peer", () => {
  it("stages the broadcast, writes the marker first, and discards what it staged", async () => {
    const harness = await guardHarness();
    const message = refusedDeleteMessage(harness.internals);
    const staged = watchStaged(harness.internals);

    const restore = breakTheRevert();
    try {
      await harness.internals.webSocketMessage(harness.editor, message);
    } finally {
      restore();
    }

    // The guard asked for a broadcast, and it never left the object.
    expect(staged.sends).toBeGreaterThan(0);
    expect(harness.peer.sent).toHaveLength(0);
    expect(harness.editor.sent).toHaveLength(0);
    // The put comes before every close, and no send happens at all.
    const ordered = harness.events.filter(
      (e) => e.startsWith("put:") || e.startsWith("close:") || e === "send" || e === "batch",
    );
    expect(ordered[0]).toBe("put:halt");
    expect(ordered).not.toContain("send");
    expect(ordered).not.toContain("batch");
    // The offending socket is closed, after the halt's own 1013s.
    expect(harness.events.filter((e) => e.startsWith("close:"))).toEqual([
      "close:1013", "close:1013", "close:1008",
    ]);
    // No response, no relay, no alarm, no activity rows.
    expect(harness.events).not.toContain("set-alarm");
    expect(harness.db.batchCalls()).toBe(0);
    expect(harness.internals.messageFailed).toBe(true);
  });

  it("sends what it staged, then closes, then the response, on the healthy path", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor, peer);
    // Three refused deletions from one socket. The third crosses the violation
    // threshold, so the guard stages a close on a message whose revert
    // SUCCEEDED — which is the only healthy message that has all three of a
    // staged send, a staged close and a response to put in order.
    seedVictim(harness.internals, "victim-1", 31);
    seedVictim(harness.internals, "victim-2", 32);
    seedVictim(harness.internals, "victim-3", 33);
    for (const storyId of ["victim-1", "victim-2"]) {
      await harness.internals.webSocketMessage(
        editor,
        refusedDeleteStep2(harness.internals, storyId),
      );
    }
    events.length = 0;
    peer.sent.length = 0;

    // A step 2, so the relay is not the one the revert suppresses.
    const third = refusedDeleteStep2(harness.internals, "victim-3");
    await harness.internals.webSocketMessage(editor, third);

    expect(harness.internals.messageFailed).toBe(false);
    expect(harness.internals.persistenceHalted).toBeNull();
    // The staged correction to each socket, then the staged close, then the
    // packet's own relay — in that order and no other.
    expect(events.filter((e) => e === "send" || e.startsWith("close:")))
      .toEqual(["send", "send", "close:1008", "send"]);
    expect(editor.closes).toEqual([
      { code: 1008, reason: "Repeated unauthorised delete attempts" },
    ]);
    expect(peer.sent).toHaveLength(2);
    expect(peer.sent[1]).toEqual(new Uint8Array(third));
    expect(harness.internals.ydoc.getArray("stories").length).toBe(4);
  });

  it("keeps its whole continuation free of awaits from the second fence to the drain", async () => {
    const harness = await guardHarness();
    const message = refusedDeleteMessage(harness.internals);
    const order: string[] = [];
    // The boundary itself, traced: the fence marks where it ran and queues a
    // microtask from inside the same synchronous stretch, and the drain marks
    // where it ran. An await anywhere between them lets the microtask run
    // first, which is exactly what F1 forbids.
    const realFence = harness.internals.socketMayReachDocument.bind(harness.internals);
    let fences = 0;
    harness.internals.socketMayReachDocument = (ws: unknown) => {
      const generation = realFence(ws);
      fences += 1;
      const nth = fences;
      order.push(`fence:${nth}`);
      void Promise.resolve().then(() => order.push(`microtask:${nth}`));
      return generation;
    };
    const realDrain = harness.internals.drainStagedEffects.bind(harness.internals);
    harness.internals.drainStagedEffects = () => {
      order.push("drain");
      return realDrain();
    };

    await harness.internals.webSocketMessage(harness.editor, message);

    // The second fence is the one the rule runs from; the first is separated
    // from the drain by the load's own await, and its microtask may run.
    expect(order).toContain("fence:2");
    expect(order.indexOf("fence:2")).toBeLessThan(order.indexOf("drain"));
    expect(order.indexOf("drain")).toBeLessThan(order.indexOf("microtask:2"));
  });

  it("starts the next message with an empty queue, after a failed one", async () => {
    const harness = await guardHarness();
    // Built before the revert is broken: the message is a client's, and the
    // client's own document is not the one the failure is scripted into.
    const message = refusedDeleteMessage(harness.internals);
    const restore = breakTheRevert();
    try {
      await harness.internals.webSocketMessage(harness.editor, message);
    } finally {
      restore();
    }
    expect(harness.internals.stagedEffects.sends).toEqual([]);
    expect(harness.internals.stagedEffects.closes).toEqual([]);

    // And the NEXT message finds it empty at its own entry, before anything it
    // does could have cleared it.
    const atEntry = queueAtEntry(harness.internals);
    await harness.internals.webSocketMessage(harness.editor, message);
    expect(atEntry.seen).toEqual([{ sends: 0, closes: 0 }]);
  });

  it("starts the next message with an empty queue, after a response send that threw", async () => {
    const events: string[] = [];
    const gone = fakeSocket(events, { sendThrows: true });
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(gone, peer);

    // The sync response is the one send outside a `try`, so a recipient that
    // has gone makes the exception escape the handler.
    await expect(harness.internals.webSocketMessage(gone, step1Message()))
      .rejects.toThrow(/socket gone/);

    const atEntry = queueAtEntry(harness.internals);
    await harness.internals.webSocketMessage(peer, step1Message());
    expect(atEntry.seen).toEqual([{ sends: 0, closes: 0 }]);
  });

  it("starts the next message with an empty queue, after one whose continuation threw", async () => {
    // The alarm read after the relay is outside every `try` in the message
    // path, so a binding that throws there escapes the handler with the queue
    // this message filled still standing. Only the `finally` clears it.
    const harness = await guardHarness({ alarmGetThrows: new Error("alarm binding gone") });
    const message = refusedDeleteStep2(harness.internals);
    const staged = watchStaged(harness.internals);

    await expect(harness.internals.webSocketMessage(harness.editor, message))
      .rejects.toThrow(/alarm binding gone/);

    expect(staged.sends).toBeGreaterThan(0);
    expect(harness.internals.stagedEffects.sends).toHaveLength(0);
    expect(harness.internals.stagedEffects.closes).toHaveLength(0);

    const atEntry = queueAtEntry(harness.internals);
    await harness.internals.webSocketMessage(harness.peer, step1Message())
      .catch(() => { /* the same binding throws again */ });
    expect(atEntry.seen).toEqual([{ sends: 0, closes: 0 }]);
  });
});

describe("the message-failure latch", () => {
  it("fails the message and halts in memory when the marker put throws", async () => {
    const harness = await guardHarness({ putThrows: new Error("storage gone") });
    const message = refusedDeleteMessage(harness.internals);

    const restore = breakTheRevert();
    try {
      await harness.internals.webSocketMessage(harness.editor, message);
    } finally {
      restore();
    }

    expect(harness.internals.messageFailed).toBe(true);
    expect(harness.internals.persistenceHalted).not.toBeNull();
    expect(harness.peer.sent).toHaveLength(0);
    expect(harness.events.filter((e) => e === "put:halt")).toHaveLength(1);
    expect(harness.editor.closes).toContainEqual(UNAVAILABLE);

    // And the next message is refused before it reaches the document.
    harness.events.length = 0;
    await harness.internals.webSocketMessage(harness.editor, message);
    expect(harness.events.filter((e) => e === "batch" || e === "send")).toEqual([]);
  });

  it("halts as apply_failed when an observer throws after integration", async () => {
    const harness = await guardHarness();
    harness.internals.ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      if (tr.origin === harness.editor) throw new Error("observer threw after integration");
    });

    await harness.internals.webSocketMessage(
      harness.editor,
      updateMessage(Y.encodeStateAsUpdate(harness.internals.ydoc), (doc) => {
        doc.getArray<Y.Map<unknown>>("stories").get(0).set("byline", "credited");
      }),
    );

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("apply_failed");
    expect(harness.peer.sent).toHaveLength(0);
    // The document is NOT disposed: its sockets and ledgers are live, and the
    // reset is the recovery.
    expect(harness.internals.ydoc.getArray("stories").length).toBeGreaterThan(0);
    expect(harness.editor.closes).toContainEqual(UNAVAILABLE);
  });

  it("halts as apply_failed on malformed bytes from a socket", async () => {
    const harness = await guardHarness();
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, new Uint8Array([9, 9, 9, 9, 9, 9]));

    await harness.internals.webSocketMessage(
      harness.editor,
      encoding.toUint8Array(enc).buffer as ArrayBuffer,
    );

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("apply_failed");
    expect(harness.peer.sent).toHaveLength(0);
  });

  it("issues the next staged send when one recipient throws", async () => {
    const events: string[] = [];
    const gone = fakeSocket(events, { sendThrows: true, closeThrows: true });
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(gone, editor);
    seedVictim(harness.internals);
    events.length = 0;

    await harness.internals.webSocketMessage(editor, refusedDeleteMessage(harness.internals));

    // The correction reached the socket after the one that threw.
    expect(editor.sent.length).toBeGreaterThan(0);
    expect(harness.internals.messageFailed).toBe(false);
  });

  it("issues the next staged close when one throws, and returns past it", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events, { closeThrows: true });
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor, peer);
    // One story neither socket may delete: the editor's message takes the
    // first, and an observer takes the second from the peer's socket inside the
    // same message, so the queue carries a close for each.
    seedVictim(harness.internals, "victim-editor", 31, OTHER_USER);
    seedVictim(harness.internals, "victim-peer", 32, USER_ID);
    const message = refusedDeleteMessage(harness.internals, "victim-editor");
    let pending = true;
    harness.internals.ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      if (tr.origin !== editor || !pending) return;
      pending = false;
      const stories = harness.internals.ydoc.getArray<Y.Map<unknown>>("stories");
      const index = stories.toArray().findIndex((m) => m.get("story_id") === "victim-peer");
      if (index >= 0) harness.internals.ydoc.transact(() => { stories.delete(index, 1); }, peer);
    });
    events.length = 0;

    const restore = breakTheRevert();
    try {
      await expect(harness.internals.webSocketMessage(editor, message)).resolves.toBeUndefined();
    } finally {
      restore();
    }

    // Two staged closes, the first throwing: the second is issued all the same,
    // and the handler returns normally past both.
    expect(harness.internals.stagedEffects.closes).toHaveLength(0);
    expect(events.filter((e) => e === "close:1008")).toHaveLength(2);
    expect(peer.closes).toContainEqual({
      code: 1008,
      reason: "Delete enforcement could not be applied",
    });
    expect(editor.closes).toEqual([]);
    expect(harness.internals.messageFailed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attribution, abandoned with the halt
// ---------------------------------------------------------------------------

/** Everything the accumulators hold for the editor right now. */
function ledgerState(internals: Internals) {
  return {
    fields: internals.userFieldSets.size,
    lastEdit: internals.lastEditAt.size,
    paths: internals.editsByPath.size,
    words: internals.wordsByRow.size,
    time: internals.timeLedger.size,
    sessions: internals.newSessions.size,
    baseline: internals.wordBaseline.size,
    seeded: internals.timeSeeded,
    emitted: internals.activityEmitted.size,
  };
}

/**
 * An observer registered AFTER the accumulator, writing into the very maps the
 * accumulators captured.
 *
 * The accumulator itself stands down once the message has failed, so it is not
 * what the second abandonment is for: any LATER observer is, and this is one.
 * Registered from the test, so it runs third, after the guard and after the
 * accumulator.
 */
function lateObserver(internals: Internals, ws: unknown): void {
  internals.ydoc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.origin !== ws) return;
    internals.userFieldSets.set(USER_ID, new Set(["stories:11:title"]));
    internals.lastEditAt.set(USER_ID, new Date().toISOString());
    const stamp = new Date().toISOString();
    internals.editsByPath.set(
      "stories:11:title",
      new Map([[USER_ID, { first: stamp, last: stamp }]]),
    );
    internals.wordsByRow.set("stories", new Map([["11", new Map([[USER_ID, 5]])]]));
    internals.timeLedger.set(USER_ID, {
      pendingEditingMs: 60_000,
      pendingWritingMs: 60_000,
      lastChangeAt: new Date().toISOString(),
      lastWriteAt: new Date().toISOString(),
    });
    internals.newSessions.add(USER_ID);
    internals.wordBaseline.set("stories:11:title", 4);
  });
}

describe("a halt abandons the attribution it was holding", () => {
  it("leaves every pending ledger empty after the whole message has been processed", async () => {
    const harness = await guardHarness();
    const message = refusedDeleteMessage(harness.internals);
    // What the instance was already holding when the halt arrived.
    harness.internals.newSessions.add(USER_ID);
    harness.internals.userFieldSets.set(OTHER_USER, new Set(["stories:11:title"]));
    harness.internals.lastEditAt.set(OTHER_USER, new Date().toISOString());
    harness.internals.activityEmitted.set(USER_ID, new Set(["stories:11"]));
    harness.internals.displacements.record([{ client: 1, from: 0, to: 4 }]);
    const displacedBefore = harness.internals.displacements.size();
    expect(displacedBefore).toBeGreaterThan(0);
    const epochBefore = harness.internals.settleEpoch;
    expect(ledgerState(harness.internals).baseline).toBeGreaterThan(0);
    // The maps the observers captured at construction: abandonment clears them
    // in place, and a fresh map would leave every observer writing into the old
    // one.
    const captured = {
      fields: harness.internals.userFieldSets,
      lastEdit: harness.internals.lastEditAt,
      paths: harness.internals.editsByPath,
      words: harness.internals.wordsByRow,
      time: harness.internals.timeLedger,
      sessions: harness.internals.newSessions,
      baseline: harness.internals.wordBaseline,
      displacements: harness.internals.displacements,
    };
    // An observer after the accumulator, repopulating everything the halt gave
    // up. Only the drain's second abandonment answers for it.
    lateObserver(harness.internals, harness.editor);

    const restore = breakTheRevert();
    try {
      await harness.internals.webSocketMessage(harness.editor, message);
    } finally {
      restore();
    }

    expect(ledgerState(harness.internals)).toEqual({
      fields: 0,
      lastEdit: 0,
      paths: 0,
      words: 0,
      time: 0,
      sessions: 0,
      baseline: 0,
      seeded: false,
      // The dedup history and the reservations the eager flush took are kept:
      // clearing them would re-emit rows D1 already holds.
      emitted: 1,
    });
    expect(harness.internals.settleEpoch).toBeGreaterThan(epochBefore);
    // Bounded telemetry, not attribution: kept, and the same log.
    expect(harness.internals.displacements).toBe(captured.displacements);
    expect(harness.internals.displacements.size()).toBe(displacedBefore);
    // Every map is the one the observers hold.
    expect(harness.internals.userFieldSets).toBe(captured.fields);
    expect(harness.internals.lastEditAt).toBe(captured.lastEdit);
    expect(harness.internals.editsByPath).toBe(captured.paths);
    expect(harness.internals.wordsByRow).toBe(captured.words);
    expect(harness.internals.timeLedger).toBe(captured.time);
    expect(harness.internals.newSessions).toBe(captured.sessions);
    expect(harness.internals.wordBaseline).toBe(captured.baseline);
  });

  it("credits nothing for a transaction that arrives with the latch set", async () => {
    const harness = await guardHarness();
    harness.internals.messageFailed = true;

    harness.internals.ydoc.transact(() => {
      const story = harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
      (story.get("title") as Y.Text).insert(0, "words that earn nothing ");
    }, harness.editor);

    expect(harness.internals.userFieldSets.size).toBe(0);
    expect(harness.internals.timeLedger.size).toBe(0);
  });

  it("clears the same state immediately for a halt met at load", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    harness.internals.userFieldSets.set(USER_ID, new Set(["stories:11:title"]));
    harness.internals.newSessions.add(USER_ID);
    plantMarker(harness.storage, 0, "enforcement_failed");

    await expect(harness.internals.ensureDocLoaded())
      .rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.userFieldSets.size).toBe(0);
    expect(harness.internals.newSessions.size).toBe(0);
    expect(harness.internals.timeSeeded).toBe(false);
  });

  it.each([
    ["keeps its reservations when it lands", true],
    ["releases them when it fails", false],
  ])("an eager batch in flight across the abandonment %s", async (_label, lands) => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const held = heldBatch();
    let armed = false;
    const harness = await loaded({
      rows: ONE_STORY,
      batch: () => (armed ? held.hold() : undefined),
    }, {}, [], events);
    harness.sockets.push(editor);
    armed = true;

    // A healthy edit, so the real `flushActivityRows` builds and issues its own
    // batch; nothing is planted and nothing is deleted by hand.
    const pending = harness.internals.webSocketMessage(
      editor,
      updateMessage(Y.encodeStateAsUpdate(harness.internals.ydoc), (doc) => {
        (doc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text)
          .insert(0, "many more words written here ");
      }),
    );
    await held.issued;
    // The reservations are taken before the await, which is what makes them
    // reservations; the abandonment lands with the write still in flight.
    const reserved = [...(harness.internals.activityEmitted.get(USER_ID) ?? [])];
    expect(reserved.length).toBeGreaterThan(0);
    abandon(harness.internals);

    if (lands) held.release();
    else held.refuse(new Error("D1_ERROR: eager write failed"));
    await pending;

    // An eager batch that lands stays emitted; one that fails releases its own
    // keys, as it does on any failure. The abandonment adds no invalidation of
    // its own either way, and the field sets it cleared stay cleared.
    expect([...(harness.internals.activityEmitted.get(USER_ID) ?? [])])
      .toEqual(lands ? reserved : []);
    expect(harness.internals.userFieldSets.size).toBe(0);
    expect(harness.internals.wordsByRow.size).toBe(0);
    expect(harness.internals.editsByPath.size).toBe(0);
  });
});

/**
 * An instance halted by a real enforcement failure, with everything the halt
 * abandons already given up.
 */
async function haltedByEnforcement(db: Partial<DbScript> = {}, events: string[] = []) {
  const harness = await guardHarness({}, db, events);
  const message = refusedDeleteMessage(harness.internals);
  const restore = breakTheRevert();
  try {
    await harness.internals.webSocketMessage(harness.editor, message);
  } finally {
    restore();
  }
  expect(harness.internals.persistenceHalted).not.toBeNull();
  return harness;
}

/** The gap the stored stamps leave behind them: short enough to prove the rule. */
const GAP_MS = 10_000;

/** Stored stamps a gap below the window, so a fresh minute would be visible. */
function storedStamps() {
  const stamp = new Date(Date.now() - GAP_MS).toISOString();
  return { member_editing_time: [{ user_id: USER_ID, last_change_at: stamp, last_write_at: stamp }] };
}

/**
 * One real edit message from a socket attached to the generation the instance
 * now serves, and what it credited.
 *
 * A message rather than a bare transaction: the accumulator stands down while
 * the message-failure latch is set, and only the handler clears it.
 */
async function creditOneEdit(
  harness: { internals: Internals; sockets: FakeSocket[] },
  events: string[],
): Promise<{ editing: number; writing: number }> {
  const socket = fakeSocket(events, { generation: harness.internals.docGeneration ?? 0 });
  harness.sockets.push(socket);
  await harness.internals.webSocketMessage(
    socket,
    updateMessage(Y.encodeStateAsUpdate(harness.internals.ydoc), (doc) => {
      (doc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text)
        .insert(0, "many more words written here ");
    }),
  );
  const accrual = harness.internals.timeLedger.get(USER_ID);
  return { editing: accrual?.pendingEditingMs ?? 0, writing: accrual?.pendingWritingMs ?? 0 };
}

/** The gap rule's credit, and not the fresh minute a null stamp would earn. */
function expectGapCredit(ms: number): void {
  expect(ms).toBeGreaterThanOrEqual(GAP_MS);
  expect(ms).toBeLessThan(GAP_MS + 5_000);
}

describe("the seeding of the editing clock is successful only when the read succeeded", () => {
  it("leaves the flag false and fails the load when the stamp read rejects", async () => {
    let failing = true;
    const harness = makeDo({
      base: [tagged(BASE_A, 0, 0, 4)],
      stampReadFails: () => failing,
    });

    await expect(harness.internals.ensureDocLoaded()).rejects.toThrow(/stamp read failed/);
    expect(harness.internals.timeSeeded).toBe(false);
    expect(harness.internals.docLoaded).toBe(false);

    // The retry reads again, and opens.
    failing = false;
    await harness.internals.ensureDocLoaded();
    expect(harness.internals.timeSeeded).toBe(true);
    expect(harness.db.stampReads()).toBe(2);
  });

  it("answers /reset 200 with the replacement written when the stamp read rejects", async () => {
    let failing = false;
    const events: string[] = [];
    // Halted first, so the instance arrives with the flag already false and the
    // rejected read below is the only one this reset takes. A landed reset
    // abandons the ledgers and reads the stamps again whatever state it arrived
    // in; what a halt fixes here is that no earlier read can be mistaken for
    // this one's.
    const harness = await haltedByEnforcement({
      rows: { ...ONE_STORY, ...storedStamps() },
      stampReadFails: () => failing,
    }, events);
    expect(harness.internals.timeSeeded).toBe(false);
    failing = true;
    harness.db.clear();

    const answered = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    // The seeding runs past the landed write, so a rejected stamp read is a
    // finalisation failure over a row that already holds the replacement, and
    // the route says so.
    expect(answered.status).toBe(200);
    expect(harness.db.mutations.filter((s) => /^UPDATE projects SET yjs_state/.test(s.sql))).toHaveLength(1);
    expect(harness.internals.timeSeeded).toBe(false);
    expect(harness.internals.docLoaded).toBe(false);
    expect(errors.filter((l) => l.includes("the replacement landed and its attribution failed")))
      .toHaveLength(1);

    // The next reset reads the stamps again, lands, and admits an edit
    // afterwards.
    failing = false;
    const stampsBefore = harness.db.stampReads();
    const landed = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    expect(landed.status).toBe(200);
    expect(harness.db.stampReads()).toBe(stampsBefore + 1);
    expect(harness.internals.timeSeeded).toBe(true);

    // And the stamps that read put back are the ones the next edit is measured
    // against: the gap's own credit, not the minute a null stamp would earn.
    const credit = await creditOneEdit(harness, events);
    expectGapCredit(credit.editing);
    expectGapCredit(credit.writing);
  });

  it("reads no stamps for a replacement that failed to land, and reads them on the one that does", async () => {
    let failing = true;
    const events: string[] = [];
    const harness = await haltedByEnforcement({
      rows: { ...ONE_STORY, ...storedStamps() },
      // The row as it stands when nothing landed: the load claimed revision 4
      // to 5, and the reset reads 4 and conditions its write on it.
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 4 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        && failing ? { changes: 0 } : undefined),
    }, events);
    const stampsBefore = harness.db.stampReads();

    // The seeding sits past the write, so a replacement that did not land reads
    // no stamp at all, and `abandonReset` leaves the flag invalid.
    const refused = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    expect(refused.status).toBe(503);
    expect(harness.db.stampReads()).toBe(stampsBefore);
    expect(harness.internals.timeSeeded).toBe(false);

    failing = false;
    const landed = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    expect(landed.status).toBe(200);
    expect(harness.db.stampReads()).toBe(stampsBefore + 1);
    expect(harness.internals.timeSeeded).toBe(true);

    const credit = await creditOneEdit(harness, events);
    expectGapCredit(credit.editing);
    expectGapCredit(credit.writing);
  });
});

// ---------------------------------------------------------------------------
// Settlement across an abandonment
// ---------------------------------------------------------------------------

/** One prose edit through an editor's socket, so every ledger carries something. */
function driveOneEdit(internals: Internals, ws: unknown): void {
  const story = internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
  internals.ydoc.transact(() => {
    (story.get("title") as Y.Text).insert(0, "many more words written here ");
  }, ws);
  internals.newSessions.add(USER_ID);
}

/** The abandonment a halt performs, called where a halt would call it. */
function abandon(internals: Internals): void {
  (internals as unknown as { abandonAttribution: () => void }).abandonAttribution();
}

describe("a settlement built before an abandonment never runs after it", () => {
  it("settles nothing and leaves no negative figure against a reseeded entry", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    // A stored stamp, so the recovery's reseed puts the entry back rather than
    // leaving the ledger empty. An empty ledger cannot show the defect: the
    // settlement skips an entry that is not there, and only an entry PUT BACK
    // can be driven negative by a subtraction built before it existed.
    const STAMP = "2026-01-01T00:00:00.000Z";
    let spanned = false;
    const harness = await loaded({
      rows: {
        member_editing_time: [
          { user_id: USER_ID, last_change_at: STAMP, last_write_at: STAMP },
        ],
      },
      batch: async () => {
        if (spanned) return;
        spanned = true;
        // The halt's clearing and the recovery's reseed, both inside the window
        // the snapshot's batch is in flight — the credits were peeked before it.
        abandon(harness.internals);
        await harness.internals.seedEditingTime();
      },
    }, {}, [], events);
    harness.sockets.push(editor);
    driveOneEdit(harness.internals, editor);
    expect(harness.internals.timeLedger.get(USER_ID)?.pendingEditingMs).toBe(60_000);

    await harness.internals.doSnapshot();

    expect(spanned).toBe(true);
    const reseeded = harness.internals.timeLedger.get(USER_ID);
    // The reseeded entry stands exactly as the stamps left it.
    expect(reseeded).toEqual({
      pendingEditingMs: 0,
      pendingWritingMs: 0,
      lastChangeAt: STAMP,
      lastWriteAt: STAMP,
    });
    for (const accrual of harness.internals.timeLedger.values()) {
      expect(accrual.pendingEditingMs).toBeGreaterThanOrEqual(0);
      expect(accrual.pendingWritingMs).toBeGreaterThanOrEqual(0);
    }
    expect(harness.internals.wordsByRow.size).toBe(0);

    // And the next snapshot writes nothing from the abandoned span: no
    // contributor row at all, and the time row carries the stamps with no
    // seconds behind them.
    harness.db.clear();
    await harness.internals.doSnapshot();
    expect(harness.db.mutations.filter((s) => /INSERT INTO entity_contributors/.test(s.sql)))
      .toHaveLength(0);
    const timeRows = harness.db.mutations.filter(
      (s) => /INSERT INTO member_editing_time/.test(s.sql),
    );
    for (const row of timeRows) {
      expect(row.binds[2]).toBe(0);
      expect(row.binds[3]).toBe(0);
    }
  });

  it("makes an /editing-time reader take both figures again", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    let spanned = false;
    const harness = await loaded({
      rows: {
        member_editing_time: [{ user_id: USER_ID, editing_seconds: 120, writing_seconds: 60 }],
      },
    }, {}, [], events);
    harness.sockets.push(editor);
    driveOneEdit(harness.internals, editor);
    const stored = (harness.internals as unknown as {
      readStoredEditingTime: () => Promise<unknown>;
    });
    const real = stored.readStoredEditingTime.bind(stored);
    stored.readStoredEditingTime = async () => {
      const rows = await real();
      if (!spanned) {
        spanned = true;
        abandon(harness.internals);
      }
      return rows;
    };

    const response = await harness.doInstance.fetch(
      await signedRequest("/editing-time", "editing-time", undefined, "GET"),
    );

    expect(response.status).toBe(200);
    // The stored totals alone, and nothing negative: the second read meets a
    // cleared ledger and adds nothing to them.
    expect(await response.json()).toEqual({
      times: [{ userId: USER_ID, editingSeconds: 120, writingSeconds: 60 }],
    });
  });
});

// ---------------------------------------------------------------------------
// The fence refusal writes its marker
// ---------------------------------------------------------------------------

describe("a refused write fence is a halt with a marker", () => {
  it("writes fence_refused after a successful storage validation", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = await loaded({
      reacquire: [null],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    }, {}, [], events);
    harness.sockets.push(socket);

    await expect(harness.internals.doSnapshot()).rejects.toThrow();

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("fence_refused");
    expect(harness.storage.kv.get(haltKey(0))).toMatchObject({ reason: "fence_refused" });
    expect(socket.closes).toEqual([UNAVAILABLE]);
  });

  it("writes no marker when the validation itself rejects", async () => {
    const events: string[] = [];
    const harness = await loaded({
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 5 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    }, {
      // The generation read AFTER the load's own, which is re-acquisition's.
      failOn: (kind, nth) => (kind === "generation" && nth > 2 ? new Error("storage down") : undefined),
    }, [], events);

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(ExactBaseError);

    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.storage.kv.has(haltKey(0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The route matrix
// ---------------------------------------------------------------------------

const MUTATING_ROUTES: Array<[string, string, unknown]> = [
  ["/snapshot", "snapshot", undefined],
  ["/restore-orphans", "restore-orphans", { stories: [{ storyId: "lost", steps: [], layers: [] }] }],
  ["/ingest-sync", "ingest-sync", { pages: { insert: [{ slug: "about", created_by: USER_ID }] } }],
  ["/clear-course-markers", "clear-course-markers", { courseProjectId: 5 }],
];

describe("every route has one answer under a resident halt", () => {
  it.each(MUTATING_ROUTES)("answers %s with 503 persistence_halted, mutating nothing", async (path, action, body) => {
    const harness = await haltedByEnforcement();
    harness.db.clear();
    const before = Y.encodeStateAsUpdate(harness.internals.ydoc);

    const response = await harness.doInstance.fetch(await signedRequest(path, action, body));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("persistence_halted");
    expect(writes(harness.db.mutations)).toHaveLength(0);
    expect(harness.db.batchCalls()).toBe(0);
    expect(Y.encodeStateAsUpdate(harness.internals.ydoc)).toEqual(before);
  });

  it.each(MUTATING_ROUTES)("answers %s the same way when the load meets the marker", async (path, action, body) => {
    const events: string[] = [];
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY }, {}, [], events);
    plantMarker(harness.storage, 0, "log_corrupt");

    const response = await harness.doInstance.fetch(await signedRequest(path, action, body));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("persistence_halted");
    expect(writes(harness.db.mutations)).toHaveLength(0);
    expect(harness.internals.docLoaded).toBe(false);
  });

  it("keeps /restore-orphans' early success for an empty request, which mutates nothing", async () => {
    const harness = await haltedByEnforcement();

    const response = await harness.doInstance.fetch(
      await signedRequest("/restore-orphans", "restore-orphans", { stories: [] }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ restored: 0 });
  });

  it("answers the read-only routes as usual and makes the alarm issue nothing", async () => {
    const harness = await haltedByEnforcement();
    harness.db.clear();

    const count = await harness.doInstance.fetch(
      await signedRequest("/active-ws-count", "active-ws-count", undefined, "GET"),
    );
    expect(count.status).toBe(200);
    const time = await harness.doInstance.fetch(
      await signedRequest("/editing-time", "editing-time", undefined, "GET"),
    );
    expect(time.status).toBe(200);
    const deleted = await harness.doInstance.fetch(
      await signedRequest("/notify-deleted", "notify-deleted"),
    );
    expect(deleted.status).toBe(200);

    // The alarm under the halt: no statement of either kind, nothing written to
    // storage, no alarm rescheduled, and no socket touched.
    harness.db.clear();
    harness.events.length = 0;
    harness.editor.closes.length = 0;
    harness.peer.sent.length = 0;
    await harness.internals.alarm();
    expect(harness.db.mutations).toHaveLength(0);
    expect(harness.db.reads).toHaveLength(0);
    expect(harness.events.filter((e) => e.startsWith("put:") || e.startsWith("close:")
      || e === "set-alarm" || e === "delete-alarm" || e === "send" || e === "delete"))
      .toEqual([]);
    expect(harness.editor.closes).toEqual([]);
    expect(harness.peer.sent).toHaveLength(0);
  });

  it("refuses an upgrade before it accepts anything", async () => {
    const harness = await haltedByEnforcement();

    const response = await upgrade(harness);

    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe("persistence_halted");
    expect(harness.ctx.acceptWebSocket).not.toHaveBeenCalled();
  });

  it("refuses an upgrade that was already past its own gate when the halt was entered", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY });
    const load = harness.internals.ensureDocLoaded.bind(harness.internals);
    harness.internals.ensureDocLoaded = async () => {
      await load();
      (harness.internals as unknown as {
        enterHalt: (reason: string, generation: number) => void;
      }).enterHalt("apply_failed", 0);
    };

    const response = await upgrade(harness);

    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe("persistence_halted");
    expect(harness.ctx.acceptWebSocket).not.toHaveBeenCalled();
  });

  it("closes a socket at the first fence and applies nothing", async () => {
    const harness = await haltedByEnforcement();
    harness.editor.closes.length = 0;
    harness.peer.sent.length = 0;
    const before = Y.encodeStateAsUpdate(harness.internals.ydoc);

    // The halt is resident before the message arrives.
    await harness.internals.webSocketMessage(
      harness.editor,
      updateMessage(before, (doc) => {
        doc.getArray<Y.Map<unknown>>("stories").get(0).set("byline", "dropped");
      }),
    );
    expect(harness.editor.closes).toEqual([UNAVAILABLE]);
    expect(harness.peer.sent).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(harness.internals.ydoc)).toEqual(before);
  });

  it("closes an awareness socket at the first fence and relays nothing", async () => {
    const harness = await haltedByEnforcement();
    harness.editor.closes.length = 0;
    harness.peer.sent.length = 0;

    const { message, clientId } = awarenessMessage();
    await harness.internals.webSocketMessage(harness.editor, message);

    expect(harness.editor.closes).toEqual([UNAVAILABLE]);
    expect(harness.peer.sent).toHaveLength(0);
    expect(harness.internals.awareness.getStates().has(clientId)).toBe(false);
  });

  /**
   * An instance the first fence admits and whose awaited load enters the halt,
   * so a handler already past the first check meets the second.
   */
  function haltedDuringLoad(events: string[]) {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY }, {}, [], events);
    harness.internals.docGeneration = 0;
    const load = harness.internals.ensureDocLoaded.bind(harness.internals);
    harness.internals.ensureDocLoaded = async () => {
      await load();
      (harness.internals as unknown as {
        enterHalt: (reason: string, generation: number) => void;
      }).enterHalt("apply_failed", 0);
    };
    return harness;
  }

  it("closes a sync socket at the SECOND fence, when the halt arrives during the load", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = haltedDuringLoad(events);
    harness.sockets.push(socket, peer);
    // Built from the base rather than from the document, which is empty until
    // the load inside this very message.
    const message = updateMessage(BASE_A, (doc) => {
      doc.getArray<Y.Map<unknown>>("stories").get(0).set("byline", "dropped");
    });

    await harness.internals.webSocketMessage(socket, message);

    expect(socket.closes).toContainEqual(UNAVAILABLE);
    expect(peer.sent).toHaveLength(0);
    expect(harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("byline"))
      .toBeUndefined();
  });

  it("closes an awareness socket at the SECOND fence, when the halt arrives during the load", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = haltedDuringLoad(events);
    harness.sockets.push(socket, peer);
    const { message, clientId } = awarenessMessage();

    await harness.internals.webSocketMessage(socket, message);

    expect(socket.closes).toContainEqual(UNAVAILABLE);
    expect(peer.sent).toHaveLength(0);
    expect(harness.internals.awareness.getStates().has(clientId)).toBe(false);
  });

  it("closes a socket whose load met the marker, applying nothing", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {}, [], events);
    harness.sockets.push(socket);
    harness.internals.docGeneration = 0;
    plantMarker(harness.storage, 0, "log_corrupt");

    await harness.internals.webSocketMessage(socket, step1Message());

    expect(socket.closes).toContainEqual(UNAVAILABLE);
    expect(socket.sent).toHaveLength(0);
    expect(harness.internals.docLoaded).toBe(false);
  });
});

describe("a halt entered during a route's own flush answers that request", () => {
  it.each(MUTATING_ROUTES)("answers %s 503 persistence_halted", async (path, action, body) => {
    const events: string[] = [];
    const harness = await loaded({
      rows: ONE_STORY,
      reacquire: [null],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    }, {}, [], events);

    const response = await harness.doInstance.fetch(await signedRequest(path, action, body));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("persistence_halted");
    expect(harness.internals.persistenceHalted?.marker.reason).toBe("fence_refused");
  });

  it("keeps /snapshot's own code for a snapshot that failed for any other reason", async () => {
    const harness = await loaded({
      rows: ONE_STORY,
      batch: () => { throw new Error("D1_ERROR: batch failed"); },
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 6 } as BaseRowShape],
    });

    const response = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("snapshot_failed");
    expect(harness.internals.persistenceHalted).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /reset, the one mutating route that answers
// ---------------------------------------------------------------------------

describe("/reset and the generations a halt belongs to", () => {
  it("clears the halt on its landed replacement, and the new generation reads no marker", async () => {
    const harness = await haltedByEnforcement();

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.internals.docGeneration).toBe(1);
    expect(harness.storage.kv.has(haltKey(1))).toBe(false);
    // The old generation's marker is unreachable from the new prefix, and is
    // left for the maintenance alarm.
    expect(harness.storage.kv.has(haltKey(0))).toBe(true);
    expect(harness.internals.docLoaded).toBe(true);
  });

  it("leaves the state and the marker when its own put fails", async () => {
    const harness = await haltedByEnforcement();
    const storage = harness.storage;
    const realPut = storage.put.bind(storage);
    (storage as unknown as { put: unknown }).put = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0] === "docGeneration") {
        throw new Error("storage down");
      }
      return (realPut as (...a: unknown[]) => Promise<void>)(...args);
    };

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(harness.internals.persistenceHalted?.generation).toBe(0);
    expect(harness.storage.kv.get(haltKey(0))).toMatchObject({ reason: "enforcement_failed" });
  });

  it("clears a halt two generations old on the retry that lands", async () => {
    let refusing = true;
    const harness = await haltedByEnforcement({
      // The replacement lands zero rows once and the row has not moved, which
      // is the failure that spends a generation: the switch is behind it.
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 4 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        && refusing ? { changes: 0 } : undefined),
    });

    // The first reset spends generation 1 and fails past its switch, leaving
    // the halt resident under a generation already advanced past.
    const failed = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    expect(failed.status).toBe(503);
    expect(harness.internals.persistenceHalted?.generation).toBe(0);
    expect(harness.internals.docGeneration).toBe(1);
    // And the staged base for generation 1 stands, exact and unreachable until
    // a load names it.
    expect(harness.storage.kv.has(baseKey(1))).toBe(true);

    // The retry lands under generation 2 and clears it.
    refusing = false;
    const landed = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    expect(landed.status).toBe(200);
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.internals.docGeneration).toBe(2);
    expect(harness.internals.docLoaded).toBe(true);
    expect(titles(harness.internals.ydoc)).toEqual(["Story A"]);
  });

  it("spends no generation when the rebuild fails, and clears the halt on the next reset", async () => {
    let build = 0;
    const harness = await haltedByEnforcement();
    const realBuild = harness.internals.buildFromD1Rows.bind(harness.internals);
    harness.internals.buildFromD1Rows = async () => {
      if (build++ === 0) throw new Error("D1_ERROR: rebuild failed");
      return realBuild();
    };

    const failed = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    expect(failed.status).toBe(503);
    expect(harness.internals.persistenceHalted?.generation).toBe(0);
    // The build sits before the staging and before the switch, so nothing is
    // spent and no key is written.
    expect(harness.internals.docGeneration).toBe(0);
    expect(harness.storage.kv.has(baseKey(1))).toBe(false);

    const landed = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    expect(landed.status).toBe(200);
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.internals.docGeneration).toBe(1);
    expect(titles(harness.internals.ydoc)).toEqual(["Story A"]);
  });

  it("keeps a halt the rebuilt document raises under the new generation", async () => {
    const harness = await haltedByEnforcement();
    const realBuild = harness.internals.buildFromD1Rows.bind(harness.internals);
    harness.internals.buildFromD1Rows = async () => {
      await realBuild();
      // The replacement document raises an enforcement failure of its own,
      // under the generation this reset has already advanced to.
      (harness.internals as unknown as {
        enterHalt: (reason: string, generation: number) => void;
      }).enterHalt("enforcement_failed", 1);
    };

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(harness.internals.persistenceHalted).toMatchObject({ generation: 1 });
    expect(harness.storage.kv.has(haltKey(1))).toBe(true);
    expect(harness.internals.docLoaded).toBe(true);

    // And a retry clears the new-generation halt only by landing past it with a
    // rebuild that raises none.
    harness.internals.buildFromD1Rows = realBuild;
    const again = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    expect(again.status).toBe(200);
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.internals.docGeneration).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /persistence-state
// ---------------------------------------------------------------------------

async function stateRequest(action = "persistence-state"): Promise<Request> {
  return signedRequest("/persistence-state", action, undefined, "GET");
}

describe("GET /persistence-state reads, and does nothing else", () => {
  it("answers from the instance's state when the document is open", async () => {
    const harness = await haltedByEnforcement();

    const response = await harness.doInstance.fetch(await stateRequest());
    const body = await response.json() as { halted: boolean; reason: string; generation: number };

    expect(response.status).toBe(200);
    expect(body.halted).toBe(true);
    expect(body.reason).toBe("enforcement_failed");
    expect(body.generation).toBe(0);
  });

  it("answers from storage when the document is not loaded, issuing no statement", async () => {
    const events: string[] = [];
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {}, [], events);
    plantMarker(harness.storage, 3, "log_corrupt");
    harness.storage.kv.set("docGeneration", 3);

    const response = await harness.doInstance.fetch(await stateRequest());

    expect(await response.json()).toMatchObject({
      halted: true,
      reason: "log_corrupt",
      generation: 3,
    });
    // No load, no claim, no repair, no flush, no socket effect, no alarm —
    // asserted over both inventories, since a loader's first act is a SELECT.
    expect(harness.db.mutations).toHaveLength(0);
    expect(harness.db.reads).toHaveLength(0);
    expect(events.filter((e) => e === "read-base" || e.startsWith("run:"))).toEqual([]);
    expect(events.filter((e) => e.startsWith("put:") || e.startsWith("close:"))).toEqual([]);
    expect(events).not.toContain("delete-alarm");
    expect(harness.internals.docLoaded).toBe(false);
  });

  it("reports no durable halt for the current generation when storage holds none", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });

    const response = await harness.doInstance.fetch(await stateRequest());

    expect(await response.json()).toEqual({ halted: false, generation: 0 });
  });

  it("answers 503 generation_malformed for a stored generation that is not one", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    harness.storage.kv.set("docGeneration", -2);

    const response = await harness.doInstance.fetch(await stateRequest());

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("generation_malformed");
  });

  it.each([
    ["the generation", "generation"],
    ["the marker", "halt"],
  ])("answers 503 storage_unavailable when %s cannot be read", async (_label, kind) => {
    const harness = makeDo(
      { base: [tagged(BASE_A, 0, 0, 4)] },
      { failOn: (k) => (k === kind ? new Error("storage down") : undefined) },
    );

    const response = await harness.doInstance.fetch(await stateRequest());

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("storage_unavailable");
  });

  it("is refused without its own signature, and by a signature for another operation", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });

    const unsigned = await harness.doInstance.fetch(
      new Request("https://internal/persistence-state", { method: "GET" }),
    );
    expect(unsigned.status).toBe(401);

    const wrongOperation = await harness.doInstance.fetch(await stateRequest("snapshot"));
    expect(wrongOperation.status).toBe(401);

    const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, TEST_SECRET, "persistence-state");
    const stale = await harness.doInstance.fetch(
      new Request("https://internal/persistence-state", {
        method: "GET",
        headers: {
          "X-Internal-Auth": sigHex,
          "X-Internal-Timestamp": String(timestamp - 10 * 60 * 1000),
          "X-Internal-Project": String(PROJECT_ID),
        },
      }),
    );
    expect(stale.status).toBe(401);

    const mismatched = await harness.doInstance.fetch(
      new Request("https://internal/persistence-state", {
        method: "GET",
        headers: {
          "X-Internal-Auth": sigHex,
          "X-Internal-Timestamp": String(timestamp),
          "X-Internal-Project": "99",
        },
      }),
    );
    expect(mismatched.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /reset's two signed preconditions
// ---------------------------------------------------------------------------

/**
 * A reset request whose query states preconditions and whose marker binds
 * `signedAs`. The two are supplied separately so a test can sign for one set of
 * parameters and send another, which is the whole point of the binding.
 */
async function guardedReset(query: string, signedAs?: string): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(
    PROJECT_ID,
    TEST_SECRET,
    "reset",
    signedAs,
  );
  return new Request(`https://internal/reset${query}`, {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(PROJECT_ID),
    },
  });
}

/** An unloaded instance whose storage holds a planted halt for generation 0. */
function markedButUnloaded(marker = "log_corrupt", db: Partial<DbScript> = {}) {
  const events: string[] = [];
  const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY, ...db }, {}, [], events);
  plantMarker(harness.storage, 0, marker);
  return { harness, events };
}

/**
 * What a refused reset has to leave exactly as it found it, captured before the
 * request goes in.
 *
 * The attribution is seeded HERE rather than assumed, because an empty ledger
 * cannot tell an untouched instance from one the loader's marker read has
 * abandoned: the assertion needs something to preserve.
 */
function beforeReset(harness: ReturnType<typeof makeDo>) {
  harness.internals.newSessions.add(USER_ID);
  harness.internals.lastEditAt.set(USER_ID, "2026-01-01T00:00:00.000Z");
  harness.internals.userFieldSets.set(USER_ID, new Set(["stories:11:title"]));
  return {
    ledger: ledgerState(harness.internals),
    titles: titles(harness.internals.ydoc),
    marker: harness.storage.kv.get(haltKey(0)),
  };
}

/** Nothing the reset was refused before may have moved. */
function assertNothingTouched(
  harness: ReturnType<typeof makeDo>,
  events: string[],
  before: ReturnType<typeof beforeReset>,
  sockets: FakeSocket[] = [],
) {
  expect(events.filter((e) => e.startsWith("put:"))).toEqual([]);
  expect(writes(harness.db.mutations)).toEqual([]);
  // A SELECT is not a mutation, so the read inventory has to be named on its
  // own: a refusal that reached the row would leave the mutation list empty
  // and still have woken D1 for a request that touches nothing.
  expect(harness.db.reads).toEqual([]);
  expect(events.filter((e) => e.startsWith("close:"))).toEqual([]);
  expect(events).not.toContain("delete-alarm");
  expect(harness.storage.kv.get("docGeneration")).toBe(0);
  for (const socket of sockets) expect(socket.closes).toEqual([]);
  expect(titles(harness.internals.ydoc)).toEqual(before.titles);
  expect(ledgerState(harness.internals)).toEqual(before.ledger);
  expect(harness.storage.kv.get(haltKey(0))).toBe(before.marker);
}

/** What `GET /persistence-state` answers for this instance right now. */
async function stateThroughRoute(
  harness: ReturnType<typeof makeDo>,
): Promise<{ halted: boolean; reason?: string; generation: number }> {
  const response = await harness.doInstance.fetch(
    await signedRequest("/persistence-state", "persistence-state", undefined, "GET"),
  );
  expect(response.status).toBe(200);
  return await response.json();
}

describe("/reset compares the generation the caller expected", () => {
  it("resets when the generation matches", async () => {
    const harness = await loaded();

    const response = await harness.doInstance.fetch(await guardedReset("?expectedGeneration=0", "0"));

    expect(response.status).toBe(200);
    expect(harness.internals.docGeneration).toBe(1);
    expect(titles(harness.internals.ydoc)).toEqual(["Story A"]);
  });

  it("answers 409 with the current generation and touches nothing on a mismatch", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = await loaded({}, {}, [socket], events);
    const before = beforeReset(harness);

    const response = await harness.doInstance.fetch(await guardedReset("?expectedGeneration=3", "3"));

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("reset_stale:0");
    assertNothingTouched(harness, events, before, [socket]);
    expect(harness.internals.docGeneration).toBe(0);
    // A refused precondition is not a failure of the object, and takes no line.
    expect(errors.filter((line) => line.includes("[reset]"))).toEqual([]);
  });

  it("lands the first of two confirmations of the same generation and calls the second stale", async () => {
    const harness = await loaded();

    const first = await harness.doInstance.fetch(await guardedReset("?expectedGeneration=0", "0"));
    const second = await harness.doInstance.fetch(await guardedReset("?expectedGeneration=0", "0"));

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.text()).toBe("reset_stale:1");
    expect(harness.internals.docGeneration).toBe(1);
  });
});

describe("/reset refuses a halted project when the caller asked it to", () => {
  it("answers 409 reset_halted against a resident halt, touching nothing", async () => {
    const events: string[] = [];
    const harness = await haltedByEnforcement({}, events);
    harness.db.clear();
    events.length = 0;
    errors.length = 0;
    const before = beforeReset(harness);

    const response = await harness.doInstance.fetch(
      await guardedReset("?expectedGeneration=0&requireNotHalted=1", "0|nh"),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("reset_halted");
    assertNothingTouched(harness, events, before);
    expect(harness.internals.persistenceHalted).toMatchObject({ generation: 0 });
    expect(errors.filter((line) => line.includes("[reset]"))).toEqual([]);
  });

  it("answers 409 reset_halted against a durable marker with no resident state, installing none", async () => {
    const { harness, events } = markedButUnloaded();
    const socket = fakeSocket(events);
    harness.sockets.push(socket);
    const before = beforeReset(harness);

    const response = await harness.doInstance.fetch(
      await guardedReset("?expectedGeneration=0&requireNotHalted=1", "0|nh"),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("reset_halted");
    // The loader's marker read installs the halt, abandons attribution and
    // closes every socket; a precondition may do none of that.
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.internals.docLoaded).toBe(false);
    assertNothingTouched(harness, events, before, [socket]);
    expect(haltedLoadLines()).toEqual([]);
  });

  it("counts a malformed marker as halted", async () => {
    const { harness, events } = markedButUnloaded();
    harness.storage.kv.set(haltKey(0), { v: 2, reason: "who knows", at: -1 });
    const before = beforeReset(harness);

    const response = await harness.doInstance.fetch(
      await guardedReset("?expectedGeneration=0&requireNotHalted=1", "0|nh"),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("reset_halted");
    // The damaged value stands exactly as it was found.
    expect(harness.storage.kv.get(haltKey(0))).toEqual({ v: 2, reason: "who knows", at: -1 });
    assertNothingTouched(harness, events, before);
  });

  it("answers 409 reset_halted for a halted project whose row carries a NULL blob", async () => {
    const events: string[] = [];
    const harness = makeDo({ base: [cold(4)], rows: ONE_STORY }, {}, [], events);
    plantMarker(harness.storage, 0, "apply_failed");
    const before = beforeReset(harness);

    const response = await harness.doInstance.fetch(
      await guardedReset("?expectedGeneration=0&requireNotHalted=1", "0|nh"),
    );

    expect(response.status).toBe(409);
    assertNothingTouched(harness, events, before);
  });

  it("answers 503 with nothing mutated when the marker read rejects", async () => {
    const events: string[] = [];
    const harness = makeDo(
      { base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY },
      { failOn: (kind) => (kind === "halt" ? new Error("storage down") : undefined) },
      [],
      events,
    );
    const before = beforeReset(harness);

    const response = await harness.doInstance.fetch(
      await guardedReset("?expectedGeneration=0&requireNotHalted=1", "0|nh"),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("reset_failed");
    assertNothingTouched(harness, events, before);
    expect(harness.internals.persistenceHalted).toBeNull();
  });

  it("resets a healthy project under both preconditions", async () => {
    const harness = await loaded();

    const response = await harness.doInstance.fetch(
      await guardedReset("?expectedGeneration=0&requireNotHalted=1", "0|nh"),
    );

    expect(response.status).toBe(200);
    expect(harness.internals.docGeneration).toBe(1);
  });

  it("refuses a reset whose halt was entered under the generation the read returned", async () => {
    // The window the generation alone cannot close: the state was read healthy,
    // and the halt written since belongs to the very generation the caller is
    // still expecting. The read is the one the helper makes — the route, not an
    // internal field — so what the caller acted on is what is asserted.
    const harness = await loaded();
    const read = await stateThroughRoute(harness);
    expect(read).toMatchObject({ halted: false, generation: 0 });
    (harness.internals as unknown as {
      enterHalt: (reason: string, generation: number) => void;
    }).enterHalt("enforcement_failed", read.generation);
    harness.db.clear();

    const response = await harness.doInstance.fetch(
      await guardedReset(
        `?expectedGeneration=${read.generation}&requireNotHalted=1`,
        `${read.generation}|nh`,
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("reset_halted");
    expect(harness.internals.docGeneration).toBe(0);
    expect(writes(harness.db.mutations)).toEqual([]);
  });

  it("refuses the same sequence for a project whose row carries a NULL blob", async () => {
    // The anomaly the reset exists to recover is still not a reason to run one
    // over a halt: the row's shape does not enter the guard's decision.
    const events: string[] = [];
    const harness = makeDo({ base: [cold(4)], rows: ONE_STORY }, {}, [], events);
    const read = await stateThroughRoute(harness);
    expect(read).toMatchObject({ halted: false, generation: 0 });
    harness.db.clear();
    events.length = 0;
    plantMarker(harness.storage, read.generation, "apply_failed");
    const before = beforeReset(harness);

    const response = await harness.doInstance.fetch(
      await guardedReset(
        `?expectedGeneration=${read.generation}&requireNotHalted=1`,
        `${read.generation}|nh`,
      ),
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toBe("reset_halted");
    assertNothingTouched(harness, events, before);
  });
});

describe("/reset's preconditions travel in its signature", () => {
  it("runs unguarded, on the unguarded signature, when neither parameter is present", async () => {
    const harness = await loaded();

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(harness.internals.docGeneration).toBe(1);
  });

  it.each([
    ["a marker bound to another generation", "?expectedGeneration=0", "1"],
    ["a marker binding nothing", "?expectedGeneration=0", undefined],
    ["the flag added after signing", "?expectedGeneration=0&requireNotHalted=1", "0"],
    ["the flag removed after signing", "?expectedGeneration=0", "0|nh"],
  ])("refuses %s", async (_label, query, signedAs) => {
    const harness = await loaded();

    const response = await harness.doInstance.fetch(await guardedReset(query, signedAs));

    expect(response.status).toBe(401);
    expect(harness.internals.docGeneration).toBe(0);
  });

  it.each([
    ["the flag on its own", "?requireNotHalted=1"],
    ["an empty generation", "?expectedGeneration="],
    ["a negative generation", "?expectedGeneration=-1"],
    ["a non-canonical generation", "?expectedGeneration=01"],
    ["a fractional generation", "?expectedGeneration=1.0"],
    ["a generation past the safe range", "?expectedGeneration=9007199254740993"],
    ["a flag that is not one", "?expectedGeneration=0&requireNotHalted=0"],
    ["an empty flag", "?expectedGeneration=0&requireNotHalted="],
  ])("answers 400 for %s, and never falls back to an unguarded reset", async (_label, query) => {
    const events: string[] = [];
    const harness = await loaded({}, {}, [], events);
    const before = beforeReset(harness);

    const response = await harness.doInstance.fetch(await guardedReset(query, "0"));

    expect(response.status).toBe(400);
    expect(harness.internals.docGeneration).toBe(0);
    assertNothingTouched(harness, events, before);
  });
});

// ---------------------------------------------------------------------------
// The staged reset
// ---------------------------------------------------------------------------

/** Let every resolved continuation run, so an in-flight route reaches its next await. */
async function settle(times = 50): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The two deadlines the object arms, as the source names them. */
const MAINTENANCE_DELAY_MS = 5_000;
const SNAPSHOT_ALARM_MS = 30_000;

/**
 * A clock that does not move for the length of one case, so a deadline is an
 * exact number rather than an inequality around a wall clock.
 *
 * `Date.now` alone: `new Date()` is what the fence's timestamps read and
 * `setTimeout` is what `settle` drives, so neither is disturbed. The spy is a
 * restorable one and the file's `afterEach` restores it, so no case carries a
 * frozen clock into the next.
 */
function freezeClock(): number {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  return now;
}

/** The delay a `setAlarm` deadline stands for, measured from now. */
function armedIn(storage: FakeStorage): number {
  const at = storage.alarms[storage.alarms.length - 1];
  expect(at).toBeGreaterThan(0);
  return at - Date.now();
}

/**
 * The gate depth every protected operation ran at, by kind.
 *
 * A gate count alone is met by an empty gate followed by ungated work, which is
 * exactly what these cases have to refuse: the claim is that the reset's and the
 * alarm's storage accesses and statements are INSIDE one gate, and only the
 * depth at each operation says so.
 */
function watchDepths(harness: ReturnType<typeof makeDo>) {
  const seen: Array<{ kind: string; depth: number }> = [];
  const storage = harness.ctx.storage as unknown as Record<string, (...a: never[]) => unknown>;
  for (const name of ["get", "put", "delete", "list", "setAlarm", "getAlarm"]) {
    const real = (storage[name] as (...a: never[]) => unknown).bind(storage);
    storage[name] = (...args: never[]) => {
      seen.push({ kind: name, depth: harness.ctx.depth });
      return real(...args);
    };
  }
  const db = harness.env.DB as unknown as {
    prepare: (sql: string) => Record<string, unknown>;
    batch: (statements: unknown[]) => Promise<unknown>;
  };
  const prepare = db.prepare.bind(db);
  const batch = db.batch.bind(db);
  db.prepare = (sql: string) => {
    const stmt = prepare(sql);
    for (const name of ["run", "first", "all"]) {
      const real = stmt[name] as () => Promise<unknown>;
      stmt[name] = async () => {
        seen.push({ kind: `d1:${name}`, depth: harness.ctx.depth });
        return await real.call(stmt);
      };
    }
    return stmt;
  };
  db.batch = async (statements: unknown[]) => {
    seen.push({ kind: "d1:batch", depth: harness.ctx.depth });
    return await batch(statements);
  };
  return {
    /** Every depth recorded for the named kinds, so an empty list cannot pass. */
    depthsOf(...kinds: string[]): number[] {
      return seen.filter((entry) => kinds.includes(entry.kind)).map((entry) => entry.depth);
    },
  };
}

/**
 * A reset run on an instance already serving a document, over a LIVE `projects`
 * row.
 *
 * The row has to answer the next read with what the last write left: a
 * recovery case asks what a load finds after a reset that did not land, and a
 * second scripted answer would be the test asserting its own premise.
 */
async function stagedResetHarness(
  db: Partial<DbScript> = {},
  storageOpts: StorageOptions = {},
  events: string[] = [],
) {
  const harness = makeDo(
    { row: tagged(BASE_A, 0, 0, 4), rows: ONE_STORY, ...db },
    // The read-side seams only, for the load; the rest are armed once it has
    // opened, so a failure written for the reset does not meet the record the
    // load's own repairs write.
    { failOn: storageOpts.failOn },
    [],
    events,
  );
  await harness.internals.ensureDocLoaded();
  // The record the load wrote arms the alarm through a promise; let that land
  // before the reset's own ordered record begins.
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.storage.arm(storageOpts);
  const socket = fakeSocket(events);
  harness.sockets.push(socket);
  // What the load spent is not what the reset spends.
  harness.storage.putBatches.length = 0;
  harness.storage.deleteBatches.length = 0;
  harness.storage.lists.length = 0;
  harness.storage.alarms.length = 0;
  harness.storage.disarmAlarm();
  harness.db.clear();
  events.length = 0;
  errors.length = 0;
  return { ...harness, socket };
}

/** The codec's part size, and a document one part past a single put batch. */
const PART_LIMIT_BYTES = 96 * 1024;
const OVER_ONE_BATCH_BYTES = 128 * PART_LIMIT_BYTES + 1;

/**
 * Make the rebuilt document as large as `bytesOf` answers, so a staged group
 * spans the parts and the put batches a case needs.
 *
 * The size is read at each rebuild, so one harness can stage a large base and
 * then a smaller one over it.
 */
function inflateRebuild(harness: { internals: Internals }, bytesOf: () => number): void {
  const build = harness.internals.buildFromD1Rows.bind(harness.internals);
  harness.internals.buildFromD1Rows = async () => {
    await build();
    const bytes = bytesOf();
    if (bytes > 0) {
      harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0)
        .set("byline", "b".repeat(bytes));
    }
  };
}

/** Every base part standing under one generation, in key order. */
function partsOf(storage: FakeStorage, generation: number): string[] {
  return [...storage.kv.keys()].filter((key) => key.startsWith(`${baseKey(generation)}:`)).sort();
}

/** The replacement writes a reset issues, which a refused one issues none of. */
function blobWrites(harness: { db: { mutations: Issued[] } }): Issued[] {
  return harness.db.mutations.filter((s) => /^UPDATE projects SET yjs_state/.test(s.sql));
}

/** The storage record a reset writes and reads, without the D1 reads between. */
function resetRecord(events: string[]): string[] {
  return events.filter((event) =>
    event === "get:generation" ||
    event === "get:halt" ||
    event === "read-base" ||
    event === "read-stamps" ||
    event === "delete" ||
    event === "set-alarm" ||
    event === "send" ||
    event.startsWith("put:") ||
    /^run:UPDATE projects SET yjs_state/.test(event));
}

describe("the reset stages its base before it switches", () => {
  it("reads, stages, switches, replaces, seeds, retires, arms and announces in that order", async () => {
    const events: string[] = [];
    const harness = await stagedResetHarness({}, {}, events);

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(resetRecord(events)).toEqual([
      "get:generation",
      "read-base",
      // Parts then header, in one batch: the group is atomic and the switch is
      // issued only once the whole of it has resolved.
      "put:base,base",
      "put:generation",
      "run:UPDATE projects SET yjs_state = ?,",
      "read-stamps",
      "delete",
      "set-alarm",
      "send",
    ]);
    expect(harness.storage.putBatches[0]).toEqual([`${baseKey(1)}:0001`, baseKey(1)]);
    expect(harness.storage.deleteBatches).toEqual([[baseKey(1)]]);
  });

  it("issues no D1 access for a precondition it refuses, and answers 409 before the row read", async () => {
    const events: string[] = [];
    const harness = await stagedResetHarness({}, {}, events);

    const stale = await harness.doInstance.fetch(await guardedReset("?expectedGeneration=7", "7"));

    expect(stale.status).toBe(409);
    expect(await stale.text()).toBe("reset_stale:0");
    expect(events).toEqual(["get:generation"]);
    expect(harness.db.reads).toHaveLength(0);
    expect(harness.db.mutations).toHaveLength(0);
    expect(harness.storage.putBatches).toHaveLength(0);
  });

  it("refuses a halted project with the same 409 contract and no D1 access", async () => {
    const events: string[] = [];
    const harness = await stagedResetHarness({}, {}, events);
    plantMarker(harness.storage, 0, "enforcement_failed");

    const halted = await harness.doInstance.fetch(
      await guardedReset("?expectedGeneration=0&requireNotHalted=1", "0|nh"),
    );

    expect(halted.status).toBe(409);
    expect(await halted.text()).toBe("reset_halted");
    expect(events).toEqual(["get:generation", "get:halt"]);
    expect(harness.db.reads).toHaveLength(0);
    expect(harness.storage.putBatches).toHaveLength(0);
  });

  it("holds the response until the retirement lands", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const harness = await stagedResetHarness({}, {
      holdDelete: (keys) => (keys.includes(baseKey(1)) ? held : undefined),
    });

    const pending = harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    await settle();

    // The retirement is awaited, so nothing past it has run: the header stands
    // and no client has been told to come back.
    expect(harness.storage.kv.has(baseKey(1))).toBe(true);
    expect(harness.socket.sent).toHaveLength(0);

    release();
    expect((await pending).status).toBe(200);
    expect(harness.storage.kv.has(baseKey(1))).toBe(false);
    expect(harness.socket.sent).toHaveLength(1);
  });

  it("spends nothing when a later batch of the staged group is rejected, and the next reset stages it again", async () => {
    let big = true;
    const harness = await stagedResetHarness({}, {
      // The batch the header travels in is the group's last, so a base spanning
      // more than one batch fails here with its earlier parts already written:
      // a partial group, not a refusal before anything was issued.
      putFails: (keys) => (big && keys.includes(baseKey(1)) ? new Error("storage down") : undefined),
    });
    inflateRebuild(harness, () => (big ? OVER_ONE_BATCH_BYTES : 0));

    const refused = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(refused.status).toBe(503);
    // The group did span several batches, and the first of them landed.
    expect(harness.storage.putBatches).toHaveLength(2);
    expect(harness.storage.putBatches[0]).toHaveLength(128);
    expect(harness.storage.kv.has(`${baseKey(1)}:0001`)).toBe(true);
    expect(harness.storage.kv.has(`${baseKey(1)}:0128`)).toBe(true);
    // Without the header the parts name no base, and no reader can reach them.
    expect(harness.storage.kv.has(baseKey(1))).toBe(false);
    // No generation put: the switch is behind the staging, so the generation,
    // the row and the old base all stand.
    expect(harness.storage.kv.get("docGeneration")).toBe(0);
    expect(blobWrites(harness)).toHaveLength(0);
    expect(harness.socket.closes).toEqual([UNAVAILABLE]);

    big = false;
    const landed = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(landed.status).toBe(200);
    expect(harness.storage.kv.get("docGeneration")).toBe(1);
    expect(harness.db.row()?.yjs_generation).toBe(1);
  });

  it("issues no switch and no replacement, and answers nothing, while the staging is in flight", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const harness = await stagedResetHarness({}, {
      holdPut: (keys) => (keys.includes(baseKey(1)) ? held : undefined),
    });

    const pending = harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    let answered = false;
    void pending.then(() => { answered = true; });
    await settle();

    // The staging is awaited, so the switch that names the base has not been
    // issued, the row has not been written, and the caller has no answer.
    expect(harness.storage.kv.get("docGeneration")).toBe(0);
    expect(harness.storage.kv.has(baseKey(1))).toBe(false);
    expect(blobWrites(harness)).toHaveLength(0);
    expect(answered).toBe(false);

    release();
    expect((await pending).status).toBe(200);
    expect(harness.storage.kv.get("docGeneration")).toBe(1);
    expect(harness.db.row()?.yjs_generation).toBe(1);
  });

  it("serves exactly what a smaller retry staged, with the earlier attempt's surplus parts beside it", async () => {
    const events: string[] = [];
    let big = true;
    const harness = await stagedResetHarness({}, {
      // The first switch is refused, so the parted base the first attempt staged
      // stays where it is and the next attempt writes over it.
      putFails: (keys, nth) => (nth === 2 ? new Error("storage down") : undefined),
    }, events);
    inflateRebuild(harness, () => (big ? 250 * 1024 : 0));

    expect((await harness.doInstance.fetch(await signedRequest("/reset", "reset"))).status)
      .toBe(503);
    const staged = harness.storage.kv.get(baseKey(1)) as RecordHeader;
    expect(staged.parts).toBeGreaterThan(1);

    // The retry stages a document small enough for one part, so the header
    // names one and the rest are surplus.
    big = false;
    harness.internals.landReplacement = async (_g, _r, _b, progress) => {
      // The replacement is made not to land, so the staged base stays reachable
      // for the load below rather than being retired by a landed one.
      progress.at = "switched";
      throw new Error("D1_ERROR: the replacement did not land");
    };
    expect((await harness.doInstance.fetch(await signedRequest("/reset", "reset"))).status)
      .toBe(503);

    const retried = harness.storage.kv.get(baseKey(1)) as RecordHeader;
    expect(retried.parts).toBe(1);
    expect(harness.storage.kv.has(`${baseKey(1)}:0002`)).toBe(true);

    // What a load serves is the retry's document, not the bytes the surplus
    // parts still hold.
    harness.sockets.length = 0;
    const woken = await reviveOn(harness);
    await woken.internals.ensureDocLoaded();
    expect(titles(woken.internals.ydoc)).toEqual(["Story A"]);
    expect(String(woken.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("byline")))
      .toBe("");

    // A header at the current generation names a live base, so its parts are
    // deferred whatever else the sweep finds, surplus and all.
    await woken.internals.alarm();
    expect(partsOf(woken.storage, 1)).toEqual([
      `${baseKey(1)}:0001`,
      `${baseKey(1)}:0002`,
      `${baseKey(1)}:0003`,
    ]);

    // The snapshot's landed write retires the header, and the parts it named
    // become orphans the next sweep takes with the surplus.
    await woken.internals.doSnapshot();
    expect(woken.storage.kv.has(baseKey(1))).toBe(false);
    await woken.internals.alarm();
    expect(partsOf(woken.storage, 1)).toEqual([]);
  });
});

describe("the reset's failure matrix", () => {
  it("spends nothing and disposes the document when the rebinding throws", async () => {
    const harness = await stagedResetHarness();
    const real = harness.internals.replaceDocument.bind(harness.internals);
    let thrown = false;
    harness.internals.replaceDocument = () => {
      if (thrown) return real();
      thrown = true;
      // The served document is destroyed before the next is constructed, so a
      // throw here already owes a disposal.
      harness.internals.ydoc.destroy();
      throw new Error("the handlers could not be rebound");
    };

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(harness.storage.putBatches).toHaveLength(0);
    expect(harness.storage.kv.get("docGeneration")).toBe(0);
    expect(harness.db.mutations).toHaveLength(0);
    expect(harness.internals.docLoaded).toBe(false);
    expect(harness.socket.closes).toEqual([UNAVAILABLE]);
  });

  it("abandons and answers 503 when the switch is rejected", async () => {
    const harness = await stagedResetHarness({}, {
      putFails: (keys) => (keys.includes("docGeneration") ? new Error("storage down") : undefined),
    });

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    // The rejection does not prove the value did not land, so the cached
    // generation is dropped rather than guessed at.
    expect(harness.internals.docGeneration).toBeNull();
    expect(harness.internals.docLoaded).toBe(false);
    expect(harness.socket.closes).toEqual([UNAVAILABLE]);
    expect(harness.db.mutations.filter((s) => /^UPDATE projects SET yjs_state/.test(s.sql)))
      .toHaveLength(0);
    // The staged base stands, exact for the generation that may or may not have
    // been named.
    expect(harness.storage.kv.has(baseKey(1))).toBe(true);
  });

  it("serves the old base after an unresolved switch that did not land", async () => {
    const harness = await stagedResetHarness({}, {
      putFails: (keys) => (keys.includes("docGeneration") ? new Error("storage down") : undefined),
    });
    await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    const woken = await reviveOn(harness);
    await woken.internals.ensureDocLoaded();

    expect(woken.internals.docGeneration).toBe(0);
    expect(titles(woken.internals.ydoc)).toEqual(["Story A"]);
  });

  it("serves the staged base after an unresolved switch that did land", async () => {
    const harness = await stagedResetHarness({}, {
      putFails: (keys) => (keys.includes("docGeneration") ? new Error("storage down") : undefined),
    });
    await harness.doInstance.fetch(await signedRequest("/reset", "reset"));
    // The value the rejected put may have written all the same.
    harness.storage.kv.set("docGeneration", 1);

    const woken = await reviveOn(harness);
    await woken.internals.ensureDocLoaded();

    expect(woken.internals.docGeneration).toBe(1);
    // The staged base's 0, plus the record the load's own repairs wrote.
    expect(woken.internals.docSeq).toBe(1);
    expect(titles(woken.internals.ydoc)).toEqual(["Story A"]);
  });

  /** The one line a landed replacement's failure owes, for a named step. */
  function finalisationLines(step: string): string[] {
    return errors.filter((l) => l.includes(`the replacement landed and its ${step} failed`));
  }

  const FINALISATION_FAILURES: Array<[string, string, (internals: Internals) => void]> = [
    // Injected at the entry, before the method mutates anything: the row is at
    // the new generation and no part of the installation has run.
    ["the installation throws", "installation", (internals) => {
      internals.installReplacement = async () => {
        throw new Error("the replacement could not be installed");
      };
    }],
    ["the baseline seeding throws", "attribution", (internals) => {
      internals.seedWordBaseline = () => { throw new Error("the baseline could not be seeded"); };
    }],
    ["the announcement throws", "announcement", (internals) => {
      internals.announceReset = () => { throw new Error("the announcement failed"); };
    }],
  ];

  it.each(FINALISATION_FAILURES)(
    "answers 200 with the row at the new generation when %s",
    async (_label, step, breakIt) => {
      const harness = await stagedResetHarness();
      breakIt(harness.internals);

      const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

      expect(response.status).toBe(200);
      expect(harness.db.row()?.yjs_generation).toBe(1);
      expect(harness.db.row()?.yjs_seq).toBe(0);
      expect(harness.internals.docLoaded).toBe(false);
      expect(harness.socket.closes).toEqual([UNAVAILABLE]);
      // The step the line names is the one that failed, and no other line was
      // written for it.
      expect(finalisationLines(step)).toHaveLength(1);
      expect(errors.filter((l) => l.includes("the replacement landed"))).toHaveLength(1);

      // The state a landed replacement leaves is never dependent on its
      // finalisation: a fresh instance over the same durable state serves it.
      harness.sockets.length = 0;
      const woken = await reviveOn(harness);
      await woken.internals.ensureDocLoaded();
      expect(woken.internals.docLoaded).toBe(true);
      expect(woken.internals.docGeneration).toBe(1);
      expect(titles(woken.internals.ydoc)).toEqual(["Story A"]);
    },
  );

  it("answers 200 when the header deletion is rejected, and the next load serves the row", async () => {
    const harness = await stagedResetHarness({}, {
      // One-shot: the loader below retires the same header, and a permanently
      // broken deletion would refuse the load rather than exercise it.
      deleteFails: (keys, nth) => (nth === 1 && keys.includes(baseKey(1))
        ? new Error("storage down")
        : undefined),
    });

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(harness.db.row()?.yjs_generation).toBe(1);
    expect(harness.storage.kv.has(baseKey(1))).toBe(true);
    expect(errors.filter((l) => l.includes("the replacement landed and its retirement failed")))
      .toHaveLength(1);

    // The header still stands beside a row at the same generation and sequence,
    // and the authority rule sends the load to the row and retires it.
    const woken = await reviveOn(harness);
    await woken.internals.ensureDocLoaded();
    expect(woken.internals.docLoaded).toBe(true);
    expect(woken.storage.kv.has(baseKey(1))).toBe(false);
  });

  it("answers 200 when the alarm cannot be armed", async () => {
    const harness = await stagedResetHarness({}, {
      setAlarmRejects: new Error("storage down"),
    });

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(harness.db.row()?.yjs_generation).toBe(1);
    expect(harness.internals.docLoaded).toBe(false);
    expect(errors.filter((l) => l.includes("the replacement landed and its scheduling failed")))
      .toHaveLength(1);
  });

  it.each([
    ["landed", 200],
    ["switched", 503],
  ])("applies the phase table to an exception no step caught: %s", async (phase, status) => {
    const harness = await stagedResetHarness();
    harness.internals.landReplacement = async (_g, _r, _b, progress) => {
      progress.at = phase;
      throw new Error("the reset escaped");
    };

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(status);
    // Whatever the phase, no exit leaves the document open.
    expect(harness.internals.docLoaded).toBe(false);
    expect(harness.socket.closes).toEqual([UNAVAILABLE]);
  });

  it("refuses the fence after the switch and leaves the staged base in place", async () => {
    const harness = await stagedResetHarness({
      // A competing claim moved the row between the reset's read and its CAS,
      // and the row it left is another lineage's.
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 9 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(503);
    expect(harness.internals.persistenceHalted?.marker.reason).toBe("fence_refused");
    expect(harness.storage.kv.has(baseKey(1))).toBe(true);
    expect(harness.storage.kv.get("docGeneration")).toBe(1);
  });
});

describe("a landed replacement", () => {
  it("installs the document, reseeds the ledgers once, retires the header and arms the sweep", async () => {
    const events: string[] = [];
    const harness = await stagedResetHarness({
      rows: { ...ONE_STORY, ...storedStamps() },
    }, {}, events);
    harness.internals.activityEmitted.set(USER_ID, new Set(["story:11"]));
    plantMarker(harness.storage, 0, "enforcement_failed");
    harness.internals.persistenceHalted = { generation: 0, marker: { reason: "enforcement_failed", at: 1 } };
    const stampsBefore = harness.db.stampReads();
    freezeClock();

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(harness.internals.docLoaded).toBe(true);
    expect(harness.internals.docSeq).toBe(0);
    // The load claimed revision 4 to 5, and the replacement conditioned on 5.
    expect(harness.internals.docWrite).toBe(6);
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.storage.kv.has(baseKey(1))).toBe(false);
    // Exactly one stamp read, whatever state the reset arrived in.
    expect(harness.db.stampReads()).toBe(stampsBefore + 1);
    expect(harness.internals.timeSeeded).toBe(true);
    expect(harness.internals.wordBaseline.size).toBeGreaterThan(0);
    // Dedup history and telemetry are not attribution and survive.
    expect(harness.internals.activityEmitted.get(USER_ID)?.has("story:11")).toBe(true);
    expect(armedIn(harness.storage)).toBe(MAINTENANCE_DELAY_MS);
    expect(harness.socket.closes).toEqual([{ code: 1012, reason: "State reset" }]);
  });

  it("seeds the baseline from the replacement alone, and credits the next edit from it", async () => {
    const events: string[] = [];
    // The served document and the rebuilt one are different rows with different
    // word counts, so a baseline carried over from the first would stand out.
    const harness = await stagedResetHarness({
      row: tagged(storyBlob("one two three four five", 11), 0, 0, 4),
      rows: {
        stories: [{ id: 12, story_id: "s12", title: "rebuilt title", order: 0, order_key: "a0" }],
        ...storedStamps(),
      },
    }, {}, events);
    expect(harness.internals.wordBaseline.get("stories:11:title")).toBe(5);

    expect((await harness.doInstance.fetch(await signedRequest("/reset", "reset"))).status)
      .toBe(200);

    // Exactly the replacement's own three prose fields, and nothing of the
    // document the reset discarded.
    expect([...harness.internals.wordBaseline.entries()].sort()).toEqual([
      ["stories:12:byline", 0],
      ["stories:12:subtitle", 0],
      ["stories:12:title", 2],
    ]);

    const credit = await creditOneEdit(harness, events);

    // Five words inserted into a title of two: the rise over the replacement's
    // own baseline, not the count of the field.
    expect(harness.internals.wordsByRow.get("stories")?.get("12")?.get(USER_ID)).toBe(5);
    expectGapCredit(credit.editing);
  });

  it("credits an edit against the replacement's own baseline", async () => {
    const events: string[] = [];
    const harness = await stagedResetHarness({
      rows: { ...ONE_STORY, ...storedStamps() },
    }, {}, events);

    expect((await harness.doInstance.fetch(await signedRequest("/reset", "reset"))).status)
      .toBe(200);
    const credit = await creditOneEdit(harness, events);

    expectGapCredit(credit.editing);
    expectGapCredit(credit.writing);
    expect(harness.internals.wordsByRow.size).toBeGreaterThan(0);
  });

  it("keeps the guard bound to the replacement, so a forbidden deletion is reverted", async () => {
    const events: string[] = [];
    const harness = await stagedResetHarness({}, {}, events);

    expect((await harness.doInstance.fetch(await signedRequest("/reset", "reset"))).status)
      .toBe(200);

    const editor = fakeSocket(events, { generation: 1 });
    harness.sockets.push(editor);
    const before = titles(harness.internals.ydoc);
    harness.internals.ydoc.transact(() => {
      harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
    }, editor);

    // The observers were re-bound at construction of the replacement, so the
    // deletion meets the guard and is put back.
    expect(titles(harness.internals.ydoc)).toEqual(before);
  });

  it("retires the header on an adopted replacement too", async () => {
    const harness = await stagedResetHarness({
      reacquire: [{ yjs_generation: 1, yjs_seq: 0, yjs_write: 6 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(harness.internals.docWrite).toBe(6);
    expect(harness.storage.kv.has(baseKey(1))).toBe(false);
    expect(harness.internals.docLoaded).toBe(true);
  });
});

describe("a replacement that lands zero rows with the row unmoved", () => {
  it("leaves the staged base exact for the new generation, and the next load serves it", async () => {
    let refusing = true;
    const events: string[] = [];
    const harness = await stagedResetHarness({
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        && refusing ? { changes: 0 } : undefined),
    }, {}, events);

    const refused = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(refused.status).toBe(503);
    expect(harness.storage.kv.get("docGeneration")).toBe(1);
    expect(harness.storage.kv.has(baseKey(1))).toBe(true);
    // The row is honestly at the old generation, one revision behind.
    expect(harness.db.row()?.yjs_generation).toBe(0);
    expect(harness.db.row()?.yjs_write).toBe(5);

    refusing = false;
    harness.sockets.length = 0;
    const woken = await reviveOn(harness);
    woken.db.clear();
    await woken.internals.ensureDocLoaded();

    // No second reset: the staged base is what the load serves, and the row is
    // bare-claimed at whatever generation it carries.
    expect(woken.internals.docLoaded).toBe(true);
    // The staged base's 0, plus the record the load's own repairs wrote.
    expect(woken.internals.docSeq).toBe(1);
    expect(woken.internals.docWrite).toBe(6);
    expect(titles(woken.internals.ydoc)).toEqual(["Story A"]);
    expect(claims(woken.db.mutations)).toHaveLength(1);
    expect(tags(woken.db.mutations)).toHaveLength(0);
    expect(woken.db.row()?.yjs_generation).toBe(0);

    // The first snapshot puts the row at the new generation and retires the
    // header, after the landed write and before it returns.
    woken.internals.ydoc.transact(() => {
      (woken.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text)
        .insert(0, "edited ");
    }, null);
    await woken.internals.doSnapshot();

    expect(woken.db.row()?.yjs_generation).toBe(1);
    // The staged base's 0, the load's own repair record, and the edit above it.
    expect(woken.db.row()?.yjs_seq).toBe(2);
    expect(woken.storage.kv.has(baseKey(1))).toBe(false);

    // And the load after that finds no base in storage and serves the row.
    const again = await reviveOn(harness);
    await again.internals.ensureDocLoaded();
    expect(titles(again.internals.ydoc)).toEqual(["edited Story A"]);
  });
});

// ---------------------------------------------------------------------------
// Same generation: the newer base wins, ties to D1
// ---------------------------------------------------------------------------

/** Record each application, so the header deletion's place against it is observable. */
function watchApplications(internals: Internals, events: string[]): void {
  const real = internals.applyBase.bind(internals);
  internals.applyBase = (bytes, generation) => {
    events.push("apply");
    return real(bytes, generation);
  };
}

describe("a storage base and a D1 row exact for the same generation", () => {
  it("serves the row at a tie, retiring the header after the claim and before any application", async () => {
    const events: string[] = [];
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {}, [], events);
    plantBase(harness.storage, 0, 0, BASE_STORAGE);
    watchApplications(harness.internals, events);
    freezeClock();

    await harness.internals.ensureDocLoaded();

    // The row's distinguishing content is what is served, and its sequence is
    // what seeds the instance.
    expect(titles(harness.internals.ydoc)).toEqual(["Story A"]);
    // The row's 0, plus the record the load's own repairs wrote.
    expect(harness.internals.docSeq).toBe(1);
    expect(harness.storage.kv.has(baseKey(0))).toBe(false);
    const ordered = events.filter((e) =>
      e === "read-base" || e === "get:generation" || e === "get:halt" || e === "get:base" ||
      e === "delete" || e === "apply" || e.startsWith("run:UPDATE projects"));
    expect(ordered).toEqual([
      "read-base",
      "get:generation",
      "get:halt",
      "get:base",
      "run:UPDATE projects SET yjs_write = ? ",
      "delete",
      "apply",
      // The retirement leaves the base's parts behind, and the load that made
      // it is what arms the sweep that takes them.
      "get:base",
    ]);
    expect(armedIn(harness.storage)).toBe(MAINTENANCE_DELAY_MS);
  });

  it("serves the row when its sequence is higher, and the base when the base's is", async () => {
    const higher = makeDo({ base: [tagged(BASE_A, 0, 4, 4)] });
    plantBase(higher.storage, 0, 1, BASE_STORAGE);
    await higher.internals.ensureDocLoaded();
    expect(titles(higher.internals.ydoc)).toEqual(["Story A"]);
    // The winner's sequence, plus the record the load's own repairs wrote.
    expect(higher.internals.docSeq).toBe(5);
    expect(higher.storage.kv.has(baseKey(0))).toBe(false);

    const lower = makeDo({ base: [tagged(BASE_A, 0, 1, 4)] });
    plantBase(lower.storage, 0, 3, BASE_STORAGE);
    await lower.internals.ensureDocLoaded();
    expect(titles(lower.internals.ydoc)).toEqual(["Story in storage"]);
    expect(lower.internals.docSeq).toBe(4);
    // The base wins, so nothing is retired.
    expect(lower.storage.kv.has(baseKey(0))).toBe(true);
    expect(lower.storage.deleteBatches).toHaveLength(0);
  });

  it("serves the base over an untagged row whatever its blob, and never tags it", async () => {
    const harness = makeDo({ base: [untagged(BASE_A, 4)] });
    plantBase(harness.storage, 0, 0, BASE_STORAGE);

    await harness.internals.ensureDocLoaded();

    expect(titles(harness.internals.ydoc)).toEqual(["Story in storage"]);
    expect(tags(harness.db.mutations)).toHaveLength(0);
    expect(harness.storage.kv.has(baseKey(0))).toBe(true);
  });

  it("serves the base over an untagged row twice, leaving both tags NULL across the claims", async () => {
    const harness = makeDo({ row: untagged(BASE_A, 4) });
    plantBase(harness.storage, 0, 0, BASE_STORAGE);

    await harness.internals.ensureDocLoaded();

    // The storage base is what is served, and the claim moved the revision
    // without saying anything about the blob the row still holds.
    expect(titles(harness.internals.ydoc)).toEqual(["Story in storage"]);
    expect(harness.db.row()?.yjs_generation).toBeNull();
    expect(harness.db.row()?.yjs_seq).toBeNull();
    expect(harness.db.row()?.yjs_write).toBe(5);
    expect(tags(harness.db.mutations)).toHaveLength(0);
    expect(harness.storage.kv.has(baseKey(0))).toBe(true);

    // No snapshot between the two: a tag written here would make the row's own
    // bytes a base at the current generation, and the tie would serve them.
    const woken = await reviveOn(harness);
    woken.db.clear();
    await woken.internals.ensureDocLoaded();

    expect(titles(woken.internals.ydoc)).toEqual(["Story in storage"]);
    expect(woken.db.row()?.yjs_generation).toBeNull();
    expect(woken.db.row()?.yjs_seq).toBeNull();
    expect(woken.db.row()?.yjs_write).toBe(6);
    expect(claims(woken.db.mutations)).toHaveLength(1);
    expect(tags(woken.db.mutations)).toHaveLength(0);
    expect(woken.storage.kv.has(baseKey(0))).toBe(true);
  });

  it("serves the base at a later generation over a row at an earlier one", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] });
    harness.storage.kv.set("docGeneration", 1);
    plantBase(harness.storage, 1, 0, BASE_STORAGE);

    await harness.internals.ensureDocLoaded();

    expect(titles(harness.internals.ydoc)).toEqual(["Story in storage"]);
    expect(harness.storage.kv.has(baseKey(1))).toBe(true);
  });

  it("serves the staged base twice when an eviction follows the recovery claim with no snapshot between", async () => {
    const harness = makeDo({ row: tagged(BASE_A, 0, 0, 4) });
    harness.storage.kv.set("docGeneration", 1);
    plantBase(harness.storage, 1, 0, BASE_STORAGE);

    await harness.internals.ensureDocLoaded();
    expect(titles(harness.internals.ydoc)).toEqual(["Story in storage"]);

    const woken = await reviveOn(harness);
    await woken.internals.ensureDocLoaded();

    // The claim moved the revision and left the NULL-free tags exactly as they
    // were, so the second load takes the same decision as the first.
    expect(titles(woken.internals.ydoc)).toEqual(["Story in storage"]);
    expect(woken.db.row()?.yjs_generation).toBe(0);
  });

  it("halts on a corrupt base rather than reading it as absent beside a newer row", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 9, 4)] });
    plantBase(harness.storage, 0, 0, BASE_STORAGE);
    harness.storage.kv.delete(`${baseKey(0)}:0001`);

    await expect(harness.internals.ensureDocLoaded())
      .rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("log_corrupt");
    expect(writes(harness.db.mutations)).toHaveLength(0);
  });

  it("holds the load until the retirement lands, and refuses it marker-less when it is rejected", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holding = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {
      holdDelete: (keys) => (keys.includes(baseKey(0)) ? held : undefined),
    });
    plantBase(holding.storage, 0, 0, BASE_STORAGE);

    const pending = holding.internals.ensureDocLoaded();
    await settle();
    expect(holding.internals.docLoaded).toBe(false);
    release();
    await pending;
    expect(holding.internals.docLoaded).toBe(true);

    const refusing = makeDo({ base: [tagged(BASE_A, 0, 0, 4)] }, {
      deleteFails: (keys) => (keys.includes(baseKey(0)) ? new Error("storage down") : undefined),
    });
    plantBase(refusing.storage, 0, 0, BASE_STORAGE);

    const err = await refusing.internals.ensureDocLoaded().then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(ExactBaseError);
    expect((err as ExactBaseError).reason).toBe("generation_unreadable");
    // Marker-less, with nothing applied: no mutated document is left resident
    // behind a failed cleanup.
    expect(refusing.internals.persistenceHalted).toBeNull();
    expect(refusing.storage.kv.has(haltKey(0))).toBe(false);
    expect(refusing.internals.docLoaded).toBe(false);
    expect(titles(refusing.internals.ydoc)).toEqual([]);
    expect(exactBaseLines()).toEqual([`[exact-base] project ${PROJECT_ID}: generation_unreadable`]);
  });
});

// ---------------------------------------------------------------------------
// The snapshot retires the storage base's header
// ---------------------------------------------------------------------------

/**
 * A blob write that landed and whose acknowledgement was lost: the row takes
 * the write, and the caller is told no row matched it.
 *
 * The row is reached through the harness rather than scripted, because the
 * point of the case is that the NEXT reader sees what the write left.
 */
function lostAcknowledgement(harness: () => { db: { row: () => BaseRowShape | undefined } }) {
  return (sql: string, binds: unknown[]): RunOutcome | undefined => {
    if (!/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)) {
      return undefined;
    }
    const row = harness().db.row();
    if (row === undefined) return undefined;
    row.yjs_state = binds[0] as Uint8Array;
    row.yjs_generation = binds[1] as number;
    row.yjs_seq = binds[2] as number;
    row.yjs_write = binds[3] as number;
    return { changes: 0 };
  };
}

describe("the snapshot's landed blob write retires the storage base's header", () => {
  /**
   * A storage base NEWER than the row, so the base is what the load serves and
   * the header is still standing when the snapshot runs. At a tie the loader
   * retires it first, and the snapshot would have nothing left to prove.
   */
  const BASE_SEQ = 3;

  it("retires on an acknowledged write, and the next load finds no base", async () => {
    const harness = makeDo({ row: tagged(BASE_A, 0, 0, 4) });
    plantBase(harness.storage, 0, BASE_SEQ, BASE_STORAGE);
    await harness.internals.ensureDocLoaded();
    // The base's sequence, plus the record the load's own repairs wrote.
    expect(harness.internals.docSeq).toBe(BASE_SEQ + 1);

    await harness.internals.doSnapshot();

    expect(harness.storage.kv.has(baseKey(0))).toBe(false);
    expect(harness.db.row()?.yjs_generation).toBe(0);
    expect(harness.db.row()?.yjs_seq).toBe(BASE_SEQ + 1);

    // The claim about the next load, made by loading: the header key is read
    // and found absent, so the row is the only base there is.
    const woken = await reviveOn(harness);
    await woken.internals.ensureDocLoaded();
    expect(woken.internals.docLoaded).toBe(true);
    // The row's own sequence and no more: the blob it carries was encoded after
    // the first load's repairs, so this load's repairs change nothing and write
    // nothing.
    expect(woken.internals.docSeq).toBe(BASE_SEQ + 1);
    expect(titles(woken.internals.ydoc)).toEqual(["Story in storage"]);
    expect(woken.storage.deleteBatches.filter((batch) => batch.includes(baseKey(0))))
      .toHaveLength(1);
  });

  it.each([
    ["an acknowledged write", false],
    ["an adopted write", true],
  ])("serves the row and retires the header itself when the retirement fails after %s", async (_label, adopted) => {
    let harness!: ReturnType<typeof makeDo>;
    harness = makeDo({
      row: tagged(BASE_A, 0, 0, 4),
      run: adopted ? lostAcknowledgement(() => harness) : undefined,
    }, {
      // One-shot: the load below retires the same header, and a permanently
      // broken deletion would refuse that load rather than exercise it.
      deleteFails: (keys, nth) => (nth === 1 && keys.includes(baseKey(0))
        ? new Error("storage down")
        : undefined),
    });
    plantBase(harness.storage, 0, BASE_SEQ, BASE_STORAGE);
    await harness.internals.ensureDocLoaded();
    harness.internals.ydoc.transact(() => {
      (harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text)
        .insert(0, "edited ");
    }, null);

    await expect(harness.internals.doSnapshot()).rejects.toThrow(/storage down/);

    // The blob write landed, and the header it should have retired stands over
    // a base at the row's own sequence: the tie the authority rule settles.
    expect(harness.db.row()?.yjs_generation).toBe(0);
    // The base's sequence, the load's repair record, and the edit above it.
    expect(harness.db.row()?.yjs_seq).toBe(BASE_SEQ + 2);
    expect(harness.storage.kv.has(baseKey(0))).toBe(true);

    const woken = await reviveOn(harness);
    await woken.internals.ensureDocLoaded();

    // The tie goes to the row, which carries the edit, and the loader retires
    // the header the snapshot could not.
    expect(titles(woken.internals.ydoc)).toEqual(["edited Story in storage"]);
    expect(woken.storage.kv.has(baseKey(0))).toBe(false);
  });

  it("retires on an adopted write", async () => {
    const harness = makeDo({
      base: [tagged(BASE_A, 0, 0, 4)],
      // The row one revision above the held one, under this write's own tags:
      // it landed and its acknowledgement was lost.
      // The sequence the encoding captured: the base's, plus the load's own
      // repair record.
      reacquire: [{ yjs_generation: 0, yjs_seq: BASE_SEQ + 1, yjs_write: 6 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });
    plantBase(harness.storage, 0, BASE_SEQ, BASE_STORAGE);
    await harness.internals.ensureDocLoaded();

    await harness.internals.doSnapshot();

    expect(harness.storage.kv.has(baseKey(0))).toBe(false);
  });

  it.each([
    ["a zero-row write the row has not moved under", { yjs_generation: 0, yjs_seq: 0, yjs_write: 5 }],
    ["a write whose row belongs to another instance", { yjs_generation: 3, yjs_seq: 0, yjs_write: 9 }],
  ])("retires nothing for %s", async (_label, reacquired) => {
    const harness = makeDo({
      base: [tagged(BASE_A, 0, 0, 4)],
      reacquire: [reacquired as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });
    plantBase(harness.storage, 0, BASE_SEQ, BASE_STORAGE);
    await harness.internals.ensureDocLoaded();

    await expect(harness.internals.doSnapshot()).rejects.toBeDefined();

    expect(harness.storage.kv.has(baseKey(0))).toBe(true);
  });

  it.each([
    ["the re-acquisition read rejects", {
      reacquire: [{ throws: new Error("D1_ERROR: the row could not be read") }],
    }, {}],
    ["the ownership validation rejects", {
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 5 } as BaseRowShape],
    }, {
      // The load's read, then the snapshot's early exit, then re-acquisition's
      // own, which is the one that has to fail.
      failOn: (kind: string, nth: number) => (kind === "generation" && nth === 3
        ? new Error("storage down")
        : undefined),
    }],
  ])("retires nothing when %s", async (_label, db, storageOpts) => {
    const harness = makeDo({
      base: [tagged(BASE_A, 0, 0, 4)],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
      ...db,
    }, storageOpts);
    plantBase(harness.storage, 0, BASE_SEQ, BASE_STORAGE);
    await harness.internals.ensureDocLoaded();

    await expect(harness.internals.doSnapshot()).rejects.toBeDefined();

    // The write was issued and its outcome was never settled, which is the
    // window this covers: an unsettled write proves nothing landed, so the
    // deletion is never issued and the header stands.
    expect(blobWrites(harness)).toHaveLength(1);
    expect(harness.storage.deleteBatches.filter((batch) => batch.includes(baseKey(0))))
      .toHaveLength(0);
    expect(harness.storage.kv.has(baseKey(0))).toBe(true);
  });

  it("retires nothing when the write itself is aborted", async () => {
    const harness = makeDo({
      base: [tagged(BASE_A, 0, 0, 4)],
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 5 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { throws: new Error("D1_ERROR: the write was aborted") }
        : undefined),
    });
    plantBase(harness.storage, 0, BASE_SEQ, BASE_STORAGE);
    await harness.internals.ensureDocLoaded();

    await expect(harness.internals.doSnapshot()).rejects.toThrow(/aborted/);

    expect(harness.storage.kv.has(baseKey(0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Maintenance, by the alarm, derived from storage
// ---------------------------------------------------------------------------

const MAINTENANCE_FLOOR_KEY = "maintenanceFloor";

/**
 * Fill one superseded generation with `count` keys, through the codecs that
 * write them: log records, a parted base with its header, and a halt marker.
 */
function plantGeneration(storage: FakeStorage, generation: number, count: number): string[] {
  const planted: string[] = [];
  plantBase(storage, generation, 0, BASE_A);
  planted.push(baseKey(generation), `${baseKey(generation)}:0001`);
  plantMarker(storage, generation, "enforcement_failed");
  planted.push(haltKey(generation));
  for (let seq = 1; planted.length < count; seq++) {
    plantRecord(storage, generation, seq, BASE_A);
    planted.push(logKey(generation, seq));
  }
  return planted;
}

/** An unloaded, socketless instance over storage a test has planted into. */
function maintenanceHarness(current: number, storageOpts: StorageOptions = {}) {
  const events: string[] = [];
  const harness = makeDo({ base: [tagged(BASE_A, current, 0, 4)] }, storageOpts, [], events);
  harness.storage.kv.set("docGeneration", current);
  return { ...harness, events };
}

function floorOf(harness: { storage: FakeStorage }): number {
  return (harness.storage.kv.get(MAINTENANCE_FLOOR_KEY) as number | undefined) ?? 0;
}

/** What one alarm run listed and deleted, counted from the run's own slice of the record. */
function runCounts(storage: FakeStorage, from: { lists: number; deletes: number }) {
  const batches = storage.deleteBatches.slice(from.deletes);
  return {
    lists: storage.lists.length - from.lists,
    batches,
    keys: batches.reduce((total, batch) => total + batch.length, 0),
  };
}

function marker(storage: FakeStorage) {
  return { lists: storage.lists.length, deletes: storage.deleteBatches.length };
}

describe("the alarm's maintenance half sweeps superseded generations", () => {
  it("sweeps one generation per run, in bounded batches, and finishes in three", async () => {
    const harness = maintenanceHarness(3);
    const planted = [
      ...plantGeneration(harness.storage, 0, 600),
      ...plantGeneration(harness.storage, 1, 500),
      ...plantGeneration(harness.storage, 2, 400),
    ];
    expect(planted).toHaveLength(1_500);

    const swept: number[] = [];
    const armed: number[] = [];
    for (let run = 0; run < 3; run++) {
      const before = marker(harness.storage);
      armed.push(harness.storage.alarms.length);
      await harness.internals.alarm();
      const counts = runCounts(harness.storage, before);
      swept.push(counts.keys);
      // Both per-run bounds, on every run.
      expect(counts.keys).toBeLessThanOrEqual(1_024);
      expect(counts.lists).toBeLessThanOrEqual(8);
      for (const batch of counts.batches) expect(batch.length).toBeLessThanOrEqual(128);
      expect(floorOf(harness)).toBe(run + 1);
      // Work remains between the runs, and it survives an eviction: the floor
      // is the whole of what the next instance needs.
      if (run < 2) expect(floorOf(harness)).toBeLessThan(3);
    }

    expect(swept).toEqual([600, 500, 400]);
    for (const key of planted) expect(harness.storage.kv.has(key)).toBe(false);
    expect(floorOf(harness)).toBe(3);
    // The first two runs came back for the rest; the third found nothing left
    // to come back for.
    expect(armed).toEqual([0, 1, 2]);
    expect(harness.storage.alarms).toHaveLength(2);
  });

  it("sweeps generation 0 when the current generation is 1", async () => {
    const harness = maintenanceHarness(1);
    const planted = plantGeneration(harness.storage, 0, 40);
    expect(floorOf(harness)).toBeLessThan(1);

    await harness.internals.alarm();

    for (const key of planted) expect(harness.storage.kv.has(key)).toBe(false);
    expect(floorOf(harness)).toBe(1);
  });

  it("never lists or deletes a generation above the current one", async () => {
    const harness = maintenanceHarness(1);
    plantGeneration(harness.storage, 0, 10);
    // A reset in flight has staged a base for the next generation.
    plantBase(harness.storage, 2, 0, BASE_A);

    await harness.internals.alarm();

    expect(harness.storage.kv.has(baseKey(2))).toBe(true);
    expect(harness.storage.kv.has(`${baseKey(2)}:0001`)).toBe(true);
    for (const listed of harness.storage.lists) {
      expect(listed.prefix).not.toContain(":2:");
      expect(listed.prefix).not.toBe(`${baseKey(2)}:`);
    }
  });

  it("reads a malformed floor as 0", async () => {
    const harness = maintenanceHarness(1);
    harness.storage.kv.set(MAINTENANCE_FLOOR_KEY, "not a generation");
    const planted = plantGeneration(harness.storage, 0, 10);

    await harness.internals.alarm();

    for (const key of planted) expect(harness.storage.kv.has(key)).toBe(false);
    expect(floorOf(harness)).toBe(1);
  });

  it("bounds a run over empty generations by the list budget", async () => {
    const harness = maintenanceHarness(6);
    freezeClock();

    const before = marker(harness.storage);
    await harness.internals.alarm();

    expect(runCounts(harness.storage, before).lists).toBeLessThanOrEqual(8);
    // One old generation per run, whatever else it finds.
    expect(floorOf(harness)).toBe(1);
    expect(armedIn(harness.storage)).toBe(MAINTENANCE_DELAY_MS);
  });

  it("defers the current generation's parts while a header stands, and sweeps them when none does", async () => {
    const live = maintenanceHarness(1);
    plantBase(live.storage, 1, 0, BASE_A);

    await live.internals.alarm();

    expect(live.storage.kv.has(`${baseKey(1)}:0001`)).toBe(true);

    const orphaned = maintenanceHarness(1);
    plantBase(orphaned.storage, 1, 0, BASE_A);
    orphaned.storage.kv.delete(baseKey(1));

    await orphaned.internals.alarm();

    expect(orphaned.storage.kv.has(`${baseKey(1)}:0001`)).toBe(false);
  });

  it("returns pending and comes back in five seconds when the budget runs out at the boundary", async () => {
    const harness = maintenanceHarness(1);
    // Exactly the deletion budget under the old generation: 895 records, a base
    // whose header names one part beside 126 surplus parts an earlier, larger
    // attempt left, and the halt marker. The slice finishes the generation and
    // has nothing left for the current generation's orphans.
    plantBase(harness.storage, 0, 0, BASE_A);
    for (let part = 2; part <= 127; part++) {
      harness.storage.kv.set(`${baseKey(0)}:${String(part).padStart(4, "0")}`, new Uint8Array([1]));
    }
    plantMarker(harness.storage, 0, "enforcement_failed");
    for (let seq = 1; seq <= 895; seq++) plantRecord(harness.storage, 0, seq, BASE_A);
    // The generation key and the durable identity binding beside them, neither
    // of which the sweep lists or deletes.
    expect(harness.storage.kv.size).toBe(1_024 + 2);

    // An orphan at the current generation, which this run cannot reach.
    plantBase(harness.storage, 1, 0, BASE_A);
    harness.storage.kv.delete(baseKey(1));
    freezeClock();

    await harness.internals.alarm();

    expect(floorOf(harness)).toBe(1);
    expect(harness.storage.kv.has(`${baseKey(1)}:0001`)).toBe(true);
    expect(armedIn(harness.storage)).toBe(MAINTENANCE_DELAY_MS);

    await harness.internals.alarm();

    expect(harness.storage.kv.has(`${baseKey(1)}:0001`)).toBe(false);
  });

  it("leaves the floor where it stood and waits the full interval when the old generation's cleanup is rejected", async () => {
    const harness = maintenanceHarness(2, {
      // Inside the old generation's own cleanup, before the floor put.
      deleteFails: (keys) => (keys.includes(haltKey(0)) ? new Error("storage down") : undefined),
    });
    plantGeneration(harness.storage, 0, 10);
    freezeClock();

    await harness.internals.alarm();

    expect(floorOf(harness)).toBe(0);
    expect(harness.storage.kv.has(haltKey(0))).toBe(true);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
    expect(errors.filter((l) => l.includes("[maintenance]"))).toHaveLength(1);
  });

  it("leaves the floor where it stood when the current generation's orphans are rejected, with the old generation already gone", async () => {
    const harness = maintenanceHarness(1, {
      // Past every old-generation key, at the last thing the slice does before
      // the floor put: the orphan parts of the generation being served.
      deleteFails: (keys) => (keys.some((key) => key.startsWith(`${baseKey(1)}:`))
        ? new Error("storage down")
        : undefined),
    });
    const planted = plantGeneration(harness.storage, 0, 10);
    plantBase(harness.storage, 1, 0, BASE_A);
    harness.storage.kv.delete(baseKey(1));
    freezeClock();

    await harness.internals.alarm();

    // The old generation was swept clean and the floor still did not move: the
    // floor put is the slice's last fallible operation, so a rejection anywhere
    // above it leaves the generation to be re-swept, which deletes nothing.
    for (const key of planted) expect(harness.storage.kv.has(key)).toBe(false);
    expect(floorOf(harness)).toBe(0);
    expect(harness.storage.kv.has(`${baseKey(1)}:0001`)).toBe(true);
    expect(harness.storage.alarms).toHaveLength(1);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
    expect(errors.filter((l) => l.includes("[maintenance]"))).toHaveLength(1);
  });

  it("runs the snapshot half after a rejected slice, and holds the full interval", async () => {
    const events: string[] = [];
    const harness = makeDo({ row: tagged(BASE_A, 1, 0, 4) }, {
      deleteFails: (keys) => (keys.includes(haltKey(0)) ? new Error("storage down") : undefined),
    }, [], events);
    harness.storage.kv.set("docGeneration", 1);
    plantGeneration(harness.storage, 0, 10);
    await harness.internals.ensureDocLoaded();
    harness.sockets.push(fakeSocket(events, { generation: 1 }));
    harness.storage.alarms.length = 0;
    freezeClock();

    await harness.internals.alarm();

    // Maintenance's failure is logged and carried; it is not a reason to skip
    // the half that keeps D1 current.
    expect(floorOf(harness)).toBe(0);
    expect(errors.filter((l) => l.includes("[maintenance]"))).toHaveLength(1);
    expect(blobWrites(harness)).toHaveLength(1);
    expect(harness.db.row()?.yjs_generation).toBe(1);
    expect(harness.storage.alarms).toHaveLength(1);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
  });

  it("arms nothing when there is neither a socket nor work left", async () => {
    const harness = maintenanceHarness(0);

    await harness.internals.alarm();

    expect(harness.storage.alarms).toHaveLength(0);
  });

  it("runs the snapshot half after the slice and holds the thirty-second cadence with a socket", async () => {
    const events: string[] = [];
    const harness = makeDo({ row: tagged(BASE_A, 1, 0, 4) }, {}, [], events);
    harness.storage.kv.set("docGeneration", 1);
    plantGeneration(harness.storage, 0, 10);
    await harness.internals.ensureDocLoaded();
    harness.sockets.push(fakeSocket(events, { generation: 1 }));
    harness.storage.alarms.length = 0;
    // The setup's own record says nothing about the order inside the alarm.
    events.length = 0;
    freezeClock();

    await harness.internals.alarm();

    expect(floorOf(harness)).toBe(1);
    // The floor write completes the slice, and the blob write is the snapshot
    // half: the one follows the other on the alarm's own record.
    const floorWrite = events.indexOf("put:other");
    const blobWrite = events.findIndex((e) => /^run:UPDATE projects SET yjs_state/.test(e));
    expect(floorWrite).toBeGreaterThanOrEqual(0);
    expect(blobWrite).toBeGreaterThan(floorWrite);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
  });

  it("does nothing and arms nothing under a resident halt", async () => {
    const harness = maintenanceHarness(2);
    plantGeneration(harness.storage, 0, 10);
    harness.internals.persistenceHalted = { generation: 2, marker: { reason: "apply_failed", at: 1 } };

    await harness.internals.alarm();

    expect(harness.storage.deleteBatches).toHaveLength(0);
    expect(harness.storage.alarms).toHaveLength(0);
  });

  it("does nothing and arms nothing when a socketless wake's preflight finds a durable marker", async () => {
    const harness = maintenanceHarness(2);
    plantGeneration(harness.storage, 0, 10);
    plantMarker(harness.storage, 2, "enforcement_failed");

    await harness.internals.alarm();

    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.storage.deleteBatches).toHaveLength(0);
    expect(harness.storage.alarms).toHaveLength(0);
  });

  it("does not re-arm when the snapshot half enters a halt", async () => {
    const events: string[] = [];
    const harness = makeDo({ row: tagged(BASE_A, 1, 0, 4) }, {}, [], events);
    harness.storage.kv.set("docGeneration", 1);
    await harness.internals.ensureDocLoaded();
    harness.sockets.push(fakeSocket(events, { generation: 1 }));
    harness.storage.alarms.length = 0;
    const snapshot = harness.internals.snapshotToD1.bind(harness.internals);
    harness.internals.snapshotToD1 = async () => {
      (harness.internals as unknown as { enterHalt: (r: string, g: number) => void })
        .enterHalt("fence_refused", 1);
      return snapshot();
    };

    await harness.internals.alarm();

    expect(harness.internals.persistenceHalted).not.toBeNull();
    expect(harness.storage.alarms).toHaveLength(0);
  });

  it("leaves an earlier alarm exactly where the reset found it", async () => {
    const harness = await stagedResetHarness();
    const now = freezeClock();
    await harness.storage.setAlarm(now + 1_000);
    harness.storage.alarms.length = 0;

    await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    // A pending alarm sooner than the maintenance delay runs maintenance too,
    // and moving it out would delay the snapshot it was armed for.
    expect(harness.storage.alarms).toHaveLength(0);
    expect(await harness.storage.getAlarm()).toBe(now + 1_000);
  });

  it("brings an alarm later than the maintenance delay forward to it", async () => {
    const harness = await stagedResetHarness();
    const now = freezeClock();
    await harness.storage.setAlarm(now + SNAPSHOT_ALARM_MS);
    harness.storage.alarms.length = 0;

    await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(harness.storage.alarms).toEqual([now + MAINTENANCE_DELAY_MS]);
    expect(await harness.storage.getAlarm()).toBe(now + MAINTENANCE_DELAY_MS);
  });

  it("arms the sweep once from a load that opens with the floor behind", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 2, 0, 4)] });
    harness.storage.kv.set("docGeneration", 2);
    const now = freezeClock();

    await harness.internals.ensureDocLoaded();

    // The repair record arms the snapshot's own thirty seconds first, and the
    // sweep brings it forward.
    expect(harness.storage.alarms).toEqual([
      now + SNAPSHOT_ALARM_MS,
      now + MAINTENANCE_DELAY_MS,
    ]);

    // Once: the second call finds the document open and reads nothing.
    await harness.internals.ensureDocLoaded();
    expect(harness.storage.alarms).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// One gate each, and no nesting
// ---------------------------------------------------------------------------

describe("the reset and the alarm each run under one gate of their own", () => {
  it("opens exactly one gate per reset, and takes every protected operation inside it", async () => {
    const harness = await stagedResetHarness();
    const depths = watchDepths(harness);
    harness.ctx.gates = 0;
    harness.ctx.maxDepth = 0;

    expect((await harness.doInstance.fetch(await signedRequest("/reset", "reset"))).status)
      .toBe(200);

    expect(harness.ctx.gates).toBe(1);
    expect(harness.ctx.maxDepth).toBe(1);
    // The reset's own operations, each named: an empty gate followed by ungated
    // work would satisfy the counts above and fail every line below.
    const staged = depths.depthsOf("put");
    const read = depths.depthsOf("get", "d1:first", "d1:all");
    const written = depths.depthsOf("d1:run");
    const retired = depths.depthsOf("delete");
    const armed = depths.depthsOf("getAlarm", "setAlarm");
    for (const recorded of [staged, read, written, retired, armed]) {
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.every((depth) => depth === 1)).toBe(true);
    }
  });

  it("opens exactly one gate per alarm, covering the slice and the snapshot half alike", async () => {
    const events: string[] = [];
    const harness = makeDo({ row: tagged(BASE_A, 1, 0, 4) }, {}, [], events);
    harness.storage.kv.set("docGeneration", 1);
    plantGeneration(harness.storage, 0, 10);
    await harness.internals.ensureDocLoaded();
    harness.sockets.push(fakeSocket(events, { generation: 1 }));
    const depths = watchDepths(harness);
    harness.ctx.gates = 0;
    harness.ctx.maxDepth = 0;

    await harness.internals.alarm();

    // Cloudflare's gate does not nest, so the snapshot half runs inside the
    // alarm's own gate rather than opening one.
    expect(harness.ctx.gates).toBe(1);
    expect(harness.ctx.maxDepth).toBe(1);
    expect(floorOf(harness)).toBe(1);
    expect(harness.db.mutations.some((s) => /^UPDATE projects SET yjs_state/.test(s.sql))).toBe(true);
    // The slice's reads, its deletions and its floor write; then the snapshot
    // half's statements and its batch.
    const listed = depths.depthsOf("list", "get");
    const deleted = depths.depthsOf("delete");
    const floorWrite = depths.depthsOf("put");
    const snapshot = depths.depthsOf("d1:run", "d1:batch");
    for (const recorded of [listed, deleted, floorWrite, snapshot]) {
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.every((depth) => depth === 1)).toBe(true);
    }
    // The scheduling runs inside the same gate as the phases it reads: what an
    // invocation armed has to be observable in the invocation that armed it,
    // and `scheduleAfterAlarm` holds no gate of its own to nest.
    expect(depths.depthsOf("setAlarm")).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// The log write: message groups, standalone records, and the ceiling
// ---------------------------------------------------------------------------

/** A sync message of `subtype` carrying exactly these bytes. */
function syncMessage(subtype: number, payload: Uint8Array): ArrayBuffer {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  encoding.writeVarUint(enc, subtype);
  encoding.writeVarUint8Array(enc, payload);
  return encoding.toUint8Array(enc).buffer as ArrayBuffer;
}

/** One edit to the story the base carries, as the raw bytes a client sends. */
function titleEdit(seed: Uint8Array, text: string): Uint8Array {
  return recordBytes(seed, (doc) => {
    (doc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text).insert(0, text);
  });
}

/** Every put batch that carries a log key, in issue order. */
function logBatches(storage: FakeStorage): string[][] {
  return storage.putBatches.filter((keys) => keys.some((key) => key.startsWith("log:")));
}

/** Every log key written, flattened, in issue order. */
function loggedKeys(storage: FakeStorage): string[] {
  return logBatches(storage).flat().filter((key) => key.startsWith("log:"));
}

/** The bytes stored at one record, read back through the codec that wrote it. */
function storedRecord(
  storage: FakeStorage,
  generation: number,
  seq: number,
): Promise<Uint8Array | null> {
  return readRecord(storage as unknown as LogStorage, logKey(generation, seq));
}

/**
 * A document built by applying the base and then every record above `from`, in
 * order and origin-less — what step 5's replay does, run here against what this
 * step wrote.
 */
async function replayed(
  storage: FakeStorage,
  base: Uint8Array,
  generation: number,
  from: number,
  to: number,
): Promise<Y.Doc> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base);
  for (let seq = from; seq <= to; seq++) {
    const bytes = await storedRecord(storage, generation, seq);
    if (bytes !== null) Y.applyUpdate(doc, bytes);
  }
  return doc;
}

/** Mark where the apply ran, so the group's put can be placed against it. */
function traceApply(internals: Internals, events: string[]): void {
  const real = (internals as unknown as {
    applyInboundSync: (...args: unknown[]) => unknown;
  }).applyInboundSync.bind(internals);
  (internals as unknown as { applyInboundSync: (...args: unknown[]) => unknown })
    .applyInboundSync = (...args: unknown[]) => {
      events.push("apply");
      return real(...args);
    };
}

/** A put the test holds open, so what the caller does across it is observable. */
function heldPut() {
  let land!: () => void;
  const gate = new Promise<void>((resolve) => { land = resolve; });
  return { gate, release: () => land() };
}

describe("an accepted message is written as one group before the drain", () => {
  it.each([
    ["an update", syncProtocol.messageYjsUpdate],
    ["a sync step 2", syncProtocol.messageYjsSyncStep2],
  ])("writes %s as one record, before the drain, and advances the sequence by one", async (
    _label,
    subtype,
  ) => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor, peer);
    traceApply(harness.internals, events);
    const held = harness.internals.docSeq as number;
    const payload = titleEdit(BASE_A, "new ");

    await harness.internals.webSocketMessage(editor, syncMessage(subtype, payload));

    expect(harness.internals.docSeq).toBe(held + 1);
    // One put, one key, and the key is the exact one the sequence names.
    expect(logBatches(harness.storage)).toEqual([[logKey(0, held + 1)]]);
    expect(await storedRecord(harness.storage, 0, held + 1)).toEqual(payload);
    // The apply, then the group, then everything the message releases.
    expect(events.filter((e) => e === "apply" || e === "put:log" || e === "send"))
      .toEqual(["apply", "put:log", "send"]);
    expect(peer.sent).toHaveLength(1);
    expect(titleOf(harness.internals.ydoc)).toBe("new Story A");
  });

  it("does not await the group, so the message finishes while the put is pending", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const held = heldPut();
    const harness = await loaded({}, {
      holdPut: (keys) => (keys[0].startsWith("log:") ? held.gate : undefined),
    }, [], events);
    harness.sockets.push(editor, peer);

    const pending = harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, titleEdit(BASE_A, "new ")),
    );
    let finished = false;
    void pending.then(() => { finished = true; });
    await settle();

    // The handler ran to the end with the put still pending. What holds the
    // relay back on the real backend is the output gate, which this fake does
    // not have — so this is an issuance claim, not a delivery one.
    expect(finished).toBe(true);
    expect(peer.sent).toHaveLength(1);
    held.release();
    await pending;
  });

  it("writes nothing and advances nothing for a step 1", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor);
    const held = harness.internals.docSeq;

    await harness.internals.webSocketMessage(editor, step1Message());

    expect(logBatches(harness.storage)).toEqual([]);
    expect(harness.internals.docSeq).toBe(held);
    expect(editor.sent).toHaveLength(1);
  });

  it("writes nothing for an awareness message", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor);
    const held = harness.internals.docSeq;

    await harness.internals.webSocketMessage(editor, awarenessMessage().message);

    expect(logBatches(harness.storage)).toEqual([]);
    expect(harness.internals.docSeq).toBe(held);
  });

  it("writes one record for a message, never one for the socket's own transaction", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor);

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, titleEdit(BASE_A, "new ")),
    );

    // The raw payload stands for the socket-origin transaction the apply opened,
    // so the group holds one record and not two.
    expect(loggedKeys(harness.storage)).toHaveLength(1);
    expect(events.filter((e) => e === "put:log")).toHaveLength(1);
  });
});

/**
 * One document's state as bytes a second document can be compared against.
 *
 * A document that has been edited in place carries whatever struct splits its
 * edits produced, and two documents holding one state need not have split
 * alike; a state applied to an empty document is integrated in that document's
 * own order instead, so the copy is what the comparison is made of.
 */
function normalisedState(doc: Y.Doc): Uint8Array {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return Y.encodeStateAsUpdate(copy);
}

/** What a document is holding for structs it cannot integrate yet. */
function pendingShape(doc: Y.Doc): unknown {
  const pending = doc.store.pendingStructs;
  return {
    missing: pending === null ? null : [...pending.missing.entries()],
    deleteSet: doc.store.pendingDs,
  };
}

/**
 * The replayed document holds exactly what the live one does.
 *
 * The claim is the brief's: the log replayed from the base reconstructs the
 * document the messages left. So the two encoded states are compared directly,
 * each normalised through a copy of its own. The explicit checks beside them,
 * on the delete set and on the structs held for a missing dependency,
 * supplement that equality with the two shapes a reader of the comparison
 * most needs named.
 */
function expectSameDocument(replay: Y.Doc, live: Y.Doc): void {
  expect(normalisedState(replay)).toEqual(normalisedState(live));
  expect(Y.equalDeleteSets(
    Y.createDeleteSetFromStructStore(replay.store),
    Y.createDeleteSetFromStructStore(live.store),
  )).toBe(true);
  expect(pendingShape(replay)).toEqual(pendingShape(live));
}

describe("the message scope is synchronous and ends before the first await", () => {
  it("writes a transaction issued across the activity flush as a record of its own", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const flush = heldBatch();
    const harness = await loaded({ batch: () => flush.hold() }, {}, [], events);
    harness.sockets.push(editor);
    const held = harness.internals.docSeq as number;

    const pending = harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, titleEdit(BASE_A, "new ")),
    );
    await flush.issued;

    // The eager activity batch is in flight, so the handler is past its message
    // scope. A DO-origin transaction here is nobody's message.
    harness.internals.ydoc.transact(() => {
      harness.internals.ydoc.getMap<unknown>("config").set("skip_stories", true);
    }, null);
    flush.release();
    await pending;

    // Two puts, not one group of two: the message's record and the standalone
    // one, each at its own sequence.
    expect(loggedKeys(harness.storage)).toEqual([
      logKey(0, held + 1),
      logKey(0, held + 2),
    ]);
    expect(logBatches(harness.storage)).toHaveLength(2);
    expect(harness.internals.docSeq).toBe(held + 2);
  });
});

describe("what a message provokes is written into the message's group", () => {
  it("writes the payload and the guard's revert as one group at consecutive sequences", async () => {
    const events: string[] = [];
    const harness = await guardHarness({}, {}, events);
    const held = harness.internals.docSeq as number;

    await harness.internals.webSocketMessage(
      harness.editor,
      refusedDeleteStep2(harness.internals),
    );

    // One put, and every record the message caused inside it: the raw payload,
    // then the two updates the enforcement emits — Yjs's `cleanup` transaction,
    // opened while the guard read the text under a snapshot and cleaned up only
    // after the revert had landed, and the revert itself under `REVERT_ORIGIN`.
    // In the order Yjs emitted them, at consecutive sequences.
    expect(logBatches(harness.storage)).toEqual([[
      logKey(0, held + 1),
      logKey(0, held + 2),
      logKey(0, held + 3),
    ]]);
    expect(harness.internals.docSeq).toBe(held + 3);
    expect(harness.internals.persistenceHalted).toBeNull();

    // And the two of them replay onto the base as the corrected document: the
    // origin-less replay reaches neither the guard nor the accumulator, which is
    // correct only because the correction is logged beside what provoked it.
    const replay = await replayed(harness.storage, BASE_A, 0, 1, held + 3);
    expectSameDocument(replay, harness.internals.ydoc);
    // The cleanup's deferred update carries the revert's structs, so the two
    // records are the same bytes. Applying one twice is a no-op, and deciding by
    // inspection which emitted update is redundant would be guessing at what
    // the document holds — so both are kept.
    expect(await storedRecord(harness.storage, 0, held + 2))
      .toEqual(await storedRecord(harness.storage, 0, held + 3));
  });

  it("writes the payload and a formatting cleanup as one group", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor);
    // The client formats a range it cannot see the server has already formatted,
    // so the two runs overlap and Yjs's cleanup removes the redundant marker in
    // a transaction of its own.
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(harness.internals.ydoc));
    const before = Y.encodeStateVector(client);
    client.transact(() => {
      const title = client.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text;
      title.format(0, 5, { bold: true });
    });
    const payload = Y.encodeStateAsUpdate(client, before);

    harness.internals.ydoc.transact(() => {
      const title = harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0)
        .get("title") as Y.Text;
      title.format(0, 3, { bold: true });
    }, null);
    await settle();
    harness.storage.putBatches.length = 0;
    const held = harness.internals.docSeq as number;

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, payload),
    );

    expect(logBatches(harness.storage)).toHaveLength(1);
    expect(loggedKeys(harness.storage)).toEqual([logKey(0, held + 1), logKey(0, held + 2)]);
    expect(await storedRecord(harness.storage, 0, held + 1)).toEqual(payload);
    const replay = await replayed(harness.storage, BASE_A, 0, 1, held + 2);
    expectSameDocument(replay, harness.internals.ydoc);
  });
});

/**
 * Two updates from one client, the second depending on the first: a new story,
 * then a change inside it.
 */
function dependentUpdates(seed: Uint8Array, edit: (doc: Y.Doc) => void): {
  first: Uint8Array;
  second: Uint8Array;
} {
  const client = new Y.Doc();
  Y.applyUpdate(client, seed);
  const before = Y.encodeStateVector(client);
  client.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("_id", 77);
    story.set("story_id", "later");
    story.set("title", new Y.Text("Later"));
    story.set("order_key", "c0");
    client.getArray<Y.Map<unknown>>("stories").push([story]);
  });
  const between = Y.encodeStateVector(client);
  client.transact(() => edit(client));
  return {
    first: Y.encodeStateAsUpdate(client, before),
    second: Y.encodeStateAsUpdate(client, between),
  };
}

/** The pending state of a document assembled from the log alone. */
function isPending(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null;
}

describe("a payload held pending is written, and replays into the same pending state", () => {
  it("writes it, replays it pending, and integrates it when the dependency's record follows", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor);
    const held = harness.internals.docSeq as number;
    const { first, second } = dependentUpdates(BASE_A, (doc) => {
      const later = doc.getArray<Y.Map<unknown>>("stories").get(1);
      (later.get("title") as Y.Text).insert(0, "much ");
    });

    // The dependency is missing, so Yjs holds the payload and emits no update.
    // The raw bytes are what stands for it.
    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, second),
    );

    expect(loggedKeys(harness.storage)).toEqual([logKey(0, held + 1)]);
    expect(await storedRecord(harness.storage, 0, held + 1)).toEqual(second);
    expect(isPending(harness.internals.ydoc)).toBe(true);
    const pendingReplay = await replayed(harness.storage, BASE_A, 0, 1, held + 1);
    expect(isPending(pendingReplay)).toBe(true);
    expect(titles(pendingReplay)).toEqual(["Story A"]);

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, first),
    );

    expect(loggedKeys(harness.storage)).toEqual([logKey(0, held + 1), logKey(0, held + 2)]);
    const replay = await replayed(harness.storage, BASE_A, 0, 1, held + 2);
    expect(isPending(replay)).toBe(false);
    expect(titles(replay)).toEqual(["Story A", "much Later"]);
    expectSameDocument(replay, harness.internals.ydoc);
  });

  it("replays a pending payload that provoked enforcement once unlocked as the corrected document", async () => {
    const events: string[] = [];
    const harness = await guardHarness({}, {}, events);
    const held = harness.internals.docSeq as number;
    const seed = Y.encodeStateAsUpdate(harness.internals.ydoc);
    // The second update both depends on the first and carries a deletion the
    // guard will refuse, so enforcement runs on the transaction that unlocks it.
    const { first, second } = dependentUpdates(seed, (doc) => {
      const stories = doc.getArray<Y.Map<unknown>>("stories");
      const later = stories.get(stories.length - 1);
      (later.get("title") as Y.Text).insert(0, "much ");
      stories.delete(stories.toArray().findIndex((m) => m.get("story_id") === "victim"), 1);
    });

    await harness.internals.webSocketMessage(
      harness.editor,
      syncMessage(syncProtocol.messageYjsUpdate, second),
    );
    expect(harness.internals.revertedThisMessage).toBe(false);

    await harness.internals.webSocketMessage(
      harness.editor,
      syncMessage(syncProtocol.messageYjsUpdate, first),
    );

    expect(harness.internals.persistenceHalted).toBeNull();
    // The victim is back, and the replay of the log alone says the same.
    expect(titles(harness.internals.ydoc)).toContain("Victim");
    const replay = await replayed(
      harness.storage,
      BASE_A,
      0,
      1,
      harness.internals.docSeq as number,
    );
    expect(replay).toBeDefined();
    expectSameDocument(replay, harness.internals.ydoc);
    expect(harness.internals.docSeq as number).toBeGreaterThan(held + 2);
  });
});

describe("a failed message writes no group and advances nothing", () => {
  it("writes only the halt marker when the apply throws", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor);
    const held = harness.internals.docSeq;

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, new Uint8Array([9, 9, 9])),
    );

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("apply_failed");
    expect(loggedKeys(harness.storage)).toEqual([]);
    expect(harness.storage.putBatches).toEqual([[haltKey(0)]]);
    expect(harness.internals.docSeq).toBe(held);
  });

  it("writes only the halt marker when an observer throws after integration", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor);
    const held = harness.internals.docSeq;
    harness.internals.ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      if (tr.origin === editor) throw new Error("observer threw after integration");
    });

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, titleEdit(BASE_A, "new ")),
    );

    // The structs are integrated and the observer threw afterwards, so the
    // document holds a change no group carries: the halt is the answer, and the
    // sequence does not move.
    expect(harness.internals.persistenceHalted?.marker.reason).toBe("apply_failed");
    expect(loggedKeys(harness.storage)).toEqual([]);
    expect(harness.internals.docSeq).toBe(held);
  });

  it("writes only the halt marker when enforcement fails, and abandons the attribution", async () => {
    const events: string[] = [];
    const harness = await guardHarness({}, {}, events);
    const held = harness.internals.docSeq;
    const message = refusedDeleteMessage(harness.internals);

    const restore = breakTheRevert();
    try {
      await harness.internals.webSocketMessage(harness.editor, message);
    } finally {
      restore();
    }

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("enforcement_failed");
    expect(harness.storage.putBatches).toEqual([[haltKey(0)]]);
    expect(harness.internals.docSeq).toBe(held);
    // The message touched the document, so what it accrued is abandoned.
    expect(harness.internals.userFieldSets.size).toBe(0);
    expect(harness.internals.lastEditAt.size).toBe(0);
  });
});

/** Every `[persistence][refused]` line, which is the ceiling's own tag. */
function refusedLines(): string[] {
  return errors.filter((line) => line.includes("[persistence][refused]"));
}

describe("an update above the record ceiling is refused before it is applied", () => {
  it.each([
    ["an update", syncProtocol.messageYjsUpdate],
    ["a sync step 2", syncProtocol.messageYjsSyncStep2],
  ])("applies nothing, writes nothing and closes the socket 1009 for %s", async (
    _label,
    subtype,
  ) => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor, peer);

    // Attribution accrued by an earlier, healthy message, so "untouched" is a
    // claim about something rather than about an empty map.
    await harness.internals.webSocketMessage(
      peer,
      syncMessage(syncProtocol.messageYjsUpdate, titleEdit(BASE_A, "first ")),
    );
    const credited = new Map(harness.internals.userFieldSets);
    expect(credited.size).toBeGreaterThan(0);
    const held = harness.internals.docSeq;
    const served = titles(harness.internals.ydoc);
    harness.storage.putBatches.length = 0;
    errors.length = 0;

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(subtype, new Uint8Array(MAX_RECORD_BYTES + 1)),
    );

    // Nothing applied, nothing logged, and no halt: the document did not change,
    // so there is no state to refuse to persist from.
    expect(titles(harness.internals.ydoc)).toEqual(served);
    expect(harness.internals.docSeq).toBe(held);
    expect(harness.storage.putBatches).toEqual([]);
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.storage.kv.has(haltKey(0))).toBe(false);
    expect(editor.closes).toEqual([{ code: 1009, reason: "Message too big" }]);
    expect(refusedLines()).toHaveLength(1);
    expect(refusedLines()[0]).toContain(String(MAX_RECORD_BYTES + 1));
    expect(refusedLines()[0]).toContain(`project ${PROJECT_ID}`);
    // The attribution of the earlier messages stands.
    expect([...harness.internals.userFieldSets.keys()]).toEqual([...credited.keys()]);

    // And the next message from another socket is accepted as usual.
    await harness.internals.webSocketMessage(
      peer,
      syncMessage(syncProtocol.messageYjsUpdate, titleEdit(BASE_A, "second ")),
    );
    expect(harness.internals.docSeq).toBe((held as number) + 1);
    expect(loggedKeys(harness.storage)).toEqual([logKey(0, (held as number) + 1)]);
  });
});

describe("a group that cannot be written halts as group_discarded", () => {
  it("halts when the sequence has no room, writing the marker and nothing else", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor, peer);
    harness.internals.docSeq = MAX_SEQ;

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, titleEdit(BASE_A, "new ")),
    );

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
    expect(harness.storage.kv.get(haltKey(0))).toMatchObject({ reason: "group_discarded" });
    // Every record is encoded before any batch is issued, so nothing was
    // written at all.
    expect(harness.storage.putBatches).toEqual([[haltKey(0)]]);
    expect(harness.internals.docSeq).toBe(MAX_SEQ);
    expect(peer.sent).toHaveLength(0);
    expect(editor.closes).toContainEqual(UNAVAILABLE);
  });

  it("halts when the group's first put throws, with the marker's put succeeding after it", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor, peer);
    const held = harness.internals.docSeq;
    harness.storage.arm({
      putThrowsOn: (keys) => (keys[0].startsWith("log:") ? new Error("storage gone") : undefined),
    });

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, titleEdit(BASE_A, "new ")),
    );

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
    expect(harness.storage.kv.get(haltKey(0))).toMatchObject({ reason: "group_discarded" });
    expect(harness.internals.docSeq).toBe(held);
    expect(peer.sent).toHaveLength(0);
  });

  it("halts when a later batch of the group throws, with the marker's put succeeding after it", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const peer = fakeSocket(events, { userId: OTHER_USER });
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor, peer);
    const held = harness.internals.docSeq;
    // Over 128 parts, so the codec issues the group as more than one batch and
    // the SECOND one is the one made to throw.
    const payload = titleEdit(BASE_A, "x".repeat(13 * 1024 * 1024));
    expect(payload.length).toBeLessThan(MAX_RECORD_BYTES);
    let logPuts = 0;
    harness.storage.arm({
      putThrowsOn: (keys) => {
        if (!keys[0].startsWith("log:")) return undefined;
        logPuts += 1;
        return logPuts === 2 ? new Error("storage gone") : undefined;
      },
    });

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, payload),
    );

    expect(logPuts).toBeGreaterThan(1);
    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
    expect(harness.storage.kv.get(haltKey(0))).toMatchObject({ reason: "group_discarded" });
    expect(harness.internals.docSeq).toBe(held);
    expect(peer.sent).toHaveLength(0);
  });
});

/** Add a story the snapshot has to INSERT, under a null origin. */
function addUnsavedStory(internals: Internals, storyId = "fresh"): void {
  internals.ydoc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("story_id", storyId);
    story.set("title", new Y.Text("Fresh"));
    story.set("order_key", "d0");
    internals.ydoc.getArray<Y.Map<unknown>>("stories").push([story]);
  }, null);
}

/** The `yjs_seq` the blob write bound, from the statement it issued. */
function blobSeq(harness: { db: { mutations: Issued[] } }): number {
  const write = harness.db.mutations.find((s) =>
    /^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(s.sql));
  return write?.binds[2] as number;
}

describe("a transaction outside a message is a record of its own", () => {
  it.each([
    [
      "/restore-orphans",
      "restore-orphans",
      { stories: [{ storyId: "lost", steps: [], layers: [] }] },
      () => { /* the route builds the story itself */ },
    ],
    [
      "/ingest-sync",
      "ingest-sync",
      { pages: { insert: [{ slug: "about", title: "About", body: "About body.", created_by: USER_ID }] } },
      () => { /* the route builds the page itself */ },
    ],
    [
      "/clear-course-markers",
      "clear-course-markers",
      { courseProjectId: 5 },
      (internals: Internals) => {
        // A marker to clear: the route mutates nothing without one, and a route
        // that mutates nothing writes nothing, which is the rule rather than a
        // gap in it.
        internals.ydoc.transact(() => {
          const object = new Y.Map<unknown>();
          object.set("_id", 51);
          object.set("object_id", "o51");
          object.set("order_key", "a0");
          object.set("course_project_id", 5);
          internals.ydoc.getArray<Y.Map<unknown>>("objects").push([object]);
        }, null);
      },
    ],
  ])("writes one record per transaction, one key per put, for %s", async (path, action, body, prepare) => {
    const harness = await loaded({ rows: ONE_STORY });
    prepare(harness.internals);
    await settle();
    harness.storage.putBatches.length = 0;
    const held = harness.internals.docSeq as number;

    const response = await harness.doInstance.fetch(await signedRequest(path, action, body));

    expect(response.status).toBe(200);
    const batches = logBatches(harness.storage);
    expect(batches.length).toBeGreaterThan(0);
    // One record per transaction: every standalone put carries exactly one key,
    // and the sequence moved by exactly as many records as were written.
    for (const batch of batches) expect(batch).toHaveLength(1);
    expect(loggedKeys(harness.storage)).toEqual(
      batches.map((_batch, index) => logKey(0, held + index + 1)),
    );
    expect(harness.internals.docSeq).toBe(held + batches.length);
  });

  it("writes the repairs a load runs, and arms the alarm for each record", async () => {
    const events: string[] = [];
    const harness = makeDo({ base: [tagged(BASE_A, 0, 4, 4)], rows: ONE_STORY }, {}, [], events);
    const now = freezeClock();

    await harness.internals.ensureDocLoaded();
    await settle();

    // The base's sequence seeds the instance, and the repairs above it are
    // records: the first is the next sequence after the base's.
    expect(loggedKeys(harness.storage)).toEqual([logKey(0, 5)]);
    expect(harness.internals.docSeq).toBe(5);
    // A record written with no socket attached still reaches the alarm.
    expect(harness.storage.alarms).toEqual([now + SNAPSHOT_ALARM_MS]);
  });

  it("writes a snapshot's _id backfill, and the blob carries the sequence that includes it", async () => {
    const harness = await loaded({ rows: ONE_STORY });
    addUnsavedStory(harness.internals);
    await settle();
    const held = harness.internals.docSeq as number;
    harness.storage.putBatches.length = 0;

    await harness.internals.doSnapshot();

    // The INSERT's backfill is a transaction between D1 awaits, and it is one
    // record; the blob is encoded after it, so the pair the row carries names
    // the state those bytes hold.
    expect(loggedKeys(harness.storage)).toEqual([logKey(0, held + 1)]);
    expect(harness.internals.docSeq).toBe(held + 1);
    expect(blobSeq(harness)).toBe(held + 1);
  });

  it("gives a transaction issued after the encoding a sequence above the blob's", async () => {
    const gate = heldPut();
    let reached!: () => void;
    const issued = new Promise<void>((resolve) => { reached = resolve; });
    const harness = await loaded({
      rows: ONE_STORY,
      holdRun: (sql) => {
        if (!/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)) {
          return undefined;
        }
        reached();
        return gate.gate;
      },
    });
    const held = harness.internals.docSeq as number;

    const pending = harness.internals.doSnapshot();
    await issued;
    // The sequence was captured beside the encoding, and this transaction comes
    // after it: its record sits above the blob's sequence and replays onto it.
    harness.internals.ydoc.transact(() => {
      harness.internals.ydoc.getMap<unknown>("config").set("skip_stories", true);
    }, null);
    gate.release();
    await pending;

    expect(blobSeq(harness)).toBe(held);
    expect(harness.internals.docSeq).toBe(held + 1);
    expect(loggedKeys(harness.storage)).toEqual([logKey(0, held + 1)]);
  });
});

/** Make every log put throw synchronously, leaving the marker's put alone. */
const LOG_PUT_THROWS: StorageOptions = {
  putThrowsOn: (keys) => (keys[0].startsWith("log:") ? new Error("storage gone") : undefined),
};

describe("a standalone record that cannot be written halts too", () => {
  it("stops a snapshot before its blob write and before its entity batch", async () => {
    const harness = await loaded({ rows: ONE_STORY });
    addUnsavedStory(harness.internals);
    await settle();
    const held = harness.internals.docSeq;
    harness.db.clear();
    harness.storage.arm(LOG_PUT_THROWS);

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
    expect(harness.storage.kv.get(haltKey(0))).toMatchObject({ reason: "group_discarded" });
    expect(harness.internals.docSeq).toBe(held);
    // The INSERT landed and its backfill ran; nothing that would persist them
    // followed.
    expect(harness.db.mutations.filter((s) => /^UPDATE projects/.test(s.sql))).toHaveLength(0);
    expect(harness.db.batchCalls()).toBe(0);
  });

  it("writes no entity row at all when the deduplication's re-key is the failed record", async () => {
    const harness = await loaded({ rows: ONE_STORY });
    // A second story under the key D1 already holds for the first. The snapshot
    // re-keys it before any pipeline runs, and that re-key is a transaction of
    // its own — so the halt is latched with every INSERT still ahead of it.
    addUnsavedStory(harness.internals, "s11");
    await settle();
    const held = harness.internals.docSeq;
    harness.db.clear();
    harness.storage.arm(LOG_PUT_THROWS);

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
    expect(harness.internals.docSeq).toBe(held);
    // The whole inventory, not the blob and the batch alone: an INSERT is
    // persistence of the same kind, and it is what the re-key would be
    // persisted by.
    expect(harness.db.mutations.filter((s) => /^INSERT INTO /.test(s.sql))).toHaveLength(0);
    expect(harness.db.mutations.filter((s) => /^UPDATE projects/.test(s.sql))).toHaveLength(0);
    expect(harness.db.batchCalls()).toBe(0);
  });

  it("writes no second entity row when a listener throws after the failed record", async () => {
    const harness = await loaded({ rows: ONE_STORY });
    addUnsavedStory(harness.internals, "first");
    addUnsavedStory(harness.internals, "second");
    await settle();
    const held = harness.internals.docSeq;
    harness.db.clear();
    harness.storage.arm(LOG_PUT_THROWS);
    // An observer that throws once the backfill's structs are integrated: the
    // record's failure is latched by then, and the exit the throw takes is the
    // backfill's exceptional one. The condition is a transaction that changed
    // something, since the nested dedup pass opens an empty one of its own.
    harness.internals.ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      if (tr.origin === null && tr.changed.size > 0) {
        throw new Error("observer threw after integration");
      }
    });

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
    expect(harness.internals.docSeq).toBe(held);
    // The INSERT that PRECEDED the failed record has landed and stays; the
    // second story's has not been attempted.
    expect(harness.db.mutations.filter((s) => /^INSERT INTO stories/.test(s.sql)))
      .toHaveLength(1);
    expect(harness.db.mutations.filter((s) => /^UPDATE projects/.test(s.sql))).toHaveLength(0);
    expect(harness.db.batchCalls()).toBe(0);
  });

  it("answers the route that provoked it with 503 persistence_halted", async () => {
    const harness = await loaded({ rows: ONE_STORY });
    addUnsavedStory(harness.internals);
    await settle();
    harness.storage.arm(LOG_PUT_THROWS);

    const response = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("persistence_halted");
    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
  });

  it("fails the load, disposes the document and closes the sockets during a repair", async () => {
    const events: string[] = [];
    const socket = fakeSocket(events);
    const harness = makeDo(
      { base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY },
      LOG_PUT_THROWS,
      [socket],
      events,
    );

    await expect(harness.internals.ensureDocLoaded())
      .rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
    expect(harness.storage.kv.get(haltKey(0))).toMatchObject({ reason: "group_discarded" });
    expect(harness.internals.docLoaded).toBe(false);
    expect(harness.internals.ydoc.getArray("stories").length).toBe(0);
    expect(socket.closes).toContainEqual(UNAVAILABLE);
  });
});

describe("a record the codec refuses is the same halt as a record that cannot be put", () => {
  it("discards a message's whole group when a later captured record cannot be encoded", async () => {
    const events: string[] = [];
    const harness = await guardHarness({}, {}, events);
    const held = harness.internals.docSeq as number;
    // The last of the three an enforcement message writes: the payload and the
    // cleanup encode cleanly before it, and neither may be put on its own.
    encodings.refuse = logKey(0, held + 3);

    await harness.internals.webSocketMessage(
      harness.editor,
      refusedDeleteStep2(harness.internals),
    );

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
    expect(harness.storage.kv.get(haltKey(0))).toMatchObject({ reason: "group_discarded" });
    expect(harness.internals.docSeq).toBe(held);
    expect(harness.storage.putBatches).toEqual([[haltKey(0)]]);
    expect(harness.peer.sent).toHaveLength(0);
    expect(harness.editor.closes).toContainEqual(UNAVAILABLE);
  });

  it("stops a snapshot before its blob and its batch when a standalone record cannot be encoded", async () => {
    const harness = await loaded({ rows: ONE_STORY });
    addUnsavedStory(harness.internals);
    await settle();
    const held = harness.internals.docSeq as number;
    harness.db.clear();
    harness.storage.putBatches.length = 0;
    encodings.refuse = logKey(0, held + 1);

    await expect(harness.internals.doSnapshot()).rejects.toBeInstanceOf(PersistenceHaltedError);

    expect(harness.internals.persistenceHalted?.marker.reason).toBe("group_discarded");
    expect(harness.internals.docSeq).toBe(held);
    expect(loggedKeys(harness.storage)).toEqual([]);
    // The INSERT the backfill belongs to had already landed; nothing after it.
    expect(harness.db.mutations.filter((s) => /^INSERT INTO stories/.test(s.sql)))
      .toHaveLength(1);
    expect(harness.db.mutations.filter((s) => /^UPDATE projects/.test(s.sql))).toHaveLength(0);
    expect(harness.db.batchCalls()).toBe(0);
  });
});

describe("nothing is written while logging is suppressed", () => {
  it("writes nothing for the base or the replay, and seeds the first record above the tail", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 5, 4)], rows: ONE_STORY });
    for (let seq = 6; seq <= 8; seq++) {
      plantRecord(harness.storage, 0, seq, fieldRecord(`field_${seq}`, String(seq)));
    }

    await harness.internals.ensureDocLoaded();

    // The base and the three replayed records wrote nothing; the repairs above
    // them wrote one, at the sequence the replay left.
    expect(loggedKeys(harness.storage)).toEqual([logKey(0, 9)]);
    expect(harness.internals.docSeq).toBe(9);
    const story = harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    expect(story.get("field_8")).toBe("8");
  });

  it("writes nothing for a cold build before its initial write lands", async () => {
    const events: string[] = [];
    const harness = makeDo({ base: [cold(0)], rows: ONE_STORY }, {}, [], events);

    await harness.internals.ensureDocLoaded();

    // The build and its repairs ran under suppression, and the initial blob is
    // what opens the log: the first record is the next transaction's.
    expect(loggedKeys(harness.storage)).toEqual([]);
    expect(harness.internals.docSeq).toBe(0);
    harness.internals.ydoc.transact(() => {
      harness.internals.ydoc.getMap<unknown>("config").set("skip_stories", true);
    }, null);
    expect(loggedKeys(harness.storage)).toEqual([logKey(0, 1)]);
  });

  it("writes nothing for a reset's rebuild before its replacement lands", async () => {
    const harness = await stagedResetHarness();

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    // The rebuild and its repairs ran under suppression, so the replacement's
    // own sequence 0 is what the first record after it extends.
    expect(loggedKeys(harness.storage)).toEqual([]);
    expect(harness.internals.docSeq).toBe(0);
    harness.internals.ydoc.transact(() => {
      harness.internals.ydoc.getMap<unknown>("config").set("skip_stories", true);
    }, null);
    expect(loggedKeys(harness.storage)).toEqual([logKey(1, 1)]);
  });

  it("writes nothing under a halt", async () => {
    const harness = await haltedByEnforcement();
    harness.storage.putBatches.length = 0;
    const held = harness.internals.docSeq;

    harness.internals.ydoc.transact(() => {
      harness.internals.ydoc.getMap<unknown>("config").set("skip_stories", true);
    }, null);

    expect(loggedKeys(harness.storage)).toEqual([]);
    expect(harness.internals.docSeq).toBe(held);
  });
});

describe("the sequence is seeded from the base and the tail together", () => {
  it.each([
    ["an empty tail", [] as number[], 6],
    ["a tail entirely below the base", [2, 3, 4], 6],
    ["a tail above the base", [6, 7, 8], 9],
  ])("writes its first record at the next free sequence with %s", async (_label, tail, expected) => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 5, 4)], rows: ONE_STORY });
    for (const seq of tail) {
      plantRecord(harness.storage, 0, seq, fieldRecord(`field_${seq}`, String(seq)));
    }

    await harness.internals.ensureDocLoaded();

    expect(loggedKeys(harness.storage)).toEqual([logKey(0, expected)]);
    expect(harness.internals.docSeq).toBe(expected);
    const story = harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    // A record below the base is not applied; one above it is, and the seeding
    // never skips it.
    expect(story.get("field_4")).toBeUndefined();
    if (tail.includes(8)) expect(story.get("field_8")).toBe("8");
  });
});

/**
 * Take this instance's storage access away, and no other's.
 *
 * The seam is instance-scoped on purpose: the revived instance below shares the
 * same store, and a global failure would be a claim about the object rather than
 * about the invocation the platform replaced.
 */
function invalidateStorage(internals: Internals): void {
  const ctx = internals.ctx as Record<string, unknown> & { storage: FakeStorage };
  const gone = new Proxy(ctx.storage, {
    get(target, prop, receiver) {
      if (prop === "get" || prop === "put" || prop === "list" || prop === "delete") {
        return () =>
          Promise.reject(new Error("Durable Object reset because its code was updated"));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  internals.ctx = { ...ctx, storage: gone };
}

describe("the window the DO ingest closes, in the unit harness", () => {
  it("serves the INSERT's row id from the log after an eviction, and refuses the late blob write", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    let reached!: () => void;
    const held = heldPut();
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    let holds = 0;
    const harness = makeDo(
      {
        // The live row, so the fenced write evaluates against the revision as
        // the real statement would.
        row: tagged(BASE_A, 0, 0, 4),
        rows: ONE_STORY,
        lastRowId: 99,
        holdRun: (sql) => {
          if (!/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)) {
            return undefined;
          }
          holds += 1;
          if (holds > 1) return undefined;
          reached();
          return held.gate;
        },
      },
      {},
      [editor],
      events,
    );
    await harness.ctx.lastGate;
    await harness.internals.ensureDocLoaded();
    await settle();

    // A client creates a story the snapshot has to INSERT.
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(harness.internals.ydoc));
    const before = Y.encodeStateVector(client);
    client.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("story_id", "fresh");
      story.set("title", new Y.Text("Fresh"));
      story.set("order_key", "d0");
      client.getArray<Y.Map<unknown>>("stories").push([story]);
    });
    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, Y.encodeStateAsUpdate(client, before)),
    );
    const payloadSeq = harness.internals.docSeq as number;

    // The snapshot runs to its INSERT and its backfill, and is held before the
    // blob write's statement executes.
    const pending = harness.internals.doSnapshot();
    await arrived;
    const backfillSeq = harness.internals.docSeq as number;
    expect(backfillSeq).toBe(payloadSeq + 1);
    expect(loggedKeys(harness.storage)).toContain(logKey(0, payloadSeq));
    expect(loggedKeys(harness.storage)).toContain(logKey(0, backfillSeq));

    // A fresh instance over the same storage: base plus log, and nothing else.
    const woken = await reviveOn(harness);
    await woken.internals.ensureDocLoaded();
    const served = woken.internals.ydoc.getArray<Y.Map<unknown>>("stories").toArray()
      .find((m) => m.get("story_id") === "fresh");
    expect(served).toBeDefined();
    expect(served?.get("_id")).toBe(99);

    // Only the old instance loses its storage, and only then is its statement
    // released: the row it wrote to has passed to the instance above.
    invalidateStorage(harness.internals);
    held.release();
    await expect(pending).rejects.toBeInstanceOf(ExactBaseError);

    // The late write landed zero rows and re-acquisition could not prove
    // ownership, so the refusal is marker-less and nothing followed it.
    expect(harness.storage.kv.has(haltKey(0))).toBe(false);
    expect(harness.internals.persistenceHalted).toBeNull();
    expect(harness.db.batchCalls()).toBe(0);
    expect(editor.closes).toEqual([]);
    expect(woken.internals.docLoaded).toBe(true);
  });
});

describe("the group's issue sits inside the continuation the fence opens", () => {
  it("issues the group between the second fence and the drain, with no await between", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor);
    const order: string[] = [];
    const realFence = harness.internals.socketMayReachDocument.bind(harness.internals);
    let fences = 0;
    harness.internals.socketMayReachDocument = (ws: unknown) => {
      const generation = realFence(ws);
      fences += 1;
      const nth = fences;
      order.push(`fence:${nth}`);
      void Promise.resolve().then(() => order.push(`microtask:${nth}`));
      return generation;
    };
    const realDrain = harness.internals.drainStagedEffects.bind(harness.internals);
    harness.internals.drainStagedEffects = () => {
      order.push("drain");
      return realDrain();
    };
    harness.storage.arm({
      holdPut: (keys) => {
        if (keys[0].startsWith("log:")) order.push("group");
        return undefined;
      },
    });

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, titleEdit(BASE_A, "new ")),
    );

    // The second fence, the group's issue and the drain are one synchronous
    // stretch: the microtask the fence queued runs only after all three.
    expect(order.indexOf("fence:2")).toBeLessThan(order.indexOf("group"));
    expect(order.indexOf("group")).toBeLessThan(order.indexOf("drain"));
    expect(order.indexOf("drain")).toBeLessThan(order.indexOf("microtask:2"));
  });
});

// ---------------------------------------------------------------------------
// The log retired below the row's sequence, after the header, after the write
// ---------------------------------------------------------------------------

/** Keys one bounded retirement may delete, the page it asks for, its listings. */
const RETIREMENT_BUDGET = 1_024;
const RETIREMENT_PAGE = 128;
const RETIREMENT_LISTS = 8;

/** A record that removes the story the base carries, so the delete set moves. */
function deletionRecord(): Uint8Array {
  return recordBytes(BASE_A, (doc) => {
    doc.getArray<Y.Map<unknown>>("stories").delete(0, 1);
  });
}

/**
 * A record whose dependency is never written, so a reader holds it pending.
 *
 * This fixture exercises an unresolved dependency; the explicit pending-state
 * check makes that state visible beside the encoded-state equality, so a
 * replay that dropped the record and one that held it cannot read alike.
 */
function pendingDependencyRecord(): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, BASE_A);
  doc.transact(() => {
    const story = new Y.Map<unknown>();
    story.set("story_id", "s99");
    doc.getArray<Y.Map<unknown>>("stories").push([story]);
  }, null);
  const between = Y.encodeStateVector(doc);
  doc.transact(() => {
    doc.getArray<Y.Map<unknown>>("stories").get(1).set("byline", "depends on the record before");
  }, null);
  return Y.encodeStateAsUpdate(doc, between);
}

/**
 * Everything a load applied before it reached its repairs.
 *
 * The repairs write into the document themselves, so what the replay produced
 * can be read only at the boundary in front of them. The WHOLE boundary is
 * returned rather than a prefix of the trace: a record the replay should have
 * excluded lands inside it and moves the comparison.
 */
function boundaryAtRepairs(internals: Internals, applied: Uint8Array[]): () => Uint8Array[] {
  let cut = -1;
  const repairs = internals.runPostLoadRepairs.bind(internals);
  internals.runPostLoadRepairs = async () => {
    if (cut < 0) cut = applied.length;
    await repairs();
  };
  return () => {
    expect(cut).toBeGreaterThanOrEqual(0);
    return applied.slice(0, cut);
  };
}

/** A document with the given updates applied to it in order. */
function documentOf(updates: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

/** Bytes small enough to be one inline record, and distinguishable by sequence. */
function junk(seq: number): Uint8Array {
  return new Uint8Array([seq & 0xff, (seq >> 8) & 0xff, 1, 2]);
}

/** Every key a generation's log holds, in key order. */
function logKeysOf(storage: FakeStorage, generation = 0): string[] {
  return [...storage.kv.keys()]
    .filter((key) => key.startsWith(logPrefix(generation)))
    .sort(byteCompare);
}

/** The deletions that carried a log key of one generation, in order. */
function logDeletes(storage: FakeStorage, generation = 0): string[][] {
  return storage.deleteBatches.filter(
    (batch) => batch.some((key) => key.startsWith(logPrefix(generation))),
  );
}

/** The listings issued under one generation's log prefix, in order. */
function logLists(storage: FakeStorage, generation = 0): LogListOptions[] {
  return storage.lists.filter((options) => options.prefix === logPrefix(generation));
}

/**
 * The retirement's own listings under a generation's log prefix: a retirement
 * lists a page, while the alarm's cleanup probe lists one key to ask whether
 * an eligible range holds, and is not a retirement listing.
 */
function retirementLists(storage: FakeStorage, generation = 0): LogListOptions[] {
  return logLists(storage, generation).filter((options) => options.limit !== 1);
}

/**
 * The ordered record with each deletion named by what it carried.
 *
 * The fake pushes one `delete` event and one batch per call, in the same order,
 * so the two lists are read together: a bare `delete` says a deletion happened
 * and nothing about which one.
 */
function retirementRecord(harness: { events: string[]; storage: FakeStorage }): string[] {
  let nth = 0;
  return harness.events
    .map((event) => {
      if (event !== "delete") return event;
      const batch = harness.storage.deleteBatches[nth++] ?? [];
      return batch.some((key) => key.startsWith("log:")) ? "delete:log" : "delete:base";
    })
    .filter((event) =>
      event === "delete:log" ||
      event === "delete:base" ||
      event === "batch" ||
      /^run:UPDATE projects SET yjs_state/.test(event));
}

/**
 * An opened instance over a live row, holding the records a test planted and
 * standing at the sequence its next snapshot will encode and write.
 *
 * The sequence is set rather than reached, because what the retirement turns on
 * is the pair the row is written with, and driving the document to an arbitrary
 * sequence would prove the driver rather than the retirement.
 */
async function retirementHarness(
  seq: number,
  planted: number[],
  storageOpts: StorageOptions = {},
  db: Partial<DbScript> = {},
  events: string[] = [],
) {
  const harness = makeDo({ row: tagged(BASE_A, 0, 0, 4), rows: ONE_STORY, ...db }, {}, [], events);
  await harness.internals.ensureDocLoaded();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const at of planted) plantRecord(harness.storage, 0, at, junk(at));
  harness.internals.docSeq = seq;
  harness.storage.arm(storageOpts);
  harness.storage.putBatches.length = 0;
  harness.storage.deleteBatches.length = 0;
  harness.storage.lists.length = 0;
  harness.storage.alarms.length = 0;
  harness.storage.disarmAlarm();
  harness.db.clear();
  events.length = 0;
  return harness;
}

describe("a landed blob write retires the log at or below the sequence it carried", () => {
  it("deletes exactly the eligible keys in one batch, and keeps every key above them", async () => {
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5, 6, 7]);

    await harness.internals.doSnapshot();

    expect(logDeletes(harness.storage)).toEqual([
      [1, 2, 3, 4, 5].map((seq) => logKey(0, seq)),
    ]);
    expect(logKeysOf(harness.storage)).toEqual([logKey(0, 6), logKey(0, 7)]);
  });

  it("writes the row, retires the header, retires the log, then issues the entity batch", async () => {
    const events: string[] = [];
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5, 6, 7], {}, {}, events);

    await harness.internals.doSnapshot();

    expect(retirementRecord(harness)).toEqual([
      "run:UPDATE projects SET yjs_state = ?,",
      "delete:base",
      "delete:log",
      "batch",
    ]);
  });

  it("lists the exact prefix with the bound one sequence above the row's", async () => {
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5, 6, 7]);

    await harness.internals.doSnapshot();

    expect(logLists(harness.storage)).toEqual([
      {
        prefix: logPrefix(0),
        start: undefined,
        startAfter: undefined,
        end: logKey(0, 6),
        limit: RETIREMENT_PAGE,
        reverse: undefined,
      },
    ]);
  });

  it("lists the prefix with no bound at the top of the domain, and takes the record's parts with it", async () => {
    const harness = await retirementHarness(MAX_SEQ, []);
    for (const [key, value] of Object.entries(
      encodeRecord(logKey(0, MAX_SEQ), junk(9), { partLimit: 2 }),
    )) {
      harness.storage.kv.set(key, value);
    }
    const top = logKeysOf(harness.storage).filter((key) => key.startsWith(logKey(0, MAX_SEQ)));
    expect(top).toHaveLength(3);

    await harness.internals.doSnapshot();

    expect(logLists(harness.storage)[0].end).toBeUndefined();
    expect(logLists(harness.storage)[0].prefix).toBe(logPrefix(0));
    // The whole prefix is eligible at the top of the domain, the record's parts
    // with it.
    expect(logKeysOf(harness.storage)).toEqual([]);
  });

  it("starts no later listing, deletion or batch, and answers nothing, while a page is held", async () => {
    const gate = heldBatch();
    // More than one page of eligible keys, so a sweep that did not await its
    // deletion would have a SECOND listing to show for it: an answer that waits
    // says only that the route awaited, not that the pages are ordered.
    const eligible = RETIREMENT_PAGE + 40;
    const harness = await retirementHarness(
      eligible,
      Array.from({ length: eligible + 1 }, (_v, index) => index + 1),
      { holdDelete: (keys) => (keys[0].startsWith(logPrefix(0)) ? gate.hold() : undefined) },
    );
    let settled = false;

    const answer = harness.doInstance
      .fetch(await signedRequest("/snapshot", "snapshot"))
      .then((response) => { settled = true; return response; });
    await gate.issued;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toBe(false);
    expect(logLists(harness.storage)).toHaveLength(1);
    expect(logDeletes(harness.storage)).toHaveLength(1);
    expect(harness.db.batchCalls()).toBe(0);
    expect(logKeysOf(harness.storage)).toHaveLength(eligible + 1);

    gate.release();
    expect((await answer).status).toBe(200);
    expect(logLists(harness.storage)).toHaveLength(2);
    expect(harness.db.batchCalls()).toBe(1);
    expect(logKeysOf(harness.storage)).toEqual([logKey(0, eligible + 1)]);
  });

  it("retires the header before the first log deletion when the load kept it", async () => {
    // A storage base ABOVE the row's sequence: the loader serves the base and
    // leaves its header standing, so the snapshot is what retires it.
    const harness = makeDo({ row: tagged(BASE_A, 0, 0, 4), rows: ONE_STORY });
    plantBase(harness.storage, 0, 3, BASE_STORAGE);
    await harness.internals.ensureDocLoaded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const at of [1, 2, 3, 4, 5]) plantRecord(harness.storage, 0, at, junk(at));
    harness.internals.docSeq = 5;
    harness.storage.deleteBatches.length = 0;

    await harness.internals.doSnapshot();

    expect(harness.storage.deleteBatches[0]).toEqual([baseKey(0)]);
    expect(harness.storage.deleteBatches[1]).toEqual(
      [1, 2, 3, 4, 5].map((seq) => logKey(0, seq)),
    );
    expect(harness.storage.kv.has(baseKey(0))).toBe(false);
  });

  it("retires the same on an adopted write", async () => {
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5, 6], {}, {
      base: [tagged(BASE_A, 0, 0, 4)],
      row: undefined,
      // The row one revision above the held one, under this write's own tags:
      // it landed and its acknowledgement was lost.
      reacquire: [{ yjs_generation: 0, yjs_seq: 5, yjs_write: 6 } as BaseRowShape],
      run: (sql) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    });

    await harness.internals.doSnapshot();

    expect(logKeysOf(harness.storage)).toEqual([logKey(0, 6)]);
  });

  it.each([
    ["a zero-row write the row has not moved under", {
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 5 } as BaseRowShape],
      run: (sql: string) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    }],
    ["an aborted write", {
      reacquire: [{ yjs_generation: 0, yjs_seq: 0, yjs_write: 5 } as BaseRowShape],
      run: (sql: string) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { throws: new Error("D1_ERROR: the write was aborted") }
        : undefined),
    }],
    ["an unresolved write", {
      reacquire: [{ throws: new Error("D1_ERROR: the row could not be read") }],
      run: (sql: string) => (/^UPDATE projects SET yjs_state = \?, yjs_generation = \?, yjs_seq = \?/.test(sql)
        ? { changes: 0 }
        : undefined),
    }],
  ])("issues no log listing and no log deletion for %s", async (_label, db) => {
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5, 6], {}, {
      base: [tagged(BASE_A, 0, 0, 4)],
      row: undefined,
      ...(db as Partial<DbScript>),
    });

    await expect(harness.internals.doSnapshot()).rejects.toBeDefined();

    expect(logLists(harness.storage)).toHaveLength(0);
    expect(logDeletes(harness.storage)).toHaveLength(0);
    expect(logKeysOf(harness.storage)).toHaveLength(6);
  });

  it("touches no other generation, no base part and no halt marker", async () => {
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5]);
    plantRecord(harness.storage, 1, 1, junk(1));
    plantMarker(harness.storage, 1, "enforcement_failed");
    harness.storage.kv.set(`${baseKey(0)}:0001`, new Uint8Array([1]));

    await harness.internals.doSnapshot();

    expect(harness.storage.kv.has(logKey(1, 1))).toBe(true);
    expect(harness.storage.kv.has(haltKey(1))).toBe(true);
    expect(harness.storage.kv.has(`${baseKey(0)}:0001`)).toBe(true);
    for (const listed of harness.storage.lists) expect(listed.prefix).toBe(logPrefix(0));
    for (const batch of logDeletes(harness.storage)) {
      for (const key of batch) expect(key.startsWith(logPrefix(0))).toBe(true);
    }
  });

  it("deletes a malformed key below the bound and keeps one above it", async () => {
    const below = `${logKey(0, 3)}-not-a-part`;
    const above = `${logKey(0, 9)}-not-a-part`;
    const harness = await retirementHarness(5, [1, 2]);
    harness.storage.kv.set(below, new Uint8Array([1]));
    harness.storage.kv.set(above, new Uint8Array([1]));

    await harness.internals.doSnapshot();

    expect(harness.storage.kv.has(below)).toBe(false);
    expect(harness.storage.kv.has(above)).toBe(true);
  });

  it("keeps a record a standalone transaction wrote after the sequence was captured", async () => {
    const gate = heldBatch();
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5], {}, {
      holdRun: (sql) => (/^UPDATE projects SET yjs_state/.test(sql) ? gate.hold() : undefined),
    });

    const snapshot = harness.internals.doSnapshot();
    await gate.issued;
    harness.internals.ydoc.transact(() => {
      harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0).set("byline", "later");
    }, null);
    // Above the captured sequence, so the retirement's bound is below it.
    expect(harness.internals.docSeq).toBe(6);
    gate.release();
    await snapshot;

    expect(logKeysOf(harness.storage)).toEqual([logKey(0, 6)]);

    const woken = await reviveOn(harness);
    await woken.internals.ensureDocLoaded();
    expect(woken.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("byline"))
      .toBe("later");
  });
});

describe("the retirement is bounded, and says whether it finished", () => {
  /** An unopened instance over a log a test planted into. */
  function budgetHarness(count: number, storageOpts: StorageOptions = {}) {
    const harness = makeDo({ row: tagged(BASE_A, 0, 0, 4) }, storageOpts);
    for (let seq = 1; seq <= count; seq++) plantRecord(harness.storage, 0, seq, junk(seq));
    return harness;
  }

  it("deletes a budget's worth in pages of the batch limit, and comes back for the rest", async () => {
    const harness = budgetHarness(1_500);

    const first = await harness.internals.retireLogBelow(0, 1_500);

    expect(first).toEqual({
      outcome: "exhausted",
      deleted: RETIREMENT_BUDGET,
      // The counts the diagnostic reads: the listings issued, the deletions
      // attempted, and the range the sweep reached.
      lists: 8,
      deleteCalls: 8,
      firstDeleted: logKey(0, 1),
      lastDeleted: logKey(0, RETIREMENT_BUDGET),
    });
    expect(harness.storage.deleteBatches.map((batch) => batch.length))
      .toEqual(Array.from({ length: 8 }, () => RETIREMENT_PAGE));
    expect(harness.storage.lists).toHaveLength(8);
    expect(logKeysOf(harness.storage)).toHaveLength(1_500 - RETIREMENT_BUDGET);

    const second = await harness.internals.retireLogBelow(0, 1_500);

    expect(second).toMatchObject({
      outcome: "complete",
      deleted: 1_500 - RETIREMENT_BUDGET,
    });
    expect(logKeysOf(harness.storage)).toEqual([]);
  });

  it("leaves a budget's exact worth unproved, and proves it on the next call", async () => {
    const harness = budgetHarness(RETIREMENT_BUDGET);

    expect(await harness.internals.retireLogBelow(0, RETIREMENT_BUDGET))
      .toMatchObject({ outcome: "exhausted", deleted: RETIREMENT_BUDGET });
    expect(logKeysOf(harness.storage)).toEqual([]);
    expect(await harness.internals.retireLogBelow(0, RETIREMENT_BUDGET))
      .toMatchObject({ outcome: "complete", deleted: 0, firstDeleted: null });
  });

  it("leaves the key past the budget for the next call", async () => {
    const harness = budgetHarness(RETIREMENT_BUDGET + 1);

    expect(await harness.internals.retireLogBelow(0, RETIREMENT_BUDGET + 1))
      .toMatchObject({ outcome: "exhausted", deleted: RETIREMENT_BUDGET });
    expect(await harness.internals.retireLogBelow(0, RETIREMENT_BUDGET + 1))
      .toMatchObject({ outcome: "complete", deleted: 1 });
    expect(logKeysOf(harness.storage)).toEqual([]);
  });

  it("stops at a rejected listing, keeping the pages it had already deleted", async () => {
    const harness = budgetHarness(200, {
      failOn: (kind, nth) => (kind === "list" && nth === 2 ? new Error("storage down") : undefined),
    });

    expect(await harness.internals.retireLogBelow(0, 200))
      .toMatchObject({ outcome: "rejected", deleted: RETIREMENT_PAGE, lists: 2 });
    expect(logKeysOf(harness.storage)).toHaveLength(200 - RETIREMENT_PAGE);
    expect(errors.filter((line) => line.includes("[persistence][retirement]"))).toHaveLength(1);
  });

  it("stops at a rejected deletion, keeps the page before it, and names it in one line", async () => {
    const harness = budgetHarness(300, {
      deleteFails: (_keys, nth) => (nth === 2 ? new Error("storage down") : undefined),
    });

    expect(await harness.internals.retireLogBelow(0, 300))
      // A rejection carries the deletions it ATTEMPTED beside the one that
      // resolved: the second call is the one that failed.
      .toMatchObject({ outcome: "rejected", deleted: RETIREMENT_PAGE, deleteCalls: 2 });
    expect(logKeysOf(harness.storage)).toHaveLength(300 - RETIREMENT_PAGE);

    // One line, carrying what a reader needs to find the tail it names: the
    // project, the generation, the sequence and what storage said.
    const lines = errors.filter((line) => line.includes("[persistence][retirement]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`project ${PROJECT_ID}`);
    expect(lines[0]).toContain("generation 0");
    expect(lines[0]).toContain("sequence 300");
    expect(lines[0]).toContain("storage down");
  });

  it("pages with startAfter and carries the bound on every page", async () => {
    const harness = budgetHarness(400);

    expect(await harness.internals.retireLogBelow(0, 300))
      .toMatchObject({ outcome: "complete", deleted: 300, lists: 3 });

    const listed = harness.storage.lists;
    expect(listed).toHaveLength(3);
    expect(listed.every((options) => options.end === logKey(0, 301))).toBe(true);
    expect(listed[0].startAfter).toBeUndefined();
    expect(listed[1].startAfter).toBe(logKey(0, RETIREMENT_PAGE));
    expect(listed[2].startAfter).toBe(logKey(0, RETIREMENT_PAGE * 2));
    expect(logKeysOf(harness.storage))
      .toEqual(Array.from({ length: 100 }, (_v, i) => logKey(0, 301 + i)));
  });
});

describe("a partly retired log never reads as a partly deleted record", () => {
  /**
   * Records of three keys each — a header and two parts — so a page of 128 and
   * a budget of 1,024 both fall INSIDE a record rather than between two.
   */
  function plantParted(storage: FakeStorage, seq: number, bytes: Uint8Array): void {
    for (const [key, value] of Object.entries(
      encodeRecord(logKey(0, seq), bytes, { partLimit: Math.ceil(bytes.length / 2) }),
    )) {
      storage.kv.set(key, value);
    }
  }

  /**
   * No batch removes a part while the header that names it still stands.
   *
   * Storage is reconstructed at every batch boundary from the keys the fixture
   * planted and the deletions the sweep issued, rather than read at the end:
   * a header the LAST batch removed is absent from the final map, so a final
   * reading passes a part deleted in batch 1 whose header only went in batch 2 —
   * exactly the state a reader would meet as a header naming keys that are
   * gone. A header deleted in the same batch as its parts is allowed, because a
   * batch applies atomically and no reader sees between its keys.
   */
  function assertHeaderFirst(planted: string[], batches: string[][]): void {
    const standing = new Set(planted);
    for (const batch of batches) {
      const inThisBatch = new Set(batch);
      for (const key of batch) {
        const header = key.replace(/:\d{4}$/, "");
        if (header === key) continue;
        expect(!standing.has(header) || inThisBatch.has(header)).toBe(true);
      }
      for (const key of batch) standing.delete(key);
    }
  }

  /**
   * A log of `below` parted records at or below the row's sequence and two
   * above it, over a row exact for `below`.
   */
  function partedHarness(below: number, storageOpts: StorageOptions = {}) {
    const harness = makeDo({ row: tagged(BASE_A, 0, below, 4), rows: ONE_STORY }, storageOpts);
    for (let seq = 1; seq <= below; seq++) plantParted(harness.storage, seq, junk(seq));
    return harness;
  }

  // A deletion and a record whose dependency was never written: the fixtures
  // exercise deletion and an unresolved dependency, and the explicit checks
  // make those states visible beside the encoded-state equality.
  const ABOVE = [deletionRecord(), pendingDependencyRecord()];

  it.each([
    ["a page boundary", 60, {
      failOn: (kind: string, nth: number) => (kind === "list" && nth === 2
        ? new Error("storage down")
        : undefined),
    }, "rejected"],
    ["the budget boundary", 400, {}, "exhausted"],
  ])("stops inside a record at %s, leaving parts a reader ignores", async (
    _label,
    below,
    storageOpts,
    outcome,
  ) => {
    const harness = partedHarness(below, storageOpts as StorageOptions);
    ABOVE.forEach((bytes, index) => plantParted(harness.storage, below + 1 + index, bytes));
    const planted = logKeysOf(harness.storage);

    const answer = await harness.internals.retireLogBelow(0, below);

    expect(answer.outcome).toBe(outcome);
    assertHeaderFirst(planted, logDeletes(harness.storage));
    // The stop fell inside a record: its header is gone and a part of it stands.
    const orphans = logKeysOf(harness.storage)
      .filter((key) => /:\d{4}$/.test(key) && !harness.storage.kv.has(key.replace(/:\d{4}$/, "")));
    expect(orphans.length).toBeGreaterThan(0);

    // A fresh load over the partial state, read at the boundary in front of the
    // repairs: the row's blob and the records above its sequence, and nothing
    // else — not the junk at or below it, and not an orphan part.
    const expected = documentOf([BASE_A, ...ABOVE]);
    const applied = traceApplies();
    const woken = await reviveOn(harness);
    const boundary = boundaryAtRepairs(woken.internals, applied);
    await woken.internals.ensureDocLoaded();

    expect(boundary()).toEqual([BASE_A, ...ABOVE]);
    const replayed = documentOf(boundary());
    expectSameDocument(replayed, expected);
    // And the fixtures are what they claim: the deletion took the story the
    // base carried, and the record after it is still waiting on one that was
    // never written.
    expect(titles(replayed)).toEqual([]);
    expect(replayed.store.pendingStructs).not.toBeNull();
  });
});

/**
 * The revision advance the guarded batch carries, applied to the live row.
 *
 * The fake records a batch's statements rather than executing them, so a
 * fixture that takes two consecutive snapshots carries the advance itself or
 * the second write meets a row a revision behind the instance that holds it.
 */
function batchAdvancesRow(harness: () => { db: { row: () => BaseRowShape | undefined } }) {
  return () => {
    const row = harness().db.row();
    if (row !== undefined) row.yjs_write = (row.yjs_write as number) + 1;
  };
}

describe("a refused log retirement leaves the snapshot's own outcome alone", () => {
  it("logs once, keeps what it could not reach, and still issues the entity batch", async () => {
    let batches = 0;
    let harness!: Awaited<ReturnType<typeof retirementHarness>>;
    harness = await retirementHarness(200, [], {
      deleteFails: (keys) => {
        if (!keys[0].startsWith(logPrefix(0))) return undefined;
        batches += 1;
        return batches === 2 ? new Error("storage down") : undefined;
      },
    }, { batch: batchAdvancesRow(() => harness) });
    for (let seq = 1; seq <= 200; seq++) plantRecord(harness.storage, 0, seq, junk(seq));

    const response = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));

    expect(response.status).toBe(200);
    expect(errors.filter((line) => line.includes("[persistence][retirement]"))).toHaveLength(1);
    expect(logKeysOf(harness.storage)).toHaveLength(200 - RETIREMENT_PAGE);
    expect(harness.db.batchCalls()).toBe(1);

    // The next landed write retires the rest, from the start.
    harness.storage.arm({});
    await harness.internals.doSnapshot();
    expect(logKeysOf(harness.storage)).toEqual([]);
  });

  it("counts only the current generation's retirement, with maintenance sweeping an old one in the same run", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events, { generation: 1 });
    const harness = makeDo(
      { row: tagged(BASE_A, 1, 0, 4), rows: ONE_STORY },
      {},
      [editor],
      events,
    );
    harness.storage.kv.set("docGeneration", 1);
    await harness.internals.ensureDocLoaded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Old-generation work for the maintenance half, whose deletions carry log
    // keys too: a failure matcher that counted them would fail the wrong batch.
    const old = plantGeneration(harness.storage, 0, 10);
    for (let seq = 1; seq <= 200; seq++) plantRecord(harness.storage, 1, seq, junk(seq));
    harness.internals.docSeq = 200;
    let batches = 0;
    harness.storage.arm({
      deleteFails: (keys) => {
        if (!keys[0].startsWith(logPrefix(1))) return undefined;
        batches += 1;
        return batches === 2 ? new Error("storage down") : undefined;
      },
    });

    await harness.internals.alarm();

    for (const key of old) expect(harness.storage.kv.has(key)).toBe(false);
    expect(logKeysOf(harness.storage, 1)).toHaveLength(200 - RETIREMENT_PAGE);
    expect(errors.filter((line) => line.includes("[persistence][retirement]"))).toHaveLength(1);
    expect(harness.db.batchCalls()).toBe(1);
  });

  it("spends a full budget on the maintenance slice and another on the retirement", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events, { generation: 1 });
    const spare = 200;
    const harness = makeDo(
      { row: tagged(BASE_A, 1, 0, 4), rows: ONE_STORY },
      {},
      [editor],
      events,
    );
    harness.storage.kv.set("docGeneration", 1);
    await harness.internals.ensureDocLoaded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // More than one budget of each kind, so a run that shared a budget between
    // the two halves would leave one of them short.
    const old = plantGeneration(harness.storage, 0, RETIREMENT_BUDGET + spare);
    const eligible = RETIREMENT_BUDGET + spare;
    for (let seq = 1; seq <= eligible; seq++) plantRecord(harness.storage, 1, seq, junk(seq));
    harness.internals.docSeq = eligible;
    harness.storage.lists.length = 0;
    harness.storage.deleteBatches.length = 0;
    const gates = harness.ctx.gates;

    await harness.internals.alarm();

    // Two budgets under one gate: the old generation's sweep spent one and the
    // current generation's retirement spent another, each stopping at 1,024
    // keys with the remainder for the next run.
    expect(old.filter((key) => harness.storage.kv.has(key))).toHaveLength(spare);
    expect(logKeysOf(harness.storage, 1)).toHaveLength(spare);
    expect(retirementLists(harness.storage, 1)).toHaveLength(RETIREMENT_LISTS);
    expect(harness.ctx.gates).toBe(gates + 1);
  });

  it("logs once and deletes nothing when the first listing is refused", async () => {
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5], {
      failOn: (kind) => (kind === "list" ? new Error("storage down") : undefined),
    });

    const response = await harness.doInstance.fetch(await signedRequest("/snapshot", "snapshot"));

    expect(response.status).toBe(200);
    expect(errors.filter((line) => line.includes("[persistence][retirement]"))).toHaveLength(1);
    expect(logDeletes(harness.storage)).toHaveLength(0);
    expect(logKeysOf(harness.storage)).toHaveLength(5);
  });

  /** The answer each caller already gives when a snapshot fails outright. */
  const HEADER_REFUSAL_ANSWERS = new Map<string, [number, string]>([
    ["/snapshot", [500, "snapshot_failed"]],
    ["/restore-orphans", [503, "snapshot_failed"]],
    ["/ingest-sync", [503, "snapshot_failed"]],
    ["/clear-course-markers", [503, "snapshot_blocked"]],
  ]);

  /** A loaded instance whose header deletion is refused on every attempt. */
  function refusedHeaderHarness() {
    return retirementHarness(5, [1, 2, 3, 4, 5], {
      deleteFails: (keys) => (keys.includes(baseKey(0)) ? new Error("storage down") : undefined),
    });
  }

  it.each(MUTATING_ROUTES)(
    "issues no log listing under a refused header deletion, and keeps %s's own answer",
    async (path, action, body) => {
      const harness = await refusedHeaderHarness();
      const [status, text] = HEADER_REFUSAL_ANSWERS.get(path)!;

      const response = await harness.doInstance.fetch(await signedRequest(path, action, body));

      expect([response.status, await response.text()]).toEqual([status, text]);
      expect(logLists(harness.storage)).toHaveLength(0);
      expect(logDeletes(harness.storage)).toHaveLength(0);
      expect(harness.db.batchCalls()).toBe(0);
      expect(errors.filter((line) => line.includes("[persistence][retirement]"))).toHaveLength(0);
    },
  );

  it("rethrows from the alarm under a refused header deletion, retiring nothing", async () => {
    const harness = await refusedHeaderHarness();
    // The alarm's snapshot half runs only for an object somebody is connected
    // to, so the socket is what makes this alarm reach a retirement at all.
    harness.sockets.push(fakeSocket([]));

    // Rethrown for the runtime's retry, which is the alarm's existing answer to
    // a snapshot that failed.
    await expect(harness.internals.alarm()).rejects.toThrow(/storage down/);

    expect(retirementLists(harness.storage)).toHaveLength(0);
    expect(logDeletes(harness.storage)).toHaveLength(0);
    expect(harness.db.batchCalls()).toBe(0);
    expect(logKeysOf(harness.storage)).toHaveLength(5);
    expect(errors.filter((line) => line.includes("[persistence][retirement]"))).toHaveLength(0);
  });
});

describe("the retirement stands whatever the entity batch after it does", () => {
  const OWED_STAMP = "2026-01-01T00:00:00.000Z";

  /**
   * Ledger debt for the batch to carry.
   *
   * An empty ledger cannot show the claim: a batch that settled nothing and one
   * that was never owed anything write the same statements, and the second
   * attempt's rebuild is only visible against work that was still standing.
   */
  function owedLedgers(internals: Internals): void {
    internals.editsByPath.set(
      "stories:11:title",
      new Map([[USER_ID, { first: OWED_STAMP, last: OWED_STAMP }]]),
    );
    internals.wordsByRow.set("stories", new Map([["11", new Map([[USER_ID, 5]])]]));
    internals.timeLedger.set(USER_ID, {
      pendingEditingMs: 60_000,
      pendingWritingMs: 30_000,
      lastChangeAt: OWED_STAMP,
      lastWriteAt: OWED_STAMP,
    });
  }

  it("keeps the row at p + 1 with the ledgers owed, and rebuilds them on the next snapshot", async () => {
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5, 6], {}, {
      batch: (_statements, nth) => {
        if (nth === 1) throw new Error("D1_ERROR: the batch was refused");
      },
    });
    const settled = harness.internals.settleEpoch;
    owedLedgers(harness.internals);

    await expect(harness.internals.doSnapshot()).rejects.toThrow(/refused/);

    // The blob write moved the row from the claimed p to p + 1, and the batch
    // that failed moved nothing: no settlement ran, and every ledger stands at
    // exactly the figure it was owed before the attempt.
    expect(logKeysOf(harness.storage)).toEqual([logKey(0, 6)]);
    expect(harness.db.row()?.yjs_write).toBe(6);
    expect(harness.internals.docWrite).toBe(6);
    expect(harness.internals.settleEpoch).toBe(settled);
    expect(harness.internals.timeLedger.get(USER_ID)).toEqual({
      pendingEditingMs: 60_000,
      pendingWritingMs: 30_000,
      lastChangeAt: OWED_STAMP,
      lastWriteAt: OWED_STAMP,
    });
    expect(harness.internals.wordsByRow.get("stories")?.get("11")?.get(USER_ID)).toBe(5);
    expect([...harness.internals.editsByPath.keys()]).toEqual(["stories:11:title"]);

    // An edit between the attempts, so the second blob cannot be the first
    // one's bytes and a retry of the captured work would show as a document
    // missing this.
    harness.internals.ydoc.transact(() => {
      harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0)
        .set("byline", "between the attempts");
    }, null);
    const captured = harness.internals.docSeq;
    harness.db.clear();

    await harness.internals.doSnapshot();

    // The second attempt's own blob, at the sequence it captured, under the
    // revision the first attempt's blob write left.
    const row = harness.db.row()!;
    expect(row.yjs_seq).toBe(captured);
    expect(row.yjs_write).toBe(7);
    const written = documentOf([row.yjs_state as Uint8Array]);
    expect(written.getArray<Y.Map<unknown>>("stories").get(0).get("byline"))
      .toBe("between the attempts");
    const guard = harness.db.mutations.filter((s) => /^INSERT INTO yjs_write_guard/.test(s.sql));
    expect(guard.map((s) => s.binds)).toEqual([[PROJECT_ID, 7]]);
    // The debt rebuilt, not the captured statements replayed: the figures are
    // the ones still standing in the ledger.
    const owed = harness.db.mutations.filter(
      (s) => /^INSERT INTO member_editing_time/.test(s.sql),
    );
    expect(owed.map((s) => s.binds)).toEqual([
      [PROJECT_ID, USER_ID, 60, 30, OWED_STAMP, OWED_STAMP],
    ]);
    expect(harness.db.batchCalls()).toBe(2);
    expect(harness.internals.settleEpoch).toBe(settled + 1);
  });
});

describe("a retirement an eviction interrupts is the next landed write's", () => {
  it("serves the row without the records it left, and retires them on the next write", async () => {
    const gate = heldBatch();
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5], {
      holdDelete: (keys) => (keys[0].startsWith("log:") ? gate.hold() : undefined),
    });
    // A deletion and a record waiting on one that was never written: the
    // fixtures exercise deletion and an unresolved dependency, and the explicit
    // checks make those states visible beside the encoded-state equality.
    const above = [deletionRecord(), pendingDependencyRecord()];
    above.forEach((bytes, index) => plantRecord(harness.storage, 0, 6 + index, bytes));

    const snapshot = harness.internals.doSnapshot();
    await gate.issued;
    // The instance goes away between the landed write and the deletion it
    // issued: what it had in flight reaches no successor's storage.
    harness.storage.invalidate();
    gate.release();
    await snapshot;

    expect(logKeysOf(harness.storage)).toHaveLength(7);
    const rowBlob = harness.db.row()?.yjs_state as Uint8Array;
    const expected = documentOf([rowBlob, ...above]);

    const applied = traceApplies();
    const woken = await reviveOn(harness);
    const boundary = boundaryAtRepairs(woken.internals, applied);
    await woken.internals.ensureDocLoaded();

    // The whole pre-repair boundary: the row's own blob, decoded on its own,
    // then the records above the sequence it is exact for — and no record at or
    // below it, which a prefix of the trace could not have refused.
    expect(boundary()).toEqual([rowBlob, ...above]);
    const replayed = documentOf(boundary());
    expectSameDocument(replayed, expected);
    expect(titles(replayed)).toEqual([]);
    expect(replayed.store.pendingStructs).not.toBeNull();

    await woken.internals.doSnapshot();

    expect(logKeysOf(woken.storage)).toEqual([]);
  });
});

describe("nothing else in the object retires a log record", () => {
  it("lists and deletes no log key under a halt", async () => {
    const harness = await retirementHarness(5, [1, 2, 3, 4, 5]);
    plantMarker(harness.storage, 0, "enforcement_failed");
    harness.internals.persistenceHalted = {
      generation: 0,
      marker: { reason: "enforcement_failed", at: Date.now() },
    };

    await harness.internals.alarm();

    expect(logLists(harness.storage)).toHaveLength(0);
    expect(logDeletes(harness.storage)).toHaveLength(0);
    expect(logKeysOf(harness.storage)).toHaveLength(5);
  });

  it("deletes only the staged header when a reset lands its replacement", async () => {
    const harness = await stagedResetHarness();
    plantRecord(harness.storage, 0, 1, junk(1));

    const response = await harness.doInstance.fetch(await signedRequest("/reset", "reset"));

    expect(response.status).toBe(200);
    expect(harness.storage.deleteBatches).toEqual([[baseKey(1)]]);
    expect(harness.storage.kv.has(logKey(0, 1))).toBe(true);
    // The retirement's own signature is a bounded listing under a generation's
    // log prefix, and the replacement's generation is never given one: the
    // replacement is written by `writeBaseRow`, not by the fenced path.
    expect(logLists(harness.storage, 1)).toHaveLength(0);
    expect(logLists(harness.storage, 0).filter((options) => options.end !== undefined))
      .toHaveLength(0);
  });

  it("lists and deletes no log key for a load that only loads", async () => {
    const harness = makeDo({ row: tagged(BASE_A, 0, 0, 4), rows: ONE_STORY });
    for (const at of [1, 2, 3]) {
      plantRecord(harness.storage, 0, at, fieldRecord("byline", `record ${at}`));
    }

    await harness.internals.ensureDocLoaded();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The whole inventory a load leaves: the replay's listings, which page with
    // `startAfter` and carry no bound, and not one deletion.
    expect(logDeletes(harness.storage)).toHaveLength(0);
    for (const at of [1, 2, 3]) expect(harness.storage.kv.has(logKey(0, at))).toBe(true);
    expect(logLists(harness.storage).filter((options) => options.end !== undefined))
      .toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The durable identity binding
// ---------------------------------------------------------------------------

/** The put batches that carried the identity key alone. */
function identityPuts(storage: FakeStorage): string[][] {
  return storage.putBatches.filter(
    (keys) => keys.length === 1 && keys[0] === PROJECT_ID_KEY,
  );
}

/** A signed-marker request, which is what the internal routes bind from. */
function markerRequest(projectId: number = PROJECT_ID): Request {
  return new Request("https://internal/marker", {
    headers: { "X-Internal-Project": String(projectId) },
  });
}

/** The lines the identity path states, and the ones the cleanup derivation does. */
function identityLines(): string[] {
  return errors.filter((line) => line.includes("[persistence][identity]"));
}

function cleanupLines(): string[] {
  return errors.filter((line) => line.includes("[persistence][cleanup]"));
}

function cleanupUnknownLines(): string[] {
  return errors.filter((line) => line.includes("[persistence][cleanup-unknown]"));
}

describe("the object keeps its project in memory and at one storage key", () => {
  it("binds from the marker route, once, and re-binding the same id puts nothing", async () => {
    const harness = makeDo({}, {}, [], [], false);

    expect(await harness.internals.bindProjectIdFromMarker(markerRequest())).toBeNull();
    expect(await harness.internals.bindProjectIdFromMarker(markerRequest())).toBeNull();

    expect(harness.internals.projectId).toBe(PROJECT_ID);
    expect(harness.storage.kv.get(PROJECT_ID_KEY)).toBe(PROJECT_ID);
    expect(identityPuts(harness.storage)).toHaveLength(1);
  });

  it("binds from a socket admission", async () => {
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY }, {}, [], [], false);

    await upgrade(harness);

    expect(harness.storage.kv.get(PROJECT_ID_KEY)).toBe(PROJECT_ID);
    expect(identityPuts(harness.storage)).toHaveLength(1);
  });

  it("binds from a socket attachment the constructor woke with", async () => {
    const harness = makeDo(
      { base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY },
      {},
      [fakeSocket([])],
      [],
      false,
    );

    await harness.ctx.lastGate;
    await settle(2);

    expect(harness.internals.projectId).toBe(PROJECT_ID);
    expect(harness.storage.kv.get(PROJECT_ID_KEY)).toBe(PROJECT_ID);
  });

  it("leaves the binding unmade when the put fails, and the next path retries it", async () => {
    const harness = makeDo(
      {},
      { putFails: (keys) => (keys[0] === PROJECT_ID_KEY ? new Error("storage down") : undefined) },
      [],
      [],
      false,
    );

    await harness.internals.bindProjectIdFromMarker(markerRequest());

    expect(harness.internals.projectId).toBe(PROJECT_ID);
    expect(harness.internals.identityBound).toBeNull();
    expect(harness.storage.kv.has(PROJECT_ID_KEY)).toBe(false);
    expect(identityLines()).toHaveLength(1);

    harness.storage.arm({});
    await harness.internals.bindProjectIdFromMarker(markerRequest());

    expect(harness.internals.identityBound).toBe(PROJECT_ID);
    expect(harness.storage.kv.get(PROJECT_ID_KEY)).toBe(PROJECT_ID);
  });

  it("retries the failed put from the preflight, and withholds the row until it lands", async () => {
    const events: string[] = [];
    const harness = makeDo(
      { row: tagged(BASE_A, 0, 0, 4), rows: ONE_STORY },
      {},
      [],
      events,
      false,
    );
    await harness.internals.bindProjectIdFromMarker(markerRequest());
    harness.internals.identityBound = null;
    harness.storage.kv.delete(PROJECT_ID_KEY);
    harness.storage.arm({
      putFails: (keys) => (keys[0] === PROJECT_ID_KEY ? new Error("storage down") : undefined),
    });
    events.length = 0;

    await harness.internals.alarm();

    // The put was attempted and refused, so the row is not consulted at all.
    expect(harness.internals.identityBound).toBeNull();
    expect(events.filter((e) => e === "read-metadata")).toEqual([]);

    harness.storage.arm({});
    events.length = 0;
    await harness.internals.alarm();

    expect(harness.internals.identityBound).toBe(PROJECT_ID);
    expect(events.filter((e) => e === "read-metadata")).toHaveLength(1);
  });

  it("refuses zero and a malformed stored value alike, and says so once", async () => {
    const zero = makeDo({}, {}, [], [], false);
    const refusal = await zero.internals.bindProjectIdFromMarker(markerRequest(0));
    expect(refusal?.status).toBe(400);
    expect(zero.storage.kv.has(PROJECT_ID_KEY)).toBe(false);

    const woken = makeDo({}, {}, [], [], false);
    woken.storage.kv.set(PROJECT_ID_KEY, 0);
    await woken.internals.alarm();
    await woken.internals.alarm();

    expect(woken.internals.projectId).toBeNull();
    expect(identityLines()).toHaveLength(1);

    const malformed = makeDo({}, {}, [], [], false);
    malformed.storage.kv.set(PROJECT_ID_KEY, "forty-two");
    await malformed.internals.alarm();

    expect(malformed.internals.projectId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The accounting: the logical replay tail above the exact base
// ---------------------------------------------------------------------------

/** What the instance says the tail above its base holds. */
function accounting(internals: Internals): {
  base: number | null;
  records: number;
  bytes: number;
  seqs: number[];
} {
  return {
    base: internals.baseSeq,
    records: (internals.docSeq ?? 0) - (internals.baseSeq ?? 0),
    bytes: internals.logBytesSinceBase,
    seqs: internals.logBytes.map((record) => record.seq),
  };
}

/**
 * The document and the accounting at the one boundary where they are the base
 * and its replayed tail and nothing else.
 *
 * `backfillBlobGaps` is the first thing the stored path runs after the replay,
 * and the repairs it and `runPostLoadRepairs` make are real transactions: each
 * is a record of its own, so a comparison or a byte total taken after them is
 * not the tail's. The hook reads `internals` at call time, so a document a
 * contention retry replaced is the one recorded.
 */
function captureAtRepairBoundary(internals: Internals): {
  snapshot: Y.Snapshot | null;
  bytes: number;
  seqs: number[];
  base: number | null;
} {
  const captured = {
    snapshot: null as Y.Snapshot | null,
    bytes: -1,
    seqs: [] as number[],
    base: null as number | null,
  };
  const hooked = internals as unknown as { backfillBlobGaps: () => Promise<void> };
  const original = hooked.backfillBlobGaps;
  hooked.backfillBlobGaps = async function (this: unknown) {
    captured.snapshot = Y.snapshot(internals.ydoc);
    captured.bytes = internals.logBytesSinceBase;
    captured.seqs = internals.logBytes.map((record) => record.seq);
    captured.base = internals.baseSeq;
    return original.call(this);
  };
  return captured;
}

/**
 * Every `baseSeq` the accounting held at a call to count a record, in order.
 *
 * The floor has to be set before anything is counted against it, and only an
 * observation taken AT each count says so: a floor opened after the replay
 * leaves the same value behind by the time a test could read it.
 */
function floorsWhileCounting(internals: Internals): Array<number | null> {
  const seen: Array<number | null> = [];
  const original = internals.noteRecordWritten.bind(internals);
  internals.noteRecordWritten = (seq: number, bytes: number) => {
    seen.push(internals.baseSeq);
    original(seq, bytes);
  };
  return seen;
}

/** An instance opened over a base at (0, 5) with four records replayed above it. */
async function replayedTail(events: string[] = []) {
  const harness = makeDo(
    { base: [tagged(BASE_A, 0, 5, 4)], rows: ONE_STORY },
    {},
    [],
    events,
  );
  const planted: Uint8Array[] = [];
  for (let seq = 6; seq <= 9; seq++) {
    const bytes = fieldRecord(`replayed_${seq}`, String(seq));
    planted.push(bytes);
    plantRecord(harness.storage, 0, seq, bytes);
  }
  const boundary = captureAtRepairBoundary(harness.internals);
  await harness.internals.ensureDocLoaded();
  await settle(2);
  return { harness, planted, boundary };
}

describe("the accounting describes the replay tail above the exact base", () => {
  it("counts the records the replay applied and the payload bytes they carried", async () => {
    const { planted, boundary } = await replayedTail();

    // Read at the boundary the replay ends on, so the total is the tail's own
    // and not the tail's plus whatever the load's repairs wrote above it.
    expect(boundary.base).toBe(5);
    expect(boundary.seqs).toEqual([6, 7, 8, 9]);
    expect(boundary.bytes).toBe(planted.reduce((sum, bytes) => sum + bytes.length, 0));
  });

  it("holds the floor at every count, on all three opening paths", async () => {
    const stored = makeDo({ base: [tagged(BASE_A, 0, 5, 4)], rows: ONE_STORY });
    plantRecord(stored.storage, 0, 6, fieldRecord("replayed", "six"));
    const storedFloors = floorsWhileCounting(stored.internals);
    await stored.internals.ensureDocLoaded();
    await settle(2);
    addUnsavedStory(stored.internals);

    expect(storedFloors.length).toBeGreaterThan(0);
    expect([...new Set(storedFloors)]).toEqual([5]);

    const built = makeDo({ base: [cold(4)], rows: ONE_STORY });
    const builtFloors = floorsWhileCounting(built.internals);
    await built.internals.ensureDocLoaded();
    await settle(2);
    addUnsavedStory(built.internals);

    expect(builtFloors.length).toBeGreaterThan(0);
    expect([...new Set(builtFloors)]).toEqual([0]);

    const replaced = await stagedResetHarness({ rows: { ...ONE_STORY, ...storedStamps() } });
    const replacedFloors = floorsWhileCounting(replaced.internals);
    expect((await replaced.doInstance.fetch(await signedRequest("/reset", "reset"))).status)
      .toBe(200);
    addUnsavedStory(replaced.internals);

    expect(replacedFloors.length).toBeGreaterThan(0);
    expect([...new Set(replacedFloors)]).toEqual([0]);
  });

  it("advances on a standalone record once its group is issued, and not when it fails", async () => {
    const harness = await loaded();
    const before = accounting(harness.internals);

    addUnsavedStory(harness.internals);

    const after = accounting(harness.internals);
    expect(after.records).toBe(before.records + 1);
    expect(after.bytes).toBeGreaterThan(before.bytes);

    harness.storage.arm(LOG_PUT_THROWS);
    addUnsavedStory(harness.internals, "refused");

    expect(accounting(harness.internals).records).toBe(after.records);
    expect(accounting(harness.internals).bytes).toBe(after.bytes);
  });

  it("advances on a message's group by the exact bytes each of its records carried", async () => {
    const events: string[] = [];
    const editor = fakeSocket(events);
    const harness = await loaded({}, {}, [], events);
    harness.sockets.push(editor);
    // A formatting run overlapping one the server already applied: Yjs's own
    // cleanup removes the redundant marker in a transaction of its own, so the
    // group carries two records rather than one.
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(harness.internals.ydoc));
    const before = Y.encodeStateVector(client);
    client.transact(() => {
      (client.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text)
        .format(0, 5, { bold: true });
    });
    const payload = Y.encodeStateAsUpdate(client, before);
    harness.internals.ydoc.transact(() => {
      (harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text)
        .format(0, 3, { bold: true });
    }, null);
    await settle();
    const held = harness.internals.docSeq as number;
    harness.internals.baseSeq = held;
    harness.internals.logBytes = [];
    harness.internals.logBytesSinceBase = 0;
    harness.storage.putBatches.length = 0;

    await harness.internals.webSocketMessage(
      editor,
      syncMessage(syncProtocol.messageYjsUpdate, payload),
    );

    // The entries are compared against the payloads the group actually issued,
    // read back through the codec that wrote them: a count alone is met by a
    // fixture that wrote one record and by an entry carrying any number.
    const issued = loggedKeys(harness.storage);
    expect(issued).toEqual([logKey(0, held + 1), logKey(0, held + 2)]);
    const expected = [];
    for (const [index] of issued.entries()) {
      const bytes = await storedRecord(harness.storage, 0, held + 1 + index);
      expected.push({ seq: held + 1 + index, bytes: (bytes as Uint8Array).length });
    }
    expect(harness.internals.logBytes).toEqual(expected);
    expect(harness.internals.logBytesSinceBase)
      .toBe(expected.reduce((sum, entry) => sum + entry.bytes, 0));
  });

  it("trims to the records above the sequence a landed blob write carried", async () => {
    const harness = await retirementHarness(5, []);
    harness.internals.baseSeq = 0;
    harness.internals.logBytes = [2, 4, 5, 7].map((seq) => ({ seq, bytes: 100 }));
    harness.internals.logBytesSinceBase = 400;

    await harness.internals.doSnapshot();

    expect(accounting(harness.internals)).toMatchObject({ base: 5, seqs: [7] });
    expect(harness.internals.logBytesSinceBase).toBe(100);
  });

  it("trims before the header's deletion and before the batch, whatever the batch does", async () => {
    for (const outcome of ["lands", "fails"]) {
      const seen: Array<{ at: string } & ReturnType<typeof accounting>> = [];
      const harness = await retirementHarness(5, [1, 2], {
        deleteFails: () => undefined,
      }, {
        batch: () => {
          seen.push({ at: "batch", ...accounting(harness.internals) });
          if (outcome === "fails") throw new Error("D1_ERROR: the entity batch was refused");
        },
      });
      // A list spanning the sequence the write carries, so the trim is a change
      // to the entries and not to `baseSeq` alone: an entry at or below 5 still
      // standing at the header's deletion is a trim that ran after it.
      harness.internals.baseSeq = 0;
      harness.internals.logBytes = [2, 4, 7].map((seq) => ({ seq, bytes: 100 }));
      harness.internals.logBytesSinceBase = 300;
      const storage = harness.ctx.storage as unknown as {
        delete: (keys: string[]) => Promise<number>;
      };
      const realDelete = storage.delete.bind(storage);
      storage.delete = (keys: string[]) => {
        seen.push({
          at: keys[0].startsWith("base:") ? "header" : "log",
          ...accounting(harness.internals),
        });
        return realDelete(keys);
      };

      await harness.internals.doSnapshot().catch(() => null);

      expect(seen.map((entry) => entry.at)).toEqual(["header", "log", "batch"]);
      for (const entry of seen) {
        expect(entry).toMatchObject({ base: 5, seqs: [7], bytes: 100 });
      }
      expect(accounting(harness.internals)).toMatchObject({ base: 5, seqs: [7], bytes: 100 });
    }
  });

  it("keeps the advance when the header's deletion fails", async () => {
    const harness = await retirementHarness(5, [1], {
      deleteFails: (keys) => (keys[0].startsWith("base:") ? new Error("storage down") : undefined),
    });

    await harness.internals.doSnapshot().catch(() => null);

    expect(harness.internals.baseSeq).toBe(5);
  });

  it("advances on an adopted write as it does on an acknowledged one", async () => {
    let harness!: Awaited<ReturnType<typeof retirementHarness>>;
    harness = await retirementHarness(5, [1, 2], {}, {
      row: tagged(BASE_A, 0, 0, 4),
      run: lostAcknowledgement(() => harness),
    });

    await harness.internals.doSnapshot();

    expect(harness.internals.baseSeq).toBe(5);
  });

  it("clears with the document", async () => {
    const harness = await loaded();
    addUnsavedStory(harness.internals);
    expect(harness.internals.logBytes.length).toBeGreaterThan(0);

    harness.internals.replaceDocument();

    expect(accounting(harness.internals)).toMatchObject({ base: null, bytes: 0, seqs: [] });
  });

  it("states the list's size once, and keeps every entry", async () => {
    const harness = await loaded();
    harness.internals.baseSeq = 0;
    harness.internals.logBytes = [];
    harness.internals.logBytesSinceBase = 0;
    for (let seq = 1; seq <= 100_001; seq++) harness.internals.noteRecordWritten(seq, 4);

    expect(harness.internals.logBytes).toHaveLength(100_001);
    expect(harness.internals.logBytesSinceBase).toBe(400_004);
    expect(errors.filter((line) => line.includes("[persistence][accounting]"))).toHaveLength(1);
  });

  it("initialises the base before the replay on the cold path too", async () => {
    const harness = makeDo({ base: [cold(4)], rows: ONE_STORY });

    await harness.internals.ensureDocLoaded();

    expect(harness.internals.baseSeq).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Compaction: the log folded into a storage base at the document's sequence
// ---------------------------------------------------------------------------

/** The lowered policy every compaction fixture runs under. */
const SEAM_RECORDS = 20;
const SEAM_BYTES = 4 * 1024;

/**
 * An opened instance over a live row, with the thresholds lowered through the
 * policy seam and its inventories empty.
 *
 * The sequence and the byte total are SET rather than reached: what compaction
 * turns on is the tail the accounting describes, and driving a document to
 * twenty records would prove the driver.
 */
async function compactionHarness(
  debt: { seq?: number; bytes?: number; planted?: number[] } = {},
  policy: Partial<{ records: number; bytes: number; ceiling: number; partLimit: number }> = {},
  storageOpts: StorageOptions = {},
  db: Partial<DbScript> = {},
  sockets: FakeSocket[] = [],
  events: string[] = [],
) {
  const harness = makeDo(
    { row: tagged(BASE_A, 0, 0, 4), rows: ONE_STORY, ...db },
    {},
    sockets,
    events,
  );
  await harness.internals.ensureDocLoaded();
  await settle(2);
  for (const at of debt.planted ?? []) plantRecord(harness.storage, 0, at, junk(at));
  harness.internals.compactionPolicy = {
    records: SEAM_RECORDS,
    bytes: SEAM_BYTES,
    ceiling: MAX_RECORD_BYTES,
    ...policy,
  };
  harness.internals.baseSeq = 0;
  harness.internals.logBytes = [];
  harness.internals.logBytesSinceBase = debt.bytes ?? 0;
  harness.internals.docSeq = debt.seq ?? 0;
  harness.storage.arm(storageOpts);
  harness.storage.putBatches.length = 0;
  harness.storage.deleteBatches.length = 0;
  harness.storage.lists.length = 0;
  harness.storage.alarms.length = 0;
  harness.storage.disarmAlarm();
  harness.db.clear();
  events.length = 0;
  errors.length = 0;
  return harness;
}

/** Empty a generation's log, so nothing stands at or below a planted header. */
function clearLog(storage: FakeStorage, generation = 0): void {
  for (const key of logKeysOf(storage, generation)) storage.kv.delete(key);
}

/** The put batches that carried a base key of one generation, in order. */
function basePuts(storage: FakeStorage, generation = 0): string[][] {
  return storage.putBatches.filter(
    (keys) => keys.some((key) => key.startsWith(`${baseKey(generation)}`)),
  );
}

/**
 * Put a marker in the ordered record where the alarm first reads the document.
 *
 * The compaction's encoding is the one thing an alarm does that touches the
 * document at all: the preflight reads storage and D1, the maintenance slice
 * reads storage, and `Y.encodeStateAsUpdate` reads the store to encode. So the
 * FIRST store read inside an alarm is the encoding, and one marker at it places
 * the encoding among the storage operations either side.
 */
function markTheEncoding(internals: Internals, record: string[]): void {
  const doc = internals.ydoc;
  const store = doc.store;
  let marked = false;
  Object.defineProperty(doc, "store", {
    configurable: true,
    get() {
      if (!marked) {
        marked = true;
        record.push("encode");
      }
      return store;
    },
  });
}

function compactionLines(): string[] {
  return errors.filter((line) => line.includes("[persistence][compaction]"));
}

function compactedLines(): string[] {
  return errors.filter((line) => line.includes("[persistence][compacted]"));
}

describe("the alarm folds a log that has passed its threshold into a storage base", () => {
  it("writes the base at the document's sequence, then retires the log below it", async () => {
    const harness = await compactionHarness({ seq: 25, planted: [1, 2, 3, 25, 26] });

    await harness.internals.alarm();

    const stored = await readBase(harness.storage as unknown as LogStorage, 0);
    expect(stored).toMatchObject({ generation: 0, seq: 25 });
    expect(logKeysOf(harness.storage)).toEqual([logKey(0, 26)]);
    expect(compactedLines()).toHaveLength(1);
  });

  it("has moved the accounting to the fold before its own retirement is entered", async () => {
    const harness = await compactionHarness({ seq: 25, planted: [1, 2, 25] });
    // A tail spanning the sequence the fold carries, so the trim is a change to
    // the entries and the total and not to `baseSeq` alone: an entry at or
    // below 25 still standing at the first deletion is a trim that ran after
    // the retirement rather than before it.
    harness.internals.logBytes = [2, 4, 26].map((seq) => ({ seq, bytes: 100 }));
    harness.internals.logBytesSinceBase = 300;
    const atRetirement: Array<ReturnType<typeof accounting>> = [];
    const storage = harness.ctx.storage as unknown as {
      delete: (keys: string[]) => Promise<number>;
    };
    const realDelete = storage.delete.bind(storage);
    storage.delete = (keys: string[]) => {
      if (keys[0].startsWith(logPrefix(0))) atRetirement.push(accounting(harness.internals));
      return realDelete(keys);
    };

    await harness.internals.alarm();

    // Read on entry to the compaction's own retirement, which the base
    // transaction has already landed before.
    expect(atRetirement.length).toBeGreaterThan(0);
    expect(atRetirement[0]).toMatchObject({ base: 25, seqs: [26], bytes: 100 });
  });

  it("takes the maintenance slice, the encoding, the compaction and the snapshot in order", async () => {
    const events: string[] = [];
    const socket = fakeSocket([]);
    const harness = await compactionHarness(
      { seq: 25, planted: [1, 2, 25] },
      {},
      {},
      {},
      [socket],
      events,
    );
    // An orphan base part no header stands over: work the maintenance slice
    // actually has to do, so its own deletion stands in the record and a slice
    // moved after the fold could not pass for one that ran before it.
    harness.storage.kv.set(`${baseKey(0)}:0007`, new Uint8Array([9, 9]));
    events.length = 0;
    markTheEncoding(harness.internals, events);

    await harness.internals.alarm();

    const record = events.filter((event) =>
      event === "transaction" ||
      event === "delete" ||
      event === "encode" ||
      event.startsWith("put:base") ||
      /^run:UPDATE projects SET yjs_state/.test(event));
    expect(record).toEqual([
      // The maintenance slice's own sweep first; then the document encoded and
      // the base's parts and header written in one group inside the
      // transaction; the compaction's own retirement after it; then the
      // snapshot half: its blob write and the header that write retires.
      // Nothing is left below the sequence for the snapshot's retirement.
      "delete",
      "encode",
      "transaction",
      "put:base,base",
      "delete",
      "run:UPDATE projects SET yjs_state = ?,",
      "delete",
    ]);
    expect(harness.storage.kv.has(`${baseKey(0)}:0007`)).toBe(false);
    // The base's parts and its header in one group, at the exact keys.
    expect(basePuts(harness.storage)).toEqual([[`${baseKey(0)}:0001`, baseKey(0)]]);
    // The preflight's probe first, bounded one above the floor the row named,
    // then the retirement's own listing bounded one above the compacted base.
    const lists = logLists(harness.storage);
    expect(lists[0]).toMatchObject({ prefix: logPrefix(0), end: logKey(0, 1), limit: 1 });
    expect(lists[1]).toMatchObject({ prefix: logPrefix(0), end: logKey(0, 26) });
  });

  it("writes no base below the record threshold", async () => {
    const harness = await compactionHarness({ seq: SEAM_RECORDS - 1, planted: [1] });

    await harness.internals.alarm();

    expect(basePuts(harness.storage)).toEqual([]);
    expect(logKeysOf(harness.storage)).toEqual([logKey(0, 1)]);
  });

  it("compacts on the byte threshold alone", async () => {
    const harness = await compactionHarness({ seq: 3, bytes: SEAM_BYTES, planted: [1, 2, 3] });

    await harness.internals.alarm();

    expect(basePuts(harness.storage)).toHaveLength(1);
    expect(logKeysOf(harness.storage)).toEqual([]);
  });

  it("compacts once when both thresholds stand", async () => {
    const harness = await compactionHarness({ seq: 30, bytes: SEAM_BYTES * 2, planted: [1, 30] });

    await harness.internals.alarm();

    expect(basePuts(harness.storage)).toHaveLength(1);
    expect(compactedLines()).toHaveLength(1);
  });

  it("loads nothing and compacts nothing on a socketless unloaded instance", async () => {
    const harness = await compactionHarness({ seq: 25, planted: [1, 2] });
    harness.internals.replaceDocument();
    harness.db.clear();
    harness.storage.putBatches.length = 0;

    await harness.internals.alarm();

    expect(basePuts(harness.storage)).toEqual([]);
    expect(harness.internals.docLoaded).toBe(false);
    expect(harness.db.reads.filter((r) => /^SELECT yjs_state/.test(r.sql))).toHaveLength(0);
  });

  it("runs the cleanup owed and not a new compaction, then compacts on the next turn", async () => {
    const harness = await compactionHarness({ seq: 25, planted: [1, 2, 25] });
    // A base header standing at 2 is cleanup owed: keys 1 and 2 sit at or below
    // it, and the alarm that finds them spends its one budget on them.
    plantBase(harness.storage, 0, 2, BASE_A);
    harness.storage.putBatches.length = 0;

    await harness.internals.alarm();

    expect(basePuts(harness.storage)).toEqual([]);
    expect(logKeysOf(harness.storage)).toEqual([logKey(0, 25)]);

    await harness.internals.alarm();

    expect(basePuts(harness.storage)).toHaveLength(1);
    expect((await readBase(harness.storage as unknown as LogStorage, 0))?.seq).toBe(25);
  });

  it("serves the compacted base and the tail above it, and nothing at or below it", async () => {
    const socket = fakeSocket([]);
    // The blob write refused before execution, so the alarm's snapshot half
    // retires no header: what the recovery below reads is the storage base.
    const harness = await compactionHarness(
      { seq: 3, bytes: SEAM_BYTES },
      {},
      {},
      {
        run: (sql) => (/^UPDATE projects SET yjs_state/.test(sql)
          ? { throws: new Error("D1_ERROR: the row could not be written") }
          : undefined),
      },
      [socket],
    );
    harness.internals.docSeq = 3;
    harness.internals.ydoc.transact(() => {
      harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0).set("folded", "yes");
    }, null);
    const foldedAt = harness.internals.docSeq as number;

    await harness.internals.alarm().catch(() => null);

    const stored = await readBase(harness.storage as unknown as LogStorage, 0);
    expect(stored).toMatchObject({ generation: 0, seq: foldedAt });
    expect(harness.storage.kv.has(baseKey(0))).toBe(true);
    // The tail: each record built on the one before it, so a replay that
    // skipped or reordered any of them leaves structs pending; the third is a
    // deletion, which a state vector alone cannot tell from an absence.
    const tail = new Y.Doc();
    Y.applyUpdate(tail, stored!.bytes);
    const above = (edit: (doc: Y.Doc) => void): Uint8Array => {
      const before = Y.encodeStateVector(tail);
      tail.transact(() => edit(tail), null);
      return Y.encodeStateAsUpdate(tail, before);
    };
    const records = [
      above((doc) => { doc.getArray<Y.Map<unknown>>("stories").get(0).set("above", "base"); }),
      above((doc) => {
        const second = new Y.Map<unknown>();
        second.set("_id", 12);
        second.set("story_id", "s12");
        doc.getArray<Y.Map<unknown>>("stories").push([second]);
      }),
      above((doc) => { doc.getArray<Y.Map<unknown>>("stories").delete(1, 1); }),
    ];
    records.forEach((bytes, index) => plantRecord(harness.storage, 0, foldedAt + 1 + index, bytes));
    // Two records the fold subsumed, planted back into the range the base
    // covers: a replay that started below the base's own sequence would serve
    // them.
    plantRecord(harness.storage, 0, foldedAt, recordBytes(stored!.bytes, (doc) => {
      doc.getArray<Y.Map<unknown>>("stories").get(0).set("at_the_base", "yes");
    }));
    plantRecord(harness.storage, 0, foldedAt - 1, recordBytes(stored!.bytes, (doc) => {
      doc.getArray<Y.Map<unknown>>("stories").get(0).set("below_the_base", "yes");
    }));
    harness.db.clear();

    const woken = await reviveOn(harness);
    woken.internals.replaceDocument();
    const boundary = captureAtRepairBoundary(woken.internals);
    await woken.internals.ensureDocLoaded();

    // The base and its tail, compared against a document built from the same
    // bytes outside the object, at the point before the load's own repairs add
    // to it.
    expect(boundary.snapshot).not.toBeNull();
    expect(Y.equalSnapshots(boundary.snapshot as Y.Snapshot, Y.snapshot(tail))).toBe(true);
    expect(woken.internals.ydoc.store.pendingStructs).toBeNull();
    expect(woken.internals.ydoc.store.pendingDs).toBeNull();
    const story = woken.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0);
    expect(story.get("folded")).toBe("yes");
    expect(story.get("above")).toBe("base");
    expect(story.get("at_the_base")).toBeUndefined();
    expect(story.get("below_the_base")).toBeUndefined();
    expect(woken.internals.ydoc.getArray("stories")).toHaveLength(1);
  });
});

describe("the base is written whole or not at all", () => {
  it("leaves an existing base byte for byte when a later batch throws", async () => {
    // The new base parted small enough to span more than one batch, so the
    // throw lands on a LATER one with earlier keys already issued.
    const harness = await compactionHarness({ seq: 25 }, { partLimit: 1 });
    // A distinguishable multipart base at the key, written through the codec.
    for (const [key, value] of Object.entries(
      encodeBase(0, 7, BASE_STORAGE, { partLimit: 8 }),
    )) {
      harness.storage.kv.set(key, value);
    }
    // Nothing at or below the planted header's sequence, so the turn's one
    // budget goes to the compaction rather than to a cleanup.
    clearLog(harness.storage);
    const before = new Map(harness.storage.kv);
    harness.storage.arm({
      putThrowsOn: (keys, nth) => (nth === 2 ? new Error("binding gone") : undefined),
    });

    await harness.internals.alarm();

    expect([...harness.storage.kv.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, value] of before) expect(harness.storage.kv.get(key)).toEqual(value);
    const kept = await readBase(harness.storage as unknown as LogStorage, 0);
    expect(kept).toMatchObject({ seq: 7 });
    expect(kept?.bytes).toEqual(BASE_STORAGE);
  });

  it("changes nothing, says so once and leaves the counters alone when the transaction rejects", async () => {
    const harness = await compactionHarness({ seq: 25, bytes: 99 });
    harness.storage.arm({
      putFails: (keys) => (keys.some((k) => k.startsWith("base:")) ? new Error("down") : undefined),
    });

    await harness.internals.alarm();

    expect(harness.storage.kv.has(baseKey(0))).toBe(false);
    expect(accounting(harness.internals)).toMatchObject({ base: 0, bytes: 99 });
    expect(compactionLines()).toHaveLength(1);
    expect(compactedLines()).toHaveLength(0);
  });

  it("leaves the previous base's surplus parts to the sweep the header's retirement opens", async () => {
    const harness = await compactionHarness({ seq: 25 });
    // A previous base parted one byte at a time, so its parts outnumber one
    // maintenance run's deletion budget and the sweep has to take more than one.
    for (const [key, value] of Object.entries(
      encodeBase(0, 7, new Uint8Array(1_200).fill(7), { partLimit: 1 }),
    )) {
      harness.storage.kv.set(key, value);
    }
    clearLog(harness.storage);
    const surplus = [...harness.storage.kv.keys()].filter((key) => key.startsWith(`${baseKey(0)}:`));
    expect(surplus.length).toBeGreaterThan(1_024);

    await harness.internals.alarm();

    // The new header names one part, and every surplus part is still there —
    // unreachable through the reader, and maintenance's only once the header
    // goes.
    const header = harness.storage.kv.get(baseKey(0)) as RecordHeader;
    expect(header.parts).toBe(1);
    for (const key of surplus.slice(1)) expect(harness.storage.kv.has(key)).toBe(true);
    expect((await readBase(harness.storage as unknown as LogStorage, 0))?.seq).toBe(25);

    // The landed blob write retires the header, and the parts become orphans.
    harness.internals.docSeq = 26;
    await harness.internals.doSnapshot();
    expect(harness.storage.kv.has(baseKey(0))).toBe(false);

    await harness.internals.alarm();
    const afterFirst = [...harness.storage.kv.keys()]
      .filter((key) => key.startsWith(`${baseKey(0)}:`));
    expect(afterFirst.length).toBeGreaterThan(0);
    expect(afterFirst.length).toBeLessThan(surplus.length);

    await harness.internals.alarm();

    expect([...harness.storage.kv.keys()].filter((key) => key.startsWith(`${baseKey(0)}:`)))
      .toEqual([]);
  });
});

describe("a document too big to fold is reported and left uncompacted", () => {
  it("writes no base, states the size once, and keeps the log and the document", async () => {
    const harness = await compactionHarness({ seq: 25, planted: [1, 2] }, { ceiling: 4 });

    await harness.internals.alarm();
    await harness.internals.alarm();

    expect(basePuts(harness.storage)).toEqual([]);
    expect(logKeysOf(harness.storage)).toEqual([logKey(0, 1), logKey(0, 2)]);
    expect(compactionLines()).toHaveLength(1);
    expect(harness.internals.docLoaded).toBe(true);
  });

  it("compacts once the document is back under the ceiling", async () => {
    const harness = await compactionHarness({ seq: 25 }, { ceiling: 4 });
    await harness.internals.alarm();
    expect(basePuts(harness.storage)).toEqual([]);

    harness.internals.compactionPolicy = {
      ...harness.internals.compactionPolicy,
      ceiling: MAX_RECORD_BYTES,
    };
    await harness.internals.alarm();

    expect(basePuts(harness.storage)).toHaveLength(1);
  });

  it("clears both latches with the document", async () => {
    const harness = await compactionHarness({ seq: 25 }, { ceiling: 4 });
    await harness.internals.alarm();
    await harness.internals.doSnapshot();
    expect(compactionLines()).toHaveLength(1);

    harness.internals.replaceDocument();
    await harness.internals.ensureDocLoaded();
    harness.internals.compactionPolicy = { records: SEAM_RECORDS, bytes: SEAM_BYTES, ceiling: 4 };
    harness.internals.docSeq = 25;
    harness.internals.baseSeq = 0;
    await harness.internals.alarm();

    expect(compactionLines()).toHaveLength(2);
  });
});

describe("compaction and its retirement run at the alarm's own gate depth", () => {
  it("records the transaction, its puts and the deletions at depth 1", async () => {
    const harness = await compactionHarness({ seq: 25, planted: [1, 2] });
    const watch = watchDepths(harness);

    await harness.internals.alarm();

    expect(watch.depthsOf("put", "delete", "list")).not.toHaveLength(0);
    for (const depth of watch.depthsOf("put", "delete", "list")) expect(depth).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cleanup owed, derived from storage and the row rather than recorded
// ---------------------------------------------------------------------------

/** A generation's log holding `count` records from sequence 1 upward. */
function plantLog(storage: FakeStorage, count: number, generation = 0): void {
  for (let seq = 1; seq <= count; seq++) plantRecord(storage, generation, seq, junk(seq));
}

describe("the next alarm finds what a bounded retirement left owed", () => {
  it("continues from a storage base's header until the range is drained", async () => {
    const harness = await compactionHarness({ seq: 0 });
    clearLog(harness.storage);
    plantBase(harness.storage, 0, 1_500, BASE_A);
    plantLog(harness.storage, 1_500);
    harness.storage.deleteBatches.length = 0;

    await harness.internals.alarm();
    const afterFirst = logKeysOf(harness.storage).length;
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(1_500);

    await harness.internals.alarm();

    expect(logKeysOf(harness.storage)).toEqual([]);
  });

  it("does nothing at all once the eligible range is empty", async () => {
    const harness = await compactionHarness({ seq: 0 });
    clearLog(harness.storage);
    plantBase(harness.storage, 0, 5, BASE_A);
    harness.storage.deleteBatches.length = 0;

    await harness.internals.alarm();

    expect(logDeletes(harness.storage)).toEqual([]);
  });

  it("continues from the row when no header stands, on a socketless wake with no seam", async () => {
    const harness = await compactionHarness({ seq: 0 });
    clearLog(harness.storage);
    // What a landed write leaves: the row at a sequence, no header, and a log
    // still holding what its own bounded retirement could not reach.
    harness.db.row()!.yjs_seq = 40;
    plantLog(harness.storage, 40);

    const woken = await reviveWithoutIdentity(harness);
    expect(woken.internals.projectId).toBeNull();

    await woken.internals.alarm();

    expect(woken.internals.projectId).toBe(PROJECT_ID);
    expect(logKeysOf(woken.storage)).toEqual([]);
    expect(woken.internals.docLoaded).toBe(false);
  });

  it("runs maintenance only, and says so once, when no identity is stored", async () => {
    const harness = await compactionHarness({ seq: 0 });
    clearLog(harness.storage);
    harness.storage.kv.delete(PROJECT_ID_KEY);
    harness.db.row()!.yjs_seq = 40;
    plantLog(harness.storage, 40);
    const woken = await reviveWithoutIdentity(harness);
    errors.length = 0;

    await woken.internals.alarm();

    expect(logKeysOf(woken.storage)).toHaveLength(40);
    expect(identityLines()).toHaveLength(1);
  });

  it("takes no floor from a row that is not a base", async () => {
    for (const metadata of [
      { yjs_generation: 0, yjs_seq: 40, has_blob: 0 },
      null,
      { yjs_generation: 1, yjs_seq: 40, has_blob: 1 },
      { yjs_generation: 0, yjs_seq: "forty", has_blob: 1 },
    ]) {
      const harness = await compactionHarness({ seq: 0 }, {}, {}, { metadata: () => metadata });
      clearLog(harness.storage);
      plantLog(harness.storage, 3);
      errors.length = 0;

      await harness.internals.alarm();

      expect(logKeysOf(harness.storage)).toHaveLength(3);
      expect(cleanupLines()).toHaveLength(1);
    }
  });

  it("probes the range with a listing of one, and finds an orphan part exactly at the floor", async () => {
    const harness = await compactionHarness({ seq: 0 });
    clearLog(harness.storage);
    harness.db.row()!.yjs_seq = 5;
    harness.storage.kv.set(`${logKey(0, 5)}:0001`, new Uint8Array([1]));
    // A malformed key that sorts INSIDE the range, which is the only kind the
    // bound reaches: the sweep owns it, and the codec skips it on read.
    harness.storage.kv.set(`${logKey(0, 3)}x`, new Uint8Array([2]));

    await harness.internals.alarm();

    expect(logLists(harness.storage)[0]).toMatchObject({ end: logKey(0, 6), limit: 1 });
    expect(logKeysOf(harness.storage)).toEqual([]);
  });

  it("omits the bound at the codec's highest sequence", async () => {
    const harness = await compactionHarness({ seq: 0 });
    clearLog(harness.storage);
    harness.db.row()!.yjs_seq = MAX_SEQ;

    await harness.internals.alarm();

    expect(logLists(harness.storage)[0]).toMatchObject({ prefix: logPrefix(0), limit: 1 });
    expect(logLists(harness.storage)[0].end).toBeUndefined();
  });

  it("takes no storage floor from a malformed header, and consults the row instead", async () => {
    const harness = await compactionHarness({ seq: 0 });
    clearLog(harness.storage);
    harness.storage.kv.set(baseKey(0), { v: 1, parts: 0, length: 0, checksum: 0 });
    harness.db.row()!.yjs_seq = 3;
    plantLog(harness.storage, 3);
    errors.length = 0;

    await harness.internals.alarm();

    expect(cleanupLines()).toHaveLength(1);
    expect(logKeysOf(harness.storage)).toEqual([]);
  });

  it("waits the full interval when the header read or the probe is refused", async () => {
    freezeClock();
    const refusedRead = await compactionHarness({ seq: 0 }, {}, {
      failOn: (kind) => (kind === "base" ? new Error("storage down") : undefined),
    });
    await refusedRead.internals.alarm();
    expect(armedIn(refusedRead.storage)).toBe(SNAPSHOT_ALARM_MS);

    const refusedList = await compactionHarness({ seq: 0 }, {}, {
      failOn: (kind) => (kind === "list" ? new Error("storage down") : undefined),
    });
    await refusedList.internals.alarm();
    expect(armedIn(refusedList.storage)).toBe(SNAPSHOT_ALARM_MS);
  });
});

describe("a row read the cleanup needed is unknown, and compaction runs anyway", () => {
  it("compacts from storage, skips the row's cleanup, and waits the full interval", async () => {
    freezeClock();
    const harness = await compactionHarness(
      { seq: 25, planted: [1, 2] },
      {},
      {},
      { metadata: () => ({ throws: new Error("D1_ERROR: the row could not be read") }) },
    );

    await harness.internals.alarm();

    expect((await readBase(harness.storage as unknown as LogStorage, 0))?.seq).toBe(25);
    expect(cleanupUnknownLines()).toHaveLength(1);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
    // The preflight's own reads are untouched by it: the generation and the
    // halt were read, and neither refused the alarm.
    expect(harness.events.filter((e) => e === "get:halt")).not.toHaveLength(0);
  });
});

describe("a durable binding storage refused withholds the row and the fold alike", () => {
  /** An instance holding its id with the durable binding unmade and unmakeable. */
  function refuseTheBinding(harness: ReturnType<typeof makeDo>): void {
    harness.internals.identityBound = null;
    harness.storage.kv.delete(PROJECT_ID_KEY);
    harness.storage.arm({
      putFails: (keys) => (keys[0] === PROJECT_ID_KEY ? new Error("storage down") : undefined),
    });
  }

  it("folds nothing on a loaded document with debt, and waits the full interval", async () => {
    freezeClock();
    const harness = await compactionHarness({ seq: 25, planted: [1, 2] });
    refuseTheBinding(harness);

    await harness.internals.alarm();

    expect(harness.internals.identityBound).toBeNull();
    expect(basePuts(harness.storage)).toEqual([]);
    expect(compactedLines()).toEqual([]);
    expect(logKeysOf(harness.storage)).toEqual([logKey(0, 1), logKey(0, 2)]);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
  });

  it("withholds a socketless instance's row cleanup, and waits the full interval", async () => {
    freezeClock();
    const events: string[] = [];
    const harness = await compactionHarness({ seq: 0 }, {}, {}, {}, [], events);
    clearLog(harness.storage);
    harness.db.row()!.yjs_seq = 40;
    plantLog(harness.storage, 40);
    refuseTheBinding(harness);
    events.length = 0;

    await harness.internals.alarm();

    expect(events.filter((event) => event === "read-metadata")).toEqual([]);
    expect(logKeysOf(harness.storage)).toHaveLength(40);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
  });
});

// ---------------------------------------------------------------------------
// What the alarm arms next
// ---------------------------------------------------------------------------

describe("the alarm arms the next one by one precedence", () => {
  it("arms nothing under a halt", async () => {
    const harness = await compactionHarness({ seq: 25, planted: [1] });
    plantMarker(harness.storage, 0, "log_corrupt");
    harness.storage.alarms.length = 0;

    await harness.internals.alarm();

    expect(harness.storage.alarms).toHaveLength(0);
    expect(basePuts(harness.storage)).toEqual([]);
    expect(logDeletes(harness.storage)).toEqual([]);
  });

  it("waits the full interval on a rejected compaction, with no socket to mask it", async () => {
    freezeClock();
    const harness = await compactionHarness({ seq: 25 });
    harness.storage.arm({
      putFails: (keys) => (keys.some((k) => k.startsWith("base:")) ? new Error("down") : undefined),
    });

    await harness.internals.alarm();

    // Debt still stands, which alone would bring the next run forward to the
    // maintenance delay: the full interval is the refusal's.
    expect(harness.internals.docSeq).toBe(25);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
  });

  it("waits the full interval on a rejected cleanup, with no socket to mask it", async () => {
    freezeClock();
    const harness = await compactionHarness({ seq: 0 });
    clearLog(harness.storage);
    plantBase(harness.storage, 0, 5, BASE_A);
    plantLog(harness.storage, 5);
    harness.storage.arm({
      deleteFails: (keys) => (keys[0].startsWith("log:") ? new Error("down") : undefined),
    });

    await harness.internals.alarm();

    expect(logKeysOf(harness.storage)).toHaveLength(5);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
  });

  it("lets the snapshot half run through a rejected compaction and a rejected cleanup alike", async () => {
    for (const refusal of [
      {
        // No header stands, so the turn's one retirement is the compaction, and
        // the base's own put is what fails.
        owed: false,
        arm: {
          putFails: (keys: string[]) =>
            (keys.some((k) => k.startsWith("base:")) ? new Error("down") : undefined),
        },
      },
      {
        // A header at 2 over records at 1 and 2 is cleanup owed, which takes
        // the turn ahead of any compaction, and its deletion is what fails.
        owed: true,
        arm: {
          deleteFails: (keys: string[]) =>
            (keys[0].startsWith("log:") ? new Error("down") : undefined),
        },
      },
    ]) {
      const socket = fakeSocket([]);
      const harness = await compactionHarness({ seq: 25, planted: [1, 2] }, {}, {}, {}, [socket]);
      if (refusal.owed) plantBase(harness.storage, 0, 2, BASE_A);
      harness.storage.arm(refusal.arm);

      await harness.internals.alarm();

      // The refusal this iteration is about, established before the snapshot
      // half is asked about at all: a turn that refused nothing says nothing
      // about running through a refusal.
      if (refusal.owed) {
        // The cleanup's own refusal; the snapshot half's retirement fails on
        // the same deletions after it, so the count is not the assertion.
        expect(errors.filter((line) => line.includes("[persistence][retirement]")).length)
          .toBeGreaterThan(0);
      } else {
        expect(compactionLines()).toHaveLength(1);
      }
      expect(compactedLines()).toHaveLength(0);
      expect(harness.db.mutations.some((m) => /^UPDATE projects SET yjs_state/.test(m.sql)))
        .toBe(true);
    }
  });

  it("takes thirty seconds for an attached socket ahead of work that demonstrably remains", async () => {
    freezeClock();
    const socket = fakeSocket([]);
    const harness = await compactionHarness({ seq: 0 }, {}, {}, {}, [socket]);
    clearLog(harness.storage);
    plantBase(harness.storage, 0, 1_500, BASE_A);
    plantLog(harness.storage, 1_500);

    await harness.internals.alarm();

    // A cleanup one budget could not drain, which without the socket would come
    // back at the maintenance delay.
    expect(logKeysOf(harness.storage).length).toBeGreaterThan(0);
    expect(armedIn(harness.storage)).toBe(SNAPSHOT_ALARM_MS);
  });

  it("comes back at the maintenance delay for a cleanup one budget could not drain", async () => {
    freezeClock();
    const harness = await compactionHarness({ seq: 0 });
    clearLog(harness.storage);
    plantBase(harness.storage, 0, 1_500, BASE_A);
    plantLog(harness.storage, 1_500);

    await harness.internals.alarm();

    expect(armedIn(harness.storage)).toBe(MAINTENANCE_DELAY_MS);
  });

  it("comes back at the maintenance delay while threshold debt still stands", async () => {
    freezeClock();
    const harness = await compactionHarness({ seq: 25 }, { ceiling: 4 });

    await harness.internals.alarm();

    expect(armedIn(harness.storage)).toBe(MAINTENANCE_DELAY_MS);
  });

  it("arms each combined outcome at exactly the stated delay", async () => {
    const quiet = { floor: 0, pending: false, rejected: false, lists: 0, deleted: 0 };
    const settled = { owed: false, rejected: false };
    // The snapshot half's own retirement is the one outcome an alarm cannot
    // reach without a socket, and a socket takes precedence over pending work —
    // so its two failing outcomes are put to the scheduler directly.
    const matrix: Array<{
      what: string;
      slice?: Partial<typeof quiet>;
      turn?: Partial<typeof settled>;
      snapshot?: string | null;
      sockets?: number;
      debt?: number;
      delay: number | null;
    }> = [
      { what: "a quiet turn", delay: null },
      { what: "a rejected slice", slice: { rejected: true }, delay: SNAPSHOT_ALARM_MS },
      { what: "a rejected turn", turn: { rejected: true }, delay: SNAPSHOT_ALARM_MS },
      { what: "a rejected snapshot retirement", snapshot: "rejected", delay: SNAPSHOT_ALARM_MS },
      {
        what: "a rejected turn under a socket",
        turn: { rejected: true },
        sockets: 1,
        delay: SNAPSHOT_ALARM_MS,
      },
      { what: "a socket over pending work", slice: { pending: true }, sockets: 1, delay: SNAPSHOT_ALARM_MS },
      { what: "an unswept generation", slice: { floor: -1 }, delay: MAINTENANCE_DELAY_MS },
      { what: "a pending slice", slice: { pending: true }, delay: MAINTENANCE_DELAY_MS },
      { what: "a cleanup still owed", turn: { owed: true }, delay: MAINTENANCE_DELAY_MS },
      {
        what: "an exhausted snapshot retirement",
        snapshot: "exhausted",
        delay: MAINTENANCE_DELAY_MS,
      },
      { what: "threshold debt still standing", debt: SEAM_RECORDS, delay: MAINTENANCE_DELAY_MS },
    ];

    for (const row of matrix) {
      freezeClock();
      const sockets = row.sockets === 1 ? [fakeSocket([])] : [];
      const harness = await compactionHarness({ seq: row.debt ?? 0 }, {}, {}, {}, sockets);
      // The snapshot half's retirement is the whole progress record, so the
      // outcome the scheduler reads travels inside it.
      harness.internals.snapshotRetirement = row.snapshot === undefined || row.snapshot === null
        ? null
        : { outcome: row.snapshot, deleted: 0, lists: 0, deleteCalls: 0, firstDeleted: null, lastDeleted: null };

      await harness.internals.scheduleAfterAlarm(
        { ...quiet, ...row.slice },
        { ...settled, ...row.turn },
        0,
      );

      if (row.delay === null) expect(harness.storage.alarms, row.what).toHaveLength(0);
      else expect(armedIn(harness.storage), row.what).toBe(row.delay);
    }
  });

  it("arms nothing under a halt whatever the outcomes say", async () => {
    const harness = await compactionHarness({ seq: 25 });
    harness.internals.persistenceHalted = {
      generation: 0,
      marker: { reason: "log_corrupt", at: Date.now() },
    };
    harness.internals.snapshotRetirement = {
      outcome: "rejected", deleted: 0, lists: 0, deleteCalls: 0,
      firstDeleted: null, lastDeleted: null,
    };

    await harness.internals.scheduleAfterAlarm(
      { floor: -1, pending: true, rejected: true, lists: 0, deleted: 0 },
      { owed: true, rejected: true },
      0,
    );

    expect(harness.storage.alarms).toHaveLength(0);
  });

  it("arms nothing when the fold left neither debt nor work", async () => {
    freezeClock();
    const harness = await compactionHarness({ seq: 25, planted: [1] });

    await harness.internals.alarm();

    expect(harness.storage.alarms).toHaveLength(0);
    expect(harness.internals.baseSeq).toBe(25);
  });
});

describe("a load arms the alarm for the debt its own replay counted", () => {
  it("schedules maintenance when the tail it replayed is already over the threshold", async () => {
    freezeClock();
    const harness = makeDo({ base: [tagged(BASE_A, 0, 0, 4)], rows: ONE_STORY });
    for (let seq = 1; seq <= 3; seq++) {
      plantRecord(harness.storage, 0, seq, fieldRecord(`f${seq}`, String(seq)));
    }
    harness.internals.compactionPolicy = { records: 2, bytes: SEAM_BYTES, ceiling: MAX_RECORD_BYTES };

    await harness.internals.ensureDocLoaded();

    expect(harness.storage.alarms).not.toHaveLength(0);
    expect(armedIn(harness.storage)).toBe(MAINTENANCE_DELAY_MS);
  });
});

// ---------------------------------------------------------------------------
// The snapshot's size warning
// ---------------------------------------------------------------------------

function sizeWarnings(): string[] {
  return warnings.filter((line) => line.includes("[snapshot][size]"));
}

describe("a snapshot states the size of a blob above one mebibyte", () => {
  it("says it once per load, and again for the next document", async () => {
    const harness = await loaded();
    const big = "x".repeat(1_100_000);
    const swell = (): void => {
      harness.internals.ydoc.transact(() => {
        harness.internals.ydoc.getArray<Y.Map<unknown>>("stories").get(0).set("bulk", big);
      }, null);
    };
    swell();

    await harness.internals.doSnapshot();
    await harness.internals.doSnapshot();

    expect(sizeWarnings()).toHaveLength(1);

    // A second document on the same instance: the latch belongs to the load,
    // so the operator hears the size of every document the object serves.
    harness.internals.replaceDocument();
    await harness.internals.ensureDocLoaded();
    swell();
    await harness.internals.doSnapshot();

    expect(sizeWarnings()).toHaveLength(2);
  });

  it("says nothing for a blob under the mark", async () => {
    const harness = await loaded();

    await harness.internals.doSnapshot();

    expect(sizeWarnings()).toEqual([]);
  });
});

describe("a document too big for D1 and small enough for the codec", () => {
  it("compacts into storage while the snapshot fails and /snapshot fails closed", async () => {
    const socket = fakeSocket([]);
    const harness = await compactionHarness(
      { seq: 25 },
      {},
      {},
      {
        // What D1 answers above its own cap on a string, a blob or a whole row.
        run: (sql) => (/^UPDATE projects SET yjs_state/.test(sql)
          ? { throws: new Error("D1_ERROR: string or blob too big") }
          : undefined),
      },
      [socket],
    );

    await harness.internals.alarm().catch(() => null);

    expect((await readBase(harness.storage as unknown as LogStorage, 0))?.seq).toBe(25);

    const response = await harness.doInstance.fetch(
      await signedRequest("/snapshot", "snapshot"),
    );
    expect(response.status).not.toBe(200);
  });
});

describe("nothing is compacted while the document is not the log's to describe", () => {
  it("writes no base and lists nothing under a halt with debt and cleanup both standing", async () => {
    const harness = await compactionHarness({ seq: 25, planted: [1, 2] });
    plantBase(harness.storage, 0, 5, BASE_A);
    plantMarker(harness.storage, 0, "group_discarded");
    harness.storage.putBatches.length = 0;
    harness.storage.lists.length = 0;

    await harness.internals.alarm();

    expect(basePuts(harness.storage)).toEqual([]);
    expect(logLists(harness.storage)).toEqual([]);
    expect(logDeletes(harness.storage)).toEqual([]);
  });

  it("counts nothing and compacts nothing while logging is suppressed", async () => {
    const harness = await compactionHarness({ seq: 25 });
    harness.internals.logSuppressed = true;
    const before = accounting(harness.internals);

    addUnsavedStory(harness.internals);

    expect(accounting(harness.internals)).toEqual(before);
  });
});

describe("an ingest's prose writes credit nobody and move the word baseline", () => {
  it("credits the next author only with the words they add to a field a sync changed", async () => {
    const events: string[] = [];
    const harness = await loaded({ rows: ONE_STORY }, {}, [], events);
    expect(harness.internals.wordBaseline.get("stories:11:title")).toBe(2);

    const response = await harness.doInstance.fetch(await signedRequest("/ingest-sync", "ingest-sync", {
      stories: { update: [{ storyId: "s11", title: "one two three four five six" }] },
    }));
    expect(response.status).toBe(200);
    expect(harness.internals.wordBaseline.get("stories:11:title")).toBe(6);
    expect(harness.internals.wordsByRow.get("stories")?.get("11")?.get(USER_ID)).toBeUndefined();

    const socket = fakeSocket(events, { generation: harness.internals.docGeneration ?? 0 });
    harness.sockets.push(socket);
    await harness.internals.webSocketMessage(
      socket,
      updateMessage(Y.encodeStateAsUpdate(harness.internals.ydoc), (doc) => {
        (doc.getArray<Y.Map<unknown>>("stories").get(0).get("title") as Y.Text).insert(0, "extra ");
      }),
    );

    expect(harness.internals.wordsByRow.get("stories")?.get("11")?.get(USER_ID)).toBe(1);
  });

  it("credits the first author to edit a page a sync created with the words they add", async () => {
    const events: string[] = [];
    const harness = await loaded({ rows: ONE_STORY }, {}, [], events);

    const response = await harness.doInstance.fetch(await signedRequest("/ingest-sync", "ingest-sync", {
      pages: { insert: [{ slug: "review-page", title: "one two", body: "three four", created_by: USER_ID }] },
    }));
    expect(response.status).toBe(200);
    const page = harness.internals.ydoc.getArray<Y.Map<unknown>>("pages").toArray().find((m) => m.get("slug") === "review-page")!;
    const id = String(page.get("_id"));
    expect(harness.internals.wordBaseline.get(`pages:${id}:body`)).toBe(2);

    const socket = fakeSocket(events, { generation: harness.internals.docGeneration ?? 0 });
    harness.sockets.push(socket);
    await harness.internals.webSocketMessage(
      socket,
      updateMessage(Y.encodeStateAsUpdate(harness.internals.ydoc), (doc) => {
        const map = doc.getArray<Y.Map<unknown>>("pages").toArray().find((m) => m.get("slug") === "review-page")!;
        (map.get("body") as Y.Text).insert(0, "extra ");
      }),
    );

    expect(harness.internals.wordsByRow.get("pages")?.get(id)?.get(USER_ID)).toBe(1);
  });
});
