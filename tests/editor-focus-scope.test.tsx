/**
 * @vitest-environment jsdom
 *
 * editor-focus-scope.test.tsx — the MarkdownEditor judges focus by its
 * logical scope. Its link and footnote popovers and its image dialog are
 * portalled to `document.body`, outside the editor's DOM; focus moving into
 * any of them is still focus in the editor, and `onFocusLeave` fires only
 * when focus has left the editor and all of them. Also: `autoFocus`, and an
 * unmount that sends a pending debounced save instead of dropping it.
 *
 * Leaving is judged on the next task, so each case lets one pass before it
 * reads the result. The editor is mocked as footnote-button.test.tsx mocks
 * it, with the fetcher's `submit` kept to be read.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";

const { submit } = vi.hoisted(() => ({ submit: vi.fn(() => Promise.resolve()) }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit }),
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

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

beforeEach(() => {
  submit.mockClear();
});

afterEach(() => {
  cleanup();
});

/** Lets the focus change settle: the scope judges it on the next task. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

function viewIn(container: HTMLElement): EditorView {
  return EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement)!;
}

/** Enter on a focused toolbar button, as a browser delivers it. */
function pressKey(target: HTMLElement): void {
  target.focus();
  fireEvent.click(target, { detail: 0 });
}

function mount(props: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) {
  const onFocusLeave = vi.fn();
  const rendered = render(
    <div>
      <button type="button">elsewhere</button>
      <MarkdownEditor
        initialValue="alpha omega"
        fieldName="content"
        projectId={1}
        alwaysShowToolbar
        enableFootnotes
        onFocusLeave={onFocusLeave}
        {...props}
      />
    </div>,
  );
  const view = viewIn(rendered.container);
  return { ...rendered, view, onFocusLeave, elsewhere: screen.getByText("elsewhere") };
}

describe("the editor's focus scope", () => {
  it("counts focus in the link popover as focus in the editor", async () => {
    const { view, onFocusLeave, container } = mount();
    act(() => view.focus());
    await settle();
    pressKey(screen.getByTitle("toolbar.link"));
    const input = screen.getByPlaceholderText("link_popover.url_placeholder");
    expect(container.contains(input)).toBe(false);
    expect(document.activeElement).toBe(input);
    await settle();
    expect(onFocusLeave).not.toHaveBeenCalled();
  });

  it("counts focus in the footnote popover as focus in the editor", async () => {
    const { view, onFocusLeave, container } = mount();
    act(() => view.focus());
    await settle();
    pressKey(screen.getByTitle("footnote.button"));
    const dialog = screen.getByRole("dialog", { name: "footnote.button" });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await settle();
    expect(onFocusLeave).not.toHaveBeenCalled();
  });

  it("counts focus in the image dialog as focus in the editor", async () => {
    const { view, onFocusLeave, container } = mount();
    act(() => view.focus());
    await settle();
    pressKey(screen.getByTitle("toolbar.image"));
    const dialog = screen.getByRole("dialog");
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await settle();
    expect(onFocusLeave).not.toHaveBeenCalled();
  });

  it("reports leaving once focus goes outside the editor", async () => {
    const { view, onFocusLeave, elsewhere } = mount();
    act(() => view.focus());
    await settle();
    act(() => elsewhere.focus());
    await settle();
    expect(onFocusLeave).toHaveBeenCalledTimes(1);
  });

  it("reports leaving when focus goes outside from a popover", async () => {
    const { view, onFocusLeave, elsewhere } = mount();
    act(() => view.focus());
    await settle();
    pressKey(screen.getByTitle("toolbar.link"));
    await settle();
    act(() => elsewhere.focus());
    await settle();
    expect(onFocusLeave).toHaveBeenCalledTimes(1);
  });

  it("gives focus back to the text when the link popover is cancelled", async () => {
    const { view, onFocusLeave } = mount();
    act(() => view.focus());
    await settle();
    pressKey(screen.getByTitle("toolbar.link"));
    fireEvent.click(screen.getByText("link_popover.cancel"));
    expect(view.hasFocus).toBe(true);
    await settle();
    expect(onFocusLeave).not.toHaveBeenCalled();
  });
});

describe("autoFocus", () => {
  it("focuses the editor on mount with the caret at the end", () => {
    const { view } = mount({ autoFocus: true });
    expect(view.hasFocus).toBe(true);
    expect(view.state.selection.main.head).toBe("alpha omega".length);
  });

  it("leaves focus alone without it", () => {
    const { view } = mount();
    expect(view.hasFocus).toBe(false);
  });
});

describe("a pending autosave at unmount", () => {
  it("is sent, not dropped", () => {
    const { view, unmount } = mount({ debounceMs: 10_000 });
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " added" } }));
    expect(submit).not.toHaveBeenCalled();
    unmount();
    expect(submit).toHaveBeenCalledTimes(1);
    const [payload] = submit.mock.calls[0] as unknown as [Record<string, string>];
    expect(payload.value).toBe("alpha omega added");
  });

  it("is sent once, by the timer, when the editor outlives it", async () => {
    const { view, unmount } = mount({ debounceMs: 1 });
    act(() => view.dispatch({ changes: { from: 0, insert: "x" } }));
    await settle();
    unmount();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("is dropped, not sent at unmount, once a Y.Text replaces the standalone editor", () => {
    const props = { initialValue: "alpha", fieldName: "content", projectId: 1, debounceMs: 10_000 };
    const { container, rerender, unmount } = render(<MarkdownEditor {...props} />);
    const view = viewIn(container);
    act(() => view.dispatch({ changes: { from: 5, insert: " typed before the connection" } }));
    const doc = new Y.Doc();
    const yText = doc.getText("content");
    yText.insert(0, "the shared text");
    rerender(<MarkdownEditor {...props} yText={yText} />);
    unmount();
    expect(submit).not.toHaveBeenCalled();
  });

  it("is dropped, not sent by its timer, once a Y.Text replaces the standalone editor", async () => {
    const props = { initialValue: "alpha", fieldName: "content", projectId: 1, debounceMs: 1 };
    const { container, rerender } = render(<MarkdownEditor {...props} />);
    const view = viewIn(container);
    act(() => view.dispatch({ changes: { from: 5, insert: " typed before the connection" } }));
    const doc = new Y.Doc();
    rerender(<MarkdownEditor {...props} yText={doc.getText("content")} />);
    await settle();
    expect(submit).not.toHaveBeenCalled();
  });

  it("saves nothing in controlled mode, and reports each change", () => {
    const onChange = vi.fn();
    const { view, unmount } = mount({ mode: "controlled", onChange, debounceMs: 1 });
    act(() => view.dispatch({ changes: { from: 0, insert: "x" } }));
    unmount();
    expect(onChange).toHaveBeenLastCalledWith("xalpha omega");
    expect(submit).not.toHaveBeenCalled();
  });
});
