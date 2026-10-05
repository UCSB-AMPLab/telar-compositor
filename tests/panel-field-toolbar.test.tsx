/**
 * @vitest-environment jsdom
 *
 * panel-field-toolbar.test.tsx — with a widget field focused, the
 * layer panel editor's toolbar acts on that field at the field's own caret,
 * not on the panel's selection, which stays wherever the author last left it
 * in the prose; and a footnote reference written in a field is drawn as its
 * number there. The editor is the real MarkdownEditor, mocked as
 * footnote-button.test.tsx mocks it, with a widget box opened for editing.
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

import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { editPanelBlock } from "~/components/ui/markdown-editor/panelAuthoring";

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const LABEL = "[a-hjkmnp-z][a-hjkmnp-z2-9]{3}";
const CAROUSEL = "Prose before.\n\n:::carousel\nimage: a.jpg\ncaption: A caption here\n:::\n\nProse after.";
const ACCORDION = "Prose before.\n\n:::accordion\n## One\nFirst text.\n\n## Two\nSecond text.\n:::\n\nProse after.";

afterEach(() => {
  cleanup();
});

/** Mounts the editor with the panel's selection on "Prose" and the first box open. */
async function mountEditing(doc: string): Promise<EditorView> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      <MarkdownEditor
        initialValue={doc}
        fieldName="content"
        projectId={1}
        alwaysShowToolbar
        enableFootnotes
        enablePanelAuthoring
      />,
    ));
  });
  const view = EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement)!;
  // The selection first: moving it out of an open box closes the box.
  await act(async () => {
    view.dispatch({ selection: { anchor: 0, head: 5 } });
  });
  await act(async () => {
    view.dispatch({ effects: editPanelBlock.of({ from: doc.indexOf(":::"), mode: "edit" }) });
  });
  return view;
}

function input(label: string): HTMLInputElement {
  const found = [...document.querySelectorAll(".cm-panel-fields label")].find((l) =>
    l.textContent?.startsWith(label),
  );
  return found!.querySelector("input")!;
}

async function focusInput(label: string, from: number, to = from): Promise<HTMLInputElement> {
  const field = input(label);
  await act(async () => {
    field.focus();
    field.setSelectionRange(from, to);
  });
  return field;
}

function nestedField(index: number): EditorView {
  const content = document.querySelectorAll(".cm-panel-field .cm-content")[index] as HTMLElement;
  return EditorView.findFromDOM(content)!;
}

async function focusNested(index: number, anchor: number, head = anchor): Promise<EditorView> {
  const nested = nestedField(index);
  await act(async () => {
    nested.dispatch({ selection: { anchor, head } });
    fireEvent.focus(nested.contentDOM);
  });
  return nested;
}

async function press(title: string): Promise<void> {
  await act(async () => {
    const button = screen.getByTitle(title);
    fireEvent.mouseDown(button);
    fireEvent.click(button, { detail: 1 });
  });
}

async function writeNote(text: string): Promise<void> {
  const dialog = screen.getByRole("dialog", { name: "footnote.button" });
  await act(async () => {
    fireEvent.change(dialog.querySelector("textarea")!, { target: { value: text } });
  });
  await act(async () => {
    fireEvent.click(screen.getByText("link_popover.insert"));
  });
}

describe("the toolbar acts on the focused widget field", () => {
  it("bolds the selection in a carousel caption, not the panel's selection", async () => {
    const view = await mountEditing(CAROUSEL);
    await focusInput("panel.caption", 2, 9);
    await press("toolbar.bold");
    expect(view.state.doc.toString()).toBe(CAROUSEL.replace("A caption here", "A **caption** here"));
  });

  it("writes a formula at a carousel caption's caret", async () => {
    const view = await mountEditing(CAROUSEL);
    await focusInput("panel.caption", 10);
    await press("panel.math");
    expect(view.state.doc.toString()).toBe(CAROUSEL.replace("A caption here", "A caption $x^2$here"));
  });

  it("does not format a field published as plain text", async () => {
    const view = await mountEditing(CAROUSEL);
    await focusInput("panel.image", 0, 1);
    await press("toolbar.bold");
    expect(view.state.doc.toString()).toBe(CAROUSEL);
  });

  it("refuses a footnote in a carousel caption, which the framework converts without footnotes", async () => {
    const view = await mountEditing(CAROUSEL);
    await focusInput("panel.caption", 2);
    await press("footnote.button");
    expect(screen.getByRole("alert").textContent).toBe("footnote.not_here");
    expect(view.state.doc.toString()).toBe(CAROUSEL);
  });

  it("inserts a footnote at a section's caret, with its definition at the end of the section", async () => {
    const view = await mountEditing(ACCORDION);
    // The caret moves after focus, as arrow keys move it: the panel's own
    // selection was set when the field took focus and no longer matches.
    const nested = await focusNested(0, 0);
    await act(async () => {
      nested.dispatch({ selection: { anchor: "First".length } });
    });
    await press("footnote.button");
    await writeNote("Note");
    expect(view.state.doc.toString()).toMatch(
      new RegExp(
        `^Prose before\\.\\n\\n:::accordion\\n## One\\nFirst\\[\\^(${LABEL})\\] text\\.\\n\\n\\[\\^\\1\\]: Note\\n\\n## Two\\nSecond text\\.\\n:::\\n\\nProse after\\.$`,
      ),
    );
  });

  it("bolds the selection in a section's own editor", async () => {
    const view = await mountEditing(ACCORDION);
    await focusNested(1, 0, "Second".length);
    await press("toolbar.bold");
    expect(view.state.doc.toString()).toBe(ACCORDION.replace("Second text.", "**Second** text."));
  });

  it("returns to the prose once the panel's text takes focus again", async () => {
    const view = await mountEditing(ACCORDION);
    await focusNested(1, 0, "Second".length);
    await act(async () => {
      view.dispatch({ selection: { anchor: 0, head: 5 } });
      fireEvent.focus(view.contentDOM);
    });
    await press("toolbar.bold");
    expect(view.state.doc.toString()).toBe(ACCORDION.replace("Prose before.", "**Prose** before."));
  });
});

describe("a note in a widget field is drawn as a note", () => {
  it("shows a section's reference as its number in the section's editor", async () => {
    const doc = ":::accordion\n## One\nFirst[^a] text[^b].\n\n[^b]: Second note\n[^a]: First note\n\n## Two\nMore.\n:::";
    await mountEditing(doc);
    const marks = [...nestedField(0).contentDOM.querySelectorAll(".cm-panel-reference")].map((m) => m.textContent);
    expect(marks).toEqual(["1", "2"]);
  });
});

describe("A focused field that goes away", () => {
  /** Deletes the carousel, as a collaborator's edit or an undo would. */
  async function removeCarousel(view: EditorView): Promise<string> {
    const from = CAROUSEL.indexOf(":::");
    const to = CAROUSEL.lastIndexOf(":::") + 3;
    await act(async () => {
      view.dispatch({ changes: { from, to, insert: "" } });
    });
    return view.state.doc.toString();
  }

  it.each([["toolbar.bold"], ["panel.math"]])("leaves the prose alone on %s", async (title) => {
    const view = await mountEditing(CAROUSEL);
    await focusInput("panel.caption", 2, 9);
    const after = await removeCarousel(view);
    await press(title);
    expect(view.state.doc.toString()).toBe(after);
  });

  it("refuses a footnote until the author puts the caret somewhere", async () => {
    const view = await mountEditing(CAROUSEL);
    await focusInput("panel.caption", 2);
    const after = await removeCarousel(view);
    await press("footnote.button");
    expect(screen.getByRole("alert").textContent).toBe("footnote.not_here");
    expect(view.state.doc.toString()).toBe(after);
  });

  it("marks Bold, Italic and Math disabled, and says why when one is pressed", async () => {
    const view = await mountEditing(CAROUSEL);
    await focusInput("panel.caption", 2, 9);
    const after = await removeCarousel(view);
    for (const title of ["toolbar.bold", "toolbar.italic", "panel.math"])
      expect(screen.getByTitle(title).getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByText("panel.fieldGone")).toBeNull();
    await press("toolbar.italic");
    expect(screen.getByRole("alert").textContent).toBe("panel.fieldGone");
    expect(view.state.doc.toString()).toBe(after);
    await act(async () => {
      fireEvent.focus(view.contentDOM);
    });
    expect(screen.queryByText("panel.fieldGone")).toBeNull();
    expect(screen.getByTitle("toolbar.bold").getAttribute("aria-disabled")).toBeNull();
  });

  it("gives the toolbar back to the prose once the prose takes focus", async () => {
    const view = await mountEditing(CAROUSEL);
    await focusInput("panel.caption", 2, 9);
    const after = await removeCarousel(view);
    await act(async () => {
      view.dispatch({ selection: { anchor: 0, head: 5 } });
      fireEvent.focus(view.contentDOM);
    });
    await press("toolbar.bold");
    expect(view.state.doc.toString()).toBe(after.replace("Prose before.", "**Prose** before."));
  });
});

describe("A focused field whose structure changes before it is redrawn", () => {
  /** A collaborator's edit and a Bold press, before React redraws the box. */
  async function editThenBold(view: EditorView, from: number, to: number, insert: string): Promise<void> {
    await act(async () => {
      view.dispatch({ changes: { from, to, insert } });
      const button = screen.getByTitle("toolbar.bold");
      fireEvent.mouseDown(button);
      fireEvent.click(button, { detail: 1 });
    });
  }

  it("does not format a caption whose key was renamed to alt", async () => {
    const view = await mountEditing(CAROUSEL);
    await focusInput("panel.caption", 2, 9);
    const key = CAROUSEL.indexOf("caption:");
    await editThenBold(view, key, key + "caption".length, "alt");
    expect(view.state.doc.toString()).toBe(CAROUSEL.replace("caption: A caption here", "alt: A caption here"));
  });

  it("does not format a section whose heading became prose", async () => {
    const view = await mountEditing(ACCORDION);
    await focusNested(1, 0, "Second".length);
    const heading = ACCORDION.indexOf("## Two");
    await editThenBold(view, heading, heading + 3, "");
    expect(view.state.doc.toString()).toBe(ACCORDION.replace("## Two", "Two"));
  });
});
