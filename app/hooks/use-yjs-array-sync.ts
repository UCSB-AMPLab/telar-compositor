/**
 * Mirror a `Y.Array<Y.Map<unknown>>` into React state as a plain array.
 *
 * Rebuilds the array once on mount (and whenever `yArray` changes identity),
 * subscribes with `observeDeep` so every nested mutation re-derives the plain
 * array, and tears the observer down on cleanup. When `yArray` is null (no
 * ydoc / D1-fallback render path) the hook returns null so callers can gate on
 * `result !== null` to choose the Yjs source over loader data.
 *
 * The map function is held in a ref and read at recompute time, so the effect
 * depends only on `[yArray]` — passing a fresh inline `mapFn` each render does
 * NOT re-subscribe the observer. This preserves the subscribe-once semantics of
 * the hand-written effects this hook replaces; callers relied on the observer
 * being wired exactly when the underlying Y.Array reference changed.
 *
 * @version v1.4.0-beta
 */

import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";

export function useYjsArraySync<T>(
  yArray: Y.Array<Y.Map<unknown>> | null,
  mapFn: (item: Y.Map<unknown>, index: number) => T,
): T[] | null {
  const [items, setItems] = useState<T[] | null>(null);

  // Latest-ref: keep the newest mapFn available to the observer without making
  // it an effect dependency (which would churn the observeDeep subscription).
  const mapRef = useRef(mapFn);
  mapRef.current = mapFn;

  useEffect(() => {
    if (!yArray) {
      setItems(null);
      return;
    }
    const recompute = () => {
      const next: T[] = [];
      for (let i = 0; i < yArray.length; i++) {
        next.push(mapRef.current(yArray.get(i), i));
      }
      setItems(next);
    };
    recompute();
    yArray.observeDeep(recompute);
    return () => yArray.unobserveDeep(recompute);
  }, [yArray]);

  return items;
}
