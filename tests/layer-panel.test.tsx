// @vitest-environment jsdom
/**
 * layer-panel.test.tsx — Component tests for LayerPanel.
 *
 * Tests panel rendering, canDelete logic, layer 2 creation button visibility,
 * and delete confirmation.
 *
 * Note: MarkdownEditor (CodeMirror) is mocked to avoid jsdom layout limitations.
 * useFetcher is mocked since LayerPanel uses autosave.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LayerPanel } from "~/components/features/editor/LayerPanel";

// ---------------------------------------------------------------------------
// Mock react-i18next
// ---------------------------------------------------------------------------
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

// ---------------------------------------------------------------------------
// Mock react-router useFetcher
// ---------------------------------------------------------------------------
const { submitMock } = vi.hoisted(() => ({ submitMock: vi.fn() }));
vi.mock("react-router", () => ({
  useFetcher: () => ({
    submit: submitMock,
    data: null,
    state: "idle",
  }),
}));

// ---------------------------------------------------------------------------
// Mock MarkdownEditor — avoids CodeMirror's need for real DOM layout
// ---------------------------------------------------------------------------
vi.mock("~/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: () => (
    <div data-testid="markdown-editor">Mock editor</div>
  ),
}));

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const baseLayer = {
  id: 1,
  layer_number: 1,
  title: "Weaving Techniques",
  button_label: "Learn more",
  content: "Some content",
};

const defaultProps = {
  layer: baseLayer,
  open: true,
  onClose: vi.fn(),
  onDelete: vi.fn(),
  canDelete: true,
  hasLayer2: false,
  objects: [],
  actionUrl: "/stories/test-story",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LayerPanel: basic rendering", () => {
  it("renders panel title input with layer's title value", () => {
    render(<LayerPanel {...defaultProps} />);
    const input = screen.getByRole("textbox", { name: /panel_title/i });
    expect(input).toBeDefined();
    expect((input as HTMLInputElement).value).toBe("Weaving Techniques");
  });

  it("renders close button", () => {
    render(<LayerPanel {...defaultProps} />);
    const closeBtn = screen.getByRole("button", { name: /close_panel/i });
    expect(closeBtn).toBeDefined();
  });

  it("renders the MarkdownEditor", () => {
    render(<LayerPanel {...defaultProps} />);
    expect(screen.getByTestId("markdown-editor")).toBeDefined();
  });

  it("slide-in panel has translate-x-0 when open", () => {
    render(<LayerPanel {...defaultProps} open={true} />);
    const panel = document.querySelector(".translate-x-0");
    expect(panel).not.toBeNull();
  });

  it("panel has translate-x-full when closed", () => {
    render(<LayerPanel {...defaultProps} open={false} />);
    const panel = document.querySelector(".translate-x-full");
    expect(panel).not.toBeNull();
  });

  it("calls onClose directly when close button is clicked", () => {
    const onClose = vi.fn();
    render(<LayerPanel {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close_panel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("LayerPanel: canDelete", () => {
  it("shows delete button when canDelete is true", () => {
    render(<LayerPanel {...defaultProps} canDelete={true} />);
    const deleteBtn = screen.getByRole("button", { name: /layer.delete_title/i });
    expect(deleteBtn).toBeDefined();
  });

  it("shows delete button as disabled when canDelete is false", () => {
    render(<LayerPanel {...defaultProps} canDelete={false} />);
    const deleteBtn = screen.getByRole("button", { name: /layer.delete_title/i });
    // Delete buttons are visible but disabled with a tooltip so the
    // permission system is discoverable rather than hidden.
    expect(deleteBtn).toBeDefined();
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows 'Open second panel' button in layer 1 when hasLayer2 is true", () => {
    render(
      <LayerPanel
        {...defaultProps}
        layer={{ ...baseLayer, layer_number: 1 }}
        hasLayer2={true}
        onOpenLayer2={vi.fn()}
      />
    );
    expect(screen.getByText("layer.default_label_2")).toBeDefined();
  });

  it("does not show 'Open second panel' button when hasLayer2 is false", () => {
    render(
      <LayerPanel
        {...defaultProps}
        layer={{ ...baseLayer, layer_number: 1 }}
        hasLayer2={false}
      />
    );
    expect(screen.queryByText("layer.default_label_2")).toBeNull();
  });
});

describe("LayerPanel: layer 2 creation button", () => {
  it("shows 'Add panel' button for layer 1 when layer 2 does not exist", () => {
    render(
      <LayerPanel
        {...defaultProps}
        layer={{ ...baseLayer, layer_number: 1 }}
        hasLayer2={false}
      />
    );
    expect(screen.getByText("layer.add_further_panel")).toBeDefined();
  });

  it("does not show 'Add panel' button when layer 2 already exists", () => {
    render(
      <LayerPanel
        {...defaultProps}
        layer={{ ...baseLayer, layer_number: 1 }}
        hasLayer2={true}
      />
    );
    expect(screen.queryByText("layer.add_further_panel")).toBeNull();
  });

  it("does not show 'Add panel' button for layer 2 panels", () => {
    render(
      <LayerPanel
        {...defaultProps}
        layer={{ ...baseLayer, layer_number: 2 }}
        hasLayer2={false}
      />
    );
    expect(screen.queryByText("layer.add_further_panel")).toBeNull();
  });

  it("calls onCreateLayer2 when 'Add panel' is clicked", () => {
    const onCreateLayer2 = vi.fn();
    render(
      <LayerPanel
        {...defaultProps}
        layer={{ ...baseLayer, layer_number: 1 }}
        hasLayer2={false}
        onCreateLayer2={onCreateLayer2}
      />
    );
    fireEvent.click(screen.getByText("layer.add_further_panel"));
    expect(onCreateLayer2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Breadcrumb + button-label field
//
// The panel shows a breadcrumb (`Story / Step N / Layer M`) at the top and a
// button-label field that edits the CURRENT layer's button_label Y.Text via
// the panel's writeYText. The field was originally a tinted "pinned strip"
// above the Title; a later UX pass moved it BELOW the Title and styled it like
// the other labelled fields (no tinted box). Under the identity t() mock, the
// breadcrumb keys surface as raw keys (`breadcrumb.step`, `breadcrumb.layer`)
// and the field label as `layer.button_label_strip_label`.
// ---------------------------------------------------------------------------

describe("LayerPanel: breadcrumb + button-label field", () => {
  it("renders a breadcrumb 'Story / Step N / Layer M' at the top of the panel", () => {
    render(<LayerPanel {...defaultProps} stepNumber={3} />);
    // Identity t() mock surfaces the interpolated keys as raw keys.
    expect(screen.getByText("breadcrumb.step")).toBeDefined();
    expect(screen.getByText("breadcrumb.layer")).toBeDefined();
  });

  it("renders the button-label field label", () => {
    render(<LayerPanel {...defaultProps} />);
    expect(screen.getAllByText("layer.button_label_strip_label").length).toBeGreaterThan(0);
  });

  it("renders the button label as a plain field (no tinted strip box)", () => {
    render(<LayerPanel {...defaultProps} layer={{ ...baseLayer, layer_number: 1 }} />);
    expect(document.querySelector(".bg-anil-pale")).toBeNull();
    expect(document.querySelector(".bg-terracotta-pale")).toBeNull();
  });

  it("seeds the button-label input with the layer's current button_label", () => {
    render(<LayerPanel {...defaultProps} layer={{ ...baseLayer, button_label: "Learn more" }} />);
    const strip = screen.getByRole("textbox", { name: /button_label_strip_label/i });
    expect((strip as HTMLInputElement).value).toBe("Learn more");
  });
});

describe("LayerPanel: delete confirmation", () => {
  it("shows delete confirmation dialog when delete button clicked", () => {
    render(<LayerPanel {...defaultProps} canDelete={true} />);
    fireEvent.click(screen.getByRole("button", { name: /layer.delete_title/i }));
    expect(screen.getByText("layer.delete_body")).toBeDefined();
  });

  it("calls onDelete when delete is confirmed", () => {
    const onDelete = vi.fn();
    render(<LayerPanel {...defaultProps} canDelete={true} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /layer.delete_title/i }));
    fireEvent.click(screen.getByText("layer.delete_confirm"));
    expect(onDelete).toHaveBeenCalledWith(baseLayer.id);
  });

  it("does not call onDelete when cancel is clicked", () => {
    const onDelete = vi.fn();
    render(<LayerPanel {...defaultProps} canDelete={true} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /layer.delete_title/i }));
    fireEvent.click(screen.getByText("layer.delete_cancel"));
    expect(onDelete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-persistable id guard
//
// A Yjs-only layer (not yet snapshotted to D1) carries `_id = null`, which the
// loader coerces to `0`. With no collaboration provider, useCollaborationContext
// returns the default `{ ydoc: null }`, so writeYText returns false and the code
// reaches the D1 fallback — exactly the bug's runtime path. The guard must skip
// the fallback for id 0 (it could never persist) but STILL fire for a real id.
// ---------------------------------------------------------------------------

describe("LayerPanel: non-persistable id guard", () => {
  it("does NOT fire the D1 autosave fallback for a layer with id 0", () => {
    vi.useFakeTimers();
    render(
      <LayerPanel
        {...defaultProps}
        layer={{ ...baseLayer, id: 0 }}
      />
    );
    const input = screen.getByRole("textbox", { name: /panel_title/i });
    fireEvent.change(input, { target: { value: "Renamed" } });
    vi.advanceTimersByTime(1600); // past the 1500ms debounce
    expect(submitMock).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("DOES fire the D1 autosave fallback for a real (positive) layer id", () => {
    submitMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
    render(
      <LayerPanel
        {...defaultProps}
        layer={{ ...baseLayer, id: 5 }}
      />
    );
    const input = screen.getByRole("textbox", { name: /panel_title/i });
    fireEvent.change(input, { target: { value: "Renamed" } });
    vi.advanceTimersByTime(1600);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ layerId: "5", field: "title" }),
      expect.objectContaining({ method: "post" })
    );
    vi.useRealTimers();
  });
});
