/**
 * A logical focus scope: an element, and the layers opened from it that are
 * rendered elsewhere in the page. An editor's link and footnote popovers and
 * its image dialog are portalled to `document.body`, so DOM containment
 * cannot say whether focus in one of them is still focus in the editor; the
 * scope can, because each layer registers with the scope it was opened from.
 *
 * Registration travels through React context, which a portal keeps, so a
 * layer finds its scope wherever its DOM ends up. A scope nested in another
 * scope registers its layers with both, and focus in a layer of an inner
 * scope counts as inside the outer one too.
 *
 * Leaving is judged after the focus change has settled, on the next task,
 * from `document.activeElement`. A layer that takes focus as it mounts (an
 * `autoFocus` field in a dialog) takes it before its registration runs, and
 * a judgement made on the event itself would count that as leaving.
 *
 * Focus can also be placed before the scope listens at all: React focuses
 * an `autoFocus` field during commit, before any effect runs, and a dialog
 * open from the start moves focus in from its layout effect. So the scope
 * reads where focus is when it subscribes. A layer that takes focus after
 * that fires `focusin` before it registers, and the judgement that event
 * schedules runs after the registration. A focused layer that is removed
 * takes focus with it and no event says so, so the scope judges again
 * after a layer unregisters.
 *
 * @version v1.5.0-beta
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";

export interface FocusScope {
  /** Adds a layer to the scope; the returned function removes it. */
  register: (layer: HTMLElement) => () => void;
  /** Whether a node is in the scope's root or in one of its layers. */
  contains: (node: Node | null) => boolean;
}

export const FocusScopeContext = createContext<FocusScope | null>(null);

// useLayoutEffect warns during server rendering; nothing registers there.
const useClientLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

/**
 * Registers `ref`'s element with the enclosing scope while `active`. A
 * component with no enclosing scope registers nothing.
 */
export function useFocusScopeLayer(ref: RefObject<HTMLElement | null>, active = true): void {
  const scope = useContext(FocusScopeContext);
  useClientLayoutEffect(() => {
    const layer = ref.current;
    if (!scope || !active || !layer) return;
    return scope.register(layer);
  }, [scope, active, ref]);
}

interface FocusScopeOptions {
  /** Called when focus arrives in the scope from outside it. */
  onEnter?: () => void;
  /** Called when focus has left the root and every layer. */
  onLeave?: () => void;
}

/**
 * A scope rooted at `rootRef`. Provide the returned value through
 * `FocusScopeContext` so layers opened inside can register with it.
 *
 * `judge` re-reads where focus is and calls `onEnter` or `onLeave` if that
 * has changed; the scope calls it itself from document focus events, and a
 * caller whose own focus handler fires first may call it too.
 */
export function useFocusScope(
  rootRef: RefObject<HTMLElement | null>,
  { onEnter, onLeave }: FocusScopeOptions,
): FocusScope & { judge: () => void } {
  const parent = useContext(FocusScopeContext);
  const layers = useRef(new Set<HTMLElement>());
  const inside = useRef(false);
  const handlers = useRef({ onEnter, onLeave });
  handlers.current = { onEnter, onLeave };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const contains = useCallback(
    (node: Node | null) => {
      if (!node) return false;
      if (rootRef.current?.contains(node)) return true;
      for (const layer of layers.current) if (layer.contains(node)) return true;
      return false;
    },
    [rootRef],
  );

  const judge = useCallback(() => {
    const now = contains(document.activeElement);
    if (now === inside.current) return;
    inside.current = now;
    if (now) handlers.current.onEnter?.();
    else handlers.current.onLeave?.();
  }, [contains]);

  /** Judges once the focus change in progress has settled. */
  const settle = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      judge();
    }, 0);
  }, [judge]);

  const register = useCallback(
    (layer: HTMLElement) => {
      layers.current.add(layer);
      const unregisterParent = parent?.register(layer);
      return () => {
        layers.current.delete(layer);
        unregisterParent?.();
        settle();
      };
    },
    [parent, settle],
  );

  useEffect(() => {
    judge();
    const onFocusIn = (event: FocusEvent) => {
      // Arriving is certain on the event; leaving waits for the change to settle.
      if (contains(event.target as Node | null) && !inside.current) judge();
      else settle();
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", settle, true);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", settle, true);
    };
  }, [contains, judge, settle]);

  return useMemo(() => ({ register, contains, judge }), [register, contains, judge]);
}
