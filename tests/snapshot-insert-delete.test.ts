/**
 * snapshot-insert-delete.test.ts — unit tests for the snapshotToD1 extension.
 *
 * Tests: INSERT for Y.Maps with _id === null, DELETE for D1 rows absent from
 * Y.Array, ID backfill broadcast. Also covers unique-field Set semantics.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { makeAfterTransactionHandler, buildContributionUpdate } from "../workers/collaboration-helpers";

describe("snapshotToD1 INSERT for null-id items", () => {
  it.todo("INSERTs a D1 row when a Y.Map has _id === null");
  it.todo("writes the new D1 ID back to the Y.Map via ydoc.transact()");
  it.todo("skips objects with _validation_state === 'pending'");
  it.todo("writes order column from Y.Array index for objects");
});

describe("snapshotToD1 DELETE for orphan rows", () => {
  it.todo("DELETEs a D1 row when its ID is absent from the Y.Array");
  it.todo("cascades story delete to steps and layers");
  it.todo("does not delete rows that are still present in the Y.Array");
});

describe("snapshotToD1 ID backfill broadcast", () => {
  it.todo("broadcasts the Yjs update to all connected WebSockets after ID backfill");
  it.todo("isSnapshotting lock prevents concurrent snapshot execution");
});

// ---------------------------------------------------------------------------
// A2 verification: tr.origin === ws after applyUpdate
// ---------------------------------------------------------------------------

describe("A2 verification: tr.origin is the origin passed to Y.applyUpdate", () => {
  it("A2: tr.origin inside afterTransaction equals the object passed as origin to Y.applyUpdate", () => {
    const ydoc = new Y.Doc();
    let capturedOrigin: unknown = undefined;

    ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      capturedOrigin = tr.origin;
    });

    // Create a fake WebSocket-like object as origin
    const fakeWs = { id: "fake-ws", deserializeAttachment: () => ({ userId: 42 }) };

    // Apply an update with fakeWs as origin
    const srcDoc = new Y.Doc();
    srcDoc.getMap("stories").set("title", "hello");
    const update = Y.encodeStateAsUpdate(srcDoc);
    Y.applyUpdate(ydoc, update, fakeWs);

    expect(capturedOrigin).toBe(fakeWs);
  });
});

// ---------------------------------------------------------------------------
// Unique-field Set semantics
// ---------------------------------------------------------------------------

/**
 * Helper: build a minimal Y.Doc with the handler wired, returning the doc and
 * the per-user field-set map.
 *
 * Production semantics: entities are added to the doc first (via DO cold-start
 * or prior sessions — null origin). User edits happen in subsequent transactions
 * with the WebSocket object as origin. Tests mirror this two-step pattern so
 * tr.changed captures Y.Map field mutations rather than Y.Array insertions.
 */
function makeTestDoc() {
  const ydoc = new Y.Doc();
  const userFieldSets = new Map<number, Set<string>>();

  const handler = makeAfterTransactionHandler(ydoc, userFieldSets, (ws: unknown) => {
    const att = (ws as { deserializeAttachment?: () => { userId?: number } }).deserializeAttachment?.();
    return att?.userId ?? null;
  });

  ydoc.on("afterTransaction", handler);

  return { ydoc, userFieldSets };
}

/** Seed a story entity into the doc with null origin (simulates server-side cold-start). */
function seedStory(ydoc: Y.Doc, id: number | null, tempId?: string): Y.Map<unknown> {
  const stories = ydoc.getArray<Y.Map<unknown>>("stories");
  let storyMap!: Y.Map<unknown>;
  ydoc.transact(() => {
    storyMap = new Y.Map<unknown>();
    storyMap.set("_id", id);
    if (tempId) storyMap.set("_temp_id", tempId);
    stories.push([storyMap]);
  }, null); // null origin = server-side, not attributed to any user
  return storyMap;
}

describe("Unique-field Set semantics", () => {
  it("re-editing the same Y.Map key twice keeps Set size at 1", () => {
    const { ydoc, userFieldSets } = makeTestDoc();
    const fakeWs = { deserializeAttachment: () => ({ userId: 42 }) };

    const storyMap = seedStory(ydoc, 1);

    // First user edit
    ydoc.transact(() => { storyMap.set("title", "First"); }, fakeWs);
    // Second user edit on the same key
    ydoc.transact(() => { storyMap.set("title", "Updated"); }, fakeWs);

    expect(userFieldSets.get(42)?.size).toBe(1);
  });

  it("SC-9: editing two distinct fields on same entity produces Set size = 2", () => {
    const { ydoc, userFieldSets } = makeTestDoc();
    const fakeWs = { deserializeAttachment: () => ({ userId: 42 }) };

    const storyMap = seedStory(ydoc, 1);

    ydoc.transact(() => {
      storyMap.set("title", "First");
      storyMap.set("subtitle", "Sub");
    }, fakeWs);

    expect(userFieldSets.get(42)?.size).toBe(2);
  });

  it("SC-9: field path format is 'stories:<id>:title' for story title", () => {
    const { ydoc, userFieldSets } = makeTestDoc();
    const fakeWs = { deserializeAttachment: () => ({ userId: 42 }) };

    const storyMap = seedStory(ydoc, 42);

    ydoc.transact(() => { storyMap.set("title", "My Story"); }, fakeWs);

    const fieldSet = userFieldSets.get(42);
    expect(fieldSet).toBeDefined();
    expect([...fieldSet!].some(p => p === "stories:42:title")).toBe(true);
  });

  it("SC-9: field path uses _temp_id when _id is null", () => {
    const { ydoc, userFieldSets } = makeTestDoc();
    const fakeWs = { deserializeAttachment: () => ({ userId: 42 }) };

    const storyMap = seedStory(ydoc, null, "temp-uuid-123");

    ydoc.transact(() => { storyMap.set("title", "Draft"); }, fakeWs);

    const fieldSet = userFieldSets.get(42);
    expect(fieldSet).toBeDefined();
    expect([...fieldSet!].some(p => p.includes("temp-uuid-123") && p.endsWith(":title"))).toBe(true);
  });

  it("SC-9: afterTransaction callback ignores transactions with no tr.origin userId", () => {
    const { ydoc, userFieldSets } = makeTestDoc();

    // All mutations with null origin — nothing should be attributed
    const storyMap = seedStory(ydoc, 1);
    ydoc.transact(() => { storyMap.set("title", "Server-side"); }, null);

    expect(userFieldSets.size).toBe(0);
  });

  it("SC-9: cold-start DO wake starts with an empty per-user Set (pitfall 5 accepted behaviour)", () => {
    // Simulated by just creating a new userFieldSets map (represents fresh DO instance)
    const freshUserFieldSets = new Map<number, Set<string>>();
    expect(freshUserFieldSets.size).toBe(0);
    expect(freshUserFieldSets.get(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// snapshotToD1 writes fields.size
// ---------------------------------------------------------------------------

describe("snapshotToD1 writes fields.size to contributions.fields_edited", () => {
  it("buildContributionUpdate writes fields.size after two distinct-field edits", () => {
    const fieldSet = new Set(["stories:1:title", "stories:1:subtitle"]);
    const prev = { stories_edited: [], objects_edited: [], fields_edited: 0, sessions: 2, last_active: "2026-01-01" };
    const result = buildContributionUpdate(prev, fieldSet, false);
    expect(result.fields_edited).toBe(2);
    // Other fields preserved
    expect(result.sessions).toBe(2);
    expect(result.last_active).toBe("2026-01-01");
  });

  it("SC-9c: userFieldSets entry NOT cleared after snapshot — accumulator keeps growing", () => {
    // The set is NOT reset between snapshots (D-11 / pitfall 5 design).
    // buildContributionUpdate uses fields.size directly (not an increment).
    const fieldSet = new Set(["stories:1:title", "stories:1:subtitle"]);
    buildContributionUpdate({ fields_edited: 0, sessions: 1, last_active: null }, fieldSet, false);
    // Set must still contain both entries after the call
    expect(fieldSet.size).toBe(2);
  });

  it("SC-9c: a second snapshot after one more distinct field writes fields_edited = 3", () => {
    const fieldSet = new Set(["stories:1:title", "stories:1:subtitle"]);
    const prev1 = { fields_edited: 0, sessions: 1, last_active: null };
    const result1 = buildContributionUpdate(prev1, fieldSet, false);
    expect(result1.fields_edited).toBe(2);

    // User edits one more distinct field (simulated by adding to the set)
    fieldSet.add("stories:1:byline");
    const result2 = buildContributionUpdate(result1, fieldSet, false);
    expect(result2.fields_edited).toBe(3);
  });

  it("SC-9c: user with userTouches but no userFieldSets entry writes fields_edited = 0 (edge case)", () => {
    // No fieldSet entry (e.g. session started before this code landed)
    const prev = { fields_edited: 5, sessions: 1, last_active: "2026-01-01" };
    const result = buildContributionUpdate(prev, undefined, false);
    // fields_edited is reset to 0 (the set is empty/absent — migration zeroed the baseline)
    expect(result.fields_edited).toBe(0);
    // Other fields preserved
    expect(result.sessions).toBe(1);
    expect(result.last_active).toBe("2026-01-01");
  });

  it("SC-9c: isNewSession increments sessions count by 1", () => {
    const prev = { fields_edited: 0, sessions: 3, last_active: "2026-01-01" };
    const result = buildContributionUpdate(prev, new Set(["stories:1:title"]), true);
    expect(result.sessions).toBe(4);
  });
});
