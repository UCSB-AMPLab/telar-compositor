/**
 * useBackgroundRead — a read the page makes on its own, outside navigation,
 * whose failure leaves the page as it was.
 *
 * A fetcher read that fails in transit (the network is down, an upstream 5xx,
 * an undecodable answer) is sent to the nearest error boundary, and the page is
 * replaced by its error card, with any open field's draft. A read the page did
 * not ask for in the author's name must not do that, so these reads use `fetch`
 * and keep the last good answer instead.
 *
 * - The kept answer belongs to its scope: the URL and the active project. A
 *   change of either drops it, and an answer that arrives for a superseded
 *   scope is discarded. Each read carries an `AbortController`; unmounting,
 *   disabling or changing scope aborts the read in flight, and a new read
 *   aborts the one before it.
 * - An answer is accepted only when the response is 2xx, was not redirected
 *   and parses as JSON. A redirect is how the auth middleware's redirect to
 *   the sign-in page reaches a `fetch`. Anything else is a failed read: the
 *   kept answer stands, the next beat reads again, and one console line is
 *   written per run of failures. The next navigation meets the auth
 *   middleware as usual.
 * - `afterActions` stands in for the router's revalidation, which reads a
 *   fetcher's loaded data again after every action. A completed fetcher leaves
 *   `useFetchers()` rather than showing there as idle, so the keys of the
 *   submissions seen (any form method but GET) are recorded, and the hook
 *   reads again when one of them is gone or idle. A navigation submission
 *   completes when `useNavigation()` returns to idle from one.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFetchers, useNavigation } from "react-router";

export interface BackgroundReadOptions {
  /** What to read; null reads nothing. */
  url: string | null;
  /** Whether reads are made at all. */
  enabled: boolean;
  /** Read again on this beat while enabled. */
  intervalMs?: number;
  /** Read again when the window regains focus. */
  onFocus?: boolean;
  /** Read again whenever a submission completes. */
  afterActions?: boolean;
  /** The active project the answer belongs to. */
  scope: number | string | null;
}

type ReadResult = { ok: true; data: unknown } | { ok: false; reason: string };

async function readOnce(url: string, signal: AbortSignal): Promise<ReadResult> {
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "request failed" };
  }
  if (response.redirected) return { ok: false, reason: "redirected" };
  if (!response.ok) return { ok: false, reason: `status ${response.status}` };
  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, reason: "answer is not JSON" };
  }
}

function isSubmission(formMethod: string | undefined): boolean {
  return !!formMethod && formMethod.toUpperCase() !== "GET";
}

export function useBackgroundRead<T>({
  url,
  enabled,
  intervalMs,
  onFocus = false,
  afterActions = false,
  scope,
}: BackgroundReadOptions): T | undefined {
  const key = JSON.stringify([scope, url]);
  const active = enabled && url !== null;
  const [kept, setKept] = useState<{ key: string; data: T } | null>(null);

  // The read below outlives renders; it reads the latest of these.
  const current = useRef({ key, url, active, afterActions });
  current.current = { key, url, active, afterActions };
  const inFlight = useRef<AbortController | null>(null);
  const failing = useRef(false);

  const read = useCallback(() => {
    const { key: startedUnder, url: target, active: reading } = current.current;
    if (!reading || target === null) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    void readOnce(target, controller.signal).then((result) => {
      if (controller.signal.aborted || current.current.key !== startedUnder) return;
      if (inFlight.current === controller) inFlight.current = null;
      if (result.ok) {
        failing.current = false;
        setKept({ key: startedUnder, data: result.data as T });
        return;
      }
      if (!failing.current) console.warn(`[background-read] ${target}: ${result.reason}`);
      failing.current = true;
    });
  }, []);

  useEffect(() => {
    setKept((prev) => (prev && prev.key !== key ? null : prev));
  }, [key]);

  useEffect(() => {
    if (!active) return;
    read();
    const beat = intervalMs ? window.setInterval(read, intervalMs) : null;
    if (onFocus) window.addEventListener("focus", read);
    return () => {
      if (beat !== null) window.clearInterval(beat);
      if (onFocus) window.removeEventListener("focus", read);
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [active, key, intervalMs, onFocus, read]);

  const fetchers = useFetchers();
  const submissions = useRef(new Set<string>());
  useEffect(() => {
    const live = new Map(fetchers.map((f) => [f.key, f]));
    for (const f of fetchers) {
      if (f.state !== "idle" && isSubmission(f.formMethod)) submissions.current.add(f.key);
    }
    let completed = false;
    for (const k of [...submissions.current]) {
      const f = live.get(k);
      if (!f || f.state === "idle") {
        submissions.current.delete(k);
        completed = true;
      }
    }
    if (completed && current.current.afterActions) read();
  }, [fetchers, read]);

  const navigation = useNavigation();
  const navigationSubmitting = useRef(false);
  useEffect(() => {
    if (navigation.state !== "idle") {
      if (isSubmission(navigation.formMethod)) navigationSubmitting.current = true;
      return;
    }
    if (!navigationSubmitting.current) return;
    navigationSubmitting.current = false;
    if (current.current.afterActions) read();
  }, [navigation.state, navigation.formMethod, read]);

  return kept && kept.key === key ? kept.data : undefined;
}
