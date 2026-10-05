/**
 * Footnote syntax reads each Markdown conversion with its own syntax tree,
 * because that is how the framework converts it. An accordion or tabs
 * section is converted from its content alone, after
 * `'\n'.join(lines).strip()`, so a code fence in one section cannot run into
 * the next, and a fence left open at the end of a section is unclosed there.
 * Each section's content is therefore parsed on its own, with the editor's
 * Markdown parser, and offsets are mapped back to the panel. The top-level
 * conversion sees each widget as a closed HTML block, which leaves the
 * Markdown around it read as though the widget were absent; it is parsed with
 * every widget blanked to whitespace of the same length, newlines kept, so
 * offsets need no mapping, nothing inside a widget can open code outside it,
 * and the blank does not start a block that absorbs what follows.
 *
 * A position is unusable for a reference when the converter would not read
 * the reference there, or when inserting it would break the construct it
 * sits in: inside inline code, a code block, raw HTML, a link or an
 * autolink; right after an odd number of backslashes; from the start of a
 * footnote definition's line through its `[^label]` marker, up to the `:`
 * (after it, the note's text takes references); or anywhere
 * footnoteScopes.ts gives no conversion.
 *
 * Definitions follow Python Markdown's pattern, `^[ ]{0,3}\[\^([^\]]*)\]:`.
 * A definition whose marker sits inside code or raw HTML of its own
 * conversion is not one; what follows the marker does not matter.
 *
 * `readNotes` numbers the references and notes of every conversion as the
 * framework publishes them: in the order a reader meets the references, a
 * note keeping the number of its first reference, and unreferenced notes
 * after the referenced ones in definition order. A reference whose label has
 * no definition in its conversion is literal text and takes no number. A
 * label defined twice in one conversion is marked `duplicate`; the editor
 * shows it as an error rather than choosing a definition, as Python Markdown
 * does.
 *
 * @version v1.5.0-beta
 */
import { ensureSyntaxTree, language, syntaxTree } from "@codemirror/language";
import { commonmarkLanguage } from "@codemirror/lang-markdown";
import type { EditorState, Text } from "@codemirror/state";
import type { SyntaxNodeRef, Tree } from "@lezer/common";
import {
  findWidgets,
  widgetScopeAt,
  type FootnoteScope,
  type Widget,
} from "./footnoteScopes";
import { isEscaped } from "./escapes";
import { protectedSpans } from "./latex";
import { lineStart, scanHtmlBlocks, type HtmlBlockRange } from "./htmlBlocks";

export interface SourceRange {
  from: number;
  to: number;
}

export interface NoteDefinition extends SourceRange {
  label: string;
  /** The `[^label]:` marker, from `[` through `:`. */
  marker: SourceRange;
  /** The conversion the definition belongs to. */
  scope: FootnoteScope;
  /** The note's text with continuation-line indentation removed. */
  text: string;
  /** Where the note's text starts in the panel, after the marker and its spaces. */
  textFrom: number;
}

/**
 * A conversion's tree over `source`, which starts at `offset` in the panel.
 * Raw HTML blocks are read by htmlBlocks.ts, as Python Markdown reads them,
 * and blanked out of `tree`'s text; `html` holds their ranges in `source`.
 */
interface ConversionSyntax {
  tree: Tree;
  source: string;
  offset: number;
  html: HtmlBlockRange[];
}

/** Parse time allowed before falling back to the tree parsed so far. */
const PARSE_TIMEOUT_MS = 200;

function markdownParser(state: EditorState) {
  return (state.facet(language) ?? commonmarkLanguage).parser;
}

/**
 * Widgets become whitespace of the same length, newlines kept. The framework
 * replaces a widget with a closed HTML block, so the Markdown after it is read
 * as though the widget were not there; blank lines give the same reading
 * without starting a block that could absorb what follows.
 */
function blankWidgets(text: string, widgets: Widget[]): string {
  return blankRanges(text, widgets);
}

/** `text` with each range replaced by whitespace of the same length, newlines kept. */
function blankRanges(text: string, ranges: SourceRange[]): string {
  let blanked = text;
  for (const r of ranges) {
    const filler = text.slice(r.from, r.to).replace(/[^\n]/g, " ");
    blanked = blanked.slice(0, r.from) + filler + blanked.slice(r.to);
  }
  return blanked;
}

/** Stands for a container's tag where text shares its line, so the text does not read as indented code. */
const TAG_FILLER = "\u2060";

/**
 * `source` with raw HTML blanked to whitespace, and a `markdown` container's
 * tag blanked to a filler instead when other text is on its line.
 */
function blankHtml(source: string, html: HtmlBlockRange[]): string {
  let out = source;
  for (const r of html) {
    if (r.span) continue;
    const lineFrom = lineStart(source, r.from);
    const newline = source.indexOf("\n", r.to);
    const line = source.slice(lineFrom, newline === -1 ? source.length : newline);
    const alone = !(line.slice(0, r.from - lineFrom) + line.slice(r.to - lineFrom)).trim();
    const fill = r.tag && !alone ? TAG_FILLER : " ";
    out = out.slice(0, r.from) + source.slice(r.from, r.to).replace(/[^\n]/g, fill) + out.slice(r.to);
  }
  return out;
}

/**
 * A conversion's syntax, with the raw HTML blocks Python Markdown finds in
 * `source` blanked before the editor's parser reads what is left. Text inside
 * a `markdown="1"` container stays, so it parses as the Markdown it is.
 */
function conversionSyntax(
  state: EditorState,
  source: string,
  offset: number,
  reuseStateTree: boolean,
): ConversionSyntax {
  const html = scanHtmlBlocks(source);
  if (!html.length && reuseStateTree) {
    const tree = ensureSyntaxTree(state, state.doc.length, PARSE_TIMEOUT_MS) ?? syntaxTree(state);
    return { tree, source, offset, html };
  }
  return { tree: markdownParser(state).parse(blankHtml(source, html)), source, offset, html };
}

function topLevelSyntax(state: EditorState, text: string, widgets: Widget[]): ConversionSyntax {
  if (!widgets.length) return conversionSyntax(state, text, 0, true);
  return conversionSyntax(state, blankWidgets(text, widgets), 0, false);
}

function sectionSyntax(
  state: EditorState,
  text: string,
  scope: { from: number; end: number },
): ConversionSyntax {
  const raw = text.slice(scope.from, Math.max(scope.from, scope.end));
  const lead = raw.length - raw.trimStart().length;
  const source = raw.trim();
  return conversionSyntax(state, source, scope.from + lead, false);
}

/** Builds each conversion's syntax once per panel reading. */
function syntaxCache(state: EditorState, text: string, widgets: Widget[]) {
  const cache = new Map<number, ConversionSyntax>();
  return (scope: FootnoteScope): ConversionSyntax => {
    const key = scope.kind === "section" ? scope.from : -1;
    let syntax = cache.get(key);
    if (!syntax) {
      syntax =
        scope.kind === "section"
          ? sectionSyntax(state, text, scope)
          : topLevelSyntax(state, text, widgets);
      cache.set(key, syntax);
    }
    return syntax;
  };
}

export function overlaps(range: SourceRange, other: SourceRange): boolean {
  return range.from < other.to && range.to > other.from;
}

const CODE_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "CommentBlock",
  "Comment",
  "HTMLTag",
]);

/** Code and raw HTML in a conversion, in panel offsets. */
function codeRangesIn(syntax: ConversionSyntax): SourceRange[] {
  const ranges: SourceRange[] = [];
  syntax.tree.iterate({
    enter(node) {
      if (!CODE_NODES.has(node.name)) return;
      ranges.push({ from: node.from + syntax.offset, to: node.to + syntax.offset });
      return false;
    },
  });
  for (const r of syntax.html) if (!r.span) ranges.push({ from: r.from + syntax.offset, to: r.to + syntax.offset });
  return ranges;
}

const DEFINITION_LINE = /^( {0,3})(\[\^([^\]]*)\]:)[ ]*(.*)$/;
const INDENTED = /^( {4}|\t)/;

/**
 * The last line number of the definition starting at `first`: indented lines
 * continue it, and a blank line does too when an indented line follows.
 */
function definitionLastLine(doc: Text, first: number): number {
  let last = first;
  for (let next = first + 1; next <= doc.lines; next++) {
    const text = doc.line(next).text;
    const continuesAfterBlank =
      !text.trim() && next < doc.lines && INDENTED.test(doc.line(next + 1).text);
    if (!INDENTED.test(text) && !continuesAfterBlank) break;
    last = next;
  }
  return last;
}

/**
 * The formulas `protect_latex` takes out of a conversion before Markdown
 * reads it, in panel offsets. Nothing inside one is a footnote.
 */
function formulasIn(syntax: ConversionSyntax): SourceRange[] {
  return protectedSpans(syntax.source).map((r) => ({ from: r.from + syntax.offset, to: r.to + syntax.offset }));
}

/** Code and formula ranges of each conversion, built once per reading. */
function codeByScope(state: EditorState, text: string, widgets: Widget[]) {
  const syntaxFor = syntaxCache(state, text, widgets);
  const cache = new Map<ConversionSyntax, SourceRange[]>();
  const codeFor = (scope: FootnoteScope): SourceRange[] => {
    const syntax = syntaxFor(scope);
    if (!cache.has(syntax)) cache.set(syntax, [...codeRangesIn(syntax), ...formulasIn(syntax)]);
    return cache.get(syntax)!;
  };
  const formulasFor = (scope: FootnoteScope) => formulasIn(syntaxFor(scope));
  const spanFor = (scope: FootnoteScope): SourceRange[] => {
    const syntax = syntaxFor(scope);
    return syntax.html.filter((r) => r.span).map((r) => ({ from: r.from + syntax.offset, to: r.to + syntax.offset }));
  };
  return { codeFor, formulasFor, spanFor };
}

/**
 * The panel position of an offset in a note's text. The text drops each
 * continuation line's indentation, so every offset past a dropped indent
 * moves on by it.
 */
function notePosition(text: string, note: NoteDefinition): (offset: number) => number {
  const raw = text.slice(note.textFrom, note.to);
  const cuts: Array<[at: number, removed: number]> = [];
  let removed = 0;
  for (const m of raw.matchAll(/\n( {4}|\t)/g)) {
    cuts.push([m.index + 1 - removed, removed + m[1].length]);
    removed += m[1].length;
  }
  return (offset) => {
    const cut = cuts.filter(([at]) => offset >= at).at(-1);
    return note.textFrom + offset + (cut ? cut[1] : 0);
  };
}

/**
 * Code in a note, in panel offsets. Python Markdown reads a note's text with
 * its continuation indentation removed, so an indented second paragraph is
 * prose and only a line indented further is code; the note's text is
 * parsed on its own for that reason.
 */
function noteCode(state: EditorState, text: string, note: NoteDefinition): SourceRange[] {
  const tree = markdownParser(state).parse(note.text);
  const at = notePosition(text, note);
  return codeRangesIn({ tree, source: note.text, offset: 0, html: [] }).map((r) => ({ from: at(r.from), to: at(r.to) }));
}

interface PanelReading {
  state: EditorState;
  text: string;
  widgets: Widget[];
  /** Code, raw HTML and formulas in each conversion: nothing in them is a footnote. */
  codeFor: (scope: FootnoteScope) => SourceRange[];
  /** The content of `markdown="span"` containers, which takes no definition. */
  spanFor: (scope: FootnoteScope) => SourceRange[];
  /** Formulas alone, which hold across a note's paragraphs as well. */
  formulasFor: (scope: FootnoteScope) => SourceRange[];
}

function readPanel(state: EditorState): PanelReading {
  const text = state.doc.toString();
  const widgets = findWidgets(text);
  return { state, text, widgets, ...codeByScope(state, text, widgets) };
}

function definitionsIn(state: EditorState, reading: PanelReading): NoteDefinition[] {
  const { doc } = state;
  const definitions: NoteDefinition[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const match = DEFINITION_LINE.exec(line.text);
    if (!match) continue;
    const markerFrom = line.from + match[1].length;
    const marker = { from: markerFrom, to: markerFrom + match[2].length };
    const scope = widgetScopeAt(reading.text, reading.widgets, markerFrom);
    if (!scope || reading.codeFor(scope).some((r) => overlaps(marker, r))) continue;
    if (reading.spanFor(scope).some((r) => overlaps(marker, r))) continue;
    const last = definitionLastLine(doc, i);
    const to = doc.line(last).to;
    const body = state.sliceDoc(line.to - match[4].length, to);
    definitions.push({
      from: line.from,
      to,
      label: match[3],
      marker,
      scope,
      text: body.replace(/\n(?: {4}|\t)/g, "\n"),
      textFrom: line.to - match[4].length,
    });
    i = last;
  }
  return definitions;
}

/** Definitions in every conversion that takes footnotes, in document order. */
export function parseDefinitions(state: EditorState): NoteDefinition[] {
  return definitionsIn(state, readPanel(state));
}

export interface NoteReference extends SourceRange {
  label: string;
  scope: FootnoteScope;
  /** The published number: first-reference order within the conversion. */
  number: number;
}

export interface NumberedNote extends NoteDefinition {
  number: number;
  /** A label defined more than once in its conversion, shown as an error. */
  duplicate: boolean;
}

export interface PanelNotes {
  references: NoteReference[];
  /** Each conversion's notes in published order, conversions in document order. */
  notes: NumberedNote[];
}

const REFERENCE = /\[\^([^\]]*)\]/g;

function scopeKey(scope: FootnoteScope): number {
  return scope.kind === "section" ? scope.from : -1;
}

interface FoundReference extends SourceRange {
  label: string;
  scope: FootnoteScope;
  inNote: boolean;
}

/**
 * `[^label]` spans the converter reads as references: in a conversion, not
 * escaped, not in code or a formula, not a definition's marker, and naming
 * a label defined in the same conversion. Anything else stays literal text.
 * Inside a note, code is read from the note's own text, so a reference in
 * an indented continuation paragraph counts and one in a code block does not.
 * Inside a raw HTML tag Python Markdown does convert a reference, writing
 * the note's markup into the tag's attribute; that output is broken, so the
 * editor leaves such a reference as text instead.
 */
/** What a reference cannot sit in: its note's own code, or its conversion's; built once per note. */
function exclusions(reading: PanelReading) {
  const byNote = new Map<NoteDefinition, SourceRange[]>();
  return (scope: FootnoteScope, note: NoteDefinition | undefined): SourceRange[] => {
    if (!note) return reading.codeFor(scope);
    if (!byNote.has(note))
      byNote.set(note, [...noteCode(reading.state, reading.text, note), ...reading.formulasFor(scope)]);
    return byNote.get(note)!;
  };
}

function findReferences(reading: PanelReading, definitions: NoteDefinition[]): FoundReference[] {
  const found: FoundReference[] = [];
  const exclusionsFor = exclusions(reading);
  for (const match of reading.text.matchAll(REFERENCE)) {
    const range = { from: match.index, to: match.index + match[0].length };
    const scope = widgetScopeAt(reading.text, reading.widgets, range.from);
    if (!scope || isEscaped(reading.text, range.from)) continue;
    const inScope = definitions.filter((d) => sameScopeKey(d.scope, scope));
    const note = inScope.find((d) => d.from <= range.from && range.to <= d.to);
    if (exclusionsFor(scope, note).some((r) => overlaps(range, r))) continue;
    if (inScope.some((d) => overlaps(range, d.marker))) continue;
    if (!inScope.some((d) => d.label === match[1])) continue;
    found.push({ ...range, label: match[1], scope, inNote: !!note });
  }
  return found;
}

function sameScopeKey(a: FootnoteScope, b: FootnoteScope): boolean {
  return scopeKey(a) === scopeKey(b);
}

/**
 * Numbers per conversion as the framework publishes them
 * (`renumber_footnotes_by_reference`, scripts/telar/latex.py): the order a
 * reader meets the references — the text first, then the notes — with a
 * note referenced twice keeping its first number. Unreferenced notes follow,
 * in definition order.
 */
function numbering(references: FoundReference[], definitions: NoteDefinition[]) {
  const ordered = [...references].sort(
    (a, b) => Number(a.inNote) - Number(b.inNote) || a.from - b.from,
  );
  const numbers = new Map<number, Map<string, number>>();
  const numbersOf = (scope: FootnoteScope) => {
    const key = scopeKey(scope);
    if (!numbers.has(key)) numbers.set(key, new Map());
    return numbers.get(key)!;
  };
  for (const ref of ordered) {
    const own = numbersOf(ref.scope);
    if (!own.has(ref.label)) own.set(ref.label, own.size + 1);
  }
  for (const d of definitions) {
    const own = numbersOf(d.scope);
    if (!own.has(d.label)) own.set(d.label, own.size + 1);
  }
  return (scope: FootnoteScope, label: string) => numbersOf(scope).get(label)!;
}

/** References and notes with their published numbers. */
export function readNotes(state: EditorState): PanelNotes {
  const reading = readPanel(state);
  const definitions = definitionsIn(state, reading);
  const found = findReferences(reading, definitions);
  const numberOf = numbering(found, definitions);
  const count = (d: NoteDefinition) =>
    definitions.filter((o) => o.label === d.label && sameScopeKey(o.scope, d.scope)).length;
  const references = found.map(({ inNote: _inNote, ...ref }) => ({
    ...ref,
    number: numberOf(ref.scope, ref.label),
  }));
  const notes = definitions
    .map((d) => ({ ...d, number: numberOf(d.scope, d.label), duplicate: count(d) > 1 }))
    .sort((a, b) => scopeKey(a.scope) - scopeKey(b.scope) || a.number - b.number);
  return { references, notes };
}

/** Blocks a reference cannot start, end or sit inside without breaking. */
const BLOCK_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "LinkReference",
]);
/** Inline spans a reference cannot sit inside; their edges are fine. */
const INLINE_NODES = new Set([
  "InlineCode",
  "Link",
  "Image",
  "Autolink",
  "URL",
  "Comment",
  "HTMLTag",
  "ProcessingInstruction",
]);

function blocksPosition(syntax: ConversionSyntax, node: SyntaxNodeRef, pos: number): boolean {
  if (INLINE_NODES.has(node.name)) return node.from < pos && pos < node.to;
  if (!BLOCK_NODES.has(node.name)) return false;
  // A `[^label]: text` line can parse as a link reference definition.
  if (node.name === "LinkReference" && syntax.source.startsWith("[^", node.from)) return false;
  return node.from <= pos && pos <= node.to;
}

/**
 * Whether `at` is in a `markdown` container's tag: inside it, or in front of
 * it on its own line, where a reference would stop the tag starting a line.
 */
function insideTag(source: string, tag: SourceRange, at: number): boolean {
  if (tag.from < at && at < tag.to) return true;
  const lineFrom = lineStart(source, tag.from);
  return at === tag.from && !source.slice(lineFrom, tag.from).trim();
}

function insideExcludedSyntax(syntax: ConversionSyntax, pos: number): boolean {
  const at = Math.min(Math.max(0, pos - syntax.offset), syntax.source.length);
  if (syntax.html.some((r) => (r.span ? false : r.tag ? insideTag(syntax.source, r, at) : r.from <= at && at <= r.to))) return true;
  let blocked = false;
  syntax.tree.iterate({
    from: at,
    to: at,
    enter(node) {
      if (blocked) return false;
      blocked = blocksPosition(syntax, node, at);
    },
  });
  return blocked;
}

function insideDefinitionMarker(state: EditorState, pos: number): boolean {
  return parseDefinitions(state).some(
    (d) => d.from <= pos && pos < d.marker.to,
  );
}

/** The conversion a reference at `pos` would belong to; null where it cannot go. */
export function footnoteScopeAt(state: EditorState, pos: number): FootnoteScope | null {
  const text = state.doc.toString();
  const widgets = findWidgets(text);
  const scope = widgetScopeAt(text, widgets, pos);
  if (!scope || isEscaped(text, pos)) return null;
  const syntax = syntaxCache(state, text, widgets)(scope);
  if (insideExcludedSyntax(syntax, pos) || insideDefinitionMarker(state, pos)) return null;
  return definitionSite(state, scope, pos) === null ? null : scope;
}

/**
 * Where a new definition for a reference in `scope` is written: the end of the
 * conversion, unless a raw HTML block with no end tag runs to that end, where
 * the definition would be raw text. Python Markdown finds a definition
 * anywhere in the conversion, so it goes on the line before that block
 * starts, or before the closed block that line begins inside. That line can
 * precede `at`: a reference inside an unclosed `markdown="span"` container
 * still works with its definition above the container.
 */
export function definitionSite(state: EditorState, scope: FootnoteScope, at: number): number | null {
  const text = state.doc.toString();
  const syntax = syntaxCache(state, text, findWidgets(text))(scope);
  const html = syntax.html.map((r) => ({
    from: r.from + syntax.offset,
    to: r.to + syntax.offset,
    unclosed: r.unclosed,
  }));
  const open = html.filter((r) => r.unclosed).sort((a, b) => a.from - b.from)[0];
  if (!open) return scope.end;
  let site = lineStart(text, open.from);
  // Every step moves strictly earlier, so the loop ends; a step that could
  // not is a refusal.
  for (let moved = true; moved; ) {
    moved = false;
    for (const r of html) {
      if (r.from < site && site < r.to) {
        const earlier = lineStart(text, r.from);
        if (earlier >= site) return null;
        site = earlier;
        moved = true;
      }
    }
  }
  return site;
}
