/**
 * @vitest-environment jsdom
 *
 * footnote-button.test.tsx — the layer panel editor's Footnote button, on the
 * real MarkdownEditor in both persistence modes: standalone, where CodeMirror's
 * history() undoes, and collaborative, where a Y.Text is bound through yCollab
 * and the shared Y.UndoManager undoes. The mocking follows
 * editor-paste-cleaning.test.tsx.
 *
 * A remote edit is a change the popover did not make: in standalone mode a
 * transaction dispatched on the view, in collaborative mode a Y transaction on
 * the shared text with a foreign origin, which yCollab applies to the view.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import * as Y from "yjs";

const { collab } = vi.hoisted(() => ({
  collab: {
    ydoc: null as unknown,
    undoManager: null as unknown,
    isPublishing: false,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(() => Promise.resolve()) }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: collab.ydoc,
    provider: null,
    isPublishing: collab.isPublishing,
    undoManager: collab.undoManager,
  }),
}));

import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { Dialog } from "~/components/ui/Dialog";

const LABEL = "[a-hjkmnp-z][a-hjkmnp-z2-9]{3}";

function viewIn(container: HTMLElement): EditorView {
  const content = container.querySelector(".cm-content") as HTMLElement | null;
  expect(content).toBeTruthy();
  return EditorView.findFromDOM(content!)!;
}

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

beforeEach(() => {
  collab.ydoc = null;
  collab.undoManager = null;
  collab.isPublishing = false;
});

afterEach(() => {
  cleanup();
});

interface Mounted {
  view: EditorView;
  read: () => string;
  undo: () => void;
  remoteEdit: (from: number, to: number, insert: string) => void;
  /** Collaborative only: a peer's insert at the start, outside this editor's undo. */
  peerInsert: ((text: string) => void) | null;
  /** Replaces the edited document, as switching to another layer does. */
  swapDocument: (initial: string) => void;
}

type Mount = (initial: string, props?: { enableFootnotes?: boolean }) => Mounted;

const standalone: Mount = (initial, props = { enableFootnotes: true }) => {
  const editor = (value: string) => (
    <MarkdownEditor initialValue={value} fieldName="content" projectId={1} alwaysShowToolbar {...props} />
  );
  const { container, rerender } = render(editor(initial));
  const mounted: Mounted = {
    view: viewIn(container),
    read: () => mounted.view.state.doc.toString(),
    undo: () => undo(mounted.view),
    remoteEdit: (from, to, insert) => mounted.view.dispatch({ changes: { from, to, insert } }),
    peerInsert: null,
    swapDocument: (value) => {
      rerender(editor(value));
      mounted.view = viewIn(container);
    },
  };
  return mounted;
};

function sharedText(initial: string) {
  const ydoc = new Y.Doc();
  const yText = ydoc.getText("content");
  yText.insert(0, initial);
  const undoManager = new Y.UndoManager(yText);
  collab.ydoc = ydoc;
  collab.undoManager = undoManager;
  return { ydoc, yText, undoManager };
}

const collaborative: Mount = (initial, props = { enableFootnotes: true }) => {
  let shared = sharedText(initial);
  const editor = () => (
    <MarkdownEditor initialValue={initial} fieldName="content" projectId={1} yText={shared.yText} alwaysShowToolbar {...props} />
  );
  const { container, rerender } = render(editor());
  const mounted: Mounted = {
    view: viewIn(container),
    read: () => shared.yText.toString(),
    undo: () => shared.undoManager.undo(),
    remoteEdit: (from, to, insert) =>
      shared.ydoc.transact(() => {
        shared.yText.delete(from, to - from);
        shared.yText.insert(from, insert);
      }, "remote-peer"),
    peerInsert: (text) =>
      shared.ydoc.transact(() => shared.yText.insert(0, text), "remote-peer"),
    swapDocument: (value) => {
      shared = sharedText(value);
      rerender(editor());
      mounted.view = viewIn(container);
    },
  };
  return mounted;
};

function footnoteButton(): HTMLButtonElement | null {
  return screen.queryByTitle("footnote.button") as HTMLButtonElement | null;
}

/** A pointer press as a browser delivers it: mousedown, then click. */
function press(button: HTMLElement): void {
  fireEvent.mouseDown(button);
  fireEvent.click(button, { detail: 1 });
}

function openPopoverAt(view: EditorView, at: number): void {
  view.dispatch({ selection: { anchor: at } });
  press(footnoteButton()!);
}

/** The footnote popover, named by its button; an enclosing Dialog is a dialog too. */
function dialog(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: "footnote.button" });
}

function textarea(): HTMLTextAreaElement {
  return dialog()!.querySelector("textarea")!;
}

function write(text: string): void {
  fireEvent.change(textarea(), { target: { value: text } });
}

function clickButton(name: string): void {
  fireEvent.click(screen.getByText(name));
}

function typeAt(view: EditorView, at: number, text: string): void {
  view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" });
}

describe.each([
  ["standalone", standalone],
  ["collaborative", collaborative],
])("Footnote button (%s)", (_mode, mount) => {
  it("inserts the reference at the cursor and the definition at the end", () => {
    const { view, read } = mount("Alpha beta.");
    openPopoverAt(view, 5);
    write("A note");
    clickButton("link_popover.insert");
    expect(read()).toMatch(new RegExp(`^Alpha\\[\\^(${LABEL})\\] beta\\.\\n\\n\\[\\^\\1\\]: A note$`));
    expect(dialog()).toBeNull();
  });

  it("is one undo step, separate from the typing before and after it", () => {
    const { view, read, undo, peerInsert } = mount("Alpha beta.");
    typeAt(view, 5, "x");
    openPopoverAt(view, 6);
    write("A note");
    clickButton("link_popover.insert");
    const withNote = read();
    expect(withNote).toMatch(new RegExp(`^Alphax\\[\\^(${LABEL})\\] beta\\.\\n\\n\\[\\^\\1\\]: A note$`));
    typeAt(view, withNote.indexOf(" beta"), "y");
    const peer = peerInsert ? "Peer " : "";
    peerInsert?.(peer);
    undo();
    expect(read()).toBe(peer + withNote);
    undo();
    expect(read()).toBe(`${peer}Alphax beta.`);
  });

  it("inserts at the cursor of a backwards selection", () => {
    const { view, read } = mount("Alpha beta gamma.");
    view.dispatch({ selection: { anchor: 10, head: 5 } });
    press(footnoteButton()!);
    write("Note");
    clickButton("link_popover.insert");
    expect(read()).toMatch(new RegExp(`^Alpha\\[\\^${LABEL}\\] beta gamma\\.`));
  });

  it.each([
    ["inline code", "Text `code` more.", 7],
    ["a link", "See [the archive](https://example.org).", 8],
    ["a carousel", ":::carousel\nimage: a.jpg\ncaption: A caption\n:::", 30],
    ["a section heading", ":::tabs\n## One\nText\n:::", 11],
  ])("shows only the not-here message inside %s", (_what, doc, at) => {
    const { view, read } = mount(doc);
    openPopoverAt(view, at);
    expect(screen.getByRole("alert").textContent).toBe("footnote.not_here");
    expect(dialog()!.querySelector("textarea, select")).toBeNull();
    expect(screen.queryByText("link_popover.insert")).toBeNull();
    clickButton("link_popover.cancel");
    expect(dialog()).toBeNull();
    expect(read()).toBe(doc);
  });

  it("puts a note written in a tabs section at the end of that section", () => {
    const doc = ":::tabs\n## One\nFirst text.\n\n## Two\nSecond text.\n:::";
    const { view, read } = mount(doc);
    openPopoverAt(view, doc.indexOf(" text."));
    write("Note");
    clickButton("link_popover.insert");
    expect(read()).toMatch(
      new RegExp(`^:::tabs\\n## One\\nFirst\\[\\^(${LABEL})\\] text\\.\\n\\n\\[\\^\\1\\]: Note\\n\\n## Two\\nSecond text\\.\\n:::$`),
    );
  });

  it("puts a note written in a bibliography entry on the line after that entry", () => {
    const doc = ":::bibliography\nFirst entry.\n\nSecond entry.\n:::";
    const { view, read } = mount(doc);
    openPopoverAt(view, doc.indexOf(" entry."));
    write("Note");
    clickButton("link_popover.insert");
    expect(read()).toMatch(
      new RegExp(`^:::bibliography\\nFirst\\[\\^(${LABEL})\\] entry\\.\\n\\[\\^\\1\\]: Note\\n\\nSecond entry\\.\\n:::$`),
    );
  });

  it("refuses after a remote deletion that ends at the cursor", () => {
    const { view, read, remoteEdit } = mount("Alpha beta.");
    openPopoverAt(view, 5);
    write("Note");
    remoteEdit(3, 5, "");
    clickButton("link_popover.insert");
    expect(screen.getByRole("alert").textContent).toBe("footnote.target_changed");
    expect(read()).toBe("Alp beta.");
  });

  it("drops a kept draft when the document changes", () => {
    const { view, remoteEdit, swapDocument } = mount("Alpha beta.");
    openPopoverAt(view, 5);
    write("Kept note");
    remoteEdit(2, 7, "Z");
    clickButton("link_popover.insert");
    expect(screen.getByRole("alert").textContent).toBe("footnote.target_changed");
    // The refused text is kept on close; the test above reopens it unchanged.
    clickButton("link_popover.cancel");
    swapDocument("Another layer.");
    const next = viewIn(document.body);
    openPopoverAt(next, 3);
    expect(textarea().value).toBe("");
  });

  it("reuses an existing note by adding only the reference", () => {
    const { view, read } = mount("Alpha beta.\n\n[^ab2c]: First note");
    openPopoverAt(view, 5);
    fireEvent.change(dialog()!.querySelector("select")!, { target: { value: "ab2c" } });
    clickButton("link_popover.insert");
    expect(read()).toBe("Alpha[^ab2c] beta.\n\n[^ab2c]: First note");
  });

  it("leaves the document as it was on Cancel and on Escape", () => {
    const { view, read } = mount("Alpha beta.");
    openPopoverAt(view, 5);
    write("Unwanted");
    clickButton("link_popover.cancel");
    expect(dialog()).toBeNull();
    openPopoverAt(view, 5);
    expect(textarea().value).toBe("");
    write("Unwanted");
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(read()).toBe("Alpha beta.");
  });

  it("refuses after a remote edit around the cursor and keeps the draft", () => {
    const { view, read, remoteEdit } = mount("Alpha beta.");
    openPopoverAt(view, 5);
    write("Kept note");
    remoteEdit(2, 7, "Z");
    clickButton("link_popover.insert");
    expect(screen.getByRole("alert").textContent).toBe("footnote.target_changed");
    expect(read()).toBe("AlZeta.");
    clickButton("link_popover.cancel");
    expect(dialog()).toBeNull();
    openPopoverAt(view, 2);
    expect(textarea().value).toBe("Kept note");
    clickButton("link_popover.insert");
    expect(read()).toMatch(new RegExp(`^Al\\[\\^(${LABEL})\\]Zeta\\.\\n\\n\\[\\^\\1\\]: Kept note$`));
    openPopoverAt(view, 2);
    expect(textarea().value).toBe("");
  });

  it("does not offer a note inside a code block for reuse", () => {
    const { view } = mount("Alpha.\n\n```\n[^cd2e]: in code\n```\n\n[^ab2c]: Real");
    openPopoverAt(view, 5);
    const options = [...dialog()!.querySelectorAll("option")].map((o) => o.value);
    expect(options).toEqual(["", "ab2c"]);
  });

  it("has no button without enableFootnotes", () => {
    mount("Alpha.", {});
    expect(footnoteButton()).toBeNull();
    expect(screen.queryByTitle("toolbar.bold")).not.toBeNull();
  });
});

describe("Footnote popover inside a dialog", () => {
  it("closes on Escape without closing the dialog", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog open onClose={onClose}>
        <MarkdownEditor initialValue="Alpha beta." fieldName="content" projectId={1} alwaysShowToolbar enableFootnotes />
      </Dialog>,
    );
    openPopoverAt(viewIn(container.ownerDocument.body), 5);
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Footnote button during a publish", () => {
  it("is disabled while a publish holds the collaborative document", () => {
    collab.isPublishing = true;
    collaborative("Alpha.");
    expect(footnoteButton()!.disabled).toBe(true);
    press(footnoteButton()!);
    expect(dialog()).toBeNull();
  });
});

describe("Footnote surfaces", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("are enabled on the layer panel editor and nowhere else", () => {
    const app = resolve(__dirname, "../app");
    const enabling = sourceFiles(app)
      .filter((f) => !f.endsWith("ui/MarkdownEditor.tsx"))
      .filter((f) => readFileSync(f, "utf8").includes("enableFootnotes"))
      .map((f) => f.slice(app.length + 1));
    expect(enabling).toEqual(["components/features/editor/PanelContent.tsx"]);
  });
});
