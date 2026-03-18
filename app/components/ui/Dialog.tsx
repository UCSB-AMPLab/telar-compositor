/**
 * Dialog — reusable modal overlay primitive.
 *
 * Renders a fixed overlay with a centred panel. Closes on overlay click
 * or Escape key. Renders nothing when `open` is false.
 */

import { useEffect, type ReactNode } from "react";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

export function Dialog({ open, onClose, children, className = "" }: DialogProps) {
  useEffect(() => {
    if (!open) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`bg-white rounded-lg shadow-xl w-full mx-4 ${className.includes("max-w-") ? "" : "max-w-md"} ${className.includes("p-") ? "" : "p-6"} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
