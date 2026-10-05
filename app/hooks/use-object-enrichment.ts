/**
 * Asks the collaboration server, in the background, to fill the document's
 * external IIIF objects from their manifests (`enrich-external`). The page
 * writes none of it: the server chooses the objects from its own document and
 * fills only empty fields of an object still naming the source it read.
 *
 * The request goes once per object and source while this document is open,
 * and only once the document is the page's source (`live`), so an object whose source changes is asked about again and one whose
 * manifest cannot be read is not asked about on every render. A new document is asked
 * about from the start.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef } from "react";
import type * as Y from "yjs";
import { useSiteFetcher } from "~/lib/page-site";

type EnrichmentRow = { id: number; source_url: string | null; thumbnail: string | null };

/** `id|source` for each object with a D1 id and an external source whose thumbnail is empty. */
export function enrichmentKeys(rows: ReadonlyArray<EnrichmentRow>): string[] {
  return rows.filter((r) => r.id > 0 && r.source_url && !r.thumbnail).map((r) => `${r.id}|${r.source_url}`);
}

export function useObjectEnrichment(ydoc: Y.Doc | null, live: boolean, rows: ReadonlyArray<EnrichmentRow> | null): void {
  const fetcher = useSiteFetcher();
  const asked = useRef(new Set<string>());
  const askedFor = useRef<Y.Doc | null>(null);
  if (ydoc !== null && askedFor.current !== ydoc) {
    askedFor.current = ydoc;
    asked.current = new Set();
  }
  const unasked = live && ydoc && rows ? enrichmentKeys(rows).filter((key) => !asked.current.has(key)) : [];
  const unaskedKey = unasked.join("\n");

  useEffect(() => {
    if (fetcher.state !== "idle" || unasked.length === 0) return;
    for (const key of unasked) asked.current.add(key);
    fetcher.submit({ intent: "enrich-external" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one request per unasked set, while none is in flight
  }, [fetcher.state, unaskedKey]);
}
