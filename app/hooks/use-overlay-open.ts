/**
 * useOverlayOpen — the overlays and menus open anywhere in the editor, in the
 * order they opened, so a key that closes the topmost layer panel (Escape,
 * Left arrow) does nothing while something else is open that the same key
 * closes, and a menu that takes Escape first (`useEscapeFirst`) takes it only
 * while nothing opened above it.
 *
 * Each component that opens an overlay or a menu calls `useOverlayOpen(open)`
 * and keeps its own Escape handling. An overlay joins the stack in an effect,
 * after the render that opens it, and leaves in the effect's cleanup, after
 * the render that closes it, so during the keydown that closes an overlay it
 * is still on the stack, whichever listener runs first: one press closes one
 * thing. An overlay opened after another is above it.
 *
 * The stack is module state, shared by every component on the page.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useRef } from "react";

const stack: object[] = [];

/** How many overlays and menus are open now. */
export function overlaysOpen(): number {
  return stack.length;
}

/**
 * Puts this component's overlay on the stack while `open`. `isTop` answers
 * whether it is open and nothing opened since is still open.
 */
export function useOverlayOpen(open: boolean): { isTop: () => boolean } {
  const id = useRef<object>({});
  useEffect(() => {
    if (!open) return;
    const own = id.current;
    stack.push(own);
    return () => {
      const at = stack.lastIndexOf(own);
      if (at !== -1) stack.splice(at, 1);
    };
  }, [open]);
  const isTop = useCallback(() => stack.length > 0 && stack[stack.length - 1] === id.current, []);
  return { isTop };
}
