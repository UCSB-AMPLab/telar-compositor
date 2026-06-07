/**
 * useUndoControls — wraps the shared UndoManager's undo/redo so that an undo or
 * redo with an empty own-stack flashes a "nothing of yours to undo" toast.
 * Lives in the ToastProvider subtree (ToastProvider is nested inside
 * CollaborationProvider, so the provider's own callbacks cannot raise toasts).
 *
 * Off-screen feedback for changes that DID pop is handled separately by
 * UndoFeedback via the manager's stack-item-popped event.
 *
 * @version v1.3.0-beta
 */
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useToast } from "~/hooks/use-toast";

/** Suppress duplicate no-op toasts fired within this window (ms). */
const NOOP_DEDUP_MS = 1500;

export function useUndoControls() {
  const { undoManager, canUndo, canRedo } = useCollaborationContext();
  const { showToast } = useToast();
  const { t } = useTranslation("collaboration");
  const lastNoopRef = useRef(0);

  const flashNoop = useCallback(() => {
    const now = Date.now();
    if (now - lastNoopRef.current < NOOP_DEDUP_MS) return;
    lastNoopRef.current = now;
    showToast({ message: t("undo_nothing"), type: "info" });
  }, [showToast, t]);

  const undo = useCallback(() => {
    if (!undoManager) return; // collaboration not ready — silent no-op
    if (!undoManager.undo()) flashNoop();
  }, [undoManager, flashNoop]);

  const redo = useCallback(() => {
    if (!undoManager) return; // collaboration not ready — silent no-op
    if (!undoManager.redo()) flashNoop();
  }, [undoManager, flashNoop]);

  return { undo, redo, canUndo, canRedo };
}
