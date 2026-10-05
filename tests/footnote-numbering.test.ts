// @vitest-environment jsdom
/**
 * Footnote numbers and note order in the editor against what the framework
 * publishes. The fixture is written by footnote-numbering.py through the
 * framework's own panel pipeline, where each conversion — the top level, each accordion or tabs section, each bibliography entry — numbers
 * its notes in the order a reader meets the references, and lists
 * unreferenced notes after the referenced ones.
 *
 * One divergence is deliberate: Python Markdown publishes one of two notes
 * sharing a label, and the editor marks both as an error instead of choosing.
 * The numbers still agree, since the label takes one number either way.
 * The comparison reads each note's label from its anchor, which inside a
 * widget carries the widget and section as a prefix.
 *
 * The fixture is regenerated from the framework checkout by
 * `npm run parity:regenerate`, and checked against it by
 * `npm run parity:regenerate -- --check`, which needs the checkout's Python
 * and so never runs in this suite. Run the check before merging anything that
 * touches rendering and whenever the framework moves. A failure means the
 * site now publishes something the committed fixture does not describe: the
 * preview follows the site, and the fixture is re-recorded with that change.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { readNotes } from "~/components/ui/markdown-editor/footnoteSyntax";
import {
  bibliographyEntries,
  findWidgets,
  widgetSections,
  type FootnoteScope,
} from "~/components/ui/markdown-editor/footnoteScopes";
import fixture from "./fixtures/footnote-numbering.json";

const CONVERSIONS = ".accordion-body, .tab-pane-content, .telar-bib-entry";
/** A note's label from its anchor: `fn:<label>`, or `fn:widget-N-M-<label>` inside a widget. */
const labelOf = (anchor: string) => anchor.replace(/^#?fn:(widget-\d+-\d+-)?/, "");

/** Each widget conversion's start, in document order, as the HTML nests them. */
function conversionStarts(text: string): number[] {
  return findWidgets(text).flatMap((w) => {
    if (w.type === "bibliography") return bibliographyEntries(text, w).map((e) => e.from);
    if (w.type === "accordion" || w.type === "tabs") return widgetSections(text, w).map((s) => s.from);
    return [];
  });
}

function editorKey(text: string, scope: FootnoteScope): string {
  return scope.kind === "top" ? "top" : String(conversionStarts(text).indexOf(scope.from));
}

function htmlKey(doc: Document, node: Element): string {
  const container = node.closest(CONVERSIONS);
  return container ? String([...doc.querySelectorAll(CONVERSIONS)].indexOf(container)) : "top";
}

type Grouped = Record<string, string[]>;

function push(groups: Grouped, key: string, value: string): void {
  (groups[key] ??= []).push(value);
}

function published(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const numbers: Grouped = {};
  for (const ref of doc.querySelectorAll("a.footnote-ref")) {
    const label = labelOf(ref.getAttribute("href")!);
    push(numbers, htmlKey(doc, ref), `${label}=${ref.textContent}`);
  }
  const lists: Grouped = {};
  for (const item of doc.querySelectorAll("div.footnote li[id^='fn:']"))
    push(lists, htmlKey(doc, item.closest("div.footnote")!), labelOf(item.id));
  return { numbers, lists };
}

function inEditor(source: string) {
  const { references, notes } = readNotes(EditorState.create({ doc: source, extensions: [markdown()] }));
  const numbers: Grouped = {};
  for (const ref of references) {
    const pair = `${ref.label}=${ref.number}`;
    const key = editorKey(source, ref.scope);
    if (!numbers[key]?.includes(pair)) push(numbers, key, pair);
  }
  const lists: Grouped = {};
  for (const note of notes) {
    const key = editorKey(source, note.scope);
    if (!lists[key]?.includes(note.label)) push(lists, key, note.label);
  }
  return { numbers, lists, notes };
}

const sorted = (groups: Grouped) =>
  Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, [...new Set(v)].sort()]));

function matchesPublication(c: (typeof fixture.cases)[number]): void {
  const site = published(c.html);
  const editor = inEditor(c.source);
  expect(sorted(editor.numbers)).toEqual(sorted(site.numbers));
  expect(editor.lists).toEqual(site.lists);
}

describe(`footnote numbering against framework ${fixture.framework_commit.slice(0, 8)}`, () => {
  for (const c of fixture.cases) it(c.name, () => matchesPublication(c));

  it("marks both notes of a duplicated label as an error", () => {
    const c = fixture.cases.find((x) => x.name === "a duplicate definition")!;
    const { notes } = inEditor(c.source);
    expect(notes.filter((n) => n.label === "d").map((n) => n.duplicate)).toEqual([true, true]);
    expect(notes.find((n) => n.label === "e")!.duplicate).toBe(false);
  });
});
