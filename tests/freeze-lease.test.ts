/**
 * The freeze lease's rules, and what a client makes of the frames that carry
 * it.
 *
 * The Durable Object applies these rules; a client reads the result. The
 * cases pin what each side decides on its own: who may renew or end a lease,
 * how long any one operation may hold the freeze, and which ended operations
 * a page acts on — the last being what keeps a replayed success from
 * reloading a page twice.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  EMPTY_LEASE_STATE,
  LEASE_MAX_MS,
  LEASE_PHASE_MS,
  ENDED_KEEP_MS,
  applyLeaseControl,
  leaseControlText,
  leaseFrame,
  parseLeaseControl,
  type LeaseControl,
  type LeaseState,
} from "../workers/freeze-lease";
import {
  EMPTY_FREEZE_VIEW,
  applyFreezeFrame,
  dismissFreezeError,
  expireFreeze,
  nextFreezeDeadline,
  parseFreezeFrame,
  readFreezeView,
  readLockHolder,
  type FreezeFrame,
} from "~/lib/freeze-view";

const HOLDER = 5;
const OTHER = 6;

function apply(state: LeaseState, control: LeaseControl, userId = HOLDER, now = 0): LeaseState {
  const next = applyLeaseControl(state, control, userId, now);
  if (next === null) throw new Error(`refused: ${leaseControlText(control)}`);
  return next;
}

describe("the lease table", () => {
  const begun = apply(EMPTY_LEASE_STATE, { op: "begin", kind: "upgrade", operationId: "op" });

  it("gives a lease a phase window and a revision", () => {
    expect(begun.leases.op).toEqual({ rev: 1, kind: "upgrade", userId: HOLDER, startedAt: 0, expiresAt: LEASE_PHASE_MS });
    expect(begun.nextRev).toBe(2);
  });

  it("refuses a renewal or an end from anyone but the holder", () => {
    expect(applyLeaseControl(begun, { op: "renew", operationId: "op" }, OTHER, 1)).toBeNull();
    expect(applyLeaseControl(begun, { op: "end", operationId: "op", outcome: "failed" }, OTHER, 1)).toBeNull();
  });

  it("refuses to renew a lease that has run out", () => {
    expect(applyLeaseControl(begun, { op: "renew", operationId: "op" }, HOLDER, LEASE_PHASE_MS)).toBeNull();
  });

  it("never renews an operation past the cap, however often it is renewed", () => {
    let state = begun;
    for (let t = LEASE_PHASE_MS / 2; t < LEASE_MAX_MS; t += LEASE_PHASE_MS / 2) {
      state = apply(state, { op: "renew", operationId: "op" }, HOLDER, t);
    }
    expect(state.leases.op.expiresAt).toBe(LEASE_MAX_MS);
    expect(applyLeaseControl(state, { op: "renew", operationId: "op" }, HOLDER, LEASE_MAX_MS)).toBeNull();
  });

  it("records an end with its outcome, and keeps it only for a while", () => {
    const ended = apply(begun, { op: "end", operationId: "op", outcome: "succeeded" }, HOLDER, 10);
    expect(ended.leases).toEqual({});
    expect(leaseFrame(ended, 20).ended).toEqual([{ rev: 1, kind: "upgrade", userId: HOLDER, outcome: "succeeded" }]);
    expect(leaseFrame(ended, 10 + ENDED_KEEP_MS).ended).toEqual([]);
  });

  it.each([
    ["another user's publish", OTHER, "publish"],
    ["another user's upgrade", OTHER, "upgrade"],
    ["the same user's second operation", HOLDER, "publish"],
  ] as const)("refuses to begin %s while a lease stands: that is the lock", (_label, userId, kind) => {
    expect(applyLeaseControl(begun, { op: "begin", kind, operationId: "op2" }, userId, 1)).toBeNull();
  });

  it("lets the next operation begin once the lease has ended or run out", () => {
    const ended = apply(begun, { op: "end", operationId: "op", outcome: "succeeded" }, HOLDER, 1);
    expect(applyLeaseControl(ended, { op: "begin", kind: "publish", operationId: "op2" }, OTHER, 2)).not.toBeNull();
    expect(applyLeaseControl(begun, { op: "begin", kind: "publish", operationId: "op2" }, OTHER, LEASE_PHASE_MS)).not.toBeNull();
  });

  it("sends the time left, never the server's clock", () => {
    expect(leaseFrame(begun, 1000).leases[0].remainingMs).toBe(LEASE_PHASE_MS - 1000);
  });
});

describe("the control text", () => {
  it.each<LeaseControl>([
    { op: "begin", kind: "publish", operationId: "a-1" },
    { op: "renew", operationId: "a-1" },
    { op: "end", operationId: "a-1", outcome: "failed" },
  ])("round-trips %o", (control) => {
    expect(parseLeaseControl(leaseControlText(control))).toEqual(control);
  });

  it.each(["begin:deploy:a", "end:a:maybe", "renew:a:b", "begin:publish:a:b", "renew:", "", "renew:a b"])(
    "rejects %s",
    (text) => {
      expect(parseLeaseControl(text)).toBeNull();
    },
  );
});

const ME = 5;
const lease = (rev: number, userId: number, kind: "publish" | "upgrade" | "objects" = "upgrade", remainingMs = 60_000) =>
  ({ rev, kind, userId, remainingMs });
const frame = (leases: FreezeFrame["leases"], ended: FreezeFrame["ended"] = []): FreezeFrame => ({ leases, ended });

describe("a client's reading", () => {
  it("freezes every editor for any lease, and shows the modal only for another user's", () => {
    const mine = applyFreezeFrame(EMPTY_FREEZE_VIEW, frame([lease(1, ME)]), ME, 0);
    expect(readFreezeView(mine, "upgrade", ME)).toEqual({ frozen: true, heldByOther: false, heldBy: null, error: false });
    const theirs = applyFreezeFrame(EMPTY_FREEZE_VIEW, frame([lease(1, OTHER)]), ME, 0);
    expect(readFreezeView(theirs, "upgrade", ME)).toEqual({ frozen: true, heldByOther: true, heldBy: OTHER, error: false });
  });

  it("lifts a lease at its local deadline", () => {
    const view = applyFreezeFrame(EMPTY_FREEZE_VIEW, frame([lease(1, OTHER, "publish", 500)]), ME, 1000);
    expect(nextFreezeDeadline(view)).toBe(1500);
    expect(readFreezeView(expireFreeze(view, 1500), "publish", ME).frozen).toBe(false);
  });

  it("acts on an end only for an operation it saw running", () => {
    const replayed = applyFreezeFrame(
      EMPTY_FREEZE_VIEW,
      frame([], [{ rev: 1, kind: "upgrade", userId: OTHER, outcome: "succeeded" }]),
      ME,
      0,
    );
    // A page that has just reloaded is told of the end on admission and saw nothing run.
    expect(replayed.upgradeSucceeded).toBe(false);

    const running = applyFreezeFrame(EMPTY_FREEZE_VIEW, frame([lease(1, OTHER)]), ME, 0);
    const ended = applyFreezeFrame(
      running,
      frame([], [{ rev: 1, kind: "upgrade", userId: OTHER, outcome: "succeeded" }]),
      ME,
      1,
    );
    expect(ended.upgradeSucceeded).toBe(true);
  });

  it("does not reload for the holder's own upgrade", () => {
    const running = applyFreezeFrame(EMPTY_FREEZE_VIEW, frame([lease(1, ME)]), ME, 0);
    const ended = applyFreezeFrame(running, frame([], [{ rev: 1, kind: "upgrade", userId: ME, outcome: "succeeded" }]), ME, 1);
    expect(ended.upgradeSucceeded).toBe(false);
  });

  it("acts on each end once, however often it is replayed", () => {
    const running = applyFreezeFrame(EMPTY_FREEZE_VIEW, frame([lease(2, OTHER, "publish")]), ME, 0);
    const failed = frame([], [{ rev: 2, kind: "publish", userId: OTHER, outcome: "failed" }]);
    const shown = applyFreezeFrame(running, failed, ME, 1);
    const dismissed = dismissFreezeError(shown, "publish");
    expect(readFreezeView(applyFreezeFrame(dismissed, failed, ME, 2), "publish", ME).error).toBe(false);
  });

  it("clears an older failure when another user starts a new operation of that kind", () => {
    const running = applyFreezeFrame(EMPTY_FREEZE_VIEW, frame([lease(1, OTHER, "publish")]), ME, 0);
    const failed = applyFreezeFrame(running, frame([], [{ rev: 1, kind: "publish", userId: OTHER, outcome: "failed" }]), ME, 1);
    expect(readFreezeView(failed, "publish", ME).error).toBe(true);
    const again = applyFreezeFrame(failed, frame([lease(2, OTHER, "publish")], [{ rev: 1, kind: "publish", userId: OTHER, outcome: "failed" }]), ME, 2);
    expect(readFreezeView(again, "publish", ME)).toEqual({ frozen: true, heldByOther: true, heldBy: OTHER, error: false });
  });
});

describe("a frame that is not one", () => {
  it.each(["not json", "{}", '{"leases":{},"ended":[]}', "null"])("is refused: %s", (json) => {
    expect(parseFreezeFrame(json)).toBeNull();
  });

  it("keeps the well-formed entries of a frame and drops the rest", () => {
    const parsed = parseFreezeFrame(
      JSON.stringify({
        leases: [lease(1, OTHER), { rev: 2, kind: "deploy", userId: 1, remainingMs: 5 }, { rev: 3 }],
        ended: [{ rev: 1, kind: "publish", userId: 1, outcome: "exploded" }],
      }),
    );
    expect(parsed).toEqual({ leases: [lease(1, OTHER)], ended: [] });
  });
});

describe("an objects commit's lease", () => {
  const objects = apply(EMPTY_LEASE_STATE, { op: "begin", kind: "objects", operationId: "up" });

  it("is a control the object accepts", () => {
    const control: LeaseControl = { op: "begin", kind: "objects", operationId: "up" };
    expect(parseLeaseControl(leaseControlText(control))).toEqual(control);
  });

  it("stops a publish or upgrade from beginning, and begins during neither", () => {
    expect(applyLeaseControl(objects, { op: "begin", kind: "publish", operationId: "p" }, OTHER, 1)).toBeNull();
    expect(applyLeaseControl(objects, { op: "begin", kind: "upgrade", operationId: "u" }, OTHER, 1)).toBeNull();
    const publishing = apply(EMPTY_LEASE_STATE, { op: "begin", kind: "publish", operationId: "p" });
    expect(applyLeaseControl(publishing, { op: "begin", kind: "objects", operationId: "up" }, OTHER, 1)).toBeNull();
  });

  it("leaves no end for reconnecting clients to replay", () => {
    const ended = apply(objects, { op: "end", operationId: "up", outcome: "succeeded" }, HOLDER, 1);
    expect(ended.leases).toEqual({});
    expect(ended.ended).toEqual([]);
  });

  it("freezes no editor and shows no modal, and names its holder for the lock", () => {
    const view = applyFreezeFrame(EMPTY_FREEZE_VIEW, frame([lease(1, OTHER, "objects")]), ME, 0);
    for (const kind of ["publish", "upgrade"] as const) {
      expect(readFreezeView(view, kind, ME)).toEqual({ frozen: false, heldByOther: false, heldBy: null, error: false });
    }
    expect(readLockHolder(view, "objects", ME)).toBe(OTHER);
    expect(readLockHolder(applyFreezeFrame(EMPTY_FREEZE_VIEW, frame([lease(1, ME, "objects")]), ME, 0), "objects", ME)).toBeNull();
  });

  it("is kept in a frame beside a publish lease", () => {
    const parsed = parseFreezeFrame(JSON.stringify(frame([lease(1, OTHER, "objects"), lease(2, OTHER, "publish")])));
    expect(parsed?.leases.map((l) => l.kind)).toEqual(["objects", "publish"]);
  });
});
