/**
 * Python Markdown's `smarty` extension, with its defaults (quotes, dashes and
 * ellipses on, angled quotes off), applied to the text of one run of inline
 * text as the framework's converter applies it to one text node of the tree
 * (`MARKDOWN_EXTENSIONS` in scripts/telar/latex.py).
 *
 * The patterns are the extension's own, in its order: dashes, then the quote
 * patterns, then the ellipsis. Each match is replaced by a placeholder at
 * once and the search resumes after it, so a later pattern reads a
 * replacement as the extension's does, as a character that is neither
 * punctuation nor a word, and never rewrites it. `\w` and `\b` are Unicode
 * in Python and ASCII in JavaScript, so a word character is spelled out.
 * Output is the entities the extension writes, which `marked` leaves as they
 * are.
 *
 * @version v1.5.0-beta
 */

const WORD = "[\\p{L}\\p{N}_]";
const PUNCT = "[!\"#$%'()*+,\\-./:;<=>?@[\\\\\\]^_`{|}~]";
const CLOSE = "[^ \\t\\r\\n[{(\\-\\u0002\\u0003]";
const OPENING = "(\\s|&nbsp;|--|–|—|&[mn]dash;|&#8211;|&#8212;)";

const LSQUO = "&lsquo;";
const RSQUO = "&rsquo;";
const LDQUO = "&ldquo;";
const RDQUO = "&rdquo;";

/** A pattern, and what replaces a match: a group's text, or an entity. */
type Rule = readonly [RegExp, ReadonlyArray<number | string>];

const smartRule = (source: string, replacement: ReadonlyArray<number | string>): Rule => [new RegExp(source, "gu"), replacement];

const RULES: readonly Rule[] = [
  smartRule("(?<!-)---(?!-)", ["&mdash;"]),
  smartRule("(?<!-)--(?!-)", ["&ndash;"]),
  smartRule(`^'(?=${PUNCT}(?!${WORD}))`, [RSQUO]),
  smartRule(`^"(?=${PUNCT}(?!${WORD}))`, [RDQUO]),
  smartRule(`"'(?=${WORD})`, [LDQUO + LSQUO]),
  smartRule(`'"(?=${WORD})`, [LSQUO + LDQUO]),
  smartRule(`(?<=${CLOSE})'"`, [RSQUO + RDQUO]),
  smartRule(`(?<=${CLOSE})"'`, [RDQUO + RSQUO]),
  smartRule(`(?<!${WORD})'(?=\\d{2}s)`, [RSQUO]),
  smartRule(`${OPENING}'(?=${WORD})`, [1, LSQUO]),
  smartRule(`(?<=${CLOSE})'(?!\\s|s(?!${WORD})|\\d)`, [RSQUO]),
  smartRule("'(\\s|s(?!" + WORD + "))", [RSQUO, 1]),
  smartRule("'", [LSQUO]),
  smartRule(`${OPENING}"(?=${WORD})`, [1, LDQUO]),
  smartRule('"(?=\\s)', [RDQUO]),
  smartRule(`(?<=${CLOSE})"`, [RDQUO]),
  smartRule('"', [LDQUO]),
  smartRule("(?<!\\.)\\.{3}(?!\\.)", ["&hellip;"]),
];

const PLACEHOLDER = /\u0002smarty:(\d+)\u0003/g;

/** `text` with the rule applied from left to right, each replacement held out of what follows. */
function substituteWith(text: string, [pattern, replacement]: Rule, hold: (entity: string) => string): string {
  let out = text;
  let from = 0;
  for (;;) {
    pattern.lastIndex = from;
    const found = pattern.exec(out);
    if (!found) return out;
    const put = replacement.map((part) => (typeof part === "number" ? found[part] : hold(part))).join("");
    out = out.slice(0, found.index) + put + out.slice(found.index + found[0].length);
    from = found.index + put.length;
  }
}

/** The text of one text node, quotes, dashes and ellipses as the site writes them. */
export function smartTypography(text: string): string {
  const entities: string[] = [];
  const hold = (entity: string) => `\u0002smarty:${entities.push(entity) - 1}\u0003`;
  const held = RULES.reduce((out, current) => substituteWith(out, current, hold), text);
  return held.replace(PLACEHOLDER, (whole, index: string) => entities[Number(index)] ?? whole);
}
