/**
 * usePanelDismissKeys — Escape and Left arrow close the topmost layer panel,
 * as they do on the published page (the framework
 * assets/js/telar-story/navigation.js, `_closeTopmostPanel`), without taking
 * either key from anything else in the editor.
 *
 * One listener on the document, in the bubbling phase, so every handler on
 * the way (an open field, a popover, CodeMirror) has had the key first. It
 * acts only when the event is not `defaultPrevented`, not part of a
 * composition (`isComposing`, or key code 229), and no overlay or menu is
 * open (`overlaysOpen`, use-overlay-open.ts). So one press closes one thing:
 * an overlay, menu or open field first, then the panel.
 *
 * Escape with focus in the topmost panel's content editor moves focus to the
 * panel's heading rather than closing the panel; the next Escape closes it.
 * CodeMirror's own Escape, which narrows a selection, prevents the default
 * while it has one to narrow, and so runs before either.
 *
 * Left arrow closes the topmost panel only when focus is not in editable
 * text and no modifier is held, since in text it moves the caret.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef } from "react";
import { overlaysOpen } from "~/hooks/use-overlay-open";

interface PanelDismissKeys {
  /** Whether a panel is open. */
  enabled: boolean;
  /** The topmost open panel's element. */
  topPanel: () => HTMLElement | null;
  /** The topmost open panel's heading, which takes focus from its editor. */
  topHeading: () => HTMLElement | null;
  /** Closes the topmost open panel. */
  onClose: () => void;
}

/** Whether `el` takes typed text: a text field, a select, or editable content. */
export function isEditableText(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(el.type);
  }
  return false;
}

export function usePanelDismissKeys({ enabled, topPanel, topHeading, onClose }: PanelDismissKeys): void {
  const latest = useRef({ topPanel, topHeading, onClose });
  latest.current = { topPanel, topHeading, onClose };

  useEffect(() => {
    if (!enabled) return;
    function dismissTopPanel(event: KeyboardEvent) {
      if (event.key !== "Escape" && event.key !== "ArrowLeft") return;
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (overlaysOpen() > 0) return;
      const active = document.activeElement;
      if (event.key === "ArrowLeft") {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (isEditableText(active)) return;
        event.preventDefault();
        latest.current.onClose();
        return;
      }
      const panel = latest.current.topPanel();
      const editor = active instanceof Element ? active.closest(".cm-editor") : null;
      if (editor && panel?.contains(editor)) {
        const heading = latest.current.topHeading();
        if (heading) {
          event.preventDefault();
          heading.focus();
          return;
        }
      }
      event.preventDefault();
      latest.current.onClose();
    }
    document.addEventListener("keydown", dismissTopPanel);
    return () => document.removeEventListener("keydown", dismissTopPanel);
  }, [enabled]);
}
