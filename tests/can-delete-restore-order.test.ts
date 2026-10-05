/**
 * Restore order for the canDelete rule.
 *
 * The rule reverts an unauthorised delete by rebuilding the tombstoned Y.Map
 * and inserting it back. This file pins WHERE it goes back, which matters
 * because stories, steps and pages publish their array order: a reader of the
 * built site sees the sequence, so a revert that returns the entities whole
 * but shuffled has still corrupted the story.
 *
 * The failing shape was a transaction removing several siblings at once. The
 * position each entity is restored to has to be read in two frames — the
 * pre-transaction order, which says which sibling comes first, and the
 * surviving array, which says what index that answers to now — and collapsing
 * the two gave every sibling in one transaction the same slot, so they came
 * back reversed.
 *
 * The interleaved-insert and part-authorised cases are here because they are
 * the two ways the two frames disagree by something other than the restores
 * themselves: an insert the transaction is entitled to make occupies a slot in
 * the surviving array that never existed before it, and a delete the actor was
 * entitled to make vacates one that is never coming back.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import * as Y from "yjs";
import { makeCanDeleteHandler, makeViolationCounter } from "../workers/can-delete";

// ---------------------------------------------------------------------------
// Harness — mirrors tests/collaboration-can-delete.test.ts
// ---------------------------------------------------------------------------

type Role = "convenor" | "collaborator" | "instructor";

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: Role };
  // Written out rather than left as the bare mock type: that type carries no
  // call signature, so `ws.send(...)` below would not typecheck.
  send: Mock<(message: Uint8Array) => void>;
  close: Mock<(code?: number, reason?: string) => void>;
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
  sockets: FakeWS[];
  warns: string[];
  installHandler: () => void;
}

function makeHarness(): Harness {
  const ydoc = new Y.Doc();
  const sockets: FakeWS[] = [];
  const isReverting = { value: false };
  const warns: string[] = [];
  const recordViolation = makeViolationCounter();

  const installHandler = () => {
    const handler = makeCanDeleteHandler({
      ydoc,
      isSnapshotting: () => false,
      isReverting: () => isReverting.value,
      setReverting: (v: boolean) => { isReverting.value = v; },
      getSockets: () => sockets as unknown as Iterable<WebSocket>,
      broadcastUpdate: (msg: Uint8Array) => {
        for (const ws of sockets) ws.send(msg);
      },
      recordViolation,
      warn: (msg: string) => { warns.push(msg); },
    });
    ydoc.on("afterTransaction", handler);
  };

  return { ydoc, sockets, warns, installHandler };
}

function seedStory(
  ydoc: Y.Doc,
  opts: { createdBy: number; tempId: string },
): Y.Map<unknown> {
  const stories = ydoc.getArray<Y.Map<unknown>>("stories");
  let storyMap!: Y.Map<unknown>;
  ydoc.transact(() => {
    storyMap = new Y.Map<unknown>();
    storyMap.set("_id", null);
    storyMap.set("_temp_id", opts.tempId);
    storyMap.set("created_by", opts.createdBy);
    storyMap.set("title", new Y.Text(`story-${opts.tempId}`));
    storyMap.set("steps", new Y.Array<Y.Map<unknown>>());
    stories.push([storyMap]);
  }, null);
  return storyMap;
}

/** Build a detached story Y.Map for a client-side insert inside a transaction. */
function newStory(opts: { createdBy: number; tempId: string }): Y.Map<unknown> {
  const storyMap = new Y.Map<unknown>();
  storyMap.set("_id", null);
  storyMap.set("_temp_id", opts.tempId);
  storyMap.set("created_by", opts.createdBy);
  storyMap.set("title", new Y.Text(`story-${opts.tempId}`));
  storyMap.set("steps", new Y.Array<Y.Map<unknown>>());
  return storyMap;
}

function tempIds(ydoc: Y.Doc): unknown[] {
  return ydoc
    .getArray<Y.Map<unknown>>("stories")
    .toArray()
    .map((m) => m.get("_temp_id"));
}

const CONVENOR = 1;
const COLLABORATOR = 2;

// ---------------------------------------------------------------------------

describe("canDelete revert — restores siblings in their original order", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
  });

  it("puts two siblings deleted in one transaction back in order", () => {
    const h = makeHarness();
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    h.sockets.push(collab);
    for (const tempId of ["s-a", "s-b", "s-c"]) {
      seedStory(h.ydoc, { createdBy: CONVENOR, tempId });
    }
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 2);
    });

    expect(tempIds(h.ydoc)).toEqual(["s-a", "s-b", "s-c"]);
  });

  it("puts three contiguous siblings back in order", () => {
    const h = makeHarness();
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    h.sockets.push(collab);
    for (const tempId of ["s-a", "s-b", "s-c", "s-d"]) {
      seedStory(h.ydoc, { createdBy: CONVENOR, tempId });
    }
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 3);
    });

    expect(tempIds(h.ydoc)).toEqual(["s-a", "s-b", "s-c", "s-d"]);
  });

  it("puts a non-contiguous selection back in its own slots", () => {
    const h = makeHarness();
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    h.sockets.push(collab);
    for (const tempId of ["s-a", "s-b", "s-c", "s-d"]) {
      seedStory(h.ydoc, { createdBy: CONVENOR, tempId });
    }
    h.installHandler();

    // Indices 0 and 2 of four. The second `delete` runs against the array as
    // the first left it, so index 1 is "s-c".
    asUser(h.ydoc, collab, () => {
      const stories = h.ydoc.getArray<Y.Map<unknown>>("stories");
      stories.delete(0, 1);
      stories.delete(1, 1);
    });

    expect(tempIds(h.ydoc)).toEqual(["s-a", "s-b", "s-c", "s-d"]);
  });

  it("puts a trailing pair back after the survivors", () => {
    const h = makeHarness();
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    h.sockets.push(collab);
    for (const tempId of ["s-a", "s-b", "s-c", "s-d"]) {
      seedStory(h.ydoc, { createdBy: CONVENOR, tempId });
    }
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(2, 2);
    });

    expect(tempIds(h.ydoc)).toEqual(["s-a", "s-b", "s-c", "s-d"]);
  });

  it("leaves a single unauthorised delete where it always went", () => {
    const h = makeHarness();
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    h.sockets.push(collab);
    for (const tempId of ["s-a", "s-b", "s-c"]) {
      seedStory(h.ydoc, { createdBy: CONVENOR, tempId });
    }
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(1, 1);
    });

    expect(tempIds(h.ydoc)).toEqual(["s-a", "s-b", "s-c"]);
  });

  it("restores siblings around an insert the same transaction was entitled to make", () => {
    const h = makeHarness();
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    h.sockets.push(collab);
    for (const tempId of ["s-a", "s-b", "s-c"]) {
      seedStory(h.ydoc, { createdBy: CONVENOR, tempId });
    }
    h.installHandler();

    // The collaborator adds a story of their own between "s-a" and "s-b" and
    // removes the two convenor-owned stories that followed it, all at once.
    // The insert stands; the deletes come back around it.
    asUser(h.ydoc, collab, () => {
      const stories = h.ydoc.getArray<Y.Map<unknown>>("stories");
      stories.insert(1, [newStory({ createdBy: COLLABORATOR, tempId: "s-new" })]);
      stories.delete(2, 2);
    });

    expect(tempIds(h.ydoc)).toEqual(["s-a", "s-new", "s-b", "s-c"]);
  });

  it("restores siblings around a delete the same transaction was entitled to make", () => {
    const h = makeHarness();
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    h.sockets.push(collab);
    seedStory(h.ydoc, { createdBy: COLLABORATOR, tempId: "s-own" });
    seedStory(h.ydoc, { createdBy: CONVENOR, tempId: "s-a" });
    seedStory(h.ydoc, { createdBy: CONVENOR, tempId: "s-b" });
    h.installHandler();

    // One transaction, three removals: the collaborator's own story goes for
    // good, the two convenor-owned ones come back. The vacated slot must not
    // push the restores along.
    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 3);
    });

    expect(tempIds(h.ydoc)).toEqual(["s-a", "s-b"]);
  });

  it("does not push a lone restore along by the slot an authorised delete vacated", () => {
    const h = makeHarness();
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    h.sockets.push(collab);
    seedStory(h.ydoc, { createdBy: COLLABORATOR, tempId: "s-own" });
    seedStory(h.ydoc, { createdBy: CONVENOR, tempId: "s-a" });
    seedStory(h.ydoc, { createdBy: CONVENOR, tempId: "s-b" });
    h.installHandler();

    // Only "s-a" is restored, and it belongs at the head: the slot "s-own"
    // held is gone for good, so counting it towards "s-a"'s target would put
    // the restore behind the survivor.
    asUser(h.ydoc, collab, () => {
      h.ydoc.getArray<Y.Map<unknown>>("stories").delete(0, 2);
    });

    expect(tempIds(h.ydoc)).toEqual(["s-a", "s-b"]);
  });

  it("puts nested steps back in order when a step pair is removed at once", () => {
    const h = makeHarness();
    const collab = fakeSocket(COLLABORATOR, "collaborator");
    h.sockets.push(collab);
    const story = seedStory(h.ydoc, { createdBy: COLLABORATOR, tempId: "s-own" });
    const steps = story.get("steps") as Y.Array<Y.Map<unknown>>;
    h.ydoc.transact(() => {
      for (const tempId of ["st-a", "st-b", "st-c"]) {
        const step = new Y.Map<unknown>();
        step.set("_id", null);
        step.set("_temp_id", tempId);
        step.set("created_by", CONVENOR);
        step.set("layers", new Y.Array<Y.Map<unknown>>());
        steps.push([step]);
      }
    }, null);
    h.installHandler();

    asUser(h.ydoc, collab, () => {
      steps.delete(0, 2);
    });

    expect(steps.toArray().map((m) => m.get("_temp_id"))).toEqual([
      "st-a",
      "st-b",
      "st-c",
    ]);
  });
});

function asUser(ydoc: Y.Doc, ws: FakeWS, fn: () => void): void {
  ydoc.transact(fn, ws);
}
