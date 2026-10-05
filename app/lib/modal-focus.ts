/**
 * modal-focus — the modal semantics and keyboard containment the story
 * editor's page chooser and keep-or-choose dialogs need.
 *
 * The `Dialog` primitive positions a panel and closes it on Escape or an
 * overlay click; it declares no modal role and does not contain focus, so a
 * keyboard user can Tab straight out of a dialog into the editor behind it.
 * These two dialogs are decision points in a chain — the author cannot
 * usefully act on the editor while one is open — so they are named modals whose
 * focus starts on the control the author is being asked about and stays inside
 * until the dialog closes.
 *
 * Focus restoration is not this helper's business: along the chain focus moves
 * forward into the next dialog, and only the chain's owner knows which
 * persistent control to land on when the chain ends.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export interface ModalFocusOptions {
  open: boolean;
  onClose: () => void;
  /** Id of the element that names the dialog. */
  labelledBy: string;
  /** The control that takes focus when the dialog opens. */
  initialFocusRef: RefObject<HTMLElement | null>;
}

export interface ModalFocusResult {
  containerRef: RefObject<HTMLDivElement | null>;
  dialogProps: {
    role: "dialog";
    "aria-modal": "true";
    "aria-labelledby": string;
    onKeyDown: (event: ReactKeyboardEvent) => void;
  };
}

export function useModalFocus({
  open,
  onClose,
  labelledBy,
  initialFocusRef,
}: ModalFocusOptions): ModalFocusResult {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Defer so the panel and its controls exist before focus moves.
    const timer = setTimeout(() => {
      const target = initialFocusRef.current;
      if (target) target.focus();
      else containerRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, initialFocusRef]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !root.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  return {
    containerRef,
    dialogProps: {
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": labelledBy,
      onKeyDown,
    },
  };
}
