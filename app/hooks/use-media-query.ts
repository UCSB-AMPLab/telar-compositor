/**
 * useMediaQuery — SSR-safe `matchMedia` hook.
 *
 * Returns `false` during SSR and on the first client render, then updates to
 * the real match after hydration and on every subsequent change. Starting
 * from `false` keeps the server and first-client markup identical, avoiding a
 * hydration mismatch; consumers that need a different default should treat the
 * first paint as "no match" and let the effect correct it.
 *
 * @version v1.3.7-beta
 */

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
