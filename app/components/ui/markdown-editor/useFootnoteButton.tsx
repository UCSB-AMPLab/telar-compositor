/**
 * useFootnoteButton — the MarkdownEditor's footnote wiring: the state field
 * the editor must carry, the toolbar action that sets the insertion point at
 * the cursor and opens FootnotePopover under it, and the text of a refused
 * insert, or of a popover closed because its place scrolled out of view,
 * which is offered again the next time the popover opens on the same
 * document (for an edit, on the same note with the same text).
 *
 * With a widget field focused (fieldFocus.ts), the insertion point is the
 * field's caret mapped into the panel and the popover opens under the field,
 * so a note goes where the author is typing rather than where the panel's
 * own selection was left. When that field has gone away, the popover says a
 * note cannot go there, as it does for any refused position. `edit` opens an existing note's text for editing,
 * from its number or the note list.
 *
 * `extensions` is empty when footnotes are not enabled, so the editor can
 * spread it unconditionally. `reset` closes the popover and drops the kept
 * text; it belongs in the cleanup of whatever destroys the EditorView. The
 * kept text is also dropped when the document (the Y.Text, or the
 * standalone initial value) changes identity, so a note written for one
 * layer never appears in another.
 *
 * @version v1.5.0-beta
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type * as Y from "yjs";
import { FootnoteEdit, FootnotePopover, noteTextRange } from "./FootnotePopover";
import { caretAnchor, elementAnchor, type PopoverAnchor } from "./EditorPopover";
import { panelTarget, setPanelTarget } from "./footnoteSource";
import type { FootnoteScope } from "./footnoteScopes";
import { footnoteScopeAt, parseDefinitions } from "./footnoteSyntax";
import { LOST, fieldCaret, focusedField, type FocusedField } from "./fieldFocus";

interface FootnoteButtonOptions {
  enabled: boolean;
  viewRef: RefObject<EditorView | null>;
  /** What the popover opens under when the caret cannot be measured. */
  anchorFallback: () => Element | null;
  /** The shared undo manager in collaborative mode; null otherwise. */
  undoManager: Y.UndoManager | null | undefined;
  /** The shared text in collaborative mode, which a publish locks; null otherwise. */
  yText: Y.Text | null;
  isPublishing: boolean;
  /** The standalone editor's document, which identifies it when there is no Y.Text. */
  initialValue: string;
}

type OpenPopover =
  | { mode: "insert"; anchor: PopoverAnchor; scope: FootnoteScope | null }
  | { mode: "edit"; anchor: PopoverAnchor; from: number; source: string; text: string };

/** What an edit closed by a scroll left written, for the same note. */
type KeptEdit = { from: number; source: string; body: string };

/** What the popover opens under for a focused field: its caret, or the field. */
function fieldAnchor(
  view: EditorView,
  target: FocusedField | typeof LOST,
  fallback: () => Element | null,
): PopoverAnchor {
  if (target === LOST) return caretAnchor(view, view.state.selection.main.head, fallback);
  if (target.kind === "editor") return caretAnchor(target.view, target.view.state.selection.main.head, fallback);
  return elementAnchor(target.input);
}

/** Where a new note goes and what the popover opens under, from the focus. */
function insertionPoint(view: EditorView, fallback: () => Element | null) {
  const target = focusedField(view);
  if (!target) {
    const at = view.state.selection.main.head;
    return { at, anchor: caretAnchor(view, at, fallback) };
  }
  return { at: fieldCaret(view, target), anchor: fieldAnchor(view, target, fallback) };
}

export function useFootnoteButton({
  enabled,
  viewRef,
  anchorFallback,
  undoManager,
  yText,
  isPublishing,
  initialValue,
}: FootnoteButtonOptions) {
  const documentKey = yText ?? initialValue;
  const [opened, setOpened] = useState<OpenPopover | null>(null);
  const draft = useRef("");
  const keptEdit = useRef<KeptEdit | null>(null);
  const extensions: Extension[] = enabled ? [panelTarget] : [];

  useEffect(() => {
    draft.current = "";
    keptEdit.current = null;
    setOpened(null);
  }, [documentKey]);

  function openFootnotePopover() {
    const view = viewRef.current;
    if (!view || view.state.readOnly) return;
    const { at, anchor } = insertionPoint(view, anchorFallback);
    const scope = at === null ? null : footnoteScopeAt(view.state, at);
    view.dispatch({ effects: setPanelTarget.of(scope && at !== null ? { from: at, to: at } : null) });
    setOpened({ mode: "insert", anchor, scope });
  }

  function editFootnote(definitionFrom: number) {
    const view = viewRef.current;
    if (!view || view.state.readOnly) return;
    const note = parseDefinitions(view.state).find((d) => d.from === definitionFrom);
    if (!note) return;
    const range = noteTextRange(view, note);
    view.dispatch({ effects: setPanelTarget.of(range) });
    const source = view.state.sliceDoc(range.from, range.to);
    const kept = keptEdit.current;
    const text = kept && kept.from === definitionFrom && kept.source === source ? kept.body : note.text;
    keptEdit.current = null;
    setOpened({ mode: "edit", anchor: caretAnchor(view, note.from, anchorFallback), from: definitionFrom, source, text });
  }

  function closeFootnotePopover(keptText: string) {
    draft.current = keptText;
    setOpened(null);
  }

  function resetFootnotes() {
    draft.current = "";
    keptEdit.current = null;
    setOpened(null);
  }

  const view = viewRef.current;
  const isolateUndo = () => undoManager?.stopCapturing();
  let popover = null;
  if (opened && view && opened.mode === "edit") {
    popover = (
      <FootnoteEdit
        view={view}
        anchor={opened.anchor}
        source={opened.source}
        text={opened.text}
        onClose={() => setOpened(null)}
        onDetach={(body) => {
          keptEdit.current = { from: opened.from, source: opened.source, body };
          setOpened(null);
        }}
        isolateUndo={isolateUndo}
      />
    );
  } else if (opened && view && opened.mode === "insert") {
    popover = (
      <FootnotePopover
        view={view}
        anchor={opened.anchor}
        scope={opened.scope}
        initialText={draft.current}
        onClose={closeFootnotePopover}
        isolateUndo={isolateUndo}
      />
    );
  }

  return {
    extensions,
    open: openFootnotePopover,
    edit: editFootnote,
    reset: resetFootnotes,
    popover,
    disabled: yText !== null && isPublishing,
  };
}
