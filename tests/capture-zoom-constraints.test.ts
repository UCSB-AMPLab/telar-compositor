// @vitest-environment jsdom

/**
 * What holds the capture viewer at its floor, and what that is allowed to cost.
 *
 * `minZoomImageRatio` bounds OpenSeadragon's GESTURES. It does not bound a
 * programmatic `viewport.zoomBy`, which is what the editor's own zoom-out
 * button calls: six clicks from home settle at about 0.0905 of home on an
 * instance whose floor is 0.1, and every capture taken there stored a framing
 * the published story would raise.
 *
 * So the editor's buttons clamp the requested zoom against the viewport's own
 * `getMinZoom()` and `getMaxZoom()`, and then call `applyConstraints()` as OSD's
 * own controls and every gesture do. Its pan bounds move with the zoom, so a
 * centre inside them at one zoom can be outside them at the next; where that
 * happens it is repaired, and the repair is the viewer keeping the image on
 * screen. Both halves are measured here, and so is what the second one prevents:
 * without it a few clicks of zoom-in on an off-centre framing reach a view the
 * image lies entirely outside of.
 *
 * This file drives the real OSD `Viewport` rather than the suite's fake,
 * because the claim is about OSD's behaviour: a fake that modelled the floor
 * would be asserting the test's own arithmetic. `animationTime: 0` settles the
 * springs on the spot — the question is where the zoom LANDS, not how it
 * travels there, and OSD's springs advance on wall-clock time that a test loop
 * cannot supply.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import OpenSeadragon from "openseadragon";
import {
  authoringHomeZoom,
  captureViewportState,
  inscribedFrameHomeZoom,
  publishedFraming,
  AUTHORING_ASPECT,
  CAPTURE_MIN_ZOOM_RATIO,
} from "~/lib/viewer-utils";
import { osdImageItem } from "./helpers/osd-fake";

/** The number of zoom-out clicks that reproduces the drift. */
const CLICKS = 6;
/** The factor the editor's zoom-out button passes. */
const ZOOM_OUT = 0.67;
/** The factor the editor's zoom-in button passes. */
const ZOOM_IN = 1.5;

/** The image the fixture describes. */
const IMAGE = { width: 4000, height: 3000 };

/**
 * A viewport with the capture instance's floor and its home — the image
 * filling the inscribed authoring frame, which `measureInAuthoringFrame` sets
 * as `defaultZoomLevel` when the image opens — and OSD's own defaults for
 * everything else, which `IiifViewer` does not override.
 *
 * `contentSize` in the constructor does not set the content bounds: OSD 6.0.2
 * initialises them to a unit square with a content factor of 1 and waits for
 * `resetContentSize`, which is what the real viewer's tile source triggers. Home
 * zoom, the maximum, and the pan bounds all follow from those bounds, so without
 * the reset the fixture has the geometry of a square rather than of the 4000×3000
 * image it names.
 */
function captureViewport() {
  const d = OpenSeadragon.DEFAULT_SETTINGS;
  const viewport = new OpenSeadragon.Viewport({
    containerSize: new OpenSeadragon.Point(1440, 900),
    contentSize: new OpenSeadragon.Point(IMAGE.width, IMAGE.height),
    minZoomImageRatio: CAPTURE_MIN_ZOOM_RATIO,
    maxZoomPixelRatio: d.maxZoomPixelRatio,
    visibilityRatio: d.visibilityRatio,
    defaultZoomLevel: inscribedFrameHomeZoom(IMAGE.width / IMAGE.height, 1440 / 900),
    minZoomLevel: d.minZoomLevel,
    maxZoomLevel: d.maxZoomLevel,
    springStiffness: d.springStiffness,
    animationTime: 0,
    wrapHorizontal: false,
    wrapVertical: false,
    degrees: 0,
    homeFillsViewer: false,
    silenceMultiImageWarnings: true,
  });
  viewport.resetContentSize(new OpenSeadragon.Point(IMAGE.width, IMAGE.height));
  viewport.goHome(true);
  settle(viewport);
  return viewport;
}

/** Advance the springs to their endpoint. */
function settle(viewport: OpenSeadragon.Viewport) {
  for (let i = 0; i < 20; i += 1) viewport.update();
}

/** One press of a zoom button, as the editor's `zoomConstrained` performs it. */
function clickZoom(viewport: OpenSeadragon.Viewport, factor: number) {
  const requested = viewport.getZoom() * factor;
  viewport.zoomTo(
    Math.min(Math.max(requested, viewport.getMinZoom()), viewport.getMaxZoom())
  );
  viewport.applyConstraints();
  settle(viewport);
}

/** The same press with the constraint left off, for what it is holding. */
function clickZoomUnconstrained(viewport: OpenSeadragon.Viewport, factor: number) {
  const requested = viewport.getZoom() * factor;
  viewport.zoomTo(
    Math.min(Math.max(requested, viewport.getMinZoom()), viewport.getMaxZoom())
  );
  settle(viewport);
}

/** Whether any part of the image — which spans 0…1 across — is in view. */
function imageIsOnScreen(viewport: OpenSeadragon.Viewport): boolean {
  const bounds = viewport.getBounds();
  return bounds.x < 1 && bounds.x + bounds.width > 0;
}

/** `CLICKS` presses of the zoom-out button, with or without the constraint. */
function zoomOutRepeatedly(viewport: OpenSeadragon.Viewport, constrain: boolean) {
  for (let i = 0; i < CLICKS; i += 1) {
    viewport.zoomBy(ZOOM_OUT);
    if (constrain) viewport.applyConstraints();
  }
  settle(viewport);
  return viewport.getZoom() / viewport.getHomeZoom();
}

/**
 * A framing in the letterbox left of the image, at a zoom OSD's own pan
 * constraints accept — `getConstrainedBounds()` leaves its centre where it is at
 * this zoom, and not at the next one: the window narrows around the same centre
 * until no part of the image is inside it.
 */
function offCentreFraming(viewport: OpenSeadragon.Viewport) {
  viewport.panTo(new OpenSeadragon.Point(-0.2, 0.2), true);
  viewport.zoomTo(viewport.getHomeZoom() * 0.8, null as never, true);
  settle(viewport);
  const accepted = viewport.getConstrainedBounds().getCenter();
  expect(accepted.x).toBeCloseTo(-0.2, 9);
  expect(accepted.y).toBeCloseTo(0.2, 9);
  return viewport.getCenter();
}

/**
 * A framing well inside the image, which the pan bounds accept at every zoom
 * between the floor and the maximum.
 */
function interiorFraming(viewport: OpenSeadragon.Viewport) {
  viewport.panTo(new OpenSeadragon.Point(0.35, 0.3), true);
  viewport.zoomTo(viewport.getHomeZoom() * 0.8, null as never, true);
  settle(viewport);
  return viewport.getCenter();
}

describe("the fixture's geometry", () => {
  it("is the named image's, not the unit square the constructor starts from", () => {
    const viewport = captureViewport();
    // OSD normalises content to width 1, so a 4:3 image stands 0.75 high and
    // home is centred on it at 0.375. The unit square the constructor starts
    // from would stand 1 high and centre home at 0.5.
    expect(viewport.getHomeBounds().getCenter().y).toBeCloseTo(
      IMAGE.height / IMAGE.width / 2,
      9
    );
    // Home is the image filling the inscribed authoring frame: a 4:3 image is
    // wider than the frame, so it fills the frame's width, which is
    // AUTHORING_ASPECT / 1.6 of the 1440×900 pane's.
    const paneAspect = 1440 / 900;
    expect(viewport.getHomeBounds().width * (AUTHORING_ASPECT / paneAspect)).toBeCloseTo(1, 12);
    // And the maximum is well above home, as it is for a real tiled image —
    // without the reset it collapses onto home and no zoom-in is possible.
    expect(viewport.getMaxZoom()).toBeGreaterThan(viewport.getHomeZoom() * 3);
    expect(viewport.getMinZoom()).toBeCloseTo(
      viewport.getHomeZoom() * CAPTURE_MIN_ZOOM_RATIO,
      12
    );
  });
});

describe("OSD's minZoomImageRatio against the editor's own zoom control", () => {
  it("does not bound a programmatic zoomBy — the floor is passed straight through", () => {
    const ratio = zoomOutRepeatedly(captureViewport(), false);
    expect(ratio).toBeLessThan(CAPTURE_MIN_ZOOM_RATIO);
    // The exact landing place, so a change in OSD's own arithmetic is visible
    // here rather than only as "still below the floor".
    expect(ratio).toBeCloseTo(0.0904583, 6);
  });

  it("holds the floor however far past it the author keeps clicking", () => {
    const viewport = captureViewport();
    for (let i = 0; i < CLICKS * 4; i += 1) {
      clickZoom(viewport, ZOOM_OUT);
      expect(viewport.getZoom() / viewport.getHomeZoom()).toBeGreaterThanOrEqual(
        CAPTURE_MIN_ZOOM_RATIO - 1e-12
      );
    }
    expect(viewport.getZoom() / viewport.getHomeZoom()).toBeCloseTo(
      CAPTURE_MIN_ZOOM_RATIO,
      10
    );
  });
});

describe("what the pan constraint does to the author's centre", () => {
  it("leaves a framing the new zoom still accepts exactly where it is", () => {
    // The constraint is not a re-centring. Where the framing is inside the pan
    // bounds at the zoom being asked for, the author's centre survives the
    // click to the last place the double can carry.
    const viewport = captureViewport();
    const before = interiorFraming(viewport);
    for (const factor of [ZOOM_IN, ZOOM_IN, ZOOM_OUT]) {
      clickZoom(viewport, factor);
      expect(viewport.getCenter().x).toBeCloseTo(before.x, 12);
      expect(viewport.getCenter().y).toBeCloseTo(before.y, 12);
    }
  });

  it("repairs a framing the new zoom does not accept, rather than leave it showing nothing", () => {
    // A moved centre here is the viewer keeping the image on screen. The pan
    // bounds narrow with the zoom, so this framing — acceptable at 0.8 of home,
    // as `offCentreFraming` checks — is outside them at 1.2, and the repair puts
    // the image back in front of the author.
    const viewport = captureViewport();
    const before = offCentreFraming(viewport);
    clickZoom(viewport, ZOOM_IN);
    expect(viewport.getCenter().x).not.toBeCloseTo(before.x, 3);
    // Where it lands: OSD's `visibilityRatio` of 0.5 keeps half the image's
    // width in view, so the window's right edge stops at 0.5.
    expect(viewport.getCenter().x).toBeCloseTo(0.5 - viewport.getBounds().width / 2, 9);
    expect(imageIsOnScreen(viewport)).toBe(true);
  });

  it("without it, that framing zooms in until no part of the image is in view", () => {
    // What the repair above is holding. Four clicks leave the centre
    // untouched, and the window there is entirely inside the letterbox: bounds
    // x of -0.3876 to -0.0124, against an image spanning 0 to 1.
    const viewport = captureViewport();
    offCentreFraming(viewport);
    for (let i = 0; i < 4; i += 1) clickZoomUnconstrained(viewport, ZOOM_IN);
    const bounds = viewport.getBounds();
    expect(bounds.x).toBeCloseTo(-0.387589, 6);
    expect(bounds.x + bounds.width).toBeCloseTo(-0.012411, 6);
    expect(imageIsOnScreen(viewport)).toBe(false);

    // A capture taken there is measured on the image, and its centre is held
    // to the image's left edge: a framing the site renders, rather than one
    // outside the 0…1 the framework's `_isSane` bounds x to.
    const onImage = captureViewportState(
      viewport.getCenter(),
      viewport.getZoom(),
      0,
      viewport.getHomeBounds(),
      viewport.getHomeZoom(),
      osdImageItem(IMAGE.width, IMAGE.height)
    );
    expect(onImage.x).toBe(0);
    expect(publishedFraming(onImage)).not.toBeNull();
  });

  it("still stops a pull-back at the floor, with the centre it was given", () => {
    const viewport = captureViewport();
    const before = interiorFraming(viewport);
    for (let i = 0; i < CLICKS * 2; i += 1) clickZoom(viewport, ZOOM_OUT);
    expect(viewport.getZoom() / viewport.getHomeZoom()).toBeCloseTo(
      CAPTURE_MIN_ZOOM_RATIO,
      10
    );
    expect(viewport.getCenter().x).toBeCloseTo(before.x, 12);
    expect(viewport.getCenter().y).toBeCloseTo(before.y, 12);
  });

  it("does not let the author zoom past the instance's own maximum", () => {
    const viewport = captureViewport();
    for (let i = 0; i < 20; i += 1) clickZoom(viewport, ZOOM_IN);
    expect(viewport.getZoom()).toBeCloseTo(viewport.getMaxZoom(), 10);
  });
});

/**
 * The zoom arithmetic of a home set to the inscribed authoring frame, over a
 * grid of image and pane shapes. The home is set on the fixture here, so this
 * checks the arithmetic, not the wiring: that `measureInAuthoringFrame` sets it
 * is tested through a real viewport in tests/capture-authoring-frame.test.ts.
 *
 * The oracle is the inscribed frame's width in image pixels, computed from the
 * container size and OSD's zoom alone, against replay's reading of the
 * captured zoom: `frameWidthImg = W / (authoringHomeZoom(ia) · zoom)`
 * (`computeFocalTarget`, framework `iiif-card.js`).
 */
describe("a zoom measured against the inscribed frame's home is the width replay reads", () => {
  const W = 3000;
  const IMAGE_ASPECTS = [0.5, 0.8, 1, 1.5, 2];
  const PANES = [
    { x: 800, y: 1000 },
    { x: 1000, y: 1000 },
    { x: 1053, y: 1000 },
    { x: 1500, y: 1000 },
    { x: 2000, y: 1000 },
  ];

  function framedViewport(ia: number, pane: { x: number; y: number }) {
    const d = OpenSeadragon.DEFAULT_SETTINGS;
    const H = W / ia;
    const viewport = new OpenSeadragon.Viewport({
      containerSize: new OpenSeadragon.Point(pane.x, pane.y),
      contentSize: new OpenSeadragon.Point(W, H),
      minZoomImageRatio: CAPTURE_MIN_ZOOM_RATIO,
      maxZoomPixelRatio: d.maxZoomPixelRatio,
      visibilityRatio: d.visibilityRatio,
      defaultZoomLevel: inscribedFrameHomeZoom(ia, pane.x / pane.y),
      minZoomLevel: d.minZoomLevel,
      maxZoomLevel: d.maxZoomLevel,
      springStiffness: d.springStiffness,
      animationTime: 0,
      wrapHorizontal: false,
      wrapVertical: false,
      degrees: 0,
      homeFillsViewer: false,
      silenceMultiImageWarnings: true,
    });
    viewport.resetContentSize(new OpenSeadragon.Point(W, H));
    viewport.goHome(true);
    settle(viewport);
    return viewport;
  }

  for (const ia of IMAGE_ASPECTS) {
    for (const pane of PANES) {
      it(`image ${ia} in a ${pane.x}×${pane.y} pane`, () => {
        const viewport = framedViewport(ia, pane);
        const paneAspect = pane.x / pane.y;
        expect(viewport.getZoom() / viewport.getHomeZoom()).toBeCloseTo(1, 12);

        for (const k of [0.5, 1, 2, 8]) {
          const Z = viewport.getHomeZoom() * k;
          viewport.zoomTo(Z, null as never, true);
          settle(viewport);
          const captured = captureViewportState(
            viewport.getCenter(), viewport.getZoom(), 0,
            viewport.getHomeBounds(), viewport.getHomeZoom()
          );
          // The pane shows 1 / Z of the image's width; the frame is the pane's
          // width, or AUTHORING_ASPECT / paneAspect of it in a wider pane.
          const frameImg = (W / viewport.getZoom()) * Math.min(1, AUTHORING_ASPECT / paneAspect);
          const replayImg = W / (authoringHomeZoom(ia) * captured.zoom);
          expect(replayImg / frameImg, `at ${k} times home`).toBeCloseTo(1, 9);
        }

        expect(viewport.getMinZoom() / viewport.getHomeZoom()).toBeCloseTo(CAPTURE_MIN_ZOOM_RATIO, 12);
      });
    }
  }
});
