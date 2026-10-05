// @vitest-environment jsdom
/**
 * The previews that set their markup with dangerouslySetInnerHTML write it
 * only when it changes. React 19 writes an element's innerHTML again
 * whenever it is given a new object, so a render that changes nothing replaced
 * the element under a pointer that had pressed on it and lost the click, and
 * wiped a typeset formula.
 *
 * Each case renders a preview, renders it again with the same text, and reads
 * a MutationObserver on the preview's container: a write shows as removed
 * nodes. The clickable ones also press on a node inside, render again as the
 * card's focus change does, and check the node is still there to be released
 * on.
 *
 * @version v1.5.0-beta
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import * as Y from "yjs";
import { InPlaceMarkdown } from "~/components/ui/InPlaceMarkdown";
import { InlineHtmlEditor } from "~/components/ui/InlineHtmlEditor";
import { GlossaryPreviewPane } from "~/components/features/glossary/GlossaryPreviewPane";
import { NoteText } from "~/components/ui/markdown-editor/PanelBox";
import { WidgetPreview } from "~/components/ui/markdown-editor/WidgetPreview";
import { parsePanel } from "~/components/ui/markdown-editor/panelSource";
import { resetTargetSaves } from "~/components/ui/target-saves";
import { EditorView } from "@codemirror/view";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn() } }),
}));
vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn() }),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...rest}>{children}</a>,
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    ydoc: null,
    undoManager: null,
    lastEditorByField: new Map(),
  }),
}));

afterEach(() => {
  cleanup();
  resetTargetSaves();
});

/** Removed nodes seen under `root` while `change` runs. */
function removedWhile(root: Element, change: () => void): number {
  let removed = 0;
  const observer = new MutationObserver((records) => {
    for (const record of records) removed += record.removedNodes.length;
  });
  observer.observe(root, { childList: true, subtree: true });
  change();
  removed += observer.takeRecords().reduce((n, record) => n + record.removedNodes.length, 0);
  observer.disconnect();
  return removed;
}

const inPlaceProps = {
  target: "id:1:text",
  yText: null,
  initialValue: "A *river* mouth.",
  placeholder: "Write here",
  label: "Text",
  fieldKey: "f",
};

describe("InPlaceMarkdown", () => {
  const inPlaceMarkdownView = () => <InPlaceMarkdown {...inPlaceProps} />;

  it("does not rewrite its markup when it renders again with the same text", () => {
    const { container, rerender } = render(inPlaceMarkdownView());
    expect(removedWhile(container, () => rerender(inPlaceMarkdownView()))).toBe(0);
  });

  it("keeps the node pressed on through a render before the pointer is released", () => {
    const { rerender } = render(inPlaceMarkdownView());
    const pressed = screen.getByText("river");
    fireEvent.pointerDown(pressed);
    fireEvent.mouseDown(pressed);
    act(() => screen.getByRole("button", { name: "Text" }).focus());
    rerender(inPlaceMarkdownView());
    expect(pressed.isConnected).toBe(true);
  });
});

describe("InlineHtmlEditor", () => {
  const inlineHtmlView = (className: string) => <InlineHtmlEditor initialValue="A <b>river</b> mouth." yText={null} className={className} />;

  it("does not rewrite its preview when it renders again with the same text", () => {
    const { container, rerender } = render(inlineHtmlView("a"));
    expect(container.querySelector("[data-description-preview]")).not.toBeNull();
    expect(removedWhile(container, () => rerender(inlineHtmlView("b")))).toBe(0);
  });
});

describe("GlossaryPreviewPane", () => {
  const doc = new Y.Doc();
  const term = new Y.Map<unknown>();
  term.set("definition", new Y.Text("A [link](https://example.org) and *emphasis*."));
  doc.getArray("glossary").push([term]);
  const glossaryPaneView = (className: string) => (
    <GlossaryPreviewPane yMap={term} theme={null} termVersion={1} titleLabel="Delta" className={className} />
  );

  it("does not rewrite its preview when it renders again with the same definition", () => {
    const { container, rerender } = render(glossaryPaneView("a"));
    expect(removedWhile(container, () => rerender(glossaryPaneView("b")))).toBe(0);
  });

  it("keeps a link pressed on through a render before the pointer is released", () => {
    const { container, rerender } = render(glossaryPaneView("a"));
    const link = container.querySelector("a")!;
    fireEvent.mouseDown(link);
    rerender(glossaryPaneView("b"));
    expect(link.isConnected).toBe(true);
  });
});

describe("a note in a panel", () => {
  it("does not rewrite its text when it renders again with the same source", () => {
    const state = EditorState.create({ doc: "x" });
    const editor = { state } as unknown as EditorView;
    const { container, rerender } = render(<NoteText source="A *river* mouth." view={editor} />);
    expect(removedWhile(container, () => rerender(<NoteText source="A *river* mouth." view={editor} />))).toBe(0);
  });
});

describe("a panel's widgets", () => {
  const widgetOfPanel = (source: string) =>
    parsePanel(EditorState.create({ doc: source, extensions: [markdown()] })).widgets[0];
  const accordion = widgetOfPanel(
    ":::accordion\n\n## First title\n\nFirst **body**.\n\n## Second\n\nSecond body.\n\n:::\n",
  );

  it("are drawn from a fixture that parses as a widget", () => {
    expect(accordion?.kind).toBe("accordion");
  });

  it("do not rewrite a section's markup when they render again with the same text", () => {
    const { container, rerender } = render(<WidgetPreview block={accordion} />);
    expect(removedWhile(container, () => rerender(<WidgetPreview block={accordion} />))).toBe(0);
  });

  it("keep an accordion title's text through the render its own press causes", () => {
    const { container } = render(<WidgetPreview block={accordion} />);
    const button = container.querySelector<HTMLElement>(".accordion-button")!;
    const text = button.firstChild!;
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    expect(text.isConnected).toBe(true);
  });
});
