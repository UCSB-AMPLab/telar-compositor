/**
 * The upgrade prepare's start of the operation lease, and the refusal the
 * author is shown when it cannot start.
 *
 * The prepare takes the lease, so the Durable Object can replace the same
 * author's abandoned prepare (see freeze-lease.test.ts for that rule). What
 * is pinned here is the refusal: only the author's own upgrade is told as
 * theirs, with minutes rounded up so the retry it names is never early.
 *
 * @version v1.5.4-beta
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLeaseNamingHolder: vi.fn(async () => ({ result: "applied", holder: null })),
  newFreezeOperationId: vi.fn(() => "op-new"),
}));

import { controlFreezeLeaseNamingHolder } from "~/lib/freeze-lease.server";
import { beginUpgradeLease, upgradeLeaseRefusal, withPrepareLease } from "~/lib/upgrade-lease.server";

const env = {} as Parameters<typeof beginUpgradeLease>[0];

describe("beginUpgradeLease", () => {
  it("takes the lease, for the user, and answers the new operation's id", async () => {
    expect(await beginUpgradeLease(env, 12, 34)).toEqual({ operationId: "op-new" });
    expect(vi.mocked(controlFreezeLeaseNamingHolder)).toHaveBeenCalledWith(env, 12, 34, {
      op: "take",
      kind: "upgrade",
      operationId: "op-new",
    });
  });

  it("lets the prepare through when the object could not be asked", async () => {
    vi.mocked(controlFreezeLeaseNamingHolder).mockResolvedValueOnce({ result: "unavailable", holder: null });
    expect(await beginUpgradeLease(env, 12, 34)).toEqual({ operationId: "op-new" });
  });

  it("answers the refusal for the lease the object named", async () => {
    vi.mocked(controlFreezeLeaseNamingHolder).mockResolvedValueOnce({
      result: "refused",
      holder: { kind: "upgrade", own: true, remainingMs: 61_000 },
    });
    expect(await beginUpgradeLease(env, 12, 34)).toEqual({ error: "own_upgrade_in_progress", detail: { minutes: 2 } });
  });
});

describe("upgradeLeaseRefusal", () => {
  it.each([
    ["another user's upgrade", { kind: "upgrade", own: false, remainingMs: 60_000 }],
    ["the user's own publish", { kind: "publish", own: true, remainingMs: 60_000 }],
    ["the user's own objects commit", { kind: "objects", own: true, remainingMs: 60_000 }],
    ["a refusal that names no lease", null],
  ] as const)("is the general message for %s", (_label, holder) => {
    expect(upgradeLeaseRefusal(holder)).toEqual({ error: "operation_in_progress" });
  });

  it.each([
    [1, 1],
    [60_000, 1],
    [60_001, 2],
    [299_000, 5],
  ])("tells the author their own upgrade lifts in whole minutes, rounded up (%i ms is %i)", (remainingMs, minutes) => {
    expect(upgradeLeaseRefusal({ kind: "upgrade", own: true, remainingMs })).toEqual({
      error: "own_upgrade_in_progress",
      detail: { minutes },
    });
  });
});

describe("withPrepareLease", () => {
  it("keeps the lease for an answer that holds it", async () => {
    const release = vi.fn(async () => {});
    expect(await withPrepareLease(async () => "ready", (a) => a === "ready", release)).toBe("ready");
    expect(release).not.toHaveBeenCalled();
  });

  it("releases the lease once for an answer that does not hold it", async () => {
    const release = vi.fn(async () => {});
    expect(await withPrepareLease(async () => "question", (a) => a === "ready", release)).toBe("question");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the lease once when the run throws, and rethrows that error", async () => {
    const release = vi.fn(async () => {});
    const boom = new Error("boom");
    await expect(withPrepareLease(async () => { throw boom; }, () => true, release)).rejects.toBe(boom);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rethrows the run's error when the release also fails", async () => {
    const boom = new Error("boom");
    const release = vi.fn(async () => { throw new Error("release"); });
    await expect(withPrepareLease(async () => { throw boom; }, () => true, release)).rejects.toBe(boom);
  });
});
