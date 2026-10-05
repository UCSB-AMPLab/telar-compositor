/**
 * A removal inside a map that is itself being removed is not a second removal.
 *
 * The two passes schedule removals against different arrays: the identity pass
 * removes a whole forged map from the root array it stands in, and the
 * structural pass removes one member from a story's own `steps`. When the
 * forged map is the one holding that `steps` array, the two are not siblings —
 * one contains the other, and taking the container away takes the member with
 * it.
 *
 * The trap this file exists to pin: the sweep ordered removals by numeric
 * index alone, which is a rule about SHIFTS within one array and says nothing
 * about one array living inside another. The whole map went first, tombstoning
 * its `steps`, and the member removal then threw `Length exceeded!` against a
 * dead array.
 *
 * What makes that severe is where the throw lands. `onEnforcementFailure`
 * stops the project persisting until a reset rebuilds it from D1, and its own
 * contract says a value a client can author must never reach it — otherwise
 * the safeguard is an availability attack. One crafted transaction reached it.
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
  const warns: string[] = [];
  ydoc.on("afterTransaction", makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => false,
    isReverting: () => isReverting.value,
    setReverting: (v: boolean) => { isReverting.value = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => { /* not under test */ },
    recordViolation: makeViolationCounter(),
    warn: (msg: string) => { warns.push(msg); },
    onEnforcementFailure: (detail) => { halts.push(detail); },
  }));
  return {
    ydoc,
    halts,
    warns,
    asUser: (ws: FakeWS, fn: () => void) => { ydoc.transact(fn, ws); },
  };
}

/** Two stories, so a forgery can claim the row id of one that stays. */
function seedStories(ydoc: Y.Doc) {
  const first = new Y.Map<unknown>();
  const steps = new Y.Array<unknown>();
  const step = new Y.Map<unknown>();
  ydoc.transact(() => {
    step.set("_id", 11);
    step.set("question_md", new Y.Text("What is this?"));
    steps.push([step]);
    first.set("_id", 7);
    first.set("story_id", "the-story");
    first.set("steps", steps);
    ydoc.getArray<unknown>("stories").push([first]);
  }, null);
  return { first };
}

function storyIds(ydoc: Y.Doc): unknown[] {
  return ydoc.getArray<unknown>("stories").toArray()
    .map((s) => (s instanceof Y.Map ? s.get("_id") : "NOT A MAP"));
}

describe("a forged map whose own born container also breaks a rule", () => {
  /**
   * The forgery claims the row id of a story that stays, so the identity pass
   * removes it whole; the `steps` it was born with carries a `null`, so the
   * structural pass reports that member. Both removals name arrays, and one of
   * those arrays is inside the map the other removal deletes.
   */
  const plant = (ydoc: Y.Doc) => {
    const twin = new Y.Map<unknown>();
    const steps = new Y.Array<unknown>();
    steps.push([null]);
    twin.set("_id", 7);
    twin.set("story_id", "the-twin");
    twin.set("steps", steps);
    ydoc.getArray<unknown>("stories").push([twin]);
  };

  it("does not reach the persistence halt", () => {
    const h = makeHarness();
    seedStories(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => { plant(h.ydoc); });

    expect(h.halts).toEqual([]);
  });

  it("logs no revert failure", () => {
    const h = makeHarness();
    seedStories(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => { plant(h.ydoc); });

    expect(h.warns.filter((w) => w.includes("revert-failed"))).toEqual([]);
  });

  it("removes the forgery and leaves the genuine story whole", () => {
    const h = makeHarness();
    const { first } = seedStories(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => { plant(h.ydoc); });

    expect(storyIds(h.ydoc)).toEqual([7]);
    const steps = first.get("steps");
    expect(steps).toBeInstanceOf(Y.Array);
    const step = (steps as Y.Array<unknown>).get(0) as Y.Map<unknown>;
    expect(step.get("_id")).toBe(11);
    expect(String(step.get("question_md"))).toBe("What is this?");
  });

  it("does the same when the forgery stands ahead of the story it copies", () => {
    // Index order is the thing that used to decide the sweep, so the case
    // where the container sorts BEFORE its own member must answer alike.
    const h = makeHarness();
    seedStories(h.ydoc);

    h.asUser(fakeSocket(2, "collaborator"), () => {
      const twin = new Y.Map<unknown>();
      const steps = new Y.Array<unknown>();
      steps.push([null]);
      twin.set("_id", 7);
      twin.set("story_id", "the-twin");
      twin.set("steps", steps);
      h.ydoc.getArray<unknown>("stories").insert(0, [twin]);
    });

    expect(h.halts).toEqual([]);
    expect(storyIds(h.ydoc)).toEqual([7]);
  });
});
