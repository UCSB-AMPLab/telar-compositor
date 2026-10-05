/**
 * The story editor's dialog chain: keep-or-choose, the object picker, and the
 * page chooser, as one piece of state owned by the viewer column.
 *
 * They are one chain rather than three dialogs because each can hand over to
 * the next — a seeded step offers to keep or replace its object, replacing it
 * opens the picker, and a picked multi-page object opens the chooser — and only
 * the column knows when the chain has ended and which persistent control focus
 * should land on. The control that opened a dialog may itself have unmounted by
 * then, so focus goes to the bar's Change button, else "Change object", else
 * the document body.
 *
 * A pick reaches the viewer only once the route reflects it, so a pick is held
 * as an `awaiting` record and consumed only when the rendered target carries
 * that object AND its source has resolved. That wait is also why a non-IIIF
 * pick ends the chain only once the rendered target matches: an image picked
 * while a video is showing keeps its chooser across the interval.
 *
 * The picker calls `onSelect` and then `onClose` on a pick, so a selection is
 * marked before the close arrives and a close with nothing marked is a
 * dismissal.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceState } from "~/components/features/objects/IiifViewer";
import type { PageChooserSession } from "~/components/features/editor/PageChooserDialog";

/**
 * `confirm` asks whether a seeded new step keeps its inherited object; `picker`
 * is the object picker; `awaiting` holds a pick whose object has not yet
 * reached the viewer; `chooser` is the page chooser.
 */
export type DialogChain =
  | null
  | {
      stage: "confirm" | "picker" | "awaiting" | "chooser";
      newStep?: { tempId: string };
      awaiting?: { selectionKey: string; objectId: string };
      session?: PageChooserSession;
    };

/** What the column is showing, as the chain needs to see it. */
export interface DialogChainContext {
  /** `_tempId` of the active step, or null when there is no step. */
  activeTempId: string | null;
  hasStep: boolean;
  selectionKey: string;
  currentObjectId: string | null;
  currentTargetKey: string | null;
  columnSourceKey: string;
  isIiif: boolean;
  sourceState: SourceState | null;
  pendingNewStep: { tempId: string } | null;
  onNewStepConsumed?: (tempId: string) => void;
  onChangeObject: (objectId: string, targetKey?: string) => void;
}

type ChooserReadiness = "wait" | "end" | "open";

/** The part of the context the awaiting record is judged against. */
type ChooserContext = Pick<
  DialogChainContext,
  "selectionKey" | "currentObjectId" | "isIiif" | "sourceState" | "columnSourceKey"
>;

/**
 * Whether an awaiting pick may become a chooser yet. `wait` keeps the record
 * for a later render; `end` retires it without a chooser (a selection change, a
 * non-IIIF object, an unavailable source, a single page).
 */
function chooserReadiness(
  record: { selectionKey: string; objectId: string },
  ctx: ChooserContext
): ChooserReadiness {
  if (record.selectionKey !== ctx.selectionKey) return "end";
  if (ctx.currentObjectId !== record.objectId) return "wait";
  if (!ctx.isIiif) return "end";
  const source = ctx.sourceState;
  if (!source || source.sourceKey !== ctx.columnSourceKey) return "wait";
  if (source.status === "unavailable") return "end";
  if (source.status !== "ready") return "wait";
  return source.pageCount > 1 ? "open" : "end";
}

export interface DialogChainApi {
  chain: DialogChain;
  /** Persistent focus targets, in the order the chain's end prefers them. */
  changePageButtonRef: React.RefObject<HTMLButtonElement | null>;
  changeObjectButtonRef: React.RefObject<HTMLButtonElement | null>;
  endChain: () => void;
  openChooser: () => void;
  openPicker: () => void;
  handlePickerSelect: (objectId: string) => void;
  handlePickerClose: () => void;
}

export function useViewerDialogChain(ctx: DialogChainContext): DialogChainApi {
  const [chain, setChain] = useState<DialogChain>(null);
  // The chain as the handlers see it: a picker selection is answered outside
  // React's own update, so the session it belongs to is read from here rather
  // than from inside a state updater.
  const chainRef = useRef<DialogChain>(null);
  chainRef.current = chain;
  const pickedRef = useRef<string | null>(null);
  // The new-step request a chain was already opened for. The route clears the
  // request on acknowledgement, and this makes a second consumption of the same
  // id impossible in the interval before that clearing renders.
  const consumedNewStepRef = useRef<string | null>(null);

  const changePageButtonRef = useRef<HTMLButtonElement>(null);
  const changeObjectButtonRef = useRef<HTMLButtonElement>(null);

  const {
    activeTempId,
    hasStep,
    selectionKey,
    currentObjectId,
    currentTargetKey,
    columnSourceKey,
    isIiif,
    sourceState,
    pendingNewStep,
    onNewStepConsumed,
    onChangeObject,
  } = ctx;

  const endChain = useCallback(() => {
    setChain(null);
    pickedRef.current = null;
    const target = changePageButtonRef.current ?? changeObjectButtonRef.current ?? null;
    if (target) target.focus();
    else if (typeof document !== "undefined") (document.body as HTMLElement).focus?.();
  }, []);

  const openChooser = useCallback(() => {
    if (!hasStep || !currentObjectId || !currentTargetKey) return;
    setChain((prev) => ({
      stage: "chooser",
      newStep: prev?.newStep,
      session: {
        selectionKey,
        targetKey: currentTargetKey,
        objectId: currentObjectId,
        sourceKey: columnSourceKey,
      },
    }));
  }, [hasStep, currentObjectId, currentTargetKey, selectionKey, columnSourceKey]);

  const openPicker = useCallback(() => {
    setChain((prev) => ({ stage: "picker", newStep: prev?.newStep }));
  }, []);

  const handlePickerSelect = useCallback(
    (objectId: string) => {
      pickedRef.current = objectId;
      const newStep = chainRef.current?.newStep;
      onChangeObject(objectId, newStep ? `tmp:${newStep.tempId}` : undefined);
    },
    [onChangeObject]
  );

  const handlePickerClose = useCallback(() => {
    const picked = pickedRef.current;
    pickedRef.current = null;
    if (!picked) {
      endChain();
      return;
    }
    setChain((prev) => ({
      stage: "awaiting",
      newStep: prev?.newStep,
      awaiting: { selectionKey, objectId: picked },
    }));
  }, [endChain, selectionKey]);

  // An awaiting pick becomes a chooser, or retires, once the rendered target
  // and its source say which.
  useEffect(() => {
    if (chain?.stage !== "awaiting" || !chain.awaiting) return;
    const verdict = chooserReadiness(chain.awaiting, {
      selectionKey,
      currentObjectId,
      isIiif,
      sourceState,
      columnSourceKey,
    });
    if (verdict === "end") endChain();
    if (verdict === "open") openChooser();
  }, [
    chain, selectionKey, currentObjectId, isIiif, sourceState, columnSourceKey,
    endChain, openChooser,
  ]);

  // The route's handoff for a seeded new step: consumed once this column is
  // mounted and the rendered active step is that step, and acknowledged by id.
  useEffect(() => {
    if (!pendingNewStep) return;
    if (!hasStep || activeTempId !== pendingNewStep.tempId) return;
    if (consumedNewStepRef.current === pendingNewStep.tempId) return;
    consumedNewStepRef.current = pendingNewStep.tempId;
    setChain({ stage: "confirm", newStep: { tempId: pendingNewStep.tempId } });
    onNewStepConsumed?.(pendingNewStep.tempId);
  }, [pendingNewStep, hasStep, activeTempId, onNewStepConsumed]);

  // A new-step session belongs to one step: a switch, a peer's deletion or a
  // reorder that moves it out of the active slot cancels it and closes
  // whichever dialog is open.
  useEffect(() => {
    if (!chain?.newStep) return;
    if (!hasStep || activeTempId !== chain.newStep.tempId) endChain();
  }, [chain, hasStep, activeTempId, endChain]);

  // An open chooser is bound to its target: any drift in the selection, the
  // target step, the object or the source closes it, and a choice made after
  // that reaches no write.
  useEffect(() => {
    if (chain?.stage !== "chooser" || !chain.session) return;
    const session = chain.session;
    if (
      session.selectionKey !== selectionKey ||
      session.targetKey !== currentTargetKey ||
      session.objectId !== currentObjectId ||
      session.sourceKey !== columnSourceKey
    ) {
      endChain();
    }
  }, [chain, selectionKey, currentTargetKey, currentObjectId, columnSourceKey, endChain]);

  return {
    chain,
    changePageButtonRef,
    changeObjectButtonRef,
    endChain,
    openChooser,
    openPicker,
    handlePickerSelect,
    handlePickerClose,
  };
}
