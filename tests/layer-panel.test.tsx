// @vitest-environment jsdom
/**
 * layer-panel.test.tsx — what a layer panel on the stage holds (LayerPanel):
 * the heading holding the title edited in place and its pencil, the content
 * editor, and on layer 1 layer 2's button or the button that adds it.
 *
 * The panel's frame (Back, close, delete, where it stands) is StagePanels',
 * tested mounted in stage-panels.test.tsx with the fields' saves; here the
 * saves are the `fields` a test hands in.
 *
 * Note: MarkdownEditor (CodeMirror) is mocked to avoid jsdom layout limitations.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createRef } from "react";
import { LayerPanel, type LayerFieldSaves } from "~/components/features/editor/LayerPanel";
import type { StagePanelLayer } from "~/components/features/editor/StagePanels";
import { resetTargetSaves } from "~/components/ui/target-saves";
import { LayerContentDrafts } from "~/hooks/use-layer-content-drafts";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

/** An awareness that holds this client's local state, as y-protocols' does. */
function awarenessStub() {
  let state: Record<string, unknown> = { location: { route: "/stories/s", storyId: "s", fieldKey: null } };
  return {
    getLocalState: () => state,
    setLocalStateField: (field: string, value: unknown) => {
      state = { ...state, [field]: value };
    },
  };
}
const collab: { provider: { awareness: ReturnType<typeof awarenessStub> } | null } = { provider: null };

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: collab.provider,
    isPublishing: false,
    undoManager: null,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
}));

vi.mock("~/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: ({
    enableFootnotes,
    enablePanelAuthoring,
    dismissed,
    mode,
    initialValue,
    onChange,
  }: {
    enableFootnotes?: boolean;
    enablePanelAuthoring?: boolean;
    dismissed?: boolean;
    mode?: string;
    initialValue: string;
    onChange?: (value: string) => void;
  }) => (
    <div
      data-testid="markdown-editor"
      data-footnotes={String(!!enableFootnotes)}
      data-panels={String(!!enablePanelAuthoring)}
      data-dismissed={String(!!dismissed)}
      data-mode={mode}
      data-value={initialValue}
      onClick={() => onChange?.("typed")}
    />
  ),
}));

function layer(n: 1 | 2, over: Partial<StagePanelLayer> = {}): StagePanelLayer {
  return {
    key: `L${n}`,
    id: n,
    layer_number: n,
    title: n === 1 ? "Weaving Techniques" : null,
    button_label: n === 1 ? "Learn more" : "Go further",
    content: "Some content",
    titleYText: null,
    contentYText: null,
    buttonLabelYText: null,
    canDelete: true,
    ...over,
  };
}

const save = vi.fn<LayerFieldSaves["save"]>(() => Promise.resolve(undefined));
const fields: LayerFieldSaves = {
  save,
  fresh: (_layer, _field, value) => value,
  recoveryKey: () => undefined,
  saveErrorMessage: "stage.save_failed",
};

const contentSend = vi.fn(() => Promise.resolve(undefined as number | undefined));
const contentDrafts = new LayerContentDrafts({ projectId: 1, storyKey: "s" }, contentSend, {
  debounceMs: 1500,
  errorMessage: () => "stage.save_failed",
});

const glossary = { terms: new Map<string, string>(), baseUrl: "" };
const props = { fields, contentDrafts, glossary, objects: [], actionUrl: "/stories/test-story", siteLang: "en" };

beforeEach(() => {
  collab.provider = null;
  vi.clearAllMocks();
  resetTargetSaves();
});

const heading = () => document.querySelector("h1.offcanvas-title") as HTMLHeadingElement;
const titleBlock = () => heading().querySelector(":scope > [data-in-place]") as HTMLElement;

describe("LayerPanel: the heading", () => {
  it("is h1.offcanvas-title, focusable by script only, holding the title's block and its pencil", () => {
    const ref = createRef<HTMLHeadingElement>();
    render(<LayerPanel {...props} layer={layer(1)} headingRef={ref} />);
    expect(ref.current).toBe(heading());
    expect(heading().tabIndex).toBe(-1);
    expect(titleBlock().textContent).toBe("Weaving Techniques");
    expect(titleBlock().getAttribute("aria-label")).toBe("layer.panel_title_aria");
    const pencil = heading().querySelector(":scope > .stage-field-pencil > [data-in-place]") as HTMLElement;
    expect(pencil.getAttribute("aria-label")).toBe("stage.edit_panel_title");
  });

  it("saves an edited title through the fields' save, for its own layer", async () => {
    render(<LayerPanel {...props} layer={layer(1)} />);
    fireEvent.click(titleBlock());
    const input = heading().querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Looms" } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ key: "L1" }), "title", "Looms");
  });
});

describe("LayerPanel: the content", () => {
  it("is drawn as the site renders it, and opens into the Markdown editor, controlled by the stage's owner", () => {
    const { rerender } = render(<LayerPanel {...props} layer={layer(1)} />);
    const content = document.querySelector("[data-panel-content]") as HTMLElement;
    expect(content.querySelector("[data-panel-prose]")!.innerHTML.trim()).toBe("<p>Some content</p>");
    expect(content.getAttribute("aria-label")).toBe("stage.edit_panel_text");
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    fireEvent.click(content.querySelector("p")!);
    const editor = screen.getByTestId("markdown-editor");
    expect(editor.dataset.footnotes).toBe("true");
    expect(editor.dataset.panels).toBe("true");
    expect(editor.dataset.mode).toBe("controlled");
    expect(editor.dataset.value).toBe("Some content");
    expect(editor.dataset.dismissed).toBe("false");
    // Covered: the editor closes and the rendered content is back.
    rerender(<LayerPanel {...props} layer={layer(1)} dismissed />);
    expect(screen.queryByTestId("markdown-editor")).toBeNull();
    expect(document.querySelector("[data-panel-content]")).not.toBeNull();
  });
});

describe("LayerPanel: layer 2's button at the end of layer 1's content", () => {
  it("shows layer 2's label, and opens layer 2 from the button pressed", () => {
    const onOpenLayer2 = vi.fn();
    render(<LayerPanel {...props} layer={layer(1)} layer2={layer(2)} onOpenLayer2={onOpenLayer2} />);
    const pill = document.querySelector("[data-layer2-pill]") as HTMLButtonElement;
    expect(pill.textContent).toBe("Go further →");
    fireEvent.click(pill);
    expect(onOpenLayer2).toHaveBeenCalledWith(pill);
  });

  it("shows the site language's default label where layer 2 has none", () => {
    render(<LayerPanel {...props} siteLang="es" layer={layer(1)} layer2={layer(2, { button_label: null })} />);
    expect(document.querySelector("[data-layer2-pill]")!.textContent).toBe("Profundizar →");
  });

  it("saves an edited label to layer 2, not to layer 1", async () => {
    render(<LayerPanel {...props} layer={layer(1)} layer2={layer(2)} />);
    fireEvent.click(screen.getByRole("button", { name: "layer.edit_button_label_aria" }));
    const input = document.querySelector(".stage-panel-next input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Deeper" } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ key: "L2", id: 2 }), "button_label", "Deeper");
  });

  it("offers the button that adds layer 2 where there is none, and calls onCreateLayer2", () => {
    const onCreateLayer2 = vi.fn();
    render(<LayerPanel {...props} layer={layer(1)} onCreateLayer2={onCreateLayer2} />);
    expect(document.querySelector("[data-layer2-pill]")).toBeNull();
    fireEvent.click(screen.getByText("layer.add_further_panel"));
    expect(onCreateLayer2).toHaveBeenCalledTimes(1);
  });

  it("shows neither on layer 2's own panel", () => {
    render(<LayerPanel {...props} layer={layer(2)} />);
    expect(screen.queryByText("layer.add_further_panel")).toBeNull();
    expect(document.querySelector("[data-layer2-pill]")).toBeNull();
  });
});

describe("LayerPanel: the title's presence", () => {
  const fieldKeyNow = () => (collab.provider!.awareness.getLocalState().location as { fieldKey: string | null }).fieldKey;

  it("says this author is in the title while its field is open, and clears it when the field is finished with Escape", () => {
    collab.provider = { awareness: awarenessStub() };
    render(<LayerPanel {...props} layer={layer(1)} />);
    fireEvent.click(titleBlock());
    const input = heading().querySelector("input") as HTMLInputElement;
    fireEvent.focus(input);
    expect(fieldKeyNow()).toBe("layer-L1-title");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(heading().querySelector("input")).toBeNull();
    expect(fieldKeyNow()).toBeNull();
  });

  it("clears it when the panel goes with the field open", () => {
    collab.provider = { awareness: awarenessStub() };
    const { unmount } = render(<LayerPanel {...props} layer={layer(1)} />);
    fireEvent.click(titleBlock());
    fireEvent.focus(heading().querySelector("input")!);
    unmount();
    expect(fieldKeyNow()).toBeNull();
  });

  it("leaves another field's presence alone when the title's field goes after it", () => {
    collab.provider = { awareness: awarenessStub() };
    const { unmount } = render(<LayerPanel {...props} layer={layer(1)} />);
    fireEvent.click(titleBlock());
    fireEvent.focus(heading().querySelector("input")!);
    collab.provider.awareness.setLocalStateField("location", { route: "/stories/s", storyId: "s", fieldKey: "step-s-1-question" });
    unmount();
    expect(fieldKeyNow()).toBe("step-s-1-question");
  });
});
