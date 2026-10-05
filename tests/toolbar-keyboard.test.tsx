/**
 * @vitest-environment jsdom
 *
 * toolbar-keyboard.test.tsx — every Markdown editor toolbar button runs its
 * action from the keyboard, once, on the text the author had selected; and a
 * pointer press or a screen reader's activate runs it once, not twice.
 *
 * A browser activates a focused button on Enter or Space by firing `click`
 * with `detail` 0 and no `mousedown`; a pointer press fires `mousedown`, then
 * `click` with `detail` 1; WebKit's accessibility activate fires `mousedown`
 * and `click`, both with `detail` 0. jsdom synthesises none of them from a
 * key, so the cases fire those sequences directly. The editor is the real MarkdownEditor,
 * mocked as footnote-button.test.tsx mocks it.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(() => Promise.resolve()) }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    undoManager: null,
  }),
}));

import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { toolbarPress } from "~/components/ui/markdown-editor/toolbar-press";

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => {
  cleanup();
});

function mount(initial: string): EditorView {
  const { container } = render(
    <MarkdownEditor
      initialValue={initial}
      fieldName="content"
      projectId={1}
      alwaysShowToolbar
      enableFootnotes
      enableGlossaryLinks
    />
  );
  const content = container.querySelector(".cm-content") as HTMLElement;
  return EditorView.findFromDOM(content)!;
}

function button(title: string): HTMLElement {
  return screen.getByTitle(title);
}

/** Enter or Space on a focused button, as a browser delivers it. */
function pressKey(target: HTMLElement): void {
  target.focus();
  fireEvent.click(target, { detail: 0 });
}

/** A pointer press, as a browser delivers it. */
function pressPointer(target: HTMLElement): void {
  fireEvent.mouseDown(target);
  fireEvent.click(target, { detail: 1 });
}

/** A screen reader's activate, as WebKit delivers it. */
function pressAssistive(target: HTMLElement): void {
  fireEvent.mouseDown(target, { detail: 0 });
  fireEvent.click(target, { detail: 0 });
}

function select(view: EditorView, from: number, to: number): void {
  view.dispatch({ selection: { anchor: from, head: to } });
}

describe("Markdown editor toolbar from the keyboard", () => {
  it("bolds the selection when Bold is pressed from the keyboard", () => {
    const view = mount("alpha omega");
    select(view, 0, 5);
    pressKey(button("toolbar.bold"));
    expect(view.state.doc.toString()).toBe("**alpha** omega");
  });

  it("applies a pointer press once, not once for mousedown and again for click", () => {
    const view = mount("alpha omega");
    select(view, 0, 5);
    pressPointer(button("toolbar.italic"));
    expect(view.state.doc.toString()).toBe("_alpha_ omega");
  });

  it("applies a screen reader's activate once", () => {
    const view = mount("alpha omega");
    select(view, 0, 5);
    pressAssistive(button("toolbar.bold"));
    expect(view.state.doc.toString()).toBe("**alpha** omega");
  });

  it("opens the heading menu on a screen reader's activate and leaves it open", () => {
    mount("alpha");
    const heading = button("toolbar.heading");
    pressAssistive(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("true");
  });

  it("acts on the selection the editor held, with focus on the button", () => {
    const view = mount("alpha omega");
    select(view, 6, 11);
    const bold = button("toolbar.bold");
    bold.focus();
    expect(document.activeElement).toBe(bold);
    fireEvent.click(bold, { detail: 0 });
    expect(view.state.doc.toString()).toBe("alpha **omega**");
  });

  it("opens the heading menu and applies a level from the keyboard", () => {
    const view = mount("alpha");
    select(view, 0, 0);
    const heading = button("toolbar.heading");
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    pressKey(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    pressKey(screen.getAllByText("toolbar.heading_level")[0]);
    expect(view.state.doc.toString()).toBe("# alpha");
    expect(screen.queryAllByText("toolbar.heading_level")).toHaveLength(0);
  });

  it("keeps the toolbar while focus moves from the editor onto it", () => {
    const { container } = render(
      <MarkdownEditor initialValue="alpha omega" fieldName="content" projectId={1} />
    );
    const content = container.querySelector(".cm-content") as HTMLElement;
    const view = EditorView.findFromDOM(content)!;
    expect(screen.queryByTitle("toolbar.bold")).toBeNull();
    fireEvent.focus(content);
    const bold = button("toolbar.bold");
    select(view, 0, 5);
    // Escape, then Shift-Tab, takes focus from CodeMirror to the toolbar.
    fireEvent.blur(content, { relatedTarget: bold });
    bold.focus();
    expect(screen.queryByTitle("toolbar.bold")).toBe(bold);
    pressKey(bold);
    expect(view.state.doc.toString()).toBe("**alpha** omega");
  });

  it("opens the footnote popover from the keyboard", () => {
    const view = mount("alpha");
    select(view, 5, 5);
    pressKey(button("footnote.button"));
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("opens the glossary link picker from the keyboard", () => {
    mount("alpha");
    expect(screen.queryByPlaceholderText("search_terms_placeholder")).toBeNull();
    pressKey(button("insert_link_button"));
    expect(screen.queryByPlaceholderText("search_terms_placeholder")).not.toBeNull();
  });
});

describe("toolbarPress", () => {
  const event = (detail: number) => {
    const prevented = { value: false };
    const e = {
      detail,
      preventDefault: () => {
        prevented.value = true;
      },
    } as unknown as React.MouseEvent<HTMLElement>;
    return { e, prevented };
  };

  it("acts on click only, and keeps focus on mousedown", () => {
    const action = vi.fn();
    const press = toolbarPress(action);
    const down = event(1);
    press.onMouseDown(down.e);
    expect(down.prevented.value).toBe(true);
    expect(action).not.toHaveBeenCalled();
    press.onClick(event(1).e);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled", () => {
    const action = vi.fn();
    const press = toolbarPress(action, true);
    press.onMouseDown(event(0).e);
    press.onClick(event(0).e);
    expect(action).not.toHaveBeenCalled();
  });
});
