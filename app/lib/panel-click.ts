/**
 * panel-click — where a click in a layer panel's rendered content opens the
 * editor, and the one-shot request that carries it into the editor.
 *
 * The rendered HTML carries no source positions, so the place is found by a
 * heuristic (ruled 28 September), with the Markdown port returning source
 * spans as its replacement should authors find it misplaces the caret.
 *
 * A click in a widget opens its box in the editor with the clicked
 * section's, tab's or item's first Markdown field focused: a section's or
 * entry's text, a carousel item's caption, else its credit. The widget is
 * the one whose span in the editor's text `renderPanel` records. A
 * carousel's display index is mapped to its source index, since items
 * without an image are not displayed. A widget the editor draws without a
 * box (its fences share a line with text, or the framework does not know
 * its type), an item with no Markdown field, or a click in the widget
 * outside any section puts the caret at the widget's opening fence. So does
 * a click on a glossary callout, at its own fence: the nth callout drawn as
 * a link is the nth `renderPanel` records as linked.
 *
 * A click in the text finds the caret under the pointer
 * (`caretPositionFromPoint`, or `caretRangeFromPoint` in Safari; the
 * client coordinates need no correction for the visitor layer's scale) and
 * checks it falls inside the clicked block. The rendered text before it is
 * matched against the source through a map that undoes what the renderer
 * changes: only letters and digits are compared, so whitespace, escaped
 * punctuation and Markdown's marks drop out; entities are decoded; a
 * glossary link reads as its display text or its term's title; a link reads
 * as its text, not its address; an image, a footnote mark, an HTML tag, a
 * list marker, `caption:` and a formula read as nothing, and footnote
 * numbers and typeset formulas are left out of the rendered side. The
 * shortest run of rendered text ending at the click that occurs once in the
 * source fixes the place, and the punctuation and spaces between the last
 * letter and the click are carried over. Text that matches nowhere or
 * everywhere, a formula, or a figure puts the caret at the start of the
 * clicked block's source, found the same way from the text before the
 * block; failing that, at the start of the content.
 *
 * The request carries the text it was computed against, the caret's offset
 * in it, and for a widget its kind, its fence's offset, its source, and the
 * clicked section's index, source and field. Offsets are in the editor's
 * text, whose line endings CodeMirror has normalised (`editorText`). It is
 * applied once, when the editor's first view is created (`placeCaret`),
 * never when a Y.Text replaces the view. If the editor's text is not the
 * text it was computed against, the widget is found again only where
 * exactly one widget has the same source, the section only where exactly
 * one section in it has the same source, and the text's place by the text
 * around it, found once; anything missing, replaced or ambiguous puts the
 * caret at the start. A field's focus waits until the box's field mounts
 * (`takeFieldFocus`, PanelBox), which checks the widget and section again.
 *
 * @version v1.5.0-beta
 */

import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { markdown as markdownLanguage } from "@codemirror/lang-markdown";
import { findWidgets } from "~/components/ui/markdown-editor/footnoteScopes";
import { parsePanel, type PanelSection, type PanelWidget } from "~/components/ui/markdown-editor/panelSource";
import { editPanelBlock } from "~/components/ui/markdown-editor/panelAuthoring";
import { latexSpans } from "~/components/ui/markdown-editor/latex";
import { htmlUnescape } from "~/lib/html-unescape";
import { editorText, panelBodyStart, type PanelCallout, type PanelWidgetPart } from "~/lib/card-markdown";
import type { GlossaryTerms } from "~/lib/glossary-links";

/** Where the editor opens, computed against one text. */
export interface OpeningRequest {
  id: number;
  /** The editor's text the request was computed against. */
  text: string;
  /** The caret's offset in `text`. */
  offset: number;
  widget?: {
    kind: string;
    fence: number;
    source: string;
    /** The clicked section and the field to focus; null for the caret at the fence. */
    section: { index: number; source: string; field: string } | null;
  };
}

let requests = 0;

/** A request for the start of the content, as Enter or Space on the block opens it. */
export function startRequest(value: string): OpeningRequest {
  requests += 1;
  return { id: requests, text: editorText(value), offset: 0 };
}

// ------------------------------------------------------------ the source map

const LETTER = /[\p{L}\p{N}]/u;

/** The letters and digits the source shows a reader, each with its offset in the source. */
export interface SourceSkeleton {
  chars: string;
  at: number[];
}

const GLOSSARY = /^\[\[\s*([^|\]]+?)(?:\s*\|\s*([^|\]]+?))?\s*\]\]/;
const LINE_MARKS = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+|(?:\d+[.)]|[-*+])[ \t]+|\[\^[^\]\s]+\]:[ \t]*|caption:[ \t]*)?/i;

/** Adds the letters and digits of `value` to the skeleton, each at the offset `offset` gives it. */
type Emit = (value: string, offset: (i: number) => number) => void;

/**
 * How much source at `i` a reader never sees as text: an escape's backslash
 * and character, an HTML tag, an image, a footnote mark, a link's address.
 * 0 when none starts there.
 */
function hiddenMarkupAt(text: string, i: number): number {
  const rest = text.slice(i, i + 400);
  if (text[i] === "\\" && i + 1 < text.length) return 2;
  const tag = /^<[A-Za-z/!][^>\n]*>/.exec(rest);
  if (tag) return tag[0].length;
  const image = /^!\[(?:[^\[\]]|\[[^\[\]]*\])*\]\([^)]*\)(?:\{[a-z]+\})?/.exec(rest);
  if (image) return image[0].length;
  const footnote = /^\[\^[^\]\s]+\]/.exec(rest);
  if (footnote) return footnote[0].length;
  const address = /^\]\([^)\n]*\)/.exec(rest);
  return address ? address[0].length : 0;
}

/**
 * A glossary link at `start`, emitted as the reader sees it: its display
 * text where it has one, else its term's title (else its id); returns its
 * length, 0 when none starts there.
 */
function glossaryAt(text: string, start: number, titles: Map<string, string>, emit: Emit): number {
  const match = GLOSSARY.exec(text.slice(start, start + 400));
  if (!match) return 0;
  if (match[2] !== undefined) {
    const displayAt = start + match[0].indexOf(match[2], match[1].length + 2);
    emit(match[2], (k) => displayAt + k);
  } else {
    emit(titles.get(match[1].trim().toLowerCase()) ?? match[1], () => start);
  }
  return match[0].length;
}

/** A character reference at `start`, emitted decoded; returns its length, 0 when none starts there. */
function entityAt(text: string, start: number, emit: Emit): number {
  const match = /^&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][A-Za-z\d]*);/.exec(text.slice(start, start + 40));
  if (!match) return 0;
  emit(htmlUnescape(match[0]), () => start);
  return match[0].length;
}

/**
 * The source's skeleton: what a reader sees of it, as letters and digits,
 * leaving out the ranges in `skip` (widgets, front matter, formulas).
 */
export function sourceSkeleton(text: string, skip: Array<{ from: number; to: number }>, terms: GlossaryTerms): SourceSkeleton {
  const chars: string[] = [];
  const at: number[] = [];
  const emit: Emit = (value, offset) => {
    [...value].forEach((ch, k) => {
      if (!LETTER.test(ch)) return;
      chars.push(ch);
      at.push(offset(k));
    });
  };
  const titles = new Map([...terms].map(([id, title]) => [id.toLowerCase(), title]));
  let i = 0;
  let lineStart = true;
  while (i < text.length) {
    const skipped = skip.find((r) => r.from <= i && i < r.to);
    if (skipped) {
      i = skipped.to;
      continue;
    }
    const marks = lineStart ? LINE_MARKS.exec(text.slice(i))![0].length : 0;
    lineStart = text[i] === "\n";
    const read = marks || hiddenMarkupAt(text, i) || glossaryAt(text, i, titles, emit) || entityAt(text, i, emit);
    if (read) {
      i += read;
      continue;
    }
    const offset = i;
    emit(text[i], () => offset);
    i += 1;
  }
  return { chars: chars.join(""), at };
}

/**
 * The offset just past the rendered `letters` in the source, found by the
 * shortest run ending with them that occurs once; null when none does.
 */
export function matchEnd(skeleton: SourceSkeleton, letters: string): number | null {
  for (let k = 1; k <= letters.length; k++) {
    const run = letters.slice(-k);
    const first = skeleton.chars.indexOf(run);
    if (first === -1) return null;
    if (skeleton.chars.indexOf(run, first + 1) === -1) return skeleton.at[first + k - 1] + 1;
  }
  return null;
}

// ------------------------------------------------------- the rendered side

/** What the rendered side leaves out: widgets, callouts, typeset formulas, footnote numbers and back links. */
const NOT_TEXT = "[data-panel-widget], a.glossary-callout, .katex, a.footnote-ref, a.footnote-backref";

/** The marker of a callout whose entry is unknown: a link error standing outside any text block, where an inline one stands in its text. */
function isCalloutMarker(element: Element): boolean {
  const marker = element.closest(".glossary-link-error");
  return marker !== null && !marker.closest("p, li, td, th, dt, dd, h1, h2, h3, h4, h5, h6");
}

/**
 * The letters and digits of the rendered text before `stop` (a text node and
 * an offset in it, or an element and a child index), and how many other
 * characters follow the last of them before `stop`.
 */
export function renderedBefore(container: HTMLElement, stop: { node: Node; offset: number }): { letters: string; trailing: number } {
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEnd(stop.node, stop.offset);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest(NOT_TEXT) || isCalloutMarker(node.parentElement!)) continue;
    if (!range.intersectsNode(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    text += node.data.slice(from, to);
  }
  const letters = [...text].filter((ch) => LETTER.test(ch)).join("");
  const last = [...text].reverse().findIndex((ch) => LETTER.test(ch));
  return { letters, trailing: last === -1 ? 0 : last };
}

/** The caret under a point, from whichever of the two browser methods exists. */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figure, pre, dt, dd";


// -------------------------------------------------------------- the click

export interface ClickContext {
  /** The panel's text, as the rendering was made from it. */
  value: string;
  widgets: PanelWidgetPart[];
  /** The glossary callouts, in the rendering's order; none when absent. */
  callouts?: PanelCallout[];
  /** The element holding the rendered HTML. */
  prose: HTMLElement;
  terms: GlossaryTerms;
}

/** Which section of a rendered widget a click is in, as its index among the widget's sections. */
function clickedSection(target: Element, block: PanelWidget): PanelSection | null {
  const kind = block.kind;
  const indexIn = (el: Element | null, selector: string) =>
    el ? [...(el.parentElement?.children ?? [])].filter((c) => c.matches(selector)).indexOf(el) : -1;
  if (kind === "accordion") return block.sections[indexIn(target.closest(".accordion-item"), ".accordion-item")] ?? null;
  if (kind === "tabs") return block.sections[indexIn(target.closest(".tab-pane"), ".tab-pane")] ?? null;
  if (kind === "bibliography") return block.sections[indexIn(target.closest(".telar-bib-entry"), ".telar-bib-entry")] ?? null;
  const shown = block.sections.filter((s) => s.fields?.image);
  return shown[indexIn(target.closest(".carousel-item"), ".carousel-item")] ?? null;
}

/** The first Markdown field of a section, as the box offers it. */
function firstMarkdownField(kind: string, section: PanelSection): string | null {
  if (kind !== "carousel") return section.body ? "body" : null;
  return ["caption", "credit"].find((key) => section.fields?.[key]) ?? null;
}

function widgetRequest(target: Element, slot: HTMLElement, context: ClickContext, text: string): OpeningRequest {
  const part = context.widgets[Number(slot.dataset.panelWidget)];
  requests += 1;
  if (!part) return { id: requests, text, offset: 0 };
  const fence = part.span.from;
  const source = text.slice(part.span.from, part.span.to);
  const boxed = parsePanel(EditorState.create({ doc: text, extensions: [markdownLanguage()] })).widgets.find(
    (w) => w.from === fence,
  );
  const section = boxed && clickedSection(target, boxed);
  const field = section && firstMarkdownField(boxed.kind, section);
  return {
    id: requests,
    text,
    offset: fence,
    widget: {
      kind: part.type,
      fence,
      source,
      section: section && field ? { index: boxed.sections.indexOf(section), source: section.source, field } : null,
    },
  };
}

/** The fence of the glossary callout clicked, or null where the click is on none. */
function calloutFence(target: Element, context: ClickContext): number | null {
  const link = target.closest("a.glossary-callout");
  if (!link || !context.prose.contains(link)) return null;
  const n = [...context.prose.querySelectorAll("a.glossary-callout")].indexOf(link);
  return context.callouts?.filter((c) => c.linked)[n]?.span.from ?? null;
}

/** Where a click in the rendered content opens the editor. */
export function requestFromClick(target: Element, point: { x: number; y: number }, context: ClickContext): OpeningRequest {
  const text = editorText(context.value);
  const slot = target.closest<HTMLElement>("[data-panel-widget]");
  if (slot && context.prose.contains(slot)) return widgetRequest(target, slot, context, text);
  const fence = calloutFence(target, context);
  requests += 1;
  return { id: requests, text, offset: fence ?? proseOffset(target, point, context, text) };
}

/** The ranges of the panel's text the rendering holds out as blocks of their own: its widgets and glossary callouts. */
function heldSpans(context: ClickContext): Array<{ from: number; to: number }> {
  return [...context.widgets.map((w) => w.span), ...(context.callouts ?? []).map((c) => c.span)];
}

/** What a reader sees of the panel's text, outside its widgets, callouts, front matter and formulas. */
function proseSkeleton(context: ClickContext, text: string): SourceSkeleton {
  const skip = [...heldSpans(context), { from: 0, to: panelBodyStart(context.value) }, ...latexSpans(text)];
  return sourceSkeleton(text, skip, context.terms);
}

/** The clicked block in the rendered text, if the click is in one. */
function clickedBlock(target: Element, prose: HTMLElement): Element | null {
  const block = target.closest(BLOCKS);
  return block && prose.contains(block) ? block : null;
}

/** The caret under the click, where it falls in the clicked block's own text; null for a formula or an image. */
function caretInBlock(target: Element, block: Element | null, point: { x: number; y: number }) {
  if (!block || target.closest(".katex, img")) return null;
  const caret = caretAt(point.x, point.y);
  return caret && block.contains(caret.node) ? caret : null;
}

/**
 * The source offset of a click in the text, else of its block's start. A
 * caret before the block's first letter is the block's start; a match of the
 * text before the caret is taken only where it falls inside the block.
 */
function proseOffset(target: Element, point: { x: number; y: number }, context: ClickContext, text: string): number {
  const skeleton = proseSkeleton(context, text);
  const block = clickedBlock(target, context.prose);
  const start = blockStart(block, context, skeleton, text);
  const caret = caretInBlock(target, block, point);
  if (!caret || !renderedBefore(block as HTMLElement, caret).letters) return start;
  const { letters, trailing } = renderedBefore(context.prose, caret);
  const end = matchEnd(skeleton, letters);
  return end !== null && end > start ? carriedOver(text, end, trailing) : start;
}

/** `end` moved over up to `count` characters that are not letters, on the same line. */
function carriedOver(text: string, end: number, count: number): number {
  let offset = end;
  for (let n = 0; n < count && offset < text.length && !LETTER.test(text[offset]) && text[offset] !== "\n"; n++) offset += 1;
  return offset;
}

/**
 * The start of a rendered block's source, found from the text before it: the
 * next line's first character, passing over any widget or callout between; the first
 * line a reader sees for the first block; 0 when it cannot be found.
 */
function blockStart(block: Element | null, context: ClickContext, skeleton: SourceSkeleton, text: string): number {
  if (!block) return 0;
  const { letters } = renderedBefore(context.prose, { node: block, offset: 0 });
  if (letters) {
    const end = matchEnd(skeleton, letters);
    return end === null ? 0 : lineStartPastHeld(text, end, heldSpans(context));
  }
  return firstLettersBlockStart(block, context, skeleton, text);
}

/**
 * The start of a block with no letters before it. The first block starts the
 * content, past any widgets that open it; a later one (text after an image or a formula alone) starts where
 * the content's first letters do, if it has letters itself; else the content
 * start is the nearest place known.
 */
function firstLettersBlockStart(block: Element, context: ClickContext, skeleton: SourceSkeleton, text: string): number {
  const contentStart = pastHeldAt(text, panelBodyStart(context.value), heldSpans(context));
  const first = [...context.prose.querySelectorAll(BLOCKS)].find((b) => !b.closest("[data-panel-widget]"));
  const hasLetters = renderedBefore(block as HTMLElement, { node: block, offset: block.childNodes.length }).letters !== "";
  if (first === block || !hasLetters || !skeleton.at.length) return contentStart;
  return text.lastIndexOf("\n", skeleton.at[0]) + 1;
}

/** `at`, or past every held block that starts there, to the first line after them. */
function pastHeldAt(text: string, at: number, held: Array<{ from: number; to: number }>): number {
  let from = at;
  for (let block = held.find((h) => h.from === from); block; block = held.find((h) => h.from === from)) {
    from = nextLineStart(text, block.to);
  }
  return from;
}

/** From `from`, the next line's first character, past every held block that starts there. */
function lineStartPastHeld(text: string, from: number, held: Array<{ from: number; to: number }>): number {
  return pastHeldAt(text, nextLineStart(text, from), held);
}

/** From `from` in `text`, the start of the next line's first character. */
function nextLineStart(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  if (newline === -1) return text.length;
  let at = newline;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
}

// ---------------------------------------------------------- applying it

/** The request's places in `text`: as computed, or found again where the text has changed. */
export function rematch(request: OpeningRequest, text: string): Pick<OpeningRequest, "offset" | "widget"> {
  if (text === request.text) return { offset: request.offset, widget: request.widget };
  if (request.widget) return rematchWidget(request.widget, text);
  return { offset: rematchText(request, text) };
}

/** The widget, and its clicked section, found again only where each is unique; else the start. */
function rematchWidget(widget: NonNullable<OpeningRequest["widget"]>, text: string): Pick<OpeningRequest, "offset" | "widget"> {
  const same = findWidgets(text).filter((w) => text.slice(w.from, w.to) === widget.source);
  if (same.length !== 1) return { offset: 0 };
  const fence = same[0].from;
  const section = widget.section;
  if (!section) return { offset: fence, widget: { ...widget, fence } };
  const boxed = parsePanel(EditorState.create({ doc: text, extensions: [markdownLanguage()] })).widgets.find((w) => w.from === fence);
  const matching = boxed?.sections.filter((s) => s.source === section.source) ?? [];
  if (!boxed || matching.length !== 1) return { offset: 0 };
  const index = boxed.sections.indexOf(matching[0]);
  return { offset: fence, widget: { ...widget, fence, section: { ...section, index } } };
}

/** The text's place found again by the text around it, only where that occurs once; else the start. */
function rematchText(request: OpeningRequest, text: string): number {
  const before = request.text.slice(Math.max(0, request.offset - 40), request.offset);
  const needle = before + request.text.slice(request.offset, request.offset + 40);
  if (!needle) return 0;
  const first = text.indexOf(needle);
  if (first === -1 || text.indexOf(needle, first + 1) !== -1) return 0;
  return first + before.length;
}

interface PendingFieldFocus {
  id: number;
  /** The document the box was opened on, and the widget's fence in it. */
  text: string;
  fence: number;
  widgetSource: string;
  sectionSource: string;
  index: number;
  field: string;
}

const pendingFocus = new WeakMap<EditorView, PendingFieldFocus>();

/**
 * Places the caret, or opens the clicked widget's box, as the request asks,
 * in a view just created; focuses the view.
 */
export function applyOpeningRequest(view: EditorView, request: OpeningRequest): void {
  const found = rematch(request, view.state.doc.toString());
  const clamp = (at: number) => Math.max(0, Math.min(at, view.state.doc.length));
  view.focus();
  const widget = found.widget;
  if (widget?.section) {
    const boxed = parsePanel(view.state).widgets.find((w) => w.from === widget.fence);
    if (boxed) {
      pendingFocus.set(view, {
        id: request.id,
        text: view.state.doc.toString(),
        fence: widget.fence,
        widgetSource: widget.source,
        sectionSource: widget.section.source,
        index: widget.section.index,
        field: widget.section.field,
      });
      view.dispatch({ selection: { anchor: widget.fence }, effects: editPanelBlock.of({ from: widget.fence, mode: "edit" }) });
      return;
    }
  }
  view.dispatch({ selection: { anchor: clamp(found.offset) } });
}

/**
 * Whether the field about to mount is the one a request is waiting to
 * focus; the wait ends once that section's field mounts in the clicked box.
 * Where the text is the one the box was opened on, the box at the fence is
 * the clicked one, even if another widget has the same source. Where the
 * text has changed, the widget and section are the clicked ones only if
 * each source is found once; otherwise the caret goes to the start.
 */
export function takeFieldFocus(view: EditorView, block: PanelWidget, index: number, field: string): boolean {
  const pending = pendingFocus.get(view);
  if (!pending || pending.index !== index || pending.field !== field) return false;
  const text = view.state.doc.toString();
  // Unchanged since the box opened: the widget is the one at the fence, even
  // where another has the same source; another box's field waits its turn.
  if (text === pending.text) {
    if (block.from !== pending.fence) return false;
    pendingFocus.delete(view);
    return true;
  }
  pendingFocus.delete(view);
  if (stillTheClickedSection(text, block, index, pending)) return true;
  view.dispatch({ selection: { anchor: 0 } });
  return false;
}

/** In a changed text, the widget and the section are the clicked ones only where each source is found once. */
function stillTheClickedSection(text: string, block: PanelWidget, index: number, pending: PendingFieldFocus): boolean {
  const widgetOnce = findWidgets(text).filter((w) => text.slice(w.from, w.to) === pending.widgetSource).length === 1;
  const sectionOnce = block.sections.filter((s) => s.source === pending.sectionSource).length === 1;
  return block.source === pending.widgetSource && widgetOnce && block.sections[index]?.source === pending.sectionSource && sectionOnce;
}
