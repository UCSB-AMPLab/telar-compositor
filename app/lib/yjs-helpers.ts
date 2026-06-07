/**
 * This file holds the shared utility helpers for navigating and mutating Yjs
 * document structures — finding entries by `_id` or `_temp_id`, reading
 * `Y.Text` values from `Y.Map`, reordering navigation arrays, and sanitising
 * the navigation array against legacy corruption. Route and component code
 * pulls from here so the Y.Doc-walking logic lives in one place instead of
 * being inlined everywhere a loader or hook needs it.
 *
 * @version v1.3.0-beta
 */

import * as Y from "yjs";

/**
 * findYMapById — find a Y.Map in a Y.Array by matching its "_id" key.
 *
 * Returns the first entry where `item.get("_id") === id`, or null if not found.
 * Used by all editing routes to locate the Y.Map for a specific entity.
 *
 * @param yArray  The Y.Array of Y.Maps to search.
 * @param id      The integer D1 row id to match.
 */
export function findYMapById(
  yArray: Y.Array<Y.Map<unknown>>,
  id: number
): Y.Map<unknown> | null {
  for (let i = 0; i < yArray.length; i++) {
    const item = yArray.get(i);
    if (item.get("_id") === id) return item;
  }
  return null;
}

/**
 * getYText — safely retrieve a Y.Text from a Y.Map.
 *
 * Returns null if the map is null or if the field value is not a Y.Text instance.
 * Callers can pass the result directly to useCollaborativeText without null checks.
 *
 * @param yMap      The Y.Map containing the field.
 * @param fieldName The key of the Y.Text field.
 */
export function getYText(
  yMap: Y.Map<unknown> | null,
  fieldName: string
): Y.Text | null {
  if (!yMap) return null;
  const val = yMap.get(fieldName);
  return val instanceof Y.Text ? val : null;
}

/**
 * isPersistableLayerId — true only when `id` is a positive integer, i.e. a
 * real D1 row that an `UPDATE ... WHERE id = ?` could actually persist to.
 *
 * A Yjs-only layer that has not yet been snapshotted to D1 carries
 * `_id = null`, which the story loader coerces to `0`
 * (`_app.stories.$storyId.tsx`). Posting `layerId = 0` to the autosave action
 * trips its `resolveLayerProjectId` 400 guard, and the unawaited fetcher
 * rejection surfaces in the in-app bug reporter. Callers use this to skip
 * the D1 autosave fallback for ids that can never persist —
 * persistence for such layers is the snapshot's job, not the fallback's.
 */
export function isPersistableLayerId(id: unknown): boolean {
  const n = Number(id);
  return Number.isInteger(n) && n > 0;
}

/**
 * findYMapByIdOrTempId — find a Y.Map by D1 `_id` or fallback `_temp_id`.
 *
 * Newly-added items in the Y.Doc carry `_id: null` until the next snapshotToD1
 * cycle backfills a D1 row id. During that window the stable UI key is the
 * client-generated `_temp_id` (UUID). This helper accepts either and returns
 * the first match, or null.
 *
 * @param yArray The Y.Array of Y.Maps to search.
 * @param id     The integer D1 row id to match, or null.
 * @param tempId The UUID assigned at creation time, or null.
 */
export function findYMapByIdOrTempId(
  yArray: Y.Array<Y.Map<unknown>>,
  id: number | null,
  tempId: string | null
): Y.Map<unknown> | null {
  for (let i = 0; i < yArray.length; i++) {
    const item = yArray.get(i);
    if (id !== null && item.get("_id") === id) return item;
    if (tempId !== null && item.get("_temp_id") === tempId) return item;
  }
  return null;
}

/**
 * findYMapIndex — find the current index of a Y.Map in a Y.Array.
 *
 * Returns -1 if not found. Critical for delete/reorder operations — the
 * caller should resolve the index fresh inside `ydoc.transact()` because
 * concurrent operations may shift positions.
 *
 * @param yArray The Y.Array of Y.Maps to search.
 * @param id     The integer D1 row id to match, or null.
 * @param tempId The UUID assigned at creation time, or null.
 */
export function findYMapIndex(
  yArray: Y.Array<Y.Map<unknown>>,
  id: number | null,
  tempId: string | null
): number {
  for (let i = 0; i < yArray.length; i++) {
    const item = yArray.get(i);
    if (id !== null && item.get("_id") === id) return i;
    if (tempId !== null && item.get("_temp_id") === tempId) return i;
  }
  return -1;
}

/**
 * reorderNavArray — reorder an entry in the project's `config.navigation`
 * Y.Array.
 *
 * The navigation array is unique among the project's Y.Arrays in that its
 * entries are plain JSON objects (`{type, slug, label, visible, ...}`),
 * never `Y.Map`s — see `workers/collaboration.ts` (server seed) and
 * `app/routes/_app.pages.tsx` (client inserts), which both `push` plain
 * objects. Yjs treats plain JSON values as immutable, so a simple
 * delete + reinsert of the original reference is safe and avoids the
 * tombstone issues that affect Y.Map reorders.
 *
 * Defensive: if a Y.Map ever ends up in the navigation array (legacy data
 * or future migration), we deep-clone via the same idiom as
 * `cloneYMap` in `use-structural-ops.ts` rather than reuse the reference,
 * which would re-attach a deleted node.
 *
 * Must be called inside a `ydoc.transact()` block. No-ops on identical
 * indices or out-of-range arguments.
 *
 * @param navArray The `config.navigation` Y.Array.
 * @param oldIndex The current index of the entry being moved.
 * @param newIndex The target index in the post-move array.
 */
export function reorderNavArray(
  navArray: Y.Array<unknown>,
  oldIndex: number,
  newIndex: number
): void {
  if (oldIndex === newIndex) return;
  if (oldIndex < 0 || oldIndex >= navArray.length) return;
  if (newIndex < 0 || newIndex >= navArray.length) return;

  const source = navArray.get(oldIndex);
  let entry: unknown;
  if (source instanceof Y.Map) {
    // Defensive clone path — not exercised today (nav entries are plain
    // objects) but kept so a future schema change doesn't silently corrupt.
    const clone = new Y.Map<unknown>();
    for (const [key, value] of source.entries()) {
      clone.set(key, value instanceof Y.Text ? new Y.Text(value.toString()) : value);
    }
    entry = clone;
  } else {
    // Plain JSON object — Yjs allows reuse of the same reference across
    // delete + insert because the value is immutable. This mirrors the
    // working pattern in `app/components/features/config/NavigationEditor.tsx`.
    entry = source;
  }

  navArray.delete(oldIndex, 1);
  navArray.insert(newIndex, [entry]);
}

/**
 * sanitizeNavArray — filter and (optionally) repair `config.navigation`.
 *
 * Defends against corrupted entries from an earlier broken deploy of the
 * pages-tab reorder fix (commit f94282c) where `handleNavDragEnd` inserted
 * empty `Y.Map`s in place of the dragged page record. Once snapshotToD1
 * persisted those broken entries, every later read returns nav items with
 * undefined `type`/`slug`/`key`, which the render path silently drops —
 * leaving the nav bar empty.
 *
 * Returns the filtered list of plain `NavItemLike` records (suitable to feed
 * directly to React state). When `mutate` is true and at least one entry was
 * dropped, also rewrites `navArray` inside a `ydoc.transact()` so the next
 * snapshot persists the cleaned shape — self-healing for any project that
 * loaded the broken version of the editor.
 *
 * Validity rules (must satisfy ALL):
 *   - The entry is a plain JSON object (NOT a `Y.Map`)
 *   - `type` is one of `"page"`, `"builtin"`, `"external"`
 *   - For `type === "page"`: `slug` is a non-empty string
 *   - For `type === "builtin"`: `key` is a non-empty string
 *   - For `type === "external"`: `url` (or `label` as last-resort fallback) is non-empty
 */
export interface NavItemLike {
  type: "page" | "builtin" | "external";
  key?: string;
  slug?: string;
  label?: string;
  visible?: boolean;
  url?: string;
}

export function sanitizeNavArray(
  navArray: Y.Array<unknown>,
  options: { mutate?: boolean; ydoc?: Y.Doc } = {}
): { items: NavItemLike[]; dropped: number } {
  const raw = navArray.toArray();
  const items: NavItemLike[] = [];

  for (const entry of raw) {
    // Drop Y.Maps — production navArray holds only plain JSON objects;
    // any Y.Map that slipped in is corruption from the f94282c regression.
    if (entry instanceof Y.Map) continue;
    if (entry === null || typeof entry !== "object") continue;

    const item = entry as Record<string, unknown>;
    const type = item.type;
    if (type !== "page" && type !== "builtin" && type !== "external") continue;

    if (type === "page") {
      if (typeof item.slug !== "string" || item.slug.length === 0) continue;
    } else if (type === "builtin") {
      if (typeof item.key !== "string" || item.key.length === 0) continue;
    } else if (type === "external") {
      const url = typeof item.url === "string" ? item.url : "";
      const label = typeof item.label === "string" ? item.label : "";
      if (url.length === 0 && label.length === 0) continue;
    }

    items.push(item as unknown as NavItemLike);
  }

  const dropped = raw.length - items.length;

  if (dropped > 0 && options.mutate && options.ydoc) {
    options.ydoc.transact(() => {
      navArray.delete(0, navArray.length);
      navArray.insert(0, items as unknown[]);
    });
  }

  return { items, dropped };
}
