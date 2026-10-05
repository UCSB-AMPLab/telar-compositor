/**
 * This file asks the server for an object's current manifest thumbnail and
 * writes it into the live document. The document is what the next snapshot writes to D1, so a
 * thumbnail stored only in D1 is overwritten by the one the document still
 * holds.
 *
 * @version v1.5.0-beta
 */

import { useEffect } from "react";
import { useFetcher } from "react-router";
import type * as Y from "yjs";
import { findYMapById } from "~/lib/yjs-helpers";

/** Whether the document held an entry for the object and took the new thumbnail. */
export function writeObjectThumbnail(ydoc: Y.Doc | null, objectDbId: number, thumbnail: string): boolean {
  const entry = ydoc ? findYMapById(ydoc.getArray<Y.Map<unknown>>("objects"), objectDbId) : null;
  if (!ydoc || !entry) return false;
  ydoc.transact(() => entry.set("thumbnail", thumbnail));
  return true;
}

/**
 * Asks `/api/object-thumbnail` for `object` with the fields `onFailed` gives
 * (nothing is asked when it gives none), and hands the thumbnail the server
 * answered to `onRefreshed`. Returns the function that asks.
 */
export function useThumbnailRefresh<T>(
  object: T,
  onFailed?: (object: T) => Record<string, string> | null | void,
  onRefreshed?: (object: T, thumbnail: string) => void,
): () => void {
  const fetcher = useFetcher<{ thumbnail?: string }>();
  const answered = fetcher.data?.thumbnail;
  useEffect(() => {
    if (answered) onRefreshed?.(object, answered);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one call per answer
  }, [answered]);
  return () => {
    const fields = onFailed?.(object);
    if (fields) fetcher.submit(fields, { method: "post", action: "/api/object-thumbnail" });
  };
}
