/**
 * Footnote source keeps a layer panel's footnotes as the Markdown the
 * framework converts: a `[^label]` reference in the prose and a
 * `[^label]: text` definition at the end of the same conversion — the end of
 * the document for top-level text, the end of the section for an accordion or
 * tabs section, the end of the entry for a bibliography entry (see
 * footnoteScopes.ts). Python Markdown's footnotes extension links the two by
 * label and the framework numbers the published notes, so the label is never
 * shown to a reader and only has to be unique.
 *
 * Definitions are read per conversion in footnoteSyntax.ts. A label is
 * offered for reuse unless it holds a character that changes meaning when
 * written as a reference (backslash, `*`, `_`, backtick, `<`, `&`, `[`,
 * `]`). A new label avoids every `[^label]` in the text, wherever it is, so
 * no existing note can ever match it.
 *
 * The insertion point lives in the `panelTarget` state field, which follows
 * the document through local and remote changes and drops to null when a
 * change touches it. An insert against a null target, or against a position
 * where a reference cannot go, is refused, so a collaborator's edit never
 * sends a note to a moved or broken spot.
 *
 * @version v1.5.0-beta
 */
import {
  EditorState,
  MapMode,
  type ChangeSpec,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { sameScope, type FootnoteScope } from "./footnoteScopes";
import {
  definitionSite,
  footnoteScopeAt,
  parseDefinitions,
  type NoteDefinition,
  type SourceRange,
} from "./footnoteSyntax";

/** A random source returning a number in [0, 1), as `Math.random` does. */
export type RandomSource = () => number;

/**
 * Characters that stop a label working as a reference: Python Markdown reads
 * inline code before footnote references, so a backtick splits the reference,
 * and a bracket ends the label. Emphasis, HTML, entity and escape characters
 * are read after references and leave the label intact.
 */
const UNSAFE_LABEL = /[`[\]]/;
const ANY_REFERENCE = /\[\^([^\]]*)\]/g;

/**
 * Definitions a reference in `scope` can reuse: labels defined exactly once
 * in that conversion and safe to write as a reference.
 */
export function reusableDefinitions(
  state: EditorState,
  scope: FootnoteScope,
): NoteDefinition[] {
  const inScope = parseDefinitions(state).filter((d) => sameScope(d.scope, scope));
  const counts = new Map<string, number>();
  for (const d of inScope) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  return inScope.filter(
    (d) => counts.get(d.label) === 1 && d.label !== "" && !UNSAFE_LABEL.test(d.label),
  );
}

/** Every `[^label]` label in the text, in code and definitions included. */
export function takenLabels(text: string): Set<string> {
  return new Set([...text.matchAll(ANY_REFERENCE)].map((m) => m[1]));
}

/** No 0/o, 1/l/i: the label is read in the source, so no look-alikes. */
const LABEL_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const LABEL_LETTERS = "abcdefghjkmnpqrstuvwxyz";
const LABEL_LENGTH = 4;
/** Attempts at one length before the label grows by a character. */
const ATTEMPTS_PER_LENGTH = 16;

function pick(alphabet: string, random: RandomSource): string {
  const index = Math.min(
    alphabet.length - 1,
    Math.floor(random() * alphabet.length),
  );
  return alphabet[index];
}

function drawLabel(length: number, random: RandomSource): string {
  let label = pick(LABEL_LETTERS, random);
  while (label.length < length) label += pick(LABEL_ALPHABET, random);
  return label;
}

/**
 * A label not in `taken`: four characters, starting with a letter. A source
 * that keeps returning taken labels makes the label longer rather than loop.
 */
export function newFootnoteLabel(
  taken: ReadonlySet<string>,
  random: RandomSource = Math.random,
): string {
  for (let attempt = 0; ; attempt++) {
    const length = LABEL_LENGTH + Math.floor(attempt / ATTEMPTS_PER_LENGTH);
    const label = drawLabel(length, random);
    if (!taken.has(label)) return label;
  }
}

/** A mapped anchor is invalidated when another transaction edits at or around it. */
export const setPanelTarget = StateEffect.define<SourceRange | null>();

function mapTarget(value: SourceRange, tr: Transaction): SourceRange | null {
  let touched = false;
  tr.changes.iterChangedRanges((from, to) => {
    if (from <= value.to && to >= value.from) touched = true;
  });
  if (touched) return null;
  const from = tr.changes.mapPos(value.from, 1, MapMode.TrackDel);
  const to = tr.changes.mapPos(value.to, -1, MapMode.TrackDel);
  if (from === null || to === null || to < from) return null;
  return { from, to };
}

export const panelTarget = StateField.define<SourceRange | null>({
  create: () => null,
  update(value, tr) {
    let next = value && tr.docChanged ? mapTarget(value, tr) : value;
    for (const effect of tr.effects)
      if (effect.is(setPanelTarget)) next = effect.value;
    return next;
  },
});

function scopeStart(scope: FootnoteScope): number {
  return scope.kind === "section" ? scope.from : 0;
}

/**
 * The text around a new definition: one blank line before it, and a line
 * break after it when a section heading follows. In a bibliography entry a
 * blank line would start the next entry, so the definition takes the next
 * line instead; Python Markdown reads a definition inside a paragraph.
 */
function definitionFrame(
  text: string,
  scope: FootnoteScope,
  at: number,
  site: number,
): { before: string; after: string } {
  if (site !== scope.end) return relocatedFrame(text, scope, site);
  if (scope.kind === "section" && scope.entry) return { before: "\n", after: "" };
  const after = text.startsWith("\n## ", scope.end) ? "\n" : "";
  if (at === scope.end) return { before: "\n\n", after };
  const tail = text.slice(Math.max(scopeStart(scope), scope.end - 2), scope.end);
  const trailing = /\n*$/.exec(tail)![0].length;
  return { before: "\n".repeat(2 - trailing), after };
}

/**
 * The frame for a definition written on the line before a raw HTML block that
 * runs to the end of the conversion: a blank line before it, and one after,
 * so the block's tag still starts a line. A bibliography entry has no blank
 * lines to spare, so its definition takes the line alone.
 */
function relocatedFrame(
  text: string,
  scope: FootnoteScope,
  site: number,
): { before: string; after: string } {
  if (scope.kind === "section" && scope.entry) return { before: "", after: "\n" };
  if (site === scopeStart(scope)) return { before: "", after: "\n\n" };
  const tail = text.slice(Math.max(scopeStart(scope), site - 2), site);
  const trailing = /\n*$/.exec(tail)![0].length;
  return { before: "\n".repeat(Math.max(0, 2 - trailing)), after: "\n\n" };
}

function formatDefinition(label: string, body: string): string {
  return `[^${label}]: ${body.trim().replace(/\n/g, "\n    ")}`;
}

/**
 * The label to insert: the reused one when the scope can reuse it, a new one
 * clear of every label in the text otherwise, or null when the reuse cannot
 * resolve.
 */
function labelToInsert(
  state: EditorState,
  scope: FootnoteScope,
  reuse: string | undefined,
  random: RandomSource,
): string | null {
  if (!reuse) return newFootnoteLabel(takenLabels(state.doc.toString()), random);
  const reusable = reusableDefinitions(state, scope).some((d) => d.label === reuse);
  return reusable ? reuse : null;
}

function footnoteChanges(
  at: number,
  end: number,
  reference: string,
  definition: string,
): ChangeSpec {
  if (at === end) return { from: at, insert: reference + definition };
  const changes = [{ from: at, insert: reference }];
  if (definition) changes.push({ from: end, insert: definition });
  return changes;
}

function newDefinition(
  state: EditorState,
  scope: FootnoteScope,
  at: number,
  site: number,
  label: string,
  body: string,
): string {
  const { before, after } = definitionFrame(state.doc.toString(), scope, at, site);
  return before + formatDefinition(label, body) + after;
}

/** Where the note's reference goes, or null when the editor is read-only or there is nothing to insert. */
function referenceInsertAt(state: EditorState, body: string, reuse: string | undefined): number | null {
  const target = state.field(panelTarget, false);
  if (!target || state.readOnly || (!reuse && !body.trim())) return null;
  return target.from;
}

/** Where a note goes and what is written there, or null when nothing can be inserted. */
function footnotePlan(
  state: EditorState,
  body: string,
  reuse: string | undefined,
  random: RandomSource,
): { at: number; site: number; reference: string; definition: string } | null {
  const at = referenceInsertAt(state, body, reuse);
  if (at === null) return null;
  const scope = footnoteScopeAt(state, at);
  const label = scope && labelToInsert(state, scope, reuse, random);
  if (!scope || !label) return null;
  const site = reuse ? scope.end : definitionSite(state, scope, at);
  if (site === null) return null;
  const reference = `[^${label}]`;
  const definition = reuse ? "" : newDefinition(state, scope, at, site, label, body);
  return { at, site, reference, definition };
}

/**
 * Insert a reference at the target and, for a new note, its definition at the
 * end of the target's conversion (before a raw HTML block that has no end
 * tag and would swallow it), as one history event. Returns false,
 * changing nothing, when the target is gone or cannot hold a reference, the
 * editor is read-only, the note is empty, or the note to reuse is not defined
 * exactly once in that conversion.
 */
export function insertFootnote(
  view: EditorView,
  body: string,
  reuse?: string,
  random: RandomSource = Math.random,
): boolean {
  const plan = footnotePlan(view.state, body, reuse, random);
  if (!plan) return false;
  const { at, site, reference, definition } = plan;
  view.dispatch({
    changes: footnoteChanges(at, site, reference, definition),
    selection: { anchor: at + reference.length + (site < at ? definition.length : 0) },
    effects: setPanelTarget.of(null),
    annotations: isolateHistory.of("full"),
    userEvent: "input",
  });
  view.focus();
  return true;
}
