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
 * `useEscapeFirst` is the same for a menu that must close before anything
 * else hears the key: see its own comment.
 *
 * @version v1.5.0-beta
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

/**
 * While `enabled` and `isTop()`, Escape calls `onEscape` before anything else
 * hears it and goes no further: the listener is on the document in the
 * capture phase, so it runs before a focused editor's own handlers, and it
 * stops the event. For a toolbar menu opened with the pointer, which leaves
 * focus in the editor (toolbar-press.ts): without it the editor would take
 * the key (to narrow a selection, or to close the field it is in) and the
 * menu would stay open, still counted as open (use-overlay-open.ts).
 *
 * `isTop` is the menu's place on the overlay stack (`useOverlayOpen`): while
 * a dialog or popover opened above the menu is open, the key is left to it,
 * and the menu closes on a later press. A key that is part of a composition
 * is left alone.
 */
export function useEscapeFirst(onEscape: () => void, enabled: boolean, isTop: () => boolean): void {
  const latest = useRef({ onEscape, isTop });
  latest.current = { onEscape, isTop };

  useEffect(() => {
    if (!enabled) return;
    function takeEscape(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
      if (!latest.current.isTop()) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.onEscape();
    }
    document.addEventListener("keydown", takeEscape, true);
    return () => document.removeEventListener("keydown", takeEscape, true);
  }, [enabled]);
}
