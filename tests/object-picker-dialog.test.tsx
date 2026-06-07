// @vitest-environment jsdom
/**
 * object-picker-dialog.test.tsx — unit tests for ObjectPickerDialog.
 *
 * Tests: renders object grid with correct count, search filter narrows results,
 * clicking an object calls onSelect with correct object_id, current object
 * is visually highlighted.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ObjectPickerDialog } from "~/components/features/editor/ObjectPickerDialog";

// Mock react-i18next — return key as translation
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key}`;
      return key;
    },
  }),
}));

const testObjects = [
  { object_id: "weavers-of-boyaca", title: "Weavers of Boyacá", thumbnail: null, image_available: true },
  { object_id: "colonial-map", title: "Colonial Map 1720", thumbnail: null, image_available: true },
  { object_id: "gold-chest", title: "Gold Chest", thumbnail: "https://example.com/thumb.jpg", image_available: true },
  { object_id: "no-title-obj", title: null, thumbnail: null, image_available: false },
];

describe("ObjectPickerDialog", () => {
  it("renders object grid with correct item count when open", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();

    render(
      <ObjectPickerDialog
        open={true}
        onClose={onClose}
        onSelect={onSelect}
        objects={testObjects}
        currentObjectId={null}
        siteBaseUrl={null}
      />
    );

    // All four objects should render as buttons
    const buttons = screen.getAllByRole("button").filter((b) =>
      testObjects.some((o) => b.textContent?.includes(o.title ?? o.object_id))
    );
    expect(buttons.length).toBe(testObjects.length);
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <ObjectPickerDialog
        open={false}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        objects={testObjects}
        currentObjectId={null}
        siteBaseUrl={null}
      />
    );

    expect(container.innerHTML).toBe("");
  });

  it("filters objects by title substring", () => {
    render(
      <ObjectPickerDialog
        open={true}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        objects={testObjects}
        currentObjectId={null}
        siteBaseUrl={null}
      />
    );

    const searchInput = screen.getByRole("textbox");
    fireEvent.change(searchInput, { target: { value: "colonial" } });

    // Only "Colonial Map 1720" should match
    expect(screen.getByText("Colonial Map 1720")).toBeDefined();
    expect(screen.queryByText("Weavers of Boyacá")).toBeNull();
    expect(screen.queryByText("Gold Chest")).toBeNull();
  });

  it("filters objects by object_id substring", () => {
    render(
      <ObjectPickerDialog
        open={true}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        objects={testObjects}
        currentObjectId={null}
        siteBaseUrl={null}
      />
    );

    const searchInput = screen.getByRole("textbox");
    fireEvent.change(searchInput, { target: { value: "gold-chest" } });

    expect(screen.getByText("Gold Chest")).toBeDefined();
    expect(screen.queryByText("Colonial Map 1720")).toBeNull();
  });

  it("calls onSelect with the correct object_id when an item is clicked", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <ObjectPickerDialog
        open={true}
        onClose={onClose}
        onSelect={onSelect}
        objects={testObjects}
        currentObjectId={null}
        siteBaseUrl={null}
      />
    );

    // Click on "Colonial Map 1720"
    fireEvent.click(screen.getByText("Colonial Map 1720").closest("button")!);

    expect(onSelect).toHaveBeenCalledWith("colonial-map");
    expect(onClose).toHaveBeenCalled();
  });

  it("highlights the current object with a distinct border class", () => {
    const { container } = render(
      <ObjectPickerDialog
        open={true}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        objects={testObjects}
        currentObjectId="gold-chest"
        siteBaseUrl={null}
      />
    );

    // The highlighted button should have the anil border class
    const highlighted = container.querySelector(".border-anil");
    expect(highlighted).not.toBeNull();
    expect(highlighted?.textContent).toContain("Gold Chest");
  });

  it("shows no-results message when search matches nothing", () => {
    render(
      <ObjectPickerDialog
        open={true}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        objects={testObjects}
        currentObjectId={null}
        siteBaseUrl={null}
      />
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzznotfound" } });

    // Should show no_results key (mocked to return the key string)
    expect(screen.getByText("object_picker.no_results")).toBeDefined();
  });

  it("shows no-objects message when objects array is empty", () => {
    render(
      <ObjectPickerDialog
        open={true}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        objects={[]}
        currentObjectId={null}
        siteBaseUrl={null}
      />
    );

    expect(screen.getByText("object_picker.no_objects")).toBeDefined();
  });
});
