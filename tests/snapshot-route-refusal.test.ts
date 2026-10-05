/**
 * `POST /snapshot` is the publish action's signal that D1 is current, so it
 * must never answer 200 without having flushed.
 *
 * `snapshotToD1` returns silently when `isSnapshotting` is already held — right
 * for the fire-and-forget callers, wrong for a route whose 200 the publish
 * pipeline reads as "D1 is authoritative". Skipped and succeeded were
 * indistinguishable, so a snapshot that never ran shipped stale rows under a
 * success banner.
 *
 * `/clear-course-markers` already refuses rather than lying on the same hazard:
 * drain the in-flight snapshot outside the gate, flush inside it, answer 503
 * when the flush did not run. This route now does the same, and
 * `app/routes/_app.publish.tsx` turns any non-200 into `snapshot_failed`.
 *
 * The same rule reaches the instance that woke with no project bound: it binds
 * from the signed marker and flushes rather than skipping on a null id, which
 * is a fact about the DO and not about D1.
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
import { markLoaded } from "./helpers/claimed-document";

const PROJECT_ID = 42;
const SECRET = "test-session-secret";

/**
 * A ctx whose gate defers work handed to `deliver()` — the same model the
 * enforcement-window suite uses — plus a record of whether a callback threw
 * (which in production terminates and discards the Durable Object).
 */
function makeCtx(sockets: unknown[] = []) {
  let depth = 0;
  let terminated = false;
  const queue: Array<() => void> = [];
  const ctx = {
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => {
      depth += 1;
      try {
        return await fn();
      } catch (err) {
        terminated = true;
        throw err;
      } finally {
        depth -= 1;
        if (depth === 0) for (const run of queue.splice(0)) run();
      }
    },
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  return { ctx, wasTerminated: () => terminated };
}

function makeDo() {
  const { ctx, wasTerminated } = makeCtx();
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: {} as unknown, SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number | null }).projectId = PROJECT_ID;
  markLoaded(doInstance);
  const snapshotSpy = vi
    .spyOn(doInstance as unknown as { snapshotToD1: () => Promise<void> }, "snapshotToD1")
    .mockResolvedValue(undefined);
  return { doInstance, snapshotSpy, wasTerminated };
}

async function snapshotRequest(): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, SECRET, "snapshot");
  return new Request("https://internal/snapshot", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(PROJECT_ID),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /snapshot — it refuses rather than lying", () => {
  it("answers 503 when another snapshot holds the lock, and does not snapshot", async () => {
    const { doInstance, snapshotSpy } = makeDo();
    // A snapshot is already in flight — exactly what makes snapshotToD1 return
    // silently, and silence is not a flush.
    (doInstance as unknown as { isSnapshotting: boolean }).isSnapshotting = true;

    const res = await doInstance.fetch(await snapshotRequest());

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("snapshot_blocked");
    expect(snapshotSpy).not.toHaveBeenCalled();
  });

  it("answers 503 when the document could not be loaded", async () => {
    // `ensureDocLoaded` swallows a failed hibernation-wake load, leaving
    // docLoaded false. A snapshot then writes nothing — and must not be
    // reported as one that did.
    const { doInstance, snapshotSpy } = makeDo();
    (doInstance as unknown as { docLoaded: boolean }).docLoaded = false;
    (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded =
      async () => { /* load failed earlier; docLoaded stays false */ };

    const res = await doInstance.fetch(await snapshotRequest());

    expect(res.status).toBe(503);
    expect(snapshotSpy).not.toHaveBeenCalled();
  });

  it("answers 200 on an ordinary publish, having actually snapshotted", async () => {
    const { doInstance, snapshotSpy } = makeDo();

    const res = await doInstance.fetch(await snapshotRequest());

    expect(res.status).toBe(200);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
  });

  it("binds the project from the signed marker and flushes when none is bound", async () => {
    // An evicted instance has no project id, and that says nothing about D1:
    // the blob is written standalone and ahead of the row batch, so the rows a
    // publish reads can lag it. The id comes off the HMAC-signed marker and the
    // flush runs. tests/snapshot-cold-instance-flush.test.ts covers the
    // divergence itself against real D1.
    const { doInstance, snapshotSpy } = makeDo();
    (doInstance as unknown as { projectId: number | null }).projectId = null;
    (doInstance as unknown as { docLoaded: boolean }).docLoaded = false;
    (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded =
      async () => { markLoaded(doInstance); };

    const res = await doInstance.fetch(await snapshotRequest());

    expect(res.status).toBe(200);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect((doInstance as unknown as { projectId: number | null }).projectId).toBe(PROJECT_ID);
  });

  it("refuses a marker that carries no usable project id", async () => {
    // The marker is signed over the header, so this is unreachable through the
    // publish action — but a bound id is what every step below depends on, and
    // guessing one would write under a project nobody named.
    const { doInstance, snapshotSpy } = makeDo();
    (doInstance as unknown as { projectId: number | null }).projectId = null;
    const { sigHex, timestamp } = await signInternalMarker(0, SECRET, "snapshot");
    const res = await doInstance.fetch(
      new Request("https://internal/snapshot", {
        method: "POST",
        headers: {
          "X-Internal-Auth": sigHex,
          "X-Internal-Timestamp": String(timestamp),
          "X-Internal-Project": "0",
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(snapshotSpy).not.toHaveBeenCalled();
  });

  it("answers 500 when the snapshot throws, without discarding the DO", async () => {
    const { doInstance, snapshotSpy, wasTerminated } = makeDo();
    snapshotSpy.mockRejectedValueOnce(new Error("D1_ERROR: batch failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => { /* silence */ });

    const res = await doInstance.fetch(await snapshotRequest());

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("snapshot_failed");
    expect(wasTerminated()).toBe(false);
    error.mockRestore();
  });

  it("waits for an in-flight snapshot to finish, then flushes and answers 200", async () => {
    // The drain that /clear-course-markers, /restore-orphans and /ingest-sync
    // all run: a snapshot ending while the route waits must produce a real
    // flush, not a refusal the publish action reports as a failure.
    vi.useFakeTimers();
    try {
      const { doInstance, snapshotSpy } = makeDo();
      (doInstance as unknown as { isSnapshotting: boolean }).isSnapshotting = true;

      const pending = doInstance.fetch(await snapshotRequest());
      await vi.advanceTimersByTimeAsync(50);
      (doInstance as unknown as { isSnapshotting: boolean }).isSnapshotting = false;
      await vi.advanceTimersByTimeAsync(50);

      const res = await pending;
      expect(res.status).toBe(200);
      expect(snapshotSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
