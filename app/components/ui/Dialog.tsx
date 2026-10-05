/**
 * Dialog — reusable modal overlay primitive.
 *
 * Renders a fixed overlay with a centred panel. Closes on overlay click
 * or Escape key. Renders nothing when `open` is false.
 *
 * When `dismissConfirm` is set, clicking the overlay or pressing Escape
 * shows a confirmation prompt instead of closing immediately. This
 * prevents accidental data loss in dialogs with form input (e.g. the
 * object upload flow).
 *
 * The panel is a modal dialog to assistive technology: `role="dialog"`,
 * `aria-modal`, and a name taken from the first heading inside it, so
 * callers need not wire one. Focus moves into the panel when it opens, unless
 * a field inside has already taken it with `autoFocus`, and goes back to
 * whatever held it before, if that is still on the page, when the dialog
 * closes. Tab and Shift-Tab wrap within the panel. Escape is left to
 * `useEscapeToClose`, which listens on the document, so a popover inside the
 * panel that stops Escape's propagation still keeps the dialog open.
 *
 * The overlay is portalled to `document.body`, so an ancestor with a CSS
 * transform, a filter or its own stacking context can neither shift it nor
 * clip it. It registers as a layer of the focus scope it was opened from
 * (focus-scope.ts), so focus inside it still counts as focus in, say, the
 * editor whose toolbar opened it.
 *
 * @version v1.5.0-beta
 */

import {
  useState,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useFocusScopeLayer } from "~/components/ui/focus-scope";
import { useEscapeToClose } from "~/hooks/use-escape-to-close";
import { useOverlayOpen } from "~/hooks/use-overlay-open";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** When set, overlay click / Escape shows a confirmation prompt with this message. */
  dismissConfirm?: string;
  /**
   * The caller renders its own modal element inside the panel, through
   * `useModalFocus`, and owns its role, name, focus and Tab; the panel then
   * carries none of them and gives no focus back on close, because those
   * dialogs hand focus forward along a chain only the caller knows.
   */
  managesOwnFocus?: boolean;
}

/** What Tab can land on inside the panel, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), ' +
  '[contenteditable="true"]';

/**
 * The panel's focusable elements that are rendered. A control hidden by CSS
 * (the add-object dialog's mobile-only select, on desktop) cannot take focus,
 * so counting it would send focus nowhere. Where the browser has no
 * `checkVisibility`, every match counts.
 */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => typeof el.checkVisibility !== "function" || el.checkVisibility({ visibilityProperty: true })
  );
}

export function Dialog({
  open,
  onClose,
  children,
  className = "",
  dismissConfirm,
  managesOwnFocus = false,
}: DialogProps) {
  const { t } = useTranslation("common");
  const [showConfirm, setShowConfirm] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const [labelId, setLabelId] = useState<string | undefined>(undefined);
  const fallbackLabelId = useId();

  // The element that held focus before the dialog opened. Read during render,
  // on the render that opens it: by the time an effect runs, a field inside
  // with `autoFocus` has already taken focus, and the opener would be lost.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current && typeof document !== "undefined") {
    const active = document.activeElement;
    openerRef.current = !managesOwnFocus && active instanceof HTMLElement ? active : null;
  }
  wasOpenRef.current = open;

  useFocusScopeLayer(overlayRef, open);
  useOverlayOpen(open);

  // Name the dialog by its first heading. Read after every render, since a
  // dialog with stages (the sync and add-object flows) swaps its heading.
  useLayoutEffect(() => {
    if (!open || managesOwnFocus) return;
    const heading = panelRef.current?.querySelector<HTMLElement>("h1, h2, h3");
    if (heading && !heading.id) heading.id = fallbackLabelId;
    setLabelId(heading?.id || undefined);
  });

  // Move focus in when it opens, unless something inside already has it.
  useLayoutEffect(() => {
    if (!open || managesOwnFocus) return;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      (focusableIn(panel)[0] ?? panel).focus();
    }
  }, [open, managesOwnFocus]);

  // Give focus back to the opener when the dialog closes or unmounts, if
  // focus was lost with the panel. Focus on anything still on the page is left
  // there: a dialog that replaced this one, or this one's own panel when
  // Strict Mode replays the effect, which is also why the opener is kept.
  useEffect(() => {
    if (!open) return;
    return () => {
      const opener = openerRef.current;
      if (!opener || !opener.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      opener.focus();
    };
  }, [open]);

  // The confirmation prompt takes focus while it shows, and gives it back to
  // what held it in the panel when the author goes back, or to the panel.
  useEffect(() => {
    if (!showConfirm) return;
    const before = document.activeElement;
    confirmRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      const panel = panelRef.current;
      if (!panel) return;
      if (before instanceof HTMLElement && before.isConnected && panel.contains(before)) {
        before.focus();
      } else {
        panel.focus();
      }
    };
  }, [showConfirm]);

  /** Keep Tab inside the topmost layer: the prompt if it shows, else the panel. */
  const trapTab = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    // A dialog opened from this one is portalled beside it, not inside it, but
    // its key events still bubble here through React; that dialog keeps Tab.
    if (!overlayRef.current?.contains(event.target as Node)) return;
    if (managesOwnFocus && !showConfirm) return;
    const layer = showConfirm ? confirmRef.current : panelRef.current;
    if (!layer) return;
    const items = focusableIn(layer);
    if (items.length === 0) {
      event.preventDefault();
      layer.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !layer.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !layer.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleDismissAttempt = useCallback(() => {
    if (dismissConfirm) {
      setShowConfirm(true);
    } else {
      onClose();
    }
  }, [dismissConfirm, onClose]);

  // Reset confirmation state when dialog closes
  useEffect(() => {
    if (!open) setShowConfirm(false);
  }, [open]);

  useEscapeToClose(() => {
    if (showConfirm) {
      setShowConfirm(false);
    } else {
      handleDismissAttempt();
    }
  }, open);

  // Keyboard-occlusion guard for touch devices: when a field inside the dialog
  // is focused the on-screen keyboard covers the lower half, hiding inputs and
  // the confirm/submit buttons. Scroll the focused field into the centre of the
  // (now shorter) visible area so it — and the controls below it — stay reachable.
  useEffect(() => {
    if (!open) return;
    // Touch only — a desktop (fine pointer) has no on-screen keyboard to dodge,
    // and scrolling the focused field would be unexpected there.
    if (
      typeof window === "undefined" ||
      !window.matchMedia?.("(pointer: coarse)").matches
    )
      return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function handleFocusIn(e: FocusEvent) {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable) {
        // Defer so it runs after the keyboard animates in and layout settles.
        timer = setTimeout(() => {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 150);
      }
    }
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      if (timer) clearTimeout(timer);
    };
  }, [open]);

  if (!open) return null;

  const overlay = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 bg-black/50 overflow-y-auto overscroll-contain"
      onKeyDown={trapTab}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleDismissAttempt();
      }}
    >
      {/* Scroll wrapper: lets tall dialogs and keyboard-shrunk viewports scroll
          to reach every field and the confirm buttons. Clicking the padding
          (this element directly) still dismisses. */}
      <div
        className="flex min-h-full items-center justify-center p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) handleDismissAttempt();
        }}
      >
        <div
          ref={panelRef}
          role={managesOwnFocus ? undefined : "dialog"}
          aria-modal={managesOwnFocus ? undefined : "true"}
          aria-labelledby={managesOwnFocus ? undefined : labelId}
          tabIndex={-1}
          className={`bg-white rounded-lg shadow-xl w-full focus:outline-none max-h-[calc(100dvh-2rem)] overflow-y-auto ${className.includes("max-w-") ? "" : "max-w-md"} ${className.includes("p-") ? "" : "p-6"} ${className}`}
        >
          {children}
        </div>
      </div>

      {/* Dismiss confirmation overlay */}
      {showConfirm && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowConfirm(false);
          }}
        >
          <div
            ref={confirmRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${fallbackLabelId}-confirm`}
            tabIndex={-1}
            className="bg-white rounded-lg shadow-2xl max-w-sm w-full mx-4 p-6 text-center focus:outline-none"
          >
            <p id={`${fallbackLabelId}-confirm`} className="font-body text-sm text-charcoal mb-4">{dismissConfirm}</p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="font-heading font-semibold text-sm uppercase tracking-wider text-charcoal border border-gray-200 rounded-full px-5 py-2 hover:bg-gray-50 transition-colors"
              >
                {t("dialog.dismiss_cancel", "Go back")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowConfirm(false);
                  onClose();
                }}
                className="font-heading font-semibold text-sm uppercase tracking-wider text-white bg-terracotta rounded-full px-5 py-2 hover:opacity-90 transition-opacity"
              >
                {t("dialog.dismiss_confirm", "Close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
  // Server rendering has no body to portal into; the overlay renders in place.
  return typeof document === "undefined" ? overlay : createPortal(overlay, document.body);
}
