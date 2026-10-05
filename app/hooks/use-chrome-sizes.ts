/**
 * useChromeSizes — the measured size of each piece of the framing stage's
 * chrome, which `layoutStageChrome` places.
 *
 * Each piece takes the ref `measure(part)` returns and is measured when it
 * mounts and again whenever it changes size, at the width the layout gave it:
 * a label wraps to the width it is capped at, and its height there is what the
 * layout places next. A piece not yet measured, or measured at no size (not
 * laid out), keeps its default. `inner` measures the element's first child,
 * for a piece drawn inside a wrapper that positions it, and follows that
 * child when another replaces it.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useRef, useState } from "react";
import { CHROME_DEFAULTS, type ChromePart, type ChromeSizes } from "~/lib/stage-chrome";

export type ChromeMeasure = (part: ChromePart, inner?: boolean) => (el: HTMLElement | null) => void;

export function useChromeSizes(): { sizes: ChromeSizes; measure: ChromeMeasure } {
  const [sizes, setSizes] = useState<ChromeSizes>(CHROME_DEFAULTS);
  const stops = useRef(new Map<string, () => void>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());

  const measure = useCallback<ChromeMeasure>((part, inner = false) => {
    const key = `${part}:${inner}`;
    let ref = refs.current.get(key);
    if (ref) return ref;
    ref = (el) => {
      stops.current.get(key)?.();
      stops.current.delete(key);
      if (!el) return;
      const target = () => (inner ? el.firstElementChild : el) as HTMLElement | null;
      const read = () => {
        const t = target();
        if (!t || !(t.offsetWidth > 0 && t.offsetHeight > 0)) return;
        const next = { w: t.offsetWidth, h: t.offsetHeight };
        setSizes((prev) => (prev[part].w === next.w && prev[part].h === next.h ? prev : { ...prev, [part]: next }));
      };
      read();
      if (typeof ResizeObserver === "undefined") return;
      const resize = new ResizeObserver(read);
      const watch = () => {
        resize.disconnect();
        const t = target();
        if (t) resize.observe(t);
      };
      watch();
      // A wrapper's child can be replaced while the wrapper stays (a step's bar, when its object changes kind).
      const children = inner && typeof MutationObserver !== "undefined" ? new MutationObserver(() => (watch(), read())) : null;
      children?.observe(el, { childList: true });
      stops.current.set(key, () => {
        resize.disconnect();
        children?.disconnect();
      });
    };
    refs.current.set(key, ref);
    return ref;
  }, []);

  return { sizes, measure };
}
