/**
 * fieldFocus — which widget field of a layer panel the toolbar acts on.
 *
 * A widget box edits its fields in their own controls: a nested CodeMirror
 * view for section and entry text, an input for titles and carousel fields.
 * The panel editor's toolbar belongs to the outer view, whose selection does
 * not follow the caret in those controls. The field an author last focused
 * is recorded here against the outer view, and the toolbar's Bold, Italic,
 * Math and Footnote act on that field at its own caret. The record is kept
 * while focus moves onto the toolbar, so a keyboard press still reaches the
 * field, and dropped when the outer text takes focus. When the field goes
 * away instead — its widget removed or closed, by the author or anyone
 * else — the record becomes `lost`: the toolbar then does nothing until the
 * author puts the caret somewhere again, rather than acting on a selection
 * in the prose the author is not looking at. `useLostField` lets the
 * toolbar show that state: its buttons are marked disabled to assistive
 * technology, and a press explains why nothing happened.
 *
 * Only fields the framework converts as Markdown take formatting: section
 * and entry text, and a carousel's caption and credit. A title, alt text,
 * image or dimension is published as plain text, so formatting there does
 * nothing rather than writing markers a reader would see. Every write goes
 * through the field's bookmark, which refuses once the text at it is no
 * longer the same field (panelSource.ts), so a key renamed by someone else
 * before the control is redrawn is not formatted as the key it was. A footnote's
 * position is the field's caret mapped into the panel, and footnoteScopes.ts
 * decides whether a note can go there.
 *
 * @version v1.5.0-beta
 */
import type { EditorView } from "@codemirror/view";
import { insertMarkdownWrap } from "./commands";
import { fieldHolds, replaceBookmarkedField, type FieldBookmark } from "./panelSource";
import type { MathDelimiter } from "./panelMath";

export type FocusedField =
  | { kind: "editor"; view: EditorView; bookmark: () => FieldBookmark | null }
  | {
      kind: "input";
      input: HTMLInputElement;
      bookmark: () => FieldBookmark | null;
      markdown: boolean;
    };

/** A field that went away while it held the toolbar's attention. */
export const LOST = "lost";
type Recorded = FocusedField | typeof LOST;

const focused = new WeakMap<EditorView, Recorded>();
const listeners = new WeakMap<EditorView, Set<() => void>>();

function notify(outer: EditorView): void {
  for (const listener of listeners.get(outer) ?? []) listener();
}

/** Calls `listener` whenever the record for `outer` changes; returns the unsubscribe. */
export function subscribeFieldFocus(outer: EditorView, listener: () => void): () => void {
  let set = listeners.get(outer);
  if (!set) listeners.set(outer, (set = new Set()));
  set.add(listener);
  return () => set!.delete(listener);
}

export function setFocusedField(outer: EditorView, target: FocusedField): void {
  focused.set(outer, target);
  notify(outer);
}

/** The outer text took focus: the toolbar acts on it again. */
export function clearFocusedField(outer: EditorView): void {
  focused.delete(outer);
  notify(outer);
}

/** `target` went away; if it held the toolbar, the toolbar now refuses. */
export function loseFocusedField(outer: EditorView, target: FocusedField): void {
  if (focused.get(outer) !== target) return;
  focused.set(outer, LOST);
  notify(outer);
}

/** The field the toolbar acts on, `lost`, or null for the outer text. */
export function focusedField(outer: EditorView): Recorded | null {
  return focused.get(outer) ?? null;
}

/** Where the field's caret sits in the panel; null when the field is stale or lost. */
export function fieldCaret(outer: EditorView, target: Recorded): number | null {
  if (target === LOST) return null;
  const bookmark = target.bookmark();
  if (!bookmark?.valid) return null;
  if (outer.state.sliceDoc(bookmark.from, bookmark.to) !== bookmark.expected) return null;
  if (!fieldHolds(outer, bookmark)) return null;
  const offset =
    target.kind === "editor"
      ? target.view.state.selection.main.head
      : (target.input.selectionStart ?? target.input.value.length);
  return bookmark.from + Math.min(offset, bookmark.expected.length);
}

/** Replace an input field's selection by `before + selection + after`. */
function wrapInput(
  outer: EditorView,
  target: Extract<FocusedField, { kind: "input" }>,
  before: string,
  after: string,
  fallback = "",
): void {
  const bookmark = target.bookmark();
  if (!target.markdown || !bookmark) return;
  const { value } = target.input;
  const start = target.input.selectionStart ?? value.length;
  const end = target.input.selectionEnd ?? start;
  const inner = value.slice(start, end) || fallback;
  const next = value.slice(0, start) + before + inner + after + value.slice(end);
  if (!replaceBookmarkedField(outer, bookmark, next)) return;
  target.input.value = next;
  target.input.setSelectionRange(start + before.length, start + before.length + inner.length);
  target.input.focus();
}

/** Bold or italic in the focused field; false when the outer text has the toolbar. */
export function wrapFocusedField(outer: EditorView, marker: string): boolean {
  const target = focusedField(outer);
  if (!target) return false;
  if (target === LOST) return true;
  if (target.kind === "editor") insertMarkdownWrap(target.view, marker);
  else wrapInput(outer, target, marker, marker);
  return true;
}

/** An inline formula in the focused field; false when the outer text has the toolbar. */
export function mathInFocusedField(
  outer: EditorView,
  delimiter: MathDelimiter,
  insertInView: (view: EditorView) => void,
): boolean {
  const target = focusedField(outer);
  if (!target) return false;
  if (target === LOST) return true;
  if (target.kind === "editor") insertInView(target.view);
  else wrapInput(outer, target, delimiter.left, delimiter.right, "x^2");
  return true;
}
