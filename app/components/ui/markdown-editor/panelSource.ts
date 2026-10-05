/**
 * Panel source ranges keep authoring controls attached to Markdown, without
 * serialising the panel through a second content model. Parsed fields retain
 * their exact offsets; callers replace only the field the author changed.
 *
 * Widgets are found and split as the framework's `process_widgets` finds and
 * splits them (scripts/telar/widgets.py): the fence pattern of
 * footnoteScopes.ts, code or not; accordion and tabs sections on literal
 * `## ` lines; bibliography entries on every blank line; carousel items on
 * every `---`, wherever it falls; carousel fields as `key: value` lines,
 * skipping lines that start with `#`, the last of a repeated key winning.
 * A fence that does not start and end its own lines, or an unknown widget
 * type, is left as ordinary editable source. Nothing is ever rewritten
 * except the field an author edits, so fields the editor does not know
 * survive byte for byte.
 *
 * Every field carries its role, and a write through a bookmark checks that
 * the text at the bookmark is still a field with that role: a collaborator
 * who renames `caption:` to `alt:`, or turns a heading into prose, leaves
 * the text in place but changes what it is, and the write is refused.
 *
 * A section whose heading is the last line of its widget has no content
 * line. Its content field is empty at the end of the heading line and
 * carries `lead`, a line break written before the first text typed into it,
 * so that text never joins the heading.
 *
 * @version v1.5.0-beta
 */
import type { EditorState, ChangeDesc } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  bibliographyEntries,
  findWidgets,
  headingLines,
  widgetSections,
  type Widget,
} from "./footnoteScopes";
import type { SourceRange } from "./footnoteSyntax";

export type { SourceRange };
export type WidgetKind = "accordion" | "tabs" | "carousel" | "bibliography";
/** What a field is: its widget's kind and its key (`title`, `body` or a carousel key). */
export interface FieldRole {
  widget: WidgetKind;
  key: string;
}
export interface SourceField extends SourceRange {
  value: string;
  /** Written before the first text typed into an empty field. */
  lead?: string;
  role?: FieldRole;
}
export interface PanelSection extends SourceRange {
  source: string;
  title?: SourceField;
  body?: SourceField;
  fields?: Record<string, SourceField>;
  /** The span that removing this section deletes, separators included. */
  removal: SourceRange;
}
export interface PanelWidget extends SourceRange {
  source: string;
  kind: WidgetKind;
  body: SourceRange;
  sections: PanelSection[];
}

const KINDS = new Set<string>(["accordion", "tabs", "carousel", "bibliography"]);

/** A field with its structural line breaks outside it; spaces stay inside. */
function field(text: string, from: number, to: number): SourceField {
  const raw = text.slice(from, to);
  if (!raw.replace(/[\r\n]/g, "")) return { from, to: from, value: "" };
  const left = /^[\r\n]+/.exec(raw)?.[0].length ?? 0;
  const right = /[\r\n]+$/.exec(raw)?.[0].length ?? 0;
  return { from: from + left, to: to - right, value: raw.slice(left, raw.length - right) };
}

/** Removal spans for consecutive pieces of a body, with their separators. */
function removals(pieces: SourceRange[], body: SourceRange): SourceRange[] {
  return pieces.map((piece, i) => {
    if (i + 1 < pieces.length) return { from: piece.from, to: pieces[i + 1].from };
    if (i > 0) return { from: pieces[i - 1].to, to: body.to };
    return { from: piece.from, to: body.to };
  });
}

function withRole(source: SourceField, widget: Widget, key: string): SourceField {
  return { ...source, role: { widget: widget.type as WidgetKind, key } };
}

function sectionedSections(text: string, widget: Widget): PanelSection[] {
  const headings = headingLines(text, widget);
  const contents = widgetSections(text, widget);
  const pieces = headings.map((h, i) => ({ from: h.from, to: contents[i].end }));
  const removal = removals(pieces, { from: widget.bodyFrom, to: widget.bodyTo });
  return headings.map((h, i) => {
    const content = contents[i];
    const body =
      content.from > content.end
        ? { from: content.end, to: content.end, value: "", lead: "\n" }
        : field(text, content.from, content.end);
    return {
      ...pieces[i],
      source: text.slice(pieces[i].from, pieces[i].to),
      title: withRole({ from: h.from + 3, to: h.to, value: text.slice(h.from + 3, h.to) }, widget, "title"),
      body: withRole(body, widget, "body"),
      removal: removal[i],
    };
  });
}

function bibliographySections(text: string, widget: Widget): PanelSection[] {
  const entries = bibliographyEntries(text, widget).map((e) => ({ from: e.from, to: e.end }));
  const removal = removals(entries, { from: widget.bodyFrom, to: widget.bodyTo });
  return entries.map((entry, i) => ({
    ...entry,
    source: text.slice(entry.from, entry.to),
    body: withRole(field(text, entry.from, entry.to), widget, "body"),
    removal: removal[i],
  }));
}

/** The body split on every `---`, as `content.split('---')`. */
function carouselPieces(text: string, widget: Widget): SourceRange[] {
  const pieces: SourceRange[] = [];
  let from = widget.bodyFrom;
  for (;;) {
    const separator = text.indexOf("---", from);
    if (separator === -1 || separator + 3 > widget.bodyTo) break;
    pieces.push({ from, to: separator });
    from = separator + 3;
  }
  pieces.push({ from, to: widget.bodyTo });
  return pieces;
}

/** `key: value` lines of one item, as `parse_key_value_block` reads them. */
function carouselFields(text: string, widget: Widget, item: SourceRange): Record<string, SourceField> {
  const fields: Record<string, SourceField> = {};
  let lineFrom = item.from;
  while (lineFrom <= item.to) {
    const newline = text.indexOf("\n", lineFrom);
    const lineTo = newline === -1 || newline > item.to ? item.to : newline;
    const line = text.slice(lineFrom, lineTo);
    const colon = line.indexOf(":");
    if (colon !== -1 && !line.trim().startsWith("#")) {
      const lead = /^[ \t]*/.exec(line.slice(colon + 1))![0].length;
      const valueFrom = lineFrom + colon + 1 + lead;
      const valueTo = line.endsWith("\r") ? lineTo - 1 : lineTo;
      const key = line.slice(0, colon).trim();
      fields[key] = withRole(field(text, valueFrom, Math.max(valueFrom, valueTo)), widget, key);
    }
    lineFrom = lineTo + 1;
  }
  return fields;
}

function carouselSections(text: string, widget: Widget): PanelSection[] {
  const pieces = carouselPieces(text, widget);
  const removal = removals(pieces, { from: widget.bodyFrom, to: widget.bodyTo });
  const sections: PanelSection[] = [];
  pieces.forEach((piece, i) => {
    if (!text.slice(piece.from, piece.to).trim()) return;
    sections.push({
      ...piece,
      source: text.slice(piece.from, piece.to),
      fields: carouselFields(text, widget, piece),
      removal: removal[i],
    });
  });
  return sections;
}

function sectionsOf(text: string, widget: Widget): PanelSection[] {
  if (widget.type === "bibliography") return bibliographySections(text, widget);
  if (widget.type === "carousel") return carouselSections(text, widget);
  return sectionedSections(text, widget);
}

/** A widget the editor can box: a known type whose fences own their lines. */
function boxable(text: string, widget: Widget): boolean {
  const startsLine = widget.from === 0 || text[widget.from - 1] === "\n";
  const endsLine = widget.to === text.length || text[widget.to] === "\n";
  return KINDS.has(widget.type) && startsLine && endsLine;
}

export function parsePanel(state: EditorState): { widgets: PanelWidget[] } {
  const text = state.doc.toString();
  const widgets = findWidgets(text)
    .filter((w) => boxable(text, w))
    .map((w) => ({
      from: w.from,
      to: w.to,
      source: text.slice(w.from, w.to),
      kind: w.type as WidgetKind,
      body: { from: w.bodyFrom, to: w.bodyTo },
      sections: sectionsOf(text, w),
    }));
  return { widgets };
}

/** Replace `range`, when it still reads `expected`, by its changed middle only. */
export function replacePanelField(
  view: EditorView,
  range: SourceRange,
  expected: string,
  insert: string,
): boolean {
  if (view.state.readOnly || view.state.sliceDoc(range.from, range.to) !== expected) return false;
  let start = 0;
  let oldEnd = expected.length;
  let newEnd = insert.length;
  while (start < oldEnd && start < newEnd && expected[start] === insert[start]) start++;
  while (oldEnd > start && newEnd > start && expected[oldEnd - 1] === insert[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  view.dispatch({
    changes: { from: range.from + start, to: range.from + oldEnd, insert: insert.slice(start, newEnd) },
    userEvent: "input",
  });
  return true;
}

/**
 * Live field bookmarks are updated synchronously, before React can paint a new
 * field. A remote edit inside a field invalidates the old input event instead of
 * letting that event overwrite the other author's text.
 */
export interface FieldBookmark extends SourceField {
  expected: string;
  valid: boolean;
  writing: boolean;
}
const bookmarks = new WeakMap<EditorView, Set<FieldBookmark>>();
export function bookmarkField(view: EditorView, source: SourceField): FieldBookmark {
  const bookmark = { ...source, expected: source.value, valid: true, writing: false };
  let set = bookmarks.get(view);
  if (!set) bookmarks.set(view, (set = new Set()));
  set.add(bookmark);
  return bookmark;
}
export function releaseBookmark(view: EditorView, bookmark: FieldBookmark) {
  bookmarks.get(view)?.delete(bookmark);
}
export function updateBookmarks(view: EditorView, changes: ChangeDesc) {
  for (const bookmark of bookmarks.get(view) ?? []) {
    let touched = false;
    changes.iterChangedRanges((from, to) => {
      if (from <= bookmark.to && to >= bookmark.from) touched = true;
    });
    if (touched && !bookmark.writing) bookmark.valid = false;
    bookmark.from = changes.mapPos(bookmark.from, -1);
    bookmark.to = changes.mapPos(bookmark.to, 1);
  }
}

function fieldsOf(section: PanelSection): SourceField[] {
  const own = [section.title, section.body].filter((f): f is SourceField => !!f);
  return [...own, ...Object.values(section.fields ?? {})];
}

/**
 * Whether the bookmark still marks a field with its role: the same span, in
 * a widget of the same kind, under the same key. A bookmark without a role
 * marks no field and always holds.
 */
export function fieldHolds(view: EditorView, bookmark: FieldBookmark): boolean {
  const role = bookmark.role;
  if (!role) return true;
  return parsePanel(view.state).widgets.some((w) =>
    w.sections.some((section) =>
      fieldsOf(section).some(
        (f) =>
          f.from === bookmark.from &&
          f.to === bookmark.to &&
          f.role?.widget === role.widget &&
          f.role.key === role.key,
      ),
    ),
  );
}

/** The first write into a field with a `lead` writes the lead before it. */
function writeLead(view: EditorView, bookmark: FieldBookmark, insert: string): boolean {
  const lead = bookmark.lead!;
  if (!replacePanelField(view, bookmark, "", lead + insert)) return false;
  bookmark.from += lead.length;
  bookmark.lead = undefined;
  return true;
}

export function replaceBookmarkedField(
  view: EditorView,
  bookmark: FieldBookmark,
  insert: string,
): boolean {
  if (!bookmark.valid) return false;
  if (!fieldHolds(view, bookmark)) {
    bookmark.valid = false;
    return false;
  }
  bookmark.writing = true;
  try {
    const leading = bookmark.lead && bookmark.expected === "" && insert !== "";
    const changed = leading
      ? writeLead(view, bookmark, insert)
      : replacePanelField(view, bookmark, bookmark.expected, insert);
    if (changed) bookmark.expected = insert;
    return changed;
  } finally {
    bookmark.writing = false;
  }
}

/** A shorter, older field can still match a prefix; offsets must match too. */
export function isCurrentFieldSnapshot(
  view: EditorView,
  source: SourceField,
  bookmark: FieldBookmark | null,
): boolean {
  return (
    view.state.sliceDoc(source.from, source.to) === source.value &&
    (!bookmark ||
      (bookmark.from === source.from &&
        bookmark.to === source.to &&
        (!bookmark.valid || bookmark.expected === source.value)))
  );
}
