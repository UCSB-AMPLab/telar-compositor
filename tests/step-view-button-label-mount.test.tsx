// @vitest-environment jsdom
/**
 * step-view-button-label-mount.test.tsx — component-mount coverage.
 *
 * The shared-identity test (tests/story-button-label-sync.test.ts) proves the
 * getYText/writeYText helpers share a single Y.Text identity, but it operates
 * on a bare Y.Doc and never mounts a component. That gap is exactly why the
 * regression
 * passed CI: `LayerButtonWithEdit` (inside StepView) kept an independent local
 * `label` state seeded ONCE at mount and only re-synced on Cancel. When the
 * shared button_label changed from the panel strip or a remote peer while the
 * inline editor was closed, opening the pencil showed the STALE seed and Save
 * clobbered the newer shared value.
 *
 * This test MOUNTS StepView against a real Y.Doc, mutates the shared
 * button_label Y.Text while the inline editor is closed (modelling a panel-strip
 * or remote write), then opens the pencil and asserts the input reflects the NEW
 * value — not the stale mount-time seed. It also asserts that Saving after such
 * an external change does not overwrite the newer value with the stale one.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import * as Y from "yjs";
import { StepView } from "~/components/features/editor/StepView";
import { getYText } from "~/lib/yjs-helpers";

// ---------------------------------------------------------------------------
// i18n: identity mock so keys surface as their raw key string.
// ---------------------------------------------------------------------------
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));

// ---------------------------------------------------------------------------
// Inline text fields: render a plain input/textarea so StepView mounts without
// CodeMirror/collaborative-text machinery (only the layer pill is under test).
// ---------------------------------------------------------------------------
vi.mock("~/components/ui/InlineTextField", () => ({
  InlineTextField: ({ initialValue }: { initialValue: string }) => (
    <div data-testid="inline-field">{initialValue}</div>
  ),
}));
vi.mock("~/components/ui/InlineTextArea", () => ({
  InlineTextArea: ({ initialValue }: { initialValue: string }) => (
    <div data-testid="inline-area">{initialValue}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Collaboration context: hand the component a REAL Y.Doc so writeYText (which
// runs ydoc.transact) actually mutates the shared Y.Text. The doc is swapped
// per-test via a module-level holder.
// ---------------------------------------------------------------------------
let activeDoc: Y.Doc | null = null;
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    connected: false,
    publishError: false,
    setIsPublishing: vi.fn(),
    ydoc: activeDoc,
    lastEditorByField: new Map(),
  }),
}));

/**
 * Build a real Y.Doc carrying a single layer whose `button_label` is a Y.Text
 * (mirroring how the collaboration worker seeds the field). Returns the doc,
 * the layer Y.Map, and the resolved button_label Y.Text — the SAME handle the
 * route threads into StepView.
 */
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
  return { doc, layerMap, yText: getYText(layerMap, "button_label")! };
}

/** Replace a Y.Text's contents in one transaction (panel-strip / remote idiom). */
function writeYText(doc: Y.Doc, yText: Y.Text, value: string) {
  doc.transact(() => {
    if (yText.length > 0) yText.delete(0, yText.length);
    if (value.length > 0) yText.insert(0, value);
  });
}

const baseStep = {
  id: 1,
  step_number: 1,
  question: "Q",
  answer: "A",
  alt_text: "",
};

function renderStepView(
  buttonLabel: string | null,
  buttonLabelYText: Y.Text | null
) {
  const layer = {
    id: 10,
    step_id: 1,
    layer_number: 1,
    title: null,
    button_label: buttonLabel,
    content: null,
  };
  return render(
    <StepView
      step={baseStep}
      layers={[layer]}
      onOpenLayer={vi.fn()}
      onCreateLayer={vi.fn()}
      actionUrl="/stories/test"
      questionYText={null}
      answerYText={null}
      altTextYText={null}
      buttonLabelYText={buttonLabelYText}
      storySlug="test"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  activeDoc = null;
});

describe("LayerButtonWithEdit local label does not go stale (component mount)", () => {
  it("opening the pencil after an external button_label change shows the NEW value, not the stale mount seed", () => {
    const { doc, yText } = buildDocWithButtonLabel("Learn more");
    activeDoc = doc;

    // Mount with the initial label. The pill renders the current button_label.
    const { rerender } = renderStepView("Learn more", yText);

    // Simulate a panel-strip / remote-peer write to the SHARED Y.Text while the
    // inline editor is CLOSED. In production this re-renders the route with a
    // new layer.button_label (recomputed from the Y.Text observer); model that
    // by writing the Y.Text and re-rendering StepView with the new prop value.
    act(() => {
      writeYText(doc, yText, "Explore the delta");
    });
    rerenderWith(rerender, "Explore the delta", yText);

    // Open the inline editor (pencil).
    fireEvent.click(
      screen.getByRole("button", { name: /edit_button_label_aria/i })
    );

    // The input must show the NEW shared value, not the stale "Learn more" seed.
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Explore the delta");
  });

  it("Save after an external change writes the up-to-date value back, not the stale seed", () => {
    const { doc, yText } = buildDocWithButtonLabel("Learn more");
    activeDoc = doc;
    const { rerender } = renderStepView("Learn more", yText);

    // External change while editor closed.
    act(() => {
      writeYText(doc, yText, "Explore the delta");
    });
    rerenderWith(rerender, "Explore the delta", yText);

    // Open the editor, then Save WITHOUT editing the field.
    fireEvent.click(
      screen.getByRole("button", { name: /edit_button_label_aria/i })
    );
    fireEvent.click(
      screen.getByRole("button", { name: /save_label_aria/i })
    );

    // The shared Y.Text must still hold the newer value — Save must not have
    // clobbered it with the stale mount-time seed ("Learn more").
    expect(yText.toString()).toBe("Explore the delta");
  });
});

/** Re-render StepView with an updated button_label prop (route re-render). */
function rerenderWith(
  rerender: (ui: React.ReactElement) => void,
  buttonLabel: string,
  buttonLabelYText: Y.Text
) {
  const layer = {
    id: 10,
    step_id: 1,
    layer_number: 1,
    title: null,
    button_label: buttonLabel,
    content: null,
  };
  rerender(
    <StepView
      step={baseStep}
      layers={[layer]}
      onOpenLayer={vi.fn()}
      onCreateLayer={vi.fn()}
      actionUrl="/stories/test"
      questionYText={null}
      answerYText={null}
      altTextYText={null}
      buttonLabelYText={buttonLabelYText}
      storySlug="test"
    />
  );
}
