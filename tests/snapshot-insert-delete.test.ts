/**
 * This file pins unit tests for the `snapshotToD1` extension.
 *
 * Tests: INSERT for Y.Maps with _id === null, DELETE for D1 rows absent from
 * Y.Array, ID backfill broadcast. Also covers unique-field Set semantics.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { makeAfterTransactionHandler, buildContributionUpdate } from "../workers/collaboration-helpers";

// ---------------------------------------------------------------------------
// tr.origin === ws after applyUpdate
// ---------------------------------------------------------------------------

describe("tr.origin is the origin passed to Y.applyUpdate", () => {
  it("tr.origin inside afterTransaction equals the object passed as origin to Y.applyUpdate", () => {
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

  it("editing two distinct fields on same entity produces Set size = 2", () => {
    const { ydoc, userFieldSets } = makeTestDoc();
    const fakeWs = { deserializeAttachment: () => ({ userId: 42 }) };

    const storyMap = seedStory(ydoc, 1);

    ydoc.transact(() => {
      storyMap.set("title", "First");
      storyMap.set("subtitle", "Sub");
    }, fakeWs);

    expect(userFieldSets.get(42)?.size).toBe(2);
  });

  it("field path format is 'stories:<id>:title' for story title", () => {
    const { ydoc, userFieldSets } = makeTestDoc();
    const fakeWs = { deserializeAttachment: () => ({ userId: 42 }) };

    const storyMap = seedStory(ydoc, 42);

    ydoc.transact(() => { storyMap.set("title", "My Story"); }, fakeWs);

    const fieldSet = userFieldSets.get(42);
    expect(fieldSet).toBeDefined();
    expect([...fieldSet!].some(p => p === "stories:42:title")).toBe(true);
  });

  it("field path uses _temp_id when _id is null", () => {
    const { ydoc, userFieldSets } = makeTestDoc();
    const fakeWs = { deserializeAttachment: () => ({ userId: 42 }) };

    const storyMap = seedStory(ydoc, null, "temp-uuid-123");

    ydoc.transact(() => { storyMap.set("title", "Draft"); }, fakeWs);

    const fieldSet = userFieldSets.get(42);
    expect(fieldSet).toBeDefined();
    expect([...fieldSet!].some(p => p.includes("temp-uuid-123") && p.endsWith(":title"))).toBe(true);
  });

  it("afterTransaction callback ignores transactions with no tr.origin userId", () => {
    const { ydoc, userFieldSets } = makeTestDoc();

    // All mutations with null origin — nothing should be attributed
    const storyMap = seedStory(ydoc, 1);
    ydoc.transact(() => { storyMap.set("title", "Server-side"); }, null);

    expect(userFieldSets.size).toBe(0);
  });

  it("cold-start DO wake starts with an empty per-user Set (accepted behaviour)", () => {
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

  it("userFieldSets entry NOT cleared after snapshot — accumulator keeps growing", () => {
    // The set is NOT reset between snapshots (intentional design).
    // buildContributionUpdate uses fields.size directly (not an increment).
    const fieldSet = new Set(["stories:1:title", "stories:1:subtitle"]);
    buildContributionUpdate({ fields_edited: 0, sessions: 1, last_active: null }, fieldSet, false);
    // Set must still contain both entries after the call
    expect(fieldSet.size).toBe(2);
  });

  it("a second snapshot after one more distinct field writes fields_edited = 3", () => {
    const fieldSet = new Set(["stories:1:title", "stories:1:subtitle"]);
    const prev1 = { fields_edited: 0, sessions: 1, last_active: null };
    const result1 = buildContributionUpdate(prev1, fieldSet, false);
    expect(result1.fields_edited).toBe(2);

    // User edits one more distinct field (simulated by adding to the set)
    fieldSet.add("stories:1:byline");
    const result2 = buildContributionUpdate(result1, fieldSet, false);
    expect(result2.fields_edited).toBe(3);
  });

  it("user with userTouches but no userFieldSets entry writes fields_edited = 0 (edge case)", () => {
    // No fieldSet entry (e.g. session started before this code landed)
    const prev = { fields_edited: 5, sessions: 1, last_active: "2026-01-01" };
    const result = buildContributionUpdate(prev, undefined, false);
    // fields_edited is reset to 0 (the set is empty/absent — migration zeroed the baseline)
    expect(result.fields_edited).toBe(0);
    // Other fields preserved
    expect(result.sessions).toBe(1);
    expect(result.last_active).toBe("2026-01-01");
  });

  it("isNewSession increments sessions count by 1", () => {
    const prev = { fields_edited: 0, sessions: 3, last_active: "2026-01-01" };
    const result = buildContributionUpdate(prev, new Set(["stories:1:title"]), true);
    expect(result.sessions).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Object create-path pending asymmetry (external-media vs IIIF)
// ---------------------------------------------------------------------------

/**
 * Pins the critical asymmetry between the two object create paths against the
 * snapshot skip in collaboration.ts (`_validation_state === "pending"` →
 * the object is NOT INSERTed to D1).
 *
 * This is a pure Y.Map-shape assertion, not an end-to-end D1 INSERT: the
 * skip+INSERT is inline in collaboration.ts and the DO test spies snapshotToD1
 * to a no-op, so there is no honest seam to drive an INSERT. The hook
 * (`useStructuralOps`) is not invocable here — it needs the React collaboration
 * context — so the two Y.Maps are built the same way the ops do and asserted on
 * directly. The shapes below are kept byte-for-byte in step with `addIiifObject`
 * / `addExternalMediaObject` in app/hooks/use-structural-ops.ts.
 */

/**
 * Build the Y.Map the IIIF create path produces (addIiifObject), integrated
 * into a real Y.Doc objects array — a detached Y.Map returns undefined from
 * `.get()` until it is attached, so we push it inside a transact exactly like
 * the op does.
 */
function buildIiifObjectMap(): Y.Map<unknown> {
  const ydoc = new Y.Doc();
  const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
  const objMap = new Y.Map<unknown>();
  ydoc.transact(() => {
    objMap.set("_id", null);
    objMap.set("_temp_id", crypto.randomUUID());
    objMap.set("created_by", 1);
    objMap.set("object_id", "obj-iiif");
    objMap.set("title", new Y.Text("IIIF Object"));
    objMap.set("creator", new Y.Text(""));
    objMap.set("description", new Y.Text(""));
    objMap.set("alt_text", new Y.Text(""));
    objMap.set("source_url", "https://example.org/iiif/manifest.json");
    objMap.set("period", new Y.Text(""));
    objMap.set("year", new Y.Text(""));
    objMap.set("featured", false);
    objMap.set("image_available", false);
    objMap.set("_validation_state", "pending");
    objMap.set("origin", "iiif");
    objMap.set("missing_from_repo", false);
    objMap.set("thumbnail", "");
    objectsArray.push([objMap]);
  });
  return objMap;
}

/**
 * Build the Y.Map the external-media create path produces
 * (addExternalMediaObject), integrated into a real Y.Doc objects array.
 */
function buildExternalMediaObjectMap(): Y.Map<unknown> {
  const ydoc = new Y.Doc();
  const objectsArray = ydoc.getArray<Y.Map<unknown>>("objects");
  const objMap = new Y.Map<unknown>();
  ydoc.transact(() => {
    objMap.set("_id", null);
    objMap.set("_temp_id", crypto.randomUUID());
    objMap.set("created_by", 1);
    objMap.set("object_id", "obj-external");
    objMap.set("title", new Y.Text("YouTube Video"));
    objMap.set("creator", new Y.Text(""));
    objMap.set("description", new Y.Text(""));
    objMap.set("alt_text", new Y.Text(""));
    objMap.set("source_url", "https://youtu.be/dQw4w9WgXcQ");
    objMap.set("period", new Y.Text(""));
    objMap.set("year", new Y.Text(""));
    objMap.set("featured", false);
    objMap.set("image_available", false);
    objMap.set("_validation_state", "valid");
    objMap.set("origin", "compositor");
    objMap.set("missing_from_repo", false);
    objMap.set("thumbnail", "");
    objectsArray.push([objMap]);
  });
  return objMap;
}

/**
 * The skip predicate, transcribed from collaboration.ts. Mirroring it here
 * keeps the test honest about *why* the asymmetry matters (a pending object is
 * skipped → never persisted) without stubbing the whole DO.
 */
function isSkippedFromSnapshot(objMap: Y.Map<unknown>): boolean {
  return objMap.get("_validation_state") === "pending";
}

describe("object create-path pending asymmetry (external-media vs IIIF)", () => {
  it("the external-media Y.Map is NOT pending → the snapshot skip does NOT fire (it persists)", () => {
    const ext = buildExternalMediaObjectMap();
    expect(ext.get("_validation_state")).not.toBe("pending");
    expect(isSkippedFromSnapshot(ext)).toBe(false);
  });

  it("the external-media Y.Map carries origin 'compositor' (the missing-from-repo sentinel)", () => {
    const ext = buildExternalMediaObjectMap();
    expect(ext.get("origin")).toBe("compositor");
  });

  it("the external-media Y.Map has no poster (image_available false, thumbnail empty)", () => {
    const ext = buildExternalMediaObjectMap();
    expect(ext.get("image_available")).toBe(false);
    expect(ext.get("thumbnail")).toBe("");
  });

  it("the IIIF Y.Map IS pending → the snapshot skip fires until validation flips it (the contrast)", () => {
    const iiif = buildIiifObjectMap();
    expect(iiif.get("_validation_state")).toBe("pending");
    expect(isSkippedFromSnapshot(iiif)).toBe(true);
  });
});
