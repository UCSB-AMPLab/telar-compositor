/**
 * Browser-side panel Markdown is sanitised by `previewSanitise` before
 * insertion into the editor. A glossary pass, when given, runs on the
 * converted HTML while its formulas are still placeholders, as the
 * framework's does, and its output is sanitised again.
 * Widget chrome is created separately, so author HTML cannot impersonate controls.
 * Soft breaks follow Python Markdown's nl2br extension, and tables its
 * `extra`.
 *
 * Formulas are held out of Markdown's reach as the framework holds them
 * (`protect_latex` and `restore_latex`, scripts/telar/latex.py): the same
 * forms, found in the same order, replaced by placeholders before
 * conversion and restored after sanitising, so that KaTeX sees what the
 * author wrote. Restoring happens on the parsed, sanitised tree, never in
 * the HTML string: a formula becomes text in a text node, or text in an
 * attribute's value, so nothing inside a formula can become markup, close
 * an attribute or add a handler. A link or image address that a formula
 * turns into a scheme other than http, https or mailto is removed.
 *
 * Placeholders carry a random stem (`placeholderStem`), and every copy the
 * parser makes of one is restored. A footnote reference must land exactly once, in
 * text; where one cannot, the part is shown as written, marked as such,
 * rather than previewed with its notes wrong.
 *
 * The text KaTeX reads is the text the site's page holds. The framework
 * writes a formula back escaped once (`escapeMaths`), keeping any character
 * reference it already holds, so the page holds the formula with those
 * references decoded, in a section, entry, note, caption or credit alike.
 *
 * Given an anchor prefix, `panelMarkdown` converts footnotes as the
 * framework converts a widget section or bibliography entry: references
 * numbered by readNotes (footnoteSyntax.ts), in reference order within the
 * text, and the notes in a list at its end, each with one back link per
 * reference, the last of two definitions sharing a label winning. Anchors
 * are the preview's own, prefixed so that no two notes on the page share
 * one. A caption or credit takes no footnotes, as on the site.
 *
 * A bracket or a pipe written as an entity (`&#91;`, `&lsqb;`, `&#124;` and
 * the like) stays an entity in Python Markdown's HTML, so the framework's
 * glossary pass, which reads that HTML, never takes it for part of
 * `[[…|…]]`, and escapes it again inside a display text. The preview's sanitiser decodes
 * entities, so the conversion holds each such entity out of Markdown and the
 * sanitiser as a placeholder and writes it back as the entity before the
 * glossary pass, or as its text inside code, where Python Markdown escapes
 * it.
 *
 * @version v1.5.0-beta
 */
import { EditorState } from "@codemirror/state";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { Marked, Renderer } from "marked";
import sanitizeHtml from "sanitize-html";
import { previewSanitise } from "~/lib/preview-sanitise";
import { htmlUnescape } from "~/lib/html-unescape";
import { escapeMaths, hasLatex, protectLatex } from "./latex";
import { smartTypography } from "./smartTypography";
import { readNotes, type NoteReference, type NumberedNote } from "./footnoteSyntax";
/**
 * Python Markdown with `extra`, `nl2br` and `smarty`: tables, with their
 * alignment as `extra` writes it, but no bare-address links or strikethrough,
 * which are GFM's and not Python Markdown's. An image's attributes come in
 * Python Markdown's order, `alt` before `src`. Quotes, dashes and ellipses in
 * a run of text are made typographic (smartTypography.ts); a backslash escape,
 * code and raw HTML are not.
 */
const markdown = new Marked({
  gfm: true,
  tokenizer: { url: () => undefined, del: () => undefined },
  renderer: {
    image(token) {
      const html = Renderer.prototype.image.call(this, token);
      return html.replace(/^<img src="([^"]*)" alt="([^"]*)"/, '<img alt="$2" src="$1"');
    },
    br: () => "<br>\n",
    text(token) {
      const plain = token.type === "escape" || ("tokens" in token && token.tokens) || ("escaped" in token && token.escaped);
      return Renderer.prototype.text.call(this, plain ? token : { ...token, text: smartTypography(token.text) });
    },
    tablecell({ tokens, header, align }) {
      const tag = header ? "th" : "td";
      const style = align ? ` style="text-align: ${align};"` : "";
      return `<${tag}${style}>${this.parser.parseInline(tokens)}</${tag}>\n`;
    },
  },
  extensions: [
    {
      name: "br",
      level: "inline",
      start: (source) => source.indexOf("\n"),
      tokenizer: (source) =>
        source.startsWith("\n") ? { type: "br", raw: "\n" } : undefined,
    },
  ],
});

/** `text` as the panel converter writes it, before sanitising, with nothing held out. */
export const convertMarkdown = (text: string): string => markdown.parse(text, { async: false });

const URL_ATTRIBUTES = new Set(["href", "src"]);
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

/** Twelve random capital letters. */
function randomStem(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => String.fromCharCode(65 + (b % 26))).join("");
}

let drawStem: (text: string) => string = randomStem;

/**
 * Replaces the stem source, for tests; null restores it. The source is
 * handed the text of the conversion the stem is for.
 */
export function setPlaceholderStemSource(source: ((text: string) => string) | null): void {
  drawStem = source ?? randomStem;
}

/** Entities decoded, tags left as they are. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);?/gi, (entity) => {
    const template = document.createElement("template");
    template.innerHTML = entity;
    return template.content.textContent ?? entity;
  });
}

const stripTags = (text: string) => text.replace(/<[^>]*>/g, "");

/**
 * Every form the author's text can take on its way to the output: as
 * written, with its entities decoded, with its tags removed, and both, in
 * either order.
 */
function authorForms(text: string): string[] {
  const decoded = decodeEntities(text);
  const stripped = stripTags(text);
  return [text, decoded, stripped, stripTags(decoded), decodeEntities(stripped)];
}

/**
 * A stem for one conversion's placeholders: twelve random letters from
 * `crypto.getRandomValues`, drawn afresh for every conversion and never
 * shown to the author before it is used, and absent from the author's text
 * as written, with entities decoded, with tags removed, and both.
 *
 * What the stem protects is correctness: author text that happened to hold
 * a placeholder would be restored as a formula or a note. The check above
 * catches text pasted from an earlier preview or page; anything else would
 * need the author to write twelve letters no one could know in advance, a
 * chance of 26^-12 for each placeholder. The stem is not what keeps the
 * preview safe: restoration puts text into text nodes and attribute values
 * through the DOM, and checks the scheme of every restored link and image
 * address, whatever the stem.
 */
export function placeholderStem(text: string): string {
  const forms = authorForms(text);
  for (;;) {
    const stem = drawStem(text);
    if (!forms.some((form) => form.includes(`TLATEX${stem}`) || form.includes(`TFNREF${stem}`))) return stem;
  }
}

/** A bracket or a pipe as a character reference, which Python Markdown keeps as it is. */
const BRACKET_ENTITY = /&(?:#0*(?:9[13]|124)|#[xX]0*(?:5[bBdD]|7[cC])|lsqb|rsqb|lbrack|rbrack|vert|verbar|VerticalLine);/g;

/** Bracket and pipe entities held out of one conversion, each by its placeholder. */
interface HeldBrackets {
  text: string;
  pattern: RegExp | null;
  entities: Map<string, string>;
}

/**
 * `text` with each bracket or pipe entity replaced by a placeholder of a
 * stem the text does not hold. A placeholder opens with a digit, so after
 * `<` or `</` it cannot be read as a tag name, as the entity is not. Entities
 * that differ only in letter case share one placeholder, so a reference
 * label holding one still matches its definition, which Python Markdown
 * compares without case.
 */
function holdBracketEntities(text: string): HeldBrackets {
  if (!text.match(BRACKET_ENTITY)) return { text, pattern: null, entities: new Map() };
  const forms = authorForms(text);
  let stem = drawStem(text);
  while (forms.some((form) => form.includes(`TBRACKET${stem}`))) stem = drawStem(text);
  const entities = new Map<string, string>();
  const keys = new Map<string, string>();
  const held = text.replace(BRACKET_ENTITY, (entity) => {
    const folded = entity.toLowerCase();
    let key = keys.get(folded);
    if (key === undefined) {
      key = `0TBRACKET${stem}${keys.size}END`;
      keys.set(folded, key);
      entities.set(key, entity);
    }
    return key;
  });
  return { text: held, pattern: new RegExp(`0TBRACKET${stem}\\d+END`, "g"), entities };
}

/**
 * The held entities written back into converted HTML: inside code as the
 * entity's own text, as Python Markdown escapes it there, and everywhere
 * else as the entity itself, so the glossary pass reads what the
 * framework's reads.
 */
function putBracketEntitiesBack(html: string, held: HeldBrackets): string {
  const { pattern, entities } = held;
  if (!pattern) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const inCode: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("code, pre")) inCode.push(node);
  }
  for (const node of inCode) node.data = node.data.replace(pattern, (key) => entities.get(key) ?? key);
  return template.innerHTML.replace(pattern, (key) => entities.get(key) ?? key);
}

/** What the placeholders in one converted text stand for. */
interface Placeholders {
  /** This conversion's placeholders, and nothing else. */
  pattern: RegExp;
  /**
   * Formula placeholders and the source each stands for. A formula found
   * inside another is already the author's text inside the outer one's
   * source (`protectLatex`), as in the framework's `protect_latex`.
   */
  latex: Map<string, string>;
  /** Reference placeholders and the label each references. */
  refs: Map<string, string>;
  /** Builds a reference's element, taking the next back link for its label. */
  reference?: (label: string) => HTMLElement;
  /** How many times each reference placeholder has been put back; each must be once. */
  placed: Map<string, number>;
}

/** The text a placeholder stands for inside an attribute's value. */
function asText(placeholder: string, marks: Placeholders): string {
  if (marks.latex.has(placeholder)) return htmlUnescape(escapeMaths(marks.latex.get(placeholder)!));
  return `[^${marks.refs.get(placeholder)}]`;
}

function unsafeUrl(value: string): boolean {
  const scheme = /^[\s\u0000-\u001f]*([a-z][a-z\d+.-]*):/i.exec(value);
  return !!scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase());
}

function restoreAttributes(element: Element, marks: Placeholders): void {
  for (const { name, value } of [...element.attributes]) {
    if (!value.match(marks.pattern)) continue;
    const restored = value.replace(marks.pattern, (p) => {
      if (marks.refs.has(p)) marks.placed.set(p, Infinity);
      return known(p, marks) ? asText(p, marks) : p;
    });
    if (URL_ATTRIBUTES.has(name) && unsafeUrl(restored)) element.removeAttribute(name);
    else element.setAttribute(name, restored);
  }
}

function known(placeholder: string, marks: Placeholders): boolean {
  return marks.latex.has(placeholder) || marks.refs.has(placeholder);
}

/** The node a placeholder in text becomes: a formula's text, or a reference. */
function placeholderNode(doc: Document, placeholder: string, marks: Placeholders): Node {
  const label = marks.refs.get(placeholder);
  if (label !== undefined) marks.placed.set(placeholder, (marks.placed.get(placeholder) ?? 0) + 1);
  if (label !== undefined && marks.reference) return marks.reference(label);
  return doc.createTextNode(asText(placeholder, marks));
}

function restoreText(node: Text, marks: Placeholders): void {
  const parts = node.data.split(new RegExp(`(${marks.pattern.source})`));
  if (parts.length === 1) return;
  const doc = node.ownerDocument;
  const nodes = parts.map((part, i) =>
    i % 2 && known(part, marks) ? placeholderNode(doc, part, marks) : doc.createTextNode(part),
  );
  node.replaceWith(...nodes);
}

/**
 * Put formulas and references back into sanitised HTML, through the DOM.
 * Every copy of a formula is put back. A reference must land exactly once,
 * in text: one the parser dropped, copied or moved into an attribute would
 * number the notes wrongly, so the conversion is refused (null) instead.
 */
function restore(html: string, marks: Placeholders): string | null {
  if (!marks.latex.size && !marks.refs.size) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) restoreText(node as Text, marks);
    else restoreAttributes(node as Element, marks);
  }
  const placedOnce = [...marks.refs.keys()].every((key) => marks.placed.get(key) === 1);
  return placedOnce ? template.innerHTML : null;
}

type ReferenceSpan = { from: number; to: number; label: string };

/** The source with each reference span replaced by a placeholder of `nonce`. */
function withReferencePlaceholders(source: string, spans: ReferenceSpan[], nonce: string) {
  let text = source;
  const refs = new Map<string, string>();
  for (const span of [...spans].sort((a, b) => b.from - a.from)) {
    const key = `TFNREF${nonce}${refs.size}END`;
    refs.set(key, span.label);
    text = text.slice(0, span.from) + key + text.slice(span.to);
  }
  return { text, refs };
}

type References = { spans: ReferenceSpan[]; reference: (label: string) => HTMLElement };

/**
 * One conversion, formulas held out and footnote references marked with a
 * stem the author's text cannot contain. Null when its references cannot
 * be put back where they belong.
 */
function convert(source: string, cleaner: Cleaner, references?: References): string | null {
  const spans = references?.spans ?? [];
  if (!spans.length && !hasLatex(source)) {
    const brackets = holdBracketEntities(source);
    const html = cleaner.clean(markdown.parse(brackets.text, { async: false }));
    return linked(putBracketEntitiesBack(html, brackets), cleaner);
  }
  const stem = placeholderStem(source);
  const { text: marked, refs } = withReferencePlaceholders(source, spans, stem);
  const { text: withoutLatex, held } = protectLatex(marked, `TLATEX${stem}`);
  const brackets = holdBracketEntities(withoutLatex);
  const html = linked(putBracketEntitiesBack(cleaner.clean(markdown.parse(brackets.text, { async: false })), brackets), cleaner);
  const pattern = new RegExp(`T(?:LATEX|FNREF)${stem}\\d+END`, "g");
  const reference = references?.reference;
  return restore(html, { pattern, latex: new Map(held), refs, reference, placed: new Map() });
}

/**
 * The glossary pass, where the framework runs it: on the converted HTML
 * while formulas and footnote references are still placeholders, so a
 * `[[term]]` inside a formula stays as written. Its output is sanitised again.
 */
function linked(html: string, cleaner: Cleaner): string {
  return cleaner.links ? previewSanitise(cleaner.links(html)) : html;
}

/** A conversion's footnotes: numbers by label, back-link count, anchors. */
class NoteAnchors {
  private seen = new Map<string, number>();
  /**
   * `counts` holds every reference to each label in the conversion, the
   * notes' own included, so a note's back links are complete even when a
   * later note references it.
   */
  constructor(
    readonly prefix: string,
    readonly numbers: Map<string, number>,
    readonly counts: Map<string, number>,
  ) {}
  noteId(label: string) {
    return `pfn-${this.prefix}-${this.numbers.get(label)}`;
  }
  refId(label: string, k: number) {
    return `pfnref-${this.prefix}-${this.numbers.get(label)}-${k}`;
  }
  /** The element of the next reference to `label`. */
  reference(label: string): HTMLElement {
    const k = (this.seen.get(label) ?? 0) + 1;
    this.seen.set(label, k);
    const sup = document.createElement("sup");
    sup.id = this.refId(label, k);
    const link = document.createElement("a");
    link.className = "footnote-ref";
    link.setAttribute("href", `#${this.noteId(label)}`);
    link.textContent = String(this.numbers.get(label));
    sup.appendChild(link);
    return sup;
  }
  /** One back link per reference; a note no one references keeps one that goes nowhere. */
  backLinks(label: string): string {
    const count = this.counts.get(label) ?? 0;
    if (!count) return '<a class="footnote-backref">&#8617;</a>';
    return Array.from({ length: count }, (_, i) => `<a class="footnote-backref" href="#${this.refId(label, i + 1)}">&#8617;</a>`).join("");
  }
}

/** Replace the spans with placeholders, converting, then put references in. */
function convertWithReferences(text: string, spans: ReferenceSpan[], anchors: NoteAnchors, cleaner: Cleaner): string | null {
  return convert(text, cleaner, { spans, reference: (label) => anchors.reference(label) });
}

/**
 * The references readNotes found inside a note, as offsets in the note's
 * text, which has its continuation indentation removed.
 */
function referencesInNote(source: string, note: NumberedNote, references: NoteReference[]) {
  const after = source.slice(note.marker.to, note.to);
  const start = note.marker.to + (after.length - after.trimStart().length);
  const raw = source.slice(start, note.to);
  const indents = [...raw.matchAll(/\n( {4}|\t)/g)];
  const toText = (at: number) =>
    at - start - indents.filter((m) => m.index + 1 < at - start).reduce((n, m) => n + m[1].length, 0);
  return references
    .filter((r) => r.from >= start && r.to <= note.to)
    .map((r) => ({ from: toText(r.from), to: toText(r.to), label: r.label }));
}

function noteItem(
  note: NumberedNote,
  anchors: NoteAnchors,
  spans: ReturnType<typeof referencesInNote>,
  cleaner: Cleaner,
): string | null {
  const body = convertWithReferences(note.text, spans, anchors, cleaner);
  if (body === null) return null;
  const back = `&#160;${anchors.backLinks(note.label)}`;
  const trimmed = body.trimEnd();
  const inner = trimmed.endsWith("</p>") ? `${trimmed.slice(0, -4)}${back}</p>` : `${trimmed}<p>${back}</p>`;
  return `<li id="${anchors.noteId(note.label)}">${inner}</li>`;
}

/** The text with its definitions taken out, and its references outside them. */
export function mainText(source: string, references: NoteReference[], notes: NumberedNote[]) {
  const inNote = (r: NoteReference) => notes.some((n) => n.from <= r.from && r.to <= n.to);
  const refs = references.filter((r) => !inNote(r));
  let text = source;
  const spans = refs.map((r) => ({ from: r.from, to: r.to, label: r.label }));
  for (const note of [...notes].sort((a, b) => b.from - a.from)) {
    const end = source[note.to] === "\n" ? note.to + 1 : note.to;
    text = text.slice(0, note.from) + text.slice(end);
    for (const span of spans) if (span.from > note.from) {
      span.from -= end - note.from;
      span.to -= end - note.from;
    }
  }
  return { text, spans };
}

function withFootnotes(source: string, prefix: string, cleaner: Cleaner): string | null {
  const read = readNotes(EditorState.create({ doc: source, extensions: [markdownLanguage()] }));
  const notes = read.notes.filter((n) => n.scope.kind === "top");
  if (!notes.length) return convert(source, cleaner);
  const numbers = new Map(notes.map((n) => [n.label, n.number]));
  const topReferences = read.references.filter((r) => r.scope.kind === "top");
  const { text, spans } = mainText(source, topReferences, notes);
  const lastByLabel = new Map(notes.map((n) => [n.label, n]));
  const listed = [...lastByLabel.values()].sort((a, b) => a.number - b.number);
  const noteSpans = listed.map((n) => referencesInNote(source, n, topReferences));
  const counts = new Map<string, number>();
  for (const span of [...spans, ...noteSpans.flat()]) counts.set(span.label, (counts.get(span.label) ?? 0) + 1);
  const anchors = new NoteAnchors(prefix, numbers, counts);
  const html = convertWithReferences(text, spans, anchors, cleaner);
  const items = listed.map((n, i) => noteItem(n, anchors, noteSpans[i], cleaner));
  if (html === null || items.includes(null)) return null;
  return `${html}<div class="footnote"><hr><ol>${items.join("")}</ol></div>`;
}

/** Author text as written, in an element of the preview's own, with `label` saying why. */
function asWritten(tag: "div" | "span", source: string, label: string): string {
  const element = document.createElement(tag);
  element.className = "cm-panel-unavailable";
  if (tag === "span") {
    element.title = label;
    element.textContent = source;
    return element.outerHTML;
  }
  const note = document.createElement("p");
  note.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = source;
  element.appendChild(note);
  element.appendChild(pre);
  return element.outerHTML;
}

/** Rewrites finished HTML: the glossary pass. */
export type HtmlTransform = (html: string) => string;

/** How a conversion's HTML is cleaned, and the glossary pass that runs before its formulas are restored. */
interface Cleaner {
  clean: (html: string) => string;
  links?: HtmlTransform;
}

/** A section, entry, note or top-level text: the preview sanitiser, then the glossary pass. */
function bodyCleaner(links?: HtmlTransform): Cleaner {
  return { clean: previewSanitise, links };
}

/**
 * Panel Markdown for the preview. With `footnotePrefix` the text is one of
 * the framework's footnote conversions and its notes are rendered with it.
 * A text whose references cannot be put back is shown as written, with
 * `unavailable` saying so, rather than previewed with notes missing.
 * `links` is the glossary pass, which the framework runs on converted HTML.
 */
export function panelMarkdown(source: string, footnotePrefix?: string, unavailable = "", links?: HtmlTransform): string {
  const cleaner = bodyCleaner(links);
  const html = footnotePrefix === undefined ? convert(source, cleaner) : withFootnotes(source, footnotePrefix, cleaner);
  return html ?? asWritten("div", source, unavailable);
}

const sanitiseCaption = (html: string) =>
  sanitizeHtml(html.replace(/^<p>|<\/p>\s*$/g, ""), {
    allowedTags: ["em", "strong", "i", "b", "a", "code", "sup", "sub", "br"],
    allowedAttributes: { a: ["href", "title"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  });

/**
 * A carousel caption or credit: the framework's caption sanitiser, then,
 * with `links`, the glossary pass, which on the site runs over the whole
 * panel afterwards.
 */
export function panelCaption(source: string, unavailable = "", links?: HtmlTransform): string {
  return convert(source, { clean: sanitiseCaption, links }) ?? asWritten("span", source, unavailable);
}
