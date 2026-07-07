/**
 * Shared "Escape key closes it" behaviour for modals, drawers, and popovers.
 *
 * Attaches a single `document`-level `keydown` listener while `enabled` is
 * true and calls `onEscape` with the triggering event whenever the key is
 * `Escape`. Callers decide what happens next — some call `preventDefault()`
 * before dismissing, some branch on extra local state (e.g. a nested
 * confirm-dismiss prompt), some just call their close callback directly.
 * Passing the raw event through (rather than pre-deciding preventDefault
 * inside the hook) is what let this collapse six near-identical
 * `useEffect`s without changing any site's exact behaviour.
 *
 * The callback is held in a ref and read at keydown time, so the effect's
 * dependency array is just `[enabled]` — the listener is not torn down and
 * re-attached on every render just because the caller passed a fresh inline
 * closure (same latest-ref pattern as `useYjsArraySync`).
 *
 * @version v1.4.0-beta
 */

import { useEffect, useRef } from "react";

export function useEscapeToClose(
  onEscape: (event: KeyboardEvent) => void,
  enabled: boolean = true,
): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onEscapeRef.current(e);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [enabled]);
}
