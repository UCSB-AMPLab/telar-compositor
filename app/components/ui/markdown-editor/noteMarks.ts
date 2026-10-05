/**
 * noteMarks — footnote references drawn as their published numbers, in the
 * panel editor and in a widget field's own editor.
 *
 * A widget field's editor holds only the field's text, so it cannot number
 * its references itself: the conversion they belong to, and the notes they
 * name, are in the panel. The box numbers them from the panel and hands the
 * field its references with `setFieldNotes`, as offsets in the field. The
 * field draws each as a superscript number, and shows its source while the
 * caret is inside it.
 *
 * @version v1.5.0-beta
 */
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

/** A reference drawn as its published number; a click opens the note. */
export class ReferenceWidget extends WidgetType {
  constructor(
    readonly number: number,
    readonly name: string,
    readonly target: number,
    readonly open: (target: number) => void,
  ) {
    super();
  }
  eq(other: ReferenceWidget) {
    return this.number === other.number && this.name === other.name && this.target === other.target;
  }
  toDOM() {
    const sup = document.createElement("sup");
    sup.className = "cm-panel-reference";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(this.number);
    button.setAttribute("aria-label", `${this.name} ${this.number}`.trim());
    button.onclick = () => this.open(this.target);
    sup.appendChild(button);
    return sup;
  }
  ignoreEvent() {
    return true;
  }
}

export interface FieldNote {
  from: number;
  to: number;
  number: number;
  /** The panel position of the note's definition. */
  target: number;
}

export interface FieldNotes {
  notes: FieldNote[];
  name: string;
  open: (target: number) => void;
}

export const setFieldNotes = StateEffect.define<FieldNotes>();

const fieldNotesState = StateField.define<FieldNotes>({
  create: () => ({ notes: [], name: "", open: () => {} }),
  update(value, tr) {
    const effect = tr.effects.find((e) => e.is(setFieldNotes));
    if (effect) return effect.value as FieldNotes;
    if (!tr.docChanged) return value;
    return { ...value, notes: [] };
  },
});

function fieldDecorations(state: EditorState): DecorationSet {
  const { notes, name, open } = state.field(fieldNotesState);
  const head = state.selection.main.head;
  const ranges = notes
    .filter((n) => n.to <= state.doc.length && !(head > n.from && head < n.to))
    .map((n) =>
      Decoration.replace({ widget: new ReferenceWidget(n.number, name, n.target, open) }).range(n.from, n.to),
    );
  return Decoration.set(ranges, true);
}

const fieldNoteDecorations = StateField.define<DecorationSet>({
  create: fieldDecorations,
  update: (_, tr) => fieldDecorations(tr.state),
  provide: (field) => EditorView.decorations.from(field),
});

/** The extensions a widget field's editor needs to draw its notes. */
export const fieldNoteMarks = [fieldNotesState, fieldNoteDecorations];
