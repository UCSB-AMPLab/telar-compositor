/**
 * Panel decorations add editable boxes without replacing the Markdown editor.
 * Block state is mapped through each transaction. React owns only the decoration
 * DOM; every content change still goes through the outer CodeMirror view and Yjs.
 *
 * Footnote references and the note list take their numbers from readNotes
 * (footnoteSyntax.ts), which numbers them as the framework publishes them.
 * The list shows the top-level conversion's notes in published order; notes
 * inside a widget belong to its section or entry and stay in its source. A
 * label defined twice in one conversion is not drawn as a note: its
 * references and definitions stay as source, marked as an error.
 *
 * Until the site's preview configuration has arrived, and whenever it is
 * unavailable, formulas stay as source. Every rendered box compares the whole
 * configuration, so a change to it rebuilds what the box shows.
 *
 * @version v1.5.0-beta
 */
import {
  StateEffect,
  MapMode,
  StateField,
  type EditorState,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";
import { createRoot, type Root } from "react-dom/client";
import { parsePanel, updateBookmarks, type PanelWidget, type SourceRange, type WidgetKind } from "./panelSource";
import { panelTarget } from "./footnoteSource";
import { readNotes, type NumberedNote, type NoteReference } from "./footnoteSyntax";
import { panelOptions, type PanelOptions } from "./panelOptions";
import { PanelBox, NoteBox } from "./PanelBox";
import { clearFocusedField } from "./fieldFocus";
import { ReferenceWidget } from "./noteMarks";
import { loadPanelMath, parseMath, type MathDelimiter, type MathExpression } from "./panelMath";

type ActiveBlock = { from: number; mode: "edit" | "source" } | null;
export const editPanelBlock = StateEffect.define<ActiveBlock>();

function blockAt(state: EditorState, from: number): PanelWidget | undefined {
  return parsePanel(state).widgets.find((w) => w.from === from);
}

/** The active box's position after `tr`, or the one an effect names. */
function nextActive(value: ActiveBlock, tr: Transaction): { next: ActiveBlock; named: boolean } {
  const effect = tr.effects.find((e) => e.is(editPanelBlock));
  if (effect) return { next: effect.value as ActiveBlock, named: true };
  const mapped = value && tr.changes.mapPos(value.from, 1, MapMode.TrackAfter);
  return { next: value && mapped !== null ? { ...value, from: mapped } : null, named: false };
}

/** The box being edited or shown as source; closed when the caret leaves it. */
const activeBlock = StateField.define<ActiveBlock>({
  create: () => null,
  update(value, tr) {
    const { next, named } = nextActive(value, tr);
    const block = next && blockAt(tr.state, next.from);
    if (!block) return null;
    const head = tr.newSelection.main.head;
    const left = tr.selection && !named && (head < block.from || head > block.to);
    return left ? null : next;
  },
});

/** The preview configuration as one comparable value. */
function configKey(state: EditorState): string {
  return JSON.stringify(state.facet(panelOptions).preview ?? null);
}

const roots = new WeakMap<HTMLElement, Root>();
const measurements = new WeakMap<HTMLElement, ResizeObserver>();

function mountRoot(dom: HTMLElement, view: EditorView): void {
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(dom);
    measurements.set(dom, observer);
  }
  roots.set(dom, createRoot(dom));
}

function unmountRoot(dom: HTMLElement): void {
  measurements.get(dom)?.disconnect();
  const root = roots.get(dom);
  queueMicrotask(() => root?.unmount());
}

class BlockWidget extends WidgetType {
  constructor(
    readonly block: PanelWidget,
    readonly editing: boolean,
    readonly locked: boolean,
    readonly config: string,
  ) {
    super();
  }
  eq(other: BlockWidget) {
    return (
      this.block.from === other.block.from &&
      this.block.source === other.block.source &&
      this.editing === other.editing &&
      this.locked === other.locked &&
      this.config === other.config
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-panel-box panel-widgets";
    dom.addEventListener("click", (event) => {
      const link = (event.target as HTMLElement).closest("a");
      if (link && !event.metaKey && !event.ctrlKey) event.preventDefault();
    });
    mountRoot(dom, view);
    this.render(dom, view);
    return dom;
  }
  render(dom: HTMLElement, view: EditorView) {
    dom.removeAttribute("style");
    const theme = view.state.facet(panelOptions).preview?.theme ?? {};
    for (const [key, value] of Object.entries(theme)) dom.style.setProperty(key, value);
    roots.get(dom)!.render(
      <PanelBox view={view} block={this.block} editing={this.editing} configKey={this.config} />,
    );
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    this.render(dom, view);
    return true;
  }
  destroy(dom: HTMLElement) {
    unmountRoot(dom);
  }
  ignoreEvent() {
    return true;
  }
}

class NoteListWidget extends WidgetType {
  constructor(
    readonly notes: NumberedNote[],
    readonly locked: boolean,
    readonly config: string,
  ) {
    super();
  }
  eq(other: NoteListWidget) {
    return (
      JSON.stringify(this.notes) === JSON.stringify(other.notes) &&
      this.locked === other.locked &&
      this.config === other.config
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-panel-note";
    mountRoot(dom, view);
    this.render(dom, view);
    return dom;
  }
  render(dom: HTMLElement, view: EditorView) {
    roots.get(dom)!.render(
      <>
        {this.notes.map((note) => (
          <NoteBox key={`${this.config}-${note.from}`} view={view} note={note} />
        ))}
      </>,
    );
  }
  updateDOM(dom: HTMLElement, view: EditorView) {
    this.render(dom, view);
    return true;
  }
  destroy(dom: HTMLElement) {
    unmountRoot(dom);
  }
  ignoreEvent() {
    return true;
  }
}

class MathWidget extends WidgetType {
  constructor(readonly expression: MathExpression) {
    super();
  }
  eq(other: MathWidget) {
    return (
      this.expression.from === other.expression.from &&
      this.expression.source === other.expression.source
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "cm-panel-math";
    dom.textContent = this.expression.source;
    dom.onclick = () => {
      view.dispatch({ selection: { anchor: this.expression.from + 1 } });
      view.focus();
    };
    loadPanelMath()
      .then((katex) => {
        if (!dom.isConnected) return;
        katex.default.render(this.expression.source, dom, {
          displayMode: this.expression.display,
          throwOnError: false,
          trust: false,
          strict: "warn",
          maxExpand: 1000,
          maxSize: 20,
        });
        view.requestMeasure();
      })
      .catch(() => {
        /* Source stays readable if an asset cannot load. */
      });
    return dom;
  }
  ignoreEvent() {
    return true;
  }
}

const noteError = Decoration.mark({ class: "cm-panel-note-error" });

/** Code and raw HTML anywhere in the panel. */
function codeSpans(state: EditorState): SourceRange[] {
  const spans: SourceRange[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (!["FencedCode", "CodeBlock", "InlineCode", "HTMLBlock", "Comment"].includes(node.name)) return;
      spans.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return spans;
}

function caretInside(state: EditorState, range: SourceRange): boolean {
  const s = state.selection.main;
  return s.empty ? s.head > range.from && s.head < range.to : s.from < range.to && s.to > range.from;
}

function selectionTouches(state: EditorState, range: SourceRange): boolean {
  const s = state.selection.main;
  return s.from <= range.to && s.to >= range.from;
}

interface Reading {
  state: EditorState;
  widgets: PanelWidget[];
  shown: PanelWidget[];
  active: ActiveBlock;
  notes: NumberedNote[];
  references: NoteReference[];
}

function blockDecorations(r: Reading) {
  const locked = r.state.readOnly;
  const config = configKey(r.state);
  return r.shown.map((block) =>
    Decoration.replace({
      block: true,
      widget: new BlockWidget(block, r.active?.from === block.from && r.active.mode === "edit", locked, config),
    }).range(block.from, block.to),
  );
}

function isTop(note: { scope: { kind: string } }): boolean {
  return note.scope.kind === "top";
}

function referenceDecorations(r: Reading) {
  const options = r.state.facet(panelOptions);
  const ranges = [];
  for (const ref of r.references) {
    if (!isTop(ref) || r.shown.some((w) => ref.from >= w.from && ref.to <= w.to)) continue;
    const note = r.notes.find((n) => isTop(n) && n.label === ref.label)!;
    if (note.duplicate) ranges.push(noteError.range(ref.from, ref.to));
    else if (!caretInside(r.state, ref)) {
      const open = (target: number) => options.openFootnote?.(target);
      const widget = new ReferenceWidget(ref.number, options.footnoteName ?? "", note.from, open);
      ranges.push(Decoration.replace({ widget }).range(ref.from, ref.to));
    }
  }
  return ranges;
}

function noteDecorations(r: Reading) {
  const top = r.notes.filter(isTop);
  const ranges = top.filter((n) => n.duplicate).map((n) => noteError.range(n.marker.from, n.marker.to));
  const listed = top.filter((n) => !n.duplicate && !selectionTouches(r.state, n));
  for (const note of listed) ranges.push(Decoration.replace({ block: true }).range(note.from, note.to));
  if (listed.length) {
    const widget = new NoteListWidget(listed, r.state.readOnly, configKey(r.state));
    ranges.push(Decoration.widget({ block: true, side: 1, widget }).range(r.state.doc.length));
  }
  return ranges;
}

/** Delimiters formulas are read with; none until the configuration is usable. */
function activeDelimiters(state: EditorState): MathDelimiter[] {
  const config = state.facet(panelOptions).preview;
  return config?.available ? config.delimiters : [];
}

function mathDecorations(r: Reading) {
  const excluded = [...codeSpans(r.state), ...r.widgets, ...r.notes];
  return parseMath(r.state.doc.toString(), excluded, activeDelimiters(r.state))
    .filter((expression) => !caretInside(r.state, expression))
    .map((expression) =>
      Decoration.replace({ widget: new MathWidget(expression) }).range(expression.from, expression.to),
    );
}

function decorations(state: EditorState): DecorationSet {
  const widgets = parsePanel(state).widgets;
  const active = state.field(activeBlock);
  const { notes, references } = readNotes(state);
  const shown = widgets.filter((w) => !(active?.from === w.from && active.mode === "source"));
  const r: Reading = { state, widgets, shown, active, notes, references };
  return Decoration.set(
    [...blockDecorations(r), ...referenceDecorations(r), ...noteDecorations(r), ...mathDecorations(r)],
    true,
  );
}

const panelDecorations = StateField.define<DecorationSet>({
  create: decorations,
  update: (_, tr) => decorations(tr.state),
  provide: (field) => EditorView.decorations.from(field),
});

export function panelAuthoring(options: PanelOptions = {}): Extension {
  return [
    panelOptions.of(options),
    panelTarget,
    activeBlock,
    panelDecorations,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) updateBookmarks(update.view, update.changes);
    }),
    EditorView.domEventHandlers({
      focus(event, view) {
        if (event.target === view.contentDOM) clearFocusedField(view);
        return false;
      },
    }),
  ];
}

/** A `:::kind` block written at the caret on lines of its own; `edit` opens its box. */
function insertPanelBlock(view: EditorView, kind: string, body: string, edit: boolean) {
  if (view.state.readOnly) return;
  const at = view.state.selection.main.to;
  const prefix = at ? "\n\n" : "";
  view.dispatch({
    changes: { from: at, insert: `${prefix}:::${kind}\n${body}:::\n\n` },
    effects: edit ? editPanelBlock.of({ from: at + prefix.length, mode: "edit" }) : [],
    annotations: isolateHistory.of("full"),
    userEvent: "input",
  });
}

export function insertPanelWidget(view: EditorView, kind: WidgetKind, sectionTitle: string) {
  const bodies: Record<WidgetKind, string> = {
    accordion: `## ${sectionTitle} 1\n\n\n## ${sectionTitle} 2\n\n`,
    tabs: `## ${sectionTitle} 1\n\n\n## ${sectionTitle} 2\n\n`,
    carousel: "image: \nalt: \ncaption: \ncredit: \n",
    bibliography: "\n",
  };
  insertPanelBlock(view, kind, bodies[kind], true);
}

/** A glossary callout in the framework's syntax, `align:` written only for the left, right being its default. */
export function insertGlossaryCallout(view: EditorView, entry: string, side: "right" | "left") {
  insertPanelBlock(view, "glossary", `entry: ${entry}\n${side === "left" ? "align: left\n" : ""}`, false);
}

/** Wrap the selection, or an example, in the first inline delimiter pair. */
export function insertPanelMath(view: EditorView, delimiters: MathDelimiter[]) {
  if (view.state.readOnly) return;
  const delimiter = delimiters.find((d) => !d.display) ?? delimiters[0];
  if (!delimiter) return;
  const { from, to } = view.state.selection.main;
  const body = view.state.sliceDoc(from, to) || "x^2";
  view.dispatch({
    changes: { from, to, insert: delimiter.left + body + delimiter.right },
    selection: { anchor: from + delimiter.left.length, head: from + delimiter.left.length + body.length },
    annotations: isolateHistory.of("full"),
    userEvent: "input",
  });
  view.focus();
}

export function isEditingPanelBlock(view: EditorView, block: PanelWidget): boolean {
  const active = view.state.field(activeBlock, false);
  return active?.mode === "edit" && active.from === block.from;
}
