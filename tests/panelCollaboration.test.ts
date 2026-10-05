// @vitest-environment jsdom
/** Independent edits in one widget must merge as text, not whole-field replacements. @version v1.5.0-beta */
import { it, expect, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import {
  parsePanel,
  replacePanelField,
  bookmarkField,
  isCurrentFieldSnapshot,
  replaceBookmarkedField,
} from "../app/components/ui/markdown-editor/panelSource";
import { panelAuthoring } from "../app/components/ui/markdown-editor/panelAuthoring";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
it("merges concurrent edits to different words in a section", () => {
  const a = new Y.Doc(),
    b = new Y.Doc();
  const source = ":::tabs\n## Title\nFirst and last\n:::\n";
  a.getText("content").insert(0, source);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const make = (doc: Y.Doc) =>
    new EditorView({
      state: EditorState.create({
        doc: source,
        extensions: [
          markdown(),
          yCollab(doc.getText("content"), null, { undoManager: false }),
        ],
      }),
    });
  const av = make(a),
    bv = make(b);
  const aField = parsePanel(av.state).widgets[0].sections[0].body!;
  const bField = parsePanel(bv.state).widgets[0].sections[0].body!;
  replacePanelField(av, aField, aField.value, "FIRST and last");
  replacePanelField(bv, bField, bField.value, "First and LAST");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  expect(a.getText("content").toString()).toBe(
    ":::tabs\n## Title\nFIRST and LAST\n:::\n",
  );
  expect(av.state.doc.toString()).toBe(bv.state.doc.toString());
  av.destroy();
  bv.destroy();
  a.destroy();
  b.destroy();
});
it("maps a pending field through preceding text and rejects an intersecting remote edit", () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: "Prose\n\n:::tabs\n## Title\nBody\n:::\n",
      extensions: [markdown(), panelAuthoring()],
    }),
  });
  const field = parsePanel(view.state).widgets[0].sections[0].body!;
  const bookmark = bookmarkField(view, field);
  view.dispatch({ changes: { from: 0, insert: "Remote " } });
  expect(replaceBookmarkedField(view, bookmark, "Body changed")).toBe(true);
  expect(view.state.doc.toString()).toContain("Remote Prose");
  expect(view.state.doc.toString()).toContain("Body changed");
  view.dispatch({ changes: { from: bookmark.from + 1, insert: "REMOTE" } });
  const before = view.state.doc.toString();
  expect(replaceBookmarkedField(view, bookmark, "Stale text")).toBe(false);
  expect(view.state.doc.toString()).toBe(before);
  view.destroy();
});

it("rejects an older field snapshot even when it still matches a prefix", () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: ":::tabs\n## Title\nBody\n:::\n",
      extensions: [markdown(), panelAuthoring()],
    }),
  });
  const oldField = parsePanel(view.state).widgets[0].sections[0].body!;
  const bookmark = bookmarkField(view, oldField);
  replaceBookmarkedField(view, bookmark, "Body More");
  expect(view.state.sliceDoc(oldField.from, oldField.to)).toBe(oldField.value);
  expect(isCurrentFieldSnapshot(view, oldField, bookmark)).toBe(false);
  expect(
    isCurrentFieldSnapshot(
      view,
      parsePanel(view.state).widgets[0].sections[0].body!,
      bookmark,
    ),
  ).toBe(true);
  view.destroy();
});
