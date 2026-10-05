/**
 * The characters a Telar build cannot carry, and the one function that takes
 * them out of text.
 *
 * Jekyll reads a site's front matter and `_data/*.json` with Ruby Psych, and
 * Psych fails the whole build on DEL, the C1 controls and the noncharacters
 * U+FFFE and U+FFFF (`control characters are not allowed`). The framework
 * writes story JSON with `ensure_ascii=False`, so any of them in a step's text
 * reaches Psych raw. Its object and glossary front matter escapes only tab,
 * newline and carriage return, so the remaining C0 controls fail there too.
 * A lone UTF-16 surrogate is not a character at all and has no representation
 * in a UTF-8 file.
 *
 * The set has two parts. The controls Unicode counts as whitespace — vertical
 * tab, form feed, the information separators U+001C–U+001F, NEL and the line
 * and paragraph separators — separate words, so `cleanText` turns each into a
 * space rather than joining the words either side; a space also never changes
 * the structure of a YAML line or a CSV cell, which a newline could. Every
 * other member is removed. Tab, newline and carriage return are never members.
 *
 * `knap-filters.server.ts` escapes front-matter scalars with `isUnsafeCodePoint`
 * from here, so what the escaper escapes and what `cleanText` cleans are one
 * definition. Imported by client and server code alike: nothing here may
 * depend on either environment.
 *
 * @version v1.5.0-beta
 */

type Range = readonly [number, number];

/** Members that separate words: cleaned to a space. */
const SEPARATING_RANGES: readonly Range[] = [
  [0x0b, 0x0c],
  [0x1c, 0x1f],
  [0x85, 0x85],
  [0x2028, 0x2029],
];

/** Members that carry no text: removed. */
const REMOVED_RANGES: readonly Range[] = [
  [0x00, 0x08],
  [0x0e, 0x1b],
  [0x7f, 0x84],
  [0x86, 0x9f],
  [0xfffe, 0xffff],
];

function inRanges(codePoint: number, ranges: readonly Range[]): boolean {
  return ranges.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

function rangeClass(ranges: readonly Range[]): string {
  const hex = (n: number) => `\\u${n.toString(16).padStart(4, "0")}`;
  return ranges.map(([lo, hi]) => (lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`)).join("");
}

/**
 * Matches any member other than a surrogate. No `u` flag: the class is read
 * as UTF-16 code units, and every member is a single code unit.
 */
const UNSAFE_UNIT = new RegExp(`[${rangeClass(SEPARATING_RANGES)}${rangeClass(REMOVED_RANGES)}]`);

const SURROGATE_UNIT = /[\ud800-\udfff]/;

/** True for a code point that separates words and cleans to a space. */
export function isSeparatingCodePoint(codePoint: number): boolean {
  return inRanges(codePoint, SEPARATING_RANGES);
}

/**
 * True for any code point in the set. Surrogate code points are not members:
 * a well-formed pair is a real character, and a lone half is handled by
 * `replaceLoneSurrogates`.
 */
export function isUnsafeCodePoint(codePoint: number): boolean {
  return inRanges(codePoint, SEPARATING_RANGES) || inRanges(codePoint, REMOVED_RANGES);
}

function isHigh(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLow(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (isHigh(unit)) {
      if (isLow(text.charCodeAt(i + 1))) i++;
      else return true;
    } else if (isLow(unit)) {
      return true;
    }
  }
  return false;
}

/**
 * Replaces any lone (unpaired) UTF-16 surrogate with U+FFFD, the Unicode
 * replacement character, and keeps every well-formed pair.
 *
 * The loss is deliberate: a lone surrogate is not a character, so no output
 * preserves it, and replacing it keeps a site publishable where refusing would
 * turn malformed input into a publish outage.
 */
export function replaceLoneSurrogates(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (isHigh(code)) {
      if (isLow(value.charCodeAt(i + 1))) {
        out += value[i] + value[i + 1];
        i++;
      } else {
        out += "\ufffd";
      }
    } else if (isLow(code)) {
      out += "\ufffd";
    } else {
      out += value[i];
    }
  }
  return out;
}

/** True when `cleanText` would change `text`. Cheap on text that is clean. */
export function needsCleaning(text: string): boolean {
  if (UNSAFE_UNIT.test(text)) return true;
  return SURROGATE_UNIT.test(text) && hasLoneSurrogate(text);
}

/**
 * Returns `text` without the characters a Telar build rejects: a separating
 * member becomes a space, every other member is removed, and a lone surrogate
 * becomes U+FFFD. Clean text is returned as the same string.
 */
export function cleanText(text: string): string {
  if (!needsCleaning(text)) return text;
  let out = "";
  for (const char of replaceLoneSurrogates(text)) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!isUnsafeCodePoint(codePoint)) out += char;
    else if (isSeparatingCodePoint(codePoint)) out += " ";
  }
  return out;
}
