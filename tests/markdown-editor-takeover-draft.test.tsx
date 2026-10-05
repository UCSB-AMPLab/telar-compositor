// @vitest-environment jsdom
/**
 * Text typed in an autosave Markdown field while its save is still waiting is
 * kept for the author when the shared text takes the field over: the
 * field shows the shared text, offers the typed text back, and changes the
 * shared text only when the author applies it.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
const fetcher = vi.hoisted(() => ({ state: "idle", data: undefined as unknown, submit: (() => Promise.resolve()) as (...args: unknown[]) => Promise<void> }));
vi.mock("react-router", () => ({
  useFetcher: () => fetcher,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: null, provider: null, isPublishing: false, undoManager: null }),
}));

import { MarkdownEditor } from "~/components/ui/MarkdownEditor";

const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fetcher.data = undefined;
  fetcher.submit = () => Promise.resolve();
});

function sharedText(text: string): Y.Text {
  const ydoc = new Y.Doc();
  const shared = ydoc.getText("content");
  shared.insert(0, text);
  return shared;
}

function editor(yText: Y.Text | null) {
  return (
    <MarkdownEditor initialValue="stored" fieldName="content" projectId={1} yText={yText} debounceMs={1500} />
  );
}

const viewOf = (container: HTMLElement) =>
  EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement)!;

describe("a Markdown field taken over by shared text", () => {
  it("offers the text typed before the connection, and applies it only on request", () => {
    const shared = sharedText("what a collaborator wrote");
    const { container, rerender } = render(editor(null));
    const typing = viewOf(container);
    act(() => typing.dispatch({ changes: { from: typing.state.doc.length, insert: " and my words" } }));

    rerender(editor(shared));
    expect(viewOf(container).state.doc.toString()).toBe("what a collaborator wrote");
    expect(screen.getByTestId("kept-draft")).toBeTruthy();
    expect(shared.toString()).toBe("what a collaborator wrote");

    fireEvent.click(screen.getByTestId("kept-draft-apply"));
    expect(shared.toString()).toBe("stored and my words");
    expect(screen.queryByTestId("kept-draft")).toBeNull();
  });

  it("drops the kept text when the author discards it", () => {
    const shared = sharedText("what a collaborator wrote");
    const { container, rerender } = render(editor(null));
    const typing = viewOf(container);
    act(() => typing.dispatch({ changes: { from: 0, insert: "mine " } }));
    rerender(editor(shared));
    fireEvent.click(screen.getByTestId("kept-draft-discard"));
    expect(screen.queryByTestId("kept-draft")).toBeNull();
    expect(shared.toString()).toBe("what a collaborator wrote");
  });

  it("offers nothing when nothing was typed", () => {
    const { rerender } = render(editor(null));
    rerender(editor(sharedText("what a collaborator wrote")));
    expect(screen.queryByTestId("kept-draft")).toBeNull();
  });

  it("keeps text whose save was out when the shared text arrived, and offers it once that save fails", () => {
    vi.useFakeTimers();
    const shared = sharedText("what a collaborator wrote");
    const { container, rerender } = render(editor(null));
    const typing = viewOf(container);
    act(() => typing.dispatch({ changes: { from: 0, insert: "mine " } }));
    act(() => vi.advanceTimersByTime(1500));
    rerender(editor(shared));
    expect(screen.queryByTestId("kept-draft")).toBeNull();
    fetcher.data = { ok: false, reason: "unreachable" };
    rerender(editor(shared));
    expect(screen.getByTestId("kept-draft")).toBeTruthy();
  });

  it("drops text whose save was out when that save succeeds", () => {
    vi.useFakeTimers();
    const shared = sharedText("what a collaborator wrote");
    const { container, rerender } = render(editor(null));
    const typing = viewOf(container);
    act(() => typing.dispatch({ changes: { from: 0, insert: "mine " } }));
    act(() => vi.advanceTimersByTime(1500));
    rerender(editor(shared));
    fetcher.data = { ok: true };
    rerender(editor(shared));
    expect(screen.queryByTestId("kept-draft")).toBeNull();
  });

  it("holds the kept text for its own shared text: hidden while another shows, back with it, and never written to the other", () => {
    const termA = sharedText("definition of A");
    const termB = sharedText("definition of B");
    const { container, rerender } = render(editor(null));
    const typing = viewOf(container);
    act(() => typing.dispatch({ changes: { from: 0, insert: "mine " } }));
    rerender(editor(termA));
    expect(screen.getByTestId("kept-draft")).toBeTruthy();
    rerender(editor(termB));
    expect(screen.queryByTestId("kept-draft")).toBeNull();
    rerender(editor(termA));
    expect(screen.getByTestId("kept-draft")).toBeTruthy();
    fireEvent.click(screen.getByTestId("kept-draft-apply"));
    expect(termA.toString()).toBe("mine stored");
    expect(termB.toString()).toBe("definition of B");
  });

  describe("with two terms' saves out in the one editor", () => {
    function twoSavesOut() {
      vi.useFakeTimers();
      const rejects: Array<(reason: unknown) => void> = [];
      fetcher.submit = () => new Promise<void>((_, reject) => rejects.push(reject));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const termA = sharedText("definition of A");
      const termB = sharedText("definition of B");
      const { container, rerender } = render(editor(null));
      const typeA = viewOf(container);
      act(() => typeA.dispatch({ changes: { from: 0, insert: "mine A " } }));
      act(() => vi.advanceTimersByTime(1500));
      rerender(editor(termA));
      rerender(editor(null));
      const typeB = viewOf(container);
      act(() => typeB.dispatch({ changes: { from: 0, insert: "mine B " } }));
      act(() => vi.advanceTimersByTime(1500));
      rerender(editor(termB));
      return { termA, termB, rerender, rejects };
    }

    it("offers the first term's text once the second term's save supersedes its save, and keeps it when that save succeeds", async () => {
      const { termA, termB, rerender } = twoSavesOut();
      fetcher.data = { ok: true };
      rerender(editor(termB));
      rerender(editor(termA));
      expect(screen.getByTestId("kept-draft")).toBeTruthy();
      fireEvent.click(screen.getByTestId("kept-draft-apply"));
      expect(termA.toString()).toBe("mine A stored");
    });

    it("waits for the only save still out before offering its text", () => {
      vi.useFakeTimers();
      fetcher.submit = () => new Promise<void>(() => {});
      const termA = sharedText("definition of A");
      const { container, rerender } = render(editor(null));
      act(() => viewOf(container).dispatch({ changes: { from: 0, insert: "mine A " } }));
      act(() => vi.advanceTimersByTime(1500));
      rerender(editor(termA));
      expect(screen.queryByTestId("kept-draft")).toBeNull();
    });
  });
});
