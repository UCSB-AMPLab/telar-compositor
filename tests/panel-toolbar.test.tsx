/**
 * @vitest-environment jsdom
 *
 * panel-toolbar.test.tsx — the layer panel editor's Bibliography, Widget and
 * Math buttons, and the editors that do not have them.
 *
 * The panel buttons act like every toolbar button: the action
 * runs on click, once per pointer press, keyboard activation or screen
 * reader activate, and a key press on a focused button does nothing of its
 * own. The other Markdown editors keep exactly the toolbar they had before
 * panel authoring. Each insertion is its own step on the shared undo stack.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";

const { collab } = vi.hoisted(() => ({
  collab: { ydoc: null as unknown, undoManager: null as unknown },
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
    isPublishing: false,
    undoManager: collab.undoManager,
  }),
}));

import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { PanelPreviewNotice } from "~/components/ui/markdown-editor/PanelPreviewNotice";
import { parsePanelPreviewConfig } from "~/lib/panel-preview-config";

const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

beforeEach(() => {
  collab.ydoc = null;
  collab.undoManager = null;
});

afterEach(() => {
  cleanup();
});

function viewIn(container: HTMLElement): EditorView {
  return EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement)!;
}

async function mount(props: Record<string, unknown>, initial = "Alpha."): Promise<EditorView> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      <MarkdownEditor initialValue={initial} fieldName="content" projectId={1} alwaysShowToolbar {...props} />,
    ));
  });
  return viewIn(container);
}

function titles(): string[] {
  return [...document.querySelectorAll("button[title]")].map((b) => b.getAttribute("title")!);
}

/** The toolbar as it was before panel authoring, glossary and footnotes aside. */
const MAIN_TOOLBAR = [
  "toolbar.bold",
  "toolbar.italic",
  "toolbar.link",
  "toolbar.image",
  "toolbar.heading",
  "toolbar.bullet_list",
  "toolbar.ordered_list",
  "toolbar.blockquote",
  "toolbar.indent",
  "toolbar.outdent",
  "toolbar.undo",
  "toolbar.redo",
];

describe("Editors without panel authoring", () => {
  it("keep the toolbar they had", async () => {
    await mount({});
    expect(titles()).toEqual(MAIN_TOOLBAR);
  });

  it("keep the layer panel's footnote button where it was", async () => {
    await mount({ enableFootnotes: true });
    expect(titles()).toEqual([...MAIN_TOOLBAR.slice(0, 4), "footnote.button", ...MAIN_TOOLBAR.slice(4)]);
  });

  it("run Bold on click only; a key press on the button does nothing of its own", async () => {
    const view = await mount({}, "Alpha beta.");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const bold = screen.getByTitle("toolbar.bold");
    fireEvent.keyDown(bold, { key: "Enter" });
    fireEvent.keyDown(bold, { key: " " });
    expect(view.state.doc.toString()).toBe("Alpha beta.");
    fireEvent.click(bold, { detail: 0 });
    expect(view.state.doc.toString()).toBe("**Alpha** beta.");
  });
});

describe("Panel authoring buttons", () => {
  it("sit after the footnote button", async () => {
    await mount({ enableFootnotes: true, enablePanelAuthoring: true });
    expect(titles().slice(4, 8)).toEqual(["footnote.button", "panel.bibliography", "panel.widget", "panel.math"]);
  });

  it.each([
    ["a pointer press", (b: HTMLElement) => (fireEvent.mouseDown(b), fireEvent.click(b, { detail: 1 }))],
    ["a keyboard activation", (b: HTMLElement) => fireEvent.click(b, { detail: 0 })],
    ["a screen reader's activate", (b: HTMLElement) => (fireEvent.mouseDown(b, { detail: 0 }), fireEvent.click(b, { detail: 0 }))],
  ])("insert one bibliography on %s, and none on a key press alone", async (_how, activate) => {
    const view = await mount({ enablePanelAuthoring: true });
    const button = screen.getByTitle("panel.bibliography");
    fireEvent.keyDown(button, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("Alpha.");
    await act(async () => {
      activate(button);
    });
    expect(view.state.doc.toString().match(/:::bibliography/g)).toHaveLength(1);
  });

  it("offer accordion, tabs, carousel and a glossary callout in the Widget menu", async () => {
    const view = await mount({ enablePanelAuthoring: true });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await act(async () => {
      fireEvent.click(screen.getByTitle("panel.widget"), { detail: 0 });
    });
    const items = [...document.querySelectorAll(".cm-panel-menu button")].map((b) => b.textContent);
    expect(items).toEqual(["panel.accordion", "panel.tabs", "panel.carousel", "panel.glossary"]);
    await act(async () => {
      fireEvent.click(screen.getByText("panel.carousel"), { detail: 0 });
    });
    expect(view.state.doc.toString()).toBe("Alpha.\n\n:::carousel\nimage: \nalt: \ncaption: \ncredit: \n:::\n\n");
    expect(document.querySelector(".cm-panel-menu")).toBeNull();
  });
});

/** A collaborative editor on `text` whose project's glossary holds `entries`. */
async function mountWithGlossary(text: string, entries: Array<{ term_id: string; title: string }>) {
  const ydoc = new Y.Doc();
  const glossary = ydoc.getArray<Y.Map<unknown>>("glossary");
  for (const entry of entries) glossary.push([new Y.Map(Object.entries(entry))]);
  const yText = ydoc.getText("content");
  yText.insert(0, text);
  collab.ydoc = ydoc;
  collab.undoManager = new Y.UndoManager(yText);
  const view = await mount({ enablePanelAuthoring: true, yText }, text);
  return { view, yText, undoManager: collab.undoManager as Y.UndoManager };
}

async function openCalloutDialog() {
  await act(async () => {
    fireEvent.click(screen.getByTitle("panel.widget"), { detail: 0 });
  });
  await act(async () => {
    fireEvent.click(screen.getByText("panel.glossary"), { detail: 0 });
  });
}

describe("The glossary callout", () => {
  const entries = [
    { term_id: "loom", title: "Loom" },
    { term_id: "iiif", title: "IIIF" },
  ];

  it("is chosen from the glossary's entries, searched as the glossary link's are, on the right unless left is chosen", async () => {
    const { view } = await mountWithGlossary("Alpha.", entries);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await openCalloutDialog();
    expect(document.querySelector(".cm-panel-menu")).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
    const insert = screen.getByText("panel.glossaryInsert") as HTMLButtonElement;
    expect(insert.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("search_terms_placeholder"), { target: { value: "LO" } });
    expect(screen.queryByText("IIIF")).toBeNull();
    fireEvent.click(screen.getByText("Loom"));
    expect((screen.getByLabelText("panel.glossaryRight") as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(insert);
    });
    expect(view.state.doc.toString()).toBe("Alpha.\n\n:::glossary\nentry: loom\n:::\n\n");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("writes align: left for the left, at the caret, as one undo step", async () => {
    const { view, yText, undoManager } = await mountWithGlossary("Alpha.\n\nOmega.", entries);
    view.dispatch({ selection: { anchor: 6 } });
    await openCalloutDialog();
    fireEvent.click(screen.getByText("IIIF"));
    fireEvent.click(screen.getByLabelText("panel.glossaryLeft"));
    await act(async () => {
      fireEvent.click(screen.getByText("panel.glossaryInsert"));
    });
    expect(yText.toString()).toBe("Alpha.\n\n:::glossary\nentry: iiif\nalign: left\n:::\n\n\n\nOmega.");
    undoManager.undo();
    expect(yText.toString()).toBe("Alpha.\n\nOmega.");
  });

  it("inserts nothing when the dialog is cancelled", async () => {
    const { view } = await mountWithGlossary("Alpha.", entries);
    await openCalloutDialog();
    fireEvent.click(screen.getByText("Loom"));
    await act(async () => {
      fireEvent.click(screen.getByText("common:cancel"));
    });
    expect(view.state.doc.toString()).toBe("Alpha.");
  });
});

describe("Math in the collaborative editor", () => {
  it("is its own undo step, apart from the typing before it", async () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText("content");
    yText.insert(0, "Alpha.");
    const undoManager = new Y.UndoManager(yText);
    collab.ydoc = ydoc;
    collab.undoManager = undoManager;
    const view = await mount({ enablePanelAuthoring: true, yText });
    view.dispatch({ changes: { from: 5, insert: " more" }, selection: { anchor: 10 }, userEvent: "input.type" });
    await act(async () => {
      fireEvent.click(screen.getByTitle("panel.math"), { detail: 0 });
    });
    expect(yText.toString()).toBe("Alpha more$x^2$.");
    undoManager.undo();
    expect(yText.toString()).toBe("Alpha more.");
  });
});

describe("The older-framework notice", () => {
  const config = (siteVersion: string | null, olderFramework: boolean) => ({
    ...parsePanelPreviewConfig(null, null),
    siteVersion,
    olderFramework,
  });

  it("shows above a panel's content on an older site, with the way to upgrade", () => {
    render(<PanelPreviewNotice preview={config("1.7.1", true)} />);
    expect(screen.getByText(/panel\.olderFramework$/)).toBeTruthy();
    expect(screen.getByText("panel.olderFrameworkLink")).toBeTruthy();
  });

  it.each([
    ["a current site", config("1.8.0", false)],
    ["an unknown version", config(null, false)],
  ])("does not show for %s", (_what, preview) => {
    render(<PanelPreviewNotice preview={preview} />);
    expect(screen.queryByText("panel.olderFrameworkLink")).toBeNull();
  });

  it("is not the editor's to show: a panel editor on an older site shows none", async () => {
    await mount({ enablePanelAuthoring: true, panelPreview: config("1.7.1", true) });
    expect(screen.queryByText("panel.olderFrameworkLink")).toBeNull();
  });
});
