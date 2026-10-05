/**
 * authorText — an author's text written into the Markdown syntax the
 * Compositor builds around it: a link's text, an image's alt text, a
 * glossary reference's display text, and the address of a link or image.
 * Each function states which characters would end or change the construct
 * on the site, and what is written for them instead.
 *
 * Every replacement is an HTML entity or a percent escape, never a
 * backslash: `\[…\]` and `\(…\)` are KaTeX's display and inline maths
 * delimiters, which a layer panel publishes as written and the site then
 * typesets, so a backslash written before a bracket or a parenthesis can
 * turn text into a formula.
 *
 * The framework's two paths read what is written here as follows, measured
 * at the framework 0980b030 and 508e4c03 (the panel path: widgets,
 * `process_images`, Python Markdown, then the glossary pass; an answer takes
 * the same conversion and glossary pass, without images):
 *
 *   - `&#91;` and `&#93;` in alt text publish as `[` and `]`, since
 *     `process_images` decodes alt text before escaping it; in link text
 *     they publish as the entity, and read as a bracket. Neither path ever
 *     forms a glossary
 *     reference from them in body or link text.
 *   - A glossary display text is decoded before it is escaped (in the
 *     framework), so `&#93;` and `&#124;` there publish as `]`
 *     and `|`; a raw `[` is read as itself on both paths.
 *   - A link address may hold `%28`, `%29` and `%20` on both paths, and so
 *     may an image address in `process_images`, which does not read the
 *     `<…>` form.
 *
 * @version v1.5.0-beta
 */
import { isEscaped } from "./escapes";

const OPEN = "&#91;";
const CLOSE = "&#93;";
const PIPE = "&#124;";

/** How the text reached the writer: typed as plain text, or selected from Markdown source. */
export type AuthorTextSource = "text" | "markdown";

/**
 * `text` made safe to stand between the brackets of `[…](…)` or `![…](…)`.
 *
 * A bracket is written as it is only when it belongs to a pair that holds
 * no other bracket and stands inside no other pair, and that pair is not
 * the whole text; every other bracket is written `&#91;` or `&#93;`. So
 * "Loom [Telar]" is written as it is, while a lone bracket, the brackets of
 * a pair two levels deep, and both pairs of `[[…]]` become entities. A pair
 * that is the whole text is escaped because, with the construct's own
 * brackets around it, it would read `[[…]]`, which the answer path's
 * glossary pass takes for a reference before Markdown sees the link.
 *
 * With `source` "markdown" the text is the author's own Markdown, such as a
 * selection: a bracket escaped with a backslash is theirs and is neither
 * counted nor changed, as Markdown does not count it. An entity already in
 * the text holds no bracket, so escaping twice changes nothing.
 */
export function escapeBracketsForMarkdown(text: string, source: AuthorTextSource = "text"): string {
  const brackets = bracketsIn(text, source);
  const kept = keptBrackets(text, brackets, partners(text, brackets));
  let out = "";
  let last = 0;
  for (const at of brackets) {
    if (kept.has(at)) continue;
    out += text.slice(last, at) + (text[at] === "[" ? OPEN : CLOSE);
    last = at + 1;
  }
  return out + text.slice(last);
}

/** The offsets of the brackets that count, in order. */
function bracketsIn(text: string, source: AuthorTextSource): number[] {
  const brackets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const counted = source === "text" || !isEscaped(text, i);
    if ((text[i] === "[" || text[i] === "]") && counted) brackets.push(i);
  }
  return brackets;
}

/** Each matched bracket's partner, both ways; an unmatched one has none. */
function partners(text: string, brackets: number[]): Map<number, number> {
  const partner = new Map<number, number>();
  const open: number[] = [];
  for (const at of brackets) {
    if (text[at] === "[") open.push(at);
    else if (open.length) {
      const from = open.pop()!;
      partner.set(from, at).set(at, from);
    }
  }
  return partner;
}

/** The brackets written as they are: the pairs at depth 0 with nothing between them, unless a pair is the whole text. */
function keptBrackets(text: string, brackets: number[], partner: Map<number, number>): Set<number> {
  const kept = new Set<number>();
  let depth = 0;
  brackets.forEach((at, n) => {
    const other = partner.get(at);
    if (other === undefined) return;
    if (text[at] === "]") {
      depth--;
      return;
    }
    const empty = brackets[n + 1] === other;
    const whole = at === 0 && other === text.length - 1;
    if (depth === 0 && empty && !whole) kept.add(at).add(other);
    depth++;
  });
  return kept;
}

/**
 * Text from pasted HTML, where it stands outside any construct the paste
 * builds: every bracket is written as an entity, since a pair followed by
 * `(`, `[` or `:` would make a link or a reference of the author's words.
 */
export function escapeEveryBracket(text: string): string {
  return text.replace(/[[\]]/g, (ch) => (ch === "[" ? OPEN : CLOSE));
}

/**
 * `text` as the display text of `[[term|…]]`. The framework's reference
 * pattern (`process_glossary_links`, scripts/telar/glossary.py) stops a
 * display text at the first `]` or `|`, so those are written `&#93;` and
 * `&#124;`; a `[` does not end it and is left as it is.
 */
export function escapeGlossaryDisplay(text: string): string {
  return text.replace(/[\]|]/g, (ch) => (ch === "]" ? CLOSE : PIPE));
}

/** `[[termId]]`, or `[[termId|display]]` with its display text escaped. */
export function glossaryReference(termId: string, display?: string): string {
  const shown = display?.trim();
  return shown ? `[[${termId}|${escapeGlossaryDisplay(shown)}]]` : `[[${termId}]]`;
}

/**
 * `url` made safe to stand between the parentheses of `[…](…)` or
 * `![…](…)`: whitespace and parentheses percent-encoded, everything else,
 * `%` included, as written. `process_images` ends an image address at its
 * first `)`, and whitespace would start a link title.
 */
export function encodeUrlForMarkdown(url: string): string {
  return url.replace(/[\s()]/gu, (ch) => PARENTHESES[ch] ?? encodeURIComponent(ch));
}

const PARENTHESES: Record<string, string> = { "(": "%28", ")": "%29" };

/**
 * Text read back into an editing field with the three entities this module
 * writes, `&#91;`, `&#93;` and `&#124;`, decoded; any other entity is the
 * author's and is left as written.
 */
export function decodeWrittenEntities(text: string): string {
  return text.replace(/&#(91|93|124);/g, (_entity, code: string) => String.fromCharCode(Number(code)));
}
