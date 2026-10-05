/**
 * card-markdown — author text rendered as the site publishes it, for the
 * framing stage's step card and layer panels. Two pipelines, each in the
 * build's own order, each ending in `previewSanitise`; formulas are typeset
 * afterwards on the sanitised DOM by `typesetPreview`, as the site typesets
 * at runtime.
 *
 * The step card's answer (`answerHtml`) is `renderAnswer`
 * (`~/lib/answer-preview`), the build's `render_answer` on the panel
 * converter.
 *
 * The story intro's byline (`bylineHtml`) is that converter's output with
 * every `<p>` and `</p>` removed, as the story layout prints it
 * (`markdownify | remove: '<p>' | remove: '</p>'`). The site converts it with
 * kramdown; for a byline's one line of inline Markdown the two agree.
 *
 * A layer panel (`renderPanel`), in the order of the framework's layer path
 * (`_process_content_columns` and `process_inline_content`):
 *
 *   1. line endings normalised and the text stripped;
 *   2. front matter split off as `_split_frontmatter` does, only when the
 *      block has a `title:` key;
 *   3. widgets found as `process_widgets` finds them, fenced code included,
 *      each held out as a block of its own and returned for `WidgetPreview`;
 *      a glossary callout (`:::glossary`) is held out too, as the slot the
 *      framework's glossary pass fills, and drawn here once the text is
 *      HTML (glossary-callout.ts), after the pass over the text's own links;
 *   4. images as `process_images` writes them: a figure, the size class, a
 *      caption from the next line, relative paths under
 *      `<baseurl>/telar-content/objects/`, alt text holding brackets one
 *      level deep, its entities decoded and then escaped; an image inside a
 *      line of text stays there, its relative path resolved the same way
 *      (`_resolve_inline_images`);
 *   5. Markdown as panelPreview.ts converts it (Python Markdown with `extra`
 *      and `nl2br`), footnotes numbered for the top level;
 *   6. the glossary pass on the converted HTML, sections, notes, captions
 *      and the figures' own markup included, so a `[[…]]` in alt text is
 *      resolved inside the attribute as the site resolves it;
 *   7. `fixImageUrls` (assets/js/telar-story/utils.js), which the site runs on
 *      panel HTML before a reader sees it: the baseurl in front of every
 *      root-absolute image address not already under it, so `/assets/a.jpg`
 *      reads `/telar/assets/a.jpg` on a site at `/telar` and a relative
 *      image from step 4 keeps its one baseurl.
 *
 * The addresses stay the site's own unless `origin` is given: the framing
 * stage gives the site's origin, and every root-relative image address is
 * then read from it (`imagesFromOrigin`), so an image loads inside the
 * editor as it does on the site. `widgetImages` does the same for the
 * Markdown a widget renders. Glossary definitions never pass through step 7
 * on the site; step 4 alone gives their images the baseurl, and nothing here
 * applies step 7 to them.
 *
 * Where a widget or a figure stood, the HTML holds an empty
 * `<div data-panel-widget="n">` or the figure itself; the widget is drawn by
 * `WidgetPreview` with the same glossary pass. A widget of a type the
 * framework does not know has no block, and its source is kept. Each widget
 * carries its span in the panel's text with its line endings normalised,
 * the text an editor of the panel holds, front matter and the stripped
 * whitespace included, so a click on the widget can be taken to its source.
 *
 * The oracles (tests/fixtures/answer-preview.py, panel-rendering.py)
 * establish the contract; the recorded differences are in
 * answer-preview-parity.test.ts and card-markdown-parity.test.tsx.
 *
 * A glossary link's `href` is `#` and its `data-term-url` belongs to the
 * published site: whatever mounts this output must not follow either.
 *
 * @version v1.5.0-beta
 */

import { load as loadYaml } from "js-yaml";
import { EditorState } from "@codemirror/state";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { compilePythonPattern } from "~/lib/python-regex";
import { pythonStrip } from "~/lib/python-whitespace";
import { escapeHtml, resolveGlossaryLinks } from "~/lib/glossary-links";
import { glossaryCalloutHtml, parseGlossaryCallout } from "~/lib/glossary-callout";
import { renderAnswer, type GlossaryContext } from "~/lib/answer-preview";
import { htmlUnescape } from "~/lib/html-unescape";
import { previewSanitise } from "~/lib/preview-sanitise";
import { findWidgets } from "~/components/ui/markdown-editor/footnoteScopes";
import { parsePanel, type PanelWidget } from "~/components/ui/markdown-editor/panelSource";
import { convertMarkdown, panelMarkdown, placeholderStem, type HtmlTransform } from "~/components/ui/markdown-editor/panelPreview";
import {
  panelMathDelimiters,
  renderPanelMath,
  type MathDelimiter,
  type PanelMathRun,
} from "~/components/ui/markdown-editor/panelMath";

export type { GlossaryContext };

/** The answer's sanitised HTML, before formulas are typeset. */
export function answerHtml(answer: string, glossary: GlossaryContext): string {
  return answerCard(answer, glossary).html;
}

/** The answer's sanitised HTML, and whether the site sets it in the smaller type (`step-answer--long`). */
export function answerCard(answer: string, glossary: GlossaryContext): { html: string; long: boolean } {
  const { html, long } = renderAnswer(answer, glossary);
  return { html, long };
}

/** The story's byline as the published intro prints it, sanitised. */
export function bylineHtml(byline: string): string {
  return previewSanitise(convertMarkdown(byline).replaceAll("<p>", "").replaceAll("</p>", ""));
}

/**
 * Typesets the formulas in rendered, sanitised text as the site does at
 * runtime, with the site's delimiters (`_data/katex.yml`).
 */
export function typesetPreview(
  element: HTMLElement,
  delimiters: MathDelimiter[] = panelMathDelimiters,
  run?: PanelMathRun,
): Promise<void> {
  return renderPanelMath(element, delimiters, run);
}

// ---------------------------------------------------------------- a panel

/** `FRONTMATTER_PATTERN` and `TITLE_PATTERN`, scripts/telar/markdown.py. */
const FRONT_MATTER = String.raw`^---\s*\n(.*?)\n---\s*\n(.*)$`;
const TITLE_LINE = String.raw`^title:\s*["']?(.*?)["']?\s*$`;

/** `_split_frontmatter`: the title and the body, the block kept as content when it has no `title:`. */
export function splitFrontMatter(content: string): { title: string; body: string } {
  const match = compilePythonPattern(FRONT_MATTER, "s").exec(content);
  if (!match) return { title: "", body: pythonStrip(content) };
  const body = pythonStrip(match[2]);
  const titleLine = compilePythonPattern(TITLE_LINE, "m").exec(match[1]);
  if (!titleLine) return { title: "", body: pythonStrip(content) };
  let parsed: unknown;
  try {
    parsed = loadYaml(match[1]);
  } catch {
    return { title: titleLine[1], body };
  }
  if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, "title")) return { title: titleLine[1], body };
  const title = (parsed as Record<string, unknown>).title;
  return { title: typeof title === "string" ? title : pythonStrip(titleLine[1]), body };
}

/** A widget where the panel had one: its type, its source, and its block when the type is known. */
export interface PanelWidgetPart {
  type: string;
  source: string;
  block: PanelWidget | null;
  /** Where the widget stands in the panel's text as an editor holds it (`editorText`). */
  span: { from: number; to: number };
}

/** A glossary callout where the panel had one: its span as `PanelWidgetPart.span` gives one, and whether it drew a link. */
export interface PanelCallout {
  span: { from: number; to: number };
  /** False where the entry is unknown or missing and the callout is its marker. */
  linked: boolean;
}

export interface RenderedPanel {
  title: string;
  /** Sanitised HTML, with `<div data-panel-widget="n">` where widget n stands. */
  html: string;
  widgets: PanelWidgetPart[];
  /** The glossary callouts, in the order the HTML holds them. */
  callouts: PanelCallout[];
}

export interface PanelRenderOptions {
  glossary: GlossaryContext;
  /** The site's baseurl without a trailing slash, as `getBasePath` reads it; "" at a domain root. */
  baseUrl: string;
  /** Keeps this panel's footnote anchors apart from any other on the page. */
  anchor: string;
  /** Said where a part is shown as written because it cannot be previewed. */
  unavailable: string;
  /** The site's origin, which root-relative image addresses are read from; the site's own addresses when absent. */
  origin?: string;
}

const KNOWN_WIDGETS = new Set(["accordion", "tabs", "carousel", "bibliography"]);

function widgetPart(source: string, type: string, span: { from: number; to: number }): PanelWidgetPart {
  if (!KNOWN_WIDGETS.has(type)) return { type, source, block: null, span };
  const state = EditorState.create({ doc: source, extensions: [markdownLanguage()] });
  return { type, source, block: parsePanel(state).widgets[0] ?? null, span };
}

/** A token of this conversion's own, alone between blank lines so it is a paragraph. */
const heldOut = (kind: "W" | "F" | "G", stem: string, n: number) => `\n\nTPANEL${kind}${stem}${n}END\n\n`;

/** A callout held out of the text: its sanitised HTML, and where it stands. */
interface HeldCallout extends PanelCallout {
  html: string;
}

function heldCallout(body: string, span: PanelCallout["span"], glossary: GlossaryContext): HeldCallout {
  const { html, linked } = glossaryCalloutHtml(parseGlossaryCallout(body), glossary);
  return { html: previewSanitise(html), span, linked };
}

/**
 * Widgets and callouts out of the text, last first so the earlier offsets
 * hold; `at` is where the text starts in the editor's.
 */
function holdWidgets(text: string, stem: string, at: number, glossary: GlossaryContext) {
  const found = findWidgets(text);
  const widgets: PanelWidgetPart[] = [];
  const callouts: HeldCallout[] = [];
  const tokens = found.map((w) => {
    const span = { from: at + w.from, to: at + w.to };
    if (w.type === "glossary") {
      callouts.push(heldCallout(text.slice(w.bodyFrom, w.bodyTo), span, glossary));
      return heldOut("G", stem, callouts.length - 1);
    }
    widgets.push(widgetPart(text.slice(w.from, w.to), w.type, span));
    return heldOut("W", stem, widgets.length - 1);
  });
  let held = text;
  for (let n = found.length - 1; n >= 0; n--) held = held.slice(0, found[n].from) + tokens[n] + held.slice(found[n].to);
  return { text: held, widgets, callouts };
}

/** `process_images`'s pattern: alt text may hold brackets nested one level deep. */
const IMAGE_LINE = String.raw`^!\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(([^)]+)\)(?:\{(sm|small|md|medium|lg|large|full)\})?$`;
const IMAGE_SIZES: Record<string, string> = { small: "sm", medium: "md", large: "lg", full: "full", sm: "sm", md: "md", lg: "lg" };

/** The caption `process_images` reads from the line after an image, or null. */
function captionAfter(line: string | undefined): string | null {
  const next = line === undefined ? "" : pythonStrip(line);
  if (!next || next.startsWith("!") || next.startsWith(":::")) return null;
  return next.toLowerCase().startsWith("caption:") ? pythonStrip(next.slice(8)) : next;
}

/**
 * A caption as `process_images` converts it, its one paragraph unwrapped,
 * with no glossary pass yet. The HTML is kept as a string, since a parse
 * would decode the entities the glossary pass must still see.
 */
function figcaption(caption: string, options: PanelRenderOptions): string {
  const html = panelMarkdown(caption, undefined, options.unavailable).trim();
  const rendered = document.createElement("template");
  rendered.innerHTML = html;
  const paragraph = rendered.content.firstElementChild;
  const only = rendered.content.childElementCount === 1 && paragraph?.localName === "p";
  const unwrapped = only && html.startsWith("<p>") && html.endsWith("</p>") ? html.slice(3, -4) : html;
  return `<figcaption class="telar-image-caption">${unwrapped}</figcaption>`;
}

/**
 * One figure as `process_images` writes it, as a string with its values
 * escaped by `html.escape`, then the glossary pass over the whole of it.
 */
function figureHtml(match: RegExpExecArray, caption: string | null, options: PanelRenderOptions, links: HtmlTransform): string {
  const [, alt, written, size] = match;
  const relative = !written.startsWith("/") && !written.startsWith("http");
  const src = relative ? `${options.baseUrl}/telar-content/objects/${written}` : written;
  const sizeClass = size ? ` class="img-${IMAGE_SIZES[size.toLowerCase()]}"` : "";
  const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(htmlUnescape(alt))}"${sizeClass}>`;
  const figcaptionHtml = caption ? figcaption(caption, options) : "";
  return previewSanitise(links(`<figure class="telar-image-figure">${img}${figcaptionHtml}</figure>`));
}

/** `_INLINE_IMAGE`: an image written inside a line of text, its address, and what closes it. */
const INLINE_IMAGE = String.raw`(!\[(?:[^\[\]]|\[[^\[\]]*\])*\]\()([^)\s]+)((?:\s+"[^"]*")?\))`;

/** `_resolve_inline_images`: each relative image address in a line put under the site's objects. */
function resolveInlineImages(line: string, baseUrl: string): string {
  return line.replace(compilePythonPattern(INLINE_IMAGE, "g"), (whole, open: string, src: string, close: string) =>
    src.startsWith("/") || src.startsWith("http") ? whole : `${open}${baseUrl}/telar-content/objects/${src}${close}`,
  );
}

/** Image lines out of the text, each with the caption line that follows it. */
function holdImages(text: string, stem: string, options: PanelRenderOptions, links: HtmlTransform) {
  const lines = text.split("\n");
  const figures: string[] = [];
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = compilePythonPattern(IMAGE_LINE, "i").exec(pythonStrip(lines[i]));
    if (!match) {
      out.push(resolveInlineImages(lines[i], options.baseUrl));
      continue;
    }
    const caption = captionAfter(lines[i + 1]);
    if (caption !== null) i++;
    out.push(heldOut("F", stem, figures.length));
    figures.push(figureHtml(match, caption, options, links));
  }
  return { text: out.join("\n"), figures };
}

/** What each kind of token stands for: a widget's marker, a figure, a callout. */
function heldMarkup(kind: string, n: number, figures: string[], callouts: HeldCallout[]): string {
  if (kind === "W") return `<div data-panel-widget="${n}"></div>`;
  return kind === "F" ? figures[n] : callouts[n].html;
}

/** Puts each held-out widget marker, figure and callout where its token stands. */
function placeHeldOut(html: string, stem: string, figures: string[], callouts: HeldCallout[]): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  const token = new RegExp(`TPANEL([WFG])${stem}(\\d+)END`);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const node of texts) {
    const match = token.exec(node.data);
    if (!match) continue;
    const holder = document.createElement("template");
    holder.innerHTML = heldMarkup(match[1], Number(match[2]), figures, callouts);
    const paragraph = node.parentElement;
    const alone = paragraph?.localName === "p" && paragraph.textContent === match[0] && paragraph.childNodes.length === 1;
    if (alone) paragraph.replaceWith(holder.content);
    else node.replaceWith(node.data.slice(0, match.index), holder.content, node.data.slice(match.index + match[0].length));
  }
  return template.innerHTML;
}

/** A stem for the held-out tokens that the panel's text does not hold. */
function panelStem(text: string): string {
  for (;;) {
    const stem = placeholderStem(text);
    if (!["W", "F", "G"].some((kind) => text.includes(`TPANEL${kind}${stem}`))) return stem;
  }
}

/** `fixImageUrls`: `basePath` in front of each image address that starts `/` but not `//` and is not already under `basePath`. */
export function fixImageUrls(html: string, basePath: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  for (const img of holder.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    const underBase = basePath !== "" && src?.startsWith(`${basePath}/`);
    if (src && src.startsWith("/") && !src.startsWith("//") && !underBase) img.setAttribute("src", basePath + src);
  }
  return holder.innerHTML;
}

/**
 * `origin` in front of each image address that starts `/` but not `//`: the
 * address the site's page reads it from. Unchanged without an origin.
 */
export function imagesFromOrigin(html: string, origin: string | undefined): string {
  if (!origin) return html;
  const holder = document.createElement("div");
  holder.innerHTML = html;
  for (const img of holder.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (src && src.startsWith("/") && !src.startsWith("//")) img.setAttribute("src", origin + src);
  }
  return holder.innerHTML;
}

/**
 * The image addresses of Markdown a widget renders, as a reader's page reads
 * them: under the baseurl (`fixImageUrls`, which the site runs over the whole
 * panel, widgets included), then from the site's origin.
 */
export function widgetImages(baseUrl: string, origin: string | undefined): HtmlTransform {
  return (html) => imagesFromOrigin(fixImageUrls(html, baseUrl), origin);
}

/** A panel's text as an editor of it holds it: CodeMirror reads every line ending as one newline. */
export function editorText(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Where `splitFrontMatter`'s body starts in `content`. */
function bodyStart(content: string): number {
  const match = compilePythonPattern(FRONT_MATTER, "s").exec(content);
  if (!match || !compilePythonPattern(TITLE_LINE, "m").exec(match[1])) return 0;
  const rest = match[2];
  return content.length - rest.length + leadingWhitespace(rest);
}

/** How much Python whitespace `text` starts with. */
function leadingWhitespace(text: string): number {
  return text.length - pythonStrip(text + "x").length + 1;
}

/** Where a panel's body starts in its editor text: past the stripped whitespace and any front matter. */
export function panelBodyStart(source: string): number {
  const normalised = editorText(source);
  return leadingWhitespace(normalised) + bodyStart(pythonStrip(normalised));
}

/** A layer panel's title and sanitised HTML, as a reader of the site is shown it. */
export function renderPanel(source: string, options: PanelRenderOptions): RenderedPanel {
  const links: HtmlTransform = (html) => resolveGlossaryLinks(html, options.glossary.terms, options.glossary.baseUrl);
  const normalised = editorText(source);
  const content = pythonStrip(normalised);
  const { title, body } = splitFrontMatter(content);
  const at = leadingWhitespace(normalised) + bodyStart(content);
  const stem = panelStem(body);
  const { text: withoutWidgets, widgets, callouts } = holdWidgets(body, stem, at, options.glossary);
  const { text, figures } = holdImages(withoutWidgets, stem, options, links);
  const html = panelMarkdown(text, options.anchor, options.unavailable, links);
  const read = fixImageUrls(placeHeldOut(html, stem, figures, callouts), options.baseUrl);
  const shown = callouts.map(({ span, linked }) => ({ span, linked }));
  return { title, html: imagesFromOrigin(read, options.origin), widgets, callouts: shown };
}
