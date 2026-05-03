// @vitest-environment jsdom
/**
 * use-structural-ops.test.ts — unit tests for the useStructuralOps hook.
 *
 * Tests: canDelete permission logic, UndoManager stack tracking on
 * Y.Array mutation. Stubs created in Wave 0; implemented in Plans 01/04.
 */

import { describe, it } from "vitest";

describe("canDelete permission logic", () => {
  it.todo("returns true when role is convenor regardless of created_by");
  it.todo("returns true when role is collaborator and created_by matches currentUserId");
  it.todo("returns false when role is collaborator and created_by differs from currentUserId");
  it.todo("returns false when role is collaborator and created_by is null (legacy item)");
});

describe("UndoManager tracks Y.Array structural mutations", () => {
  it.todo("adds a stack item when a Y.Map is pushed onto a tracked Y.Array");
  it.todo("undo reverses a Y.Array push (removes the added item)");
  it.todo("redo re-applies a Y.Array push after undo");
  it.todo("adds a stack item when a Y.Map is deleted from a tracked Y.Array");
  it.todo("undo reverses a Y.Array delete (restores the removed item)");
});
