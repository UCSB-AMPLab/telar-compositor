import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createUndoManager } from "~/lib/undo-manager";

describe("createUndoManager — cross-user undo invariant", () => {
  test("a local (null-origin) change is undoable", () => {
    const doc = new Y.Doc();
    const arr = doc.getArray<number>("stories");
    const um = createUndoManager([arr]);

    doc.transact(() => arr.push([1])); // no origin → null → local

    expect(um.undoStack.length).toBe(1);
    um.undo();
    expect(arr.length).toBe(0);

    um.destroy();
    doc.destroy();
  });

  test("a remote (non-null origin) change is not tracked and cannot be undone", () => {
    const doc = new Y.Doc();
    const arr = doc.getArray<number>("stories");
    const um = createUndoManager([arr]);

    // Stand-in for the y-websocket provider origin used on remote applies.
    const REMOTE_ORIGIN = { provider: true };
    doc.transact(() => arr.push([1]), REMOTE_ORIGIN);

    expect(um.undoStack.length).toBe(0);
    expect(um.undo()).toBeFalsy();
    expect(arr.length).toBe(1); // collaborator's change survives

    um.destroy();
    doc.destroy();
  });
});
