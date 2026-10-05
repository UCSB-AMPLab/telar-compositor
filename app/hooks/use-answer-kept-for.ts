/**
 * useAnswerKeptFor — the last good answer of a read, kept for the scope the
 * read was sent under.
 *
 * An answer is looked at once, when the value passed in changes identity: if
 * `pick` takes something from it, that is kept for its scope. The scope is
 * the one the answer names, where `scopeOf` reads one from it (an answer that
 * names its own project is right even for a read the router sent by itself);
 * otherwise the live scope when `markSent` was last called, as each read was
 * sent. A render after the scope changes therefore cannot relabel the
 * answer a fetcher still holds as the new scope's. What is kept is returned
 * only while its scope is the live one.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useRef } from "react";

export function useAnswerKeptFor<T>(
  answer: unknown,
  pick: (answer: unknown) => T | null,
  live: string | number | null,
  scopeOf?: (value: T) => string | number | null,
): { kept: T | null; markSent: () => void } {
  const sentFor = useRef(live);
  const liveNow = useRef(live);
  liveNow.current = live;
  const seen = useRef<unknown>(undefined);
  const kept = useRef<{ scope: string | number | null; value: T } | null>(null);

  if (answer !== seen.current) {
    seen.current = answer;
    const value = pick(answer);
    if (value !== null) kept.current = { scope: scopeOf ? scopeOf(value) : sentFor.current, value };
  }

  const markSent = useCallback(() => {
    sentFor.current = liveNow.current;
  }, []);

  return { kept: kept.current && kept.current.scope === live ? kept.current.value : null, markSent };
}
