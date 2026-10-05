// @vitest-environment jsdom

/**
 * The capture viewer measures a zoom in the authoring frame, through the
 * production function and a real OpenSeadragon `Viewport`.
 *
 * The option is not injected by the fixture: `measureInAuthoringFrame` sets it,
 * from the `open` and `resize` events a real viewer raises through the rig in
 * `helpers/viewport-rig.ts`.
 *
 * The oracle is geometry chosen by the test — the image filling the inscribed
 * frame, a view the test put the viewer in — never the function under test.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import OpenSeadragon from "openseadragon";
import { authoringFrameRect, focalCircle } from "~/lib/authoring-frame";
import {
  AUTHORING_ASPECT,
  CAPTURE_MIN_ZOOM_RATIO,
  FOCAL_DIAMETER_FRAC,
  captureViewportState,
  clampCaptureZoom,
  normalisedToViewport,
} from "~/lib/viewer-utils";
import {
  authoredZoom,
  doViewerResize,
  openRig,
  settle,
  viewportRig,
} from "./helpers/viewport-rig";
import type { Size, ViewportRig } from "./helpers/viewport-rig";

type Rig = ViewportRig;

/** The rig with no region, and `later` registered after the authoring frame. */
const rig = (image: Size, container: Size, later?: (r: Rig) => void) =>
  viewportRig(image, container, undefined, later);
const open = openRig;
const authored = authoredZoom;

/**
 * How much of the inscribed frame the whole image fills, on its limiting axis,
 * in viewport units computed from the container and OSD's zoom alone. 1 is the
 * image exactly filling the frame.
 */
function fillOfFrame(r: Rig, image: Size) {
  const z = r.viewport.getZoom();
  const frame = authoringFrameRect(r.container.x, r.container.y);
  // One viewport unit is the image's width; the pane shows 1 / z of it.
  const unitsPerPx = 1 / z / r.container.x;
  const frameW = frame.width * unitsPerPx;
  const frameH = frame.height * unitsPerPx;
  return Math.max(1 / frameW, image.y / image.x / frameH);
}

describe("measureInAuthoringFrame on open", () => {
  const CASES: Array<{ image: Size; pane: Size; label: string }> = [
    { image: { x: 3000, y: 2000 }, pane: { x: 2000, y: 1000 }, label: "image 1.5 in pane 2.0" },
    { image: { x: 1500, y: 3000 }, pane: { x: 1000, y: 1000 }, label: "portrait 0.5 in a square pane" },
    { image: { x: 2400, y: 3000 }, pane: { x: 1600, y: 800 }, label: "portrait 0.8 in pane 2.0" },
    { image: { x: 3000, y: 3000 }, pane: { x: 800, y: 1000 }, label: "square in pane 0.8" },
  ];

  for (const { image, pane, label } of CASES) {
    it(`opens with the whole image filling the inscribed frame, at zoom 1: ${label}`, () => {
      const r = rig(image, pane);
      open(r);
      expect(authored(r.viewport)).toBeCloseTo(1, 12);
      expect(fillOfFrame(r, image)).toBeCloseTo(1, 9);
    });
  }

  it("is what a later open handler's saved framing is applied against", () => {
    // Capture a detail in one viewer, then open a fresh one whose column
    // applies the saved framing on open, as ViewerColumn's handler does.
    const image = { x: 3000, y: 2000 };
    const pane = { x: 2000, y: 1000 };
    const first = rig(image, pane);
    open(first);
    first.viewport.panTo(new OpenSeadragon.Point(0.3, 0.2), true);
    first.viewport.zoomTo(first.viewport.getHomeZoom() * 3, null as unknown as OpenSeadragon.Point, true);
    settle(first.viewport);
    const wantCentre = first.viewport.getCenter();
    const wantZoom = first.viewport.getZoom();
    const saved = captureViewportState(
      wantCentre, wantZoom, 0,
      first.viewport.getHomeBounds(), first.viewport.getHomeZoom(), first.item
    );
    expect(saved.zoom).toBeCloseTo(3, 12);

    const second = rig(image, pane, (r) => {
      r.viewer.addHandler("open", () => {
        const vp = r.viewport;
        const { point, actualZoom } = normalisedToViewport(
          vp.getHomeBounds(), vp.getHomeZoom(), saved.x, saved.y, clampCaptureZoom(saved.zoom), r.item
        );
        vp.panTo(point as OpenSeadragon.Point, true);
        vp.zoomTo(actualZoom, null as unknown as OpenSeadragon.Point, true);
      });
    });
    open(second);
    expect(second.viewport.getZoom()).toBeCloseTo(wantZoom, 12);
    expect(second.viewport.getCenter().x).toBeCloseTo(wantCentre.x, 12);
    expect(second.viewport.getCenter().y).toBeCloseTo(wantCentre.y, 12);
  });
});

describe("measureInAuthoringFrame on resize", () => {
  const image = { x: 3000, y: 2000 };

  it("keeps a detail's authored zoom and centre when the pane changes shape", async () => {
    const r = rig(image, { x: 2000, y: 1000 });
    open(r);
    r.viewport.panTo(new OpenSeadragon.Point(0.35, 0.3), true);
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 2.5, null as unknown as OpenSeadragon.Point, true);
    settle(r.viewport);
    const centre = r.viewport.getCenter();

    doViewerResize(r, { x: 1000, y: 1000 });
    await Promise.resolve();
    settle(r.viewport);

    expect(authored(r.viewport)).toBeCloseTo(2.5, 12);
    expect(r.viewport.getCenter().x).toBeCloseTo(centre.x, 12);
    expect(r.viewport.getCenter().y).toBeCloseTo(centre.y, 12);
    // And home is the new pane's frame: going there fills it.
    r.viewport.goHome(true);
    settle(r.viewport);
    expect(fillOfFrame(r, image)).toBeCloseTo(1, 9);
  });

  it("keeps a view at the floor on the floor, where OSD's own ratio drops below it", async () => {
    const r = rig(image, { x: 2000, y: 1000 });
    open(r);
    r.viewport.zoomTo(r.viewport.getMinZoom(), null as unknown as OpenSeadragon.Point, true);
    settle(r.viewport);
    const centre = r.viewport.getCenter();
    expect(authored(r.viewport)).toBeCloseTo(CAPTURE_MIN_ZOOM_RATIO, 12);

    doViewerResize(r, { x: 1000, y: 1000 });
    await Promise.resolve();
    settle(r.viewport);

    expect(authored(r.viewport)).toBeCloseTo(CAPTURE_MIN_ZOOM_RATIO, 12);
    expect(r.viewport.getCenter().x).toBeCloseTo(centre.x, 12);
    expect(r.viewport.getCenter().y).toBeCloseTo(centre.y, 12);
  });

  it("does nothing once detached", async () => {
    const r = rig(image, { x: 2000, y: 1000 });
    open(r);
    const home = r.viewport.getHomeZoom();
    r.detach();
    doViewerResize(r, { x: 1000, y: 1000 });
    await Promise.resolve();
    expect(r.viewport.getHomeZoom()).toBe(home);
  });
});

describe("the capture guides' geometry", () => {
  const PANES: Size[] = [
    { x: 2000, y: 1000 },
    { x: 1053, y: 1000 },
    { x: 1000, y: 1000 },
    { x: 800, y: 1000 },
    { x: 600, y: 1200 },
  ];

  for (const pane of PANES) {
    it(`draws a frame of the authoring aspect meeting the ${pane.x}×${pane.y} pane on its limiting axis`, () => {
      const frame = authoringFrameRect(pane.x, pane.y);
      expect(frame.width / frame.height).toBeCloseTo(AUTHORING_ASPECT, 12);
      const wider = pane.x / pane.y > AUTHORING_ASPECT;
      if (wider) {
        expect(frame.height).toBeCloseTo(pane.y, 9);
        expect(frame.y).toBeCloseTo(0, 9);
      } else {
        expect(frame.width).toBeCloseTo(pane.x, 9);
        expect(frame.x).toBeCloseTo(0, 9);
      }
      // Centred.
      expect(frame.x * 2 + frame.width).toBeCloseTo(pane.x, 9);
      expect(frame.y * 2 + frame.height).toBeCloseTo(pane.y, 9);
    });
  }

  it("draws the focal circle only at zoom 2 and above, 0.9 of the frame wide and centred", () => {
    const frame = authoringFrameRect(2000, 1000);
    for (const zoom of [0.1, 1, 1.5, 1.999]) expect(focalCircle(frame, zoom), `zoom ${zoom}`).toBeNull();
    for (const zoom of [2, 3, 12]) {
      const circle = focalCircle(frame, zoom);
      expect(circle, `zoom ${zoom}`).not.toBeNull();
      expect(circle!.radius * 2).toBeCloseTo(FOCAL_DIAMETER_FRAC * frame.width, 12);
      expect(circle!.cx).toBeCloseTo(1000, 12);
      expect(circle!.cy).toBeCloseTo(500, 12);
    }
  });
});
