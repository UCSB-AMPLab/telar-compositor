/**
 * @vitest-environment jsdom
 *
 * editor-paste-cleaning.test.tsx — every CodeMirror editor in the Compositor
 * keeps the characters a Telar build rejects out of its document on paste.
 *
 * Three paths reach a document: CodeMirror's own plain-text paste, which the
 * clipboard input filter cleans, and `richPaste`'s two direct dispatches, the
 * converted markdown and the plain-text fallback when conversion fails. The
 * editors are mounted for real and each paste is a `paste` event dispatched on
 * the editor's content element, carrying a stub `clipboardData`. The fallback
 * is reached by making the Turndown constructor throw.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";

const { turndownFlags, collab } = vi.hoisted(() => ({
  turndownFlags: { fail: false },
  collab: { ydoc: null as unknown, undoManager: null as unknown },
}));

vi.mock("turndown", async (importOriginal) => {
  const real = (await importOriginal<{ default: new (o?: unknown) => object }>()).default;
  class FailingTurndown extends real {
    constructor(options?: unknown) {
      if (turndownFlags.fail) throw new Error("conversion unavailable");
      super(options);
    }
  }
  return { default: FailingTurndown };
});

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
    isPublishing: false,
    undoManager: collab.undoManager,
  }),
}));

import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { InlineHtmlEditor } from "~/components/ui/InlineHtmlEditor";
import { _resetTurndownForTests } from "~/components/ui/markdown-editor/richPaste";

const FFFE = String.fromCharCode(0xfffe);
const LS = String.fromCharCode(0x2028);
const C1 = String.fromCharCode(0x90);

function paste(view: EditorView, data: Record<string, string>): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => data[type] ?? "" },
  });
  view.contentDOM.dispatchEvent(event);
}

function viewIn(container: HTMLElement): EditorView {
  const content = container.querySelector(".cm-content") as HTMLElement | null;
  expect(content).toBeTruthy();
  const view = EditorView.findFromDOM(content!);
  expect(view).toBeTruthy();
  return view!;
}

beforeEach(() => {
  turndownFlags.fail = false;
  _resetTurndownForTests();
  collab.ydoc = null;
  collab.undoManager = null;
});

afterEach(() => {
  cleanup();
});

type Mount = () => { view: EditorView; read: () => string };

const standalone: Mount = () => {
  const { container } = render(<MarkdownEditor initialValue="" fieldName="welcome_body" projectId={1} />);
  const view = viewIn(container);
  return { view, read: () => view.state.doc.toString() };
};

const collaborative: Mount = () => {
  const ydoc = new Y.Doc();
  const yText = ydoc.getText("body");
  collab.ydoc = ydoc;
  collab.undoManager = new Y.UndoManager(yText);
  const { container } = render(
    <MarkdownEditor initialValue="" fieldName="body" projectId={1} yText={yText} />,
  );
  const view = viewIn(container);
  return { view, read: () => yText.toString() };
};

describe.each([
  ["standalone", standalone],
  ["collaborative", collaborative],
])("MarkdownEditor (%s)", (_label, mount) => {
  it("cleans a native plain-text paste", () => {
    const { view, read } = mount();
    paste(view, { "text/plain": `Mediterr${FFFE}anean${LS}sea${C1}` });
    expect(read()).toBe("Mediterranean sea");
    expect(view.state.doc.toString()).toBe("Mediterranean sea");
  });

  it("cleans the markdown converted from a rich paste", async () => {
    const { view, read } = mount();
    paste(view, {
      "text/html": `<p><strong>Mediterr${FFFE}anean</strong>${LS}sea</p>`,
      "text/plain": "unused",
    });
    await vi.waitFor(() => {
      expect(read()).toBe("**Mediterranean** sea");
    });
  });

  it("cleans the plain-text fallback when conversion fails", async () => {
    turndownFlags.fail = true;
    const { view, read } = mount();
    paste(view, {
      "text/html": "<p>anything</p>",
      "text/plain": `Mediterr${FFFE}anean${LS}sea`,
    });
    await vi.waitFor(() => {
      expect(read()).toBe("Mediterranean sea");
    });
  });

  it("leaves a clean native paste as it was", () => {
    const { view, read } = mount();
    paste(view, { "text/plain": "Ánfora de terracota\ncon decoración" });
    expect(read()).toBe("Ánfora de terracota\ncon decoración");
  });
});

describe("InlineHtmlEditor", () => {
  it("cleans a native plain-text paste", () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText("description");
    const { container } = render(<InlineHtmlEditor initialValue="" yText={yText} />);
    fireEvent.click(container.querySelector("[data-description-preview]")!);
    const view = viewIn(container);
    paste(view, { "text/plain": `Una <em>descripci${FFFE}ón</em>${LS}breve` });
    expect(yText.toString()).toBe("Una <em>descripción</em> breve");
  });
});
