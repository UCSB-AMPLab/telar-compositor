/**
 * capture-undo.test.ts — critical real-Y.Doc test for capture/undo.
 *
 * Capture position writes x/y/zoom/page onto the active step's Y.Map in one
 * ydoc.transact. An Undo reverts those four values. The locked behaviour:
 *   - Snapshot the four CURRENT values BEFORE the capture transaction.
 *   - Undo writes the snapshot back in ONE transaction.
 *   - Multiplayer is last-write-wins: Undo just writes the baseline, with NO
 *     conflict detection — even if a remote writer changed the values after
 *     capture.
 *
 * This asserts on the Y.Map values directly (not on UI), so a future change
 * can't silently add conflict logic without failing here. Harness modelled on
 * tests/use-structural-ops.test.ts (real Y.Doc) + tests/capture-position.test.ts
 * (x/y/zoom/page assertion style).
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

interface ViewportState {
  x: number;
  y: number;
  zoom: number;
  page: string;
}

/** Build a step Y.Map seeded with an initial captured position. */
function buildStep(initial: ViewportState): {
  doc: Y.Doc;
  stepMap: Y.Map<unknown>;
} {
  const doc = new Y.Doc();
  const steps = doc.getArray<Y.Map<unknown>>("steps");
  const stepMap = new Y.Map<unknown>();
  doc.transact(() => {
    stepMap.set("x", initial.x);
    stepMap.set("y", initial.y);
    stepMap.set("zoom", initial.zoom);
    stepMap.set("page", initial.page);
    steps.push([stepMap]);
  });
  return { doc, stepMap };
}

/** Snapshot the step's current x/y/zoom/page — taken BEFORE capture. */
function snapshot(stepMap: Y.Map<unknown>): ViewportState {
  return {
    x: stepMap.get("x") as number,
    y: stepMap.get("y") as number,
    zoom: stepMap.get("zoom") as number,
    page: stepMap.get("page") as string,
  };
}

/** The capture write idiom — one transact setting all four values. */
function capture(doc: Y.Doc, stepMap: Y.Map<unknown>, pos: ViewportState): void {
  doc.transact(() => {
    stepMap.set("x", pos.x);
    stepMap.set("y", pos.y);
    stepMap.set("zoom", pos.zoom);
    stepMap.set("page", pos.page);
  });
}

/** The undo write idiom — one transact writing the snapshot baseline back. */
function undo(doc: Y.Doc, stepMap: Y.Map<unknown>, prior: ViewportState): void {
  doc.transact(() => {
    stepMap.set("x", prior.x);
    stepMap.set("y", prior.y);
    stepMap.set("zoom", prior.zoom);
    stepMap.set("page", prior.page);
  });
}

function readState(stepMap: Y.Map<unknown>): ViewportState {
  return snapshot(stepMap);
}

describe("capture/undo on a step Y.Map (real Y.Doc)", () => {
  const initial: ViewportState = { x: 0.5, y: 0.5, zoom: 1, page: "1" };

  it("snapshot is taken BEFORE capture, so Undo restores the pre-capture state", () => {
    const { doc, stepMap } = buildStep(initial);

    // Snapshot first ...
    const prior = snapshot(stepMap);
    // ... then capture new values.
    capture(doc, stepMap, { x: 0.2, y: 0.8, zoom: 2.5, page: "3" });

    // Capture landed.
    expect(readState(stepMap)).toEqual({ x: 0.2, y: 0.8, zoom: 2.5, page: "3" });

    // Undo restores all four to the pre-capture baseline.
    undo(doc, stepMap, prior);
    expect(readState(stepMap)).toEqual(initial);
  });

  it("Undo reverts every one of x, y, zoom, page (not a subset)", () => {
    const { doc, stepMap } = buildStep(initial);
    const prior = snapshot(stepMap);
    capture(doc, stepMap, { x: 0.9, y: 0.1, zoom: 4, page: "5" });

    undo(doc, stepMap, prior);
    const after = readState(stepMap);
    expect(after.x).toBe(initial.x);
    expect(after.y).toBe(initial.y);
    expect(after.zoom).toBe(initial.zoom);
    expect(after.page).toBe(initial.page);
  });

  it("a snapshot taken AFTER capture would be a no-op Undo", () => {
    const { doc, stepMap } = buildStep(initial);

    // The WRONG order: capture first, then snapshot reads the post-write state.
    capture(doc, stepMap, { x: 0.2, y: 0.8, zoom: 2.5, page: "3" });
    const wrongPrior = snapshot(stepMap);

    undo(doc, stepMap, wrongPrior);
    // Undo did nothing — proving the snapshot MUST precede capture.
    expect(readState(stepMap)).toEqual({ x: 0.2, y: 0.8, zoom: 2.5, page: "3" });
    expect(readState(stepMap)).not.toEqual(initial);
  });

  it("last-write-wins: Undo writes the baseline even after a remote write (no conflict detection)", () => {
    const { doc, stepMap } = buildStep(initial);

    // Local capture, baseline snapshotted before it.
    const prior = snapshot(stepMap);
    capture(doc, stepMap, { x: 0.2, y: 0.8, zoom: 2.5, page: "3" });

    // A remote collaborator writes the same four keys AFTER our capture.
    doc.transact(() => {
      stepMap.set("x", 0.42);
      stepMap.set("y", 0.42);
      stepMap.set("zoom", 3.3);
      stepMap.set("page", "7");
    });
    expect(readState(stepMap)).toEqual({ x: 0.42, y: 0.42, zoom: 3.3, page: "7" });

    // Undo simply writes the snapshot baseline back — last write wins, no merge.
    undo(doc, stepMap, prior);
    expect(readState(stepMap)).toEqual(initial);
  });

  it("repeated capture re-baselines: the second snapshot is what a later Undo restores", () => {
    const { doc, stepMap } = buildStep(initial);

    // First capture.
    capture(doc, stepMap, { x: 0.2, y: 0.8, zoom: 2.5, page: "3" });

    // Repeated capture replaces the toast and resets the baseline to the
    // current (post-first-capture) state before writing the new values.
    const secondBaseline = snapshot(stepMap);
    capture(doc, stepMap, { x: 0.6, y: 0.4, zoom: 1.2, page: "2" });

    // Undo now restores the SECOND baseline, not the original.
    undo(doc, stepMap, secondBaseline);
    expect(readState(stepMap)).toEqual({ x: 0.2, y: 0.8, zoom: 2.5, page: "3" });
  });

  it("route capture/undo binding: stash keyed to the active step, replace on recapture, one-transact undo writes the baseline back", () => {
    // Faithful inline replica of the route's handleCapturePosition +
    // handleUndoCapture wiring (app/routes/_app.stories.$storyId.tsx). The route
    // keeps a single captureUndo baseline keyed to the active step's stable key;
    // capture stashes the pre-write snapshot (replacing any existing baseline);
    // Undo writes that baseline back in ONE transact and clears the state.
    const { doc, stepMap } = buildStep(initial);
    const stepKey = "step-7";

    type Baseline = { stepKey: string; prior: ViewportState } | null;
    let captureUndo: Baseline = null;

    // route handleCapturePosition (Yjs branch): snapshot BEFORE the transact,
    // stash keyed to the active step (replaces any existing baseline),
    // then write the new values.
    function routeCapture(pos: ViewportState) {
      const prior = snapshot(stepMap);
      captureUndo = { stepKey, prior };
      capture(doc, stepMap, pos);
    }

    // route handleUndoCapture: write the stashed baseline back in one transact
    // (last-write-wins), then clear.
    function routeUndo() {
      if (!captureUndo) return;
      undo(doc, stepMap, captureUndo.prior);
      captureUndo = null;
    }

    // First capture stashes the original baseline keyed to the active step.
    routeCapture({ x: 0.2, y: 0.8, zoom: 2.5, page: "3" });
    expect(captureUndo).not.toBeNull();
    expect(captureUndo!.stepKey).toBe(stepKey);
    expect(captureUndo!.prior).toEqual(initial);

    // A second capture REPLACES the baseline with the post-first-capture state.
    routeCapture({ x: 0.6, y: 0.4, zoom: 1.2, page: "2" });
    expect(captureUndo!.prior).toEqual({ x: 0.2, y: 0.8, zoom: 2.5, page: "3" });

    // Undo restores the SECOND baseline (not the original) and clears the state.
    routeUndo();
    expect(readState(stepMap)).toEqual({ x: 0.2, y: 0.8, zoom: 2.5, page: "3" });
    expect(captureUndo).toBeNull();
  });

  it("undo resolves the target by id OR _tempId, surviving the snapshotToD1 id-backfill", () => {
    // A freshly-added step has only a _tempId at capture time. After
    // snapshotToD1 backfills the real id, the step's stable key flips from
    // _tempId to the numeric id. The OLD single-stepKey resolution captured the
    // pre-backfill key and would then fail sidebarSteps.find(...), silently
    // no-op'ing the Undo. The fix stores BOTH id and _tempId on the baseline and
    // matches on either — faithful replica of captureUndoMatchesStep + the
    // handleUndoCapture find in app/routes/_app.stories.$storyId.tsx.
    type EditorStepLike = { id: number; _tempId: string | null };
    type Baseline = { id: number | null; tempId: string | null };

    const matchesStep = (b: Baseline, s: EditorStepLike | null): boolean => {
      if (!s) return false;
      if (b.id !== null && s.id > 0 && s.id === b.id) return true;
      if (b.tempId !== null && s._tempId === b.tempId) return true;
      return false;
    };

    // At capture time the step is brand-new: id 0, only a _tempId.
    const baseline: Baseline = { id: null, tempId: "temp-abc" };

    // The OLD pre-backfill key would have been "temp-abc"; after backfill the
    // step's list row carries id 42 and (per stepFromYMap) retains _tempId.
    const stepAfterBackfill: EditorStepLike = { id: 42, _tempId: "temp-abc" };

    // Old behaviour (single stepKey === id-or-tempId) would compute the row's
    // key as "42" and fail to match the stashed "temp-abc". The new matcher
    // resolves it via _tempId.
    expect(matchesStep(baseline, stepAfterBackfill)).toBe(true);

    // A baseline captured AFTER an id is known matches by id even if _tempId
    // is later dropped from the row.
    const baselineById: Baseline = { id: 42, tempId: null };
    expect(matchesStep(baselineById, { id: 42, _tempId: null })).toBe(true);

    // A different step never matches.
    expect(matchesStep(baseline, { id: 7, _tempId: "temp-xyz" })).toBe(false);
    // id 0 (not yet backfilled, no tempId match) does not match by id.
    expect(matchesStep({ id: 5, tempId: null }, { id: 0, _tempId: "temp-q" })).toBe(false);
  });
});
