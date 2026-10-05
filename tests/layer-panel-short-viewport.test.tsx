// @vitest-environment jsdom
/**
 * layer-panel-short-viewport.test.tsx — a layer panel in a short window.
 *
 * The panel is drawn at the visitor's size, so a short window is a short
 * panel only as the site's is: it takes the window's full height above the
 * vertical layout, as Bootstrap's `.offcanvas-end` does, and its body scrolls
 * under the header, as `.offcanvas-body` does. The editor's own compaction of
 * the old panel's rows on a short screen went with those rows.
 *
 * jsdom lays nothing out and applies no CSS, so the scrolling is checked as
 * the rules that carry it; seeing it scroll is the browser pass's.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StagePanels, type StagePanelLayer } from "~/components/features/editor/StagePanels";
import { stageGeometryOf } from "~/hooks/use-stage-geometry";
import { panelBox } from "~/lib/framing-stage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn() } }),
}));

const layer: StagePanelLayer = {
  key: "1",
  id: 1,
  layer_number: 1,
  title: "Weaving Techniques",
  button_label: "Learn more",
  content: "Some content",
  titleYText: null,
  contentYText: null,
  buttonLabelYText: null,
  canDelete: true,
};

const css = readFileSync(join(process.cwd(), "app/styles/visitor-layer.css"), "utf8");
const ruleOf = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
};

describe("a layer panel in a short window", () => {
  it("takes the window's full height, as the site's panel does", () => {
    const win = { w: 1440, h: 520 };
    render(
      <StagePanels
        geometry={stageGeometryOf({ w: 1240, h: 400 }, win)!}
        selectionKey="id:11"
        layer1={layer}
        layer2={null}
        level={1}
        request={{ opener: null, focus: false }}
        onClose={() => {}}
        onDelete={() => {}}
        renderPanel={() => <p>content</p>}
      />,
    );
    const panel = screen.getByTestId("stage-panel-1");
    expect(parseFloat(panel.style.top)).toBe(0);
    expect(parseFloat(panel.style.height)).toBe(win.h);
    expect(panelBox(1, win.w, win.h).h).toBe(win.h);
    // Nothing of the old panel's short-screen compaction is left.
    expect(panel.outerHTML).not.toContain("editor-short:");
  });

  it("scrolls its body under the header, a column of the two", () => {
    expect(ruleOf(".visitor-layer .offcanvas")).toContain("flex-direction: column");
    const body = ruleOf(".visitor-layer .offcanvas-body");
    expect(body).toContain("flex: 1 1 auto");
    expect(body).toContain("overflow-y: auto");
  });
});
