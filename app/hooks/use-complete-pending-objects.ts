/**
 * use-complete-pending-objects — asks the server, once per visit to the
 * Objects page, to finish the objects operations still owed.
 *
 * Objects whose registration failed after the tab closed stay out of the list
 * until the next publish, and an author who does not see them may upload the
 * same images again. So a page whose loader counted pending records, for
 * someone who can publish, posts one `complete-pending-objects`. Once per
 * mount: the answer revalidates the loader, and a record the server kept would
 * otherwise post again on every revalidation. Never while a request of this
 * fetcher is in flight. The answer is not read; the server is silent either
 * way, and the revalidated list shows whatever it completed.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef } from "react";
import { useSiteFetcher } from "~/lib/page-site";

export function useCompletePendingObjects(pendingCount: number, canPublish: boolean): void {
  const fetcher = useSiteFetcher();
  const posted = useRef(false);

  useEffect(() => {
    if (posted.current || !canPublish || pendingCount <= 0 || fetcher.state !== "idle") return;
    posted.current = true;
    fetcher.submit({ intent: "complete-pending-objects" }, { method: "post" });
  }, [pendingCount, canPublish, fetcher.state, fetcher.submit]);
}
