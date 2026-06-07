/**
 * UndoFeedback — null-rendering listener mounted inside CollaborationProvider +
 * ToastProvider. Subscribes to the shared UndoManager's `stack-item-popped`
 * event and, when an undo/redo touched an entity that is not on the current
 * route, flashes a non-blocking toast naming it with a one-click reverse action.
 *
 * @version v1.3.0-beta
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the event types mirror Yjs's published AbstractType/YEvent signatures */
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useToast } from "~/hooks/use-toast";
import {
  describeUndoneChange,
  isOffScreen,
  routeToTarget,
  type UndoTarget,
} from "~/lib/undo-target";

interface StackItemPoppedEvent {
  type: "undo" | "redo";
  changedParentTypes: Map<Y.AbstractType<any>, Array<Y.YEvent<any>>>;
}

export function UndoFeedback() {
  const { ydoc, undoManager } = useCollaborationContext();
  const { showToast } = useToast();
  const { t } = useTranslation("collaboration");
  const { pathname } = useLocation();

  // Read pathname through a ref so navigation doesn't re-subscribe the handler.
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  // When the user clicks the toast's reverse action, the programmatic
  // undo/redo fires another stack-item-popped. Suppress the resulting toast.
  const suppressNextRef = useRef(false);

  useEffect(() => {
    if (!ydoc || !undoManager) return;

    const handler = (event: StackItemPoppedEvent) => {
      if (suppressNextRef.current) {
        suppressNextRef.current = false;
        return;
      }

      const targets = describeUndoneChange(event.changedParentTypes, ydoc);
      if (targets.length === 0) return;

      const current = routeToTarget(pathnameRef.current);
      if (!targets.every((target) => isOffScreen(current, target))) return;

      const first: UndoTarget = targets[0];
      const labelKey = first.title
        ? `undo_label_${first.section}`
        : `undo_label_${first.section}_untitled`;
      const label = t(labelKey, { title: first.title ?? "" });

      const isUndo = event.type === "undo";
      showToast({
        message: t(isUndo ? "undo_offscreen_undo" : "undo_offscreen_redo", { label }),
        type: "info",
        action: {
          label: t(isUndo ? "undo_action_redo" : "undo_action_undo"),
          onClick: () => {
            suppressNextRef.current = true;
            const popped = isUndo ? undoManager?.redo() : undoManager?.undo();
            if (!popped) suppressNextRef.current = false; // empty stack — no pop will come
          },
        },
      });
    };

    undoManager.on("stack-item-popped", handler as any);
    return () => undoManager.off("stack-item-popped", handler as any);
  }, [ydoc, undoManager, t, showToast]);

  return null;
}
