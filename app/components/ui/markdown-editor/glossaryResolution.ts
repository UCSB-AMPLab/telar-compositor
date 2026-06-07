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
 * @version v1.3.0-beta
 */

import { StateEffect, StateField } from "@codemirror/state";

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
