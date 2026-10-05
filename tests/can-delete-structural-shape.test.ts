/**
 * A client may not put a traversed key out of shape.
 *
 * `steps`, `layers`, `navigation` and `landing` are the keys the server walks.
 * Yjs stores plain JSON verbatim, so a collaborator can set any of them to
 * `{}`, `[]`, `"x"` or `null`, and the server's next line — `.get(i)`,
 * `.toArray()` — is a `TypeError` inside whichever batch it was in. The
 * reconciler no longer breaks on one, but it cannot un-break the document: the
 * value stays where it was written and that editor is unusable until somebody
 * clears it by hand.
 *
 * So the write is refused at entry. Refusal is the whole remedy — nothing here
 * reconstructs from D1 or guesses. That is what separates this from the
 * load-time repair removed on 28 August: an identity plant left the server
 * unable to say WHICH entity a value meant, and every answer was a guess.
 * There is no equivalent question here. `steps` either holds a `Y.Array` or it
 * does not, and what it held a moment ago is a fact the transaction carries.
 *
 * The trap this file exists to pin: the obvious revert DESTROYS the data it is
 * defending. The previous value is a shared type; Yjs reintegrates rather than
 * copies, so writing it back throws, and the generic field-revert answers a
 * throw by CLEARING the key — which for `steps` would delete the story's steps
 * and finish what the plant started. A displaced type also reads as empty the
 * instant its key is overwritten, so the content comes back only through the
 * snapshot. Every test below asserts the CONTENT, never merely the type.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  makeCanDeleteHandler,
  makeViolationCounter,
  extractStructuralShapeViolations,
} from "../workers/can-delete";

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
    asUser: (ws: FakeWS, fn: () => void) => { ydoc.transact(fn, ws); },
  };
}

/** A story carrying two steps, the first with a layer. Written server-side. */
function seedStory(ydoc: Y.Doc) {
  const story = new Y.Map<unknown>();
  const steps = new Y.Array<unknown>();
  const stepOne = new Y.Map<unknown>();
  const stepTwo = new Y.Map<unknown>();
  const layers = new Y.Array<unknown>();
  const layer = new Y.Map<unknown>();
  ydoc.transact(() => {
    layer.set("_id", 91);
    layers.push([layer]);
    stepOne.set("_id", 11);
    stepOne.set("question_md", new Y.Text("What is this?"));
    stepOne.set("layers", layers);
    stepTwo.set("_id", 12);
    steps.push([stepOne]);
    steps.push([stepTwo]);
    story.set("_id", 7);
    story.set("story_id", "the-story");
    story.set("steps", steps);
    ydoc.getArray<unknown>("stories").push([story]);
  }, null);
  return { story, stepOne };
}

/** The ids in a story's steps, or a marker saying what stands there instead. */
function stepIds(story: Y.Map<unknown>): unknown {
  const steps = story.get("steps");
  if (!(steps instanceof Y.Array)) return `NOT AN ARRAY: ${JSON.stringify(steps)}`;
  return steps.toArray().map((s) => (s instanceof Y.Map ? s.get("_id") : "NOT A MAP"));
}

const PLANTS: Array<[string, () => unknown]> = [
  ["a plain object", () => JSON.parse("{}")],
  ["a plain array", () => JSON.parse("[]")],
  ["a string", () => "steps"],
  ["a number", () => 0],
  ["null", () => null],
];

describe.each(PLANTS)("a collaborator setting steps to %s", (_label, makePlant) => {
  it("is refused, and the steps come back with their content", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);
    const ws = fakeSocket(2, "collaborator");

    h.asUser(ws, () => { story.set("steps", makePlant()); });

    expect(stepIds(story)).toEqual([11, 12]);
  });

  it("brings back the nested layers and the prose, not just the shape", () => {
    // The trap: a revert that satisfied `instanceof Y.Array` with an empty
    // array would pass a shape assertion and still have destroyed the story.
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);
    h.asUser(fakeSocket(2, "collaborator"), () => { story.set("steps", makePlant()); });

    const steps = story.get("steps") as Y.Array<unknown>;
    const first = steps.get(0) as Y.Map<unknown>;
    expect((first.get("question_md") as Y.Text).toString()).toBe("What is this?");
    const layers = first.get("layers") as Y.Array<unknown>;
    expect((layers.get(0) as Y.Map<unknown>).get("_id")).toBe(91);
  });
});

describe("a convenor is held to the same rule", () => {
  it("cannot put steps out of shape on a document with no course items", () => {
    // The snapshot used to be skipped for exactly this case, on the reasoning
    // that no pass could use one. This pass can, and without it there would be
    // nothing to put back.
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(1, "convenor"), () => { story.set("steps", JSON.parse("{}")); });

    expect(stepIds(story)).toEqual([11, 12]);
  });
});

describe("layers, navigation and landing", () => {
  it("refuses a wrong-shaped layers and restores its content", () => {
    const h = makeHarness();
    const { stepOne } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => { stepOne.set("layers", "gone"); });

    const layers = stepOne.get("layers");
    expect(layers).toBeInstanceOf(Y.Array);
    expect((layers as Y.Array<unknown>).length).toBe(1);
    expect(((layers as Y.Array<unknown>).get(0) as Y.Map<unknown>).get("_id")).toBe(91);
  });

  it("refuses a wrong-shaped navigation on the config root", () => {
    const h = makeHarness();
    const config = h.ydoc.getMap<unknown>("config");
    const nav = new Y.Array<unknown>();
    h.ydoc.transact(() => {
      nav.push(["about"]);
      config.set("navigation", nav);
    }, null);

    h.asUser(fakeSocket(2, "collaborator"), () => { config.set("navigation", JSON.parse("{}")); });

    const restored = config.get("navigation");
    expect(restored).toBeInstanceOf(Y.Array);
    expect((restored as Y.Array<unknown>).toArray()).toEqual(["about"]);
  });

  it("refuses a wrong-shaped landing on the config root", () => {
    const h = makeHarness();
    const config = h.ydoc.getMap<unknown>("config");
    const landing = new Y.Map<unknown>();
    h.ydoc.transact(() => {
      landing.set("welcome_body", new Y.Text("Welcome"));
      config.set("landing", landing);
    }, null);

    h.asUser(fakeSocket(2, "collaborator"), () => { config.set("landing", JSON.parse("[]")); });

    const restored = config.get("landing");
    expect(restored).toBeInstanceOf(Y.Map);
    expect(((restored as Y.Map<unknown>).get("welcome_body") as Y.Text).toString()).toBe("Welcome");
  });
});

describe("a key that held nothing", () => {
  it("is cleared rather than filled in", () => {
    // Refusing a write to a key that held nothing IS deleting it. Inventing an
    // empty container would be the server writing content it was never asked
    // for, and the client creates the array when it needs one.
    const h = makeHarness();
    const story = new Y.Map<unknown>();
    h.ydoc.transact(() => {
      story.set("_id", 8);
      story.set("story_id", "no-steps-yet");
      h.ydoc.getArray<unknown>("stories").push([story]);
    }, null);

    h.asUser(fakeSocket(2, "collaborator"), () => { story.set("steps", JSON.parse("{}")); });

    expect(story.has("steps")).toBe(false);
  });

  it("does not remove the story a born plant arrived on", () => {
    // The identity pass removes a born map whole, because a forged `_id` makes
    // the whole entity a forgery. A wrong-shaped `steps` does not: the story is
    // the user's, only the value is wrong.
    const h = makeHarness();
    const ws = fakeSocket(2, "collaborator");
    const story = new Y.Map<unknown>();

    h.asUser(ws, () => {
      story.set("story_id", "brand-new");
      story.set("steps", JSON.parse("{}"));
      h.ydoc.getArray<unknown>("stories").push([story]);
    });

    const stories = h.ydoc.getArray<unknown>("stories");
    expect(stories.length).toBe(1);
    expect((stories.get(0) as Y.Map<unknown>).get("story_id")).toBe("brand-new");
    expect((stories.get(0) as Y.Map<unknown>).has("steps")).toBe(false);
  });
});

describe("an element that is not a Y.Map", () => {
  it("is removed from the array it was inserted into", () => {
    const h = makeHarness();
    seedStory(h.ydoc);
    const stories = h.ydoc.getArray<unknown>("stories");

    h.asUser(fakeSocket(2, "collaborator"), () => {
      stories.push([JSON.parse('{"_id": 999}')]);
    });

    expect(stories.length).toBe(1);
    expect((stories.get(0) as Y.Map<unknown>).get("_id")).toBe(7);
  });

  it("leaves an inherited non-map standing", () => {
    // Removing one would be the load-time repair the 28 August ruling took
    // out, in a new place: this guard refuses what a transaction WRITES, and
    // an inherited value was written by nobody it can refuse. It is the
    // detector's, and the reconciler already declines to sweep a table while
    // one stands.
    const h = makeHarness();
    seedStory(h.ydoc);
    const stories = h.ydoc.getArray<unknown>("stories");
    h.ydoc.transact(() => { stories.push([JSON.parse('{"_id": 999}')]); }, null);

    // The array itself must be in `tr.changed` for the sweep to look at its
    // members at all, so the collaborator adds a story: that is the
    // transaction in which every member is examined and the inherited one has
    // to survive.
    const fresh = new Y.Map<unknown>();
    h.asUser(fakeSocket(2, "collaborator"), () => {
      fresh.set("story_id", "mine");
      stories.push([fresh]);
    });

    expect(stories.length).toBe(3);
    expect(stories.get(1)).toEqual({ _id: 999 });
    expect((stories.get(2) as Y.Map<unknown>).get("story_id")).toBe("mine");
  });

  it("finds the plant when a deleted item sits ahead of it in the same transaction", () => {
    // The index the sweep reports addresses VISIBLE positions, and the item
    // walk that decides whether a value is new has to count the same way. A
    // tombstone left in the count shifts every position after it, and the
    // clock read then belongs to a different item — so the plant is judged by
    // its neighbour's age and the sweep either spares it or takes the wrong
    // member.
    const h = makeHarness();
    seedStory(h.ydoc);
    const stories = h.ydoc.getArray<unknown>("stories");
    const second = new Y.Map<unknown>();
    h.ydoc.transact(() => {
      second.set("_id", 8);
      second.set("story_id", "second");
      stories.push([second]);
    }, null);

    // A convenor: deleting a story is their right, so the delete passes leave
    // this transaction alone and only the element sweep acts on it.
    h.asUser(fakeSocket(1, "convenor"), () => {
      stories.delete(0, 1);
      stories.push([JSON.parse('{"_id": 999}')]);
    });

    expect(stories.toArray().every((m) => m instanceof Y.Map)).toBe(true);
    expect(stories.toArray().map((m) => (m as Y.Map<unknown>).get("_id"))).toEqual([8]);
  });

  it("leaves the real entities beside it alone", () => {
    const h = makeHarness();
    seedStory(h.ydoc);
    const stories = h.ydoc.getArray<unknown>("stories");
    const second = new Y.Map<unknown>();

    h.asUser(fakeSocket(2, "collaborator"), () => {
      stories.push([JSON.parse("[]")]);
      second.set("_id", 8);
      second.set("story_id", "second");
      stories.push([second]);
    });

    expect(stories.toArray().every((m) => m instanceof Y.Map)).toBe(true);
    expect(stories.toArray().map((m) => (m as Y.Map<unknown>).get("_id"))).toEqual([7, 8]);
  });
});

// ---------------------------------------------------------------------------
// Round ten — three CRITICALs, every one of them in this guard
// ---------------------------------------------------------------------------

describe("equal primitive members are removed one for one", () => {
  it("removes both of two nulls inserted at two positions", () => {
    // The sweep keyed removals by the MEMBER, which is a stable reference for
    // a Y.Map and not a distinguishing one for a primitive: two nulls are one
    // Map key, so one removal ran and the other null stood in an array every
    // consumer walks as Y.Maps.
    const h = makeHarness();
    seedStory(h.ydoc);
    const stories = h.ydoc.getArray<unknown>("stories");

    h.asUser(fakeSocket(2, "collaborator"), () => {
      stories.push([null]);
      stories.push([null]);
    });

    expect(stories.toArray().every((m) => m instanceof Y.Map)).toBe(true);
    expect(stories.length).toBe(1);
  });

  it.each([
    ["nulls", null],
    ["zeroes", 0],
    ["empty strings", ""],
    ["equal strings", "same"],
  ])("removes every one of four equal %s", (_label, value) => {
    const h = makeHarness();
    seedStory(h.ydoc);
    const stories = h.ydoc.getArray<unknown>("stories");

    h.asUser(fakeSocket(2, "collaborator"), () => {
      stories.push([value, value, value, value]);
    });

    expect(stories.toArray().every((m) => m instanceof Y.Map)).toBe(true);
    expect(stories.length).toBe(1);
  });
});

describe("a non-map inside a container born in the same transaction", () => {
  it("is removed from a newly created story's steps", () => {
    // A `steps` array born inside a born story never appears in `tr.changed`
    // — its items post-date the transaction's before-state — so the top-level
    // scan never reached its members, and a null sat where the story editor
    // calls `.get()` on every element.
    const h = makeHarness();
    const story = new Y.Map<unknown>();
    const steps = new Y.Array<unknown>();
    const realStep = new Y.Map<unknown>();

    h.asUser(fakeSocket(2, "collaborator"), () => {
      realStep.set("_id", 21);
      steps.push([realStep]);
      steps.push([null]);
      story.set("story_id", "born-with-a-plant");
      story.set("steps", steps);
      h.ydoc.getArray<unknown>("stories").push([story]);
    });

    const live = story.get("steps") as Y.Array<unknown>;
    expect(live.toArray().every((m) => m instanceof Y.Map)).toBe(true);
    expect(live.length).toBe(1);
    expect((live.get(0) as Y.Map<unknown>).get("_id")).toBe(21);
  });

  it("is removed from a newly created step's layers, two levels down", () => {
    const h = makeHarness();
    const story = new Y.Map<unknown>();
    const steps = new Y.Array<unknown>();
    const step = new Y.Map<unknown>();
    const layers = new Y.Array<unknown>();

    h.asUser(fakeSocket(2, "collaborator"), () => {
      layers.push([JSON.parse("{}")]);
      step.set("_id", 31);
      step.set("layers", layers);
      steps.push([step]);
      story.set("story_id", "deep");
      story.set("steps", steps);
      h.ydoc.getArray<unknown>("stories").push([story]);
    });

    const liveLayers = ((story.get("steps") as Y.Array<unknown>).get(0) as Y.Map<unknown>)
      .get("layers") as Y.Array<unknown>;
    expect(liveLayers.length).toBe(0);
  });
});

describe("a Y type that is not exactly the container it resembles", () => {
  it("refuses an XmlHook written to landing, which instanceof called a Y.Map", () => {
    // `Y.XmlHook extends Y.Map`, so an `instanceof` test admitted it — while
    // the mirror this guard restores through admits only the exact
    // constructor. Storing one, then replacing it with plain JSON, made the
    // rebuild of the "previous" value fail and left the plant standing.
    // Accepting a value the restore path cannot reproduce is the same defect
    // as accepting one the reconciler cannot read.
    const h = makeHarness();
    const config = h.ydoc.getMap<unknown>("config");
    const landing = new Y.Map<unknown>();
    h.ydoc.transact(() => {
      landing.set("welcome_body", new Y.Text("Welcome"));
      config.set("landing", landing);
    }, null);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      config.set("landing", new Y.XmlHook("whatever"));
    });

    const held = config.get("landing");
    expect(held).toBeInstanceOf(Y.Map);
    expect(held?.constructor).toBe(Y.Map);
    expect(((held as Y.Map<unknown>).get("welcome_body") as Y.Text).toString()).toBe("Welcome");
  });

  it("does not let an XmlHook become the previous value a later plant restores to", () => {
    // The two-step version: store the subtype, then plant over it. With the
    // subtype refused on the way in, there is no step two.
    const h = makeHarness();
    const config = h.ydoc.getMap<unknown>("config");
    const ws = fakeSocket(2, "collaborator");

    h.asUser(ws, () => { config.set("landing", new Y.XmlHook("whatever")); });
    h.asUser(ws, () => { config.set("landing", JSON.parse("{}")); });

    // The key held nothing legitimate at any point, so it holds nothing now —
    // and never holds the plant.
    expect(config.get("landing")).toBeUndefined();
  });
});

describe("what the pass leaves alone", () => {
  it("does not fire on a transaction with no actor on its origin", () => {
    // The exemption is the actor, not the snapshot: a transaction whose origin
    // carries no user context is the DO's own, and every pass in this module
    // skips it.
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    // An origin object that is not a socket — no `deserializeAttachment`.
    h.ydoc.transact(() => { story.set("steps", JSON.parse("{}")); }, { some: "origin" });

    expect(story.get("steps")).toEqual({});
  });

  it("does not touch a server-origin write", () => {
    // The DO's own transactions run null-origin and are exempt, as every pass
    // in this module is: the guard is on what arrives from a socket.
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.ydoc.transact(() => { story.set("steps", JSON.parse("{}")); }, null);

    expect(story.get("steps")).toEqual({});
  });

  it("does not refuse a transaction for a value that was already out of shape", () => {
    // An inherited plant is the detector's business. Refusing a write that did
    // not make it would let one client's edit be refused for another's value.
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);
    h.ydoc.transact(() => { story.set("steps", JSON.parse("{}")); }, null);

    h.asUser(fakeSocket(2, "collaborator"), () => { story.set("title", new Y.Text("Edited")); });

    expect((story.get("title") as Y.Text).toString()).toBe("Edited");
    expect(story.get("steps")).toEqual({});
  });

  it("reports no restore at all for an inherited plant", () => {
    // Asserted on the pass rather than on the document, because the outcome is
    // the same either way — a rebuild of `{}` produces `{}`, which is not a
    // container, so the handler declines it. Same result, different reason,
    // and the reason is the rule: a transaction is refused for what IT wrote.
    const ydoc = new Y.Doc();
    const { story } = seedStory(ydoc);
    ydoc.transact(() => { story.set("steps", JSON.parse("{}")); }, null);

    let seen: ReturnType<typeof extractStructuralShapeViolations> | null = null;
    ydoc.on("afterTransaction", (tr) => {
      if (tr.origin === null) return;
      seen = extractStructuralShapeViolations(ydoc, tr);
    });
    ydoc.transact(() => { story.set("title", new Y.Text("Edited")); }, { user: 2 });

    const violations = seen as unknown as ReturnType<typeof extractStructuralShapeViolations>;
    expect(violations.restores).toEqual([]);
  });

  it("accepts an honest write of a real container onto a map being created", () => {
    // Swapping the container on a story that already exists is refused, and
    // `can-delete-displaced-container.test.ts` says why. What is honest is
    // what the client actually does: set the key on a story it is creating in
    // the same transaction.
    const h = makeHarness();
    seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const fresh = new Y.Map<unknown>();
      const replacement = new Y.Array<unknown>();
      const step = new Y.Map<unknown>();
      step.set("_id", 13);
      replacement.push([step]);
      fresh.set("_id", 8);
      fresh.set("story_id", "a-new-story");
      fresh.set("steps", replacement);
      h.ydoc.getArray<unknown>("stories").push([fresh]);
    });

    const stories = h.ydoc.getArray<unknown>("stories");
    expect(stepIds(stories.get(1) as Y.Map<unknown>)).toEqual([13]);
  });
});

describe("extractStructuralShapeViolations reports rather than acts", () => {
  it("names the key and carries what it held", () => {
    const ydoc = new Y.Doc();
    const { story } = seedStory(ydoc);
    let seen: ReturnType<typeof extractStructuralShapeViolations> | null = null;
    ydoc.on("afterTransaction", (tr) => {
      if (tr.origin === null) return;
      seen = extractStructuralShapeViolations(ydoc, tr);
    });

    ydoc.transact(() => { story.set("steps", JSON.parse("{}")); }, { user: 2 });

    expect(seen).not.toBeNull();
    const violations = seen as unknown as ReturnType<typeof extractStructuralShapeViolations>;
    expect(violations.restores).toHaveLength(1);
    expect(violations.restores[0].key).toBe("steps");
    expect(violations.restores[0].previous).toBeInstanceOf(Y.Array);
  });
});
