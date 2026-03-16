/**
 * commands.ts — Markdown formatting commands for the CodeMirror-based MarkdownEditor.
 *
 * Pure-ish command functions that operate on an EditorView. Each function
 * dispatches a single transaction and calls view.focus() so the editor
 * retains focus after toolbar clicks.
 */

import { EditorView } from "@codemirror/view";

// ---------------------------------------------------------------------------
// Exported pure helper (used in unit tests without DOM)
// ---------------------------------------------------------------------------

/**
 * Wrap or unwrap text with a marker (e.g. "**" for bold, "_" for italic).
 * Used as a pure helper by insertMarkdownWrap and by unit tests.
 */
export function wrapText(text: string, marker: string): string {
  if (text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2) {
    return text.slice(marker.length, text.length - marker.length);
  }
  return `${marker}${text}${marker}`;
}

// ---------------------------------------------------------------------------
// View commands
// ---------------------------------------------------------------------------

/**
 * Wraps the current selection with `marker` (e.g. "**" for bold).
 * If the selection is already wrapped, unwraps it.
 */
export function insertMarkdownWrap(view: EditorView, marker: string): void {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  const isWrapped =
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length >= marker.length * 2;

  if (isWrapped) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
  } else {
    const wrapped = `${marker}${selected}${marker}`;
    view.dispatch({
      changes: { from, to, insert: wrapped },
      selection: { anchor: from + marker.length, head: to + marker.length },
    });
  }

  view.focus();
}

/**
 * Toggles a heading at the cursor line.
 * If the line already starts with `#{level} `, removes the heading marker.
 * Otherwise, replaces any existing heading prefix with `#{level} `.
 */
export function toggleHeading(view: EditorView, level: number): void {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  const lineText = line.text;
  const prefix = "#".repeat(level) + " ";
  const headingPattern = /^(#{1,6})\s/;

  if (lineText.startsWith(prefix)) {
    // Remove heading prefix
    view.dispatch({
      changes: { from: line.from, to: line.from + prefix.length, insert: "" },
    });
  } else {
    const match = lineText.match(headingPattern);
    if (match) {
      // Replace existing heading prefix
      const existingPrefix = match[0];
      view.dispatch({
        changes: { from: line.from, to: line.from + existingPrefix.length, insert: prefix },
      });
    } else {
      // Add heading prefix
      view.dispatch({
        changes: { from: line.from, to: line.from, insert: prefix },
      });
    }
  }

  view.focus();
}

/**
 * Toggles a bullet list marker (`- `) at the cursor line.
 */
export function toggleBulletList(view: EditorView): void {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  const marker = "- ";

  if (line.text.startsWith(marker)) {
    view.dispatch({
      changes: { from: line.from, to: line.from + marker.length, insert: "" },
    });
  } else {
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: marker },
    });
  }

  view.focus();
}

/**
 * Toggles an ordered list marker (`1. `) at the cursor line.
 * If already ordered (`N. `), removes the marker. Otherwise adds `1. `.
 */
export function toggleOrderedList(view: EditorView): void {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  const orderedPattern = /^\d+\.\s/;
  const match = line.text.match(orderedPattern);

  if (match) {
    view.dispatch({
      changes: { from: line.from, to: line.from + match[0].length, insert: "" },
    });
  } else {
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: "1. " },
    });
  }

  view.focus();
}

/**
 * Toggles a blockquote marker (`> `) at the cursor line.
 */
export function toggleBlockquote(view: EditorView): void {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  const marker = "> ";

  if (line.text.startsWith(marker)) {
    view.dispatch({
      changes: { from: line.from, to: line.from + marker.length, insert: "" },
    });
  } else {
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: marker },
    });
  }

  view.focus();
}

/**
 * Indents the current line by adding two spaces at the start.
 */
export function indentLine(view: EditorView): void {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: "  " },
  });
  view.focus();
}

/**
 * Outdents the current line by removing up to two leading spaces.
 */
export function outdentLine(view: EditorView): void {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  const match = line.text.match(/^( {1,2})/);
  if (match) {
    view.dispatch({
      changes: { from: line.from, to: line.from + match[1].length, insert: "" },
    });
  }
  view.focus();
}

/**
 * Inserts a markdown link at the cursor.
 * If text is selected, uses it as link text; otherwise uses the provided `text` param.
 */
export function insertLink(view: EditorView, url: string, text?: string): void {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const linkText = text || selected || url;
  const markdown = `[${linkText}](${url})`;

  view.dispatch({
    changes: { from, to, insert: markdown },
    selection: { anchor: from + markdown.length },
  });

  view.focus();
}

/**
 * Inserts a markdown image at the cursor position.
 */
export function insertImage(view: EditorView, url: string, alt: string): void {
  const { from, to } = view.state.selection.main;
  const markdown = `![${alt}](${url})`;

  view.dispatch({
    changes: { from, to, insert: markdown },
    selection: { anchor: from + markdown.length },
  });

  view.focus();
}
