/**
 * step-writes — the write path for a step edit that must land on one
 * particular step and no other.
 *
 * The story editor renders steps from snapshots taken at render time, so a
 * peer's mutation can arrive between the moment an author opens a dialog and
 * the moment their choice is written. `resolveTargetStep` therefore answers the
 * question at write time and from the live Y.Array: which Y.Map does this
 * target key name, and is that map still the step the editor is pointing at?
 * A caller that cannot get an answer writes nothing.
 *
 * `choosePageInStep` is the page choice itself — one transaction so peers and
 * the snapshot see the page and the cleared framing together, never a page with
 * the framing of another page.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { orderedMaps } from "./field-order";

/**
 * The identity of a step for a write that outlives the render it was started
 * from: the temp id of a step the Y.Doc created, else its D1 id.
 */
export type TargetKey = string;

/**
 * What a write carries from the moment its values were read to the moment they
 * land: which selection was showing, which step is meant, and which object and
 * source the values describe. A page chosen in a dialog and a viewport read
 * from the viewer are both read in one render and written in another, so both
 * travel with this and are compared against live state before anything is set.
 */
export interface WriteBinding {
  selectionKey: string;
  targetKey: TargetKey;
  objectId: string;
  sourceKey: string;
}

/** The fields a step must expose for the editor's sidebar inclusion rule. */
export interface SidebarStepShape {
  id: number;
  step_number: number;
  _tempId: string | null;
}

export function targetKeyFor(step: {
  id: number;
  _tempId?: string | null;
}): TargetKey | null {
  if (step._tempId) return `tmp:${step._tempId}`;
  if (step.id > 0) return `id:${step.id}`;
  return null;
}

/**
 * What the viewer column is showing, as one key. The temp id comes before the
 * D1 id so the backfill that follows a snapshot is not a selection change and
 * does not reset a browsed page; step 0 is its own key because it is a viewing
 * mode over the first step rather than a step of its own.
 */
export function selectionKeyFor(
  step: { id: number; _tempId?: string | null } | null,
  isStepZero: boolean
): string {
  if (isStepZero) return "step0";
  if (!step) return "none";
  if (step._tempId) return `tmp:${step._tempId}`;
  return `id:${String(step.id)}`;
}

/** The three fields the inclusion rule reads, taken straight off a live Y.Map. */
export function sidebarShapeOf(yMap: Y.Map<unknown>): SidebarStepShape {
  return {
    id: (yMap.get("_id") as number | null) ?? 0,
    step_number: (yMap.get("step_number") as number) ?? 0,
    _tempId: (yMap.get("_temp_id") as string | null) ?? null,
  };
}

/**
 * Which entries of the steps array the sidebar shows, and therefore which ones
 * the editor's one-based step numbering counts. A step qualifies on a positive
 * step number, a positive D1 id, or a temp id; a malformed entry with none of
 * the three is not a step the author can select and does not shift the numbers.
 *
 * A write resolved at write time must count the live array by exactly the rule
 * the render counted it by, which is why this is one function rather than a
 * condition repeated at each site.
 */
export function isSidebarStep(step: SidebarStepShape): boolean {
  return (step.step_number ?? 0) > 0 || step.id > 0 || Boolean(step._tempId);
}

/** The steps the sidebar shows, in display order. */
export function includedSteps(
  stepsArray: Y.Array<Y.Map<unknown>> | null,
  isIncluded: (step: SidebarStepShape) => boolean
): Y.Map<unknown>[] {
  return orderedMaps(stepsArray).filter((s) => isIncluded(sidebarShapeOf(s)));
}

function matchesKey(yMap: Y.Map<unknown>, targetKey: TargetKey): boolean {
  if (targetKey.startsWith("tmp:")) {
    return (yMap.get("_temp_id") as string | null) === targetKey.slice(4);
  }
  if (targetKey.startsWith("id:")) {
    const id = Number(targetKey.slice(3));
    return Number.isFinite(id) && id > 0 && (yMap.get("_id") as number | null) === id;
  }
  return false;
}

/**
 * The step a target key names, or null when it names none, or when the step it
 * names is not the editor's active target.
 *
 * `isStepZero` selects the first included step, because step 0 is a viewing
 * mode over the first step rather than a step of its own; otherwise the
 * included element at `activeStepIndex - 1` is the target, matching the
 * sidebar's one-based numbering.
 *
 * A step's place in the list is its `order_key`, not its Y.Array position, so
 * the live array is read through `orderedMaps`: the index the editor counted
 * from is an index into display order, and a reorder that only rewrites keys
 * must move the target here exactly as it moves it on screen.
 */
export function resolveTargetStep(
  stepsArray: Y.Array<Y.Map<unknown>> | null,
  targetKey: TargetKey | null,
  activeStepIndex: number,
  isStepZero: boolean,
  isIncluded: (step: SidebarStepShape) => boolean
): Y.Map<unknown> | null {
  if (!stepsArray || !(stepsArray instanceof Y.Array) || !targetKey) return null;

  const live = orderedMaps(stepsArray);
  const named = live.find((s) => matchesKey(s, targetKey)) ?? null;
  if (!named) return null;

  const included = live.filter((s) => isIncluded(sidebarShapeOf(s)));
  const current = isStepZero ? included[0] ?? null : included[activeStepIndex - 1] ?? null;
  return current === named ? named : null;
}

/**
 * Write a chosen page to a step, clearing the framing captured on whatever page
 * was showing before. Coordinates captured on another page describe nothing on
 * this one, so they are cleared as explicit nulls and the step publishes with
 * the serializer's defaults until the author captures again.
 */
export function choosePageInStep(
  ydoc: Y.Doc,
  stepYMap: Y.Map<unknown>,
  page: number
): void {
  ydoc.transact(() => {
    stepYMap.set("page", String(page));
    stepYMap.set("x", null);
    stepYMap.set("y", null);
    stepYMap.set("zoom", null);
  });
}
