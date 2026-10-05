// @vitest-environment jsdom
/**
 * The first click on a step card's text opens its field. A browser presses
 * the pointer, focuses the block (which re-renders the card), releases the
 * pointer and then fires a click only when the element pressed is still the
 * one released on; a card that replaces the pressed element on focus loses
 * the click.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { StepCard } from "~/components/features/editor/StepCard";
import { stageGeometryOf } from "~/hooks/use-stage-geometry";
import { resetTargetSaves } from "~/components/ui/target-saves";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn() } }),
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    ydoc: null,
    undoManager: null,
    lastEditorByField: new Map(),
  }),
}));

const geometry = stageGeometryOf({ w: 1240, h: 768 }, { w: 1440, h: 900 })!;
const phoneGeometry = stageGeometryOf({ w: 844, h: 300 }, { w: 844, h: 390 })!;
const onOpenLayer = vi.fn();
const glossary = { terms: new Map(), baseUrl: "" };

function stepCardView(at = geometry) {
  return (
    <StepCard
      geometry={at}
      media={false}
      step={{ id: 1, question: "What is a delta?", answer: "A river mouth." }}
      target="id:1"
      fieldKeyPrefix="step-test-1"
      questionYText={null}
      answerYText={null}
      onSaveField={vi.fn(async () => undefined)}
      layer1={{ id: 10, button_label: "Learn more" }}
      buttonLabelYText={null}
      onSaveButtonLabel={vi.fn(async () => undefined)}
      onCreateLayer={vi.fn()}
      onOpenLayer={onOpenLayer}
      glossary={glossary}
    />
  );
}

/** One click as a browser delivers it: the element pressed must survive the focus to be clicked. */
function browserClick(pressed: Element, focusTarget: HTMLElement) {
  fireEvent.pointerDown(pressed);
  fireEvent.mouseDown(pressed);
  act(() => focusTarget.focus());
  const released = pressed.isConnected ? pressed : null;
  if (released) {
    fireEvent.pointerUp(released);
    fireEvent.mouseUp(released);
    fireEvent.click(released);
  }
}

afterEach(() => {
  onOpenLayer.mockClear();
  cleanup();
  resetTargetSaves();
});

describe("the first click on the step card", () => {
  it("opens the answer's field from its text", () => {
    render(stepCardView());
    const p = screen.getByText("A river mouth.");
    browserClick(p, p.closest<HTMLElement>("[data-in-place]")!);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("keeps the answer, the question, both pencils and the button in place through the card's focus change", () => {
    render(stepCardView());
    const p = screen.getByText("A river mouth.");
    const question = screen.getByText("What is a delta?");
    const pills = [
      screen.getByRole("button", { name: "stage.edit_question" }),
      screen.getByRole("button", { name: "stage.edit_answer" }),
      screen.getByRole("button", { name: "layer.edit_button_label_aria" }),
      screen.getByText(/Learn more/),
    ];
    act(() => p.closest<HTMLElement>("[data-in-place]")!.focus());
    for (const el of [p, question, ...pills]) expect(el.isConnected).toBe(true);
  });

  it("opens the question's field from its text", () => {
    render(stepCardView());
    const q = screen.getByText("What is a delta?");
    browserClick(q, q.closest<HTMLElement>("[data-in-place]")!);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("opens the question's and the answer's field from their pencils", () => {
    for (const name of ["stage.edit_question", "stage.edit_answer"]) {
      const view = render(stepCardView());
      const pencil = screen.getByRole("button", { name });
      browserClick(pencil, pencil);
      expect(screen.getByRole("textbox")).toBeTruthy();
      view.unmount();
    }
  });

  it("opens the button label's field from its pencil", () => {
    const view = render(stepCardView());
    const pencil = screen.getByRole("button", { name: "layer.edit_button_label_aria" });
    browserClick(pencil, pencil);
    expect(screen.getByRole("textbox")).toBeTruthy();
    view.unmount();
  });

  it("opens the panel from the button on the first click, through the card's focus change", () => {
    render(stepCardView());
    const button = screen.getByText(/Learn more/).closest<HTMLElement>("button.panel-trigger")!;
    browserClick(button, button);
    expect(onOpenLayer).toHaveBeenCalledTimes(1);
    expect(onOpenLayer).toHaveBeenCalledWith(button);
  });

  it("scrolls a card taller than its ceiling on a vertical layout, a sideways phone's included, and cuts it on a horizontal one", () => {
    const phone = render(stepCardView(phoneGeometry));
    expect(screen.getByTestId("step-card").style.overflowY).toBe("auto");
    phone.unmount();
    const desktop = render(stepCardView(stageGeometryOf({ w: 1280, h: 560 }, { w: 1280, h: 720 })!));
    expect(screen.getByTestId("step-card").style.overflowY).toBe("");
    desktop.unmount();
  });
});
