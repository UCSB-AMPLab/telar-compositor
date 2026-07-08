/**
 * stories-active-step-remote-delete.test.ts — pins the detection logic behind
 * the Story Editor's "the step you were viewing was just deleted" toast.
 *
 * @version v1.4.1-beta
 *
 * The Story Editor tracks the active step by a positional index
 * (`activeStepIndex`), so `activeStep = sidebarSteps[activeStepIndex - 1]`.
 * When a remote collaborator deletes the step the user is viewing, the same
 * render that shrinks `sidebarSteps` also re-points `activeStep` at whichever
 * surviving step slid into that index. If the "currently active key" is read
 * off that survivor, the deleted step's key is never equal to it and the
 * remote-delete effect can't fire.
 *
 * The route fixes this by capturing the active step's key when the SELECTION
 * changes (index move, or first hydration of the list) rather than re-deriving
 * it on the deletion render, and by keying with the shared tempId-first
 * `keyFor` so the capture is stable across the snapshotToD1 id backfill.
 *
 * These tests reproduce that capture-then-diff logic exactly — the same two
 * effects, run in declaration order (capture first, then detect) on each
 * committed render — and drive it through creation, hydration, backfill,
 * genuine delete, non-active delete, and concurrent-navigation scenarios. The
 * route module itself can't be imported here (server-only deps in its import
 * graph), the same constraint noted in stories-editor-remote-delete-generic.
 */

import { describe, it, expect } from "vitest";
import { keyFor } from "~/lib/item-key";

interface StepRow {
  id: number;
  _tempId?: string | null;
  _yIndex?: number;
}

/**
 * Faithful copy of the two remote-delete effects in `_app.stories.$storyId.tsx`,
 * driven one committed render at a time. Each render supplies the current
 * `activeStepIndex` and `sidebarSteps`; the simulator runs the selection-time
 * capture effect first (matching declaration order in the route) and then the
 * key-set diff, returning whether the active step's deletion was detected.
 */
function makeEditor() {
  let activeStepKey: string | null = null;
  let capturedKeyIndex: number | null = null;
  let prev = new Set<string>();

  function render(activeStepIndex: number, sidebarSteps: StepRow[]) {
    const activeStep =
      activeStepIndex > 0 ? sidebarSteps[activeStepIndex - 1] ?? null : null;

    // Selection-time capture effect (deps [activeStepIndex, activeStep]).
    const indexMoved = capturedKeyIndex !== activeStepIndex;
    const missingKey = activeStepKey === null && activeStep !== null;
    if (indexMoved || missingKey) {
      activeStepKey = activeStep ? String(keyFor(activeStep)) : null;
      capturedKeyIndex = activeStepIndex;
    }

    // Remote-delete detect effect (deps [sidebarSteps]).
    const curr = new Set<string>();
    for (const s of sidebarSteps) curr.add(String(keyFor(s)));
    const deletedKeys: string[] = [];
    prev.forEach((k) => {
      if (!curr.has(k)) deletedKeys.push(k);
    });
    prev = curr;

    const activeDeleted =
      deletedKeys.length > 0 &&
      activeStepKey !== null &&
      deletedKeys.includes(activeStepKey);

    return { activeDeleted, deletedKeys, activeStepKey };
  }

  return { render };
}

const A: StepRow = { id: 1, _tempId: null, _yIndex: 0 };
const B: StepRow = { id: 2, _tempId: null, _yIndex: 1 };
const C: StepRow = { id: 3, _tempId: null, _yIndex: 2 };

describe("story editor active-step remote-delete detection", () => {
  it("detects a genuine remote delete of the step the user is viewing", () => {
    const ed = makeEditor();
    // User is viewing step B (index 2) of [A, B, C].
    ed.render(2, [A, B, C]);
    // A remote peer deletes B. The index stays 2, so activeStep now re-points
    // at C — but the captured key still names B, so the delete is detected.
    const r = ed.render(2, [A, C]);
    expect(r.activeDeleted).toBe(true);
    expect(r.deletedKeys).toEqual([String(keyFor(B))]);
  });

  it("does NOT read the id backfill as a deletion of the active step", () => {
    const ed = makeEditor();
    const created: StepRow = { id: 0, _tempId: "uuid-A", _yIndex: 0 };
    // A freshly-created step is active (id 0, _tempId set).
    ed.render(1, [created]);
    // ~30s later snapshotToD1 backfills the real D1 id. tempId-first keying
    // keeps the key stable, so no deletion is seen.
    const backfilled: StepRow = { id: 42, _tempId: "uuid-A", _yIndex: 0 };
    const r = ed.render(1, [backfilled]);
    expect(r.activeDeleted).toBe(false);
    expect(r.deletedKeys).toEqual([]);
    expect(r.activeStepKey).toBe("uuid-A");
  });

  it("does not trigger the active-step path when a non-active step is deleted", () => {
    const ed = makeEditor();
    // User is viewing B (index 2); a remote peer deletes A instead.
    ed.render(2, [A, B, C]);
    const r = ed.render(2, [B, C]);
    expect(r.activeDeleted).toBe(false);
    expect(r.deletedKeys).toEqual([String(keyFor(A))]);
  });

  it("stays silent on the title card even as steps are deleted", () => {
    const ed = makeEditor();
    // Title card active (index 0) — nothing to detect.
    ed.render(0, [A, B, C]);
    const r = ed.render(0, [A, C]);
    expect(r.activeDeleted).toBe(false);
    expect(r.activeStepKey).toBeNull();
  });

  it("captures the active key once the list hydrates after a deep link", () => {
    const ed = makeEditor();
    // Deep link sets index 2 before the Y.Array has populated.
    ed.render(2, []);
    // The list hydrates at the same index — the key is captured now.
    ed.render(2, [A, B, C]);
    // A later delete of that step is then detected.
    const r = ed.render(2, [A, C]);
    expect(r.activeDeleted).toBe(true);
    expect(r.deletedKeys).toEqual([String(keyFor(B))]);
  });

  it("does not mis-fire when the user navigates away as their step is deleted", () => {
    const ed = makeEditor();
    // User is viewing B (index 2).
    ed.render(2, [A, B, C]);
    // In one commit the user moves to index 1 (A) AND B is deleted. The capture
    // effect runs first and re-captures for the new selection (A), so B's
    // deletion does not reset the editor.
    const r = ed.render(1, [A, C]);
    expect(r.activeDeleted).toBe(false);
    expect(r.activeStepKey).toBe(String(keyFor(A)));
  });
});
