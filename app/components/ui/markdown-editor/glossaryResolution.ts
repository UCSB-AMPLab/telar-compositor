/**
 * glossaryResolution.ts — Reactive term_id→title resolution for the glossary chip plugin.
 *
 * Carries a `Map<term_id, title>` into the CodeMirror view via a StateField/StateEffect
 * pair. MarkdownEditor builds the map from the glossary `Y.Array` (observeDeep) and
 * dispatches `setGlossaryMap.of(map)` whenever the glossary changes; `glossaryChipPlugin`
 * reads `view.state.field(glossaryMapField)` in its decoration builder to decide whether a
 * `[[term]]` range resolves to a chip (term present) or an unresolved underline (absent).
 *
 * This is view-only state — pushing the map in via an effect never touches the document,
 * so the shared Y.UndoManager stack stays clean (collaborative branch omits history()).
 *
 * @version v1.3.4-beta
 */

import { StateEffect, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";

/** Dispatch this effect to replace the term_id→title resolution map in the view. */
export const setGlossaryMap = StateEffect.define<Map<string, string>>();

/** Holds the current term_id→title map; the chip plugin reads it when building decorations. */
export const glossaryMapField = StateField.define<Map<string, string>>({
  create: () => new Map(),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGlossaryMap)) return e.value;
    }
    return value;
  },
});

/** Build the term_id→title resolution map from the glossary Y.Array. */
function buildGlossaryMap(glossaryArray: Y.Array<Y.Map<unknown>>): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < glossaryArray.length; i++) {
    const m = glossaryArray.get(i);
    const rawTitle = m.get("title");
    const title =
      rawTitle instanceof Y.Text
        ? rawTitle.toString()
        : typeof rawTitle === "string"
          ? rawTitle
          : "";
    const termId = m.get("term_id");
    if (typeof termId === "string" && termId.length > 0) map.set(termId, title);
  }
  return map;
}

/** Stable serialization of the resolution map, for change detection. */
function serializeGlossaryMap(map: Map<string, string>): string {
  return JSON.stringify([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/**
 * Observe the glossary Y.Array and keep the view's chip-resolution map current.
 *
 * Two defences, either of which alone prevents the telar-compositor#26 data loss:
 *
 * 1. DEDUPE. The resolver only consumes term_id and title, but observeDeep fires
 *    on EVERY nested change — including each keystroke in a definition Y.Text,
 *    which lives inside this same glossary Y.Array. We rebuild the map and skip
 *    the dispatch entirely when term_id/title are unchanged, so typing a
 *    definition produces NO dispatch at all (the common case). The resolver
 *    stops reacting to definition edits, rather than out-scheduling them.
 *
 * 2. DEFERRAL. When the map genuinely changes (term added/renamed/removed —
 *    possibly via a remote peer arriving mid-update), the dispatch is still
 *    deferred via queueMicrotask so it never fires synchronously inside a
 *    CodeMirror/yCollab update. A synchronous view.dispatch there throws
 *    "Calls to EditorView.update are not allowed while an update is in progress",
 *    which crashes the ySync plugin and silently stops copying the editor's text
 *    into the Y.Text — every character after the first is lost on reload.
 *
 * Returns a cleanup that unobserves and cancels any pending dispatch; the
 * cancelled flag is set synchronously, before the EditorView is destroyed, so a
 * queued flush after teardown is a no-op (and dispatching to a destroyed view
 * would be a no-op regardless).
 */
export function installGlossaryResolution(view: EditorView, ydoc: Y.Doc): () => void {
  const glossaryArray = ydoc.getArray<Y.Map<unknown>>("glossary");
  let cancelled = false;
  let scheduled = false;
  let lastSerialized = "";

  const dispatchIfChanged = () => {
    const map = buildGlossaryMap(glossaryArray);
    const serialized = serializeGlossaryMap(map);
    if (serialized === lastSerialized) return; // definition edits land here — no dispatch
    lastSerialized = serialized;
    view.dispatch({ effects: setGlossaryMap.of(map) });
  };
  const flush = () => {
    scheduled = false;
    if (cancelled) return;
    dispatchIfChanged();
  };
  const schedule = () => {
    if (scheduled || cancelled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  glossaryArray.observeDeep(schedule);
  // Initial resolution runs outside any update cycle, so it can dispatch now.
  dispatchIfChanged();

  return () => {
    cancelled = true;
    glossaryArray.unobserveDeep(schedule);
  };
}
