// @vitest-environment jsdom
/**
 * step-line.test.tsx — the step list drawn as the step line.
 *
 * Mounts the real `StepSidebar` with the shared sensors and reorders through
 * dnd-kit itself, by keyboard and by mouse. jsdom has no layout, so each
 * sortable row is given a 30px box by its position among its siblings; the
 * row is recognised by the grip dnd-kit marks as sortable, which is the
 * thing being reordered.
 *
 * Covers: the title card's square heading the line; which row ends it after
 * a reorder and after a delete, and a section's ring taking precedence; the
 * temporary ids a drop reports and keeps across the id backfill; keyboard
 * reorder, drop and cancel, with focus back on the grip; pointer reorder and
 * a press that never became a drag; what is announced; selection and layer
 * navigation without dragging; delete permission per row; the drawer.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { arrayMove } from "@dnd-kit/sortable";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      if ("position" in opts) return `${key}|${opts.title}|${opts.position}|${opts.total}`;
      if ("title" in opts) return `${key}:${opts.title}`;
      return key;
    },
    i18n: { language: "en" },
  }),
}));

vi.mock("react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

import { StepSidebar } from "~/components/features/editor/StepSidebar";
import type { SidebarLayerSummary } from "~/components/features/editor/StepSidebar";
import { EditorShell } from "~/components/features/editor/EditorShell";

// ---------------------------------------------------------------------------
// Layout stand-in
// ---------------------------------------------------------------------------

const ROW = 30;
const originalRect = Element.prototype.getBoundingClientRect;

/** A sortable row's box: 30px tall, stacked by its position among its siblings. */
function rowRect(el: Element): DOMRect | null {
  if (!el.querySelector(':scope > div > button[aria-roledescription="sortable"]')) return null;
  const index = Array.from(el.parentElement?.children ?? []).indexOf(el);
  return new DOMRect(0, index * ROW, 200, ROW);
}

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return rowRect(this) ?? new DOMRect(0, 0, 0, 0);
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
});
afterEach(() => cleanup());

/** dnd-kit acts on its keyboard and pointer listeners from the next task. */
async function nextTask() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** One animation frame, in which dnd-kit restores focus after a drop. */
async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Step {
  id: number;
  step_number: number;
  kind?: "media" | "section";
  question: string | null;
  object_id: string | null;
  _tempId?: string | null;
}

const media = (id: number, question: string, tempId?: string): Step => ({
  id,
  step_number: id,
  kind: "media",
  question,
  object_id: "obj",
  _tempId: tempId ?? null,
});
const section = (id: number, question: string): Step => ({ id, step_number: id, kind: "section", question, object_id: null });

interface HarnessProps {
  initial: Step[];
  onReorder?: (oldIndex: number, newIndex: number, ids: Array<string | number>) => void;
  onStepSelect?: (index: number) => void;
  onOpenLayer?: (stepIndex: number, layerNumber: number, opener: HTMLElement) => void;
  onDeleteStep?: (step: { id: number }) => void;
  canDeleteStep?: (step: Step) => boolean;
  layersByStep?: Record<string, SidebarLayerSummary[]>;
  activeStepIndex?: number;
}

/** The sidebar over its own list, applying a drop the way the route does. */
function Harness({ initial, onReorder, onStepSelect, onOpenLayer, onDeleteStep, canDeleteStep, layersByStep, activeStepIndex = 1 }: HarnessProps) {
  const [steps, setSteps] = useState(initial);
  return (
    <StepSidebar
      steps={steps}
      storyTitle="Your Story"
      activeStepIndex={activeStepIndex}
      onStepSelect={onStepSelect ?? (() => {})}
      onReorderSteps={(oldIndex, newIndex, ids) => {
        onReorder?.(oldIndex, newIndex, ids);
        setSteps((prev) => arrayMove(prev, oldIndex, newIndex));
      }}
      onAddStep={() => {}}
      onAddSectionCard={() => {}}
      onDeleteStep={onDeleteStep ?? (() => {})}
      objectsByType={{ obj: "iiif" }}
      canDeleteStep={canDeleteStep as never}
      deleteTooltip="Not yours to delete"
      layersByStep={layersByStep}
      onOpenLayer={onOpenLayer}
    />
  );
}

const grips = () => screen.getAllByRole("button", { name: /^step_line\.move_aria/ });
const gripOf = (title: string) => screen.getByRole("button", { name: `step_line.move_aria:${title}` });
const shapes = () => Array.from(document.querySelectorAll("svg[data-shape]")).map((s) => s.getAttribute("data-shape"));
const titles = () => grips().map((g) => g.getAttribute("aria-label")!.replace("step_line.move_aria:", ""));
const liveRegion = () => document.querySelector('[role="status"][aria-live]') as HTMLElement;

async function keyboardMove(title: string, key: "ArrowDown" | "ArrowUp", times: number, finish: "drop" | "cancel") {
  const handle = gripOf(title);
  handle.focus();
  fireEvent.keyDown(handle, { key: " ", code: "Space" });
  await nextTask();
  for (let i = 0; i < times; i++) {
    fireEvent.keyDown(document, { key, code: key });
    await nextTask();
  }
  if (finish === "drop") fireEvent.keyDown(document, { key: " ", code: "Space" });
  else fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
  await nextTask();
  return handle;
}

// ---------------------------------------------------------------------------
// The line's marks
// ---------------------------------------------------------------------------

describe("the line's marks", () => {
  it("heads the line with the title card's square, which selects step 0", () => {
    const onStepSelect = vi.fn();
    render(<Harness initial={[media(1, "One"), media(2, "Two")]} onStepSelect={onStepSelect} />);
    expect(shapes()).toEqual(["title", "step", "end"]);
    fireEvent.click(screen.getByRole("button", { name: /step\.title_card_label/ }));
    expect(onStepSelect).toHaveBeenCalledWith(0);
  });

  it("gives the title card no line below it when the story has no steps", () => {
    render(<Harness initial={[]} />);
    expect(shapes()).toEqual(["title"]);
    expect(document.querySelector('svg[data-shape="title"] line')).toBeNull();
  });

  it("ends in a ring, with no triangle anywhere, when the last row is a section", () => {
    render(<Harness initial={[media(1, "One"), media(2, "Two"), section(3, "Part two")]} />);
    expect(shapes()).toEqual(["title", "step", "step", "section"]);
  });

  it("moves the triangle to the new last step after a reorder", async () => {
    render(<Harness initial={[media(1, "One"), media(2, "Two"), media(3, "Three")]} />);
    expect(shapes()).toEqual(["title", "step", "step", "end"]);
    await keyboardMove("Three", "ArrowUp", 1, "drop");
    expect(titles()).toEqual(["One", "Three", "Two"]);
    const end = document.querySelector('svg[data-shape="end"]')!;
    expect(end.closest("div[style]")!.textContent).toContain("Two");
    expect(shapes()).toEqual(["title", "step", "step", "end"]);
  });

  it("moves the triangle to the new last step after a delete", () => {
    const { rerender } = render(
      <StepSidebar
        steps={[media(1, "One"), media(2, "Two"), media(3, "Three")]}
        storyTitle="Your Story"
        activeStepIndex={1}
        onStepSelect={() => {}}
        onReorderSteps={() => {}}
        onAddStep={() => {}}
        onAddSectionCard={() => {}}
        onDeleteStep={() => {}}
      />,
    );
    rerender(
      <StepSidebar
        steps={[media(1, "One"), media(2, "Two")]}
        storyTitle="Your Story"
        activeStepIndex={1}
        onStepSelect={() => {}}
        onReorderSteps={() => {}}
        onAddStep={() => {}}
        onAddSectionCard={() => {}}
        onDeleteStep={() => {}}
      />,
    );
    expect(shapes()).toEqual(["title", "step", "end"]);
    expect(document.querySelector('svg[data-shape="end"]')!.closest("div[style]")!.textContent).toContain("Two");
  });
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

describe("keyboard reorder", () => {
  it("picks up from the grip, moves, drops, and keeps focus on the grip", async () => {
    const onReorder = vi.fn();
    render(<Harness initial={[media(1, "One"), media(2, "Two"), media(3, "Three")]} onReorder={onReorder} />);
    const handle = await keyboardMove("One", "ArrowDown", 1, "drop");
    expect(onReorder).toHaveBeenCalledWith(0, 1, ["2", "1", "3"]);
    expect(titles()).toEqual(["Two", "One", "Three"]);
    await nextFrame();
    expect(gripOf("One")).toBe(handle);
    expect(document.activeElement).toBe(handle);
  });

  it("cancels on Escape without reordering", async () => {
    const onReorder = vi.fn();
    render(<Harness initial={[media(1, "One"), media(2, "Two"), media(3, "Three")]} onReorder={onReorder} />);
    await keyboardMove("One", "ArrowDown", 2, "cancel");
    expect(onReorder).not.toHaveBeenCalled();
    expect(titles()).toEqual(["One", "Two", "Three"]);
  });

  it("does not select the row it moves", async () => {
    const onStepSelect = vi.fn();
    render(<Harness initial={[media(1, "One"), media(2, "Two")]} onStepSelect={onStepSelect} />);
    await keyboardMove("One", "ArrowDown", 1, "drop");
    expect(onStepSelect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

describe("pointer reorder", () => {
  it("drags a row from its grip to a new position", async () => {
    const onReorder = vi.fn();
    render(<Harness initial={[media(1, "One"), media(2, "Two"), media(3, "Three")]} onReorder={onReorder} />);
    const handle = gripOf("One");
    fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 15 });
    await nextTask();
    fireEvent.mouseMove(document, { clientX: 10, clientY: 40 });
    await nextTask();
    fireEvent.mouseMove(document, { clientX: 10, clientY: 75 });
    await nextTask();
    fireEvent.mouseUp(document, { clientX: 10, clientY: 75 });
    await nextTask();
    expect(onReorder).toHaveBeenCalledWith(0, 2, ["2", "3", "1"]);
    expect(titles()).toEqual(["Two", "Three", "One"]);
  });

  it("treats a press that never travels as no drag and no selection", async () => {
    const onReorder = vi.fn();
    const onStepSelect = vi.fn();
    render(<Harness initial={[media(1, "One"), media(2, "Two")]} onReorder={onReorder} onStepSelect={onStepSelect} />);
    const handle = gripOf("One");
    fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 15 });
    await nextTask();
    fireEvent.mouseMove(document, { clientX: 12, clientY: 17 });
    fireEvent.mouseUp(document, { clientX: 12, clientY: 17 });
    fireEvent.click(handle);
    await nextTask();
    expect(onReorder).not.toHaveBeenCalled();
    expect(onStepSelect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Temporary ids
// ---------------------------------------------------------------------------

describe("stable temporary ids", () => {
  function plain(steps: Step[]) {
    return (
      <StepSidebar
        steps={steps}
        storyTitle="Your Story"
        activeStepIndex={1}
        onStepSelect={() => {}}
        onReorderSteps={() => {}}
        onAddStep={() => {}}
        onAddSectionCard={() => {}}
        onDeleteStep={() => {}}
      />
    );
  }

  it("reports a drop in temporary ids", async () => {
    const onReorder = vi.fn();
    render(<Harness initial={[media(0, "One", "tmp-a"), media(0, "Two", "tmp-b")]} onReorder={onReorder} />);
    await keyboardMove("One", "ArrowDown", 1, "drop");
    expect(onReorder).toHaveBeenCalledWith(0, 1, ["tmp-b", "tmp-a"]);
  });

  it("keeps each row's grip element across the id backfill", () => {
    const { rerender } = render(plain([media(0, "One", "tmp-a"), media(0, "Two", "tmp-b")]));
    const one = gripOf("One");
    const two = gripOf("Two");
    rerender(plain([media(11, "One", "tmp-a"), media(12, "Two", "tmp-b")]));
    expect(gripOf("One")).toBe(one);
    expect(gripOf("Two")).toBe(two);
  });
});

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

describe("what is announced", () => {
  it("describes the grip with the instructions", () => {
    render(<Harness initial={[media(1, "One"), media(2, "Two")]} />);
    const describedBy = gripOf("One").getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)!.textContent).toBe("step_line.drag_instructions");
  });

  it("names the row by its title and position, never its key", async () => {
    render(<Harness initial={[media(0, "One", "tmp-a"), media(0, "Two", "tmp-b"), section(3, "")]} />);
    const handle = gripOf("One");
    handle.focus();
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    await nextTask();
    expect(liveRegion().textContent).toContain("step_line.picked_up|One|1|3");
    fireEvent.keyDown(document, { key: "ArrowDown", code: "ArrowDown" });
    await nextTask();
    expect(liveRegion().textContent).toContain("step_line.moved|One|2|3");
    fireEvent.keyDown(document, { key: " ", code: "Space" });
    await nextTask();
    expect(liveRegion().textContent).toContain("step_line.dropped|One|2|3");
    expect(liveRegion().textContent).not.toContain("tmp-");
  });

  it("announces a cancel with the row's position before the move", async () => {
    render(<Harness initial={[media(1, "One"), media(2, "Two"), section(3, "")]} />);
    await keyboardMove("One", "ArrowDown", 1, "cancel");
    expect(liveRegion().textContent).toContain("step_line.cancelled|One|1|3");
  });

  it("names an untitled section by its placeholder", () => {
    render(<Harness initial={[media(1, "One"), section(2, "")]} />);
    expect(gripOf("step.section_no_heading_yet")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Selection, layers, delete
// ---------------------------------------------------------------------------

describe("selection and layer navigation without dragging", () => {
  it("selects a step by its title and opens a layer by its branch", () => {
    const onStepSelect = vi.fn();
    const onOpenLayer = vi.fn();
    const onReorder = vi.fn();
    render(
      <Harness
        initial={[media(1, "One"), media(2, "Two")]}
        onStepSelect={onStepSelect}
        onOpenLayer={onOpenLayer}
        onReorder={onReorder}
        layersByStep={{ "2": [{ layer_number: 1, title: "Learn more", button_label: null }] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Two" }));
    expect(onStepSelect).toHaveBeenCalledWith(2);
    const layer = screen.getByRole("button", { name: "Learn more" });
    fireEvent.click(layer);
    expect(onOpenLayer).toHaveBeenCalledWith(2, 1, layer);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("marks the selected row and fills its mark only", () => {
    render(<Harness initial={[media(1, "One"), media(2, "Two")]} activeStepIndex={2} />);
    const filled = Array.from(document.querySelectorAll('svg[data-selected="true"]'));
    expect(filled).toHaveLength(1);
    expect(filled[0].getAttribute("data-shape")).toBe("end");
    expect(screen.getByRole("button", { name: "Two" }).getAttribute("aria-current")).toBe("step");
  });
});

describe("delete permissions", () => {
  it("disables delete per row from the predicate, and deletes where allowed", () => {
    const onDeleteStep = vi.fn();
    render(
      <Harness
        initial={[media(1, "Mine"), media(2, "Theirs")]}
        onDeleteStep={onDeleteStep}
        canDeleteStep={(s) => s.question === "Mine"}
      />,
    );
    const [mine, theirs] = screen.getAllByRole("button", { name: "step.delete_aria" }) as HTMLButtonElement[];
    expect(mine.disabled).toBe(false);
    expect(theirs.disabled).toBe(true);
    expect(theirs.title).toBe("Not yours to delete");
    fireEvent.click(theirs);
    expect(onDeleteStep).not.toHaveBeenCalled();
    fireEvent.click(mine);
    expect(onDeleteStep).toHaveBeenCalledWith(expect.objectContaining({ question: "Mine" }));
  });
});

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------

describe("the drawer on narrow windows", () => {
  function renderShell() {
    const onStepSelect = vi.fn();
    render(
      <EditorShell
        storyTitle="Your Story"
        stage={null}
        sidebar={<Harness initial={[media(1, "One"), media(2, "Two")]} onStepSelect={onStepSelect} />}
      />,
    );
    const drawer = screen.getByRole("dialog");
    return { drawer, onStepSelect, isOpen: () => drawer.className.includes("translate-x-0") };
  }

  it("holds the same step line", () => {
    const { drawer } = renderShell();
    expect(within(drawer).getAllByRole("button", { name: /^step_line\.move_aria/ })).toHaveLength(2);
    expect(Array.from(drawer.querySelectorAll("svg[data-shape]")).map((s) => s.getAttribute("data-shape"))).toEqual([
      "title",
      "step",
      "end",
    ]);
  });

  it("stays open when a grip is pressed, and closes when a step is chosen", () => {
    const { drawer, onStepSelect, isOpen } = renderShell();
    expect(isOpen()).toBe(true);
    fireEvent.click(within(drawer).getAllByRole("button", { name: /^step_line\.move_aria/ })[0]);
    expect(isOpen()).toBe(true);
    fireEvent.click(within(drawer).getByRole("button", { name: "Two" }));
    expect(onStepSelect).toHaveBeenCalledWith(2);
    expect(isOpen()).toBe(false);
  });
});
