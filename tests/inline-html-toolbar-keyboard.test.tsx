/**
 * @vitest-environment jsdom
 *
 * inline-html-toolbar-keyboard.test.tsx — the site description's toolbar
 * (InlineHtmlEditor) runs each action from the keyboard, once, on the text the
 * author had selected; a pointer press runs it once, not twice.
 *
 * A browser activates a focused button on Enter or Space by firing `click`
 * with no `mousedown`; a pointer press fires `mousedown`, then `click`. jsdom
 * synthesises neither from a key, so the cases fire those sequences directly,
 * as toolbar-keyboard.test.tsx does for the Markdown editor.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    undoManager: null,
  }),
}));

import { InlineHtmlEditor } from "~/components/ui/InlineHtmlEditor";

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => {
  cleanup();
});

function openEditor(text: string): { view: EditorView; yText: Y.Text } {
  const yText = new Y.Doc().getText("description");
  yText.insert(0, text);
  const { container } = render(<InlineHtmlEditor initialValue="" yText={yText} />);
  fireEvent.click(container.querySelector("[data-description-preview]")!);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  return { view, yText };
}

/** Enter or Space on a focused button: click alone, detail 0. */
function keyActivate(button: HTMLElement): void {
  button.focus();
  fireEvent.click(button, { detail: 0 });
}

/** A pointer press: mousedown, then click with detail 1. */
function pointerPress(button: HTMLElement): void {
  fireEvent.mouseDown(button);
  fireEvent.click(button, { detail: 1 });
}

describe("InlineHtmlEditor toolbar from the keyboard", () => {
  it("bolds the selection when Bold is activated from the keyboard", () => {
    const { view, yText } = openEditor("Alpha beta");
    view.dispatch({ selection: { anchor: 6, head: 10 } });
    keyActivate(screen.getByTitle("toolbar.bold"));
    expect(yText.toString()).toBe("Alpha <strong>beta</strong>");
  });

  it("italicises the selection when Italic is activated from the keyboard", () => {
    const { view, yText } = openEditor("Alpha beta");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    keyActivate(screen.getByTitle("toolbar.italic"));
    expect(yText.toString()).toBe("<em>Alpha</em> beta");
  });

  it("opens the link popover when Link is activated from the keyboard", () => {
    const { view } = openEditor("Alpha beta");
    // jsdom lays nothing out, and the popover is placed from the caret's coordinates.
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 0, top: 0, bottom: 10 });
    view.dispatch({ selection: { anchor: 6, head: 10 } });
    keyActivate(screen.getByTitle("toolbar.link"));
    expect(screen.getByPlaceholderText("link_popover.url_placeholder")).toBeTruthy();
  });

  it("applies a pointer press once, not once for mousedown and again for click", () => {
    const { view, yText } = openEditor("Alpha beta");
    view.dispatch({ selection: { anchor: 6, head: 10 } });
    pointerPress(screen.getByTitle("toolbar.bold"));
    expect(yText.toString()).toBe("Alpha <strong>beta</strong>");
  });

  it("keeps focus in the editor on a pointer press", () => {
    openEditor("Alpha beta");
    const bold = screen.getByTitle("toolbar.bold");
    const notPrevented = fireEvent.mouseDown(bold);
    expect(notPrevented).toBe(false);
  });

  it("keeps the toolbar while focus moves from the editor onto it", () => {
    const { view } = openEditor("Alpha beta");
    const bold = screen.getByTitle("toolbar.bold");
    fireEvent.blur(view.contentDOM, { relatedTarget: bold });
    expect(screen.getByTitle("toolbar.bold")).toBeTruthy();
  });
});
