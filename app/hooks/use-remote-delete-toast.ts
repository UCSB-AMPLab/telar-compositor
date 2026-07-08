/**
 * use-remote-delete-toast — flashes a "{label} was deleted" toast when an
 * item disappears from a Yjs-backed list because a remote collaborator
 * removed it.
 *
 * The list routes (Objects, Stories, Pages) each render a Y.Array-backed
 * collection. When a peer deletes an entry, the local client sees the item
 * simply vanish from its next render. This hook watches for that: it keeps a
 * map of key -> label from the previous render and, on each change, reports
 * any key that was present before and is now gone as a deletion.
 *
 * Keys come from the shared `keyFor` helper (see ~/lib/item-key), which keys
 * on `_tempId` first so a key stays stable when the collaboration worker's
 * snapshotToD1 cycle backfills the numeric D1 id after creation. An id-first
 * key would flip at backfill and read as a false deletion — the exact bug this
 * hook is careful to avoid.
 *
 * Why the toast stays generic and button-less, once, here instead of in three
 * copies:
 *   - Generic attribution: a Y.Array delete carries no actor, and awareness
 *     only tells us who is connected — not who deleted. Naming a collaborator
 *     would misattribute the action, so the message is the actor-free
 *     `toast_item_deleted_generic` ("{label} was deleted").
 *   - No Undo affordance: a remote delete has no local undo path (the shared
 *     UndoManager tracks only local origins), so a button wired to it would be
 *     a no-op. We omit it rather than render dead UI; the TabNav Undo control
 *     is the authoritative path where one exists.
 *
 * Extracted from the three list routes, whose delete-detection effects were
 * behaviourally identical, to remove the drift risk of three hand-kept copies
 * and to make the behaviour render-testable in isolation (the logic used to
 * live inline in route modules that break vitest suite collection when
 * imported). See tests/use-remote-delete-toast.test.tsx.
 *
 * @version v1.4.2-beta
 */

import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "~/hooks/use-toast";
import { keyFor, type YjsItemLike } from "~/lib/item-key";

export interface UseRemoteDeleteToastOptions<T extends YjsItemLike> {
  /** The current display list. Keys are derived internally via `keyFor`. */
  items: T[];
  /**
   * Whether detection is active. Mirrors each route's `useYjs` flag — before
   * the collaboration socket connects there is no canonical Y.Array to watch,
   * so detection stays off and the previous-keys map is not advanced.
   */
  enabled: boolean;
  /** Last-known label for a deleted item — shown in the toast message. */
  getLabel: (item: T) => string;
  /**
   * Optional suppression flag. When its `.current` is true at the moment a
   * disappearance is detected, no toast fires. The Stories route sets this
   * during a drag-reorder as belt-and-braces: its reorder replaces the moved
   * item with a clone, but the clone copies `_temp_id`/`_id`, so keyFor keeps
   * the same key and the swap does not actually read as a deletion under the
   * shared tempId-first keying. The flag is retained from before that keying,
   * when the clone did churn the key — it is not load-bearing today. The
   * previous-keys map is still advanced while suppressed, so the next render
   * compares against the post-reorder keys.
   */
  suppressRef?: RefObject<boolean>;
}

/**
 * Watches a Yjs-backed list for remotely-deleted items and fires one generic,
 * button-less destructive toast per disappearance. Safe to call with an empty
 * list or `enabled: false` — it simply does nothing.
 */
export function useRemoteDeleteToast<T extends YjsItemLike>({
  items,
  enabled,
  getLabel,
  suppressRef,
}: UseRemoteDeleteToastOptions<T>): void {
  const { showToast } = useToast();
  const { t: tStructural } = useTranslation("structural");
  const prevLabelsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    const curr = new Map<string, string>();
    for (const item of items) curr.set(keyFor(item), getLabel(item));
    const deleted: string[] = [];
    prevLabelsRef.current.forEach((label, key) => {
      if (!curr.has(key)) deleted.push(label);
    });
    prevLabelsRef.current = curr;
    if (deleted.length === 0) return;
    // Suppress after advancing the map (e.g. during a reorder clone) so we
    // don't fire on an identity churn that isn't a real deletion.
    if (suppressRef?.current) return;
    for (const label of deleted) {
      showToast({
        message: tStructural("toast_item_deleted_generic", { label }),
        type: "destructive",
      });
    }
    // getLabel/suppressRef are intentionally excluded: routes pass inline
    // closures, and detection must run on list/enabled changes only — not on
    // every render. Matches the pre-extraction inline-effect deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, enabled]);
}
