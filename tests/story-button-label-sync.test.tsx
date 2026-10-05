// @vitest-environment jsdom
/**
 * story-button-label-sync.test.tsx — each panel's button label is edited
 * where the reader sees its button, against a real Y.Doc: layer 1's on the
 * step card's button, layer 2's on its button at the end of layer 1's
 * panel. Each writes its own layer's `button_label` Y.Text, as the route
 * resolves it (`getYText` on the layer's map), so a collaborator's document
 * receives the edit, and a collaborator's edit shows on the button.
 *
 * The writers are the mounted components, not the Y.Text handled directly:
 * a component that kept its own copy of the label, or wrote another layer's
 * Y.Text, would fail here while a test of the helpers alone passed.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, act, cleanup, screen } from "@testing-library/react";
import * as Y from "yjs";
import { StepCard } from "~/components/features/editor/StepCard";
import { LayerPanel } from "~/components/features/editor/LayerPanel";
import { LayerContentDrafts } from "~/hooks/use-layer-content-drafts";
import type { StagePanelLayer } from "~/components/features/editor/StagePanels";
import { stageGeometryOf } from "~/hooks/use-stage-geometry";
import { getYText } from "~/lib/yjs-helpers";
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

vi.mock("~/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: () => <div data-testid="markdown-editor" />,
}));

afterEach(() => {
  cleanup();
  resetTargetSaves();
});

/** A step's two layers in a real document, each with its own button_label Y.Text. */
function stepDoc() {
  const doc = new Y.Doc();
  const layers = doc.getArray<Y.Map<unknown>>("layers");
  doc.transact(() => {
    for (const [n, label] of [[1, "Learn more"], [2, "Go deeper"]] as const) {
      const map = new Y.Map<unknown>();
      map.set("layer_number", n);
      map.set("button_label", new Y.Text(label));
      map.set("title", new Y.Text(""));
      layers.push([map]);
    }
  });
  const maps = [layers.get(0), layers.get(1)];
  return { doc, labels: maps.map((m) => getYText(m, "button_label")!) };
}

/** A collaborator's document, kept in step with `doc` both ways. */
function peerOf(doc: Y.Doc) {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  doc.on("update", (u: Uint8Array) => Y.applyUpdate(peer, u));
  peer.on("update", (u: Uint8Array) => Y.applyUpdate(doc, u));
  const labelOf = (i: number) => getYText(peer.getArray<Y.Map<unknown>>("layers").get(i), "button_label")!;
  return { peer, labelOf };
}

function replace(doc: Y.Doc, text: Y.Text, value: string) {
  act(() => {
    doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, value);
    });
  });
}

/** Opens a label's field from its pencil and types into it. */
function typeLabel(pencil: HTMLElement, value: string) {
  fireEvent.click(pencil);
  const input = document.activeElement as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

function panelLayer(n: 1 | 2, label: Y.Text): StagePanelLayer {
  return {
    key: `L${n}`,
    id: 50 + n,
    layer_number: n,
    title: null,
    button_label: label.toString(),
    content: null,
    titleYText: null,
    contentYText: null,
    buttonLabelYText: label,
    canDelete: true,
  };
}

const fields = {
  save: vi.fn(() => Promise.resolve(undefined)),
  fresh: (_l: StagePanelLayer, _f: string, value: string) => value,
  recoveryKey: () => undefined,
  saveErrorMessage: "stage.save_failed",
};

describe("layer 1's label, on the step card's button", () => {
  it("writes layer 1's button_label, which a collaborator receives, and shows theirs", () => {
    const { doc, labels } = stepDoc();
    const { peer, labelOf } = peerOf(doc);
    render(
      <StepCard
        geometry={stageGeometryOf({ w: 1240, h: 768 }, { w: 1440, h: 900 })!}
        media={false}
        step={{ id: 1, question: "Q", answer: "A" }}
        target="id:1"
        fieldKeyPrefix="step-test-1"
        questionYText={null}
        answerYText={null}
        layer1={{ id: 51, button_label: "Learn more" }}
        buttonLabelYText={labels[0]}
        onCreateLayer={vi.fn()}
        onOpenLayer={vi.fn()}
        glossary={{ terms: new Map(), baseUrl: "" }}
      />,
    );
    typeLabel(screen.getByRole("button", { name: "layer.edit_button_label_aria" }), "About the plate");
    expect(labels[0].toString()).toBe("About the plate");
    expect(labelOf(0).toString()).toBe("About the plate");
    expect(labels[1].toString()).toBe("Go deeper");

    replace(peer, labelOf(0), "Their label");
    expect(document.querySelector(".text-card .panel-trigger")!.textContent).toBe("Their label →");
  });
});

describe("layer 2's label, on its button at the end of layer 1's panel", () => {
  it("writes layer 2's button_label, not layer 1's, which a collaborator receives, and shows theirs", () => {
    const { doc, labels } = stepDoc();
    const { peer, labelOf } = peerOf(doc);
    render(
      <LayerPanel
        layer={panelLayer(1, labels[0])}
        layer2={panelLayer(2, labels[1])}
        fields={fields}
        contentDrafts={new LayerContentDrafts({ projectId: 1, storyKey: "s" }, () => Promise.resolve(undefined), { debounceMs: 1500, errorMessage: () => "stage.save_failed" })}
        glossary={{ terms: new Map(), baseUrl: "" }}
        objects={[]}
        actionUrl="/"
      />,
    );
    typeLabel(screen.getByRole("button", { name: "layer.edit_button_label_aria" }), "Further still");
    expect(labels[1].toString()).toBe("Further still");
    expect(labelOf(1).toString()).toBe("Further still");
    expect(labels[0].toString()).toBe("Learn more");
    expect(fields.save).not.toHaveBeenCalled();

    replace(peer, labelOf(1), "Their deeper label");
    expect(document.querySelector("[data-layer2-pill]")!.textContent).toBe("Their deeper label →");
  });
});
