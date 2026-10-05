/**
 * Asks the deployed site, in the background, whether the document's
 * self-hosted images have their tiles, those not yet ready first, and writes the
 * ones that answered, and the ones the site definitely lacks, into the
 * document. A 404 takes an object off ready only once the same site has
 * answered 2xx for some object since this document opened, in that read or an
 * earlier one; until then the object is asked about again like any other left
 * out. Reads ask about at most `TILE_PROBE_LIMIT` objects, one read at a time; an object a read did not answer ready, or every
 * object of a read that failed, is asked about again after
 * `TILE_PROBE_RETRY_MS`. A new document is asked about from the start.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { useSiteFetcher } from "~/lib/page-site";
import { TILE_PROBE_LIMIT, TILE_PROBE_RETRY_MS, markTilesReady, tileProbeCandidates } from "~/lib/tile-readiness";

type ProbeAnswer = { ok: true; intent: "probe-tiles"; site?: string | null; ready: string[]; notFound?: string[] } | { ok: false } | undefined;

/** The ids a probe answer marks ready: none for an answer that is not the probe's. */
function answeredReady(answer: ProbeAnswer): string[] {
  return answer?.ok && answer.intent === "probe-tiles" ? answer.ready : [];
}

/** The ids a probe answer got a 404 for: none for an answer that is not the probe's. */
function answeredNotFound(answer: ProbeAnswer): string[] {
  return answer?.ok && answer.intent === "probe-tiles" ? (answer.notFound ?? []) : [];
}

/** The site a probe answer asked: none for an answer that asked no site, or is not the probe's. */
function answeredSite(answer: ProbeAnswer): string | null {
  return answer?.ok && answer.intent === "probe-tiles" ? (answer.site ?? null) : null;
}

export function useTileReadiness(
  ydoc: Y.Doc | null,
  rows: ReadonlyArray<{ object_id: string; source_url: string | null; image_available: boolean | null }> | null,
): void {
  const fetcher = useSiteFetcher<ProbeAnswer>();
  const [, setRetries] = useState(0);
  const asked = useRef(new Set<string>());
  const askedFor = useRef<Y.Doc | null>(ydoc);
  const batch = useRef<string[]>([]);
  const sitesAnswered = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  if (askedFor.current !== ydoc) {
    askedFor.current = ydoc;
    asked.current = new Set();
    sitesAnswered.current = new Set();
  }
  const unasked = rows ? tileProbeCandidates(rows).filter((id) => !asked.current.has(id)) : [];
  const unaskedKey = unasked.join("\n");

  // An answer is read against `batch`, the ids that asked it. This effect is
  // declared before the one that submits, so it runs first in the render where
  // the fetcher settles, before the next submission replaces `batch`.
  const answer = fetcher.data;
  useEffect(() => {
    if (answer === undefined) return;
    const ready = answeredReady(answer);
    const site = answeredSite(answer);
    if (site !== null && ready.length > 0) sitesAnswered.current.add(site);
    markTilesReady(ydoc, ready, site !== null && sitesAnswered.current.has(site) ? answeredNotFound(answer) : []);
    const leftOut = batch.current.filter((id) => !ready.includes(id));
    if (leftOut.length === 0) return;
    const doc = ydoc;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      if (askedFor.current === doc) for (const id of leftOut) asked.current.delete(id);
      setRetries((n) => n + 1);
    }, TILE_PROBE_RETRY_MS);
    timers.current.add(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one write per answer
  }, [answer]);

  useEffect(() => {
    if (!ydoc || fetcher.state !== "idle" || unasked.length === 0) return;
    batch.current = unasked.slice(0, TILE_PROBE_LIMIT);
    for (const id of batch.current) asked.current.add(id);
    fetcher.submit({ intent: "probe-tiles", objectIds: JSON.stringify(batch.current) }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read per unasked set, while none is in flight
  }, [ydoc, fetcher.state, unaskedKey]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);
}
