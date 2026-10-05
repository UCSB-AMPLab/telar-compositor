/**
 * Aligning a list the document holds with the list a sync accepts, by content.
 *
 * Used by `/ingest-sync`'s `stories.replaceContent` arm for a story's steps
 * and, within each step kept or updated, for its layers. Matching by position
 * or by step number moves authorship onto the wrong content whenever GitHub
 * inserts, removes or renumbers a step; matching by content keeps it where
 * the content is.
 *
 * @version v1.5.0-beta
 */

/** What becomes of one entry of the accepted list. */
export type AlignedEntry =
  /** The same content on both sides: the existing entry is kept as it is. */
  | { kind: "keep"; incoming: number; existing: number }
  /** Paired with an existing entry between two kept ones: updated in place. */
  | { kind: "update"; incoming: number; existing: number }
  /** Nothing left to pair with: a new entry. */
  | { kind: "insert"; incoming: number };

export interface Alignment {
  /** One per accepted entry, in the accepted order. */
  sequence: AlignedEntry[];
  /** Existing entries nothing in the accepted list takes, by index. */
  removed: number[];
}

/**
 * The longest common subsequence of two lists of content keys, as index
 * pairs in order. Equal keys are equal content, so every pair is an entry the
 * same on both sides.
 */
function commonSubsequence(existing: readonly string[], incoming: readonly string[]): Array<[number, number]> {
  const n = existing.length;
  const m = incoming.length;
  const length: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      length[i][j] = existing[i] === incoming[j]
        ? length[i + 1][j + 1] + 1
        : Math.max(length[i + 1][j], length[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (existing[i] === incoming[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (length[i + 1][j] >= length[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * The alignment of `existing` to `incoming`, each a list of content keys in
 * its own order.
 *
 * The longest common subsequence gives the entries kept. Between two kept
 * entries (and before the first, after the last), the remaining existing and
 * incoming entries are paired in order and updated in place; what is left
 * over on the incoming side is inserted and on the existing side removed.
 */
export function alignByContent(existing: readonly string[], incoming: readonly string[]): Alignment {
  const anchors = commonSubsequence(existing, incoming);
  const sequence: AlignedEntry[] = [];
  const removed: number[] = [];
  let fromExisting = 0;
  let fromIncoming = 0;
  const gap = (toExisting: number, toIncoming: number) => {
    const olds = toExisting - fromExisting;
    const news = toIncoming - fromIncoming;
    for (let k = 0; k < Math.max(olds, news); k++) {
      if (k < olds && k < news) sequence.push({ kind: "update", incoming: fromIncoming + k, existing: fromExisting + k });
      else if (k < news) sequence.push({ kind: "insert", incoming: fromIncoming + k });
      else removed.push(fromExisting + k);
    }
  };
  for (const [e, i] of anchors) {
    gap(e, i);
    sequence.push({ kind: "keep", incoming: i, existing: e });
    fromExisting = e + 1;
    fromIncoming = i + 1;
  }
  gap(existing.length, incoming.length);
  return { sequence, removed };
}
