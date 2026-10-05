/**
 * Placing the steps a kept-columns capture inserts (`steps.captureKeptColumns`):
 * rows of a story CSV the Compositor never had, each put after the
 * step it names in the story's live order.
 *
 * A step's place is its `order_key` (`~/lib/field-order`), so an insert is
 * placed by minting a key strictly between the step it follows and the one
 * after it. Inserts after one step each take the key minted before them as
 * their lower bound, so they keep the order they were given in. Where some
 * bound is unusable (a step with no valid key, or two equal keys), the story's
 * steps are re-keyed first, in their live order, as the load's repair does
 * (`backfillOrderKeys`): the order the capture's `expected` hash was taken
 * on is the order kept.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";
import { ORDER_KEY, backfillOrderKeys, readOrderKey } from "~/lib/field-order";
import { generateDistinctKeyBetween } from "~/lib/order-key";

/** A step map to insert, and the live step it follows (null: first). */
export interface PlacedStep {
  after: Y.Map<unknown> | null;
  map: Y.Map<unknown>;
}

/** The step after `after` in `order`, the first when `after` is null, or null at the end. */
function stepAfter(order: readonly Y.Map<unknown>[], after: Y.Map<unknown> | null): Y.Map<unknown> | null {
  const next = after === null ? 0 : order.indexOf(after) + 1;
  return order[next] ?? null;
}

/** Whether a key can be minted between `after` and the step that follows it. */
function boundsUsable(order: readonly Y.Map<unknown>[], after: Y.Map<unknown> | null): boolean {
  const lower = after === null ? null : readOrderKey(after);
  if (after !== null && lower === null) return false;
  const next = stepAfter(order, after);
  if (next === null) return true;
  const upper = readOrderKey(next);
  return upper !== null && (lower === null || lower < upper);
}

/**
 * Pushes each map onto `stepsArray` with a key that places it after its step
 * in `order`, the story's live order. Runs inside the caller's transaction.
 */
export function placeCapturedSteps(
  stepsArray: Y.Array<Y.Map<unknown>>,
  order: readonly Y.Map<unknown>[],
  placed: readonly PlacedStep[],
): void {
  if (placed.some(({ after }) => !boundsUsable(order, after))) backfillOrderKeys(stepsArray);
  const minted = new Map<Y.Map<unknown> | null, string>();
  for (const { after, map } of placed) {
    const lower = minted.get(after) ?? (after === null ? null : readOrderKey(after));
    const next = stepAfter(order, after);
    const key = generateDistinctKeyBetween(lower, next === null ? null : readOrderKey(next));
    minted.set(after, key);
    map.set(ORDER_KEY, key);
    stepsArray.push([map]);
  }
}
