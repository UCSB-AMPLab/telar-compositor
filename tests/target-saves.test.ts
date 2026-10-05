/**
 * @vitest-environment jsdom
 *
 * target-saves.test.ts — the record per target that every in-place field
 * shares: one save at a time, always of the latest value wanted; a commit
 * equal to what is wanted joins it; a commit resolves once its revision or
 * a later one is stored, and rejects when the save carrying it fails with
 * nothing newer behind it; subscribers learn each stored value. A recovered
 * draft is kept in memory and in sessionStorage, and read back from either.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  clearRecovered,
  commit,
  isPending,
  isTracked,
  nextStamp,
  recordRecovered,
  recoveredFor,
  resetTargetSaves,
  subscribe,
  targetState,
  watchPending,
  watchRecovered,
} from "~/components/ui/target-saves";

afterEach(() => {
  resetTargetSaves();
});

/** A save each call of which the test resolves or rejects. */
function controlled() {
  const calls: Array<{ value: string; ok: () => void; fail: () => void }> = [];
  const save = vi.fn(
    (value: string) =>
      new Promise<void>((resolve, reject) => calls.push({ value, ok: resolve, fail: () => reject(new Error(value)) })),
  );
  return { save, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Resolves when `promise` settles, saying how. */
function outcome(promise: Promise<unknown>) {
  const seen = { state: "pending" as "pending" | "resolved" | "rejected" };
  promise.then(
    () => (seen.state = "resolved"),
    () => (seen.state = "rejected"),
  );
  return seen;
}

describe("target-saves", () => {
  it("runs one save at a time and collapses what was wanted meanwhile into the latest", async () => {
    const { save, calls } = controlled();
    // A subscriber keeps the record, and with it `confirmed`, to be read.
    subscribe("k", () => {});
    const a = outcome(commit("k", "a", save));
    const b = outcome(commit("k", "b", save));
    const c = outcome(commit("k", "c", save));
    await tick();
    expect(calls.map((x) => x.value)).toEqual(["a"]);
    expect(targetState("k")).toEqual({ confirmed: undefined, desired: "c", inflight: "a" });
    calls[0].ok();
    await tick();
    expect(a.state).toBe("resolved");
    expect(b.state).toBe("pending");
    expect(calls.map((x) => x.value)).toEqual(["a", "c"]);
    calls[1].ok();
    await tick();
    expect(b.state).toBe("resolved");
    expect(c.state).toBe("resolved");
    expect(targetState("k").confirmed).toBe("c");
  });

  it("joins a commit equal to what is wanted instead of saving it twice", async () => {
    const { save, calls } = controlled();
    const first = outcome(commit("k", "same", save));
    const second = outcome(commit("k", "same", save));
    await tick();
    calls[0].ok();
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
    expect(first.state).toBe("resolved");
    expect(second.state).toBe("resolved");
  });

  it("rejects every commit a failed save carried when nothing newer supersedes it", async () => {
    const { save, calls } = controlled();
    const first = outcome(commit("k", "same", save));
    const joined = outcome(commit("k", "same", save));
    await tick();
    calls[0].fail();
    await tick();
    expect(first.state).toBe("rejected");
    expect(joined.state).toBe("rejected");
    expect(targetState("k").desired).toBeUndefined();
  });

  it("keeps a commit whose save failed waiting on a later revision, and settles it with that one", async () => {
    const { save, calls } = controlled();
    subscribe("k", () => {});
    const early = outcome(commit("k", "early", save));
    await tick();
    const late = outcome(commit("k", "late", save));
    calls[0].fail();
    await tick();
    expect(early.state).toBe("pending");
    calls[1].ok();
    await tick();
    expect(early.state).toBe("resolved");
    expect(late.state).toBe("resolved");
    expect(targetState("k").confirmed).toBe("late");
  });

  it("stamps each stored value on the counter loader values are stamped on", async () => {
    const { save, calls } = controlled();
    const heard: number[] = [];
    subscribe("k", (_value, stamp) => heard.push(stamp));
    const before = nextStamp();
    commit("k", "v", save);
    await tick();
    calls[0].ok();
    await tick();
    const after = nextStamp();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeGreaterThan(before);
    expect(heard[0]).toBeLessThan(after);
  });

  it("keeps keys apart", async () => {
    const { save, calls } = controlled();
    commit("k", "one", save);
    commit("other", "two", save);
    await tick();
    expect(calls.map((x) => x.value)).toEqual(["one", "two"]);
  });

  it("tells subscribers each stored value, and forgets an idle record with everything in it", async () => {
    const { save, calls } = controlled();
    const heard = vi.fn();
    const unsubscribe = subscribe("k", heard);
    commit("k", "v", save);
    await tick();
    calls[0].ok();
    await tick();
    expect(heard).toHaveBeenCalledWith("v", expect.any(Number));
    expect(isTracked("k")).toBe(true);
    unsubscribe();
    expect(isTracked("k")).toBe(false);
    expect(targetState("k")).toEqual({});
  });
});

describe("recovered drafts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  const stored = (recoveryKey: string) => window.sessionStorage.getItem(`telar:recovered-draft:${recoveryKey}`);

  it("keeps a draft in memory and under its recovery key for the session, and clears both", () => {
    const kept = recordRecovered("k", "p/k", "draft", "offline");
    expect(recoveredFor("k", "p/k")).toEqual(kept);
    expect(JSON.parse(stored("p/k")!)).toEqual(kept);
    clearRecovered("k", "p/k", kept.id);
    expect(recoveredFor("k", "p/k")).toBeNull();
    expect(stored("p/k")).toBeNull();
  });

  it("reads a draft back from the session once memory is gone", () => {
    const kept = recordRecovered("k", "p/k", "draft", "offline");
    resetTargetSaves();
    expect(recoveredFor("k", "p/k")).toEqual(kept);
  });

  it("keeps a draft with no recovery key in memory only, by target", () => {
    recordRecovered("k", undefined, "draft", "offline");
    expect(window.sessionStorage.length).toBe(0);
    expect(recoveredFor("k", undefined)?.draft).toBe("draft");
    resetTargetSaves();
    expect(recoveredFor("k", undefined)).toBeNull();
  });

  it("keeps drafts of equal targets in different projects apart", () => {
    recordRecovered("step:7/question", "project:1/step:7/question", "one", "offline");
    expect(recoveredFor("step:7/question", "project:2/step:7/question")).toBeNull();
    expect(recoveredFor("step:7/question", "project:1/step:7/question")?.draft).toBe("one");
  });

  it("clears only the draft it names, not a later one recorded in its place", () => {
    const first = recordRecovered("k", "p/k", "x", "offline");
    const second = recordRecovered("k", "p/k", "y", "still offline");
    expect(second.id).not.toBe(first.id);
    clearRecovered("k", "p/k", first.id);
    expect(recoveredFor("k", "p/k")).toEqual(second);
    expect(JSON.parse(stored("p/k")!)).toEqual(second);
    // After a reload too: the later draft read back from storage is not the one named.
    resetTargetSaves();
    clearRecovered("k", "p/k", first.id);
    expect(recoveredFor("k", "p/k")).toEqual(second);
  });

  it("does not bring back a cleared draft whose stored copy could not be removed", () => {
    const kept = recordRecovered("k", "p/k", "draft", "offline");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    expect(() => clearRecovered("k", "p/k", kept.id)).not.toThrow();
    expect(stored("p/k")).not.toBeNull();
    expect(recoveredFor("k", "p/k")).toBeNull();
    // A later draft for the key is still read.
    vi.restoreAllMocks();
    const later = recordRecovered("k", "p/k", "later", "offline");
    expect(recoveredFor("k", "p/k")).toEqual(later);
  });

  it("does not bring back an older stored draft when a replacement could not be stored and its removal fails", () => {
    const a = recordRecovered("k", "p/k", "A", "offline");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    const b = recordRecovered("k", "p/k", "B", "offline again");
    expect(JSON.parse(stored("p/k")!)).toEqual(a);
    expect(recoveredFor("k", "p/k")).toEqual(b);
    clearRecovered("k", "p/k", b.id);
    // Storage still holds A, and A is not read back.
    expect(JSON.parse(stored("p/k")!)).toEqual(a);
    expect(recoveredFor("k", "p/k")).toBeNull();
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  it("does not bring back a cleared draft when storage could neither be read nor removed at the clear", () => {
    const kept = recordRecovered("k", "p/k", "draft", "offline");
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    clearRecovered("k", "p/k", kept.id);
    getItem.mockRestore();
    removeItem.mockRestore();
    expect(JSON.parse(stored("p/k")!)).toEqual(kept);
    expect(recoveredFor("k", "p/k")).toBeNull();
  });

  it("removes the older stored draft when a replacement cannot be stored, so a reload does not bring it back", () => {
    recordRecovered("k", "p/k", "A", "offline");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const b = recordRecovered("k", "p/k", "B", "offline again");
    expect(stored("p/k")).toBeNull();
    expect(recoveredFor("k", "p/k")).toEqual(b);
    resetTargetSaves();
    expect(recoveredFor("k", "p/k")).toBeNull();
  });

  it("gives each draft a random identity, not one from the clock or the stamp counter", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const first = recordRecovered("k", "p/k", "x", "offline");
    const second = recordRecovered("k", "p/k", "y", "offline");
    expect(first.id).toMatch(uuid);
    expect(second.id).toMatch(uuid);
    expect(second.id).not.toBe(first.id);
  });

  it("falls back to random bytes where randomUUID is missing", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => real.getRandomValues(bytes) });
    try {
      const first = recordRecovered("k", "p/k", "x", "offline");
      const second = recordRecovered("k", "p/k", "y", "offline");
      expect(first.id).toMatch(/^[0-9a-f]{32}$/);
      expect(second.id).not.toBe(first.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tells its watchers when a draft is recorded or cleared, for that key only", () => {
    const heard = vi.fn();
    const other = vi.fn();
    const unwatch = watchRecovered("k", "p/k", heard);
    watchRecovered("k", "p/other", other);
    const kept = recordRecovered("k", "p/k", "draft", "offline");
    clearRecovered("k", "p/k", kept.id);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(other).not.toHaveBeenCalled();
    unwatch();
    recordRecovered("k", "p/k", "again", "offline");
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("ignores a session entry it cannot read", () => {
    window.sessionStorage.setItem("telar:recovered-draft:p/k", "{not json");
    expect(recoveredFor("k", "p/k")).toBeNull();
    window.sessionStorage.setItem("telar:recovered-draft:p/k", JSON.stringify({ draft: "x", error: "e" }));
    expect(recoveredFor("k", "p/k")).toBeNull();
  });

  it("keeps a draft in memory, without throwing, when sessionStorage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    let kept: ReturnType<typeof recordRecovered> | undefined;
    expect(() => (kept = recordRecovered("k", "p/k", "draft", "offline"))).not.toThrow();
    expect(recoveredFor("k", "p/k")).toEqual(kept);
  });

  it("works in memory when sessionStorage throws", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("denied");
    });
    let kept: ReturnType<typeof recordRecovered> | undefined;
    expect(() => (kept = recordRecovered("k", "p/k", "draft", "offline"))).not.toThrow();
    expect(recoveredFor("k", "p/k")).toEqual(kept);
    expect(() => clearRecovered("k", "p/k", kept!.id)).not.toThrow();
    expect(recoveredFor("k", "p/k")).toBeNull();
  });
});

describe("whether a save is pending", () => {
  it("tells a watcher when a save for the key is wanted and when it settles", async () => {
    const { save, calls } = controlled();
    const heard: boolean[] = [];
    const unwatch = watchPending("k", (pending) => heard.push(pending));
    expect(isPending("k")).toBe(false);
    commit("k", "v", save).catch(() => {});
    expect(isPending("k")).toBe(true);
    await tick();
    calls[0].fail();
    await tick();
    expect(isPending("k")).toBe(false);
    expect(heard[0]).toBe(false);
    expect(heard).toContain(true);
    expect(heard[heard.length - 1]).toBe(false);
    unwatch();
    expect(isTracked("k")).toBe(false);
  });
});
