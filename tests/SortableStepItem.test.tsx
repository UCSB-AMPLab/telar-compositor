// @vitest-environment jsdom
/**
 * SortableStepItem.test.tsx — one row of the step line.
 *
 * Each row:
 *   - is titled by its question, with a placeholder per kind when empty.
 *   - carries its mark: a circle per step with its object type's icon, the
 *     triangle when it is the last step, a ring (no icon) for a section card
 *     wherever it sits; the selected row's mark is filled.
 *   - has a grip at its left, a focusable button named after the row, which
 *     is the drag activator; selection is a separate button, so a press on
 *     one never does the other's work.
 *   - draws its layers as branches: layer 1 off the step's line, layer 2 off
 *     layer 1's stem, each titled by its title, its button label, or the
 *     default label for its level.
 *   - keeps the delete control and its permission.
 *
 * The icons are told apart by the class lucide-react gives every icon after
 * its name, which nothing in the row arranges.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { SortableStepItem } from "~/components/features/editor/SortableStepItem";
import type { MediaType } from "~/lib/media-type";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && "title" in opts ? `${key}:${opts.title}` : key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

type RowProps = Parameters<typeof SortableStepItem>[0];

function renderRow(props: Partial<RowProps> = {}) {
  const step = {
    id: 1,
    step_number: 1,
    kind: "media" as const,
    question: "What is the river delta?",
    object_id: "delta",
    ...(props.step ?? {}),
  };
  const merged = {
    step,
    isActive: false,
    onClick: vi.fn(),
    onDelete: vi.fn(),
    ...props,
  } as RowProps;

  const utils = render(
    <DndContext>
      <SortableContext items={[step.id]}>
        <SortableStepItem {...merged} />
      </SortableContext>
    </DndContext>,
  );
  return { ...utils, props: merged };
}

const mark = (container: HTMLElement) => container.querySelector("svg[data-shape]") as SVGSVGElement;
const markIcon = (container: HTMLElement) => mark(container).querySelector("svg.lucide");
const grip = () => screen.getByRole("button", { name: /^step_line\.move_aria/ });

// ---------------------------------------------------------------------------
// title
// ---------------------------------------------------------------------------

describe("the row's title", () => {
  it("is the question of a media step", () => {
    renderRow();
    expect(screen.getByText("What is the river delta?")).toBeDefined();
  });

  it("falls back to step.no_question_yet when the media question is empty", () => {
    renderRow({ step: { id: 1, step_number: 1, kind: "media", question: null, object_id: null } });
    expect(screen.getByText("step.no_question_yet")).toBeDefined();
  });

  it("falls back to step.section_no_heading_yet for an empty section", () => {
    renderRow({ step: { id: 2, step_number: 2, kind: "section", question: null, object_id: null } });
    expect(screen.getByText("step.section_no_heading_yet")).toBeDefined();
  });

  it("has no 'Step N' label and no change-kind control", () => {
    renderRow();
    expect(screen.queryByText("step.step_label:1")).toBeNull();
    expect(screen.queryByText(/change kind/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// marks
// ---------------------------------------------------------------------------

describe("the row's mark", () => {
  it("is a circle for a step that is not last", () => {
    const { container } = renderRow({ isLast: false });
    expect(mark(container).dataset.shape).toBe("step");
    expect(mark(container).querySelector("circle")).not.toBeNull();
  });

  it("is the triangle, carrying its icon, for the last step", () => {
    const { container } = renderRow({ isLast: true });
    expect(mark(container).dataset.shape).toBe("end");
    expect(mark(container).querySelector("path")).not.toBeNull();
    expect(markIcon(container)).not.toBeNull();
  });

  it("is a ring with no icon for a section card, also when it is last", () => {
    for (const isLast of [false, true]) {
      const { container, unmount } = renderRow({
        isLast,
        step: { id: 2, step_number: 2, kind: "section", question: "Part two", object_id: "map" },
        objectsByType: { map: "youtube" },
      });
      expect(mark(container).dataset.shape).toBe("section");
      expect(markIcon(container)).toBeNull();
      unmount();
    }
  });

  it("is filled when the row is selected, and only then", () => {
    const selected = renderRow({ isActive: true });
    expect(mark(selected.container).dataset.selected).toBe("true");
    expect(mark(selected.container).querySelector("circle")!.getAttribute("class")).toContain("fill-cream");
    selected.unmount();
    const plain = renderRow({ isActive: false });
    expect(mark(plain.container).dataset.selected).toBeUndefined();
    expect(mark(plain.container).querySelector("circle")!.getAttribute("class")).toContain("fill-none");
  });

  it("is drawn by a line that stops at the last row unless the step has layers", () => {
    const below = (container: HTMLElement) => mark(container).querySelectorAll("line").length;
    const middle = renderRow({ isLast: false });
    expect(below(middle.container)).toBe(2);
    middle.unmount();
    const end = renderRow({ isLast: true });
    expect(below(end.container)).toBe(1);
    end.unmount();
    const endWithLayers = renderRow({ isLast: true, layers: [{ layer_number: 1, title: "More", button_label: null }] });
    expect(below(endWithLayers.container)).toBe(2);
  });
});

describe("each media type's icon", () => {
  const cases: Array<[MediaType, string, string | null]> = [
    ["iiif", "lucide-image", null],
    ["youtube", "lucide-video", "media.media_type_video"],
    ["vimeo", "lucide-video", "media.media_type_video"],
    ["google-drive", "lucide-video", "media.media_type_video"],
    ["audio", "lucide-music", "media.media_type_audio"],
    ["text-only", "lucide-file-text", "media.media_type_text"],
  ];

  it.each(cases)("%s draws %s and is spoken as %s", (type, iconClass, label) => {
    const { container } = renderRow({
      step: { id: 1, step_number: 1, kind: "media", question: "Q", object_id: "obj" },
      objectsByType: { obj: type },
    });
    expect(markIcon(container)!.getAttribute("class")).toContain(iconClass);
    const select = screen.getByRole("button", { name: label ? `Q, ${label}` : "Q" });
    expect(select).toBeDefined();
  });

  it("draws the page icon for a step with no object", () => {
    const { container } = renderRow({ step: { id: 1, step_number: 1, kind: "media", question: "Q", object_id: null } });
    expect(markIcon(container)!.getAttribute("class")).toContain("lucide-file-text");
  });

  it("reads an object the site does not resolve from its value alone", () => {
    const image = renderRow({ step: { id: 1, step_number: 1, kind: "media", question: "Q", object_id: "lost" }, objectsByType: {} });
    expect(markIcon(image.container)!.getAttribute("class")).toContain("lucide-image");
    image.unmount();
    const audio = renderRow({ step: { id: 1, step_number: 1, kind: "media", question: "Q", object_id: "song.mp3" } });
    expect(markIcon(audio.container)!.getAttribute("class")).toContain("lucide-music");
  });
});

// ---------------------------------------------------------------------------
// grip and selection
// ---------------------------------------------------------------------------

describe("the grip, at the left, is the drag activator", () => {
  it("is a button named after the row, before the selection button", () => {
    renderRow();
    const handle = grip();
    expect(handle.getAttribute("aria-label")).toBe("step_line.move_aria:What is the river delta?");
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]).toBe(handle);
    expect(handle.tagName).toBe("BUTTON");
  });

  it("carries the sortable attributes; the row wrapper does not", () => {
    const { container } = renderRow();
    expect(grip().getAttribute("aria-roledescription")).toBe("sortable");
    expect(grip().getAttribute("aria-describedby")).toBeTruthy();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute("role")).toBeNull();
    expect(wrapper.getAttribute("tabindex")).toBeNull();
  });

  it("sits in an 18px column, dimmed at rest and full on row hover, never hidden", () => {
    renderRow();
    const cls = grip().className;
    expect(cls).toContain("w-[18px]");
    expect(cls).toContain("text-cream/40");
    expect(cls).toContain("group-hover:text-cream");
    expect(cls).not.toContain("opacity-0");
  });

  it("does not select the row when pressed", () => {
    const onClick = vi.fn();
    renderRow({ onClick });
    fireEvent.click(grip());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("selection is a separate button that selects without dragging", () => {
    const onClick = vi.fn();
    renderRow({ onClick });
    const select = screen.getByRole("button", { name: "What is the river delta?" });
    expect(select).not.toBe(grip());
    expect(select.getAttribute("aria-roledescription")).toBeNull();
    fireEvent.click(select);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("marks the selected row as the current step", () => {
    renderRow({ isActive: true });
    expect(screen.getByRole("button", { name: "What is the river delta?" }).getAttribute("aria-current")).toBe("step");
  });
});

// ---------------------------------------------------------------------------
// layer branches
// ---------------------------------------------------------------------------

describe("layer branches", () => {
  it("branches layer 1 off the step and layer 2 off layer 1's stem", () => {
    const { container } = renderRow({
      layers: [
        { layer_number: 2, title: "Deeper", button_label: null },
        { layer_number: 1, title: "More", button_label: null },
      ],
    });
    const branches = Array.from(container.querySelectorAll("svg[data-branch]"));
    expect(branches.map((b) => b.getAttribute("data-branch"))).toEqual(["1", "2"]);
    // Layer 1's stem continues down to layer 2; layer 2 has none.
    const stems = (b: Element) => Array.from(b.querySelectorAll("line")).filter((l) => l.getAttribute("x1") !== "20");
    expect(stems(branches[0])).toHaveLength(1);
    expect(stems(branches[1])).toHaveLength(0);
    // Layer 2's branch leaves from layer 1's stem, not the step's line.
    expect(branches[1].querySelector("path")!.getAttribute("d")).toMatch(/^M44 /);
    expect(branches[0].querySelector("path")!.getAttribute("d")).toMatch(/^M20 /);
  });

  it("gives layer 1 no stem when it has no layer 2", () => {
    const { container } = renderRow({ layers: [{ layer_number: 1, title: "More", button_label: null }] });
    const branch = container.querySelector("svg[data-branch]")!;
    expect(Array.from(branch.querySelectorAll("line")).filter((l) => l.getAttribute("x1") !== "20")).toHaveLength(0);
  });

  it("colours each level as its panel", () => {
    const { container } = renderRow({
      layers: [
        { layer_number: 1, title: "More", button_label: null },
        { layer_number: 2, title: "Deeper", button_label: null },
      ],
    });
    const [one, two] = Array.from(container.querySelectorAll("svg[data-branch]"));
    expect(one.getAttribute("class")).toContain("text-anil");
    expect(two.getAttribute("class")).toContain("text-terracotta-soft");
  });

  it("titles a layer by its title, else its button label, else its level's default label in the site's language", () => {
    renderRow({
      layers: [
        { layer_number: 1, title: "", button_label: "Read on" },
        { layer_number: 2, title: null, button_label: "  " },
      ],
    });
    expect(screen.getByText("Read on")).toBeDefined();
    expect(screen.getByText("Go deeper")).toBeDefined();
    const spanish = renderRow({ siteLang: "es", layers: [{ layer_number: 1, title: null, button_label: null }] });
    expect(within(spanish.container).getByText("Saber más")).toBeDefined();
    const titled = renderRow({ layers: [{ layer_number: 1, title: "The engraving", button_label: "Read on" }] });
    expect(within(titled.container).getByText("The engraving")).toBeDefined();
    expect(within(titled.container).queryByText("Read on")).toBeNull();
  });

  it("drops the step's line through the branches only when a row follows", () => {
    const passes = (container: HTMLElement) =>
      Array.from(container.querySelector("svg[data-branch]")!.querySelectorAll("line")).some((l) => l.getAttribute("x1") === "20");
    const middle = renderRow({ isLast: false, layers: [{ layer_number: 1, title: "More", button_label: null }] });
    expect(passes(middle.container)).toBe(true);
    middle.unmount();
    const last = renderRow({ isLast: true, layers: [{ layer_number: 1, title: "More", button_label: null }] });
    expect(passes(last.container)).toBe(false);
  });

  it("opens its layer with the layer row as the opener, without selecting through the row", () => {
    const onOpenLayer = vi.fn();
    const onClick = vi.fn();
    renderRow({ onClick, onOpenLayer, layers: [{ layer_number: 1, title: "Read more", button_label: null }] });
    fireEvent.click(screen.getByText("Read more"));
    expect(onOpenLayer).toHaveBeenCalledWith(1, screen.getByText("Read more").closest("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("highlights the open layer of the selected step", () => {
    const { container } = renderRow({
      isActive: true,
      activeLayerNumber: 2,
      layers: [
        { layer_number: 1, title: "L1", button_label: null },
        { layer_number: 2, title: "L2", button_label: null },
      ],
    });
    const highlighted = Array.from(container.querySelectorAll("button.bg-anil\\/20")).filter((b) => b.querySelector("svg[data-branch]"));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].textContent).toContain("L2");
  });

  it("draws no branches for a section", () => {
    const { container } = renderRow({
      step: { id: 3, step_number: 3, kind: "section", question: "Break", object_id: null },
      layers: [{ layer_number: 1, title: "ignored", button_label: null }],
    });
    expect(screen.queryByText("ignored")).toBeNull();
    expect(container.querySelector("svg[data-branch]")).toBeNull();
  });

  it("keeps the branches inside the sortable node, so they move with their step", () => {
    const { container } = renderRow({ layers: [{ layer_number: 1, title: "More", button_label: null }] });
    const node = container.firstElementChild!;
    expect(node.contains(screen.getByText("More"))).toBe(true);
    expect(node.contains(grip())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("delete", () => {
  it("deletes when permitted, without selecting", () => {
    const onDelete = vi.fn();
    const onClick = vi.fn();
    renderRow({ onDelete, onClick });
    fireEvent.click(screen.getByRole("button", { name: "step.delete_aria" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is disabled with its tooltip when not permitted", () => {
    const onDelete = vi.fn();
    renderRow({ onDelete, canDelete: false, deleteTooltip: "Only its author can delete this" });
    const button = screen.getByRole("button", { name: "step.delete_aria" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Only its author can delete this");
    fireEvent.click(button);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
