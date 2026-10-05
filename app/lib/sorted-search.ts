/**
 * Binary search over a sorted list of offsets, for the readers that find the
 * next close, closing tag or closing line once instead of searching the rest
 * of a text again from every opening.
 *
 * @version v1.5.0-beta
 */

/** The index of the first element of the sorted `values` that is at least `target`. */
export function firstAtLeast(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
