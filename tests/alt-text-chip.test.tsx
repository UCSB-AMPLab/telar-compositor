// @vitest-environment jsdom

/**
 * The alt-text chip's mark: a check once the step's description is written, a
 * warning while it is empty, after the label on the full chip and as a badge
 * on the icon's corner on the compact one. The mark is decorative, since the
 * label names the state, and it is part of the element the stage's chrome
 * measures. The label keeps to one line. Placement on the stage and the recovered-draft dot are in
 * `framing-stage-mount.test.tsx`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", changeLanguage: vi.fn() } }),
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc: null, provider: null, isPublishing: false, undoManager: null, remoteCollaborators: [], lastEditorByField: new Map() }),
}));

import { AltTextChip } from "~/components/features/editor/AltTextChip";
import { resetTargetSaves } from "~/components/ui/target-saves";

afterEach(() => {
  cleanup();
  resetTargetSaves();
});

let targets = 0;
function mountChip(initialValue: string, over: Partial<ComponentProps<typeof AltTextChip>> = {}) {
  targets += 1;
  return render(
    <AltTextChip
      target={`project:1/step:${targets}/alt_text`}
      initialValue={initialValue}
      yText={null}
      fieldKey={`chip-${targets}`}
      onSave={async () => {}}
      {...over}
    />,
  );
}

const chip = () => screen.getByTestId("alt-text-chip");
const mark = () => chip().querySelector<HTMLElement>("[data-alt-text-mark]");

describe("the alt-text chip's mark", () => {
  it("warns while the description is empty, and shows no check", () => {
    mountChip("");
    expect(mark()?.dataset.altTextMark).toBe("empty");
    expect(mark()?.className).toContain("bg-qolle-pale");
    expect(chip().querySelector("[data-alt-text-mark='written']")).toBeNull();
  });

  it("shows a check once the description is written, and no warning", () => {
    mountChip("The head, crowned");
    expect(mark()?.dataset.altTextMark).toBe("written");
    expect(mark()?.className).toContain("bg-chilca-pale");
    expect(chip().querySelector("[data-alt-text-mark='empty']")).toBeNull();
  });

  it("counts a description of spaces only as empty", () => {
    mountChip("   \n ");
    expect(mark()?.dataset.altTextMark).toBe("empty");
    expect(chip().textContent).toBe("stage.alt_text_add");
  });

  it("is decorative: the label names the state, and the mark adds nothing to the chip's name", () => {
    mountChip("The head, crowned");
    expect(mark()?.getAttribute("aria-hidden")).toBe("true");
    expect(chip().textContent).toBe("stage.alt_text_edit");
    cleanup();
    mountChip("", { compact: true });
    expect(mark()?.getAttribute("aria-hidden")).toBe("true");
    expect(chip().getAttribute("aria-label")).toBe("stage.alt_text_add");
  });

  it("follows the label after it on the full chip, in the chip's flow", () => {
    mountChip("");
    const m = mark()!;
    expect(m.parentElement).toBe(chip());
    expect(m.className).not.toContain("absolute");
    const children = Array.from(chip().children);
    const label = children.findIndex((el) => el.textContent === "stage.alt_text_add");
    expect(label).toBeGreaterThan(-1);
    expect(children.indexOf(m)).toBe(label + 1);
  });

  it("keeps its label on one line, cut where the chip has no more room", () => {
    mountChip("The head, crowned");
    expect(chip().className.split(" ")).toContain("whitespace-nowrap");
    const label = Array.from(chip().children).find((el) => el.textContent === "stage.alt_text_edit")!;
    expect(label.className.split(" ")).toEqual(expect.arrayContaining(["truncate", "min-w-0"]));
  });

  it("sits as a badge on the icon's corner on the compact chip", () => {
    mountChip("The head, crowned", { compact: true });
    const m = mark()!;
    const icon = m.parentElement!;
    expect(icon.parentElement).toBe(chip());
    expect(icon.className).toContain("relative");
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(m.className).toContain("absolute");
    expect(m.dataset.altTextMark).toBe("written");
  });

  it("is inside the element the stage's chrome measures", () => {
    const measured: HTMLElement[] = [];
    mountChip("", { measureRef: (el) => el && measured.push(el) });
    expect(measured.at(-1)).toBe(chip());
    expect(measured.at(-1)!.contains(mark())).toBe(true);
  });

  it("switches as the author types, with the field still open, as the label does", async () => {
    mountChip("");
    fireEvent.click(chip());
    const dialog = await screen.findByRole("dialog", { name: "step.alt_text_section" });
    fireEvent.change(dialog.querySelector("textarea")!, { target: { value: "A crowned head" } });
    expect(screen.getByRole("dialog", { name: "step.alt_text_section" })).toBeTruthy();
    expect(mark()?.dataset.altTextMark).toBe("written");
    expect(chip().textContent).toBe("stage.alt_text_edit");
    fireEvent.change(dialog.querySelector("textarea")!, { target: { value: "  " } });
    expect(mark()?.dataset.altTextMark).toBe("empty");
  });
});
