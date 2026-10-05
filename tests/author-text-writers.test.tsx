/**
 * @vitest-environment jsdom
 *
 * Each writer that puts an author's text into Markdown syntax, driven as an
 * author drives it: the Link button and its popover, the Image dialog's two
 * tabs, and the glossary button, on the real MarkdownEditor. Each writes the
 * forms authorText.ts states, and each field that reads such text back
 * shows it as the author typed it. The mocking follows
 * footnote-button.test.tsx.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { insertImage, insertLink } from "~/components/ui/markdown-editor/commands";

const { collab } = vi.hoisted(() => ({ collab: { ydoc: null as unknown } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(() => Promise.resolve()) }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: collab.ydoc, provider: null, isPublishing: false, undoManager: null }),
}));

import { MarkdownEditor } from "~/components/ui/MarkdownEditor";

const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const OBJECTS = [
  { object_id: "kogui-loom", title: "Kogui loom", thumbnail: "https://example.org/thumb.jpg", alt_text: "[Marco de un telar kogui]", source_url: null },
  { object_id: "plain", title: "Loom [Telar] ]", thumbnail: "https://example.org/plain.jpg", alt_text: null, source_url: null },
];

beforeEach(() => {
  const ydoc = new Y.Doc();
  const term = new Y.Map<unknown>();
  term.set("term_id", "loom");
  term.set("title", "Loom");
  ydoc.getArray("glossary").push([term]);
  collab.ydoc = ydoc;
});

afterEach(() => cleanup());

function mount(initial: string): { view: EditorView; read: () => string } {
  const { container } = render(
    <MarkdownEditor
      initialValue={initial}
      fieldName="content"
      projectId={1}
      alwaysShowToolbar
      objects={OBJECTS}
      enableGlossaryLinks
    />,
  );
  const content = container.querySelector(".cm-content") as HTMLElement;
  const view = EditorView.findFromDOM(content)!;
  // A focus re-renders the editor, which hands the glossary button its view.
  fireEvent.focus(view.contentDOM);
  return { view, read: () => view.state.doc.toString() };
}

function press(button: HTMLElement): void {
  fireEvent.mouseDown(button);
  fireEvent.click(button, { detail: 1 });
}

function select(view: EditorView, text: string): void {
  const from = view.state.doc.toString().indexOf(text);
  view.dispatch({ selection: { anchor: from, head: from + text.length } });
}

describe("the Link button", () => {
  function link(url: string): void {
    const input = screen.getByPlaceholderText("link_popover.url_placeholder");
    fireEvent.change(input, { target: { value: url } });
    fireEvent.click(screen.getByText("link_popover.insert"));
  }

  it("writes the selection's brackets as the escape states, and encodes the address", () => {
    const { view, read } = mount("See Loom [Telar] ] here.");
    select(view, "Loom [Telar] ]");
    press(screen.getByTitle("toolbar.link"));
    link("https://example.org/wiki/Loom_(weaving) two");
    expect(read()).toBe("See [Loom [Telar] &#93;](https://example.org/wiki/Loom_%28weaving%29%20two) here.");
  });

  it("escapes glossary syntax in the selection and keeps a backslash-escaped bracket", () => {
    const { view, read } = mount("A [[loom]] and \\[x b.");
    select(view, "[[loom]] and \\[x");
    press(screen.getByTitle("toolbar.link"));
    link("https://example.org/");
    expect(read()).toBe("A [&#91;&#91;loom&#93;&#93; and \\[x](https://example.org/) b.");
  });

  it("uses the address as the text when nothing is selected, escaped as plain text", () => {
    const { read } = mount("");
    press(screen.getByTitle("toolbar.link"));
    link("https://example.org/[a");
    expect(read()).toBe("[https://example.org/&#91;a](https://example.org/[a)");
  });

  it("shows a selection holding the escapes' entities as the author typed it", () => {
    const { view } = mount("A Loom &#91;Telar b.");
    select(view, "Loom &#91;Telar");
    press(screen.getByTitle("toolbar.link"));
    expect(screen.getByText("Loom [Telar")).toBeTruthy();
  });
});

describe("the Image dialog", () => {
  it("writes the URL tab's alt text escaped and its address encoded", () => {
    const { read } = mount("");
    press(screen.getByTitle("toolbar.image"));
    fireEvent.change(screen.getByPlaceholderText("image_dialog.url_placeholder"), { target: { value: "maps/my map (1).jpg" } });
    fireEvent.change(screen.getByPlaceholderText("image_dialog.alt_placeholder"), { target: { value: "[Marco de un telar kogui]" } });
    fireEvent.click(screen.getByText("image_dialog.insert"));
    expect(read()).toBe("![&#91;Marco de un telar kogui&#93;](maps/my%20map%20%281%29.jpg)");
  });

  it.each([
    ["an object's alt text", "Kogui loom", "![&#91;Marco de un telar kogui&#93;](https://example.org/thumb.jpg)"],
    ["an object's title, where it has no alt text", "Loom [Telar] ]", "![Loom [Telar] &#93;](https://example.org/plain.jpg)"],
  ])("writes %s escaped from the Objects tab", async (_name, title, written) => {
    const { read } = mount("");
    press(screen.getByTitle("toolbar.image"));
    fireEvent.click(screen.getByText("image_dialog.tab_objects"));
    fireEvent.click(screen.getAllByText(title).at(-1)!);
    await waitFor(() => expect(read()).toBe(written));
  });
});

describe("the glossary button", () => {
  function openOn(view: EditorView, text: string): void {
    select(view, text);
    press(screen.getByTitle("insert_link_button"));
  }

  function customText(): HTMLInputElement {
    return screen.getByPlaceholderText("custom_display_placeholder") as HTMLInputElement;
  }

  function insert(): void {
    fireEvent.click(screen.getByText("loom"));
    const buttons = screen.getAllByText("insert_link_button");
    fireEvent.click(buttons.at(-1)!);
  }

  it("writes a closing bracket and a pipe in the display text as entities", () => {
    const { view, read } = mount("x");
    openOn(view, "x");
    fireEvent.change(customText(), { target: { value: "a ] b | c [d" } });
    insert();
    expect(read()).toBe("[[loom|a &#93; b &#124; c [d]]");
  });

  it("shows the preview of what it inserts in the same form", () => {
    const { view } = mount("x");
    openOn(view, "x");
    fireEvent.change(customText(), { target: { value: "a ] b" } });
    fireEvent.click(screen.getByText("loom"));
    expect(screen.getByText("[[loom|a &#93; b]]")).toBeTruthy();
  });

  it("reads a selection holding the escapes' entities back as the author typed it", () => {
    const { view, read } = mount("see x &#93; y &#124; z &#91;w here");
    openOn(view, "x &#93; y &#124; z &#91;w");
    expect(customText().value).toBe("x ] y | z [w");
    insert();
    expect(read()).toBe("see [[loom|x &#93; y &#124; z [w]] here");
  });

  it("leaves any other entity in the selection as written", () => {
    const { view } = mount("a &amp; &lsqb; b");
    openOn(view, "a &amp; &lsqb; b");
    expect(customText().value).toBe("a &amp; &lsqb; b");
  });
});

describe("the commands, called directly", () => {
  function view(doc: string): EditorView {
    return new EditorView({ doc, parent: document.body });
  }

  it("insertLink escapes text passed to it as Markdown", () => {
    const v = view("");
    insertLink(v, "https://example.org/", "[[loom]]");
    expect(v.state.doc.toString()).toBe("[&#91;&#91;loom&#93;&#93;](https://example.org/)");
    v.destroy();
  });

  it("insertImage escapes the alt text as plain text", () => {
    const v = view("");
    insertImage(v, "a.jpg", "A [b [c]] d");
    expect(v.state.doc.toString()).toBe("![A &#91;b &#91;c&#93;&#93; d](a.jpg)");
    v.destroy();
  });
});
