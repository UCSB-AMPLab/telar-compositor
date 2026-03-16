/**
 * livePreviewPlugin.ts — Obsidian-style live preview for the MarkdownEditor.
 *
 * A CodeMirror ViewPlugin that hides markdown syntax markers (**, ##, [], etc.)
 * on lines where the cursor is NOT present, while showing formatted styles via
 * CSS mark decorations. Syntax markers are revealed when the cursor enters
 * the formatted block.
 *
 * Implementation follows CodeMirror's decoration API:
 * https://codemirror.net/examples/decoration/
 */

import { ViewPlugin, Decoration, DecorationSet, EditorView, ViewUpdate, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";

// ---------------------------------------------------------------------------
// Decoration factories
// ---------------------------------------------------------------------------

const hidden = Decoration.mark({ class: "cm-md-syntax-hidden" });

function mark(cls: string) {
  return Decoration.mark({ class: cls });
}

// ---------------------------------------------------------------------------
// Horizontal rule widget
// ---------------------------------------------------------------------------

class HrWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement("hr");
    hr.className = "cm-md-hr";
    return hr;
  }
  ignoreEvent(): boolean { return false; }
}

// ---------------------------------------------------------------------------
// Range collector
// ---------------------------------------------------------------------------

interface Range {
  from: number;
  to: number;
  deco: Decoration;
}

// ---------------------------------------------------------------------------
// Core decoration builder
// ---------------------------------------------------------------------------

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range[] = [];
  // When unfocused, hide syntax on ALL lines (cursorLine = -1)
  const cursorLine = view.hasFocus
    ? view.state.doc.lineAt(view.state.selection.main.head).number
    : -1;

  // Helper: get the line number for a given position
  function lineOf(pos: number): number {
    return view.state.doc.lineAt(pos).number;
  }

  // Helper: check if a node spans the cursor line
  function onCursorLine(from: number, to: number): boolean {
    const startLine = lineOf(from);
    const endLine = lineOf(to);
    return cursorLine >= startLine && cursorLine <= endLine;
  }

  syntaxTree(view.state).iterate({
    enter(node) {
      const { from, to, name } = node;

      // Skip nodes on the cursor line — show raw markdown there
      if (onCursorLine(from, to)) return;

      switch (name) {
        // ----- Emphasis (*text* or _text_) -----
        case "EmphasisMark":
          ranges.push({ from, to, deco: hidden });
          break;
        case "Emphasis":
          ranges.push({ from, to, deco: mark("cm-md-em") });
          break;

        // ----- Strong emphasis (**text**) -----
        // EmphasisMark inside StrongEmphasis covers the ** markers;
        // StrongEmphasis covers the whole block for the content class
        case "StrongEmphasis":
          ranges.push({ from, to, deco: mark("cm-md-strong") });
          break;

        // ----- ATX headings -----
        case "HeaderMark":
          ranges.push({ from, to, deco: hidden });
          break;
        case "ATXHeading1":
          ranges.push({ from, to, deco: mark("cm-md-h1") });
          break;
        case "ATXHeading2":
          ranges.push({ from, to, deco: mark("cm-md-h2") });
          break;
        case "ATXHeading3":
          ranges.push({ from, to, deco: mark("cm-md-h3") });
          break;

        // ----- Links [text](url) -----
        case "LinkMark":
          ranges.push({ from, to, deco: hidden });
          break;
        case "URL":
          ranges.push({ from, to, deco: hidden });
          break;
        case "Link":
          ranges.push({ from, to, deco: mark("cm-md-link") });
          break;

        // ----- Images ![alt](url) -----
        case "Image": {
          // Hide the image syntax, show alt text with an image class
          ranges.push({ from, to, deco: mark("cm-md-image-alt") });
          break;
        }

        // ----- Inline code `code` -----
        case "CodeMark":
          ranges.push({ from, to, deco: hidden });
          break;
        case "InlineCode":
          ranges.push({ from, to, deco: mark("cm-md-code") });
          break;

        // ----- Code blocks -----
        case "FencedCode":
        case "CodeBlock":
          ranges.push({ from, to, deco: mark("cm-md-code-block") });
          break;

        // ----- Blockquote -----
        case "QuoteMark":
          ranges.push({ from, to, deco: hidden });
          break;
        case "Blockquote":
          ranges.push({ from, to, deco: mark("cm-md-blockquote") });
          break;

        // ----- Lists -----
        case "ListMark": {
          // BulletList markers: "-", "*", "+"  → hide and show CSS bullet
          // OrderedList markers: "1.", "2.", etc. → keep visible, style subtly
          const text = view.state.sliceDoc(from, to);
          if (/^\d+\./.test(text)) {
            ranges.push({ from, to, deco: mark("cm-md-ol-mark") });
          } else {
            ranges.push({ from, to, deco: mark("cm-md-ul-mark") });
          }
          break;
        }
        case "BulletList":
          ranges.push({ from, to, deco: mark("cm-md-ul") });
          break;
        case "OrderedList":
          ranges.push({ from, to, deco: mark("cm-md-ol") });
          break;

        // ----- Horizontal rule -----
        case "HorizontalRule": {
          // Insert an <hr> widget before the --- text, hide the raw text
          ranges.push({ from, to, deco: hidden });
          ranges.push({
            from,
            to: from,
            deco: Decoration.widget({ widget: new HrWidget(), side: 1 }),
          });
          break;
        }
      }
    },
  });

  // RangeSetBuilder requires ranges in ascending `from` order
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, deco } of ranges) {
    builder.add(from, to, deco);
  }

  return builder.finish();
}

// ---------------------------------------------------------------------------
// ViewPlugin export
// ---------------------------------------------------------------------------

class LivePreviewPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}

export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (v) => v.decorations,
});
