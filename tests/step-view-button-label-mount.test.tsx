// @vitest-environment jsdom
/**
 * The step card's layer button, mounted against a real Y.Doc: the button
 * opens its panel, the pencil beside it edits its label in place, and the
 * label never goes stale.
 *
 * tests/story-button-label-sync.test.tsx checks which layer's Y.Text each
 * label's writer writes. This checks the card's button against a change made
 * elsewhere: a change by a remote peer while the label is not being edited
 * shows on the button, opening it shows the new label rather than the one it
 * mounted with, and finishing without an edit leaves the newer label in
 * place.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import * as Y from "yjs";
import { StepCard } from "~/components/features/editor/StepCard";
import { stageGeometryOf } from "~/hooks/use-stage-geometry";
import { getYText } from "~/lib/yjs-helpers";
import { resetTargetSaves } from "~/components/ui/target-saves";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn() } }),
}));

let activeDoc: Y.Doc | null = null;
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    ydoc: activeDoc,
    undoManager: null,
    lastEditorByField: new Map(),
  }),
}));

function buildDocWithButtonLabel(initial: string) {
  const doc = new Y.Doc();
  const layers = doc.getArray<Y.Map<unknown>>("layers");
  const layerMap = new Y.Map<unknown>();
  doc.transact(() => {
    const label = new Y.Text();
    if (initial.length > 0) label.insert(0, initial);
    layerMap.set("button_label", label);
    layers.push([layerMap]);
  });
  return { doc, yText: getYText(layerMap, "button_label")! };
}

/** Replace a Y.Text's contents in one transaction, as a remote peer's edit arrives. */
function writeYText(doc: Y.Doc, yText: Y.Text, value: string) {
  doc.transact(() => {
    if (yText.length > 0) yText.delete(0, yText.length);
    if (value.length > 0) yText.insert(0, value);
  });
}

const geometry = stageGeometryOf({ w: 1240, h: 768 }, { w: 1440, h: 900 })!;

const onOpenLayer = vi.fn();

function card(buttonLabel: string, yText: Y.Text) {
  return (
    <StepCard
      geometry={geometry}
      media={false}
      step={{ id: 1, question: "Q", answer: "A" }}
      target="id:1"
      fieldKeyPrefix="step-test-1"
      questionYText={null}
      answerYText={null}
      layer1={{ id: 10, button_label: buttonLabel }}
      buttonLabelYText={yText}
      onCreateLayer={vi.fn()}
      onOpenLayer={onOpenLayer}
      glossary={{ terms: new Map(), baseUrl: "" }}
    />
  );
}

const pencil = () => screen.getByRole("button", { name: "layer.edit_button_label_aria" });
const pill = (label: string) => screen.getByRole("button", { name: label });

beforeEach(() => {
  activeDoc = null;
  onOpenLayer.mockClear();
});
afterEach(() => {
  cleanup();
  resetTargetSaves();
});

describe("the step card's button label does not go stale", () => {
  it("shows a change made elsewhere while the button is not being edited, and opens on it", () => {
    const { doc, yText } = buildDocWithButtonLabel("Learn more");
    activeDoc = doc;
    const view = render(card("Learn more", yText));
    expect(pill("Learn more")).toBeTruthy();

    act(() => writeYText(doc, yText, "Explore the delta"));
    view.rerender(card("Explore the delta", yText));
    expect(pill("Explore the delta")).toBeTruthy();

    fireEvent.click(pencil());
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Explore the delta");
  });

  it("finishing without an edit leaves the newer label in the shared text", () => {
    const { doc, yText } = buildDocWithButtonLabel("Learn more");
    activeDoc = doc;
    const view = render(card("Learn more", yText));
    act(() => writeYText(doc, yText, "Explore the delta"));
    view.rerender(card("Explore the delta", yText));

    fireEvent.click(pencil());
    fireEvent.blur(screen.getByRole("textbox"));
    expect(yText.toString()).toBe("Explore the delta");
  });

  it("writes the label typed on the button to the shared text", () => {
    const { doc, yText } = buildDocWithButtonLabel("Learn more");
    activeDoc = doc;
    render(card("Learn more", yText));
    fireEvent.click(pencil());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "About Coordinates" } });
    expect(yText.toString()).toBe("About Coordinates");
    expect(onOpenLayer).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(pill("About Coordinates")).toBeTruthy();
    expect(pencil()).toBeTruthy();
  });

  it("opens the panel from the button and leaves the shared text alone", () => {
    const { doc, yText } = buildDocWithButtonLabel("Learn more");
    activeDoc = doc;
    render(card("Learn more", yText));
    fireEvent.click(pill("Learn more"));
    expect(onOpenLayer).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(yText.toString()).toBe("Learn more");
  });
});
