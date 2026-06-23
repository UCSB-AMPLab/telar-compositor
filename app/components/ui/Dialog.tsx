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
 */

import { useState, useCallback, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** When set, overlay click / Escape shows a confirmation prompt with this message. */
  dismissConfirm?: string;
}

export function Dialog({ open, onClose, children, className = "", dismissConfirm }: DialogProps) {
  const { t } = useTranslation("common");
  const [showConfirm, setShowConfirm] = useState(false);

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

  useEffect(() => {
    if (!open) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (showConfirm) {
          setShowConfirm(false);
        } else {
          handleDismissAttempt();
        }
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, showConfirm, handleDismissAttempt]);

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

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 overflow-y-auto overscroll-contain"
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
          className={`bg-white rounded-lg shadow-xl w-full max-h-[calc(100dvh-2rem)] overflow-y-auto ${className.includes("max-w-") ? "" : "max-w-md"} ${className.includes("p-") ? "" : "p-6"} ${className}`}
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
          <div className="bg-white rounded-lg shadow-2xl max-w-sm w-full mx-4 p-6 text-center">
            <p className="font-body text-sm text-charcoal mb-4">{dismissConfirm}</p>
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
}
