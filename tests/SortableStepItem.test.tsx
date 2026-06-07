// @vitest-environment jsdom
/**
 * SortableStepItem.test.tsx — sidebar row coverage.
 *
 * Each sidebar step row:
 *   - renders the question as the step title (fallback when empty).
 *   - kind glyphs — media → Image in a chilca-pale square; section →
 *     a § glyph in a cream-dark square. No "Change kind" affordance.
 *   - a fixed ~14px drag-handle gutter (GripVertical), handle-only
 *     drag (row is not the activator).
 *   - nested L1/L2 sub-rows (marker + truncated button_label), click
 *     navigates.
 *
 * What is asserted against the current component is: the question fallback
 * renders, the drag handle exists via setActivatorNodeRef, and there is no
 * "Change kind" control.
 *
 * Harness modelled on tests/layer-panel.test.tsx (jsdom, react-i18next mock).
 * dnd-kit's useSortable needs a DndContext; we wrap renders in one.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { SortableStepItem } from "~/components/features/editor/SortableStepItem";

// ---------------------------------------------------------------------------
// Mock react-i18next — identity-ish t() with {{number}} interpolation so the
// "Step N" label and "no_question_yet" fallback are distinguishable.
// ---------------------------------------------------------------------------
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "number" in opts ? `${key}:${opts.number}` : key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderRow(props: Partial<Parameters<typeof SortableStepItem>[0]> = {}) {
  const step = {
    id: 1,
    step_number: 1,
    kind: "media" as const,
    question: "What is the river delta?",
    object_id: null,
    ...(props.step ?? {}),
  };
  const merged = {
    step,
    displayNumber: 1,
    isActive: false,
    onClick: vi.fn(),
    onDelete: vi.fn(),
    ...props,
  } as Parameters<typeof SortableStepItem>[0];

  const utils = render(
    <DndContext>
      <SortableContext items={[step.id]}>
        <SortableStepItem {...merged} />
      </SortableContext>
    </DndContext>,
  );
  return { ...utils, props: merged };
}

// ---------------------------------------------------------------------------
// question as title (sidebar)
// ---------------------------------------------------------------------------

describe("sidebar renders the question", () => {
  it("renders the question text for a media step", () => {
    renderRow({ step: { id: 1, step_number: 1, kind: "media", question: "What is the river delta?", object_id: null } });
    expect(screen.getByText("What is the river delta?")).toBeDefined();
  });

  it("falls back to step.no_question_yet when the media question is empty", () => {
    renderRow({ step: { id: 1, step_number: 1, kind: "media", question: null, object_id: null } });
    expect(screen.getByText("step.no_question_yet")).toBeDefined();
  });

  it("falls back to step.section_no_heading_yet for an empty section step", () => {
    renderRow({ step: { id: 2, step_number: 2, kind: "section", question: null, object_id: null } });
    expect(screen.getByText("step.section_no_heading_yet")).toBeDefined();
  });

  it("renders the question as the row TITLE, not below a bold 'Step N'", () => {
    renderRow({ step: { id: 1, step_number: 1, kind: "media", question: "What is the river delta?", object_id: null } });
    // The question is present as the title; the old "Step N" label is gone.
    expect(screen.getByText("What is the river delta?")).toBeDefined();
    expect(screen.queryByText("step.step_label:1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kind glyphs, no Change-kind affordance
// ---------------------------------------------------------------------------

describe("kind glyphs only, no Change-kind menu", () => {
  it("does NOT render any 'Change kind' affordance", () => {
    renderRow();
    expect(screen.queryByText(/change kind/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /change.?kind/i })).toBeNull();
  });

  it("media step shows an Image glyph in a bg-chilca-pale square", () => {
    const { container } = renderRow({ step: { id: 1, step_number: 1, kind: "media", question: "Q", object_id: null } });
    const square = container.querySelector(".bg-chilca-pale");
    expect(square).not.toBeNull();
    // The Image lucide icon renders an <svg> inside the glyph square.
    expect(square!.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".bg-cream-dark")).toBeNull();
  });

  it("section step shows a § glyph in a bg-cream-dark square", () => {
    const { container } = renderRow({ step: { id: 2, step_number: 2, kind: "section", question: "Heading", object_id: null } });
    const square = container.querySelector(".bg-cream-dark");
    expect(square).not.toBeNull();
    expect(square!.textContent).toContain("§");
    expect(container.querySelector(".bg-chilca-pale")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// visible drag-handle gutter, handle-only drag
// ---------------------------------------------------------------------------

describe("drag handle in the gutter, row is not the activator", () => {
  it("renders a drag handle (GripVertical svg) in the row", () => {
    const { container } = renderRow();
    // lucide GripVertical renders an <svg> inside the activator div.
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);
  });

  it("clicking the row body calls onClick (navigation), not a drag", () => {
    const onClick = vi.fn();
    renderRow({ onClick });
    fireEvent.click(screen.getByText("What is the river delta?"));
    expect(onClick).toHaveBeenCalled();
  });

  it("the handle sits in a fixed ~14px gutter at reduced opacity, always present, not opacity-0", () => {
    const { container } = renderRow();
    // The activator div carries the gutter width + reduced-opacity colour and
    // rises to full on group-hover — never the old opacity-0/gray-500 styling.
    const gutter = container.querySelector(".w-3\\.5.cursor-grab");
    expect(gutter).not.toBeNull();
    expect(gutter!.className).toContain("text-fg-subtle/50");
    expect(gutter!.className).toContain("group-hover:text-fg-subtle");
    expect(gutter!.className).not.toContain("opacity-0");
  });
});

// ---------------------------------------------------------------------------
// nested L1/L2 sub-rows
// ---------------------------------------------------------------------------

describe("nested layer sub-rows", () => {
  it("renders L1/L2 mono markers + truncated button_label sub-rows from a layers prop", () => {
    renderRow({
      layers: [
        { layer_number: 1, button_label: "Read more" },
        { layer_number: 2, button_label: "Even more" },
      ],
    });
    expect(screen.getByText("layer.marker_l1")).toBeDefined();
    expect(screen.getByText("layer.marker_l2")).toBeDefined();
    expect(screen.getByText("Read more")).toBeDefined();
    expect(screen.getByText("Even more")).toBeDefined();
  });

  it("falls back to layer.button_label when a sub-row label is empty", () => {
    renderRow({ layers: [{ layer_number: 1, button_label: null }] });
    expect(screen.getByText("layer.button_label")).toBeDefined();
  });

  it("clicking a sub-row calls onOpenLayer with its layer number, not onClick", () => {
    const onOpenLayer = vi.fn();
    const onClick = vi.fn();
    renderRow({
      onClick,
      onOpenLayer,
      layers: [{ layer_number: 1, button_label: "Read more" }],
    });
    fireEvent.click(screen.getByText("Read more"));
    expect(onOpenLayer).toHaveBeenCalledWith(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("highlights the active layer sub-row (bg-anil/20) when its step is active", () => {
    const { container } = renderRow({
      isActive: true,
      activeLayerNumber: 2,
      layers: [
        { layer_number: 1, button_label: "L1" },
        { layer_number: 2, button_label: "L2" },
      ],
    });
    // Two sub-row buttons; exactly the active one carries the highlight class.
    const highlighted = container.querySelectorAll("button.bg-anil\\/20");
    expect(highlighted.length).toBe(1);
    expect(highlighted[0].textContent).toContain("L2");
  });

  it("renders no sub-rows for a section step", () => {
    const { container } = renderRow({
      step: { id: 3, step_number: 3, kind: "section", question: "Break", object_id: null },
      layers: [{ layer_number: 1, button_label: "ignored" }],
    });
    expect(screen.queryByText("ignored")).toBeNull();
    expect(container.querySelector(".border-l")).toBeNull();
  });
});
