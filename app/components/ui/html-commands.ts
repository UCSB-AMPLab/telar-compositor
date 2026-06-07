/**
 * HTML editor commands — pure transforms + thin CodeMirror wrappers.
 *
 * The transforms compute the replacement string and resulting selection for an
 * inline-HTML wrap (<strong>/<em>) or an <a> link, given the document and a
 * [from,to) selection. They are pure so the wrapping logic is unit-testable
 * without mounting CodeMirror. The exported `wrapHtml`/`insertHtmlLink` apply a
 * transform to a live EditorView (used by the toolbar and keymap).
 *
 * `wrapHtmlTransform` TOGGLES: a second invocation on already-wrapped text
 * removes the tags (whether the selection includes the tags, or the tags
 * immediately surround the selection — the state left after the first wrap).
 *
 * HTML-only by design: the site-description field stores HTML and renders raw
 * into the homepage <p class="lead"> (see InlineHtmlEditor).
 *
 * @version v1.3.0-beta
 */
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";

export type InlineTag = "strong" | "em";

export interface HtmlTransform {
  insert: string;        // text inserted in place of [from,to)
  from: number;
  to: number;
  selectionFrom: number; // caret/selection start in the resulting doc
  selectionTo: number;
  /** Helper for tests: apply this transform to its source doc. */
  doc: (self: HtmlTransform) => string;
}

/** Snapshot of the editor selection captured when the link popover opens. */
export interface LinkSnapshot {
  from: number;
  to: number;
  text: string;
}

/** Escape a string for use inside a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Low-level: replace [from,to) with `insert`, leaving the selection [selFrom,selTo). */
function make(
  srcDoc: string,
  from: number,
  to: number,
  insert: string,
  selFrom: number,
  selTo: number,
): HtmlTransform {
  return {
    insert,
    from,
    to,
    selectionFrom: selFrom,
    selectionTo: selTo,
    doc: (self) => srcDoc.slice(0, self.from) + self.insert + srcDoc.slice(self.to),
  };
}

export function wrapHtmlTransform(doc: string, from: number, to: number, tag: InlineTag): HtmlTransform {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const selected = doc.slice(from, to);

  // Toggle OFF — case A: the selection itself includes the wrapping tags.
  if (
    selected.startsWith(open) &&
    selected.endsWith(close) &&
    selected.length >= open.length + close.length
  ) {
    const inner = selected.slice(open.length, selected.length - close.length);
    return make(doc, from, to, inner, from, from + inner.length);
  }

  // Toggle OFF — case B: the tags immediately surround the selection. This is
  // the state left after the first wrap (selection = inner text), so a second
  // toolbar click / keypress unwraps instead of nesting another tag.
  if (
    from >= open.length &&
    doc.slice(from - open.length, from) === open &&
    doc.slice(to, to + close.length) === close
  ) {
    return make(
      doc,
      from - open.length,
      to + close.length,
      selected,
      from - open.length,
      from - open.length + selected.length,
    );
  }

  // Otherwise: wrap, leaving the inner text selected.
  const insert = `${open}${selected}${close}`;
  return make(doc, from, to, insert, from + open.length, from + open.length + selected.length);
}

/**
 * Build an anchor transform. `text` is the snapshot link text captured when the
 * popover opened (preferred over the live doc slice, which may be stale once the
 * popover input steals focus). Falls back to the doc slice, then the url.
 */
export function htmlLinkTransform(
  doc: string,
  from: number,
  to: number,
  url: string,
  text?: string,
): HtmlTransform {
  const selected = text ?? doc.slice(from, to);
  const linkText = selected.length > 0 ? selected : url;
  const open = `<a href="${escapeAttr(url)}">`;
  const insert = `${open}${linkText}</a>`;
  return make(doc, from, to, insert, from + open.length, from + open.length + linkText.length);
}

// --- thin EditorView wrappers (used by the toolbar + keymap) ---

export function wrapHtml(view: EditorView, tag: InlineTag): void {
  const { from, to } = view.state.selection.main;
  const t = wrapHtmlTransform(view.state.doc.toString(), from, to, tag);
  view.dispatch({
    changes: { from: t.from, to: t.to, insert: t.insert },
    selection: EditorSelection.range(t.selectionFrom, t.selectionTo),
  });
  view.focus();
}

/**
 * Insert an anchor. When `snapshot` is provided (captured at popover-open), its
 * range + text are used — robust against the live selection being lost/collapsed
 * after the popover input takes focus. Without it, the live selection is used.
 */
export function insertHtmlLink(view: EditorView, url: string, snapshot?: LinkSnapshot): void {
  const sel = view.state.selection.main;
  const from = snapshot?.from ?? sel.from;
  const to = snapshot?.to ?? sel.to;
  const t = htmlLinkTransform(view.state.doc.toString(), from, to, url, snapshot?.text);
  view.dispatch({
    changes: { from: t.from, to: t.to, insert: t.insert },
    selection: EditorSelection.range(t.selectionFrom, t.selectionTo),
  });
  view.focus();
}
