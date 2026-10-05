/**
 * A container born in a client transaction is this pass's to answer for,
 * whoever it was attached to.
 *
 * Yjs records nothing in `tr.changed` for a type it created in the same
 * transaction: the type's items post-date `tr.beforeState`, so neither the
 * container nor its members appear there. Both guards over the collaborative
 * document — the structural-shape pass and the identity-domain pass — reach
 * such members by descending from the map that holds them.
 *
 * The trap this file exists to pin: descent was entered only for a map the
 * transaction had also created. A `Y.Array` created and assigned to a story
 * that ALREADY existed has exactly the same property — its members are
 * invisible to `tr.changed` — and nothing looked at them. The container itself
 * satisfies every shape check, because a fresh `Y.Array` is a `Y.Array`; what
 * it carries is what matters, and what it carries had no reader.
 *
 * So the rule is about the CONTAINER's age, never the owner's. Each case below
 * is paired with a control that does the same thing to the story's existing
 * array, which has always been caught: the pair is what distinguishes a gap in
 * the descent from a rule that was never enforced anywhere.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import { makeCanDeleteHandler, makeViolationCounter } from "../workers/can-delete";

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

function makeHarness() {
  const ydoc = new Y.Doc();
  const isReverting = { value: false };
  const halts: Array<{ userId: number; failures: readonly string[] }> = [];
  ydoc.on("afterTransaction", makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => false,
    isReverting: () => isReverting.value,
    setReverting: (v: boolean) => { isReverting.value = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => { /* not under test */ },
    recordViolation: makeViolationCounter(),
    warn: () => { /* asserted through the document, not the log */ },
    onEnforcementFailure: (detail) => { halts.push(detail); },
  }));
  return {
    ydoc,
    halts,
    asUser: (ws: FakeWS, fn: () => void) => { ydoc.transact(fn, ws); },
  };
}

/** A story with one step, written server-side so nothing in it is born later. */
function seedStory(ydoc: Y.Doc) {
  const story = new Y.Map<unknown>();
  const steps = new Y.Array<unknown>();
  const stepOne = new Y.Map<unknown>();
  ydoc.transact(() => {
    stepOne.set("_id", 11);
    stepOne.set("question_md", new Y.Text("What is this?"));
    steps.push([stepOne]);
    story.set("_id", 7);
    story.set("story_id", "the-story");
    story.set("steps", steps);
    ydoc.getArray<unknown>("stories").push([story]);
  }, null);
  return { story };
}

/** What stands in a story's steps: the ids, or a marker naming the intruder. */
function stepMembers(story: Y.Map<unknown>): unknown {
  const steps = story.get("steps");
  if (!(steps instanceof Y.Array)) return `NOT AN ARRAY: ${JSON.stringify(steps)}`;
  return steps.toArray().map((s) =>
    s instanceof Y.Map ? s.get("_id") : `NOT A MAP: ${JSON.stringify(s)}`);
}

describe("a born array attached to an existing story — structural shape", () => {
  it("refuses a non-map member inside it", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const fresh = new Y.Array<unknown>();
      const step = new Y.Map<unknown>();
      step.set("_id", 99);
      fresh.push([step]);
      fresh.push([null]);
      story.set("steps", fresh);
    });

    // The null would be `.get(i)` in every consumer that walks steps as maps.
    expect(stepMembers(story)).not.toContain("NOT A MAP: null");
  });

  it("refuses a wrong-shaped nested key on a born member inside it", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const fresh = new Y.Array<unknown>();
      const step = new Y.Map<unknown>();
      step.set("_id", 99);
      step.set("layers", JSON.parse("{}"));
      fresh.push([step]);
      story.set("steps", fresh);
    });

    const steps = story.get("steps") as Y.Array<unknown>;
    const survivors = steps.toArray().filter((s) => s instanceof Y.Map) as Y.Map<unknown>[];
    for (const step of survivors) {
      const layers = step.get("layers");
      expect(layers === undefined || layers instanceof Y.Array).toBe(true);
    }
  });

  it("control: the same member in the story's existing array", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      (story.get("steps") as Y.Array<unknown>).push([null]);
    });

    expect(stepMembers(story)).toEqual([11]);
  });
});

describe("a born array attached to an existing story — identity domain", () => {
  it("removes a born member whose row id is out of domain", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const fresh = new Y.Array<unknown>();
      const step = new Y.Map<unknown>();
      // `_id` is minted by the Durable Object and is an integer. A string
      // there names no row, and the reconciler cannot say which one it meant.
      step.set("_id", "not-a-row-id");
      fresh.push([step]);
      story.set("steps", fresh);
    });

    expect(stepMembers(story)).not.toContain("not-a-row-id");
  });

  it("control: the same member in the story's existing array", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const step = new Y.Map<unknown>();
      step.set("_id", "not-a-row-id");
      (story.get("steps") as Y.Array<unknown>).push([step]);
    });

    expect(stepMembers(story)).toEqual([11]);
  });
});

describe("an array that already existed is not this pass's to answer for", () => {
  /**
   * The other half of the container-age rule, and the reason it is stated that
   * way round. A member that was already wrong before the transaction is an
   * inherited plant: load-time normalisation owns it, because choosing what
   * belongs there needs D1, which a synchronous `afterTransaction` guard has
   * no way to read. Removing it here would also mean one client's ordinary
   * edit being answered with a deletion of another client's value — and a
   * pass that walked every existing array on every transaction would be doing
   * load-time repair on the hot path.
   */
  const seedWithInheritedPlant = (ydoc: Y.Doc) => {
    const story = new Y.Map<unknown>();
    const steps = new Y.Array<unknown>();
    const step = new Y.Map<unknown>();
    ydoc.transact(() => {
      step.set("_id", 11);
      steps.push([step]);
      // Already standing before any client transaction — what a document
      // planted before the guard shipped looks like.
      steps.push([null]);
      story.set("_id", 7);
      story.set("story_id", "the-story");
      story.set("steps", steps);
      ydoc.getArray<unknown>("stories").push([story]);
    }, null);
    return { story };
  };

  it("leaves an inherited non-map member where it stands", () => {
    const h = makeHarness();
    const { story } = seedWithInheritedPlant(h.ydoc);

    // An edit elsewhere on the story, which is what brings the map into the
    // candidate set at all.
    h.asUser(fakeSocket(2, "collaborator"), () => { story.set("story_id", "renamed"); });

    expect(stepMembers(story)).toEqual([11, "NOT A MAP: null"]);
  });

  it("leaves an inherited out-of-domain row id where it stands", () => {
    const h = makeHarness();
    const story = new Y.Map<unknown>();
    const steps = new Y.Array<unknown>();
    const step = new Y.Map<unknown>();
    h.ydoc.transact(() => {
      step.set("_id", "not-a-row-id");
      steps.push([step]);
      story.set("_id", 7);
      story.set("story_id", "the-story");
      story.set("steps", steps);
      h.ydoc.getArray<unknown>("stories").push([story]);
    }, null);

    h.asUser(fakeSocket(2, "collaborator"), () => { story.set("story_id", "renamed"); });

    expect(stepMembers(story)).toEqual(["not-a-row-id"]);
  });
});

describe("the existing content survives the refusal", () => {
  it("never reaches the persistence halt, which no client value may", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const fresh = new Y.Array<unknown>();
      fresh.push([null]);
      story.set("steps", fresh);
    });

    expect(h.halts).toEqual([]);
  });
});
