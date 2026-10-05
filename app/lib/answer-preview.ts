/**
 * answer-preview — a step's answer rendered to the HTML the build publishes,
 * a port of `render_answer` (scripts/telar/processors/stories.py) on the
 * panel converter (panelPreview.ts), in the build's order:
 *
 *   1. line endings normalised and the text stripped; widget blocks removed
 *      as `_remove_widget_blocks` removes them;
 *   2. footnote definitions and references taken out of the text, as
 *      readNotes finds them (footnoteSyntax.ts). The build converts them
 *      and then drops both parts, which leaves the same words;
 *   3. the text converted as a panel is (Python Markdown with `extra`,
 *      `nl2br` and `smarty`), formulas held out as placeholders;
 *   4. made prose as `_AnswerProse` makes it: media, tables, code blocks and
 *      rules removed with what is inside them; headings, quotes and lists
 *      made paragraphs; empty paragraphs removed;
 *   5. glossary links, as in a panel;
 *   6. measured, and cut to the budget (`~/lib/answer-budget`);
 *      each formula's placeholder has the 21 characters of the build's
 *      (`TLATEX`, twelve hex digits, `END`), because the budget counts a
 *      placeholder's characters; past 9,999 formulas in one answer the
 *      placeholders are longer than the build's;
 *   7. formulas written back as text, escaped once (`escapeMaths`), and the
 *      whole sanitised (`previewSanitise`). The sanitiser runs last, so a
 *      formula written into an attribute cannot add one.
 *
 * It reads and writes strings only, with no DOM, so it runs in the editor's
 * server render and in the publish check. Not modelled: `_close_html_blocks`,
 * which closes block HTML an answer leaves open.
 *
 * The kinds are counted as the Compositor names them. The framework reports
 * four (media, widgets, footnotes, markup); each kind here is one of them.
 *
 * @version v1.5.0-beta
 */

import { EditorState } from "@codemirror/state";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { cutToBudget, htmlTokens, measureAnswer, smallType, withinBudget, type HtmlToken, type Measure } from "~/lib/answer-budget";
import { htmlUnescape } from "~/lib/html-unescape";
import { resolveGlossaryLinks, type GlossaryTerms } from "~/lib/glossary-links";
import type { GlossaryKinds } from "~/lib/glossary-kinds";
import { previewSanitise } from "~/lib/preview-sanitise";
import { compilePythonPattern } from "~/lib/python-regex";
import { pythonStrip } from "~/lib/python-whitespace";
import { escapeMaths, protectLatex, type Held } from "~/components/ui/markdown-editor/latex";
import { readNotes } from "~/components/ui/markdown-editor/footnoteSyntax";
import { convertMarkdown, mainText } from "~/components/ui/markdown-editor/panelPreview";

/** The site's glossary as the build reads it, and the baseurl its links carry. */
export interface GlossaryContext {
  terms: GlossaryTerms;
  /** The site's configured baseurl without a trailing slash; "" at a domain root. */
  baseUrl: string;
  /** The kinds the site offers, which a glossary callout shows; none while unknown. */
  kinds?: GlossaryKinds;
  /** Each term's `kind` as stored, by term id; a term missing here is of the default kind. */
  entryKinds?: ReadonlyMap<string, string>;
}

/** What an answer may not hold at all, since the build removes it with its words, in the order a reader is told. */
export const ANSWER_REMOVED_KINDS = ["image", "embed", "footnote", "table", "code_block", "widget"] as const;
/** What an answer loses the look of and keeps the words of; a rule has no words. */
export const ANSWER_FORMAT_KINDS = ["list", "heading", "blockquote", "rule"] as const;

export type AnswerKind = (typeof ANSWER_REMOVED_KINDS)[number] | (typeof ANSWER_FORMAT_KINDS)[number];
export type AnswerKinds = Record<AnswerKind, number>;

export interface RenderedAnswer {
  /** The sanitised HTML, before formulas are typeset. */
  html: string;
  /** How many of each kind came out of the answer or lost their look. */
  kinds: AnswerKinds;
  /** Words, paragraphs and lines before any cut. */
  measure: Measure;
  /** Whether the answer is over the budget, so that the build cuts it. */
  cut: boolean;
  /** Whether the published answer is set in the smaller type (`answer_long`). */
  long: boolean;
}

const WIDGET_OPEN = /[ \t]*:::[A-Za-z0-9_]+[ \t]*\n/y;
const WIDGET_CLOSE = /[ \t]*:::[ \t]*(?=\n|$)/y;

/** Where `pattern` matches at `at`: the end of the match, or -1. */
function widgetLineEnd(pattern: RegExp, text: string, at: number): number {
  pattern.lastIndex = at;
  return pattern.test(text) ? pattern.lastIndex : -1;
}

/** `_remove_widget_blocks`: `text` without its widget blocks, and how many there were. */
function removeWidgetBlocks(text: string): { text: string; count: number } {
  const starts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)];
  const total = starts.length;
  // nextClose[i] is the first line from i on that is `:::` alone.
  const nextClose = new Array<number>(total + 1).fill(total);
  for (let i = total - 1; i >= 0; i--) nextClose[i] = widgetLineEnd(WIDGET_CLOSE, text, starts[i]) >= 0 ? i : nextClose[i + 1];
  const pieces: string[] = [];
  let kept = 0;
  let count = 0;
  for (let i = 0; i < total - 1; i++) {
    if (widgetLineEnd(WIDGET_OPEN, text, starts[i]) < 0 || nextClose[i + 1] >= total) continue;
    const j = nextClose[i + 1];
    const end = widgetLineEnd(WIDGET_CLOSE, text, starts[j]);
    pieces.push(text.slice(kept, starts[i]));
    kept = text[end] === "\n" ? end + 1 : end;
    count += 1;
    i = j;
  }
  pieces.push(text.slice(kept));
  return { text: pieces.join(""), count };
}

/** `text` without its footnote definitions and references, and how many of both there were. */
function removeFootnotes(text: string): { text: string; count: number } {
  if (!text.includes("[^")) return { text, count: 0 };
  const read = readNotes(EditorState.create({ doc: text, extensions: [markdownLanguage()] }));
  const notes = read.notes.filter((n) => n.scope.kind === "top");
  if (!notes.length) return { text, count: 0 };
  const main = mainText(text, read.references.filter((r) => r.scope.kind === "top"), notes);
  let out = main.text;
  for (const span of [...main.spans].sort((a, b) => b.from - a.from)) out = out.slice(0, span.from) + out.slice(span.to);
  return { text: out, count: notes.length + main.spans.length };
}

/** Elements an answer loses with everything inside them, by kind. */
const DROPPED: ReadonlyMap<string, AnswerKind> = new Map([
  ["img", "image"], ["iframe", "embed"], ["video", "embed"], ["audio", "embed"], ["embed", "embed"], ["object", "embed"],
  ["table", "table"], ["pre", "code_block"], ["hr", "rule"],
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const UNWRAPPED: ReadonlyMap<string, AnswerKind> = new Map([["blockquote", "blockquote"], ["ul", "list"], ["ol", "list"]]);
/** The two pieces the footnotes extension writes, when an author writes them as HTML. */
const FOOTNOTE_PART = /^<(?:sup\b[^>]*\bid="fnref|div\b[^>]*\bclass="footnote")/;
const EMPTY_PARAGRAPH = compilePythonPattern(String.raw`<p\b[^>]*>\s*</p>\n?`, "g");

/** `_AnswerProse`: rendered answer HTML read once as prose, counting what it takes out into `kinds`. */
class AnswerProse {
  private readonly out: string[] = [];
  private dropping: { name: string; depth: number } | null = null;
  private readonly items: boolean[] = [];

  constructor(private readonly kinds: AnswerKinds) {}

  take(token: HtmlToken): void {
    if (this.dropping) return this.skip(token);
    if (this.drops(token)) return;
    const unwrapped = HEADINGS.has(token.name) ? "heading" : UNWRAPPED.get(token.name);
    if (unwrapped) return this.unwrap(token, unwrapped);
    if (token.name === "li") return this.listItem(token);
    if (token.name === "p" && token.kind === "start") this.endItem();
    this.out.push(token.raw);
  }

  html(): string {
    return this.out.join("").replace(EMPTY_PARAGRAPH, "");
  }

  /** Whether `token` opens or is something the answer loses. */
  private drops(token: HtmlToken): boolean {
    if (token.kind !== "start" && token.kind !== "void" && token.kind !== "end") return false;
    const kind = DROPPED.get(token.name) ?? (token.kind === "start" && FOOTNOTE_PART.test(token.raw) ? "footnote" : undefined);
    if (kind === undefined) return false;
    if (token.kind !== "end") this.kinds[kind] += 1;
    if (token.kind === "start") this.dropping = { name: token.name, depth: 1 };
    return true;
  }

  /** A heading's tags become a paragraph's; a quote's and a list's are taken out. */
  private unwrap(token: HtmlToken, kind: AnswerKind): void {
    this.kinds[kind] += token.kind === "start" ? 1 : 0;
    this.endItem();
    if (kind === "heading") this.out.push(token.kind === "start" ? "<p>" : "</p>");
  }

  private skip(token: HtmlToken): void {
    const dropping = this.dropping!;
    if (token.name !== dropping.name) return;
    dropping.depth += token.kind === "start" ? 1 : token.kind === "end" ? -1 : 0;
    if (!dropping.depth) this.dropping = null;
  }

  private listItem(token: HtmlToken): void {
    if (token.kind === "start") {
      this.kinds.list += 1;
      this.endItem();
      this.out.push("<p>");
      this.items.push(true);
    } else if (this.items.length && this.items.pop()) this.out.push("</p>");
  }

  /** Closes the paragraph a list item opened, before a block inside it. */
  private endItem(): void {
    if (this.items.at(-1)) {
      this.out.push("</p>");
      this.items[this.items.length - 1] = false;
    }
  }
}

/** Eight random capitals that `text`, as written or decoded, does not hold after `TLATEX`. */
function mathsStem(text: string): string {
  const forms = [text, htmlUnescape(text)];
  for (;;) {
    const stem = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => String.fromCharCode(65 + (b % 26))).join("");
    if (!forms.some((form) => form.includes(`TLATEX${stem}`))) return stem;
  }
}

/**
 * `text` with each of `protectLatex`'s placeholders under `TLATEX` and `stem`
 * padded to four digits, so that it is as long as the build's, and each
 * padded placeholder's formula.
 */
function padPlaceholders(text: string, held: Held, stem: string): { text: string; formulas: Map<string, string> } {
  const prefix = `TLATEX${stem}`;
  const toBuildLength = (placeholder: string) => `${prefix}${placeholder.slice(prefix.length, -3).padStart(4, "0")}END`;
  const formulas = new Map(held.map(([placeholder, original]) => [toBuildLength(placeholder), original] as const));
  return { text: text.replace(new RegExp(`${prefix}\\d+END`, "g"), toBuildLength), formulas };
}

const noKinds = (): AnswerKinds => ({
  image: 0, embed: 0, footnote: 0, table: 0, code_block: 0, widget: 0, list: 0, heading: 0, blockquote: 0, rule: 0,
});

/** A step's answer, as written, rendered as the build publishes it. */
export function renderAnswer(answer: string, glossary: GlossaryContext): RenderedAnswer {
  const kinds = noKinds();
  const widgets = removeWidgetBlocks(pythonStrip(answer.replace(/\r\n?/g, "\n")));
  const notes = removeFootnotes(widgets.text);
  kinds.widget = widgets.count;
  kinds.footnote = notes.count;
  const stem = mathsStem(notes.text);
  const protectedText = protectLatex(notes.text, `TLATEX${stem}`);
  const { text, formulas } = padPlaceholders(protectedText.text, protectedText.held, stem);
  const prose = new AnswerProse(kinds);
  for (const token of htmlTokens(convertMarkdown(text))) prose.take(token);
  const linked = resolveGlossaryLinks(prose.html(), glossary.terms, glossary.baseUrl);
  const measure = measureAnswer(linked);
  const restored = cutToBudget(linked).replace(new RegExp(`TLATEX${stem}\\d+END`, "g"), (p) =>
    formulas.has(p) ? escapeMaths(formulas.get(p)!) : p,
  );
  return {
    html: previewSanitise(restored),
    kinds,
    measure,
    cut: !withinBudget(measure),
    long: smallType(measureAnswer(restored)),
  };
}

const NO_GLOSSARY: GlossaryContext = { terms: new Map(), baseUrl: "" };

/**
 * Whether `next` holds more of any removed kind than `current` does: measured
 * as an increase, so an answer that already holds one can still be edited
 * until it is gone.
 */
export function addsRemovedContent(current: string, next: string): boolean {
  const before = renderAnswer(current, NO_GLOSSARY).kinds;
  const after = renderAnswer(next, NO_GLOSSARY).kinds;
  return ANSWER_REMOVED_KINDS.some((kind) => after[kind] > before[kind]);
}
