// @vitest-environment jsdom

/**
 * The capture viewer confined to the region beside or above the card, through
 * the production functions and a real OpenSeadragon `Viewport` with margins.
 *
 * The region a published page frames the image into is `regionOf` of the
 * visitor's layout. The capture viewer is given OSD viewport margins that
 * leave only that region, so OSD's centre, zoom and home all refer to it. The
 * oracles are geometry the test states — the region's centre in pane pixels,
 * the image filling the frame inscribed in the region — read back through
 * OSD's own pixel mapping, never through the function under test.
 *
 * On resize the margins must be recomputed inside OSD's `resize` event, before
 * the new home is set and before OSD's own fit that follows the event. Two
 * handlers registered after the authoring frame observe that order directly:
 * one reads the home zoom in the same `resize` event, one reads the margins in
 * `after-resize`, which OSD raises once its fit has run.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import OpenSeadragon from "openseadragon";
import { authoringFrameRect, regionMargins } from "~/lib/authoring-frame";
import type { RegionOf } from "~/lib/authoring-frame";
import { regionOf, visitorLayout } from "~/lib/framing-stage";
import type { Box } from "~/lib/framing-stage";
import {
  CAPTURE_MIN_ZOOM_RATIO,
  captureViewportState,
  inscribedFrameHomeZoom,
} from "~/lib/viewer-utils";
import {
  authoredZoom,
  doViewerResize,
  openRig,
  settle,
  viewportRig,
} from "./helpers/viewport-rig";
import type { Size, ViewportRig } from "./helpers/viewport-rig";

/** The pane is a visitor's window at scale 1: its region is the framework's. */
const windowRegion: RegionOf = (pane) => regionOf(visitorLayout(pane.w, pane.h), pane.w, pane.h);

function regionFor(pane: Size): Box {
  return windowRegion({ w: pane.x, h: pane.y }) as Box;
}

const WINDOWS: Size[] = [
  { x: 1440, y: 757 },
  { x: 1280, y: 1024 },
  { x: 1100, y: 800 },
  { x: 390, y: 844 },
];

const IMAGES: Array<{ aspect: number; size: Size }> = [
  { aspect: 0.5, size: { x: 1500, y: 3000 } },
  { aspect: 1.0, size: { x: 3000, y: 3000 } },
  { aspect: 1.5, size: { x: 3000, y: 2000 } },
];

/** Where OSD draws viewport point `p`, in pane pixels. */
function pixelOf(r: ViewportRig, p: { x: number; y: number }) {
  return r.viewport.pixelFromPoint(new OpenSeadragon.Point(p.x, p.y), true);
}

/** The image's drawn rectangle in pane pixels: one viewport unit wide, at the origin. */
function imagePixels(r: ViewportRig, image: Size) {
  const tl = pixelOf(r, { x: 0, y: 0 });
  const br = pixelOf(r, { x: 1, y: image.y / image.x });
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}

/** The region's margins as the viewport holds them now, against the pane's. */
function expectMarginsFor(r: ViewportRig, pane: Size, label: string) {
  const want = regionMargins({ w: pane.x, h: pane.y }, regionFor(pane));
  const got = r.viewport.getMargins() as Record<string, number>;
  for (const side of ["left", "top", "right", "bottom"] as const) {
    expect(got[side], `${label} margin ${side}`).toBeCloseTo(want[side], 9);
  }
}

/** The viewport's centre is drawn at the region's centre. */
function expectCentreAtRegionCentre(r: ViewportRig, pane: Size, label: string) {
  const region = regionFor(pane);
  const drawn = pixelOf(r, r.viewport.getCenter(true));
  expect(drawn.x, `${label} centre x`).toBeCloseTo(region.x + region.w / 2, 6);
  expect(drawn.y, `${label} centre y`).toBeCloseTo(region.y + region.h / 2, 6);
}

/** Home is the whole image filling the frame inscribed in the region, centred in it. */
function expectHomeFillsRegionFrame(r: ViewportRig, image: Size, pane: Size, label: string) {
  const region = regionFor(pane);
  const frame = authoringFrameRect(region.w, region.h);
  const drawn = imagePixels(r, image);
  const aspect = image.x / image.y;
  expect(drawn.w, `${label} image width`).toBeCloseTo(Math.min(frame.width, frame.height * aspect), 6);
  expect(drawn.x + drawn.w / 2, `${label} image centre x`).toBeCloseTo(region.x + region.w / 2, 6);
  expect(drawn.y + drawn.h / 2, `${label} image centre y`).toBeCloseTo(region.y + region.h / 2, 6);
}

describe("the capture viewer confined to the region, on open", () => {
  for (const pane of WINDOWS) {
    for (const { aspect, size } of IMAGES) {
      const label = `${pane.x}×${pane.y}, image ${aspect}`;
      it(`measures in the region and opens filling its frame: ${label}`, () => {
        const r = viewportRig(size, pane, windowRegion);
        openRig(r);
        expectMarginsFor(r, pane, label);
        expect(authoredZoom(r.viewport), label).toBeCloseTo(1, 12);
        expectCentreAtRegionCentre(r, pane, label);
        expectHomeFillsRegionFrame(r, size, pane, label);
        // goHome, the `0` key's target, lands in the same place.
        r.viewport.zoomTo(r.viewport.getHomeZoom() * 3, null as unknown as OpenSeadragon.Point, true);
        r.viewport.goHome(true);
        settle(r.viewport);
        expectHomeFillsRegionFrame(r, size, pane, `${label} after goHome`);
      });
    }
  }

  it("captures the image point drawn at the region's centre, with the zoom in the region's frame", () => {
    const image = { x: 3000, y: 2000 };
    for (const pane of WINDOWS) {
      const r = viewportRig(image, pane, windowRegion);
      openRig(r);
      const target = r.item.imageToViewportCoordinates(0.3 * image.x, 0.6 * image.y);
      r.viewport.zoomTo(r.viewport.getHomeZoom() * 3, null as unknown as OpenSeadragon.Point, true);
      r.viewport.panTo(new OpenSeadragon.Point(target.x, target.y), true);
      settle(r.viewport);
      const label = `${pane.x}×${pane.y}`;
      const drawn = pixelOf(r, target);
      const region = regionFor(pane);
      expect(drawn.x, label).toBeCloseTo(region.x + region.w / 2, 6);
      expect(drawn.y, label).toBeCloseTo(region.y + region.h / 2, 6);
      const vp = r.viewport;
      const captured = captureViewportState(
        vp.getCenter(), vp.getZoom(), 0, vp.getHomeBounds(), vp.getHomeZoom(), r.item
      );
      expect(captured.x, label).toBeCloseTo(0.3, 12);
      expect(captured.y, label).toBeCloseTo(0.6, 12);
      expect(captured.zoom, label).toBeCloseTo(3, 12);
    }
  });
});

describe("the capture viewer confined to the region, on resize", () => {
  const image = { x: 3000, y: 2000 };
  const from = { x: 1440, y: 757 };
  const to = { x: 1280, y: 1024 };

  // Both directions: a region narrower than the authoring aspect gives the same
  // home zoom whatever its width, so only the move into a wider region shows
  // a home set against the old margins.
  for (const [a, b] of [[from, to], [to, from]] as const) {
    it(`recomputes the margins before home is set and before OSD's own fit: ${a.x}×${a.y} to ${b.x}×${b.y}`, async () => {
      const seen: { homeZoom?: number; margins?: Record<string, number> } = {};
      const r = viewportRig(image, a, windowRegion, (rig) => {
        rig.viewer.addHandler("resize", () => {
          seen.homeZoom = rig.viewport.getHomeZoom();
        });
        rig.viewer.addHandler("after-resize", () => {
          seen.margins = rig.viewport.getMargins() as Record<string, number>;
        });
      });
      openRig(r);
      doViewerResize(r, b);
      const region = regionFor(b);
      expect(seen.homeZoom).toBeCloseTo(inscribedFrameHomeZoom(image.x / image.y, region.w / region.h), 12);
      const want = regionMargins({ w: b.x, h: b.y }, region);
      for (const side of ["left", "top", "right", "bottom"] as const) {
        expect(seen.margins?.[side], `after-resize margin ${side}`).toBeCloseTo(want[side], 9);
      }
      await Promise.resolve();
      settle(r.viewport);
      expectMarginsFor(r, b, "settled");
    });
  }

  it("keeps a detail's authored zoom and centre, drawn at the new region's centre", async () => {
    const r = viewportRig(image, from, windowRegion);
    openRig(r);
    r.viewport.panTo(new OpenSeadragon.Point(0.35, 0.3), true);
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 2.5, null as unknown as OpenSeadragon.Point, true);
    settle(r.viewport);
    const centre = r.viewport.getCenter();

    doViewerResize(r, to);
    await Promise.resolve();
    settle(r.viewport);

    expect(authoredZoom(r.viewport)).toBeCloseTo(2.5, 12);
    expect(r.viewport.getCenter().x).toBeCloseTo(centre.x, 12);
    expect(r.viewport.getCenter().y).toBeCloseTo(centre.y, 12);
    expectCentreAtRegionCentre(r, to, "resized");
    r.viewport.goHome(true);
    settle(r.viewport);
    expectHomeFillsRegionFrame(r, image, to, "resized home");
  });

  it("keeps a view at the zoom floor on the floor", async () => {
    const r = viewportRig(image, from, windowRegion);
    openRig(r);
    r.viewport.zoomTo(r.viewport.getMinZoom(), null as unknown as OpenSeadragon.Point, true);
    settle(r.viewport);
    const centre = r.viewport.getCenter();
    expect(authoredZoom(r.viewport)).toBeCloseTo(CAPTURE_MIN_ZOOM_RATIO, 12);
    const vp = r.viewport;
    expect(
      captureViewportState(vp.getCenter(), vp.getZoom(), 0, vp.getHomeBounds(), vp.getHomeZoom(), r.item).zoom
    ).toBeCloseTo(CAPTURE_MIN_ZOOM_RATIO, 12);

    doViewerResize(r, to);
    await Promise.resolve();
    settle(r.viewport);

    expect(authoredZoom(r.viewport)).toBeCloseTo(CAPTURE_MIN_ZOOM_RATIO, 12);
    expect(r.viewport.getCenter().x).toBeCloseTo(centre.x, 12);
    expect(r.viewport.getCenter().y).toBeCloseTo(centre.y, 12);
    expectMarginsFor(r, to, "floor");
    expectCentreAtRegionCentre(r, to, "floor");
  });

  it("follows the region across a layout flip, from beside the card to above it and back", async () => {
    const wide = { x: 1440, y: 757 };
    const phone = { x: 390, y: 844 };
    expect(visitorLayout(wide.x, wide.y).mode).toBe("horizontal");
    expect(visitorLayout(phone.x, phone.y).mode).toBe("vertical");

    const r = viewportRig(image, wide, windowRegion);
    openRig(r);
    r.viewport.panTo(new OpenSeadragon.Point(0.6, 0.4), true);
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 4, null as unknown as OpenSeadragon.Point, true);
    settle(r.viewport);
    const centre = r.viewport.getCenter();

    for (const [pane, label] of [[phone, "vertical"], [wide, "horizontal again"]] as const) {
      doViewerResize(r, pane);
      await Promise.resolve();
      settle(r.viewport);
      expectMarginsFor(r, pane, label);
      expect(authoredZoom(r.viewport), label).toBeCloseTo(4, 12);
      expect(r.viewport.getCenter().x, label).toBeCloseTo(centre.x, 12);
      expect(r.viewport.getCenter().y, label).toBeCloseTo(centre.y, 12);
      expectCentreAtRegionCentre(r, pane, label);
    }
  });

  it("leaves the margins alone for a viewer with no region", async () => {
    const r = viewportRig(image, from);
    openRig(r);
    doViewerResize(r, to);
    await Promise.resolve();
    expect(r.viewport.getMargins()).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});

describe("regionMargins", () => {
  it("leaves the region as the pane less the four margins", () => {
    expect(regionMargins({ w: 1000, h: 800 }, { x: 400, y: 0, w: 600, h: 800 }))
      .toEqual({ left: 400, top: 0, right: 0, bottom: 0 });
    expect(regionMargins({ w: 390, h: 844 }, { x: 0, y: 0, w: 390, h: 490.4 }).bottom)
      .toBeCloseTo(353.6, 9);
    expect(regionMargins({ w: 1000, h: 800 }, { x: 100, y: 50, w: 700, h: 600 }))
      .toEqual({ left: 100, top: 50, right: 200, bottom: 150 });
  });

  it("gives no margins for no region, and none below zero for a region past the pane", () => {
    expect(regionMargins({ w: 1000, h: 800 }, null)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    expect(regionMargins({ w: 1000, h: 800 }, { x: -10, y: -10, w: 1100, h: 900 }))
      .toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});
