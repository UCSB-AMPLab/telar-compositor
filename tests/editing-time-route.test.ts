/**
 * GET /editing-time — the figure the contribution panel's clock shows.
 *
 * The number being watched must be the number being stored, and the stored
 * number is in two places at once: the seconds D1 holds, and the seconds this
 * instance has booked and not yet written. Both reads happen inside the
 * Durable Object because a snapshot can land between them — the batch adds the
 * pending seconds to D1 and only then subtracts them from the ledger — so a
 * reader that took one figure from each side would count a settling window
 * twice or not at all.
 *
 * What these hold to:
 *
 *   - The route is marker-gated like every other control route, and binds its
 *     project id from the marker: a fresh instance has none, and answering an
 *     empty 200 would replace real rows with nothing.
 *   - A fresh instance answers the stored rows alone. An empty ledger is not a
 *     failure; it is an instance that has seen no work yet.
 *   - A loaded instance answers stored plus unsettled, and the ledger keeps
 *     what it holds: the route reads, and the next snapshot still writes those
 *     seconds.
 *   - A settle between the two reads is detected by the epoch and the pair is
 *     taken again, so the answer is neither the stored figure alone nor the
 *     pending seconds counted twice.
 *   - A read that races a settle every time answers 503 rather than a figure
 *     it cannot vouch for; the loader falls back to D1.
 *
 * Harness: `cloudflare:workers` mocked to a plain class and a hand-rolled D1,
 * per this repo's convention that each file states its own fake.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { creditChange, peekTimeCredits, settleTimeCredits } from "../workers/contribution-metrics";
import type { MemberEditingTime, TimeLedger } from "../workers/contribution-metrics";
import { checkD1Bind } from "./helpers/d1-memory";

const TEST_SECRET = "test-session-secret";
const TEST_PROJECT_ID = 42;
const ANA = 7;

interface StoredRow {
  user_id: number;
  editing_seconds: number;
  writing_seconds: number;
}

/**
 * A D1 that answers the one SELECT this route makes.
 *
 * `rows` is read at the moment `all()` resolves, and `onRead` runs first, so a
 * test can stand a snapshot up in the gap between the statement executing and
 * its promise settling — which is the only gap the epoch exists to catch.
 */
function makeEnv(rows: () => StoredRow[], onRead?: () => void) {
  const reads: string[] = [];
  const DB = {
    prepare: (query: string) => ({
      bind: (...args: unknown[]) => {
        checkD1Bind(query, args);
        return {
          async all() {
            reads.push(query);
            const answer = rows();
            onRead?.();
            return { results: answer, success: true as const };
          },
          async run() { return { meta: { last_row_id: 1, changes: 1 }, success: true as const }; },
          async first() { return null; },
        };
      },
    }),
    async batch() { return []; },
  };
  return {
    reads,
    env: {
      DB: DB as unknown,
      SESSION_SECRET: TEST_SECRET,
      COLLABORATION: {} as unknown,
    },
  };
}

/** A ctx with no sockets, so the constructor's hibernation branch is skipped. */
function makeCtx() {
  return {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (fn: () => Promise<void>) => { await fn(); },
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
}

async function makeRequest(
  options: { signed?: boolean; projectId?: number } = {},
): Promise<Request> {
  const headers: Record<string, string> = {};
  const projectId = options.projectId ?? TEST_PROJECT_ID;
  if (options.signed !== false) {
    const { sigHex, timestamp } = await signInternalMarker(projectId, TEST_SECRET, "editing-time");
    headers["X-Internal-Auth"] = sigHex;
    headers["X-Internal-Timestamp"] = String(timestamp);
    headers["X-Internal-Project"] = String(projectId);
  }
  return new Request("https://internal/editing-time", { method: "GET", headers });
}

function makeDO(rows: () => StoredRow[], onRead?: () => void) {
  const { env, reads } = makeEnv(rows, onRead);
  const doInstance = new ProjectCollaborationDO(
    makeCtx() as unknown as DurableObjectState,
    env as unknown as Env,
  );
  const ledger = (doInstance as unknown as { timeLedger: TimeLedger }).timeLedger;
  return { doInstance, ledger, reads };
}

/** What the instance's epoch counter stands at, as the route reads it. */
function epochOf(doInstance: ProjectCollaborationDO): number {
  return (doInstance as unknown as { settleEpoch: number }).settleEpoch;
}

async function times(res: Response): Promise<MemberEditingTime[]> {
  const body = (await res.json()) as { times: MemberEditingTime[] };
  return body.times;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("collaboration DO — GET /editing-time", () => {
  it("rejects a request without the internal marker", async () => {
    const { doInstance } = makeDO(() => []);

    const res = await doInstance.fetch(await makeRequest({ signed: false }));

    expect(res.status).toBe(401);
  });

  it("refuses a marker that names no project rather than answering nothing", async () => {
    const { doInstance, reads } = makeDO(() => []);

    const res = await doInstance.fetch(await makeRequest({ projectId: 0 }));

    expect(res.status).toBe(400);
    expect(reads).toHaveLength(0);
  });

  it("a fresh instance answers the stored rows alone", async () => {
    const { doInstance } = makeDO(() => [
      { user_id: ANA, editing_seconds: 120, writing_seconds: 30 },
    ]);

    const res = await doInstance.fetch(await makeRequest());

    expect(res.status).toBe(200);
    expect(await times(res)).toEqual([
      { userId: ANA, editingSeconds: 120, writingSeconds: 30 },
    ]);
  });

  it("adds the seconds this instance has booked and not settled", async () => {
    const { doInstance, ledger } = makeDO(() => [
      { user_id: ANA, editing_seconds: 120, writing_seconds: 30 },
    ]);
    // One change with nothing before it books the whole window, editing and
    // writing alike: sixty seconds of each.
    creditChange(ledger, ANA, "2026-09-04T10:00:00.000Z", true);

    const res = await doInstance.fetch(await makeRequest());

    expect(await times(res)).toEqual([
      { userId: ANA, editingSeconds: 180, writingSeconds: 90 },
    ]);
  });

  it("answers for a person the ledger knows and D1 does not", async () => {
    const { doInstance, ledger } = makeDO(() => []);
    creditChange(ledger, ANA, "2026-09-04T10:00:00.000Z", false);

    const res = await doInstance.fetch(await makeRequest());

    expect(await times(res)).toEqual([
      { userId: ANA, editingSeconds: 60, writingSeconds: 0 },
    ]);
  });

  it("leaves the ledger holding what it held — the route reads, it never settles", async () => {
    const { doInstance, ledger } = makeDO(() => []);
    creditChange(ledger, ANA, "2026-09-04T10:00:00.000Z", true);

    await doInstance.fetch(await makeRequest());

    expect(peekTimeCredits(ledger)).toEqual([
      {
        userId: ANA,
        editingSeconds: 60,
        writingSeconds: 60,
        lastChangeAt: "2026-09-04T10:00:00.000Z",
        lastWriteAt: "2026-09-04T10:00:00.000Z",
      },
    ]);
  });

  it("takes both figures again when a settle lands between them", async () => {
    let stored: StoredRow[] = [{ user_id: ANA, editing_seconds: 120, writing_seconds: 30 }];
    let settled = false;
    const held: { ledger: TimeLedger | null; bump: () => void } = { ledger: null, bump: () => {} };
    // The snapshot's tail, in its order: D1 has the pending seconds, and only
    // then does the ledger give them up. It runs after the SELECT has read the
    // old rows and before its promise resolves, which is the interleaving the
    // epoch exists to catch: without it the answer would be the stored figure
    // alone, the minute of work lost from both sides at once.
    const built = makeDO(
      () => stored,
      () => {
        if (settled) return;
        settled = true;
        stored = [{ user_id: ANA, editing_seconds: 180, writing_seconds: 90 }];
        settleTimeCredits(held.ledger!, peekTimeCredits(held.ledger!));
        held.bump();
      },
    );
    held.ledger = built.ledger;
    held.bump = () => { (built.doInstance as unknown as { settleEpoch: number }).settleEpoch += 1; };
    creditChange(built.ledger, ANA, "2026-09-04T10:00:00.000Z", true);

    const res = await built.doInstance.fetch(await makeRequest());

    expect(built.reads).toHaveLength(2);
    expect(await times(res)).toEqual([
      { userId: ANA, editingSeconds: 180, writingSeconds: 90 },
    ]);
  });

  it("answers 503 when every attempt races a settle", async () => {
    const bump: { run: () => void } = { run: () => {} };
    const built = makeDO(
      () => [{ user_id: ANA, editing_seconds: 120, writing_seconds: 30 }],
      () => bump.run(),
    );
    bump.run = () => { (built.doInstance as unknown as { settleEpoch: number }).settleEpoch += 1; };

    const res = await built.doInstance.fetch(await makeRequest());

    expect(res.status).toBe(503);
    expect(built.reads.length).toBeGreaterThan(1);
  });

  it("answers 503 when the stored rows cannot be read", async () => {
    const { doInstance } = makeDO(() => {
      throw new Error("D1 refused");
    });

    const res = await doInstance.fetch(await makeRequest());

    expect(res.status).toBe(503);
  });

  it("moves the epoch only where the ledger is settled, never on a read", async () => {
    const { doInstance, ledger } = makeDO(() => []);
    const before = epochOf(doInstance);
    creditChange(ledger, ANA, "2026-09-04T10:00:00.000Z", true);
    await doInstance.fetch(await makeRequest());

    expect(epochOf(doInstance)).toBe(before);
  });
});
