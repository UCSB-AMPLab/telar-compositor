/**
 * story-order.ts — the stories list's view of `field-order.ts`.
 *
 * Stories were the first list to move its ordering off the array position and
 * onto a field, so the implementation was written here. Steps, layers, objects,
 * pages and glossary followed, and the implementation — which never read
 * anything story-shaped — moved to `field-order.ts` unchanged.
 *
 * What is left is the stories-facing spelling of that module. It exists so the
 * story call sites and their tests keep naming the thing they order
 * (`orderedStoryMaps`), rather than every list in the app importing one
 * generic name and leaving the reader to work out which array is meant.
 *
 * @version v1.5.0-beta
 */

export {
  ORDER_KEY,
  readOrderKey,
  nextOrderKeyAfterLast,
  reorderByOrderKey,
  backfillOrderKeys,
  compareByOrderKey,
  /** The stories in display order. */
  orderedMaps as orderedStoryMaps,
} from "./field-order";
