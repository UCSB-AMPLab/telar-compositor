/**
 * Python `re` expressions, compiled so JavaScript reads them as Python does.
 *
 * The Compositor mirrors the framework's `ANSWER_PROSE_RULES` byte for byte,
 * because the pattern strings are the contract between the two. Identical
 * strings are not identical behaviour: the two engines part on what a line
 * ends with, on what `.` excludes, on which code points are whitespace, on
 * what a word character is, and on which letters fold together. An editor
 * compiled naively refuses answers the build keeps and keeps answers the build
 * removes.
 *
 * So the string stays the framework's and the compilation is rewritten. Every
 * construct whose meaning differs is replaced with one that does in JavaScript
 * what Python's does in Python; everything else is passed through untouched.
 *
 * @version v1.5.0-beta
 */

import { PYTHON_WHITESPACE } from "~/lib/python-whitespace";
import { PYTHON_WORD_CLASS_BODY } from "~/lib/python-word";

/** `\uXXXX`, so a class body carries no literal control characters. */
function escapeCodePoint(ch: string): string {
  return `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
}

/**
 * The body of a character class matching exactly what CPython's `\s` matches
 * on a `str` pattern, built from the one definition of that set.
 *
 * JavaScript's `\s` is not it: it counts U+FEFF, which CPython does not, and
 * misses U+001C-U+001F and U+0085, which CPython counts.
 */
const PYTHON_WS_BODY = [...PYTHON_WHITESPACE].sort().map(escapeCodePoint).join("");

/**
 * A word character to Python: its `\w` is Unicode-aware on `str` patterns, so
 * `é` is one and `<imgé>` has no word boundary after `img`. The set is the
 * build's Python, not the JavaScript engine's Unicode version.
 */
const WORD = `[${PYTHON_WORD_CLASS_BODY}]`;

/** Python's `\b`, which JavaScript's ASCII-only one does not reproduce. */
const WORD_BOUNDARY = `(?:(?<!${WORD})(?=${WORD})|(?<=${WORD})(?!${WORD}))`;

/**
 * Code points CPython's IGNORECASE equates with an ASCII letter, split by
 * whether its BACKREFERENCE comparison equates them too.
 *
 * The two are not the same rule, which is the whole reason this file needs
 * both halves. Measured against CPython over every code point:
 *
 *   | code point | literal match | `\1` comparison |
 *   |---|---|---|
 *   | U+0130 dotted capital I | i | i |
 *   | U+212A Kelvin sign      | k | k |
 *   | U+0131 dotless i        | i | NOT i |
 *   | U+017F long s           | s | NOT s |
 *
 * The first two are folded in the TEXT, because a folded copy is the only way
 * to reach JavaScript's own backreference comparison — no rewriting of a
 * pattern can change how `\1` compares what it captured. The last two must
 * NOT be folded there, or a closing tag would match one Python refuses; they
 * are expanded in the PATTERN instead, where they affect literal matching
 * alone.
 *
 * Each is a single UTF-16 code unit, which is what lets the folded copy share
 * every index with the original.
 */
const PYTHON_BACKREF_FOLD: ReadonlyMap<string, string> = new Map([
  ["\u0130", "i"],
  ["\u212a", "k"],
]);

/** The other half: equated when matched literally, not when compared. */
const CASE_EXTRAS: Record<string, string> = {
  i: "\u0131",
  I: "\u0131",
  s: "\u017f",
  S: "\u017f",
};

// The index-sharing the shadow rests on. A mapping that changed a string's
// length would put every later match at the wrong offset in the original, and
// the removals would cut the wrong text.
for (const [from, to] of PYTHON_BACKREF_FOLD) {
  if (from.length !== 1 || to.length !== 1) {
    throw new Error(`PYTHON_BACKREF_FOLD: ${from} -> ${to} is not one code unit to one`);
  }
}

/**
 * `text` with every code point CPython's backreference comparison equates with
 * an ASCII letter replaced by that letter.
 *
 * The copy is the same length as the original and every index in one is the
 * same position in the other, so a match found in the copy names a range in
 * the original — and the original's own bytes are what survive the cut.
 */
export function pythonCaseFold(text: string): string {
  let out = "";
  for (const ch of text) out += PYTHON_BACKREF_FOLD.get(ch) ?? ch;
  return out;
}

/**
 * The code points a case-insensitive pattern may not carry as a literal.
 *
 * Every one of them is a letter the two engines case-fold differently, and the
 * arrangement here answers the difference on the INPUT: the shadow folds the
 * text before the match, and the pattern's ASCII letters are expanded to cover
 * what JavaScript's own folding misses. Neither reaches a literal on the
 * pattern side. `\u0130` in a pattern would face a shadow that has already
 * turned every `\u0130` in the text into `i`, and match nothing; `\u0131`
 * would match only itself where Python matches `i` and `I` too.
 *
 * No rule in the framework's table carries one. The refusal is what keeps a
 * rule that starts to from diverging in silence.
 */
const FOLD_MAPPED_LITERALS = new Set([
  ...PYTHON_BACKREF_FOLD.keys(),
  ...Object.values(CASE_EXTRAS),
]);

/**
 * A code point written as an escape: Python's `\uXXXX`, `\xXX`,
 * `\UXXXXXXXX` and `\N{NAME}`.
 */
const CODE_POINT_ESCAPE = /^\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|U([0-9a-fA-F]{8})|N\{[^}]*\})/;

/**
 * Refuses a code point written as an escape in a case-insensitive pattern.
 *
 * The literal refusal below reads the pattern's characters, and an escape
 * hides one from it: `\u0130` is six characters, none of them the code point it
 * denotes. Rather than decode them — and then have to keep the decoder and the
 * fold table agreeing — every code-point escape is refused under IGNORECASE.
 * The framework's table writes none, and a case-sensitive pattern is not
 * affected, since nothing folds there: the flag is judged here rather than at
 * the call, so the compiler's own loop carries no branch for it.
 */
function refuseCodePointEscape(source: string, at: number, ignoreCase: boolean): void {
  if (!ignoreCase) return;
  const escape = source.slice(at).match(CODE_POINT_ESCAPE);
  if (!escape) return;
  const hex = escape[1] ?? escape[2] ?? escape[3];
  const denoted =
    hex === undefined ? escape[0] : codePointName(String.fromCodePoint(Number.parseInt(hex, 16)));
  throw new Error(
    `compilePythonPattern: ${denoted}, written as ${escape[0]}, has no faithful ` +
      "JavaScript form in a case-insensitive pattern",
  );
}

/** `ch` as `U+XXXX`, for a refusal that names what it refused. */
function codePointName(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** What one literal character becomes, given the case-insensitive flag. */
function rewriteLiteral(ch: string, ignoreCase: boolean, inClass: boolean): string {
  if (ignoreCase && FOLD_MAPPED_LITERALS.has(ch)) {
    throw new Error(
      `compilePythonPattern: ${codePointName(ch)} as a literal in a case-insensitive ` +
        "pattern has no faithful JavaScript form",
    );
  }
  const extras = ignoreCase ? CASE_EXTRAS[ch] : undefined;
  if (extras === undefined) return ch;
  return inClass ? `${ch}${extras}` : `[${ch}${extras}]`;
}

/**
 * Escapes this module refuses rather than mistranslates.
 *
 * `\d` and `\w` are Unicode-aware in Python and ASCII-only in JavaScript, and
 * no rule uses them — the framework writes `[0-9]`. A rule that started to
 * would diverge silently, so it stops here instead. `\S` inside a character
 * class cannot be expressed as a code-point list at all.
 */
const REFUSED_OUTSIDE_CLASS = new Set(["d", "D", "w", "W"]);

/** What one escape becomes outside a character class. */
function rewriteEscape(next: string, inClass: boolean): string {
  if (REFUSED_OUTSIDE_CLASS.has(next)) {
    throw new Error(`compilePythonPattern: \\${next} has no faithful JavaScript form`);
  }
  if (next === "s") return inClass ? PYTHON_WS_BODY : `[${PYTHON_WS_BODY}]`;
  if (next === "S") {
    if (inClass) {
      throw new Error("compilePythonPattern: \\S inside a character class has no code-point form");
    }
    return `[^${PYTHON_WS_BODY}]`;
  }
  if (next === "b" && !inClass) return WORD_BOUNDARY;
  return `\\${next}`;
}

/**
 * `pattern`, written for Python `re` with `flags`, as a JavaScript RegExp that
 * matches the same text.
 *
 * `m` and `s` do not survive into the result: both anchors and `.` are
 * rewritten to forms that need no flag, because JavaScript's own `m` breaks a
 * line at CR, U+2028 and U+2029 where Python breaks only at LF, and its `.`
 * excludes those three besides. `u` is added, which is what makes `\p{L}` and
 * the wider case folding available; `g` and `i` are carried through.
 *
 * `[\s\S]` is replaced whole. It is the any-character idiom, and both engines
 * already agree on it — expanding the `\s` inside it would leave a class that
 * matched everything except U+FEFF.
 */
export function compilePythonPattern(pattern: string, flags: string): RegExp {
  const multiline = flags.includes("m");
  const ignoreCase = flags.includes("i");
  const single: Record<string, string> = { ".": flags.includes("s") ? "[^]" : "[^\\n]" };
  if (multiline) {
    single["^"] = "(?<![^\\n])";
    single["$"] = "(?![^\\n])";
  }

  const source = pattern.split("[\\s\\S]").join("[^]");
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      refuseCodePointEscape(source, i, ignoreCase);
      out += rewriteEscape(source[i + 1], inClass);
      i++;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    if (inClass) {
      out += rewriteLiteral(ch, ignoreCase, true);
      continue;
    }
    out += single[ch] ?? rewriteLiteral(ch, ignoreCase, false);
  }

  const jsFlags = `gu${ignoreCase ? "i" : ""}`;
  return new RegExp(out, jsFlags);
}
