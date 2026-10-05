/**
 * A read that came back unreachable is asked again later.
 *
 * A background read that fails in transit is answered unreachable
 * (`answerReadsWhenUnreachable`) so the page stays open. A read made once, on
 * mount, would then stay unanswered for the rest of the visit; this asks it
 * again after `delayMs`, and again after each unreachable answer, until one
 * arrives.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef } from "react";
import { isUnreachableAnswer } from "~/lib/unreachable-write";

export const RETRY_UNREACHABLE_MS = 15_000;

export function useRetryWhileUnreachable(
  answer: unknown,
  retry: () => void,
  wanted = true,
  delayMs = RETRY_UNREACHABLE_MS,
): void {
  const latest = useRef(retry);
  latest.current = retry;
  const unreachable = wanted && isUnreachableAnswer(answer);
  useEffect(() => {
    if (!unreachable) return;
    const timer = setTimeout(() => latest.current(), delayMs);
    return () => clearTimeout(timer);
  }, [unreachable, answer, delayMs]);
}
