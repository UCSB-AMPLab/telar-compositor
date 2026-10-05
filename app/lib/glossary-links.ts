/**
 * glossary-links — `[[term]]` and `[[term|display]]` resolved as the
 * framework's `process_glossary_links` resolves them (scripts/telar/
 * glossary.py), in the HTML of every preview of author text that publishes
 * with glossary links: a step's answer, a layer panel, a glossary definition.
 *
 * What the framework does, and so what this does:
 *
 *   - The terms are the ones its loader keeps (`load_glossary_from_csv`):
 *     `term_id` and `title` stripped, both non-empty, and no id opening `#`.
 *   - A glossary with no terms leaves the text as it is, `[[term]]` included.
 *   - Of terms published at one address (`first_at_each_address`,
 *     scripts/telar/glossary.py), the first in the glossary's order keeps it
 *     and the others are not terms, so a reference to one of them is an
 *     unknown term. Ids differing only in case or punctuation share a slug,
 *     and so an address. Addresses are compared as written: `Straße` and
 *     `strasse` each publish.
 *   - A reference matches its term whatever its casing; the anchor carries the
 *     stored id, and the stored title unless the reference gives its own
 *     display text.
 *   - A known term becomes `<a href="#" class="glossary-inline-link"
 *     data-term-id data-term-url>`, with `data-demo="true"` for an id opening
 *     `demo-`; the URL is the site's baseurl, `/glossary/`, the id slugified
 *     as Jekyll names the page (`jekyll_slug`, scripts/telar/story_pages.py),
 *     and `/`, so an id with an empty slug is at `/glossary//`, as the
 *     framework writes it.
 *   - An unknown term becomes `<span class="glossary-link-error"
 *     data-term-id>⚠️ [[term]]</span>`, keeping the author's casing.
 *   - Every value is HTML-escaped with quotes, as `html.escape` does; the
 *     link text (its display text or the title) and an unknown term's text
 *     are decoded first, as `html.unescape` decodes them, so `&#93;` there
 *     reads `]`.
 *   - A reference inside a tag (`<` a letter, `/` or `!`, up to the next
 *     `>` outside a quoted attribute value), as in an image's alt text, is
 *     left as written.
 *   - A reference inside code is left as written: code is shown as written.
 *     Code is a code element (`codeElements`): a raw `<code>`, `<pre>`,
 *     `<kbd>` or `<samp>` with its content, which is also what Markdown's code
 *     spans and blocks become; a backtick is a character in HTML.
 *   - So is a reference inside the content of `script`, `style`, `textarea`
 *     or another element a browser reads as text only, as Python's HTML
 *     tokenizer reads them (`python-html-tokens.ts`).
 *   - A link cannot hold a link, so a reference inside the text of a link is
 *     not linked: it shows its display text, else its title, else, for an
 *     unknown term, the term as written, with no error marker, HTML-escaped.
 *     A link's text is an `<a>` element's content as Python's HTML tokenizer
 *     reads it, outside code elements. A `[[` one character before a link's
 *     text counts as inside it.
 *
 * The expression and the whitespace it strips are Python's, compiled by
 * `python-regex.ts`, so a reference padded with a character only one of the
 * two languages calls whitespace resolves as it will on the site.
 *
 * The output is HTML and must reach the page through a sanitiser;
 * `preview-sanitise.ts` keeps these attributes.
 *
 * @version v1.5.0-beta
 */

import { isHeldTermId } from "~/lib/csv-records";
import * as Y from "yjs";
import { compilePythonPattern } from "~/lib/python-regex";
import { htmlUnescape } from "~/lib/html-unescape";
import { PYTHON_WHITESPACE, pythonStrip } from "~/lib/python-whitespace";
import { isPythonWordCodePoint } from "~/lib/python-word";
import { firstAtLeast } from "~/lib/sorted-search";
import { panelHtmlReading } from "~/lib/python-html-tokens";
import { jekyllSlug } from "~/lib/jekyll-slug";
import { textOf } from "~/lib/yjs-helpers";

/** Stored term id to title, in the glossary's order. */
export type GlossaryTerms = ReadonlyMap<string, string>;

const GLOSSARY_PATTERN = String.raw`\[\[\s*([^|\]]+?)(?:\s*\|\s*([^|\]]+?))?\s*\]\]`;

/**
 * What `process_glossary_links` counts as a tag, whose inside it never links.
 * A quoted attribute value may hold `>`, so it does not end the tag.
 */
const TAG = /<[A-Za-z/!](?:[^<>"']|"[^"]*"|'[^']*')*>/g;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

/**
 * `html.escape(value)`, quotes included. Browsers read the result as the same
 * text whichever of the equivalent forms a converter wrote, so the Markdown
 * previews use it too.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * The terms the framework's loader would keep from the project's glossary:
 * those with an id and a title and an id not opening `#`, and of those
 * published at one address, the first.
 */
export function glossaryTermsFromDoc(ydoc: Y.Doc | null): Map<string, string> {
  const rows = ydoc?.getArray<Y.Map<unknown>>("glossary").toArray() ?? [];
  return keptGlossaryTerms(rows.map((term) => ({ term_id: textOf(term.get("term_id")), title: textOf(term.get("title")) })));
}

/** A glossary row as the loaders read it. */
interface GlossaryRow {
  term_id: string | null;
  title?: string | null;
  kind?: string | null;
}

/** The rows the framework's loader keeps, each with its stripped id and title, in the glossary's order. */
function keptRows(rows: ReadonlyArray<GlossaryRow>): Array<{ termId: string; title: string; row: GlossaryRow }> {
  const kept: Array<{ termId: string; title: string; row: GlossaryRow }> = [];
  const held = new Set<string>();
  for (const row of rows) {
    const termId = pythonStrip(row.term_id ?? "");
    const title = pythonStrip(row.title ?? "");
    if (isHeldTermId(termId) || !title) continue;
    const address = glossaryTermUrl(termId, "");
    if (held.has(address)) continue;
    held.add(address);
    kept.push({ termId, title, row });
  }
  return kept;
}

/** The terms the framework's loader keeps from `rows`, given in the glossary's order (`glossaryTermsFromDoc`). */
export function keptGlossaryTerms(rows: ReadonlyArray<GlossaryRow>): Map<string, string> {
  return new Map(keptRows(rows).map(({ termId, title }) => [termId, title]));
}

/**
 * Each kept term's `kind` as stored, which a glossary callout reads its kind
 * from (`readKind`, glossary-kinds.ts); "" for a row with none.
 */
export function glossaryEntryKindsFromDoc(ydoc: Y.Doc | null): Map<string, string> {
  const rows = ydoc?.getArray<Y.Map<unknown>>("glossary").toArray() ?? [];
  const read = rows.map((term) => ({
    term_id: textOf(term.get("term_id")),
    title: textOf(term.get("title")),
    kind: textOf(term.get("kind")),
  }));
  return new Map(keptRows(read).map(({ termId, row }) => [termId, row.kind ?? ""]));
}

/** A glossary term's slug: Jekyll's default `slugify`, as `jekyll_slug` does. */
export const glossaryTermSlug = jekyllSlug;

/** The site-relative address of a term's page; `baseUrl` has no trailing slash. */
export function glossaryTermUrl(termId: string, baseUrl: string): string {
  return `${baseUrl}/glossary/${glossaryTermSlug(termId)}/`;
}

/** A stretch of text as `[start, end)` offsets. */
export type Region = readonly [number, number];

/**
 * A test of whether `[start, end)` overlaps any of `regions`, which may
 * overlap each other: a search, not a pass over every region.
 */
export function overlapTest(regions: readonly Region[]): (start: number, end: number) => boolean {
  const ordered = [...regions].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const starts = ordered.map(([start]) => start);
  const reach: number[] = [];
  for (const [, end] of ordered) reach.push(Math.max(end, reach.at(-1) ?? end));
  return (start, end) => {
    const count = firstAtLeast(starts, end);
    return count > 0 && reach[count - 1] > start;
  };
}

/**
 * The opening of `CODE_ELEMENT` in `glossary.py`,
 * `<(code|pre|kbd|samp)\b[^>]*>(?:(?!<\1\b).)*?</\1\s*>` with DOTALL and
 * IGNORECASE. The rest is a scan: JavaScript's case-insensitive
 * backreference equates `ſ` with `s` where CPython's does not, so names are
 * compared as CPython does, one character's simple lower case against
 * another's.
 */
const OPENING = String.raw`<(code|pre|kbd|samp)\b[^>]*>`;

/** Characters CPython's backreference lower-cases to an ASCII letter besides the letter's own capital. */
const BACKREF_LOWER: ReadonlyMap<string, string> = new Map([
  ["İ", "i"],
  ["K", "k"],
]);

/** One character as CPython's case-insensitive backreference compares it. */
function lowered(ch: string): string {
  return BACKREF_LOWER.get(ch) ?? (ch < "\u0080" ? ch.toLowerCase() : ch);
}

/** Whether `text` at `at` holds `name`, compared as `\1` compares it under IGNORECASE. */
function holdsName(text: string, at: number, name: string): boolean {
  if (at + name.length > text.length) return false;
  for (let i = 0; i < name.length; i++) if (lowered(text[at + i]) !== lowered(name[i])) return false;
  return true;
}

/** Whether a word boundary, as CPython's `\b` reads one, falls at `at` after a word character. */
function endsWord(text: string, at: number): boolean {
  const next = text.codePointAt(at);
  return next === undefined || !isPythonWordCodePoint(next);
}

/** Where `</name\s*>` at `at` ends, or -1 where there is none. */
function closingTagEnd(text: string, at: number, name: string): number {
  if (!text.startsWith("</", at) || !holdsName(text, at + 2, name)) return -1;
  let k = at + 2 + name.length;
  while (k < text.length && PYTHON_WHITESPACE.has(text[k])) k++;
  return text[k] === ">" ? k + 1 : -1;
}

/** Where the element `name` opened before `from` closes, or -1 where the lazy match fails. */
function codeElementEnd(text: string, from: number, name: string): number {
  // The lazy `.*?`: at each position the closing tag is tried first, then a
  // step past one character unless an opening of the same element starts there.
  for (let j = from; j < text.length; j++) {
    const end = closingTagEnd(text, j, name);
    if (end >= 0) return end;
    if (text[j] === "<" && holdsName(text, j + 1, name) && endsWord(text, j + 1 + name.length)) return -1;
  }
  return -1;
}

/** Every code element in `text`, as `CODE_ELEMENT.finditer` finds them. */
export function codeElements(text: string): Region[] {
  const opening = compilePythonPattern(OPENING, "i");
  const regions: Region[] = [];
  for (let from = 0; ; ) {
    opening.lastIndex = from;
    const m = opening.exec(text);
    if (!m) return regions;
    const end = codeElementEnd(text, m.index + m[0].length, m[1]);
    if (end < 0) {
      from = m.index + 1;
      continue;
    }
    regions.push([m.index, end]);
    from = end;
  }
}

/** The element names `python-html-tokens.ts` reads as text only, as a start tag opens one: no such tag, no such content. */
const TEXT_ONLY_TAG = /<(?:script|style|xmp|iframe|noembed|noframes|textarea|title)(?![a-z0-9-])/i;

const noRange = () => false;

/** The content of each element in `text` whose content a browser takes as text. */
export function textOnlyRegions(text: string): Region[] {
  return TEXT_ONLY_TAG.test(text) ? panelHtmlReading(text, noRange).rawTexts : [];
}

/** `regions` sorted, with those that overlap made one. */
function mergedRegions(regions: readonly Region[]): Region[] {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of [...regions].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Where the text of a link is in `text`, sorted and without overlap: the
 * content of an `<a>` element as Python's HTML tokenizer reads it, outside
 * code elements.
 */
export function linkTextRegions(text: string): Region[] {
  return mergedRegions(panelHtmlReading(text, overlapTest(codeElements(text))).anchors);
}

/** One `[[term]]` or `[[term|display]]` as the syntax reads it: where it is, and its parts, `display` undefined without a `|`. */
interface Reference {
  start: number;
  end: number;
  term: string;
  display: string | undefined;
}

/** A part of a reference, stripped of whitespace; a part that is only whitespace is its last character, which the syntax keeps. */
function referencePart(part: string): string {
  return pythonStrip(part) || part.slice(-1);
}

/** Every reference in `text`, in order and without overlap. */
function references(text: string): Reference[] {
  return [...text.matchAll(compilePythonPattern(GLOSSARY_PATTERN, ""))].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    term: referencePart(m[1]),
    display: m[2] === undefined ? undefined : referencePart(m[2]),
  }));
}

/** Which link texts a reference may lie in: the regions, sorted, and their starts. */
interface LinkTextIndex {
  regions: readonly Region[];
  starts: readonly number[];
}

/** The link text holding offset `at`, or whose text begins just after it, since a `[` opening a link's text counts as inside it; or null. */
function linkTextAround({ regions, starts }: LinkTextIndex, at: number): Region | null {
  const after = firstAtLeast(starts, at + 2);
  for (const n of [after - 2, after - 1]) {
    if (n >= 0 && regions[n][0] - 1 <= at && at < regions[n][1]) return regions[n];
  }
  return null;
}

/**
 * The reference to replace when `found` lies in a link's text, with
 * `inLinkText` true; `found` itself, false, when it does not; or null when
 * there is nothing to replace. Where a link's text is `[[term]]` after a `[`,
 * the syntax reads `[term` as the term; the reference there is the inner one.
 */
function inLinkText(found: Reference, text: string, index: LinkTextIndex): { reference: Reference; inLinkText: boolean } | null {
  const region = linkTextAround(index, found.start);
  if (region === null) return { reference: found, inLinkText: false };
  if (!found.term.startsWith("[")) return { reference: found, inLinkText: found.start >= region[0] };
  const inner = references(text.slice(found.start + 1, found.end))[0];
  if (inner === undefined || inner.start !== 0) return null;
  const at = found.start + 1;
  return { reference: { ...inner, start: at, end: at + inner.end }, inLinkText: true };
}

/** How one text resolves its references: the glossary, by lower-cased id, and the site's baseurl. */
interface Resolution {
  terms: GlossaryTerms;
  byLowerCase: ReadonlyMap<string, string>;
  baseUrl: string;
}

/** What one reference becomes: a link, a missing term's marker, or, in a link's text, the text it shows. */
function resolvedReference({ term, display }: Reference, inText: boolean, { terms, byLowerCase, baseUrl }: Resolution): string {
  const written = pythonStrip(term);
  const termId = byLowerCase.get(written.toLowerCase());
  const shownDisplay = display === undefined ? undefined : pythonStrip(display);
  if (inText) return escapeHtml(htmlUnescape(shownDisplay || (termId === undefined ? written : terms.get(termId)!)));
  if (termId === undefined) {
    return `<span class="glossary-link-error" data-term-id="${escapeHtml(written)}">⚠️ [[${escapeHtml(htmlUnescape(term))}]]</span>`;
  }
  const label = shownDisplay ?? terms.get(termId)!;
  const demo = termId.startsWith("demo-") ? ' data-demo="true"' : "";
  const url = glossaryTermUrl(termId, baseUrl);
  return (
    `<a href="#" class="glossary-inline-link" data-term-id="${escapeHtml(termId)}"` +
    ` data-term-url="${escapeHtml(url)}"${demo}>${escapeHtml(htmlUnescape(label))}</a>`
  );
}

/** A test of whether a reference starting at an offset of `text` is left as written: in a tag, code or text-only content. */
function heldStretches(text: string): (start: number, end: number) => boolean {
  const tags = [...text.matchAll(TAG)].map((m): Region => [m.index, m.index + m[0].length]);
  return overlapTest([...tags, ...codeElements(text), ...textOnlyRegions(text)]);
}

/**
 * `text` with its glossary references resolved against `terms`. `baseUrl` is
 * the site's configured baseurl without its trailing slash, "" for a site at
 * a domain root. `text` is HTML, as `process_glossary_links` takes it.
 */
export function resolveGlossaryLinks(text: string, terms: GlossaryTerms, baseUrl: string): string {
  if (!text || !terms.size) return text;
  const resolution = { terms, byLowerCase: new Map([...terms.keys()].map((id) => [id.toLowerCase(), id])), baseUrl };
  const literal = heldStretches(text);
  const regions = linkTextRegions(text);
  const index = { regions, starts: regions.map(([start]) => start) };
  const pieces: string[] = [];
  let written = 0;
  for (const found of references(text)) {
    if (literal(found.start, found.start + 1)) continue;
    const placed = inLinkText(found, text, index);
    if (placed === null) continue;
    pieces.push(text.slice(written, placed.reference.start), resolvedReference(placed.reference, placed.inLinkText, resolution));
    written = placed.reference.end;
  }
  return pieces.join("") + text.slice(written);
}

/**
 * A click on a glossary link in rendered author text would follow the link's
 * `#` or the published site's address from the Compositor's page; a surface
 * that mounts the rendered text calls this on its clicks so neither happens.
 */
export function holdGlossaryLinks(event: { target: EventTarget | null; preventDefault(): void }) {
  if ((event.target as Element | null)?.closest?.("a.glossary-inline-link")) event.preventDefault();
}
