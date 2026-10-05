// @vitest-environment jsdom
/**
 * layer-panel-switch.test.tsx — a panel is keyed by its layer's `keyFor` key
 * (StagePanels): switching the layer a panel shows gives a fresh panel with
 * the new layer's title, and a layer that keeps its key (the worker assigning
 * its database id) keeps its panel, with whatever the panel holds.
 *
 * The route builds each panel's layer with `keyFor` (item-key.ts): its temp id
 * for the map's whole life where it has one, else its database id. A source
 * pin checks that the route keys the stage's layers that way, since a key is
 * a reconciliation instruction no mounted output shows on its own.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { StagePanels, type StagePanelLayer } from "~/components/features/editor/StagePanels";
import { stageGeometryOf } from "~/hooks/use-stage-geometry";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn() } }),
}));

function layer(key: string, id: number, title: string): StagePanelLayer {
  return {
    key,
    id,
    layer_number: 1,
    title,
    button_label: "Learn more",
    content: null,
    titleYText: null,
    contentYText: null,
    buttonLabelYText: null,
    canDelete: true,
  };
}

/** A panel whose own state starts from its layer's title, as the fields' drafts do. */
function Panel({ title }: { title: string | null }) {
  const [held] = useState(title);
  return <p data-testid="held">{held}</p>;
}

function mount(layer1: StagePanelLayer) {
  const geometry = stageGeometryOf({ w: 1240, h: 768 }, { w: 1440, h: 900 })!;
  const panels = (l: StagePanelLayer) => (
    <StagePanels
      geometry={geometry}
      selectionKey="id:11"
      layer1={l}
      layer2={null}
      level={1}
      request={{ opener: null, focus: false }}
      onClose={() => {}}
      onDelete={() => {}}
      renderPanel={(shown) => <Panel title={shown.title} />}
    />
  );
  const view = render(panels(layer1));
  return { rerender: (l: StagePanelLayer) => view.rerender(panels(l)) };
}

describe("StagePanels: a panel's key", () => {
  it("gives a panel for another layer its own state", () => {
    const { rerender } = mount(layer("10", 10, "A title"));
    expect(screen.getByTestId("held").textContent).toBe("A title");
    rerender(layer("20", 20, "B title"));
    expect(screen.getByTestId("held").textContent).toBe("B title");
  });

  it("keeps the panel of a layer whose database id is assigned under its temp id", () => {
    const { rerender } = mount(layer("temp-a", 0, "Draft title"));
    const before = screen.getByTestId("stage-panel-1");
    rerender(layer("temp-a", 99, "Stored title"));
    expect(screen.getByTestId("stage-panel-1")).toBe(before);
    expect(screen.getByTestId("held").textContent).toBe("Draft title");
  });
});

describe("the route keys the stage's layers by keyFor (source pin)", () => {
  const source = readFileSync(join(process.cwd(), "app/routes/_app.stories.$storyId.tsx"), "utf-8");

  it("builds each panel's layer with key: keyFor(layer)", () => {
    const at = source.indexOf("const stagePanelLayer =");
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, source.indexOf("};", at));
    expect(body).toContain("key: keyFor(layer)");
  });
});
