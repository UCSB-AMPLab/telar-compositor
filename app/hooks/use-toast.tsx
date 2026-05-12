/**
 * This file is the React context, provider, and hook for toast
 * notifications — the lightweight feedback system used by
 * structural operations and any other surface that needs to flash
 * a short message at the user.
 *
 * Toasts auto-dismiss after 5s by default or can be dismissed
 * manually via the close button. Convenor delete toasts include an
 * optional "Undo" action link.
 *
 * Up to 5 toasts are kept in the queue at once; older ones are
 * evicted as new ones arrive. Rendering lives in `ToastContainer`
 * (see `Toast.tsx`).
 *
 * @version v1.2.0-beta
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ToastContainer } from "~/components/ui/Toast";

const DEFAULT_AUTO_DISMISS_MS = 5000;
const MAX_VISIBLE_TOASTS = 5;

export interface ToastData {
  id: string;
  message: string;
  type: "info" | "warning" | "destructive";
  /** Optional action link — e.g. the convenor "Undo" link on delete toasts. */
  action?: { label: string; onClick: () => void };
  /**
   * Auto-dismiss timeout in ms.
   *  - `undefined` → uses DEFAULT_AUTO_DISMISS_MS (5000ms; back-compat)
   *  - positive number → custom timeout
   *  - `null` → STICKY (no auto-dismiss; user must dismiss manually).
   *    Used by the WS-disconnect destructive toast — the user is
   *    being kicked off the project and must read the message.
   */
  autoDismissMs?: number | null;
  /**
   * When true, ToastItem renders `role="alert"` (assertive
   * announcement) instead of the default `role="status"` (polite). Used
   * by the WS-disconnect destructive toast so screen readers interrupt
   * other speech to announce the project deletion.
   */
  critical?: boolean;
}

export interface ToastContextValue {
  showToast: (toast: Omit<ToastData, "id">) => void;
  dismissToast: (id: string) => void;
}

const defaultValue: ToastContextValue = {
  showToast: () => {},
  dismissToast: () => {},
};

const ToastContext = createContext<ToastContextValue>(defaultValue);

/**
 * useToast — consume the toast context.
 *
 * Returns default no-op handlers when no provider is in the tree (safe
 * for SSR and tests). Wrap the app in `ToastProvider` to enable toasts.
 */
export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

/**
 * ToastProvider — manages the toast queue and auto-dismiss timers.
 *
 * Renders children plus a fixed-position ToastContainer at bottom-right.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (toast: Omit<ToastData, "id">) => {
      const id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const newToast: ToastData = { ...toast, id };

      setToasts((prev) => {
        const next = [...prev, newToast];
        // Max 5 visible — evict oldest and clear its timer
        if (next.length > MAX_VISIBLE_TOASTS) {
          const removed = next.shift();
          if (removed) {
            const t = timersRef.current.get(removed.id);
            if (t) {
              clearTimeout(t);
              timersRef.current.delete(removed.id);
            }
          }
        }
        return next;
      });

      // `autoDismissMs: null` means STICKY — schedule no
      // timer at all. `undefined` falls back to the default. Positive
      // numbers use the supplied value.
      if (toast.autoDismissMs !== null) {
        const dismissMs = toast.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS;
        const timer = setTimeout(() => dismissToast(id), dismissMs);
        timersRef.current.set(id, timer);
      }
    },
    [dismissToast]
  );

  // Cleanup any remaining timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast }),
    [showToast, dismissToast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}
