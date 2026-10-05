// @vitest-environment jsdom
/**
 * Panel authoring preserves source and maps edits through collaboration.
 * Widgets are split as the framework's process_widgets splits them
 * (scripts/telar/widgets.py at framework 1.8.0), and footnotes are numbered
 * as its renumber_footnotes_by_reference numbers them (scripts/telar/latex.py).
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { history, undo } from "@codemirror/commands";
import {
  parsePanel,
  replacePanelField,
  bookmarkField,
  replaceBookmarkedField,
} from "../app/components/ui/markdown-editor/panelSource";
import { panelTarget, setPanelTarget, insertFootnote } from "../app/components/ui/markdown-editor/footnoteSource";
import { readNotes } from "../app/components/ui/markdown-editor/footnoteSyntax";
import { panelAuthoring } from "../app/components/ui/markdown-editor/panelAuthoring";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const state = (doc: string) => EditorState.create({ doc, extensions: [markdown(), panelTarget, history()] });
const widgets = (doc: string) => parsePanel(state(doc)).widgets;
const LABEL = "[a-hjkmnp-z][a-hjkmnp-z2-9]{3}";

describe("panel source", () => {
  it("retains imported carousel fields and changes only the chosen field", () => {
    const doc =
      "Before\n\n:::carousel\nimage: first.jpg\ncaption: Original\ncustom-field: untouched\n---\nimage: second.jpg\nalt: Second\n:::\nAfter";
    const view = new EditorView({ state: state(doc) });
    const caption = parsePanel(view.state).widgets[0].sections[0].fields!.caption;
    expect(replacePanelField(view, caption, caption.value, "Changed")).toBe(true);
    expect(view.state.doc.toString()).toBe(doc.replace("Original", "Changed"));
    view.destroy();
  });

  // Adapted: the branch skipped widget fences inside code. The framework's
  // process_widgets matches its pattern before Markdown runs, code or not.
  it("finds widgets as the framework does, code included, and keeps multiline note bodies", () => {
    const doc =
      "`[^code]`\n\n```md\n:::tabs\n## Hidden\n:::\n[^hidden]: no\n```\n\nText[^a] twice[^a].\n\n[^a]: First\n\n    Second\n\n:::accordion\n## Unfinished";
    const s = state(doc);
    expect(parsePanel(s).widgets.map((w) => w.kind)).toEqual(["tabs"]);
    const { references, notes } = readNotes(s);
    expect(references.map((n) => [n.label, n.number])).toEqual([["a", 1], ["a", 1]]);
    expect(notes.map((n) => [n.label, n.text])).toEqual([["a", "First\n\nSecond"]]);
  });

  // Framework 1.8.0 renumbers by reference; the branch's expectation stands.
  it("numbers by first reference without modifying imported labels", () => {
    const { references, notes } = readNotes(
      state("Second[^z] then first[^old].\n\n[^old]: Earlier definition\n[^z]: Later"),
    );
    expect(references.map((n) => [n.label, n.number])).toEqual([["z", 1], ["old", 2]]);
    expect(notes.map((n) => [n.label, n.number])).toEqual([["z", 1], ["old", 2]]);
  });

  // Adapted to main's insertFootnote (footnoteSource.ts), which replaced the
  // branch's: its labels are four characters, not `note-<uuid>`.
  it("maps insertion targets and undoes the reference plus definition together", () => {
    const view = new EditorView({ state: state("Prose here") });
    view.dispatch({ effects: setPanelTarget.of({ from: 5, to: 5 }) });
    view.dispatch({ changes: { from: 0, insert: "Remote " } });
    expect(insertFootnote(view, "A note\nsecond line")).toBe(true);
    expect(view.state.doc.toString()).toMatch(new RegExp(`^Remote Prose\\[\\^${LABEL}\\]`));
    expect(view.state.doc.toString()).toContain(": A note\n    second line");
    undo(view);
    expect(view.state.doc.toString()).toBe("Remote Prose here");
    view.destroy();
  });

  it("invalidates deleted targets and refuses locked writes", () => {
    const view = new EditorView({ state: state("A target sentence") });
    view.dispatch({ effects: setPanelTarget.of({ from: 2, to: 8 }) });
    view.dispatch({ changes: { from: 0, to: 10, insert: "" } });
    expect(insertFootnote(view, "Must not insert")).toBe(false);
    view.destroy();
    const locked = new EditorView({
      state: EditorState.create({ doc: "Locked", extensions: [panelTarget, EditorState.readOnly.of(true)] }),
    });
    locked.dispatch({ effects: setPanelTarget.of({ from: 2, to: 2 }) });
    expect(insertFootnote(locked, "Must not insert")).toBe(false);
    expect(replacePanelField(locked, { from: 0, to: 6 }, "Locked", "Changed")).toBe(false);
    locked.destroy();
  });
});

describe("empty source fields", () => {
  it("inserts text before the next section instead of swallowing its heading", () => {
    const view = new EditorView({ state: state(":::tabs\n## One\n\n\n## Two\n\n:::\n") });
    const body = parsePanel(view.state).widgets[0].sections[0].body!;
    replacePanelField(view, body, "", "Text");
    expect(parsePanel(view.state).widgets[0].sections.map((s) => s.title?.value)).toEqual(["One", "Two"]);
    expect(view.state.doc.toString()).toContain("Text\n\n## Two");
    view.destroy();
  });

  it("keeps the heading marker out of an empty title, so typing a title keeps the section", () => {
    const view = new EditorView({ state: state(":::tabs\n## \nFirst\n\n## Two\nSecond\n:::") });
    const title = parsePanel(view.state).widgets[0].sections[0].title!;
    expect(title).toMatchObject({ from: 11, to: 11, value: "" });
    const bookmark = bookmarkField(view, title);
    expect(replaceBookmarkedField(view, bookmark, "T")).toBe(true);
    expect(view.state.doc.toString()).toBe(":::tabs\n## T\nFirst\n\n## Two\nSecond\n:::");
    expect(parsePanel(view.state).widgets[0].sections.map((s) => s.title?.value)).toEqual(["T", "Two"]);
    view.destroy();
  });

  it("starts the content of a section whose heading ends the widget on its own line", () => {
    // panelAuthoring maps bookmarks through each change, as in the editor.
    const view = new EditorView({
      state: EditorState.create({ doc: ":::tabs\n## One\nText\n## Two\n:::", extensions: [markdown(), panelAuthoring()] }),
    });
    const body = parsePanel(view.state).widgets[0].sections[1].body!;
    expect(body.value).toBe("");
    const bookmark = bookmarkField(view, body);
    expect(replaceBookmarkedField(view, bookmark, "N")).toBe(true);
    expect(replaceBookmarkedField(view, bookmark, "Ne")).toBe(true);
    expect(view.state.doc.toString()).toBe(":::tabs\n## One\nText\n## Two\nNe\n:::");
    expect(parsePanel(view.state).widgets[0].sections[1].body!.value).toBe("Ne");
    view.destroy();
  });
});

describe("bookmarks hold the field's role", () => {
  it("refuses a write once the field's key is renamed, though its text is unchanged", async () => {
    const doc = ":::carousel\nimage: a.jpg\ncaption: hello\n:::";
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown(), panelAuthoring()] }) });
    const caption = parsePanel(view.state).widgets[0].sections[0].fields!.caption;
    const bookmark = bookmarkField(view, caption);
    view.dispatch({ changes: { from: doc.indexOf("caption"), to: doc.indexOf("caption") + 7, insert: "alt" } });
    expect(view.state.sliceDoc(bookmark.from, bookmark.to)).toBe("hello");
    expect(replaceBookmarkedField(view, bookmark, "**hello**")).toBe(false);
    expect(bookmark.valid).toBe(false);
    expect(view.state.doc.toString()).toBe(":::carousel\nimage: a.jpg\nalt: hello\n:::");
    view.destroy();
  });
});

describe("widget splitting follows the framework", () => {
  it("reads only a literal '## ' line as a section heading", () => {
    const [tabs] = widgets(":::tabs\n## One\nA\n##\tNot a heading\n## Two\nB\n:::");
    expect(tabs.sections.map((s) => s.title?.value)).toEqual(["One", "Two"]);
    expect(tabs.sections[0].body!.value).toBe("A\n##\tNot a heading");
  });

  it("splits a carousel on every '---', inside a value too", () => {
    const [carousel] = widgets(":::carousel\nimage: a.jpg\ncaption: before---after\n:::");
    expect(carousel.sections.map((s) => s.fields?.caption?.value ?? null)).toEqual(["before", null]);
    expect(carousel.sections[1].source).toBe("after");
  });

  it("reads carousel keys as parse_key_value_block does", () => {
    const [carousel] = widgets(
      ":::carousel\nimage: a.jpg\n# note: skipped\n  alt text : Spaced key\ncaption: first\ncaption: last\n:::",
    );
    const fields = carousel.sections[0].fields!;
    expect(Object.keys(fields)).toEqual(["image", "alt text", "caption"]);
    expect(fields.caption.value).toBe("last");
    expect(fields["alt text"].value).toBe("Spaced key");
  });

  it("splits a bibliography on every blank line into entries", () => {
    const [bibliography] = widgets(":::bibliography\nFirst entry.\nSame entry.\n\nSecond.\n\n\n\nThird.\n:::");
    expect(bibliography.sections.map((s) => s.body!.value)).toEqual([
      "First entry.\nSame entry.",
      "Second.",
      "Third.",
    ]);
  });

  it("leaves unknown widget types and fences that share a line as source", () => {
    expect(widgets(":::gallery\nText\n:::")).toEqual([]);
    expect(widgets("Intro :::tabs\n## One\nText\n:::")).toEqual([]);
  });

  it("removes a carousel item together with its separator", () => {
    const doc = ":::carousel\nimage: a.jpg\n---\nimage: b.jpg\n---\nimage: c.jpg\n:::";
    const view = new EditorView({ state: state(doc) });
    const middle = parsePanel(view.state).widgets[0].sections[1];
    const removal = view.state.sliceDoc(middle.removal.from, middle.removal.to);
    replacePanelField(view, middle.removal, removal, "");
    expect(view.state.doc.toString()).toBe(":::carousel\nimage: a.jpg\n---\nimage: c.jpg\n:::");
    view.destroy();
  });
});

it("preserves the trailing space while an author is typing a title or body", () => {
  const view = new EditorView({ state: state(":::tabs\n## Title\nBody\n:::\n") });
  for (const key of ["title", "body"] as const) {
    const first = parsePanel(view.state).widgets[0].sections[0][key]!;
    replacePanelField(view, first, first.value, first.value + " ");
    const second = parsePanel(view.state).widgets[0].sections[0][key]!;
    expect(second.value).toBe(first.value + " ");
    replacePanelField(view, second, second.value, second.value + "word");
    expect(parsePanel(view.state).widgets[0].sections[0][key]!.value).toBe(first.value + " word");
  }
  view.destroy();
});
