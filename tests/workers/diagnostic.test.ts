/**
 * The diagnostic read, the alarm's record and the two staging controls, against
 * the real class, real D1 and real workerd.
 *
 * Three things only this harness can prove. That the read touches nothing — the
 * object's own storage before and after, and the row's revision and stamp, are
 * what say so. That the record describes what actually happened inside the
 * gate, which needs a real alarm dispatched by the platform's own helper rather
 * than a method call. And that the hold and the flags survive an eviction,
 * which needs real Durable Object storage.
 *
 * Every alarm case arms explicitly and dispatches with `runDurableObjectAlarm`.
 * The helper does not exercise the platform's retries: an invocation that fails
 * rejects here and is not run again, so a record read afterwards is that
 * invocation's own.
 *
 * Instrumentation belongs to one instance and does not survive an eviction:
 * the storage probe, the D1 seam and the environment seam are each reinstalled
 * on the instance that has to carry them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Y from "yjs";

import {
  MAX_SEQ,
  PART_LIMIT,
  baseKey,
  encodeBase,
  encodeRecord,
  haltKey,
  logKey,
  logPrefix,
  writeGroup,
  type LogStorage,
} from "../../workers/doc-log";
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
  cancelAlarm,
  clientEdit,
  docOf,
  failBlobWrite,
  installProbe,
  installSeams,
  signedFor,
  waitUntil,
  callsTagged,
  type Internals,
  type ProbeControl,
} from "./helpers/instrumentation";

/** The read's classifying page width, and the reverse scan's page budgets. */
const DIAG_PAGE = 32;
const PRODUCTION_REVERSE_PAGES = 1;
const STAGING_REVERSE_PAGES = 8;
/** Nine storage calls, 72 value occurrences, on a cold production instance. */
const PRODUCTION_CALLS = 9;
const PRODUCTION_VALUES = 72;
/** The counting listings' page width and the budget one request may spend. */
const COUNT_PAGE = 128;
const COUNT_PAGES = 32;
/**
 * A population below the bound that spends the whole budget and still ends on
 * a short page: thirty-one full pages, then a page the range runs out inside.
 */
const COUNT_BUDGET_PARTS = 5;
const COUNT_BUDGET_RECORDS = COUNT_PAGE * COUNT_PAGES - 1 - COUNT_BUDGET_PARTS;

const touched = new Set<DurableObjectStub>();

function diagStub(projectId: number): DurableObjectStub {
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

// ---------------------------------------------------------------------------
// Driving the routes
// ---------------------------------------------------------------------------

interface Answer {
  status: number;
  // The diagnostic's answer is a tree of populations and outcomes; the tests
  // read it as one, which is what a JSON document is.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function readAnswer(response: Response): Promise<Answer> {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

async function readDiagnostic(fixture: Fixture, query = ""): Promise<Answer> {
  const response = await diagStub(fixture.projectId).fetch(
    await signedFor(fixture, `/diagnostic${query}`, "diagnostic", { method: "GET" }),
  );
  return await readAnswer(response);
}

async function setControl(
  fixture: Fixture,
  intent: "record" | "hold",
  value: "0" | "1",
): Promise<Answer> {
  const control = `${intent}=${value}`;
  const response = await diagStub(fixture.projectId).fetch(
    await signedFor(fixture, `/diagnostic?${control}`, "diagnostic-control", {
      binding: control,
    }),
  );
  return await readAnswer(response);
}

/** Set the cached environment this instance decides its controls by. */
async function seamEnvironment(stub: DurableObjectStub, environment: string): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as Internals).environment = environment;
  });
}

/**
 * Arm an alarm and dispatch it the way the platform does.
 *
 * The deadline is a minute out rather than now: workerd fires an alarm armed at
 * the current instant on its own, and a run this helper did not dispatch is a
 * run the test cannot observe the failure of. `runDurableObjectAlarm` runs a
 * pending alarm immediately whatever its deadline, so the dispatch is still the
 * only thing that runs it.
 *
 * The three ends are reported apart, because an invocation that rejected and
 * one that completed are different facts and a test that cannot tell them apart
 * asserts nothing: `ran` is the runtime's own answer that an alarm was
 * dispatched and returned, `rejected` an invocation that threw out of the gate,
 * and `none` no alarm pending to run at all.
 */
async function dispatchAlarm(
  stub: DurableObjectStub,
): Promise<{ outcome: "ran" | "rejected" | "none" }> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  try {
    return { outcome: (await runDurableObjectAlarm(stub)) ? "ran" : "none" };
  } catch {
    return { outcome: "rejected" };
  }
}

/** The record of the invocation that last reached its finalisation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function lastRecord(stub: DurableObjectStub): Promise<any> {
  return await runInDurableObject(stub, (instance) =>
    JSON.parse(JSON.stringify((instance as unknown as Internals).lastAlarm)),
  );
}

async function allKeys(stub: DurableObjectStub): Promise<string[]> {
  return await runInDurableObject(stub, async (_instance, state) =>
    [...(await state.storage.list<unknown>()).keys()],
  );
}

async function rowOf(projectId: number) {
  return await env.DB.prepare(
    "SELECT yjs_generation, yjs_seq, yjs_write, updated_at FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<Record<string, unknown>>();
}

/** Write keys straight into the object's storage, in batches the backend takes. */
async function plant(stub: DurableObjectStub, entries: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(entries);
  await runInDurableObject(stub, async (_instance, state) => {
    for (let start = 0; start < keys.length; start += 128) {
      const batch: Record<string, unknown> = {};
      for (const key of keys.slice(start, start + 128)) batch[key] = entries[key];
      await state.storage.put(batch);
    }
  });
}

/**
 * Real log records, through the codec.
 *
 * `bytes` above the codec's part limit is what makes a record a header and its
 * parts, so a fixture asking for one gets the physical population production
 * stores rather than a page of one-byte keys.
 */
async function plantRecords(
  stub: DurableObjectStub,
  generation: number,
  seqs: number[],
  bytes = 3,
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    for (const seq of seqs) {
      const payload = new Uint8Array(bytes).fill(seq & 0xff);
      await writeGroup(
        state.storage as unknown as LogStorage,
        encodeRecord(logKey(generation, seq), payload),
      );
    }
  });
}

function story0(doc: Y.Doc): Y.Map<unknown> {
  return doc.getArray<Y.Map<unknown>>("stories").get(0);
}

/** One loaded object with a socket attached, its alarm cancelled. */
async function loadedFixture(label: string): Promise<{
  fixture: Fixture;
  stub: DurableObjectStub;
  socket: Socket;
  state: Uint8Array;
}> {
  const fixture = await seedProject(label);
  const stub = diagStub(fixture.projectId);
  const socket = await openSocket(fixture, "new");
  const state = await drainAcceptanceFrames(socket);
  await cancelAlarm(stub);
  return { fixture, stub, socket, state };
}

/** A storage base folded by a real compaction, with the row left where it was. */
async function compactedFixture(label: string) {
  const opened = await loadedFixture(label);
  await installSeams(opened.stub);
  const failing = { on: true };
  await failBlobWrite(opened.stub, failing);
  let state = opened.state;
  for (let n = 1; n <= 25; n++) {
    state = clientEdit(opened.socket, state, (doc) => {
      story0(doc).set(`field_${n}`, String(n));
    });
  }
  await waitUntil(opened.stub, (doc) => story0(doc).get("field_25") === "25");
  await cancelAlarm(opened.stub);
  expect((await dispatchAlarm(opened.stub)).outcome).toBe("rejected");
  await cancelAlarm(opened.stub);
  const foldedAt = await runInDurableObject(opened.stub, (instance) =>
    (instance as unknown as Internals).docSeq,
  );
  return { ...opened, state, failing, foldedAt: foldedAt as number };
}

// ---------------------------------------------------------------------------
// A D1 seam, for the snapshot half's boundaries
// ---------------------------------------------------------------------------

interface D1Seam {
  onRun?: (sql: string, args: readonly unknown[]) => unknown;
  onFirst?: (sql: string, args: readonly unknown[]) => unknown;
  onBatch?: () => void;
}

function wrapStatement(
  stmt: D1PreparedStatement,
  sql: string,
  seam: D1Seam,
): D1PreparedStatement {
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
            const hook = boundProp === "run" ? seam.onRun : boundProp === "first" ? seam.onFirst : undefined;
            if (hook !== undefined) {
              return async () => {
                const handled = hook(sql, args);
                if (handled !== undefined) return handled;
                return await (Reflect.get(boundTarget, boundProp) as () => unknown).call(boundTarget);
              };
            }
            const value = Reflect.get(boundTarget, boundProp);
            return typeof value === "function" ? value.bind(boundTarget) : value;
          },
        });
      };
    },
  }) as D1PreparedStatement;
}

async function installD1Seam(stub: DurableObjectStub, seam: D1Seam): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals;
    const inner = internals.env.DB;
    internals.env = {
      ...internals.env,
      DB: {
        prepare: (sql: string) => wrapStatement(inner.prepare(sql), sql, seam),
        batch: (statements: unknown[]) => {
          seam.onBatch?.();
          return inner.batch(statements as never);
        },
      } as unknown as D1Database,
    };
  });
}

const BLOB_WRITE = /^UPDATE projects SET yjs_state/;
const REACQUIRE = /^SELECT yjs_generation, yjs_seq, yjs_write FROM projects/;

/** A `run` result that matched no row, which only a replacement can produce. */
const NO_ROWS = { meta: { changes: 0 } };

// ---------------------------------------------------------------------------
// 1. The read binds and loads nothing
// ---------------------------------------------------------------------------

describe("the read binds and loads nothing", () => {
  it("answers from memory and storage, writing neither", async () => {
    const fixture = await seedProject("diag-inert");
    const stub = diagStub(fixture.projectId);
    const before = await allKeys(stub);
    const rowBefore = await rowOf(fixture.projectId);
    const probe = await installProbe(stub);
    await runInDurableObject(stub, (instance) => {
      const internals = instance as unknown as Internals;
      internals.ensureDocLoaded = () => { throw new Error("the read must not load"); };
      internals.bindIdentity = () => { throw new Error("the read must not bind"); };
    });

    const first = await readDiagnostic(fixture);

    expect(first.status).toBe(200);
    expect(first.body.document.loaded).toBe(false);
    expect(first.body.identity).toEqual({
      projectId: fixture.projectId, memory: null, stored: null,
    });
    expect(first.body.base).toBeNull();
    expect(first.body.log.keys.first).toBeNull();
    expect(first.body.log.accounting).toBeNull();
    expect(first.body.row.ok).toBe(true);
    expect(first.body.object.coherent).toBe(false);

    expect(await allKeys(stub)).toEqual(before);
    const rowAfter = await rowOf(fixture.projectId);
    expect(rowAfter!.yjs_write).toBe(rowBefore!.yjs_write);
    expect(rowAfter!.updated_at).toBe(rowBefore!.updated_at);
    expect(probe.calls.filter((call) => call.operation === "put")).toEqual([]);
    expect(probe.calls.filter((call) => call.operation === "delete")).toEqual([]);

    const second = await readDiagnostic(fixture);
    expect(second.body.object.nonce).toBe(first.body.object.nonce);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. The read after a compaction
// ---------------------------------------------------------------------------

describe("the read after a compaction", () => {
  it("reports the folded base, validates it, and follows the log's extremes", async () => {
    const folded = await compactedFixture("diag-compacted");
    const { fixture, stub, foldedAt } = folded;

    const after = await readDiagnostic(fixture, "?validate=1");
    expect(after.body.base.header.generation).toBe(0);
    expect(after.body.base.header.seq).toBe(foldedAt);
    expect(after.body.base.validated).toBe(true);
    // The retirement drained the range below the base, and nothing has been
    // written above it yet.
    expect(after.body.log.keys.first).toBeNull();
    expect(after.body.row.seq).toBeLessThan(foldedAt);

    clientEdit(folded.socket, folded.state, (doc) => { story0(doc).set("later", "1"); });
    await waitUntil(stub, (doc) => story0(doc).get("later") === "1");
    await cancelAlarm(stub);

    const later = await readDiagnostic(fixture);
    expect(later.body.log.records.lowest).toBeGreaterThan(foldedAt);
    expect(later.body.log.records.highest).toBeGreaterThan(foldedAt);
    expect(later.body.row.seq).toBeLessThan(foldedAt);
  }, 60_000);

  it("names the codec's damage, a vanished base and an absent one apart", async () => {
    const fixture = await seedProject("diag-base-damage");
    const stub = diagStub(fixture.projectId);
    // A base of two full-sized parts, so the listing cases meet values of the
    // size production stores.
    const bytes = new Uint8Array(200 * 1024).fill(7);
    await runInDurableObject(stub, async (_instance, state) => {
      await writeGroup(state.storage as unknown as LogStorage, encodeBase(0, 40, bytes));
    });

    expect((await readDiagnostic(fixture, "?validate=1")).body.base.validated).toBe(true);

    // The codec's own errors, each tested apart.
    await plant(stub, { [`${baseKey(0)}:0001`]: new Uint8Array(96 * 1024).fill(9) });
    expect((await readDiagnostic(fixture, "?validate=1")).body.base.validated)
      .toEqual({ error: "checksum" });

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete([`${baseKey(0)}:0001`]);
    });
    expect((await readDiagnostic(fixture, "?validate=1")).body.base.validated)
      .toEqual({ error: "missing_part" });

    // The header standing at the first get and gone at the codec's own second
    // one, inside the same request: a base that vanished under the reader.
    const probe = await installProbe(stub);
    let headerGets = 0;
    probe.intercept = (operation, _phase, args, invoke) => {
      if (operation === "get" && args[0] === baseKey(0)) {
        headerGets += 1;
        if (headerGets === 2) return Promise.resolve(undefined);
      }
      return invoke();
    };
    expect((await readDiagnostic(fixture, "?validate=1")).body.base.validated)
      .toEqual({ error: "base_vanished" });
    probe.intercept = undefined;

    // A header that does not parse at all, and then one that is simply gone.
    await plant(stub, { [baseKey(0)]: { v: 1, parts: "many" } });
    expect((await readDiagnostic(fixture)).body.base).toEqual({ header: { error: "malformed" } });

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.delete([baseKey(0)]);
    });
    expect((await readDiagnostic(fixture)).body.base).toBeNull();

    // A storage refusal is neither damage nor absence.
    probe.intercept = (operation, _phase, args, invoke) => {
      if (operation === "get" && args[0] === baseKey(0)) throw new Error("storage down");
      return invoke();
    };
    const refused = await readDiagnostic(fixture);
    expect(refused.status).toBe(503);
    expect(refused.body).toBe("storage_unavailable");
  }, 60_000);

  it("issues nine calls on a cold production instance and refuses its options", async () => {
    const fixture = await seedProject("diag-budget");
    const stub = diagStub(fixture.projectId);
    // The population the figure is claimed against: a base the codec wrote,
    // records above the part limit — so each is a header and its parts — and a
    // log wider than one page at both ends, with values of the size production
    // stores.
    await runInDurableObject(stub, async (_instance, state) => {
      await writeGroup(
        state.storage as unknown as LogStorage,
        encodeBase(0, 1, new Uint8Array(200 * 1024).fill(5)),
      );
    });
    await plantRecords(stub, 0, Array.from({ length: 25 }, (_, i) => i + 2), 150 * 1024);
    const planted = (await allKeys(stub)).filter((key) => key.startsWith(logPrefix(0)));
    expect(planted.length).toBeGreaterThan(DIAG_PAGE * 2);
    await seamEnvironment(stub, "production");
    const probe = await installProbe(stub);

    const answer = await readDiagnostic(fixture);
    expect(answer.status).toBe(200);

    const reads = callsTagged(probe, "diagnostic");
    expect(reads).toHaveLength(PRODUCTION_CALLS);
    expect(reads.every((call) => call.operation === "get" || call.operation === "list")).toBe(true);
    expect(valueOccurrences(reads)).toBe(PRODUCTION_VALUES);
    // Every underlying read passes `noCache`, so what an operator is shown is
    // what storage holds rather than what the runtime last cached.
    expect(reads.every(uncached)).toBe(true);
    // One reverse page, and no more, whatever the log holds.
    expect(reversePages(reads)).toBe(PRODUCTION_REVERSE_PAGES);

    probe.calls.length = 0;
    const validate = await readDiagnostic(fixture, "?validate=1");
    expect(validate.status).toBe(403);
    expect(validate.body).toBe("diagnostic_controls_unavailable");
    const counted = await readDiagnostic(fixture, "?count=5");
    expect(counted.status).toBe(403);
    // Refused before any validation or counting read is issued.
    expect(probe.calls).toEqual([]);
  }, 30_000);

  it("widens the reverse scan, the validation and the ring on staging", async () => {
    const fixture = await seedProject("diag-staging-budget");
    const stub = diagStub(fixture.projectId);
    const bytes = new Uint8Array(300 * 1024).fill(3);
    await runInDurableObject(stub, async (_instance, state) => {
      await writeGroup(state.storage as unknown as LogStorage, encodeBase(0, 9, bytes));
    });
    // Eight full pages of non-headers, so the reverse scan spends its whole
    // staging budget and still establishes nothing.
    await plantOrphanParts(stub, DIAG_PAGE * STAGING_REVERSE_PAGES);
    const probe = await installProbe(stub);

    const answer = await readDiagnostic(fixture, "?validate=1&count=5");
    expect(answer.status).toBe(200);
    expect(answer.body.base.validated).toBe(true);
    expect(answer.body.log.records.highestUnknown).toBe(true);

    const reads = callsTagged(probe, "diagnostic");
    expect(reversePages(reads)).toBe(STAGING_REVERSE_PAGES);
    // Validation's batched part gets carry the option too, because the adapter
    // wraps the storage the diagnostic hands the codec.
    expect(reads.every(uncached)).toBe(true);
    expect(reads.some((call) => Array.isArray(call.args[0]))).toBe(true);
    expect(answer.body.counts.seq).toBe(5);
  }, 30_000);

  it("distinguishes a found, an exhausted and a capped reverse scan", async () => {
    const empty = await seedProject("diag-scan-empty");
    expect((await readDiagnostic(empty)).body.log.records)
      .toMatchObject({ highest: null, highestUnknown: false });

    const short = await seedProject("diag-scan-short");
    await plantOrphanParts(diagStub(short.projectId), 5);
    expect((await readDiagnostic(short)).body.log.records)
      .toMatchObject({ highest: null, highestUnknown: false });

    // Exactly one full page of non-headers, with a header standing beyond it:
    // production's single page is spent and the question stays open.
    const capped = await seedProject("diag-scan-capped");
    const cappedStub = diagStub(capped.projectId);
    await seamEnvironment(cappedStub, "production");
    await plantRecords(cappedStub, 0, [1]);
    await plantOrphanParts(cappedStub, DIAG_PAGE, 100, PART_LIMIT);
    const probe = await installProbe(cappedStub);
    const answer = await readDiagnostic(capped);
    expect(answer.body.log.records).toMatchObject({ highest: null, highestUnknown: true });
    expect(reversePages(callsTagged(probe, "diagnostic"))).toBe(PRODUCTION_REVERSE_PAGES);

    // Seven full reverse pages and a short eighth: the final permitted page
    // proves the prefix exhausted, so absence is established rather than left
    // open at the cap.
    const short8 = await seedProject("diag-scan-short-eighth");
    const short8Stub = diagStub(short8.projectId);
    await plantOrphanParts(short8Stub, DIAG_PAGE * (STAGING_REVERSE_PAGES - 1) + 5);
    const short8Probe = await installProbe(short8Stub);
    const short8Answer = await readDiagnostic(short8);
    expect(short8Answer.body.log.records)
      .toMatchObject({ highest: null, highestUnknown: false });
    expect(reversePages(callsTagged(short8Probe, "diagnostic"))).toBe(STAGING_REVERSE_PAGES);

    // An ordinary log answers from the first reverse page.
    const ordinary = await seedProject("diag-scan-ordinary");
    await plantRecords(diagStub(ordinary.projectId), 0, Array.from({ length: 40 }, (_, i) => i + 1));
    expect((await readDiagnostic(ordinary)).body.log.records)
      .toMatchObject({ lowest: 1, lowestUnknown: false, highest: 40, highestUnknown: false });
  }, 60_000);
});

/** Orphan part keys: they sort under the log prefix and are never headers. */
async function plantOrphanParts(
  stub: DurableObjectStub,
  count: number,
  from = 1000,
  bytes = 1,
): Promise<void> {
  const entries: Record<string, unknown> = {};
  for (let n = 0; n < count; n++) {
    entries[`${logKey(0, from + n)}:0001`] = new Uint8Array(bytes).fill(1);
  }
  await plant(stub, entries);
}

/** The memoised read of the two control flags, whichever consumer took it. */
function isFlagsRead(operation: string, args: readonly unknown[]): boolean {
  return operation === "get" && Array.isArray(args[0]) && args[0][0] === "diag:record";
}

/** Values a read could have touched: a key list, or one key, or a page limit. */
function valueOccurrences(calls: ReturnType<typeof callsTagged>): number {
  let total = 0;
  for (const call of calls) {
    if (call.operation === "get") {
      total += Array.isArray(call.args[0]) ? (call.args[0] as string[]).length : 1;
      continue;
    }
    total += ((call.args[0] as { limit?: number }).limit ?? 0);
  }
  return total;
}

function uncached(call: { operation: string; args: readonly unknown[] }): boolean {
  const options = call.operation === "get" ? call.args[1] : call.args[0];
  return (options as { noCache?: boolean } | undefined)?.noCache === true;
}

/** The counting listings, told from the read's own by the page width. */
function countingPages(calls: ReturnType<typeof callsTagged>): number {
  return calls.filter(
    (call) =>
      call.operation === "list" &&
      (call.args[0] as { limit?: number }).limit === COUNT_PAGE,
  ).length;
}

function reversePages(calls: ReturnType<typeof callsTagged>): number {
  return calls.filter(
    (call) =>
      call.operation === "list" &&
      (call.args[0] as { reverse?: boolean; limit?: number }).reverse === true &&
      (call.args[0] as { limit?: number }).limit === DIAG_PAGE,
  ).length;
}

// ---------------------------------------------------------------------------
// 3. Counting
// ---------------------------------------------------------------------------

describe("counting splits the log at the retirement's own bound", () => {
  it("classifies records, parts and malformed keys on each side", async () => {
    const fixture = await seedProject("diag-counts");
    const stub = diagStub(fixture.projectId);
    await plantRecords(stub, 0, [5, 100]);
    await plant(stub, {
      [`${logKey(0, 5)}:0001`]: new Uint8Array([1]),
      [`${logKey(0, 100)}:0001`]: new Uint8Array([1]),
      // Fifteen digits and a trailing character: under the prefix, refused by
      // the codec, and sorting on the side its digits put it.
      "log:0:000000000000005x": new Uint8Array([1]),
      "log:0:000000000000100x": new Uint8Array([1]),
    });

    const answer = await readDiagnostic(fixture, "?count=50");
    expect(answer.body.counts.seq).toBe(50);
    expect(answer.body.counts.below)
      .toEqual({ keys: 3, records: 1, parts: 1, malformed: 1, capped: false });
    expect(answer.body.counts.above)
      .toEqual({ keys: 3, records: 1, parts: 1, malformed: 1, capped: false });

    // At the codec's highest sequence there is no successor, so the prefix
    // alone bounds the range and everything is below it.
    const all = await readDiagnostic(fixture, `?count=${MAX_SEQ}`);
    expect(all.body.counts.below.keys).toBe(6);
    expect(all.body.counts.above)
      .toEqual({ keys: 0, records: 0, parts: 0, malformed: 0, capped: false });
  }, 30_000);

  it("caps a long count and says so", async () => {
    const fixture = await seedProject("diag-counts-capped");
    const stub = diagStub(fixture.projectId);
    const entries: Record<string, unknown> = {};
    for (let seq = 1; seq <= 4097; seq++) entries[logKey(0, seq)] = new Uint8Array([1]);
    await plant(stub, entries);

    const answer = await readDiagnostic(fixture, `?count=${MAX_SEQ}`);
    expect(answer.body.counts.below.capped).toBe(true);
    expect(answer.body.counts.below.keys).toBe(4096);
    expect(answer.body.counts.pages).toBe(32);
  }, 60_000);

  it("spends one budget of listings on the request, below first", async () => {
    const fixture = await seedProject("diag-counts-one-budget");
    const stub = diagStub(fixture.projectId);
    // Thirty-one full pages and a short thirty-second below the bound: the
    // whole budget is spent, and the side still establishes its own counts.
    const below: Record<string, unknown> = {};
    for (let seq = 1; seq <= COUNT_BUDGET_RECORDS; seq++) {
      below[logKey(0, seq)] = new Uint8Array([1]);
    }
    for (let seq = 1; seq <= COUNT_BUDGET_PARTS; seq++) {
      below[`${logKey(0, seq)}:0001`] = new Uint8Array([1]);
    }
    await plant(stub, below);
    // Above it, a population the request has no listing left to reach.
    await plantRecords(stub, 0, [9000, 9001]);
    await plant(stub, { [`${logKey(0, 9000)}:0001`]: new Uint8Array([1]) });
    const probe = await installProbe(stub);

    const answer = await readDiagnostic(fixture, `?count=${COUNT_BUDGET_RECORDS}`);

    expect(answer.body.counts.pages).toBe(COUNT_PAGES);
    expect(answer.body.counts.below).toEqual({
      keys: COUNT_BUDGET_RECORDS + COUNT_BUDGET_PARTS,
      records: COUNT_BUDGET_RECORDS,
      parts: COUNT_BUDGET_PARTS,
      malformed: 0,
      capped: false,
    });
    // Nothing left for the far side: zero counts under `capped`, and not one
    // listing of its own.
    expect(answer.body.counts.above)
      .toEqual({ keys: 0, records: 0, parts: 0, malformed: 0, capped: true });
    expect(countingPages(callsTagged(probe, "diagnostic"))).toBe(COUNT_PAGES);
  }, 60_000);

  it("refuses a count outside staging", async () => {
    const fixture = await seedProject("diag-counts-production");
    await seamEnvironment(diagStub(fixture.projectId), "production");
    const answer = await readDiagnostic(fixture, "?count=5");
    expect(answer.status).toBe(403);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. The record
// ---------------------------------------------------------------------------

/** An unloaded, socketless object that can name its project and owes cleanup. */
async function cleanupFixture(label: string, seqs: number[], floor = 50) {
  const fixture = await seedProject(label);
  const stub = diagStub(fixture.projectId);
  await plant(stub, { projectId: fixture.projectId });
  await runInDurableObject(stub, async (_instance, state) => {
    await writeGroup(
      state.storage as unknown as LogStorage,
      encodeBase(0, floor, new Uint8Array([1, 2, 3])),
    );
  });
  await plantRecords(stub, 0, seqs);
  await cancelAlarm(stub);
  return { fixture, stub };
}

describe("the alarm's record describes what each phase found and spent", () => {
  it("carries the cleanup branch's entry, counts and outcome", async () => {
    const seqs = Array.from({ length: 10 }, (_, i) => i + 1);
    const { fixture, stub } = await cleanupFixture("diag-record-cleanup", seqs);
    expect((await setControl(fixture, "record", "1")).status).toBe(200);
    const probe = await installProbe(stub);

    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    const record = await lastRecord(stub);

    expect(record.kind).toBe("ran");
    expect(record.retirement.branch).toBe("cleanup");
    expect(record.retirement.entry.floor).toBe(50);
    expect(record.retirement.entry.eligible.keys).toBe(seqs.length);
    expect(record.retirement.deleted).toBe(seqs.length);
    expect(record.retirement.firstDeleted).toBe(logKey(0, 1));
    expect(record.retirement.lastDeleted).toBe(logKey(0, 10));
    expect(record.retirement.outcome).toBe("complete");
    // The phase's own listings and deletions, as the probe counted them under
    // that phase's tag.
    expect(record.retirement.lists).toBe(callsTagged(probe, "retirement", "list").length);
    expect(record.retirement.deleteCalls)
      .toBe(callsTagged(probe, "retirement", "delete").length);
    // The entry scans are the diagnostic's, and the phase's own calls follow
    // them under the phase's tag again.
    expect(callsTagged(probe, "diagnostic", "list").length).toBeGreaterThan(0);
    expect(record.maintenance.entry.eligible.headerPresent).toBe(true);
    expect(record.snapshot).toEqual({
      ran: false,
      skipped: "no_sockets",
      entry: null,
      encodedSeq: null,
      blob: { outcome: "not_attempted", seq: null },
      header: "not_attempted",
      retirement: null,
      batch: { outcome: "not_attempted", reason: "snapshot_skipped" },
    });
  }, 30_000);

  it("captures nothing and lists nothing extra with recording off", async () => {
    const { fixture, stub } = await cleanupFixture("diag-record-off", [1, 2, 3]);
    const probe = await installProbe(stub);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    } finally {
      log.mockRestore();
    }

    const record = await lastRecord(stub);
    expect(record.recording).toBe(false);
    expect(record.maintenance.entry.eligible).toBeNull();
    expect(record.retirement.entry.eligible).toBeNull();
    // Exactly the two fields, and no observation nobody made: with recording
    // off the finalisation neither settles the attempts nor reads the alarm.
    expect(record.scheduling).toEqual({ finaliser: "none", scheduleSnapshotCalls: 0 });
    expect(lines.filter((line) => line.includes("[diagnostic]"))).toEqual([]);
    expect(callsTagged(probe, "diagnostic")).toEqual([]);
  }, 30_000);

  it("keeps the counts a rejected deletion reached", async () => {
    const seqs = Array.from({ length: 300 }, (_, i) => i + 1);
    const { fixture, stub } = await cleanupFixture("diag-record-rejected", seqs, 400);
    await setControl(fixture, "record", "1");
    await installSeams(stub, { retirement: { deletes: 300, lists: 8 } });
    const probe = await installProbe(stub);
    let deletions = 0;
    probe.intercept = (operation, phase, _args, invoke) => {
      if (operation === "delete" && phase === "retirement") {
        deletions += 1;
        if (deletions === 2) throw new Error("storage down");
      }
      return invoke();
    };

    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    const record = await lastRecord(stub);

    expect(record.retirement.outcome).toBe("rejected");
    expect(record.retirement.deleteCalls).toBe(2);
    expect(record.retirement.deleted).toBe(128);
  }, 30_000);

  it("counts and sweeps one old generation, leaving its neighbours alone", async () => {
    const fixture = await seedProject("diag-maintenance-generations");
    const stub = diagStub(fixture.projectId);
    await plant(stub, { projectId: fixture.projectId, docGeneration: 11, maintenanceFloor: 1 });
    await plantRecords(stub, 1, [1, 2]);
    await plantRecords(stub, 10, [1, 2, 3]);
    await plant(stub, {
      [baseKey(1)]: { v: 1, parts: 1, length: 1, checksum: 0, generation: 1, seq: 1 },
      [`${baseKey(1)}:0001`]: new Uint8Array([1]),
      [haltKey(1)]: { v: 1, reason: "log_corrupt", at: 1 },
      [baseKey(10)]: { v: 1, parts: 1, length: 1, checksum: 0, generation: 10, seq: 1 },
    });
    await cancelAlarm(stub);
    await setControl(fixture, "record", "1");

    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    const record = await lastRecord(stub);

    expect(record.maintenance.entry.generation).toBe(1);
    expect(record.maintenance.entry.eligible.log.keys).toBe(2);
    expect(record.maintenance.entry.eligible.base.keys).toBe(2);
    expect(record.maintenance.entry.eligible.halt.keys).toBe(1);
    const left = await allKeys(stub);
    expect(left.filter((key) => key.startsWith("log:1:"))).toEqual([]);
    expect(left.filter((key) => key.startsWith("log:10:"))).toHaveLength(3);
    expect(left).toContain(baseKey(10));
  }, 30_000);

  it("counts orphans only where no header at all stands over them", async () => {
    const parts = {
      [`${baseKey(0)}:0001`]: new Uint8Array([1]),
      [`${baseKey(0)}:0002`]: new Uint8Array([2]),
    };

    const readable = await seedProject("diag-orphans-readable");
    const readableStub = diagStub(readable.projectId);
    await plant(readableStub, {
      projectId: readable.projectId,
      // A header naming ONE part, with a surplus part beside it.
      [baseKey(0)]: { v: 1, parts: 1, length: 1, checksum: 0, generation: 0, seq: 1 },
      ...parts,
    });
    await cancelAlarm(readableStub);
    await setControl(readable, "record", "1");
    expect((await dispatchAlarm(readableStub)).outcome).toBe("ran");
    const readableRecord = await lastRecord(readableStub);
    expect(readableRecord.maintenance.entry.eligible.headerPresent).toBe(true);
    expect(readableRecord.maintenance.entry.eligible.orphans.keys).toBe(0);
    expect(await allKeys(readableStub)).toEqual(expect.arrayContaining(Object.keys(parts)));

    const malformed = await seedProject("diag-orphans-malformed");
    const malformedStub = diagStub(malformed.projectId);
    await plant(malformedStub, {
      projectId: malformed.projectId,
      [baseKey(0)]: "not a header",
      ...parts,
    });
    await cancelAlarm(malformedStub);
    await setControl(malformed, "record", "1");
    expect((await dispatchAlarm(malformedStub)).outcome).toBe("ran");
    const malformedRecord = await lastRecord(malformedStub);
    expect(malformedRecord.maintenance.entry.eligible.headerPresent).toBe(true);
    expect(malformedRecord.maintenance.entry.eligible.orphans.keys).toBe(0);
    expect(await allKeys(malformedStub)).toEqual(expect.arrayContaining(Object.keys(parts)));

    const absent = await seedProject("diag-orphans-absent");
    const absentStub = diagStub(absent.projectId);
    await plant(absentStub, { projectId: absent.projectId, ...parts });
    await cancelAlarm(absentStub);
    await setControl(absent, "record", "1");
    expect((await dispatchAlarm(absentStub)).outcome).toBe("ran");
    const absentRecord = await lastRecord(absentStub);
    expect(absentRecord.maintenance.entry.eligible.headerPresent).toBe(false);
    expect(absentRecord.maintenance.entry.eligible.orphans.keys).toBe(2);
    expect((await allKeys(absentStub)).filter((key) => key.startsWith(`${baseKey(0)}:`)))
      .toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. The snapshot's record
// ---------------------------------------------------------------------------

/** What the snapshot half was about to write, read before the alarm runs. */
async function pendingWrite(stub: DurableObjectStub) {
  return await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Internals & {
      docWrite: number | null;
    };
    return {
      held: internals.docWrite as number,
      generation: internals.docGeneration as number,
      seq: internals.docSeq as number,
    };
  });
}

/** A row the reacquisition will read, in the shape D1 hands one back. */
function reacquired(generation: number, seq: number, revision: number) {
  return { yjs_generation: generation, yjs_seq: seq, yjs_write: revision };
}

/** One loaded object with a socket, recording on and its alarm cancelled. */
async function recordingFixture(label: string) {
  const opened = await loadedFixture(label);
  expect((await setControl(opened.fixture, "record", "1")).status).toBe(200);
  await cancelAlarm(opened.stub);
  return opened;
}

/** Leave the snapshot with no entity statements to run. */
async function emptyStatements(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const internals = instance as unknown as Record<string, unknown>;
    internals.snapshotConfig = async () => { /* nothing to write */ };
    internals.snapshotStories = async () => false;
    internals.snapshotObjects = async () => false;
    internals.snapshotGlossary = async () => false;
    internals.snapshotPages = async () => false;
    internals.snapshotEntityContributors = () => [];
    internals.snapshotEditingTime = () => [];
    internals.snapshotContributions = async () => [];
  });
}

describe("the snapshot half's record names each write's own boundary", () => {
  it("records a landed blob, a retired header and a landed batch", async () => {
    const { fixture, stub } = await recordingFixture("diag-snapshot-landed");

    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    const record = await lastRecord(stub);

    expect(record.snapshot.ran).toBe(true);
    expect(record.snapshot.skipped).toBeNull();
    expect(record.snapshot.entry.floor).toBe(0);
    expect(record.snapshot.entry.eligible.below.keys).toBe(0);
    expect(record.snapshot.entry.eligible.above).toBeDefined();
    expect(record.snapshot.encodedSeq).toBe(record.snapshot.blob.seq);
    expect(record.snapshot.blob.outcome).toBe("landed");
    expect(record.snapshot.header).toBe("retired");
    expect(record.snapshot.retirement.outcome).toBe("complete");
    expect(record.snapshot.batch.outcome).toBe("landed");
    expect((await rowOf(fixture.projectId))!.yjs_seq).toBe(record.snapshot.blob.seq);
  }, 30_000);

  it("records a failure before the encoding as nothing attempted", async () => {
    const { stub } = await recordingFixture("diag-snapshot-early");
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as Internals).refusePastHalt = () => {
        throw new Error("refused before the encoding");
      };
    });

    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    const record = await lastRecord(stub);

    expect(record.kind).toBe("failed");
    expect(record.snapshot.blob).toEqual({ outcome: "not_attempted", seq: null });
    expect(record.snapshot.batch.reason).toBe("snapshot_skipped");
    expect(record.snapshot.header).toBe("not_attempted");
  }, 30_000);

  it("settles a blob write that matched no row three different ways", async () => {
    const adopted = await recordingFixture("diag-blob-adopted");
    const at = await pendingWrite(adopted.stub);
    await installD1Seam(adopted.stub, {
      onRun: (sql) => (BLOB_WRITE.test(sql) ? NO_ROWS : undefined),
      onFirst: (sql) =>
        REACQUIRE.test(sql) ? reacquired(at.generation, at.seq, at.held + 1) : undefined,
    });
    // The seam leaves the real row where it was, so the batch that follows the
    // adoption fails on its own guard: what is asserted here is the blob's own
    // boundary, which is where the adoption was settled.
    expect((await dispatchAlarm(adopted.stub)).outcome).toBe("rejected");
    expect((await lastRecord(adopted.stub)).snapshot.blob)
      .toEqual({ outcome: "adopted", seq: at.seq });

    const unchanged = await recordingFixture("diag-blob-unchanged");
    const still = await pendingWrite(unchanged.stub);
    await installD1Seam(unchanged.stub, {
      onRun: (sql) => (BLOB_WRITE.test(sql) ? NO_ROWS : undefined),
      onFirst: (sql) => (REACQUIRE.test(sql) ? reacquired(0, 0, still.held) : undefined),
    });
    expect((await dispatchAlarm(unchanged.stub)).outcome).toBe("rejected");
    const unchangedRecord = await lastRecord(unchanged.stub);
    expect(unchangedRecord.snapshot.blob).toEqual({ outcome: "not_landed", seq: null });
    expect(unchangedRecord.snapshot.batch.reason).toBe("blob_not_landed");

    const refused = await recordingFixture("diag-blob-refused");
    const lost = await pendingWrite(refused.stub);
    await installD1Seam(refused.stub, {
      onRun: (sql) => (BLOB_WRITE.test(sql) ? NO_ROWS : undefined),
      onFirst: (sql) => (REACQUIRE.test(sql) ? reacquired(0, 0, lost.held + 5) : undefined),
    });
    expect((await dispatchAlarm(refused.stub)).outcome).toBe("rejected");
    const refusedRecord = await lastRecord(refused.stub);
    expect(refusedRecord.snapshot.blob.outcome).toBe("refused");
    // The reason is set before the settlement, so a refusal that throws through
    // it still says why the batch did not run.
    expect(refusedRecord.snapshot.batch)
      .toEqual({ outcome: "not_attempted", reason: "blob_not_landed" });
    // A refusal is the one conclusion that halts.
    expect(await runInDurableObject(refused.stub, (instance) =>
      (instance as unknown as { persistenceHalted: unknown }).persistenceHalted !== null,
    )).toBe(true);
  }, 60_000);

  it("never fabricates a refusal from a reacquisition it could not take", async () => {
    const down = await recordingFixture("diag-blob-unavailable");
    await installD1Seam(down.stub, {
      onRun: (sql) => (BLOB_WRITE.test(sql) ? NO_ROWS : undefined),
      onFirst: (sql) => {
        if (REACQUIRE.test(sql)) throw new Error("D1 is unreachable");
        return undefined;
      },
    });
    expect((await dispatchAlarm(down.stub)).outcome).toBe("rejected");
    const downRecord = await lastRecord(down.stub);
    expect(downRecord.snapshot.blob)
      .toEqual({ outcome: "unresolved", seq: null, cause: "unavailable" });
    expect(downRecord.snapshot.batch)
      .toEqual({ outcome: "not_attempted", reason: "blob_not_landed" });
    expect(await runInDurableObject(down.stub, (instance) =>
      (instance as unknown as { persistenceHalted: unknown }).persistenceHalted,
    )).toBeNull();

    const malformed = await recordingFixture("diag-blob-generation");
    await installD1Seam(malformed.stub, {
      onRun: (sql) => (BLOB_WRITE.test(sql) ? NO_ROWS : undefined),
    });
    const probe = await installProbe(malformed.stub);
    let generationReads = 0;
    probe.intercept = (operation, phase, args, invoke) => {
      if (operation === "get" && phase === "snapshot" && args[0] === "docGeneration") {
        generationReads += 1;
        // The snapshot's own read stands; the reacquisition's does not parse.
        if (generationReads === 2) return Promise.resolve("not a generation");
      }
      return invoke();
    };
    expect((await dispatchAlarm(malformed.stub)).outcome).toBe("rejected");
    const malformedRecord = await lastRecord(malformed.stub);
    expect(malformedRecord.snapshot.blob)
      .toEqual({ outcome: "unresolved", seq: null, cause: "generation_malformed" });
    expect(malformedRecord.snapshot.batch)
      .toEqual({ outcome: "not_attempted", reason: "blob_not_landed" });
    expect(await runInDurableObject(malformed.stub, (instance) =>
      (instance as unknown as { persistenceHalted: unknown }).persistenceHalted,
    )).toBeNull();
  }, 60_000);

  it("records a blob write that threw and a row that had not moved", async () => {
    const { stub } = await recordingFixture("diag-blob-threw");
    const at = await pendingWrite(stub);
    await installD1Seam(stub, {
      onRun: (sql) => {
        if (BLOB_WRITE.test(sql)) throw new Error("D1_ERROR: the blob write was refused");
        return undefined;
      },
      onFirst: (sql) => (REACQUIRE.test(sql) ? reacquired(0, 0, at.held) : undefined),
    });

    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    expect((await lastRecord(stub)).snapshot.blob.outcome).toBe("not_landed");
  }, 30_000);

  it("stops before the batch when the header could not be retired", async () => {
    const { stub } = await recordingFixture("diag-header-failed");
    const probe = await installProbe(stub);
    probe.intercept = (operation, phase, args, invoke) => {
      const keys = args[0];
      if (operation === "delete" && phase === "snapshot" && Array.isArray(keys)
        && keys.length === 1 && keys[0] === baseKey(0)) {
        throw new Error("storage down");
      }
      return invoke();
    };

    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    const record = await lastRecord(stub);
    expect(record.snapshot.header).toBe("failed");
    expect(record.snapshot.blob.outcome).toBe("landed");
    expect(record.snapshot.batch.reason).toBe("header_failed");
  }, 30_000);

  it("records a batch with nothing to run as nothing attempted", async () => {
    const { stub } = await recordingFixture("diag-batch-empty");
    await emptyStatements(stub);

    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    const record = await lastRecord(stub);
    expect(record.snapshot.blob.outcome).toBe("landed");
    expect(record.snapshot.batch).toEqual({ outcome: "not_attempted", reason: "no_statements" });
  }, 30_000);

  it("settles a batch that threw three different ways", async () => {
    const unchanged = await recordingFixture("diag-batch-unchanged");
    await installD1Seam(unchanged.stub, {
      onBatch: () => { throw new Error("the batch was refused"); },
    });
    expect((await dispatchAlarm(unchanged.stub)).outcome).toBe("rejected");
    const unchangedRecord = await lastRecord(unchanged.stub);
    expect(unchangedRecord.snapshot.batch.outcome).toBe("not_landed");
    expect(unchangedRecord.kind).toBe("failed");
    expect(unchangedRecord.scheduling.finaliser).toBe("skipped");
    expect(unchangedRecord.scheduling.scheduleSnapshotCalls).toBe(1);

    const adopted = await recordingFixture("diag-batch-adopted");
    const at = await pendingWrite(adopted.stub);
    await installD1Seam(adopted.stub, {
      onBatch: () => { throw new Error("the batch was refused"); },
      onFirst: (sql) =>
        REACQUIRE.test(sql) ? reacquired(at.generation, at.seq, at.held + 2) : undefined,
    });
    expect((await dispatchAlarm(adopted.stub)).outcome).toBe("ran");
    expect((await lastRecord(adopted.stub)).snapshot.batch.outcome).toBe("adopted");

    const unresolved = await recordingFixture("diag-batch-unresolved");
    await installD1Seam(unresolved.stub, {
      onBatch: () => { throw new Error("the batch was refused"); },
      onFirst: (sql) => {
        if (REACQUIRE.test(sql)) throw new Error("D1 is unreachable");
        return undefined;
      },
    });
    expect((await dispatchAlarm(unresolved.stub)).outcome).toBe("rejected");
    expect((await lastRecord(unresolved.stub)).snapshot.batch)
      .toMatchObject({ outcome: "unresolved", cause: "unavailable" });

    const refused = await recordingFixture("diag-batch-refused");
    const lost = await pendingWrite(refused.stub);
    await installD1Seam(refused.stub, {
      onBatch: () => { throw new Error("the batch was refused"); },
      onFirst: (sql) => (REACQUIRE.test(sql) ? reacquired(0, 0, lost.held + 7) : undefined),
    });
    expect((await dispatchAlarm(refused.stub)).outcome).toBe("rejected");
    expect((await lastRecord(refused.stub)).snapshot.batch.outcome).toBe("refused");
  }, 60_000);

  it("carries a throwing scheduler out as the invocation's own failure", async () => {
    const { stub } = await recordingFixture("diag-scheduler-threw");
    const probe = await installProbe(stub);
    probe.intercept = (operation, phase, _args, invoke) => {
      if (operation === "setAlarm" && phase === "none") throw new Error("storage down");
      return invoke();
    };

    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    const record = await lastRecord(stub);
    expect(record.kind).toBe("failed");
    expect(record.scheduling.finaliser).toBe("skipped");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 6. Scheduling attempts
// ---------------------------------------------------------------------------

/** An alarm whose batch fails with the row unmoved: one scheduling attempt. */
async function schedulingFixture(label: string) {
  const opened = await recordingFixture(label);
  await installD1Seam(opened.stub, {
    onBatch: () => { throw new Error("the batch was refused"); },
  });
  return opened;
}

function held(delay: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), delay));
}

describe("the finalisation observes the scheduling attempts it counted", () => {
  it("reports the alarm it armed once the attempt has settled", async () => {
    const { stub } = await schedulingFixture("diag-scheduling-settled");
    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    const record = await lastRecord(stub);

    expect(record.scheduling.scheduleSnapshotCalls).toBe(1);
    expect(record.scheduling.unsettledScheduling).toBe(0);
    // What the attempt armed, read after it settled: thirty seconds out.
    expect(record.scheduling.pendingAlarmAt).toBeGreaterThan(Date.now() + 20_000);
    // A recording invocation carries all three settlement fields, and the read
    // that answered says so.
    expect(record.scheduling.pendingAlarmUnread).toBe(false);
  }, 30_000);

  it("does not overwrite an alarm already pending when it reads one", async () => {
    const { stub } = await schedulingFixture("diag-scheduling-armed-within");
    const probe = await installProbe(stub);
    const armed: number[] = [];
    const established = Date.now() + 45_000;

    // The platform's own storage handle, captured once so the plant below can
    // run from inside the guard's own read rather than as a separate call
    // racing it: a fresh top-level call on the same stub queues behind an
    // invocation already in flight, so it cannot land in the gap this case
    // needs, between the dispatch's alarm being consumed and this invocation
    // reading what stands pending.
    let rawStorage!: DurableObjectStorage;
    await runInDurableObject(stub, (_instance, state) => {
      rawStorage = state.storage;
    });

    probe.intercept = (operation, phase, args, invoke) => {
      if (operation === "setAlarm") armed.push(args[0] as number);
      // Planted immediately before the real `getAlarm`, so the guard reads a
      // deadline this invocation did not arm rather than the absence the
      // dispatch's own consumption left behind.
      if (operation === "getAlarm" && phase === "snapshot") {
        return rawStorage.setAlarm(established).then(() => invoke());
      }
      return invoke();
    };

    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    const record = await lastRecord(stub);

    // The guard must read this deadline and return without arming a new one;
    // removing it overwrites the planted deadline with a fresh arm, which
    // both assertions below then catch.
    expect(armed).toHaveLength(0);
    expect(record.scheduling.pendingAlarmAt).toBe(established);
  }, 30_000);

  it("waits on an arm delayed inside the bound and reports what it armed", async () => {
    const { stub } = await schedulingFixture("diag-scheduling-slow-settled");
    const probe = await installProbe(stub);
    const armed: number[] = [];
    probe.intercept = (operation, phase, args, invoke) => {
      if (operation === "setAlarm" && phase === "snapshot") {
        armed.push(args[0] as number);
        // Delayed, and inside the one-second bound: the observation follows
        // the settlement rather than racing it.
        return held(300).then(() => invoke());
      }
      return invoke();
    };

    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    const record = await lastRecord(stub);

    expect(record.scheduling.scheduleSnapshotCalls).toBe(1);
    expect(record.scheduling.unsettledScheduling).toBe(0);
    expect(armed).toHaveLength(1);
    expect(record.scheduling.pendingAlarmAt).toBe(armed[0]);
  }, 30_000);

  it("counts an attempt whose getAlarm is delayed past the bound", async () => {
    const { stub } = await schedulingFixture("diag-scheduling-slow-get");
    const probe = await installProbe(stub);
    probe.intercept = (operation, phase, _args, invoke) => {
      if (operation === "getAlarm" && phase === "snapshot") return held(2_000);
      return invoke();
    };

    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    expect((await lastRecord(stub)).scheduling.unsettledScheduling).toBe(1);
  }, 30_000);

  it("counts an attempt whose setAlarm never settles inside the bound", async () => {
    const { stub } = await schedulingFixture("diag-scheduling-slow-set");
    const probe = await installProbe(stub);
    probe.intercept = (operation, phase, _args, invoke) => {
      // The nested call, not the outer one: an attempt is unsettled only if
      // the returned chain actually awaits its `setAlarm`.
      if (operation === "setAlarm" && phase === "snapshot") return held(2_000);
      return invoke();
    };

    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    const record = await lastRecord(stub);
    expect(record.scheduling.scheduleSnapshotCalls).toBe(1);
    expect(record.scheduling.unsettledScheduling).toBe(1);
  }, 30_000);

  it("settles a rejected attempt rather than waiting for it", async () => {
    for (const operation of ["getAlarm", "setAlarm"]) {
      const { stub } = await schedulingFixture(`diag-scheduling-rejects-${operation}`);
      const probe = await installProbe(stub);
      probe.intercept = (called, phase, _args, invoke) => {
        if (called === operation && phase === "snapshot") throw new Error("storage down");
        return invoke();
      };

      expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
      const record = await lastRecord(stub);
      expect(record.scheduling.scheduleSnapshotCalls, operation).toBe(1);
      expect(record.scheduling.unsettledScheduling, operation).toBe(0);
      // The read of the pending alarm is the finalisation's own, and a
      // rejection of it is reported rather than thrown.
      expect(record.scheduling.pendingAlarmUnread, operation).toBe(false);
    }
  }, 60_000);

  it("takes neither the settle nor the read with recording off", async () => {
    const opened = await loadedFixture("diag-scheduling-off");
    await installD1Seam(opened.stub, {
      onBatch: () => { throw new Error("the batch was refused"); },
    });
    const probe = await installProbe(opened.stub);

    expect((await dispatchAlarm(opened.stub)).outcome).toBe("rejected");
    const record = await lastRecord(opened.stub);
    expect(record.scheduling).toEqual({ finaliser: "skipped", scheduleSnapshotCalls: 1 });
    expect(callsTagged(probe, "none", "getAlarm")).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 7. The hold
// ---------------------------------------------------------------------------

describe("the hold suppresses every phase and the last-disconnect drain", () => {
  it("records a held invocation that lists, deletes and snapshots nothing", async () => {
    const seqs = Array.from({ length: 10 }, (_, i) => i + 1);
    const { fixture, stub } = await cleanupFixture("diag-hold-alarm", seqs);
    await setControl(fixture, "record", "1");
    expect((await setControl(fixture, "hold", "1")).body).toEqual({
      recording: true, held: true,
    });
    const probe = await installProbe(stub);

    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    const record = await lastRecord(stub);

    expect(record.kind).toBe("held");
    expect(record.preflight.held).toBe(true);
    expect(record.snapshot).toBeNull();
    expect(record.retirement).toBeNull();
    expect(callsTagged(probe, "maintenance")).toEqual([]);
    expect(callsTagged(probe, "retirement")).toEqual([]);
    expect(record.scheduling.pendingAlarmAt).toBeNull();
    // The prepared debt is exactly where the fixture left it.
    expect((await allKeys(stub)).filter((key) => key.startsWith(logPrefix(0))))
      .toHaveLength(seqs.length);

    // Released, the alarm the release arms runs the work the hold suppressed.
    expect((await setControl(fixture, "hold", "0")).body).toEqual({
      recording: true, held: false,
    });
    await vi.waitFor(async () => {
      const released = await lastRecord(stub);
      expect(released.kind).toBe("ran");
      expect(released.retirement.deleted).toBe(seqs.length);
    }, { timeout: 10_000 });
    await cancelAlarm(stub);
  }, 30_000);

  it("suppresses the drain a disconnect would otherwise run, across an eviction", async () => {
    const opened = await loadedFixture("diag-hold-drain");
    expect((await setControl(opened.fixture, "hold", "1")).status).toBe(200);
    const before = await rowOf(opened.fixture.projectId);

    opened.socket.ws.close();
    await vi.waitFor(async () => {
      expect(await runInDurableObject(opened.stub, (_i, s) => s.getWebSockets().length)).toBe(0);
    }, { timeout: 5000 });
    await cancelAlarm(opened.stub);
    expect((await rowOf(opened.fixture.projectId))!.yjs_write).toBe(before!.yjs_write);

    // A fresh instance reads the flag from storage and suppresses its first
    // drain in the same way.
    await hibernate(opened.stub);
    const readmitted = await openSocket(opened.fixture, "0");
    await drainAcceptanceFrames(readmitted);
    await cancelAlarm(opened.stub);
    const afterLoad = await rowOf(opened.fixture.projectId);
    readmitted.ws.close();
    await vi.waitFor(async () => {
      expect(await runInDurableObject(opened.stub, (_i, s) => s.getWebSockets().length)).toBe(0);
    }, { timeout: 5000 });
    await cancelAlarm(opened.stub);
    expect((await rowOf(opened.fixture.projectId))!.yjs_write).toBe(afterLoad!.yjs_write);
  }, 60_000);

  it("keeps the flag across a reset through the internal route", async () => {
    const { fixture, stub } = await cleanupFixture("diag-hold-reset", [1, 2]);
    await setControl(fixture, "hold", "1");

    const reset = await stub.fetch(
      await signedFor(fixture, "/reset?expectedGeneration=0", "reset", { binding: "0" }),
    );
    await reset.text();
    await cancelAlarm(stub);

    expect((await readDiagnostic(fixture)).body.controls).toEqual({
      recording: false, held: true,
    });
  }, 30_000);

  it("refuses the hold while a snapshot is still in flight", async () => {
    const opened = await loadedFixture("diag-hold-in-flight");
    const probe = await installProbe(opened.stub);
    // A real snapshot, held open at a storage operation of its own rather than
    // by a flag set from outside: what the acknowledgement has to mean is that
    // no snapshot is running, and only a running one can establish that. The
    // delay is taken BEFORE the underlying call, so the object's input gate is
    // open and the control below is delivered rather than queued behind it.
    probe.intercept = (operation, _phase, args, invoke) => {
      const keys = args[0];
      if (operation === "delete" && Array.isArray(keys) && keys[0] === baseKey(0)) {
        return held(1_500).then(() => invoke());
      }
      return invoke();
    };
    const running = runInDurableObject(opened.stub, async (instance) => {
      await (instance as unknown as Internals).snapshotToD1();
    });
    await vi.waitFor(async () => {
      expect(await runInDurableObject(opened.stub, (instance) =>
        (instance as unknown as Internals).isSnapshotting)).toBe(true);
    }, { timeout: 5_000 });

    const refused = await setControl(opened.fixture, "hold", "1");
    expect(refused.status).toBe(409);
    expect(refused.body).toBe("snapshot_in_flight");

    await running;
    probe.intercept = undefined;
    expect(await runInDurableObject(opened.stub, (instance) =>
      (instance as unknown as Internals).isSnapshotting)).toBe(false);
    // The flag was never set under the refusal, and the retry lands.
    expect((await readDiagnostic(opened.fixture)).body.controls.held).toBe(false);
    expect((await setControl(opened.fixture, "hold", "1")).status).toBe(200);
    expect((await readDiagnostic(opened.fixture)).body.controls.held).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 8. The controls' gate and their one initialisation path
// ---------------------------------------------------------------------------

describe("the controls are staging's alone and are read once per instance", () => {
  it("refuses the controls and normalises the flags off outside staging", async () => {
    const fixture = await seedProject("diag-controls-production");
    const stub = diagStub(fixture.projectId);
    await plant(stub, { "diag:record": true, "diag:hold": true, projectId: fixture.projectId });
    await plantRecords(stub, 0, [1, 2, 3]);
    await cancelAlarm(stub);
    await seamEnvironment(stub, "production");

    const refused = await setControl(fixture, "record", "1");
    expect(refused.status).toBe(403);
    expect(refused.body).toBe("diagnostic_controls_unavailable");
    expect((await readDiagnostic(fixture)).body.controls)
      .toEqual({ recording: false, held: false });

    // A planted hold does not hold the alarm.
    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    expect((await lastRecord(stub)).kind).toBe("ran");
  }, 30_000);

  it("lands each control, reports it, and forgets the ring on record=0", async () => {
    const { fixture, stub } = await cleanupFixture("diag-controls-staging", [1, 2]);
    expect((await setControl(fixture, "record", "1")).body)
      .toEqual({ recording: true, held: false });
    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    expect(await allKeys(stub)).toContain("diag:alarms");

    expect((await setControl(fixture, "record", "0")).body)
      .toEqual({ recording: false, held: false });
    expect(await allKeys(stub)).not.toContain("diag:alarms");
    expect((await readDiagnostic(fixture)).body.alarms).toEqual({ last: null, recent: [] });

    // A put storage refuses leaves the cache exactly as it was.
    const probe = await installProbe(stub);
    probe.intercept = (operation, _phase, args, invoke) => {
      if (operation === "put" && args[0] === "diag:hold") throw new Error("storage down");
      return invoke();
    };
    const refused = await setControl(fixture, "hold", "1");
    expect(refused.status).toBe(503);
    probe.intercept = undefined;
    expect((await readDiagnostic(fixture)).body.controls)
      .toEqual({ recording: false, held: false });
  }, 30_000);

  it("fails the alarm and the drain on staging when the flags cannot be read", async () => {
    // A loaded object with a socket, so the disconnect below has a drain to
    // suppress and a document worth writing out.
    const opened = await loadedFixture("diag-controls-unreadable");
    const { fixture, stub, socket } = opened;
    clientEdit(socket, opened.state, (doc) => { story0(doc).set("prepared", "1"); });
    await waitUntil(stub, (doc) => story0(doc).get("prepared") === "1");
    await cancelAlarm(stub);
    await plant(stub, { "diag:hold": true });
    const probe = await installProbe(stub);
    probe.intercept = (operation, _phase, args, invoke) => {
      if (isFlagsRead(operation, args)) throw new Error("storage down");
      return invoke();
    };
    const keysBefore = await allKeys(stub);
    const rowBefore = await rowOf(fixture.projectId);

    expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    const record = await lastRecord(stub);
    expect(record.kind).toBe("failed");
    expect(record.failure).toBe("controls_unreadable");
    expect(callsTagged(probe, "maintenance")).toEqual([]);
    expect(callsTagged(probe, "retirement")).toEqual([]);
    expect(callsTagged(probe, "snapshot")).toEqual([]);

    // The last disconnect, in the same state: an unreadable hold must not be
    // the thing that lets a drain spend the prepared debt.
    socket.ws.close();
    await vi.waitFor(async () => {
      expect(await runInDurableObject(stub, (_i, state) => state.getWebSockets().length)).toBe(0);
    }, { timeout: 5_000 });
    await cancelAlarm(stub);
    expect((await rowOf(fixture.projectId))!.yjs_write).toBe(rowBefore!.yjs_write);
    expect((await rowOf(fixture.projectId))!.updated_at).toBe(rowBefore!.updated_at);
    expect(await allKeys(stub)).toEqual(keysBefore);

    // The next consumer reads the flags, and finds the planted hold.
    probe.intercept = undefined;
    expect((await readDiagnostic(fixture)).body.controls)
      .toEqual({ recording: false, held: true });
  }, 30_000);

  it("runs the ordinary alarm on production when the flags cannot be read", async () => {
    const seqs = Array.from({ length: 6 }, (_, i) => i + 1);
    const { fixture, stub } = await cleanupFixture("diag-controls-unreadable-prod", seqs);
    await seamEnvironment(stub, "production");
    await plant(stub, { "diag:hold": true, "diag:record": true });
    const probe = await installProbe(stub);
    probe.intercept = (operation, _phase, args, invoke) => {
      if (isFlagsRead(operation, args)) throw new Error("storage down");
      return invoke();
    };

    // Off staging the flags decide nothing, so a read storage refused costs the
    // invocation nothing: the phases run and the record says the flags read off.
    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    const record = await lastRecord(stub);
    expect(record.kind).toBe("ran");
    expect(record.failure).toBeNull();
    expect(record.recording).toBe(false);
    expect(record.preflight.held).toBe(false);
    expect(record.retirement.deleted).toBe(seqs.length);

    probe.intercept = undefined;
    expect((await readDiagnostic(fixture)).body.controls)
      .toEqual({ recording: false, held: false });
  }, 30_000);

  it("answers 503 to a control whose first flags read rejects, and lands the next", async () => {
    const { fixture, stub } = await cleanupFixture("diag-controls-init-503", [1]);
    const probe = await installProbe(stub);
    let flagReads = 0;
    probe.intercept = (operation, _phase, args, invoke) => {
      if (isFlagsRead(operation, args)) {
        flagReads += 1;
        if (flagReads === 1) throw new Error("storage down");
      }
      return invoke();
    };

    const refused = await setControl(fixture, "record", "1");
    expect(refused.status).toBe(503);
    expect(refused.body).toBe("storage_unavailable");
    expect(await allKeys(stub)).not.toContain("diag:record");

    // The memo was cleared by the rejection, so the next control takes a read
    // of its own rather than inheriting the poisoned one.
    expect((await setControl(fixture, "record", "1")).body)
      .toEqual({ recording: true, held: false });
    expect(flagReads).toBe(2);
  }, 30_000);

  it("answers 503 to a read whose flags read rejects", async () => {
    const fixture = await seedProject("diag-controls-read-503");
    const stub = diagStub(fixture.projectId);
    const probe = await installProbe(stub);
    probe.intercept = (operation, _phase, args, invoke) => {
      if (operation === "get" && Array.isArray(args[0]) && args[0][0] === "diag:record") {
        throw new Error("storage down");
      }
      return invoke();
    };

    const refused = await readDiagnostic(fixture);
    expect(refused.status).toBe(503);
    expect(refused.body).toBe("storage_unavailable");

    probe.intercept = undefined;
    expect((await readDiagnostic(fixture)).status).toBe(200);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 9. The markers
// ---------------------------------------------------------------------------

describe("a marker reaches exactly the op and the control it was signed for", () => {
  it("refuses another op, another control string, and another project", async () => {
    const fixture = await seedProject("diag-markers");
    const stub = diagStub(fixture.projectId);

    const wrongOp = await stub.fetch(
      await signedFor(fixture, "/diagnostic", "persistence-state", { method: "GET" }),
    );
    expect(wrongOp.status).toBe(401);
    await wrongOp.text();

    const wrongControl = await stub.fetch(
      await signedFor(fixture, "/diagnostic?hold=1", "diagnostic-control", {
        binding: "hold=0",
      }),
    );
    expect(wrongControl.status).toBe(401);
    await wrongControl.text();

    const malformed = await stub.fetch(
      await signedFor({ ...fixture, projectId: 0 }, "/diagnostic", "diagnostic", {
        method: "GET",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toBe("identity_malformed");

    // A marker naming another project than the one this object has bound.
    await plant(stub, { projectId: fixture.projectId });
    const other = { ...fixture, projectId: fixture.projectId + 100_000 };
    const mismatched = await stub.fetch(
      await signedFor(other, "/diagnostic", "diagnostic", { method: "GET" }),
    );
    expect(mismatched.status).toBe(409);
    expect((await mismatched.json() as { error: string }).error).toBe("identity_mismatch");
  }, 30_000);
});

describe("a stored identity outside the domain is a disagreement", () => {
  it("refuses it and reports the value storage holds", async () => {
    const planted: unknown[] = ["7", -1];
    for (const value of planted) {
      const fixture = await seedProject(`diag-identity-${String(value)}`);
      await plant(diagStub(fixture.projectId), { projectId: value });

      const answer = await readDiagnostic(fixture);

      expect(answer.status, String(value)).toBe(409);
      expect(answer.body.error).toBe("identity_mismatch");
      // The observed value, not a normalised absence: a binding the object
      // cannot use is the fact the read was taken for.
      expect(answer.body.identity).toEqual({
        projectId: fixture.projectId, memory: null, stored: value,
      });
    }

    // An unbound object still agrees: absence is not a contradiction.
    const unbound = await seedProject("diag-identity-absent");
    const agreed = await readDiagnostic(unbound);
    expect(agreed.status).toBe(200);
    expect(agreed.body.identity)
      .toEqual({ projectId: unbound.projectId, memory: null, stored: null });
  }, 30_000);

  it("reports a non-finite stored number as its String(), which JSON cannot carry", async () => {
    // `JSON.stringify` accepts each of these without throwing but flattens it
    // to `null`, so `identity.stored` must report the text rather than the
    // value itself.
    const nonFinite: unknown[] = [NaN, Infinity, -Infinity];
    for (const value of nonFinite) {
      const fixture = await seedProject(`diag-identity-nonfinite-${String(value)}`);
      await plant(diagStub(fixture.projectId), { projectId: value });

      const answer = await readDiagnostic(fixture);

      expect(answer.status, String(value)).toBe(409);
      expect(answer.body.error).toBe("identity_mismatch");
      expect(answer.body.identity).toEqual({
        projectId: fixture.projectId, memory: null, stored: String(value),
      });
    }
  }, 30_000);

  it("reports a structured-clone value JSON flattens to null as its String()", async () => {
    // Structured clone admits a boxed number and an invalid date; JSON
    // flattens each to `null` even though the stored value is not `null`,
    // so `identity.stored` must report the text rather than the flattened
    // value.
    const lossy: unknown[] = [
      new Number(NaN), new Number(Infinity), new Number(-Infinity), new Date(NaN),
    ];
    for (const value of lossy) {
      const fixture = await seedProject(`diag-identity-lossy-${String(value)}`);
      await plant(diagStub(fixture.projectId), { projectId: value });

      const answer = await readDiagnostic(fixture);

      expect(answer.status, String(value)).toBe(409);
      expect(answer.body.error).toBe("identity_mismatch");
      expect(answer.body.identity).toEqual({
        projectId: fixture.projectId, memory: null, stored: String(value),
      });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 10. The ring and the nonce across an eviction
// ---------------------------------------------------------------------------

describe("the ring outlives the instance that wrote it", () => {
  it("answers a changed nonce and the stored record after an eviction", async () => {
    const { fixture, stub } = await cleanupFixture("diag-ring-eviction", [1, 2, 3]);
    await setControl(fixture, "record", "1");
    expect((await dispatchAlarm(stub)).outcome).toBe("ran");
    const before = await readDiagnostic(fixture);
    expect(before.body.alarms.last.kind).toBe("ran");
    const writtenId = before.body.alarms.last.recordId;
    await cancelAlarm(stub);

    await hibernate(stub);

    const after = await readDiagnostic(fixture);
    expect(after.body.object.nonce).not.toBe(before.body.object.nonce);
    expect(after.body.alarms.last.recordId).toBe(writtenId);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 11. Every completed invocation records, and the entry line
// ---------------------------------------------------------------------------

describe("every invocation that finalises leaves a record", () => {
  it("records a halted object, a zero-socket alarm and both custom lines", async () => {
    const halted = await seedProject("diag-record-halted");
    const haltedStub = diagStub(halted.projectId);
    await plant(haltedStub, {
      projectId: halted.projectId,
      [haltKey(0)]: { v: 1, reason: "log_corrupt", at: Date.now() },
    });
    await cancelAlarm(haltedStub);
    await setControl(halted, "record", "1");
    expect((await dispatchAlarm(haltedStub)).outcome).toBe("ran");
    const haltedRecord = await lastRecord(haltedStub);
    expect(haltedRecord.kind).toBe("halted");
    expect(haltedRecord.snapshot).toBeNull();
    // The halt is a preflight state, not an absent preflight: the generation it
    // stands for is named, and nothing was derived under it.
    expect(haltedRecord.generation).toBe(0);
    expect(haltedRecord.preflight).toEqual({
      halted: true,
      held: false,
      identity: { named: false, rejected: false },
      cleanup: { floor: null, rejected: false },
      debt: false,
    });

    const quiet = await cleanupFixture("diag-record-zero-sockets", [1, 2]);
    await setControl(quiet.fixture, "record", "1");
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      expect((await dispatchAlarm(quiet.stub)).outcome).toBe("ran");
    } finally {
      log.mockRestore();
    }
    const record = await lastRecord(quiet.stub);
    expect(record.snapshot.ran).toBe(false);
    expect(record.snapshot.skipped).toBe("no_sockets");
    // The helper's dispatch passes no metadata, and none is invented.
    expect(record.retryCount).toBeNull();
    expect(record.isRetry).toBeNull();

    const entry = lines.filter((line) => line.includes("[diagnostic][alarm-entry]"));
    const exit = lines.filter((line) => line.startsWith("[diagnostic][alarm] "));
    expect(entry).toHaveLength(1);
    expect(exit).toHaveLength(1);
    expect(entry[0]).toContain(record.recordId);
    expect(exit[0]).toContain(record.recordId);
    expect(lines.indexOf(entry[0])).toBeLessThan(lines.indexOf(exit[0]));

    // The runtime's own metadata, when it supplies it.
    await runInDurableObject(quiet.stub, async (instance) => {
      await (instance as unknown as Internals).alarm({ retryCount: 2, isRetry: true });
    });
    const retried = await lastRecord(quiet.stub);
    expect(retried.retryCount).toBe(2);
    expect(retried.isRetry).toBe(true);
    await cancelAlarm(quiet.stub);
  }, 60_000);

  it("names the object in both custom lines, distinctly from another object's", async () => {
    async function alarmLines(fixture: Fixture, stub: DurableObjectStub): Promise<{
      objectId: string;
      entry: string[];
      exit: string[];
    }> {
      await setControl(fixture, "record", "1");
      const objectId = (await readDiagnostic(fixture)).body.object.id;
      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
      try {
        expect((await dispatchAlarm(stub)).outcome).toBe("ran");
      } finally {
        log.mockRestore();
      }
      return {
        objectId,
        entry: lines.filter((line) => line.includes("[diagnostic][alarm-entry]")),
        exit: lines.filter((line) => line.startsWith("[diagnostic][alarm] ")),
      };
    }

    const first = await cleanupFixture("diag-entry-line-object-id-a", [1]);
    const a = await alarmLines(first.fixture, first.stub);
    expect(a.entry).toHaveLength(1);
    expect(a.exit).toHaveLength(1);
    expect(a.entry[0]).toContain(`"objectId":"${a.objectId}"`);
    expect(a.exit[0]).toContain(`"objectId":"${a.objectId}"`);

    const second = await cleanupFixture("diag-entry-line-object-id-b", [1]);
    const b = await alarmLines(second.fixture, second.stub);
    expect(b.objectId).not.toBe(a.objectId);
    expect(b.entry[0]).toContain(`"objectId":"${b.objectId}"`);
    expect(b.exit[0]).toContain(`"objectId":"${b.objectId}"`);
    expect(b.entry[0]).not.toContain(a.objectId);
    expect(b.exit[0]).not.toContain(a.objectId);
  }, 30_000);

  it("emits no entry line when the controls read itself failed", async () => {
    const { stub } = await cleanupFixture("diag-entry-line-absent", [1]);
    // Planted rather than set through the route, so this instance has not yet
    // cached the flags and the read below is the one that rejects.
    await plant(stub, { "diag:record": true });
    const probe = await installProbe(stub);
    probe.intercept = (operation, _phase, args, invoke) => {
      if (operation === "get" && Array.isArray(args[0]) && args[0][0] === "diag:record") {
        throw new Error("storage down");
      }
      return invoke();
    };
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      expect((await dispatchAlarm(stub)).outcome).toBe("rejected");
    } finally {
      log.mockRestore();
    }

    expect(lines.filter((line) => line.includes("[diagnostic][alarm-entry]"))).toEqual([]);
    const record = await lastRecord(stub);
    expect(record.failure).toBe("controls_unreadable");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 13. A qualifying compaction run
// ---------------------------------------------------------------------------

describe("a compaction run measured the way the exercise measures one", () => {
  it("folds and snapshots in the same invocation, and records both", async () => {
    const opened = await loadedFixture("diag-qualifying-compaction");
    await installSeams(opened.stub);
    await setControl(opened.fixture, "record", "1");
    expect((await setControl(opened.fixture, "hold", "1")).status).toBe(200);
    const failing = { on: true };
    await failBlobWrite(opened.stub, failing);

    let state = opened.state;
    for (let n = 1; n <= 25; n++) {
      state = clientEdit(opened.socket, state, (doc) => {
        story0(doc).set(`field_${n}`, String(n));
      });
    }
    await waitUntil(opened.stub, (doc) => story0(doc).get("field_25") === "25");
    await cancelAlarm(opened.stub);

    // The writes are restored while the hold still stands, so the measured
    // invocation's snapshot half can land rather than throw through the fence.
    failing.on = false;
    expect((await setControl(opened.fixture, "hold", "0")).status).toBe(200);

    await vi.waitFor(async () => {
      const record = await lastRecord(opened.stub);
      expect(record?.retirement?.branch).toBe("compaction");
    }, { timeout: 10_000 });
    await cancelAlarm(opened.stub);

    const record = await lastRecord(opened.stub);
    expect(record.kind).toBe("ran");
    expect(record.retirement.entry.debt.records).toBeGreaterThanOrEqual(20);
    expect(record.retirement.outcome.retirement).not.toBe("rejected");
    expect(record.retirement.deleted).toBeGreaterThan(0);
    expect(record.retirement.lists).toBeGreaterThan(0);
    expect(record.snapshot.blob.outcome).toBe("landed");
  }, 60_000);
});
