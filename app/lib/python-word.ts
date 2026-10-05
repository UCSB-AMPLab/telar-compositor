/**
 * What a word character is to the build's Python.
 *
 * `\w` on a `str` pattern is Unicode-aware, and which code points it covers
 * depends on the Unicode version the interpreter was built with. JavaScript's
 * `\p{L}\p{N}` answers for the engine's own version, so the two disagree on
 * every code point one version assigned and the other has not. The table is
 * generated from the pinned Python (see python-word-table.ts), and both the
 * compiled patterns and the hand-written scanners read it from here.
 *
 * @version v1.5.0-beta
 */

import { PYTHON_WORD_RANGES } from "~/lib/python-word-table";

/** A character class body matching exactly the code points in the table. */
export const PYTHON_WORD_CLASS_BODY = PYTHON_WORD_RANGES.map(([from, to]) =>
  from === to ? `\\u{${from.toString(16)}}` : `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`,
).join("");

/** Whether `codePoint` is a word character to CPython's `\w`. */
export function isPythonWordCodePoint(codePoint: number): boolean {
  let low = 0;
  let high = PYTHON_WORD_RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [from, to] = PYTHON_WORD_RANGES[mid];
    if (codePoint < from) high = mid - 1;
    else if (codePoint > to) low = mid + 1;
    else return true;
  }
  return false;
}
