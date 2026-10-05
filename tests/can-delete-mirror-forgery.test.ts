/**
 * R2-1 — the revert mirror must not take its structure from client data.
 *
 * The revert rebuilds a tombstoned Y.Map by mirroring it to plain data and
 * cloning that back. While the mirror signalled "this node was a Y.Array" with
 * an in-band key (`__yarray`), any collaborator could store that key on any
 * Y.Map: a Y.Map value is arbitrary client JSON. `{ __yarray: null }` on a
 * neighbour's story made the rebuild call `.map` on null, the throw escaped the
 * revert transaction, the deletion stood and no strike was recorded — a general
 * disarm of every pass in the module, reachable from one field write.
 *
 * These tests pin two independent properties:
 *
 *   1. A client-authored value that LOOKS like a mirror node round-trips as the
 *      opaque value it is. The mirror never leaves the worker's memory, so its
 *      own nodes carry an identity a client posting JSON cannot construct.
 *   2. No single value can abort the revert. A rebuild failure is contained,
 *      loud, and still costs the actor a strike — never a silent acceptance of
 *      the deletion.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";
import { makeCanDeleteHandler, makeViolationCounter } from "../workers/can-delete";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Role = "convenor" | "collaborator" | "instructor";

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: Role };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(userId: number, role: Role): FakeWS {
  return {
    deserializeAttachment: () => ({ userId, role }),
    send: vi.fn(),
    close: vi.fn(),
  };
}

interface Harness {
  ydoc: Y.Doc;
  warns: string[];
  stories: Y.Array<Y.Map<unknown>>;
  asUser: (ws: FakeWS, fn: () => void) => void;
  seed: (fn: () => void) => void;
}

function makeHarness(): Harness {
  const ydoc = new Y.Doc();
  const warns: string[] = [];
  const isReverting = { value: false };
  const handler = makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => false,
    isReverting: () => isReverting.value,
    setReverting: (v: boolean) => { isReverting.value = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => { /* not under test */ },
    recordViolation: makeViolationCounter(),
    warn: (msg: string) => { warns.push(msg); },
  });
  ydoc.on("afterTransaction", handler);
  return {
    ydoc,
    warns,
    stories: ydoc.getArray<Y.Map<unknown>>("stories"),
    asUser: (ws, fn) => { ydoc.transact(fn, ws); },
    seed: (fn) => { ydoc.transact(fn, null); },
  };
}

/** The victim's story, owned by user 9, with one extra client-authored value. */
function seedVictimStory(h: Harness, extraKey: string, extraValue: unknown): Y.Map<unknown> {
  let story!: Y.Map<unknown>;
  h.seed(() => {
    story = new Y.Map<unknown>();
    story.set("_id", 10);
    story.set("_temp_id", "s-victim");
    story.set("created_by", 9);
    story.set("story_id", "the-victims-story");
    story.set("title", new Y.Text("An afternoon of work"));
    story.set("steps", new Y.Array<Y.Map<unknown>>());
    story.set(extraKey, extraValue);
    h.stories.push([story]);
  });
  return story;
}

function text(map: Y.Map<unknown>, key: string): string | undefined {
  const v = map.get(key);
  return v instanceof Y.Text ? v.toString() : undefined;
}

afterEach(() => { vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// 1. The reported probe
// ---------------------------------------------------------------------------

describe("R2-1 — a forged mirror sentinel cannot disarm enforcement", () => {
  it("reverts the delete and round-trips { __yarray: null } as an opaque value", () => {
    const h = makeHarness();
    seedVictimStory(h, "poison", { __yarray: null });
    const attacker = fakeSocket(7, "collaborator");

    // Two transactions, exactly as probed: poison one field, then delete.
    h.asUser(attacker, () => { h.stories.get(0).set("poison", { __yarray: null }); });
    h.asUser(attacker, () => { h.stories.delete(0, 1); });

    expect(h.stories.length).toBe(1);
    const restored = h.stories.get(0);
    expect(restored.get("_id")).toBe(10);
    expect(restored.get("created_by")).toBe(9);
    expect(text(restored, "title")).toBe("An afternoon of work");
    // The forgery is a value, not a structure: it comes back as what it is.
    expect(restored.get("poison")).toEqual({ __yarray: null });
    expect(h.warns.join("\n")).toContain("reverted 1 unauthorised delete(s)");
  });
});

// ---------------------------------------------------------------------------
// 2. Every sentinel, at the top level
// ---------------------------------------------------------------------------

describe("R2-1 — every mirror sentinel is inert as client data", () => {
  const forgeries: Array<[string, unknown]> = [
    ["__yarray null", { __yarray: null }],
    ["__yarray scalar", { __yarray: 7 }],
    ["__ymap null", { __ymap: null }],
    ["__ymap scalar", { __ymap: "not-a-map" }],
    ["__ytext object", { __ytext: { nested: true } }],
    ["__ytext string", { __ytext: "looks like a mirrored Y.Text" }],
    ["__ytextDelta null", { __ytextDelta: null }],
    ["__ytextDelta scalar", { __ytextDelta: 3 }],
  ];

  for (const [label, forged] of forgeries) {
    it(`restores the entity and preserves the value verbatim — ${label}`, () => {
      const h = makeHarness();
      seedVictimStory(h, "forged", forged);
      const attacker = fakeSocket(7, "collaborator");

      h.asUser(attacker, () => { h.stories.delete(0, 1); });

      expect(h.stories.length).toBe(1);
      const restored = h.stories.get(0);
      expect(restored.get("forged")).toEqual(forged);
      expect(text(restored, "title")).toBe("An afternoon of work");
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Nested inside real structure
// ---------------------------------------------------------------------------

describe("R2-1 — forgeries nested inside real Y types", () => {
  it("survives a forged sentinel inside a real Y.Array element", () => {
    const h = makeHarness();
    let story!: Y.Map<unknown>;
    h.seed(() => {
      story = new Y.Map<unknown>();
      story.set("_id", 11);
      story.set("created_by", 9);
      story.set("story_id", "nested-array");
      story.set("title", new Y.Text("Nested array"));
      const steps = new Y.Array<unknown>();
      steps.push([{ __ymap: null }, "plain", { __yarray: null }]);
      story.set("steps", steps);
      h.stories.push([story]);
    });

    h.asUser(fakeSocket(7, "collaborator"), () => { h.stories.delete(0, 1); });

    expect(h.stories.length).toBe(1);
    const steps = h.stories.get(0).get("steps") as Y.Array<unknown>;
    expect(steps.toArray()).toEqual([{ __ymap: null }, "plain", { __yarray: null }]);
  });

  it("survives a forged sentinel inside a real nested Y.Map", () => {
    const h = makeHarness();
    let story!: Y.Map<unknown>;
    h.seed(() => {
      story = new Y.Map<unknown>();
      story.set("_id", 12);
      story.set("created_by", 9);
      story.set("story_id", "nested-map");
      story.set("title", new Y.Text("Nested map"));
      const cfg = new Y.Map<unknown>();
      cfg.set("theme", "dark");
      cfg.set("forged", { __ytextDelta: null });
      story.set("config", cfg);
      h.stories.push([story]);
    });

    h.asUser(fakeSocket(7, "collaborator"), () => { h.stories.delete(0, 1); });

    expect(h.stories.length).toBe(1);
    const cfg = h.stories.get(0).get("config") as Y.Map<unknown>;
    expect(cfg.get("theme")).toBe("dark");
    expect(cfg.get("forged")).toEqual({ __ytextDelta: null });
  });

  it("survives a sentinel reachable only through the value's prototype chain", () => {
    // `"__yarray" in val` walks the prototype chain, and lib0's `readAny`
    // rebuilds a decoded object by assignment — so a `__proto__` entry in a
    // client's JSON becomes that object's prototype rather than a plain key.
    // A membership test can therefore be satisfied by a value with no such own
    // property at all.
    const h = makeHarness();
    const forged = Object.create({ __yarray: null }) as Record<string, unknown>;
    forged.harmless = true;
    seedVictimStory(h, "forged", forged);

    h.asUser(fakeSocket(7, "collaborator"), () => { h.stories.delete(0, 1); });

    expect(h.stories.length).toBe(1);
    expect(h.stories.get(0).get("forged")).toEqual({ harmless: true });
  });

  it("keeps a client-authored __proto__ key on the restored map", () => {
    // The mirror is a plain object, so `mirror["__proto__"] = value` reassigns
    // its prototype instead of recording the key: the field disappears from the
    // revert, silently.
    const h = makeHarness();
    seedVictimStory(h, "__proto__", { note: "a real field value" });

    h.asUser(fakeSocket(7, "collaborator"), () => { h.stories.delete(0, 1); });

    expect(h.stories.length).toBe(1);
    const restored = h.stories.get(0);
    expect(Array.from(restored.keys())).toContain("__proto__");
    expect(restored.get("__proto__")).toEqual({ note: "a real field value" });
  });
});

// ---------------------------------------------------------------------------
// 4. No single value may abort the revert
// ---------------------------------------------------------------------------

describe("R2-1 — a rebuild failure is contained, loud and counted", () => {
  it("restores the other entities when one value cannot be rebuilt", () => {
    const h = makeHarness();
    h.seed(() => {
      for (const [id, key] of [[20, "story-a"], [21, "story-b"]] as Array<[number, string]>) {
        const story = new Y.Map<unknown>();
        story.set("_id", id);
        story.set("created_by", 9);
        story.set("story_id", key);
        story.set("title", new Y.Text(key));
        h.stories.push([story]);
      }
    });

    // Fail the rebuild of the first entity's Y.Text body, and only that.
    let armed = false;
    const realApply = Y.Text.prototype.applyDelta;
    vi.spyOn(Y.Text.prototype, "applyDelta").mockImplementation(function (
      this: Y.Text,
      delta: Parameters<typeof realApply>[0],
      opts?: Parameters<typeof realApply>[1],
    ) {
      if (armed) {
        const insert = (delta as Array<{ insert?: unknown }>)[0]?.insert;
        if (insert === "story-a") throw new Error("synthetic rebuild failure");
      }
      return realApply.call(this, delta, opts);
    });
    armed = true;

    expect(() => {
      h.asUser(fakeSocket(7, "collaborator"), () => { h.stories.delete(0, 2); });
    }).not.toThrow();

    const ids = h.stories.toArray().map((m) => m.get("_id")).sort();
    expect(ids).toEqual([20, 21]);
    expect(h.warns.join("\n")).toContain("[canDelete][revert-degraded]");
  });

  it("never lets a failed revert pass silently — it logs, counts and closes", () => {
    const h = makeHarness();
    seedVictimStory(h, "harmless", 1);
    const attacker = fakeSocket(7, "collaborator");

    // Break the restore itself, past every per-value guard.
    let armed = false;
    const realInsert = Y.Array.prototype.insert;
    vi.spyOn(Y.Array.prototype, "insert").mockImplementation(function (
      this: Y.Array<unknown>,
      index: number,
      content: unknown[],
    ) {
      if (armed) throw new Error("synthetic revert failure");
      return realInsert.call(this, index, content);
    });
    armed = true;

    expect(() => {
      h.asUser(attacker, () => { h.stories.delete(0, 1); });
    }).not.toThrow();

    armed = false;
    expect(h.warns.join("\n")).toContain("[canDelete][revert-failed]");
    // A failed revert is a failed enforcement, not an accepted deletion: the
    // socket that produced it loses its connection rather than being allowed
    // to repeat the trick.
    expect(attacker.close).toHaveBeenCalled();
  });
});
