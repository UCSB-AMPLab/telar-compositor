/**
 * glossaryChipPlugin.ts — `[[term]]` chip decorations for the MarkdownEditor.
 *
 * A CodeMirror 6 ViewPlugin that scans the document for `[[term_id]]` /
 * `[[term_id|display]]` ranges and, when the cursor is OUTSIDE a range, replaces it with a
 * pill widget showing the term's resolved TITLE. When the cursor sits INSIDE the range the
 * chip unwraps to raw `[[term]]` brackets so the author can edit the slug. Term ids that
 * are absent from the resolution map get a wavy terracotta underline (`cm-glossary-unresolved`)
 * rather than a chip.
 *
 * Built as a sibling of `livePreviewPlugin` (NOT by extending it): the reveal semantics
 * differ — chips reveal on cursor/range overlap, not cursor-line — and `[[term]]` is not
 * markdown, so the doc text is scanned with a regex instead of the Lezer parse tree. The
 * plugin is a pure decoration layer: it never emits document edits, so the shared
 * Y.UndoManager stack is untouched. Resolution (term_id→title) is fed in reactively via
 * `glossaryMapField`.
 *
 * @version v1.3.0-beta
 */

import {
  ViewPlugin,
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { glossaryMapField } from "~/components/ui/markdown-editor/glossaryResolution";

// ---------------------------------------------------------------------------
// Link regex — group 1 = term_id, group 2 = optional display text. This must
// stay in sync with the framework's glossary parser (the published-site
// scripts), which treats the same `[[term_id|display]]` shape as the source of
// truth. The compositor's GlossaryLinkButton emits `[[term_id|display]]`,
// matching group(1) = term_id.
// ---------------------------------------------------------------------------

const LINK_RE = /\[\[\s*([^|\]]+?)(?:\s*\|\s*([^|\]]+?))?\s*\]\]/g;

// ---------------------------------------------------------------------------
// Chip widget — mirrors ImageWidget in livePreviewPlugin: builds DOM with textContent and
// dataset only (no raw HTML assignment); eq() as cache key; ignoreEvent() false so clicks
// reach the handler.
// ---------------------------------------------------------------------------

class GlossaryChipWidget extends WidgetType {
  constructor(
    readonly termId: string,
    readonly title: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-glossary-chip";
    el.textContent = this.title; // resolved TITLE, not the slug (XSS-safe: text node only)
    el.dataset.termId = this.termId; // click handler reads this to open the entry
    return el;
  }

  eq(other: GlossaryChipWidget): boolean {
    return this.termId === other.termId && this.title === other.title;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core decoration builder — pure over (state, resolutionMap), unit-testable headlessly.
// ---------------------------------------------------------------------------

interface Range {
  from: number;
  to: number;
  deco: Decoration;
}

/**
 * Build the chip / unresolved decorations for a `[[term]]`-bearing document.
 *
 * - resolved term_id + selection OUTSIDE the range → replace with a title chip widget;
 * - selection INSIDE the range (overlap) → no decoration (raw brackets revealed);
 * - unresolved term_id → a `cm-glossary-unresolved` mark (wavy underline), never a chip.
 *
 * View-only: this function reads state and returns decorations; it never mutates the doc.
 */
export function buildChipDecorations(
  state: EditorState,
  resolutionMap: Map<string, string>,
): DecorationSet {
  const ranges: Range[] = [];
  const text = state.doc.toString();
  const sel = state.selection.main;

  // Reset lastIndex defensively — LINK_RE is module-level and `g`-flagged (stateful).
  LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_RE.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    const termId = match[1].trim();

    const title = resolutionMap.get(termId);

    if (title === undefined) {
      // Unresolved term — wavy underline mark, regardless of cursor position.
      ranges.push({ from, to, deco: Decoration.mark({ class: "cm-glossary-unresolved" }) });
      continue;
    }

    // Reveal on cursor/range overlap (NOT cursor-line): skip the chip when the selection
    // touches the bracket range, so the author edits raw `[[term]]`.
    const cursorInside = sel.from <= to && sel.head >= from;
    if (cursorInside) continue;

    ranges.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new GlossaryChipWidget(termId, title),
        inclusive: false,
      }),
    });
  }

  // RangeSetBuilder requires ranges in ascending `from` order.
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, deco } of ranges) {
    builder.add(from, to, deco);
  }
  return builder.finish();
}

// ---------------------------------------------------------------------------
// ViewPlugin export — mirrors livePreviewPlugin's four-condition update guard.
// `selectionSet` is the trigger that flips chips in/out on cursor move.
// ---------------------------------------------------------------------------

class GlossaryChipPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildChipDecorations(view.state, view.state.field(glossaryMapField));
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.focusChanged ||
      update.startState.field(glossaryMapField) !== update.state.field(glossaryMapField)
    ) {
      this.decorations = buildChipDecorations(
        update.view.state,
        update.view.state.field(glossaryMapField),
      );
    }
  }
}

export const glossaryChipPlugin = ViewPlugin.fromClass(GlossaryChipPlugin, {
  decorations: (v) => v.decorations,
});
