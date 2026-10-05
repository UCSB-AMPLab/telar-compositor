/**
 * A structural container on a map that already existed may not be taken away.
 *
 * `steps`, `layers`, `navigation` and `landing` hold containers the server
 * walks. Setting one of them to a wrong-shaped value is refused. Two other
 * ways of emptying it were not: assigning a fresh, correctly-shaped container,
 * and deleting the key outright. Both are more damaging than the refused one.
 *
 * What happens is worse than a plain loss. Displacing a shared type deletes
 * everything inside it, and the delete pass DOES see those deletions and
 * refuses them — but it restores into the array it holds a reference to, which
 * is the one just detached. So the story keeps the empty replacement, the
 * content is unreachable, and the log reports the deletions reverted. A
 * collaborator who may not delete a single step can empty a whole story this
 * way and read a success line for it.
 *
 * Deleting the key is worse still, because the loss outlives the document: the
 * reconciler reads an absent key as "no steps" and schedules every step and
 * layer row for deletion in D1.
 *
 * The rule is about the container's identity, not its shape, and it is safe
 * because of what the client does: `use-structural-ops.ts` sets these keys
 * only on a story or step it is creating in the same transaction, never on one
 * that already existed, and deletes none of them anywhere. A map born in this
 * transaction reads absent before it and is left alone.
 *
 * The trap on the defending side, which cost a persistence halt to find: a key
 * carrying an INHERITED plant has no container to defend. Policy leaves such a
 * value standing for load-time normalisation, so a client replacing a `{}`
 * with a real array is repairing the document. Treating that as a displacement
 * tries to rebuild `{}`, fails, and stops the project persisting until a reset
 * — the one outcome no client-authored value may cause.
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
    warn: () => { /* asserted through the document */ },
    onEnforcementFailure: (detail) => { halts.push(detail); },
  }));
  return {
    ydoc,
    halts,
    asUser: (ws: FakeWS, fn: () => void) => { ydoc.transact(fn, ws); },
  };
}

function seedStory(ydoc: Y.Doc) {
  const story = new Y.Map<unknown>();
  const steps = new Y.Array<unknown>();
  const one = new Y.Map<unknown>();
  const two = new Y.Map<unknown>();
  ydoc.transact(() => {
    one.set("_id", 11);
    one.set("question_md", new Y.Text("What is this?"));
    two.set("_id", 12);
    steps.push([one]);
    steps.push([two]);
    story.set("_id", 7);
    story.set("story_id", "the-story");
    story.set("steps", steps);
    ydoc.getArray<unknown>("stories").push([story]);
  }, null);
  return { story };
}

function stepIds(story: Y.Map<unknown>): unknown {
  const steps = story.get("steps");
  if (!(steps instanceof Y.Array)) return `NOT AN ARRAY: ${JSON.stringify(steps)}`;
  return steps.toArray().map((s) => (s instanceof Y.Map ? s.get("_id") : "NOT A MAP"));
}

describe("swapping a story's steps for another container", () => {
  it("brings the steps back when the replacement is empty", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      story.set("steps", new Y.Array<unknown>());
    });

    expect(stepIds(story)).toEqual([11, 12]);
  });

  it("brings them back when the replacement carries a step of its own", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const replacement = new Y.Array<unknown>();
      const step = new Y.Map<unknown>();
      step.set("_id", 13);
      replacement.push([step]);
      story.set("steps", replacement);
    });

    expect(stepIds(story)).toEqual([11, 12]);
  });

  it("brings back the prose too, not merely the shape", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      story.set("steps", new Y.Array<unknown>());
    });

    const first = (story.get("steps") as Y.Array<unknown>).get(0) as Y.Map<unknown>;
    expect(String(first.get("question_md"))).toBe("What is this?");
  });

  it("refuses the convenor too — this is structure, not authority", () => {
    // A convenor may delete steps, and `steps.delete(0, 2)` is how. Swapping
    // the container detaches content the mirror cannot follow, which is not a
    // thing anyone's role makes safe.
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(1, "convenor"), () => {
      story.set("steps", new Y.Array<unknown>());
    });

    expect(stepIds(story)).toEqual([11, 12]);
  });

  it("leaves a story created with its own steps alone", () => {
    const h = makeHarness();
    seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const fresh = new Y.Map<unknown>();
      const steps = new Y.Array<unknown>();
      const step = new Y.Map<unknown>();
      step.set("_id", 21);
      steps.push([step]);
      fresh.set("_id", 8);
      fresh.set("story_id", "a-new-story");
      fresh.set("steps", steps);
      h.ydoc.getArray<unknown>("stories").push([fresh]);
    });

    const stories = h.ydoc.getArray<unknown>("stories");
    expect(stories.length).toBe(2);
    expect(stepIds(stories.get(1) as Y.Map<unknown>)).toEqual([21]);
  });

  it("leaves an ordinary edit inside the container alone", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const step = new Y.Map<unknown>();
      step.set("_id", 13);
      (story.get("steps") as Y.Array<unknown>).push([step]);
    });

    expect(stepIds(story)).toEqual([11, 12, 13]);
  });

  it("brings the steps back when the key is deleted outright", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => { story.delete("steps"); });

    expect(stepIds(story)).toEqual([11, 12]);
  });

  it("leaves the key present after a delete, which absence would cost rows for", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => { story.delete("steps"); });

    expect(story.has("steps")).toBe(true);
  });

  it("permits repairing an inherited plant with a real container", () => {
    // The key never held a container, so there is nothing to defend and the
    // client is fixing the document. Refusing it would fail to rebuild the
    // plant and halt persistence.
    const h = makeHarness();
    const story = new Y.Map<unknown>();
    h.ydoc.transact(() => {
      story.set("_id", 7);
      story.set("story_id", "the-story");
      story.set("steps", JSON.parse("{}"));
      h.ydoc.getArray<unknown>("stories").push([story]);
    }, null);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const fresh = new Y.Array<unknown>();
      const step = new Y.Map<unknown>();
      step.set("_id", 99);
      fresh.push([step]);
      story.set("steps", fresh);
    });

    expect(stepIds(story)).toEqual([99]);
    expect(h.halts).toEqual([]);
  });

  it("permits deleting a key that only ever held an inherited plant", () => {
    const h = makeHarness();
    const story = new Y.Map<unknown>();
    h.ydoc.transact(() => {
      story.set("_id", 7);
      story.set("story_id", "the-story");
      story.set("steps", JSON.parse("{}"));
      h.ydoc.getArray<unknown>("stories").push([story]);
    }, null);

    h.asUser(fakeSocket(2, "collaborator"), () => { story.delete("steps"); });

    expect(story.has("steps")).toBe(false);
    expect(h.halts).toEqual([]);
  });

  it("never reaches the persistence halt", () => {
    const h = makeHarness();
    const { story } = seedStory(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      story.set("steps", new Y.Array<unknown>());
    });

    expect(h.halts).toEqual([]);
  });
});
