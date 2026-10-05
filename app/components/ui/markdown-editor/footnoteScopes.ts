/**
 * Footnote scopes follow how the framework converts a layer panel, since a
 * reference only works when its definition is in the same Markdown
 * conversion.
 *
 * The framework's `process_widgets` (scripts/telar/widgets.py) runs before
 * the panel is converted and matches `:::(\w+)\s*\n(.*?)\n:::` across lines,
 * with no regard for code. Each accordion or tabs section — the lines after
 * a `## ` line, up to the next `## ` line or the closing fence — is converted
 * on its own; lines before the first heading are dropped. A bibliography's
 * body is split on every blank line (`content.split('\n\n')`) and each
 * non-empty entry is converted on its own, footnotes included. Carousel text
 * is converted without footnotes, and an unknown widget type renders an
 * error. Everything outside a matched widget, including an unclosed fence,
 * is the top-level conversion, whose definitions go at the end of the
 * document.
 *
 * By structure alone, a reference has no conversion on a widget's fence
 * line or a section's heading line, in a carousel or unknown widget, before
 * a widget's first heading, or in the blank line between two bibliography
 * entries. Syntax within a conversion is read in footnoteSyntax.ts.
 *
 * @version v1.5.0-beta
 */
/**
 * One Markdown conversion and the position its definitions are added at. A
 * bibliography entry is a section marked `entry`: a blank line would end
 * it, so its definitions follow it on the next line.
 */
export type FootnoteScope =
  | { kind: "top"; end: number }
  | { kind: "section"; from: number; end: number; entry?: true };

export interface Widget {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  type: string;
}

export interface WidgetSection {
  from: number;
  end: number;
}

/** The framework's fence, with Python's Unicode `\w`. */
const WIDGET_FENCE = /:::([\p{L}\p{N}_]+)\s*\n([\s\S]*?)\n:::/gu;
const CLOSING_FENCE_LENGTH = "\n:::".length;
const SECTIONED_WIDGETS = new Set(["accordion", "tabs"]);

export function findWidgets(text: string): Widget[] {
  return [...text.matchAll(WIDGET_FENCE)].map((match) => {
    const to = match.index + match[0].length;
    const bodyTo = to - CLOSING_FENCE_LENGTH;
    return {
      from: match.index,
      to,
      bodyFrom: bodyTo - match[2].length,
      bodyTo,
      type: match[1].toLowerCase(),
    };
  });
}

/** Line ranges of the `## ` lines in a widget's body. */
export function headingLines(text: string, widget: Widget): { from: number; to: number }[] {
  const headings: { from: number; to: number }[] = [];
  for (let lineFrom = widget.bodyFrom; lineFrom <= widget.bodyTo; ) {
    const newline = text.indexOf("\n", lineFrom);
    const lineTo =
      newline === -1 || newline > widget.bodyTo ? widget.bodyTo : newline;
    if (text.startsWith("## ", lineFrom)) headings.push({ from: lineFrom, to: lineTo });
    lineFrom = lineTo + 1;
  }
  return headings;
}

/**
 * Each section's content: from the line after its heading to the newline
 * before the next heading, or to the end of the body. A section with no
 * content lines has `from` past `end` and holds no position.
 */
export function widgetSections(text: string, widget: Widget): WidgetSection[] {
  const headings = headingLines(text, widget);
  return headings.map((heading, i) => ({
    from: heading.to + 1,
    end: i + 1 < headings.length ? headings[i + 1].from - 1 : widget.bodyTo,
  }));
}

/**
 * A bibliography's entries: the pieces between blank lines, each from its
 * first character to the blank line after it or the end of the body. Pieces
 * that are only whitespace are no entry.
 */
export function bibliographyEntries(text: string, widget: Widget): WidgetSection[] {
  const entries: WidgetSection[] = [];
  let from = widget.bodyFrom;
  while (from <= widget.bodyTo) {
    const blank = text.indexOf("\n\n", from);
    const end = blank === -1 || blank + 2 > widget.bodyTo ? widget.bodyTo : blank;
    if (text.slice(from, end).trim()) entries.push({ from, end });
    from = end + 2;
  }
  return entries;
}

function conversionsOf(text: string, widget: Widget): WidgetSection[] {
  if (widget.type === "bibliography") return bibliographyEntries(text, widget);
  return SECTIONED_WIDGETS.has(widget.type) ? widgetSections(text, widget) : [];
}

function scopeInWidget(text: string, widget: Widget, pos: number): FootnoteScope | null {
  if (pos < widget.bodyFrom || pos > widget.bodyTo) return null;
  const section = conversionsOf(text, widget).find(
    (s) => s.from <= pos && pos <= s.end,
  );
  if (!section) return null;
  const scope: FootnoteScope = { kind: "section", from: section.from, end: section.end };
  if (widget.type === "bibliography") scope.entry = true;
  return scope;
}

/** The conversion `pos` belongs to by widget structure alone; null outside any. */
export function widgetScopeAt(
  text: string,
  widgets: Widget[],
  pos: number,
): FootnoteScope | null {
  const widget = widgets.find((w) => w.from <= pos && pos < w.to);
  if (!widget) return { kind: "top", end: text.length };
  return scopeInWidget(text, widget, pos);
}

export function sameScope(a: FootnoteScope, b: FootnoteScope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "top" || a.from === (b as { from: number }).from;
}
