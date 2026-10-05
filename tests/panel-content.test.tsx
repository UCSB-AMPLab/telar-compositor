// @vitest-environment jsdom
/**
 * A layer panel's content on the stage as the author edits it
 * (PanelContent): the rendered block opening into the editor, the editor
 * closing again, and a content save without a Y.Text through the stage's
 * owner (use-layer-content-drafts.ts): Retry and Discard in the editor's own
 * slot, a failed or pending draft kept across the editor closing and
 * opening, the panel being covered, a layer with nowhere to save to, the
 * Y.Text path, a publish in progress, presence, and two authors on one
 * shared text.
 *
 * The owner's sends are deferred promises the test settles; the editor is
 * the real MarkdownEditor.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";

const collab = vi.hoisted(() => ({
  isPublishing: false,
  provider: null as null | { awareness: { getLocalState: () => Record<string, unknown>; setLocalStateField: (f: string, v: unknown) => void } },
  undoManager: null as unknown,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(() => Promise.resolve()) }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: collab.provider,
    isPublishing: collab.isPublishing,
    undoManager: collab.undoManager,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
}));

import { useRef, useState } from "react";
import { PanelContent } from "~/components/features/editor/PanelContent";
import { usePanelDismissKeys } from "~/hooks/use-panel-dismiss-keys";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import type { StagePanelLayer } from "~/components/features/editor/StagePanels";
import { LayerContentDrafts } from "~/hooks/use-layer-content-drafts";
import { parsePanelPreviewConfig } from "~/lib/panel-preview-config";
import { resetTargetSaves } from "~/components/ui/target-saves";
import type { FieldSaveOptions } from "~/hooks/use-route-field-save";

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

interface Sent {
  fields: Record<string, string>;
  options: FieldSaveOptions;
  resolve: (stamp: number | undefined) => void;
  reject: (error: unknown) => void;
}
let sent: Sent[];
let drafts: LayerContentDrafts;
const glossary = { terms: new Map([["loom", "Loom"]]), baseUrl: "" };
const config = parsePanelPreviewConfig(null, null);

function layer(over: Partial<StagePanelLayer> = {}): StagePanelLayer {
  return {
    key: "L1",
    id: 51,
    layer_number: 1,
    title: null,
    button_label: null,
    content: "Loaded text.",
    titleYText: null,
    contentYText: null,
    buttonLabelYText: null,
    canDelete: true,
    ...over,
  };
}

function Content({ over = {}, dismissed = false, owner }: { over?: Partial<StagePanelLayer>; dismissed?: boolean; owner?: LayerContentDrafts }) {
  return (
    <PanelContent layer={layer(over)} drafts={owner ?? drafts} dismissed={dismissed} glossary={glossary} objects={[]} actionUrl="/" readStamp={1} />
  );
}

const block = () => document.querySelector("[data-panel-content]") as HTMLElement | null;
const editorView = (root: Document | Element = document) => {
  const content = root.querySelector(".cm-content") as HTMLElement | null;
  return content ? EditorView.findFromDOM(content) : null;
};
const failure = () => screen.queryByTestId("editor-save-error");

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function openBlock() {
  fireEvent.click(block()!.querySelector("p") ?? block()!);
}

function type(text: string) {
  const view = editorView()!;
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text } }));
}

/** Types, waits for the owner's debounce, and answers the send with a failure. */
async function typeAndFail(text: string) {
  type(text);
  await wait(40);
  const last = sent.at(-1)!;
  await act(async () => last.reject(new Error("refused")));
}

beforeEach(() => {
  sent = [];
  collab.isPublishing = false;
  collab.provider = null;
  collab.undoManager = null;
  drafts = new LayerContentDrafts(
    { projectId: 3, storyKey: "s1", actionUrl: "/stories/s1" },
    (_layerId, fields, options) => new Promise((resolve, reject) => sent.push({ fields, options, resolve, reject })),
    { debounceMs: 20, errorMessage: () => "stage.save_failed" },
  );
  drafts.reopen();
});

afterEach(() => {
  cleanup();
  drafts.close();
  resetTargetSaves();
  sessionStorage.clear();
});

describe("opening and closing", () => {
  it("opens the editor from the rendered text, on the text the owner holds, and closes as focus leaves", async () => {
    render(<Content />);
    expect(editorView()).toBeNull();
    openBlock();
    const view = editorView()!;
    expect(view.state.doc.toString()).toBe("Loaded text.");
    expect(view.hasFocus).toBe(true);
    act(() => (document.activeElement as HTMLElement).blur());
    await wait(10);
    expect(editorView()).toBeNull();
    expect(block()).not.toBeNull();
  });

  it("opens from Enter or Space on the block itself, and not from a key a widget handles", () => {
    render(<Content over={{ content: "Before.\n\n:::tabs\n## One\nA.\n\n## Two\nB.\n:::" }} />);
    const tab = block()!.querySelector('[role="tab"]') as HTMLElement;
    fireEvent.keyDown(tab, { key: "Enter" });
    fireEvent.keyDown(tab, { key: " " });
    expect(editorView()).toBeNull();
    fireEvent.keyDown(block()!, { key: " " });
    expect(editorView()).not.toBeNull();
  });

  it("is not opened by a widget's controls", () => {
    render(<Content over={{ content: ":::accordion\n## One\nA.\n:::\n\n:::carousel\nimage: https://i.example/a.jpg\n---\nimage: https://i.example/b.jpg\n:::" }} />);
    for (const control of block()!.querySelectorAll(".telar-widget button")) fireEvent.click(control);
    expect(editorView()).toBeNull();
  });

  it("follows an ordinary link on a modified click, and edits on a plain click, a glossary link never navigating", () => {
    render(<Content over={{ content: "See [the site](https://example.org) and [[loom]]." }} />);
    const link = block()!.querySelector('a[href="https://example.org"]') as HTMLAnchorElement;
    const followed = fireEvent.click(link, { metaKey: true });
    expect(followed).toBe(true);
    expect(editorView()).toBeNull();
    const glossaryLink = block()!.querySelector("a.glossary-inline-link") as HTMLAnchorElement;
    expect(fireEvent.click(glossaryLink, { ctrlKey: true })).toBe(false);
    expect(editorView()).not.toBeNull();
  });

  it("draws a glossary callout as a glossary link: a click never navigates and edits", () => {
    render(<Content over={{ content: "Before.\n\n:::glossary\nentry: loom\nalign: left\n:::" }} />);
    const callout = block()!.querySelector("a.glossary-inline-link.glossary-callout.glossary-callout--left") as HTMLAnchorElement;
    expect(callout.querySelector(".glossary-callout-title")!.textContent).toBe("Loom");
    expect(fireEvent.click(callout)).toBe(false);
    expect(editorView()).not.toBeNull();
  });

  it("while a publish holds the document, opens from neither a click nor a key, and says it is disabled", () => {
    collab.isPublishing = true;
    render(<Content />);
    expect(block()!.getAttribute("aria-disabled")).toBe("true");
    openBlock();
    fireEvent.keyDown(block()!, { key: "Enter" });
    expect(editorView()).toBeNull();
  });
});

describe("where a click opens the editor", () => {
  afterEach(() => {
    delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
  });

  /** Answers the browser's caret-from-point with a place `into` characters into `word`. */
  function pointAt(word: string, into: number) {
    const walker = document.createTreeWalker(block()!, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const at = node.data.indexOf(word);
      if (at === -1) continue;
      (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint = () => ({ offsetNode: node, offset: at + into });
      return node.parentElement!;
    }
    throw new Error(`no ${word}`);
  }

  it("opens a click in the text with the caret at the place clicked, not at the end", () => {
    const content = "First paragraph.\n\nSecond **strong** words here.";
    render(<Content over={{ content }} />);
    fireEvent.click(pointAt("words", 2));
    const view = editorView()!;
    expect(view.state.selection.main.head).toBe(content.indexOf("words") + 2);
  });

  it("opens a click in a widget's section with its box open and the section's text focused", async () => {
    const content = "Intro.\n\n:::accordion\n## One\nFirst.\n\n## Two\nSecond.\n:::";
    render(<Content over={{ content }} />);
    fireEvent.click(block()!.querySelectorAll(".accordion-item")[1]);
    await wait(10);
    const nested = [...document.querySelectorAll(".cm-panel-field .cm-content")];
    expect(nested).toHaveLength(2);
    expect(EditorView.findFromDOM(nested[1] as HTMLElement)!.hasFocus).toBe(true);
    expect(EditorView.findFromDOM(nested[1] as HTMLElement)!.state.doc.toString()).toBe("Second.");
  });

  it("opens the second of two identical widgets, its section's text focused, when nothing has changed", async () => {
    const box = ":::accordion\n## Same\nSame text.\n:::";
    render(<Content over={{ content: `${box}\n\n${box}` }} />);
    fireEvent.click(block()!.querySelectorAll(".accordion-item")[1]);
    await wait(10);
    const fields = [...document.querySelectorAll(".cm-panel-field .cm-content")];
    expect(fields).toHaveLength(1);
    expect(EditorView.findFromDOM(fields[0] as HTMLElement)!.hasFocus).toBe(true);
  });

  it("does not open for a carousel swipe", () => {
    render(<Content over={{ content: ":::carousel\nimage: https://i.example/a.jpg\n---\nimage: https://i.example/b.jpg\n:::" }} />);
    const carousel = block()!.querySelector(".carousel")!;
    fireEvent.touchStart(carousel, { touches: [{ clientX: 200 }] });
    fireEvent.touchEnd(carousel, { changedTouches: [{ clientX: 100 }] });
    fireEvent.click(carousel.querySelector(".carousel-item.active")!);
    expect(editorView()).toBeNull();
  });

  it("drops the request when the editor closes: the next opening is its own", async () => {
    const content = "Alpha beta gamma.";
    const { rerender } = render(<Content over={{ content }} />);
    fireEvent.click(pointAt("gamma", 1));
    expect(editorView()!.state.selection.main.head).toBe(content.indexOf("gamma") + 1);
    rerender(<Content over={{ content }} dismissed />);
    rerender(<Content over={{ content }} />);
    fireEvent.keyDown(block()!, { key: "Enter" });
    expect(editorView()!.state.selection.main.head).toBe(0);
  });

  it("places the caret once: a Y.Text re-creating the view does not place it again", () => {
    const placeCaret = vi.fn();
    const first = new Y.Doc().getText("content");
    const second = new Y.Doc().getText("content");
    const props = { initialValue: "", fieldName: "content", projectId: 1, autoFocus: true, placeCaret };
    const { rerender } = render(<MarkdownEditor {...props} yText={first} />);
    rerender(<MarkdownEditor {...props} yText={second} />);
    expect(placeCaret).toHaveBeenCalledTimes(1);
  });
});

describe("the glossary's jump to a panel", () => {
  it("highlights the first glossary link in the panel asked, once it has rendered, and answers", () => {
    const onHighlighted = vi.fn();
    const text = "Plain [link](https://example.org), then [[loom]] and [[loom|again]].";
    render(
      <>
        <PanelContent layer={layer({ content: text })} drafts={drafts} glossary={glossary} objects={[]} actionUrl="/" />
        <PanelContent
          layer={layer({ key: "L2", id: 52, layer_number: 2, content: text })}
          drafts={drafts}
          glossary={glossary}
          objects={[]}
          actionUrl="/"
          highlight={7}
          onHighlighted={onHighlighted}
        />
      </>,
    );
    const [one, two] = [...document.querySelectorAll("[data-panel-content]")];
    const links = [...two.querySelectorAll("a.glossary-inline-link")];
    expect(links[0].classList.contains("glossary-link-pulse")).toBe(true);
    expect(links[1].classList.contains("glossary-link-pulse")).toBe(false);
    expect(one.querySelector(".glossary-link-pulse")).toBeNull();
    expect(onHighlighted).toHaveBeenCalledWith(7);
  });

  it("answers a panel with nothing to highlight, once its rendering is ready", () => {
    const onHighlighted = vi.fn();
    const props = { layer: layer(), drafts, glossary, objects: [], actionUrl: "/", highlight: 3, onHighlighted };
    const { rerender } = render(<PanelContent {...props} />);
    expect(onHighlighted).not.toHaveBeenCalled();
    rerender(<PanelContent {...props} previewConfig={config} />);
    expect(onHighlighted).toHaveBeenCalledWith(3);
  });

  it("waits for the glossary's terms before answering, then highlights", () => {
    const onHighlighted = vi.fn();
    const props = { layer: layer({ content: "A [[loom]] here." }), drafts, objects: [], actionUrl: "/", highlight: 4, onHighlighted, previewConfig: config };
    const { rerender } = render(<PanelContent {...props} glossary={{ terms: new Map(), baseUrl: "" }} />);
    expect(onHighlighted).not.toHaveBeenCalled();
    rerender(<PanelContent {...props} glossary={glossary} />);
    expect(document.querySelector("a.glossary-inline-link")!.classList.contains("glossary-link-pulse")).toBe(true);
    expect(onHighlighted).toHaveBeenCalledWith(4);
  });

  it("keeps the highlight on the link when a later generation replaces the rendering", () => {
    const onHighlighted = vi.fn();
    const props = { layer: layer({ content: "A [[loom]] here." }), drafts, glossary, objects: [], actionUrl: "/", onHighlighted };
    const { rerender } = render(<PanelContent {...props} highlight={5} />);
    expect(onHighlighted).toHaveBeenCalledWith(5);
    const first = document.querySelector("a.glossary-inline-link")!;
    // The request answered, the configuration arrives and the rendering is made again.
    rerender(<PanelContent {...props} highlight={null} previewConfig={config} />);
    const second = document.querySelector("a.glossary-inline-link")!;
    expect(second).not.toBe(first);
    expect(second.classList.contains("glossary-link-pulse")).toBe(true);
  });
});

describe("the editor as the panel mounts it", () => {
  function Panel({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = useState(true);
    const panelRef = useRef<HTMLDivElement>(null);
    const headingRef = useRef<HTMLHeadingElement>(null);
    usePanelDismissKeys({ enabled: open, topPanel: () => panelRef.current, topHeading: () => headingRef.current, onClose: () => setOpen(false) });
    if (!open) return null;
    return (
      <div data-testid="panel" ref={panelRef}>
        <h1 tabIndex={-1} ref={headingRef}>Heading</h1>
        {children}
      </div>
    );
  }

  it("Escape in the editor goes to the heading, closing the editor; the next closes the panel", async () => {
    render(<Panel><Content /></Panel>);
    openBlock();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await wait(10);
    expect(document.activeElement!.tagName).toBe("H1");
    expect(editorView()).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("Escape after a failed save leaves the editor open with its draft", async () => {
    render(<Panel><Content /></Panel>);
    openBlock();
    await typeAndFail(" Kept.");
    act(() => editorView()!.focus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await wait(10);
    expect(editorView()!.state.doc.toString()).toBe("Loaded text. Kept.");
  });

  it("the toolbar's Bold acts on the widget field a click opened, at its caret", async () => {
    const content = "Intro.\n\n:::accordion\n## One\nFirst words.\n:::";
    render(<Content over={{ content }} />);
    fireEvent.click(block()!.querySelector(".accordion-item")!);
    await wait(10);
    const nested = EditorView.findFromDOM(document.querySelector(".cm-panel-field .cm-content") as HTMLElement)!;
    act(() => nested.dispatch({ selection: { anchor: 0, head: "First".length } }));
    const bold = screen.getByTitle("toolbar.bold");
    fireEvent.mouseDown(bold);
    fireEvent.click(bold, { detail: 1 });
    expect(nested.state.doc.toString()).toBe("**First** words.");
    // The panel's own text, as the editor reports it to the owner.
    expect(drafts.view(51, content, 1).value).toBe("Intro.\n\n:::accordion\n## One\n**First** words.\n:::");
  });
});

describe("a layer with no database id and no Y.Text", () => {
  it("shows its content and cannot be opened", () => {
    render(<Content over={{ id: 0, key: "temp-a" }} />);
    expect(block()!.getAttribute("aria-disabled")).toBe("true");
    expect(block()!.textContent).toContain("Loaded text.");
    openBlock();
    fireEvent.keyDown(block()!, { key: "Enter" });
    expect(editorView()).toBeNull();
  });
});

describe("saving through the owner", () => {
  it("sends the content after the pause, as autosave-layer content", async () => {
    render(<Content />);
    openBlock();
    type(" More.");
    await wait(40);
    expect(sent.map((s) => s.fields)).toEqual([{ intent: "autosave-layer", layerId: "51", field: "content", value: "Loaded text. More." }]);
  });

  it("a failed save says so under the open editor, with Retry by pointer", async () => {
    render(<Content />);
    openBlock();
    await typeAndFail(" More.");
    expect(failure()!.textContent).toBe("stage.save_failed");
    expect(screen.queryByText("in_place.recovered_discard")).toBeNull();
    fireEvent.click(screen.getByText("in_place.recovered_retry"));
    expect(sent.at(-1)!.fields.value).toBe("Loaded text. More.");
    await act(async () => sent.at(-1)!.resolve(5));
    expect(failure()).toBeNull();
  });

  it("keeps the editor open as focus moves to Retry, which the keyboard presses", async () => {
    render(<Content />);
    openBlock();
    await typeAndFail(" More.");
    const retry = screen.getByText("in_place.recovered_retry");
    act(() => retry.focus());
    await wait(10);
    expect(editorView()).not.toBeNull();
    fireEvent.click(retry, { detail: 0 });
    expect(sent).toHaveLength(2);
  });

  it("shows the word count while the editor has focus, as the panel's editor always has", async () => {
    render(<Content />);
    openBlock();
    await wait(10);
    expect(screen.getByText("word_count")).toBeTruthy();
  });

  it("stays open when focus leaves after a failure", async () => {
    render(<Content />);
    openBlock();
    await typeAndFail(" More.");
    act(() => (document.activeElement as HTMLElement).blur());
    await wait(10);
    expect(editorView()).not.toBeNull();
  });

  it("keeps a failure across the editor closing, says so on the block, and reopens on the draft with Discard", async () => {
    const { rerender } = render(<Content />);
    openBlock();
    await typeAndFail(" Kept.");
    // Covered: the editor closes whatever the save did.
    rerender(<Content dismissed />);
    expect(editorView()).toBeNull();
    expect(block()!.textContent).toContain("Loaded text. Kept.");
    expect(block()!.querySelector("[data-in-place-marker]")!.textContent).toBe("in_place.recovered_marker");
    rerender(<Content />);
    openBlock();
    expect(editorView()!.state.doc.toString()).toBe("Loaded text. Kept.");
    expect(failure()).not.toBeNull();
    fireEvent.click(screen.getByText("in_place.recovered_discard"));
    expect(editorView()).toBeNull();
    expect(block()!.textContent).toContain("Loaded text.");
    expect(block()!.textContent).not.toContain("Kept.");
    expect(block()!.querySelector("[data-in-place-marker]")).toBeNull();
  });

  it("holds Discard while an earlier send is still out", async () => {
    const { rerender } = render(<Content />);
    openBlock();
    type(" A.");
    await wait(40);
    // B fails while A is still out.
    await typeAndFail(" B.");
    rerender(<Content dismissed />);
    rerender(<Content />);
    openBlock();
    const discard = screen.getByText("in_place.recovered_discard");
    expect(discard.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(discard);
    expect(editorView()!.state.doc.toString()).toBe("Loaded text. A. B.");
  });

  it("reopens on a pending draft, and an edit before its answer is sent after it", async () => {
    const { rerender } = render(<Content />);
    openBlock();
    type(" Pending.");
    // Covered before the pause: leaving sends it, once.
    rerender(<Content dismissed />);
    expect(sent.map((s) => s.fields.value)).toEqual(["Loaded text. Pending."]);
    rerender(<Content />);
    expect(block()!.textContent).toContain("Pending.");
    openBlock();
    expect(editorView()!.state.doc.toString()).toBe("Loaded text. Pending.");
    type(" Later.");
    await act(async () => sent[0].resolve(5));
    expect(editorView()!.state.doc.toString()).toBe("Loaded text. Pending. Later.");
    await wait(40);
    expect(sent.map((s) => s.fields.value)).toEqual(["Loaded text. Pending.", "Loaded text. Pending. Later."]);
  });

  it("sends a held draft once when the panel goes, and not again when the pause ends", async () => {
    const { unmount } = render(<Content />);
    openBlock();
    type(" Gone.");
    unmount();
    // Sent as the panel goes, before the pause would have sent it.
    expect(sent.map((s) => s.fields.value)).toEqual(["Loaded text. Gone."]);
    await wait(40);
    expect(sent.map((s) => s.fields.value)).toEqual(["Loaded text. Gone."]);
  });
});

describe("with a Y.Text", () => {
  it("edits the shared text and never touches the owner", async () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "Shared.");
    render(<Content over={{ contentYText: text }} />);
    expect(block()!.textContent).toContain("Shared.");
    openBlock();
    type(" Typed.");
    await wait(40);
    expect(text.toString()).toBe("Shared. Typed.");
    expect(sent).toHaveLength(0);
  });

  function sharedContent(value: string) {
    const text = new Y.Doc().getText("content");
    text.insert(0, value);
    return text;
  }

  it("offers the draft the owner kept when the shared text took over, and applies it only on request", () => {
    const { rerender } = render(<Content />);
    openBlock();
    type(" Mine.");
    const text = sharedContent("Shared.");
    rerender(<Content over={{ contentYText: text }} />);
    expect(screen.getByTestId("kept-draft")).toBeTruthy();
    expect(text.toString()).toBe("Shared.");
    fireEvent.click(screen.getByTestId("kept-draft-apply"));
    expect(text.toString()).toBe("Loaded text. Mine.");
    expect(screen.queryByTestId("kept-draft")).toBeNull();
  });

  it("drops the kept draft on Discard, the shared text untouched", () => {
    const { rerender } = render(<Content />);
    openBlock();
    type(" Mine.");
    const text = sharedContent("Shared.");
    rerender(<Content over={{ contentYText: text }} />);
    fireEvent.click(screen.getByTestId("kept-draft-discard"));
    expect(screen.queryByTestId("kept-draft")).toBeNull();
    expect(text.toString()).toBe("Shared.");
  });

  it("while a publish holds the document, the kept draft can be neither applied nor discarded", () => {
    const { rerender } = render(<Content />);
    openBlock();
    type(" Mine.");
    const text = sharedContent("Shared.");
    rerender(<Content over={{ contentYText: text }} />);
    collab.isPublishing = true;
    rerender(<Content over={{ contentYText: text }} />);
    expect((screen.getByTestId("kept-draft-apply") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("kept-draft-discard") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("kept-draft-apply"));
    expect(text.toString()).toBe("Shared.");
  });

  it("a send out at takeover is offered only once it fails", async () => {
    const { rerender } = render(<Content />);
    openBlock();
    type(" Mine.");
    await wait(40);
    act(() => sent[0].options.onSubmit?.());
    rerender(<Content over={{ contentYText: sharedContent("Shared.") }} />);
    expect(screen.queryByTestId("kept-draft")).toBeNull();
    await act(async () => sent[0].reject(new Error("refused")));
    expect(screen.getByTestId("kept-draft")).toBeTruthy();
  });

  it("two authors on one text, one in a widget and one writing a footnote, each undoing only their own", async () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u, "remote"));
    b.on("update", (u: Uint8Array) => Y.applyUpdate(a, u, "remote"));
    const source = "Prose.\n\n:::accordion\n## One\nFirst.\n:::";
    a.getText("content").insert(0, source);
    const undoA = new Y.UndoManager(a.getText("content"), { trackedOrigins: new Set([null]) });
    collab.undoManager = undoA;
    const first = render(<Content over={{ contentYText: a.getText("content") }} />);
    fireEvent.click(first.container.querySelector("[data-panel-content] p")!);
    collab.undoManager = null;
    const second = render(<Content over={{ key: "L1b", contentYText: b.getText("content") }} />);
    fireEvent.click(second.container.querySelector("[data-panel-content] p")!);
    const viewA = editorView(first.container)!;
    const viewB = editorView(second.container)!;
    const inWidget = viewA.state.doc.toString().indexOf("First.") + "First".length;
    act(() => viewA.dispatch({ changes: { from: inWidget, insert: " edited" }, userEvent: "input" }));
    act(() => viewB.dispatch({ changes: { from: "Prose".length, insert: "[^n]" }, userEvent: "input" }));
    act(() => viewB.dispatch({ changes: { from: viewB.state.doc.length, insert: "\n\n[^n]: A note." }, userEvent: "input" }));
    const both = "Prose[^n].\n\n:::accordion\n## One\nFirst edited.\n:::\n\n[^n]: A note.";
    expect(a.getText("content").toString()).toBe(both);
    expect(b.getText("content").toString()).toBe(both);
    act(() => {
      undoA.undo();
    });
    const undone = "Prose[^n].\n\n:::accordion\n## One\nFirst.\n:::\n\n[^n]: A note.";
    expect(a.getText("content").toString()).toBe(undone);
    expect(viewB.state.doc.toString()).toBe(undone);
  });
});

describe("presence", () => {
  function awarenessStub() {
    let state: Record<string, unknown> = { location: { route: "/stories/s", storyId: "s", fieldKey: null } };
    return {
      getLocalState: () => state,
      setLocalStateField: (field: string, value: unknown) => {
        state = { ...state, [field]: value };
      },
    };
  }
  const fieldKeyNow = () => (collab.provider!.awareness.getLocalState().location as { fieldKey: string | null }).fieldKey;

  it("names the content while the editor has focus, and clears it as the editor closes", async () => {
    collab.provider = { awareness: awarenessStub() };
    render(<Content />);
    openBlock();
    await wait(10);
    expect(fieldKeyNow()).toBe("layer-L1-content");
    act(() => (document.activeElement as HTMLElement).blur());
    await wait(10);
    expect(editorView()).toBeNull();
    expect(fieldKeyNow()).toBeNull();
  });

  it("clears it when the panel goes with the editor open", async () => {
    collab.provider = { awareness: awarenessStub() };
    const { unmount } = render(<Content />);
    openBlock();
    await wait(10);
    unmount();
    expect(fieldKeyNow()).toBeNull();
  });
});

describe("covered", () => {
  const css = readFileSync(join(process.cwd(), "app/styles/visitor-layer.css"), "utf8");
  const at = css.indexOf(".visitor-layer .offcanvas[inert]");
  const hidden = css.slice(at, css.indexOf(" {", at));

  it("keeps the content's text and its text links in the strip, and hides widget controls", () => {
    render(
      <div className="visitor-layer">
        <div className="offcanvas" inert>
          <Content over={{ content: "A [link](https://example.org), [[loom]] and a note[^n].\n\n:::accordion\n## One\nA.\n:::\n\n[^n]: The note." }} />
        </div>
      </div>,
    );
    expect(block()!.matches(hidden)).toBe(false);
    const prose = block()!.querySelector("[data-panel-prose]")!;
    const links = [...prose.querySelectorAll("a")].filter((a) => !a.closest("[data-panel-widget]"));
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const link of links) expect(link.matches(hidden), link.outerHTML).toBe(false);
    expect(block()!.querySelector(".accordion-button")!.matches(hidden)).toBe(true);
  });

  it("switches an open editor back to the rendered text, closes its overlays, and takes no focus", async () => {
    const { rerender } = render(<Content />);
    openBlock();
    act(() => editorView()!.focus());
    fireEvent.click(document.querySelector('[title="toolbar.link"]')!, { detail: 0 });
    expect(await screen.findByPlaceholderText("link_popover.url_placeholder")).toBeTruthy();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    rerender(<Content dismissed />);
    expect(editorView()).toBeNull();
    expect(screen.queryByPlaceholderText("link_popover.url_placeholder")).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
