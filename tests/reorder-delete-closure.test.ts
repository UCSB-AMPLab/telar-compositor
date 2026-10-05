/**
 * reorder-delete-closure.test.ts — the delete-and-replace hole the reorder exemption
 * held open, now closed.
 *
 * `reorderInPlace` moved a list entry by deleting its Y.Map and
 * inserting a clone, so on the wire an honest drag and "delete a colleague's
 * entity, put a hollow one carrying their identity in its place" were the same
 * transaction. The own-content rule could not refuse the second without
 * refusing the first, so it carried an exemption — and the exemption had to
 * decide using `_temp_id` and `created_by`, both of which any collaborator can
 * write. An attacker who copied those two fields onto a hollow replacement was
 * waved through.
 *
 * Every list now moves an entry by writing its `order_key`. No reorder deletes
 * anything, so there is nothing to exempt, the exemption is gone, and a
 * delete-and-reinsert is what it always looked like: a delete.
 *
 * These are the tests that matter most. Each one passes ONLY because the
 * exemption is gone; each one failed before it was removed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  extractCourseItemDeletes,
  extractProtectedFieldMutations,
  extractUnauthorisedDeletes,
  makeCanDeleteHandler,
  makeViolationCounter,
} from "../workers/can-delete";

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: "convenor" | "collaborator" | "instructor" };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(userId: number, role: "convenor" | "collaborator" | "instructor"): FakeWS {
  return {
    deserializeAttachment: () => ({ userId, role }),
    send: vi.fn(),
    close: vi.fn(),
  };
}

function asUser(ydoc: Y.Doc, ws: FakeWS, fn: () => void): void {
  ydoc.transact(fn, ws);
}

function seedStory(
  ydoc: Y.Doc,
  spec: { createdBy: number; tempId: string; id?: number | null; title?: string },
): Y.Map<unknown> {
  const stories = ydoc.getArray<Y.Map<unknown>>("stories");
  const m = new Y.Map<unknown>();
  ydoc.transact(() => {
    m.set("_id", spec.id ?? null);
    m.set("_temp_id", spec.tempId);
    m.set("created_by", spec.createdBy);
    m.set("story_id", spec.tempId);
    m.set("title", new Y.Text(spec.title ?? spec.tempId));
    m.set("steps", new Y.Array<Y.Map<unknown>>());
    stories.push([m]);
  }, null);
  return m;
}

function seedObject(
  ydoc: Y.Doc,
  spec: { createdBy: number; tempId: string; id?: number | null; courseProjectId?: number },
): Y.Map<unknown> {
  const objects = ydoc.getArray<Y.Map<unknown>>("objects");
  const m = new Y.Map<unknown>();
  ydoc.transact(() => {
    m.set("_id", spec.id ?? null);
    m.set("_temp_id", spec.tempId);
    m.set("created_by", spec.createdBy);
    m.set("object_id", spec.tempId);
    m.set("title", new Y.Text(spec.tempId));
    if (spec.courseProjectId !== undefined) m.set("course_project_id", spec.courseProjectId);
    objects.push([m]);
  }, null);
  return m;
}

// ---------------------------------------------------------------------------
// 1. The own-content rule — the exemption it carried
// ---------------------------------------------------------------------------

describe("a delete-and-hollow-reinsert of another member's entity is refused", () => {
  it("is classified as an unauthorised delete even when the replacement copies _temp_id and created_by", () => {
    // The attack the exemption could not see: both fields it decided on are
    // client-writable, so a hollow replacement carrying a victim's `_temp_id`
    // and `created_by` was indistinguishable from a drag.
    const ydoc = new Y.Doc();
    seedStory(ydoc, { createdBy: 99, tempId: "s1", title: "Original", id: 10 });
    seedStory(ydoc, { createdBy: 99, tempId: "s2", title: "Second", id: 11 });

    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 5, role: "collaborator" }, snap);
    });

    asUser(ydoc, fakeSocket(5, "collaborator"), () => {
      const stories = ydoc.getArray<Y.Map<unknown>>("stories");
      const victim = stories.get(0);
      const hollow = new Y.Map<unknown>();
      hollow.set("_id", victim.get("_id"));
      hollow.set("_temp_id", victim.get("_temp_id"));
      hollow.set("created_by", victim.get("created_by"));
      hollow.set("story_id", victim.get("story_id"));
      // The content is gone. Everything the exemption looked at is intact.
      hollow.set("title", new Y.Text(""));
      hollow.set("steps", new Y.Array<Y.Map<unknown>>());
      stories.delete(0, 1);
      stories.insert(0, [hollow]);
    });

    expect(captured).toHaveLength(1);
    // The revert needs somewhere to put the original back.
    expect(captured[0].parentArray).toBe(ydoc.getArray("stories"));
    expect(captured[0].originalIndex).toBeGreaterThanOrEqual(0);
  });

  it("reverts it end to end — the victim's map is put back and the actor is warned", () => {
    const ydoc = new Y.Doc();
    const sockets: FakeWS[] = [];
    const warns: string[] = [];
    const isReverting = { value: false };
    const recordViolation = makeViolationCounter();
    vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });

    seedStory(ydoc, { createdBy: 99, tempId: "s1", title: "Original", id: 10 });
    const collab = fakeSocket(5, "collaborator");
    sockets.push(collab);

    ydoc.on(
      "afterTransaction",
      makeCanDeleteHandler({
        ydoc,
        isSnapshotting: () => false,
        isReverting: () => isReverting.value,
        setReverting: (v: boolean) => { isReverting.value = v; },
        getSockets: () => sockets as unknown as Iterable<WebSocket>,
        broadcastUpdate: () => { /* not asserted here */ },
        recordViolation,
        warn: (msg: string) => { warns.push(msg); },
      }),
    );

    asUser(ydoc, collab, () => {
      const stories = ydoc.getArray<Y.Map<unknown>>("stories");
      const hollow = new Y.Map<unknown>();
      hollow.set("_id", 10);
      hollow.set("_temp_id", "s1");
      hollow.set("created_by", 99);
      hollow.set("story_id", "s1");
      hollow.set("title", new Y.Text(""));
      hollow.set("steps", new Y.Array<Y.Map<unknown>>());
      stories.delete(0, 1);
      stories.insert(0, [hollow]);
    });

    // The original is restored rather than left deleted — which is what keeps
    // the next snapshot from orphan-DELETEing the D1 row the attacker aimed at
    // — and the hollow replacement is swept, so exactly one map claims story
    // 10. Leaving both would hand the substitution to the DO's pre-snapshot
    // dedupe, which collapses an exact-`_id` pair onto whichever sits first.
    const stories = ydoc.getArray<Y.Map<unknown>>("stories");
    expect(stories.length).toBe(1);
    expect(stories.get(0).get("_temp_id")).toBe("s1");
    expect(stories.get(0).get("created_by")).toBe(99);
    expect(String(stories.get(0).get("title"))).toBe("Original");
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/reverted 1 unauthorised/);
  });

  it("refuses it inside a nested list too — a step swapped out of a colleague's story", () => {
    const ydoc = new Y.Doc();
    const story = seedStory(ydoc, { createdBy: 99, tempId: "s1", id: 10 });
    const steps = story.get("steps") as Y.Array<Y.Map<unknown>>;
    ydoc.transact(() => {
      const step = new Y.Map<unknown>();
      step.set("_id", 55);
      step.set("_temp_id", "st1");
      step.set("created_by", 99);
      step.set("question", new Y.Text("Whose question is this?"));
      steps.push([step]);
    }, null);

    let captured: ReturnType<typeof extractUnauthorisedDeletes> = [];
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", (tr) => {
      captured = extractUnauthorisedDeletes(ydoc, tr, { userId: 5, role: "collaborator" }, snap);
    });

    asUser(ydoc, fakeSocket(5, "collaborator"), () => {
      const hollow = new Y.Map<unknown>();
      hollow.set("_id", 55);
      hollow.set("_temp_id", "st1");
      hollow.set("created_by", 99);
      hollow.set("question", new Y.Text(""));
      steps.delete(0, 1);
      steps.insert(0, [hollow]);
    });

    expect(captured).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The course-item rule — the same shape, for markers
// ---------------------------------------------------------------------------

describe("a delete-and-reinsert of a course item is refused", () => {
  it("is classified even when the replacement is a faithful copy", () => {
    // Objects have no reorder operation at all, so the exemption never
    // protected a real client path here; it only ever created one for an
    // attacker.
    const ydoc = new Y.Doc();
    seedObject(ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7, id: 10 });
    seedObject(ydoc, { createdBy: 1, tempId: "o2", courseProjectId: 7, id: 11 });

    let captured: ReturnType<typeof extractCourseItemDeletes> = [];
    let snap: Y.Snapshot | null = null;
    ydoc.on("beforeTransaction", () => { snap = Y.snapshot(ydoc); });
    ydoc.on("afterTransaction", (tr) => {
      captured = extractCourseItemDeletes(ydoc, tr, snap);
    });

    asUser(ydoc, fakeSocket(1, "convenor"), () => {
      const arr = ydoc.getArray<Y.Map<unknown>>("objects");
      const clone = new Y.Map<unknown>();
      clone.set("_id", 10);
      clone.set("_temp_id", "o1");
      clone.set("created_by", 1);
      clone.set("object_id", "o1");
      clone.set("course_project_id", 7);
      clone.set("title", new Y.Text("o1"));
      arr.delete(0, 1);
      arr.insert(1, [clone]);
    });

    expect(captured).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The identity-mutation counterpart
// ---------------------------------------------------------------------------

describe("a marker appearing on a freshly inserted map is a forge, not a carry", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => { /* silence */ });
  });

  it("is classified as a protected-field mutation even alongside a same-identity delete", () => {
    // `carriedOriginals` existed so a marker that moved with a reordered item
    // was not read as a forge. With no reorder deleting anything, a marker
    // that appears on a map born inside the transaction is a forge, full stop.
    const ydoc = new Y.Doc();
    seedObject(ydoc, { createdBy: 1, tempId: "o1", courseProjectId: 7, id: 10 });
    const snap = Y.snapshot(ydoc);

    let captured: ReturnType<typeof extractProtectedFieldMutations> = [];
    ydoc.on("afterTransaction", (tr) => {
      captured = extractProtectedFieldMutations(ydoc, tr, snap);
    });

    asUser(ydoc, fakeSocket(1, "convenor"), () => {
      const arr = ydoc.getArray<Y.Map<unknown>>("objects");
      const clone = new Y.Map<unknown>();
      clone.set("_id", 10);
      clone.set("_temp_id", "o1");
      clone.set("created_by", 1);
      clone.set("object_id", "o1");
      clone.set("course_project_id", 7);
      clone.set("title", new Y.Text("o1"));
      arr.delete(0, 1);
      arr.insert(0, [clone]);
    });

    expect(captured.map((m) => m.key)).toContain("course_project_id");
  });
});
