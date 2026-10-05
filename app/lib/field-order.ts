/**
 * field-order.ts — collaborative list ordering as a field on each entry.
 *
 * A Y.Array of entity Y.Maps is not positional. An entry's place in its list
 * is its `order_key` (a fractional index — see `order-key.ts`); the array
 * index is an implementation detail of how Yjs happens to hold the maps.
 *
 * Why: reordering by moving array positions means deleting the Y.Map and
 * reinserting a clone, which is byte-for-byte what a delete-and-replace attack
 * looks like, so the own-content rule needed an exemption keyed on fields any
 * collaborator can write. Writing a field instead means an honest drag removes
 * nothing from the array, the rule never fires, and two concurrent drags settle
 * as last-write-wins on two independent fields rather than as a contest over
 * array structure.
 *
 * Stories were converted first (`story-order.ts`, which is now a thin alias of
 * this module); steps, layers, objects, pages and glossary followed. Every
 * reader of one of those lists must sort through `orderedMaps` (or the D1
 * `order_key` column) rather than walking the array. `backfillOrderKeys` exists
 * because documents in the wild predate the field.
 *
 * Nothing here is story-, step- or page-specific: every function takes the
 * Y.Array it operates on, so one implementation serves a root array
 * (`objects`) and a nested one (a step's `layers`) alike.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import {
  generateDistinctKeyBetween,
  generateKeyBetween,
  isValidOrderKey,
} from "./order-key";

/** The Y.Map key and the D1 column both carry this name, for every entity. */
export const ORDER_KEY = "order_key";

/** An entry's key, or null when it is absent or degenerate. */
export function readOrderKey(yMap: Y.Map<unknown>): string | null {
  const value = yMap.get(ORDER_KEY);
  return isValidOrderKey(value) ? value : null;
}

/**
 * The entries in display order.
 *
 * The comparator is a total order on `(order_key ?? "", array index)`: a key
 * always beats no key, equal keys fall back to array position, and the sort is
 * stable, so a document with no keys at all degenerates to exactly the array
 * order every pre-conversion reader used. That property is what lets the
 * backfill repair a legacy document without moving anything the user could see.
 */
export function orderedMaps(container: unknown): Y.Map<unknown>[] {
  return orderedEntries(container).maps;
}

/**
 * The same list, plus the positions this refused to read.
 *
 * A caller that reconciles against D1 needs both. Guarding a container with
 * `instanceof Y.Array` does not guard its members — Yjs stores plain JSON at an
 * array position as readily as at a map key, so a genuine `Y.Array` can hold
 * `{}`, and `readOrderKey` calling `.get()` on it is a `TypeError` thrown
 * inside whatever batch the caller is in. Dropping the member silently is the
 * wrong repair on its own: an element the server cannot read may be carrying
 * the `_id` of a live D1 row, and a reconciler that does not know it was there
 * reads that row as an orphan and deletes it. So the positions come back too,
 * and a reconciler that sees any of them leaves its table alone.
 *
 * Total: `container` is `unknown` because the key it came from is
 * client-writable, and a story's `steps` is as likely to hold a plain object as
 * a `Y.Array`. Nothing here throws on any input.
 */
export function orderedEntries(
  container: unknown,
): { maps: Y.Map<unknown>[]; skipped: number[] } {
  if (!(container instanceof Y.Array)) return { maps: [], skipped: [] };
  const skipped: number[] = [];
  const withIndex: { yMap: Y.Map<unknown>; index: number; key: string }[] = [];
  container.toArray().forEach((member, index) => {
    if (!(member instanceof Y.Map)) {
      skipped.push(index);
      return;
    }
    withIndex.push({ yMap: member, index, key: readOrderKey(member) ?? "" });
  });
  withIndex.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
  return { maps: withIndex.map((entry) => entry.yMap), skipped };
}

/** A key that sorts after every entry currently in the list. */
export function nextOrderKeyAfterLast(yArray: Y.Array<Y.Map<unknown>>): string {
  const ordered = orderedMaps(yArray);
  const last = ordered.length > 0 ? readOrderKey(ordered[ordered.length - 1]) : null;
  return generateDistinctKeyBetween(last, null);
}

/**
 * Give the entries of an already-sorted list a strictly ascending sequence of
 * canonical keys, preserving the order they are presented in. Returns how many
 * were written; 0 means every key was already canonical and ahead of the one
 * before it.
 *
 * A repair is bounded above by the next key that is already ahead of the
 * sequence so far, so it stays inside the broken run: an entry whose key is
 * missing or duplicated gets one between its neighbours, and an entry that
 * was already well placed is neither rewritten nor stepped over. Bounding is
 * what makes this safe to run mid-session — the only fields it can touch are
 * fields that are already degenerate, so it cannot overwrite a healthy
 * entry's place, and it cannot cascade from one broken entry through the rest
 * of the list.
 *
 * The keys are deterministic (`generateKeyBetween`, not the jittered mint):
 * two clients repairing the same broken list from the same document should
 * arrive at the same keys, and agreeing is the whole point of a repair.
 */
function healOrderKeys(ordered: Y.Map<unknown>[]): number {
  const keys = ordered.map(readOrderKey);
  let previous: string | null = null;
  let written = 0;

  for (let i = 0; i < ordered.length; i++) {
    const current = keys[i];
    if (current !== null && (previous === null || current > previous)) {
      previous = current;
      continue;
    }
    let upper: string | null = null;
    for (let j = i + 1; j < ordered.length; j++) {
      const candidate = keys[j];
      if (candidate !== null && (previous === null || candidate > previous)) {
        upper = candidate;
        break;
      }
    }
    const next = generateKeyBetween(previous, upper);
    ordered[i].set(ORDER_KEY, next);
    keys[i] = next;
    previous = next;
    written += 1;
  }

  return written;
}

/**
 * Move the entry at display index `oldIndex` to display index `newIndex` by
 * writing its `order_key`. Nothing is removed from, or inserted into, the
 * Y.Array — that is the whole point.
 *
 * `newIndex` is the destination in the list AFTER the move, matching dnd-kit's
 * `arrayMove` convention, so the new neighbours are the entries either side of
 * that slot once the moved entry is taken out.
 *
 * The list is repaired before the drop is computed, because a gap between two
 * equal keys has no key inside it and a drop aimed there would otherwise have
 * to land somewhere else. Repairing is order-preserving, so the indices the
 * caller worked out from what the user could see still name the same entries.
 *
 * Must be called inside a `ydoc.transact()` block.
 */
export function reorderByOrderKey(
  yArray: Y.Array<Y.Map<unknown>>,
  oldIndex: number,
  newIndex: number,
): void {
  if (oldIndex === newIndex) return;
  const ordered = orderedMaps(yArray);
  if (oldIndex < 0 || oldIndex >= ordered.length) return;
  if (newIndex < 0 || newIndex >= ordered.length) return;

  healOrderKeys(ordered);

  const moved = ordered[oldIndex];
  const remaining = ordered.filter((_, i) => i !== oldIndex);
  const before = newIndex > 0 ? readOrderKey(remaining[newIndex - 1]) : null;
  const after = newIndex < remaining.length ? readOrderKey(remaining[newIndex]) : null;

  let key: string;
  try {
    key = generateDistinctKeyBetween(before, after);
  } catch {
    // Unreachable: the repair above leaves every key canonical and strictly
    // ascending, so two neighbours can never be equal or reversed. If it is
    // ever reached the invariant is broken, and leaving the entry where it is
    // is the only honest answer — a drag that silently lands somewhere the
    // user did not aim at is worse than one that does nothing.
    return;
  }
  moved.set(ORDER_KEY, key);
}

/**
 * Put `wanted` in the order given by writing `order_key`s, and answer how many
 * keys were written. `ordered` is the whole list in display order; `wanted`
 * is a subset of it. Must be called inside a `ydoc.transact()` block.
 *
 * The list is healed first, as a drag heals it (`healOrderKeys`), and the
 * heal's writes are counted. The slots the wanted entries occupy are then
 * filled with them in the order given, and every other entry keeps its slot,
 * so an entry only the caller does not name stays between the same
 * neighbours. Of the resulting sequence, the longest run whose keys already
 * ascend keeps them; each other entry, left to right, gets a key between the
 * entry before it and the next entry that keeps its key. The fewest entries
 * move, and nothing is written when the order already holds.
 */
export function rekeyToOrder(ordered: Y.Map<unknown>[], wanted: Y.Map<unknown>[]): number {
  let written = healOrderKeys(ordered);
  const wantedSet = new Set(wanted);
  const target = [...ordered];
  let next = 0;
  for (let i = 0; i < target.length; i++) {
    if (wantedSet.has(target[i])) target[i] = wanted[next++];
  }
  const kept = ascendingRun(target.map((m) => readOrderKey(m) ?? ""));
  let previous: string | null = null;
  for (let i = 0; i < target.length; i++) {
    if (kept.has(i)) {
      previous = readOrderKey(target[i]);
      continue;
    }
    const key = generateDistinctKeyBetween(previous, nextKeptKey(target, kept, i));
    target[i].set(ORDER_KEY, key);
    previous = key;
    written += 1;
  }
  return written;
}

/** The key of the first entry after `i` whose index is in `kept`, or null. */
function nextKeptKey(target: Y.Map<unknown>[], kept: Set<number>, i: number): string | null {
  for (let j = i + 1; j < target.length; j++) {
    if (kept.has(j)) return readOrderKey(target[j]);
  }
  return null;
}

/**
 * The indices of a longest strictly ascending subsequence of `keys`
 * (patience sorting: O(n log n)).
 */
function ascendingRun(keys: string[]): Set<number> {
  const tails: number[] = [];
  const before: number[] = new Array(keys.length).fill(-1);
  keys.forEach((key, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[tails[mid]] < key) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) before[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const run = new Set<number>();
  for (let at = tails.length > 0 ? tails[tails.length - 1] : -1; at >= 0; at = before[at]) run.add(at);
  return run;
}

/** One row of GitHub's objects.csv, as an ingest names it: a held row by its D1 id, a new one without. */
export interface SheetEntry {
  objectId: string;
  docId?: number;
}

/**
 * A key for the row at `sheet[at]`, which the caller is bringing in: between
 * the nearest entry before it in `sheet` that the list holds and the nearest
 * one after it. `held` answers which entry of the list a sheet entry is, or
 * null. With no held neighbour on either side, the key sorts after every entry
 * (`nextOrderKeyAfterLast`). Where the two bounds are out of order in the
 * list, the upper one is replaced by the entry after the lower one, so the row
 * lands right after the row GitHub has before it.
 */
export function orderKeyForSheetPlace(
  yArray: Y.Array<Y.Map<unknown>>,
  sheet: readonly SheetEntry[],
  at: number,
  held: (entry: SheetEntry) => Y.Map<unknown> | null,
): string {
  const heldKey = (i: number): string | null => {
    const m = held(sheet[i]);
    return m ? readOrderKey(m) : null;
  };
  let lower: string | null = null;
  for (let i = at - 1; i >= 0 && lower === null; i--) lower = heldKey(i);
  let upper: string | null = null;
  for (let i = at + 1; i < sheet.length && upper === null; i++) upper = heldKey(i);
  if (lower === null && upper === null) return nextOrderKeyAfterLast(yArray);
  if (lower !== null && upper !== null && lower >= upper) upper = keyAfter(yArray, lower);
  return generateDistinctKeyBetween(lower, upper);
}

/** The key of the first entry whose key sorts after `key`, or null. */
function keyAfter(yArray: Y.Array<Y.Map<unknown>>, key: string): string | null {
  for (const m of orderedMaps(yArray)) {
    const candidate = readOrderKey(m);
    if (candidate !== null && candidate > key) return candidate;
  }
  return null;
}

/**
 * Give every entry a canonical, distinct `order_key`, preserving the order the
 * list currently presents. Returns how many entries were written; 0 means the
 * list was already healthy and nothing was touched.
 *
 * Documents in the wild carry ordering in the array position and, for some
 * entities, an integer rank (`order`, `step_number`, `layer_number`) that may
 * be absent, duplicated or all zero. The repair deliberately ignores that
 * integer and takes the order from `orderedMaps`, which for a key-less list IS
 * the array order — the only order those documents ever presented, and the one
 * the pre-conversion snapshot wrote to D1.
 *
 * The healthy case writes nothing, so a list that has been reordered since
 * conversion is never dragged back into array order.
 *
 * This is the whole-document sweep the Durable Object runs once, on load. It
 * is not the only place the repair happens: `reorderByOrderKey` runs the same
 * one on every drag, which is what keeps a live session from carrying a
 * duplicate until its next reload. A duplicate does no harm until somebody
 * drops into the gap it occupies, so repairing at the drop covers the whole
 * of the exposure without a sweep on a timer competing with live edits.
 *
 * Must be called inside a `ydoc.transact()` block.
 */
export function backfillOrderKeys(yArray: Y.Array<Y.Map<unknown>>): number {
  return healOrderKeys(orderedMaps(yArray));
}

/**
 * Comparator for a plain list of already-extracted rows that carry their key
 * alongside the array index they were read at. The client list components hold
 * plain objects rather than Y.Maps, and every one of them needs exactly this
 * total order — key first, array index as the tie-break that keeps a
 * pre-backfill document in the order it always presented.
 */
export function compareByOrderKey(
  a: { _orderKey?: string | null; _yIndex?: number },
  b: { _orderKey?: string | null; _yIndex?: number },
): number {
  const ka = a._orderKey ?? "";
  const kb = b._orderKey ?? "";
  if (ka !== kb) return ka < kb ? -1 : 1;
  return (a._yIndex ?? 0) - (b._yIndex ?? 0);
}
