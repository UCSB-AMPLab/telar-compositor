/**
 * The custom columns an object page shows, and their order.
 *
 * No stored column order exists: an object's `extra_columns` blob keeps only
 * the columns its own row filled, in the sheet's order, so the sheet's order
 * is read back from the blobs of every object in the document — each blob
 * orders only its own keys, and the page merges them. The published file does
 * not depend on this order: publish writes the file's own layout.
 *
 * No imports, so the page and its tests can take it.
 *
 * @version v1.5.0-beta
 */

import { isInstructionColumnName, parseExtraColumns } from "./extra-columns";

/**
 * The custom columns of a set of objects, in the order the blobs agree on.
 * Where two blobs disagree, the column first seen goes first, so the result is
 * the same for the same document. An instruction column (a header beginning
 * with `#`) is left out: the framework drops it before it reads a row, so the
 * site never shows it.
 *
 * `header` is the sheet's own header row, when the page could read it: the
 * columns it names go first, in its order, and columns it does not name (or all
 * of them, when it is null) follow in the order the blobs give.
 */
export function customColumnOrder(
  blobs: ReadonlyArray<string | null | undefined>,
  header?: readonly string[] | null,
): string[] {
  const inferred = inferredOrder(blobs);
  const named = new Set(inferred);
  const fromHeader = [...new Set(header ?? [])].filter((h) => named.has(h));
  return [...fromHeader, ...inferred.filter((c) => !fromHeader.includes(c))];
}

function inferredOrder(blobs: ReadonlyArray<string | null | undefined>): string[] {
  const lists = blobs
    .map((raw) => Object.keys(parseExtraColumns(raw)).filter((k) => !isInstructionColumnName(k)))
    .filter((l) => l.length > 0);
  const columns = [...new Set(lists.flat())];
  const before = new Map<string, Set<string>>(columns.map((c) => [c, new Set<string>()]));
  for (const list of lists) {
    list.forEach((key, i) => {
      if (i > 0) before.get(key)!.add(list[i - 1]);
    });
  }
  const placed: string[] = [];
  const done = new Set<string>();
  while (placed.length < columns.length) {
    const open = columns.filter((c) => !done.has(c));
    const next = open.find((c) => [...before.get(c)!].every((p) => done.has(p))) ?? open[0];
    placed.push(next);
    done.add(next);
  }
  return placed;
}
