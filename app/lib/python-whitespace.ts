/**
 * The whitespace CPython sees, for the places the Compositor has to predict
 * what the framework's Python will make of a string.
 *
 * It parts from JavaScript on six code points: CPython counts U+001C-U+001F
 * and U+0085 and does not count U+FEFF, and `trim()` and `\s` do the opposite.
 * Two surfaces depend on the difference — a CSV header fold, which decides
 * what a column IS, and a step answer's word count, which decides whether a
 * publish is refused — so the set is defined once and both read it here.
 *
 * Pure data and small functions, with no imports, so any layer can take it.
 *
 * @version v1.5.0-beta
 */

/**
 * Code points whose `str.isspace()` CPython answers true for: what
 * `str.strip()` removes and what `str.split()` with no argument splits on.
 */
export const PYTHON_WHITESPACE: ReadonlySet<string> = new Set([
  "\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u001c",
  "\u001d", "\u001e", "\u001f", "\u0020", "\u0085", "\u00a0",
  "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004",
  "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a",
  "\u2028", "\u2029", "\u202f", "\u205f", "\u3000",
]);

/**
 * The tokens `str.split()` with no argument returns for `value`.
 *
 * Leading and trailing whitespace yields no empty token and a run of
 * whitespace separates one token, which is what makes the no-argument form
 * different from splitting on a single separator.
 */
export function pythonSplit(value: string): string[] {
  const tokens: string[] = [];
  let token = "";
  for (const ch of value) {
    if (PYTHON_WHITESPACE.has(ch)) {
      if (token !== "") tokens.push(token);
      token = "";
      continue;
    }
    token += ch;
  }
  if (token !== "") tokens.push(token);
  return tokens;
}

/**
 * `str.strip()` as CPython performs it: its whitespace off both ends.
 *
 * Whatever predicts what the framework's Python makes of a string has to
 * strip what Python strips: a header fold, a glossary term id, a panel's
 * text. Two values separated only by a code point one language calls
 * whitespace and the other does not are one value there and two here.
 */
export function pythonStrip(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PYTHON_WHITESPACE.has(value[start])) start += 1;
  while (end > start && PYTHON_WHITESPACE.has(value[end - 1])) end -= 1;
  return value.slice(start, end);
}
