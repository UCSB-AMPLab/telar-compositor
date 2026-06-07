/**
 * This file is the shared anchored container every Site Status popover
 * renders inside. It owns one consistent, library-free dismiss behaviour —
 * the same fixed-inset overlay idiom the rest of the repo's dropdowns use,
 * plus an Esc keydown listener mirroring the Header dropdown — so the
 * per-state popovers (in-sync, unpublished, out-of-sync, publishing,
 * upgrade) stay pure content with no dismiss logic of their own.
 *
 * Geometry is pixel-locked to the design spec: a fixed 380px width and the
 * exact drop shadow are applied inline because they sit off the Tailwind
 * scale. The one deliberate divergence from the mock is the anchor —
 * `right-0` instead of the mock's `left:0` — because the pill lives at the
 * header's right edge and the popover must open toward the viewport
 * interior.
 *
 * Single-open is inherent: there is one Site Status pill, so only one popover
 * can ever be open. The shell renders nothing when closed.
 *
 * The consumer is responsible for the `relative` positioning context (the
 * pill wrapper) this `absolute` popover anchors against.
 *
 * @version v1.3.0-beta
 */

import { useEffect, type ReactNode } from "react";

interface StatusPopoverShellProps {
  /** Whether the popover is open. When false the shell renders nothing. */
  open: boolean;
  /** Called when the user dismisses via outside-click or Escape. */
  onClose: () => void;
  /** Popover body — a per-state popover component. */
  children: ReactNode;
  /** Extra classes for the popover container (composition). */
  className?: string;
}

// Design-locked drop shadow — off the Tailwind scale, so applied inline to
// keep the exact two-layer value.
const POPOVER_SHADOW =
  "0 12px 32px -8px rgba(0,0,0,.2), 0 6px 12px -6px rgba(0,0,0,.1)";

export function StatusPopoverShell({
  open,
  onClose,
  children,
  className = "",
}: StatusPopoverShellProps) {
  // Esc closes the open popover — mirrors the document-listener useEffect
  // pattern from the Header dropdown (there for mousedown; here for keydown).
  // Attached only while open and cleaned up on close/unmount.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Transparent outside-click overlay — same idiom as ProjectStatusBar. */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* Anchored popover: right-aligned override, 8px offset. */}
      <div
        role="dialog"
        className={`absolute top-full right-0 mt-2 z-50 overflow-hidden rounded-lg border border-border bg-surface ${className}`}
        style={{ width: "380px", boxShadow: POPOVER_SHADOW }}
      >
        {children}
      </div>
    </>
  );
}
