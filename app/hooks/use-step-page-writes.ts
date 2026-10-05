/**
 * The story editor's step writes that must land on one particular step: adding
 * a step seeded from the one before it, changing a step's object, choosing the
 * page of a multi-page object, and undoing a capture.
 *
 * They are one hook because they share three things. They share the capture
 * baseline, which a page choice and an object change both invalidate and which
 * only a capture creates. They share the live resolution of a target: each is
 * begun in one render and lands in another — a dialog opened and answered, a
 * viewport read and written — so between the two a peer can have replaced the
 * object, reordered the steps or deleted the step, and every one of them
 * answers "which step is this for, and is it still showing what I read?" from
 * the live Y.Array rather than from that render. And they share display order: a
 * step's place is its `order_key`, so the seed scan, the new step's sidebar
 * index, the cancellation of an unconsumed request and the target resolution
 * all read the ordered maps, never the raw array.
 *
 * The hook holds the handlers themselves, not copies of them: the route calls
 * it and passes what it returns straight to its children, so a test that mounts
 * the hook over a Y.Doc exercises the code the editor runs.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useState } from "react";
import * as Y from "yjs";
import { orderedMaps } from "~/lib/field-order";
import {
  choosePageInStep,
  includedSteps,
  isSidebarStep,
  resolveTargetStep,
  targetKeyFor,
} from "~/lib/step-writes";
import type { WriteBinding } from "~/lib/step-writes";
import type { StepSeed, StructuralOps } from "~/hooks/use-structural-ops";
import type { PageChooserSession } from "~/components/features/editor/PageChooserDialog";

/** What these writes need to know about a step the route has rendered. */
export interface StepWriteRow {
  id: number;
  step_number: number;
  object_id: string | null;
  _tempId: string | null;
  _yMap: Y.Map<unknown> | null;
}

/** A step's four viewport values as they stood before a capture overwrote them. */
export interface CaptureBaseline {
  id: number | null;
  tempId: string | null;
  /**
   * The object the captured viewport describes. A viewport read from one object
   * means nothing on another, so an Undo whose step now shows a different object
   * restores nothing.
   */
  objectId: string | null;
  prior: { x: unknown; y: unknown; zoom: unknown; page: unknown };
  /** Bumped on every capture, so a repeated capture re-shows the pill. */
  nonce: number;
}

export interface CapturedPosition {
  x: number;
  y: number;
  zoom: number;
  page: string;
}

export interface StepPageWritesContext {
  useYjs: boolean;
  ydoc: Y.Doc | null;
  ops: StructuralOps | null;
  storyYMap: Y.Map<unknown> | null;
  stepsArray: Y.Array<Y.Map<unknown>> | null;
  /** The sidebar's steps in display order; the render signal and the D1 target. */
  sidebarSteps: StepWriteRow[];
  activeStep: StepWriteRow | null;
  activeStepIndex: number;
  isStepZero: boolean;
  /** The viewer column's selection key, compared against a chooser session's. */
  selectionKey: string;
  /** The source key an object resolves to right now. */
  sourceKeyForObject: (objectId: string | null) => string;
  /** The route's step-selection sequence: index, panels, URL mirror. */
  onSelectStep: (index: number) => void;
  submitCapture: (fields: Record<string, string>) => void;
  submitChangeObject: (fields: Record<string, string>) => void;
  submitSetPage: (fields: Record<string, string>) => void;
}

export interface StepPageWritesApi {
  /** The Undo pill's nonce, or null when no baseline applies to the active step. */
  captureUndoNonce: number | null;
  clearCaptureUndo: () => void;
  pendingNewStep: { tempId: string } | null;
  handleNewStepConsumed: (tempId: string) => void;
  handleAddStep: () => void;
  handleCapturePosition: (pos: CapturedPosition, binding: WriteBinding) => void;
  handleUndoCapture: () => void;
  handleChangeObject: (objectId: string, targetKey?: string) => void;
  handleChoosePage: (page: number, session: PageChooserSession) => void;
}

/** Does a baseline refer to this step? Either key identifies it. */
function baselineNames(
  baseline: CaptureBaseline,
  step: { id: number; _tempId: string | null } | null
): boolean {
  if (!step) return false;
  if (baseline.id !== null && step.id > 0 && step.id === baseline.id) return true;
  return baseline.tempId !== null && step._tempId === baseline.tempId;
}

/** The live Y.Map a baseline names, matched on either key it may carry. */
function liveMapForBaseline(
  stepsArray: Y.Array<Y.Map<unknown>> | null,
  baseline: CaptureBaseline
): Y.Map<unknown> | null {
  for (const map of orderedMaps(stepsArray)) {
    const id = (map.get("_id") as number | null) ?? 0;
    const tempId = (map.get("_temp_id") as string | null) ?? null;
    if (baseline.id !== null && id > 0 && id === baseline.id) return map;
    if (baseline.tempId !== null && tempId !== null && tempId === baseline.tempId) return map;
  }
  return null;
}

/**
 * The object and view a new step starts from: the last media step in DISPLAY
 * order that has an object. Video and audio objects qualify — a new step
 * inherits the object and whatever page and coordinates the source holds, never
 * its clip values, which belong to a moment the author chose in that step.
 */
export function seedFromLastMediaStep(
  stepsArray: Y.Array<Y.Map<unknown>> | null
): StepSeed | undefined {
  const ordered = orderedMaps(stepsArray);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const map = ordered[i];
    const kind = (map.get("kind") as string | undefined) ?? "media";
    if (kind === "section") continue;
    const objectId = map.get("object_id");
    if (typeof objectId === "string" && objectId.length > 0) {
      return {
        object_id: objectId,
        page: (map.get("page") as string | null) ?? null,
        x: (map.get("x") as number | null) ?? null,
        y: (map.get("y") as number | null) ?? null,
        zoom: (map.get("zoom") as number | null) ?? null,
      };
    }
  }
  return undefined;
}

export function useStepPageWrites(ctx: StepPageWritesContext): StepPageWritesApi {
  const {
    useYjs, ydoc, ops, storyYMap, stepsArray, sidebarSteps, activeStep,
    activeStepIndex, isStepZero, selectionKey, sourceKeyForObject, onSelectStep,
    submitCapture, submitChangeObject, submitSetPage,
  } = ctx;

  const [captureUndo, setCaptureUndo] = useState<CaptureBaseline | null>(null);
  const [pendingNewStep, setPendingNewStep] = useState<{ tempId: string } | null>(null);

  const clearCaptureUndo = useCallback(() => setCaptureUndo(null), []);

  // The pill shows only while its baseline still describes what the author is
  // looking at: the same step, still showing the object the viewport was read
  // from. A peer's replacement therefore retires the pill on the render that
  // brings the replacement in.
  const captureUndoNonce =
    captureUndo !== null &&
    baselineNames(captureUndo, activeStep) &&
    (activeStep?.object_id ?? null) === captureUndo.objectId
      ? captureUndo.nonce
      : null;

  // ---------------------------------------------------------------------------
  // Adding a step seeded from the one before it
  // ---------------------------------------------------------------------------

  const handleAddStep = useCallback(() => {
    if (!useYjs || !storyYMap || !stepsArray || !ops) {
      // Without a Y.Doc there is no structural add at all; say so rather than
      // POST an intent the action does not handle.
      // eslint-disable-next-line no-console
      console.warn("[story-editor] add-step without active ydoc; ignored");
      return;
    }
    const seed = seedFromLastMediaStep(stepsArray);
    const tempId = ops.addStep(storyYMap, seed);
    if (!tempId) return;

    // The live array already carries the new step, so its sidebar index is read
    // from it in display order, under the rule the sidebar renders by.
    const index = includedSteps(stepsArray, isSidebarStep).findIndex(
      (map) => map.get("_temp_id") === tempId
    );
    if (index < 0) return;
    onSelectStep(index + 1);
    setCaptureUndo(null);
    if (seed) setPendingNewStep({ tempId });
  }, [useYjs, storyYMap, stepsArray, ops, onSelectStep]);

  const handleNewStepConsumed = useCallback((tempId: string) => {
    setPendingNewStep((prev) => (prev?.tempId === tempId ? null : prev));
  }, []);

  // An unconsumed request belongs to one step. It is dropped when that step
  // leaves the array or when the live active target is something else — the
  // title card, a section card, another step — whether the author moved or a
  // peer did. It is kept through the interval in which the index has not yet
  // caught up with the addition. `sidebarSteps` is the signal that live state
  // moved; the answer comes from the array itself.
  useEffect(() => {
    if (!pendingNewStep) return;
    const { tempId } = pendingNewStep;
    const included = includedSteps(stepsArray, isSidebarStep);
    if (!included.some((map) => map.get("_temp_id") === tempId)) {
      setPendingNewStep(null);
      return;
    }
    if (isStepZero) {
      setPendingNewStep(null);
      return;
    }
    const target = included[activeStepIndex - 1] ?? null;
    if (target && target.get("_temp_id") !== tempId) setPendingNewStep(null);
  }, [pendingNewStep, sidebarSteps, stepsArray, isStepZero, activeStepIndex]);

  // ---------------------------------------------------------------------------
  // The step a bound write may land on
  // ---------------------------------------------------------------------------

  /**
   * The live Y.Map a binding may be written to: the ordered target its key
   * names, still showing the object and the source the values were read from.
   * Null on any disagreement, which is the whole of the answer — a caller that
   * gets null writes nothing and clears nothing.
   */
  const agreedTargetMap = useCallback(
    (steps: Y.Array<Y.Map<unknown>>, bound: WriteBinding): Y.Map<unknown> | null => {
      const targetYMap = resolveTargetStep(
        steps, bound.targetKey, activeStepIndex, isStepZero, isSidebarStep
      );
      if (!targetYMap) return null;
      const liveObjectId = (targetYMap.get("object_id") as string | null) ?? null;
      if (liveObjectId !== bound.objectId) return null;
      if (sourceKeyForObject(liveObjectId) !== bound.sourceKey) return null;
      return targetYMap;
    },
    [activeStepIndex, isStepZero, sourceKeyForObject]
  );

  /** The same answer without a Y.Doc, over the loader-backed sidebar steps. */
  const agreedTargetRow = useCallback(
    (bound: WriteBinding): StepWriteRow | null => {
      const included = sidebarSteps.filter(isSidebarStep);
      const target = isStepZero
        ? included[0] ?? null
        : included[activeStepIndex - 1] ?? null;
      if (!target || target.id <= 0) return null;
      if (targetKeyFor(target) !== bound.targetKey) return null;
      const liveObjectId = target.object_id ?? null;
      if (liveObjectId !== bound.objectId) return null;
      if (sourceKeyForObject(liveObjectId) !== bound.sourceKey) return null;
      return target;
    },
    [sidebarSteps, isStepZero, activeStepIndex, sourceKeyForObject]
  );

  // ---------------------------------------------------------------------------
  // Capture and its undo
  // ---------------------------------------------------------------------------

  /** The collaborative capture: the live Y.Map decides, not the rendered step. */
  const captureInDoc = useCallback(
    (doc: Y.Doc, steps: Y.Array<Y.Map<unknown>>, pos: CapturedPosition, bound: WriteBinding) => {
      const stepYMap = agreedTargetMap(steps, bound);
      if (!stepYMap) return;
      // The four values as they stand BEFORE the transaction: read after it,
      // the baseline would be the post-write state and Undo a no-op.
      const prior = {
        x: stepYMap.get("x"),
        y: stepYMap.get("y"),
        zoom: stepYMap.get("zoom"),
        page: stepYMap.get("page"),
      };
      const id = (stepYMap.get("_id") as number | null) ?? 0;
      setCaptureUndo((prev) => ({
        id: id > 0 ? id : null,
        tempId: (stepYMap.get("_temp_id") as string | null) ?? null,
        objectId: bound.objectId,
        prior,
        nonce: (prev?.nonce ?? 0) + 1,
      }));
      doc.transact(() => {
        stepYMap.set("x", pos.x);
        stepYMap.set("y", pos.y);
        stepYMap.set("zoom", pos.zoom);
        stepYMap.set("page", pos.page);
      });
    },
    [agreedTargetMap]
  );

  /**
   * Without a Y.Doc the resolved concrete step id and the expected object go to
   * the action, which conditions its UPDATE on them and answers 409 rather than
   * write a viewport onto an object it was never read from.
   */
  const captureThroughAction = useCallback(
    (pos: CapturedPosition, bound: WriteBinding) => {
      const target = agreedTargetRow(bound);
      if (!target) return;
      submitCapture({
        intent: "capture-position",
        stepId: String(target.id),
        x: String(pos.x),
        y: String(pos.y),
        zoom: String(pos.zoom),
        page: pos.page,
        expectedObjectId: bound.objectId,
      });
    },
    [agreedTargetRow, submitCapture]
  );

  /**
   * A capture describes one object on one page of one source. Between the read
   * and the write a peer can have replaced that object, so the binding the
   * viewer column read it under is compared against live state and the write is
   * abandoned entirely on any disagreement: nothing written, nothing cleared.
   */
  const handleCapturePosition = useCallback(
    (pos: CapturedPosition, binding: WriteBinding) => {
      if (binding.selectionKey !== selectionKey) return;
      // Y.Doc is the source of truth for step state in collaborative mode;
      // snapshotToD1 reconciles. The D1-only fetcher would be clobbered.
      if (useYjs && ydoc && stepsArray) {
        captureInDoc(ydoc, stepsArray, pos, binding);
        return;
      }
      captureThroughAction(pos, binding);
    },
    [selectionKey, useYjs, ydoc, stepsArray, captureInDoc, captureThroughAction]
  );

  /**
   * Revert the just-captured step to its baseline, in one transaction. Values
   * on the same object are last-write-wins, as they were before: a peer's later
   * capture of the same view is simply overwritten. What is refused is an Undo
   * onto a different object, whose coordinates the baseline never described —
   * read from the live Y.Map, so a replacement that has not yet rendered
   * refuses it too.
   */
  const handleUndoCapture = useCallback(() => {
    if (!captureUndo) return;
    const stepYMap = liveMapForBaseline(stepsArray, captureUndo);
    const liveObjectId = (stepYMap?.get("object_id") as string | null) ?? null;
    if (ydoc && stepYMap && liveObjectId === captureUndo.objectId) {
      const { prior } = captureUndo;
      ydoc.transact(() => {
        stepYMap.set("x", prior.x);
        stepYMap.set("y", prior.y);
        stepYMap.set("zoom", prior.zoom);
        stepYMap.set("page", prior.page);
      });
    }
    setCaptureUndo(null);
  }, [captureUndo, stepsArray, ydoc]);

  // ---------------------------------------------------------------------------
  // Changing a step's object
  // ---------------------------------------------------------------------------

  /**
   * The bound write: it fails closed. Without a Y.Doc, or with a target the
   * live array does not resolve to the editor's own target, nothing is written
   * — never a fall-through to whichever step happens to be active when the
   * author picks.
   */
  const changeObjectInTargeted = useCallback(
    (objectId: string, targetKey: string) => {
      if (!useYjs || !ydoc || !stepsArray) return;
      const targetYMap = resolveTargetStep(
        stepsArray, targetKey, activeStepIndex, isStepZero, isSidebarStep
      );
      if (!targetYMap) return;
      ydoc.transact(() => { targetYMap.set("object_id", objectId); });
      setCaptureUndo(null);
    },
    [useYjs, ydoc, stepsArray, activeStepIndex, isStepZero]
  );

  /** The unbound write, onto whichever step is active; step 0 means step 1. */
  const changeObjectInActive = useCallback(
    (objectId: string) => {
      const targetStep = isStepZero ? (sidebarSteps[0] ?? null) : activeStep;
      if (!targetStep) return;
      const stepYMap = targetStep._yMap;
      if (useYjs && ydoc && stepYMap) {
        ydoc.transact(() => { stepYMap.set("object_id", objectId); });
      } else {
        submitChangeObject({
          intent: "change-object",
          stepId: String(targetStep.id),
          objectId,
        });
      }
      setCaptureUndo(null);
    },
    [isStepZero, sidebarSteps, activeStep, useYjs, ydoc, submitChangeObject]
  );

  const handleChangeObject = useCallback(
    (objectId: string, targetKey?: string) => {
      if (targetKey) changeObjectInTargeted(objectId, targetKey);
      else changeObjectInActive(objectId);
    },
    [changeObjectInTargeted, changeObjectInActive]
  );

  // ---------------------------------------------------------------------------
  // Choosing a page
  // ---------------------------------------------------------------------------

  /** The collaborative write: the live Y.Map decides, not the rendered snapshot. */
  const choosePageInDoc = useCallback(
    (doc: Y.Doc, steps: Y.Array<Y.Map<unknown>>, page: number, session: PageChooserSession) => {
      const targetYMap = agreedTargetMap(steps, session);
      if (!targetYMap) return;
      choosePageInStep(doc, targetYMap, page);
      setCaptureUndo(null);
    },
    [agreedTargetMap]
  );

  /**
   * Without a Y.Doc the same active-target rule resolves the session's key
   * against the loader-backed sidebar steps, and a concrete step id plus the
   * expected object go to the action, which conditions its UPDATE on them.
   */
  const choosePageThroughAction = useCallback(
    (page: number, session: PageChooserSession) => {
      const target = agreedTargetRow(session);
      if (!target) return;
      submitSetPage({
        intent: "set-page",
        stepId: String(target.id),
        page: String(page),
        expectedObjectId: session.objectId,
      });
      setCaptureUndo(null);
    },
    [agreedTargetRow, submitSetPage]
  );

  /**
   * The session names the selection, the step, the object and the source the
   * chooser was opened over; all four are compared against live state before
   * anything is written, because a peer's mutation can precede the rerender the
   * dialog was drawn from. The capture baseline is cleared so a stale Undo
   * cannot restore the previous page and framing over the choice.
   */
  const handleChoosePage = useCallback(
    (page: number, session: PageChooserSession) => {
      if (session.selectionKey !== selectionKey) return;
      if (useYjs && ydoc && stepsArray) {
        choosePageInDoc(ydoc, stepsArray, page, session);
        return;
      }
      choosePageThroughAction(page, session);
    },
    [selectionKey, useYjs, ydoc, stepsArray, choosePageInDoc, choosePageThroughAction]
  );

  return {
    captureUndoNonce,
    clearCaptureUndo,
    pendingNewStep,
    handleNewStepConsumed,
    handleAddStep,
    handleCapturePosition,
    handleUndoCapture,
    handleChangeObject,
    handleChoosePage,
  };
}
