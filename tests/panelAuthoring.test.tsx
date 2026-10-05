// @vitest-environment jsdom
/**
 * Live panel boxes remain view-only and share the parent history.
 *
 * @version v1.5.0-beta
 */
import { it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { history, undo } from "@codemirror/commands";
import { act } from "@testing-library/react";
import {
  panelAuthoring,
  insertPanelWidget,
  editPanelBlock,
} from "../app/components/ui/markdown-editor/panelAuthoring";
import { parsePanelPreviewConfig } from "../app/lib/panel-preview-config";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// jsdom has no layout; CodeMirror measures a Range when a view is in the
// document, and an unanswered measure fails after the test has passed.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
it("creates an editable box, preserves prose and undoes insertion once", async () => {
  let view!: EditorView;
  await act(async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "Prose",
        extensions: [markdown(), history(), panelAuthoring()],
      }),
    });
    view.dispatch({ selection: { anchor: 5 } });
    insertPanelWidget(view, "tabs", "Section");
  });
  expect(view.dom.querySelector(".cm-panel-fields")).not.toBeNull();
  const before = view.state.doc.toString();
  await act(async () => view.dispatch({ effects: editPanelBlock.of(null) }));
  expect(view.state.doc.toString()).toBe(before);
  expect(view.dom.querySelector('[role="tablist"]')).not.toBeNull();
  await act(async () => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe("Prose");
  await act(async () => view.destroy());
});
// Adapted: formulas now stay as source until the site's configuration has
// arrived, so the case supplies a usable one.
it("renders chemistry syntax only after leaving its source range", async () => {
  let view!: EditorView;
  await act(async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "Before $x^2$ after",
        extensions: [markdown(), panelAuthoring({ preview: parsePanelPreviewConfig(null, null) })],
      }),
    });
  });
  expect(view.dom.querySelector(".cm-panel-math")).not.toBeNull();
  await act(async () => {
    view.dispatch({ selection: { anchor: 9 } });
  });
  expect(view.dom.querySelector(".cm-panel-math")).toBeNull();
  await act(async () => view.destroy());
});

it("keeps the nested caret stable while typing a phrase", async () => {
  let view!: EditorView;
  await act(async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: ":::tabs\n## First\nBody\n:::\n",
        extensions: [markdown(), history(), panelAuthoring()],
      }),
    });
    view.dispatch({ effects: editPanelBlock.of({ from: 0, mode: "edit" }) });
  });
  const nestedDom = view.dom.querySelector(
    ".cm-panel-field .cm-editor",
  ) as HTMLElement;
  const inner = EditorView.findFromDOM(nestedDom)!;
  inner.dispatch({ selection: { anchor: inner.state.doc.length } });
  for (const letter of " More words.") {
    await act(async () => {
      const at = inner.state.selection.main.head;
      inner.dispatch({
        changes: { from: at, insert: letter },
        selection: { anchor: at + letter.length },
        userEvent: "input.type",
      });
    });
  }
  expect(inner.state.doc.toString()).toBe("Body More words.");
  expect(view.state.doc.toString()).toContain("Body More words.");
  await act(async () => view.destroy());
});

it("closes a deleted widget even when an identical one follows it", async () => {
  const block = ":::tabs\n## Title\nBody\n:::";
  let view!: EditorView;
  await act(async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: block + "\n\n" + block,
        extensions: [markdown(), panelAuthoring()],
      }),
    });
    view.dispatch({ effects: editPanelBlock.of({ from: 0, mode: "edit" }) });
  });
  await act(async () => {
    view.dispatch({ changes: { from: 0, to: block.length + 2, insert: "" } });
  });
  expect(view.dom.querySelector(".cm-panel-fields")).toBeNull();
  expect(view.state.doc.toString()).toBe(block);
  await act(async () => view.destroy());
});

// The review's reproduction: widget and note DOM kept typeset maths after the
// configuration turned unavailable, and missed it when it turned available.
it("typesets formulas only while the configuration is usable, in boxes and notes alike", async () => {
  const { Compartment } = await import("@codemirror/state");
  const { panelOptions } = await import("../app/components/ui/markdown-editor/panelOptions");
  const preview = new Compartment();
  const doc = ":::accordion\n## One\nArea $a^2$.\n\n## Two\nMore.\n:::\n\nText[^n].\n\n[^n]: Note $b^2$.";
  let view!: EditorView;
  await act(async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        extensions: [markdown(), panelAuthoring(), preview.of(panelOptions.of({}))],
      }),
    });
  });
  const typeset = (selector: string) => view.dom.querySelector(`${selector} .katex`) !== null;
  const configure = (available: boolean) =>
    act(async () => {
      view.dispatch({
        effects: preview.reconfigure(panelOptions.of({ preview: { ...parsePanelPreviewConfig(null, null), available } })),
      });
    });
  expect(typeset(".cm-panel-box")).toBe(false);
  await configure(true);
  await vi.waitFor(() => expect(typeset(".cm-panel-box") && typeset(".cm-panel-note")).toBe(true));
  await configure(false);
  expect(typeset(".cm-panel-box")).toBe(false);
  expect(typeset(".cm-panel-note")).toBe(false);
  await act(async () => view.destroy());
});
