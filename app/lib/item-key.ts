/**
 * This file holds the helper that derives a stable React/dnd-kit key for
 * any Yjs-backed list item (pages, stories, objects) that has both a
 * numeric D1 `id` and a client-generated `_tempId`. The single source of
 * truth for list-keying across every editor route — inlining the logic
 * is what caused the false-deletion bug that prompted this extraction.
 *
 * Why `_tempId` is preferred over `id`: a freshly-created item starts
 * with `id: 0` (or null) and a UUID `_tempId`. The collaboration
 * worker's snapshotToD1 cycle eventually backfills the real D1 row id
 * (~30s after creation, see `workers/collaboration.ts:1408`). If the
 * React key is derived from `id`, that key changes mid-render when the
 * backfill arrives. Any observer that compares prev/curr key sets — e.g.
 * the deletion-detection effect at `_app.pages.tsx` and
 * `_app.stories.tsx` — interprets the disappearance of the old key as
 * a remote deletion and fires a false "deleted" toast, taking the editor
 * back to the previously-selected item.
 *
 * `_tempId` is set once at creation and never changes for the lifetime
 * of the YMap, so keying on it is stable across the backfill. Items
 * loaded from D1 have `_tempId: null`; for those we fall back to the
 * numeric `id`, and finally to a `_yIndex`-based string for the rare
 * unidentified case.
 *
 * This helper was previously inlined in both `_app.pages.tsx` (fixed at
 * commit `a318a45`) and `_app.stories.tsx`. Sharing the implementation
 * prevents drift.
 *
 * @version v1.2.0-beta
 */

export interface YjsItemLike {
  id: number;
  _tempId?: string | null;
  _yIndex?: number;
}

export function keyFor(item: YjsItemLike): string {
  if (item._tempId) return item._tempId;
  if (item.id > 0) return String(item.id);
  return `idx-${item._yIndex ?? 0}`;
}
