/**
 * @vitest-environment jsdom
 *
 * The markdown editor ignores an image insert with an empty address. Written
 * into a carousel's image field it would erase the image the author had, and
 * written into the prose it would be `![alt]()`. The editor is the real
 * MarkdownEditor, mounted as panel-field-toolbar.test.tsx mounts it, with the
 * image dialog replaced by one that records the insert callback it is given.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(() => Promise.resolve()) }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: null, provider: null, isPublishing: false, undoManager: null }),
}));

const { dialog } = vi.hoisted(() => ({
  dialog: { open: false, onInsert: null as null | ((url: string, alt: string) => void) },
}));
vi.mock("~/components/ui/markdown-editor/ImageInsertDialog", () => ({
  ImageInsertDialog: (props: { open: boolean; onInsert: (url: string, alt: string) => void }) => {
    dialog.open = props.open;
    dialog.onInsert = props.onInsert;
    return null;
  },
}));

import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { editPanelBlock } from "~/components/ui/markdown-editor/panelAuthoring";

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const CAROUSEL = "Prose before.\n\n:::carousel\nimage: a.jpg\ncaption: A caption here\n:::\n\nProse after.";

afterEach(() => {
  cleanup();
  dialog.open = false;
  dialog.onInsert = null;
});

async function mount(doc: string): Promise<EditorView> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      <MarkdownEditor initialValue={doc} fieldName="content" projectId={1} alwaysShowToolbar enablePanelAuthoring />,
    ));
  });
  return EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement)!;
}

async function insert(url: string): Promise<void> {
  expect(dialog.open).toBe(true);
  await act(async () => {
    dialog.onInsert!(url, "A map");
  });
}

describe("an image insert with an empty address", () => {
  it("leaves a carousel's image field as it was", async () => {
    const view = await mount(CAROUSEL);
    await act(async () => {
      view.dispatch({ selection: { anchor: 0 } });
    });
    await act(async () => {
      view.dispatch({ effects: editPanelBlock.of({ from: CAROUSEL.indexOf(":::"), mode: "edit" }) });
    });
    const pick = [...document.querySelectorAll(".cm-panel-fields button")].find((b) => b.textContent === "toolbar.image")!;
    await act(async () => {
      fireEvent.click(pick);
    });
    await insert("");
    expect(view.state.doc.toString()).toBe(CAROUSEL);
  });

  it("writes nothing into the prose", async () => {
    const view = await mount("Prose.");
    await act(async () => {
      view.dispatch({ selection: { anchor: "Prose.".length } });
    });
    await act(async () => {
      const button = screen.getByTitle("toolbar.image");
      fireEvent.mouseDown(button);
      fireEvent.click(button, { detail: 1 });
    });
    await insert("");
    expect(view.state.doc.toString()).toBe("Prose.");
  });
});
