/**
 * This file renders the toast notification stack — the
 * fixed-position cluster at the bottom-right of the viewport
 * (z-50) plus the individual toast cards inside it.
 *
 * `ToastContainer` renders the stack; `ToastItem` is an individual
 * toast card with a left-border accent colour based on type, an
 * optional action link (e.g. "Undo" for convenor delete toasts),
 * and a close button.
 *
 * Entry animation: slide-in-from-right (Tailwind v4 `animate-in`).
 * Exit animation: 200ms fade before the container removes the toast
 * from the DOM (handled by the provider via `dismissToast`).
 *
 * @version v1.2.0-beta
 */

import { X } from "lucide-react";
import type { ToastData } from "~/hooks/use-toast";

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

/**
 * ToastContainer — fixed-position stack at bottom-right.
 *
 * Rendered once by ToastProvider. z-50 keeps toasts above modals'
 * backdrops (z-50 with explicit stacking context via fixed positioning).
 */
export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

interface ToastItemProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const borderClass =
    toast.type === "destructive"
      ? "border-l-4 border-red-500"
      : toast.type === "warning"
        ? "border-l-4 border-amber-400"
        : "border-l-4 border-lavender";

  // `critical` swaps the default polite role="status" for
  // the assertive role="alert" so screen readers announce the message
  // immediately. Used by the WS-disconnect destructive toast that fires
  // when a convenor deletes a project the user has open.
  const itemRole = toast.critical ? "alert" : "status";

  return (
    <div
      className={`bg-white rounded-md shadow-lg ${borderClass} p-3 flex items-start gap-3 min-w-72 animate-in slide-in-from-right duration-200`}
      role={itemRole}
    >
      <div className="flex-1">
        <p className="font-body text-sm text-charcoal">{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            onClick={toast.action.onClick}
            className="mt-1 font-heading text-xs uppercase tracking-wider text-terracotta hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="text-gray-400 hover:text-charcoal transition-colors"
        aria-label="Close notification"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
