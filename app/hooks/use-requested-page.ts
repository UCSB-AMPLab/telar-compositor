/**
 * useRequestedPage — opens the page a link names.
 *
 * Another surface links to one page's editor as `/pages?page=<slug>`. The
 * Pages screen reads its rows from the loader first and from the shared
 * document once that has synced, and the switch between the two resets the
 * selection (to Home while the document is still empty, then to the last row
 * when its rows arrive). So the selection is made once for each source of
 * rows, `source`, as soon as a row with that slug is among them: the
 * document's rows take it again after the loader's did, and an author who
 * picks another page after that is not pulled back.
 *
 * @version v1.5.5-beta
 */
import { useEffect, useRef } from "react";

export function useRequestedPage<P extends { slug?: string | null }>(
  requestedSlug: string | null,
  pages: readonly P[],
  source: string,
  select: (page: P) => void,
): void {
  const appliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedSlug || appliedFor.current === source) return;
    const page = pages.find((p) => (p.slug ?? "") === requestedSlug);
    if (!page) return;
    appliedFor.current = source;
    select(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, requestedSlug, source]);
}
