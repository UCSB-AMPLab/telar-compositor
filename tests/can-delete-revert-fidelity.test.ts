/**
 * Revert fidelity for the canDelete rule — C2.
 *
 * The rule reverts an unauthorised delete by rebuilding the tombstoned Y.Map
 * through `toCloneable`/`fromCloneable`. This file pins that the rebuilt
 * entity is the entity, not a shell of it: nested arrays keep their elements,
 * nested maps keep their keys, and Y.Text bodies keep their text.
 *
 * THIS FILE IS A CANARY FOR A YJS INTERNAL.
 *
 * Recovering a tombstoned entity depends on deleted content still being
 * present while the `afterTransaction` handler runs. That holds because
 * `cleanupTransactions` emits `afterTransaction` from inside its `try` and
 * runs `tryGcDeleteSet` from the `finally` after it — an ordering yjs does not
 * publish as API. A yjs upgrade that moves garbage collection ahead of the
 * observer calls would leave the reverted entity hollow again, silently,
 * because nothing else in the suite reads a deleted subtree.
 *
 * These tests are what would catch it. A failure here after a yjs bump is not
 * a test to relax: it means the revert has gone back to writing empty shells
 * to D1, and the recovery has to move somewhere the content still exists.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import {
  makeCanDeleteHandler,
  makeViolationCounter,
  toCloneable,
  fromCloneable,
} from "../workers/can-delete";

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
  asUser: (ws: FakeWS, fn: () => void) => void;
}

/** A Y.Doc with the handler installed, matching the DO's wiring. */
function makeHarness(): Harness {
  const ydoc = new Y.Doc();
  const warns: string[] = [];
  const isReverting = { value: false };
  const recordViolation = makeViolationCounter();

  const handler = makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => false,
    isReverting: () => isReverting.value,
    setReverting: (v: boolean) => { isReverting.value = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => { /* not under test here */ },
    recordViolation,
    warn: (msg: string) => { warns.push(msg); },
  });
  ydoc.on("afterTransaction", handler);

  return {
    ydoc,
    warns,
    asUser: (ws, fn) => { ydoc.transact(fn, ws); },
  };
}

/** Y.Text body of `key`, or undefined when the key holds no Y.Text. */
function text(map: Y.Map<unknown>, key: string): string | undefined {
  const v = map.get(key);
  return v instanceof Y.Text ? v.toString() : undefined;
}

function arr(map: Y.Map<unknown>, key: string): Y.Array<Y.Map<unknown>> {
  return map.get(key) as Y.Array<Y.Map<unknown>>;
}

// ---------------------------------------------------------------------------
// The defect: a reverted entity comes back hollow
// ---------------------------------------------------------------------------

describe("revert fidelity — nested arrays under a tombstoned parent", () => {
  it("restores a story's steps, its steps' layers, and every Y.Text body", () => {
    const { ydoc, asUser, warns } = makeHarness();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_id", 10);
      story.set("_temp_id", "s1");
      story.set("created_by", 99);
      story.set("story_id", "the-story");
      story.set("title", new Y.Text("A story with a title"));
      story.set("description", new Y.Text("And a description"));

      const steps = new Y.Array<Y.Map<unknown>>();
      for (const [i, question] of [["st1", "First question"], ["st2", "Second question"]]) {
        const step = new Y.Map<unknown>();
        step.set("_temp_id", i);
        step.set("created_by", 99);
        step.set("question", new Y.Text(question));

        const layers = new Y.Array<Y.Map<unknown>>();
        for (const caption of [`${i}-layer-a`, `${i}-layer-b`]) {
          const layer = new Y.Map<unknown>();
          layer.set("_temp_id", caption);
          layer.set("created_by", 99);
          layer.set("caption", new Y.Text(`caption for ${caption}`));
          layers.push([layer]);
        }
        step.set("layers", layers);
        steps.push([step]);
      }
      story.set("steps", steps);
      stories.push([story]);
    }, null);

    const collab = fakeSocket(5, "collaborator");
    asUser(collab, () => { stories.delete(0, 1); });

    expect(warns[0]).toMatch(/reverted 1 unauthorised/);
    expect(stories.length).toBe(1);

    const restored = stories.get(0);
    expect(restored.get("_temp_id")).toBe("s1");
    expect(text(restored, "title")).toBe("A story with a title");
    expect(text(restored, "description")).toBe("And a description");

    const steps = arr(restored, "steps");
    expect(steps.length).toBe(2);
    expect(steps.toArray().map((s) => s.get("_temp_id"))).toEqual(["st1", "st2"]);
    expect(steps.toArray().map((s) => text(s, "question")))
      .toEqual(["First question", "Second question"]);

    for (const step of steps.toArray()) {
      const layers = arr(step, "layers");
      const id = step.get("_temp_id") as string;
      expect(layers.length).toBe(2);
      expect(layers.toArray().map((l) => l.get("_temp_id")))
        .toEqual([`${id}-layer-a`, `${id}-layer-b`]);
      expect(layers.toArray().map((l) => text(l, "caption")))
        .toEqual([`caption for ${id}-layer-a`, `caption for ${id}-layer-b`]);
    }
  });

  it("restores a nested Y.Map's own keys and text, not just its presence", () => {
    const { ydoc, asUser } = makeHarness();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_temp_id", "s1");
      story.set("created_by", 99);
      const config = new Y.Map<unknown>();
      config.set("theme", "dark");
      config.set("columns", 3);
      config.set("note", new Y.Text("a nested note"));
      const inner = new Y.Map<unknown>();
      inner.set("depth", "two");
      inner.set("label", new Y.Text("deep label"));
      config.set("inner", inner);
      story.set("config", config);
      stories.push([story]);
    }, null);

    asUser(fakeSocket(5, "collaborator"), () => { stories.delete(0, 1); });

    const config = stories.get(0).get("config") as Y.Map<unknown>;
    expect(config.get("theme")).toBe("dark");
    expect(config.get("columns")).toBe(3);
    expect(text(config, "note")).toBe("a nested note");
    const inner = config.get("inner") as Y.Map<unknown>;
    expect(inner.get("depth")).toBe("two");
    expect(text(inner, "label")).toBe("deep label");
  });

  it("restores an object's Y.Text fields", () => {
    const { ydoc, asUser } = makeHarness();
    const objects = ydoc.getArray<Y.Map<unknown>>("objects");

    ydoc.transact(() => {
      const obj = new Y.Map<unknown>();
      obj.set("_id", 42);
      obj.set("object_id", "an-object");
      obj.set("created_by", 99);
      obj.set("title", new Y.Text("Retablo de la Virgen"));
      obj.set("description", new Y.Text("Oil on panel, seventeenth century."));
      obj.set("credit", new Y.Text("Colección particular"));
      objects.push([obj]);
    }, null);

    asUser(fakeSocket(5, "collaborator"), () => { objects.delete(0, 1); });

    const restored = objects.get(0);
    expect(restored.get("object_id")).toBe("an-object");
    expect(text(restored, "title")).toBe("Retablo de la Virgen");
    expect(text(restored, "description")).toBe("Oil on panel, seventeenth century.");
    expect(text(restored, "credit")).toBe("Colección particular");
  });

  it("restores an entity with an empty nested array and no nested array at all", () => {
    const { ydoc, asUser } = makeHarness();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const withEmpty = new Y.Map<unknown>();
      withEmpty.set("_temp_id", "empty");
      withEmpty.set("created_by", 99);
      withEmpty.set("title", new Y.Text(""));
      withEmpty.set("steps", new Y.Array<Y.Map<unknown>>());

      const withNone = new Y.Map<unknown>();
      withNone.set("_temp_id", "none");
      withNone.set("created_by", 99);

      stories.push([withEmpty, withNone]);
    }, null);

    asUser(fakeSocket(5, "collaborator"), () => { stories.delete(0, 2); });

    expect(stories.length).toBe(2);
    // Located by handle, not by index: restoring several siblings deleted in
    // one transaction does not preserve their relative order, which is a
    // separate defect from the hollow-entity one this file pins.
    const byId = new Map(stories.toArray().map((m) => [m.get("_temp_id"), m]));
    const withEmpty = byId.get("empty")!;
    const withNone = byId.get("none")!;
    expect(withEmpty.get("_temp_id")).toBe("empty");
    expect(arr(withEmpty, "steps")).toBeInstanceOf(Y.Array);
    expect(arr(withEmpty, "steps").length).toBe(0);
    expect(text(withEmpty, "title")).toBe("");
    expect(withNone.get("_temp_id")).toBe("none");
    expect(withNone.get("steps")).toBeUndefined();
  });
});

describe("revert fidelity — Y.Text delta detail", () => {
  // The mirror carries the delta, not a flattened string, so formatting marks
  // and embeds survive the revert. Telar writes neither today — nothing calls
  // format or insertEmbed, and CodeMirror binds plain text — so this pins a
  // deliberate choice rather than a shipped feature: if a formatted field is
  // ever added, the revert must not quietly strip it.
  it("keeps formatting attributes and embeds through a revert", () => {
    const { ydoc, asUser } = makeHarness();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_temp_id", "s1");
      story.set("created_by", 99);
      const body = new Y.Text();
      body.insert(0, "plain ");
      body.insert(6, "bold", { bold: true });
      body.insertEmbed(10, { image: "figure-1.jpg" });
      story.set("body", body);
      stories.push([story]);
    }, null);

    asUser(fakeSocket(5, "collaborator"), () => { stories.delete(0, 1); });

    const body = stories.get(0).get("body") as Y.Text;
    expect(body.toDelta()).toEqual([
      { insert: "plain " },
      { insert: "bold", attributes: { bold: true } },
      { insert: { image: "figure-1.jpg" } },
    ]);
  });

  it("restores a Y.Text edited in the same transaction as the delete to its pre-transaction body", () => {
    const { ydoc, asUser } = makeHarness();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");

    ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_temp_id", "s1");
      story.set("created_by", 99);
      story.set("title", new Y.Text("original title"));
      stories.push([story]);
    }, null);

    asUser(fakeSocket(5, "collaborator"), () => {
      (stories.get(0).get("title") as Y.Text).insert(0, "vandalised ");
      stories.delete(0, 1);
    });

    expect(text(stories.get(0), "title")).toBe("original title");
  });
});

// ---------------------------------------------------------------------------
// The live path must not move
// ---------------------------------------------------------------------------

describe("toCloneable on a still-live Y.Map (snap === null)", () => {
  it("round-trips scalars, Y.Text, nested maps and nested arrays unchanged", () => {
    const ydoc = new Y.Doc();
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    let story!: Y.Map<unknown>;
    ydoc.transact(() => {
      story = new Y.Map<unknown>();
      story.set("_id", 10);
      story.set("_temp_id", "s1");
      story.set("title", new Y.Text("live title"));
      const config = new Y.Map<unknown>();
      config.set("theme", "dark");
      story.set("config", config);
      const steps = new Y.Array<Y.Map<unknown>>();
      const step = new Y.Map<unknown>();
      step.set("_temp_id", "st1");
      step.set("question", new Y.Text("live question"));
      steps.push([step]);
      story.set("steps", steps);
      stories.push([story]);
    }, null);

    const cloneable = toCloneable(story, null);
    // The live mirror keeps its established shape: a plain `__ytext` string.
    expect(cloneable.title).toEqual({ __ytext: "live title" });
    expect(cloneable._id).toBe(10);
    expect(cloneable.config).toEqual({ __ymap: { theme: "dark" } });

    const clone = fromCloneable(cloneable);
    ydoc.transact(() => { stories.push([clone]); }, null);

    expect(clone.get("_temp_id")).toBe("s1");
    expect(text(clone, "title")).toBe("live title");
    expect((clone.get("config") as Y.Map<unknown>).get("theme")).toBe("dark");
    const steps = arr(clone, "steps");
    expect(steps.length).toBe(1);
    expect(text(steps.get(0), "question")).toBe("live question");
  });
});

// ---------------------------------------------------------------------------
// The yjs-internals canary, stated directly
// ---------------------------------------------------------------------------

describe("yjs canary — deleted content is readable during afterTransaction", () => {
  it("still exposes tombstoned array elements and text on a gc:true doc", () => {
    const ydoc = new Y.Doc();
    expect(ydoc.gc).toBe(true); // the DO takes the default; the canary must too

    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    let story!: Y.Map<unknown>;
    ydoc.transact(() => {
      story = new Y.Map<unknown>();
      story.set("title", new Y.Text("Hello world"));
      const steps = new Y.Array<Y.Map<unknown>>();
      const step = new Y.Map<unknown>();
      step.set("_temp_id", "st1");
      steps.push([step]);
      story.set("steps", steps);
      stories.push([story]);
    }, null);

    let snap: Y.Snapshot | null = null;
    let seen: { steps: number; title: unknown } | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", () => {
      if (seen || !snap) return;
      const yjs = Y as unknown as {
        typeListToArraySnapshot: (a: Y.Array<unknown>, s: Y.Snapshot) => unknown[];
        typeMapGetSnapshot: (m: Y.Map<unknown>, k: string, s: Y.Snapshot) => unknown;
      };
      const steps = yjs.typeMapGetSnapshot(story, "steps", snap) as Y.Array<unknown>;
      const title = yjs.typeMapGetSnapshot(story, "title", snap) as Y.Text;
      seen = {
        steps: yjs.typeListToArraySnapshot(steps, snap).length,
        title: title.toDelta(snap),
      };
    });

    ydoc.transact(() => { stories.delete(0, 1); }, {});

    // If a yjs upgrade moves tryGcDeleteSet ahead of the observer calls, both
    // of these collapse to the empty case and the revert goes back to writing
    // hollow entities to D1.
    expect(seen).not.toBeNull();
    expect(seen!.steps).toBe(1);
    expect(seen!.title).toEqual([{ insert: "Hello world" }]);
  });
});
