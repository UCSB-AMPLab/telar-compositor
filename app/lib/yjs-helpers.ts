/**
 * yjs-helpers — shared utility functions for Yjs document operations.
 *
 * These helpers keep route and component code concise when navigating
 * the Y.Doc structure (find by _id, get Y.Text from Y.Map, etc.).
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
