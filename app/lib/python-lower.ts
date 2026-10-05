/**
 * The lowercase CPython 3.11 gives, for the places the Compositor has to
 * predict what the site build's Python will make of a header.
 *
 * Pure data and one function, with no imports, so `column-mapping.ts` can fold
 * headers with it without reaching the modules that import that one.
 *
 * @version v1.5.0-beta
 */

/**
 * The code points whose lowercase JavaScript's `toLowerCase` gives (Node 22,
 * Unicode 17) and CPython 3.11's `str.lower` does not, so Python leaves them as
 * they are. The site build runs Python 3.11 (Unicode 14.0; build.yml's
 * `python-version: '3.11'`), and a header fold that lowers one of these where
 * the build does not claims a name the build never sees.
 *
 * Derived, not listed by hand: `chr(c).lower()` under /usr/local/bin/python3.12
 * (Unicode 15.0) diffed against `String.fromCodePoint(c).toLowerCase()` for
 * every code point outside the surrogates gave exactly these 55, each one a
 * code point Python leaves unchanged; the 1,433 case mappings of that Python
 * and of CPython 3.11.5 (Unicode 14.0) are identical, so 15.0 added none.
 * `framework-sheet-parity.test.ts` repeats the sweep against Python 3.12.
 */
export const LOWERED_ONLY_AFTER_UNICODE_14: ReadonlySet<number> = new Set([
  0x1c89, 0xa7cb, 0xa7cc, 0xa7ce, 0xa7d2, 0xa7d4, 0xa7da, 0xa7dc,
  ...Array.from({ length: 0x10d65 - 0x10d50 + 1 }, (_, i) => 0x10d50 + i),
  ...Array.from({ length: 0x16eb8 - 0x16ea0 + 1 }, (_, i) => 0x16ea0 + i),
]);

/**
 * `str.lower()` as the build's Python 3.11 performs it. Each run between two
 * of LOWERED_ONLY_AFTER_UNICODE_14 is lowered whole, so a final sigma is judged
 * in context; such a code point is unassigned in Unicode 14, neither cased nor
 * case-ignorable, so it ends that context as the end of a run does.
 */
export function pythonLower(value: string): string {
  let out = "";
  let run = "";
  for (const ch of value) {
    if (LOWERED_ONLY_AFTER_UNICODE_14.has(ch.codePointAt(0) as number)) {
      out += run.toLowerCase() + ch;
      run = "";
    } else run += ch;
  }
  return out + run.toLowerCase();
}
