/**
 * Tests for captureViewportState and the position conversions under it.
 *
 * A stored x and y are fractions of the image. The oracle in every case is the
 * image point the test chose, never the function under test.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  captureViewportState,
  normalisedToViewport,
  viewportToNormalised,
  authoringHomeZoom,
  inscribedFrameHomeZoom,
  AUTHORING_ASPECT,
} from "~/lib/viewer-utils";
import { osdImageItem as fakeItem } from "./helpers/osd-fake";

describe("captureViewportState", () => {
  it("returns correct x, y, zoom values from viewport center", () => {
    // At 2 and above replay places the stored point itself, so the centre is
    // stored as it is; below 2 see captureFocal.
    const result = captureViewportState({ x: 0.5, y: 0.3 }, 2.75, 0);
    expect(result.x).toBe(0.5);
    expect(result.y).toBe(0.3);
    expect(result.zoom).toBe(2.75);
  });

  it("converts 0-based pageIndex to 1-indexed page string", () => {
    const result = captureViewportState({ x: 0.5, y: 0.5 }, 1, 0);
    expect(result.page).toBe("1");
  });

  it("converts pageIndex 1 to page '2'", () => {
    const result = captureViewportState({ x: 0.5, y: 0.5 }, 1, 1);
    expect(result.page).toBe("2");
  });

  it("converts pageIndex 4 to page '5'", () => {
    const result = captureViewportState({ x: 0.2, y: 0.8 }, 2.5, 4);
    expect(result.page).toBe("5");
  });

  it("uses '1' when pageIndex is null (single-page object)", () => {
    const result = captureViewportState({ x: 0.5, y: 0.5 }, 1, null);
    expect(result.page).toBe("1");
  });

  it("returns fractional coordinates with full precision", () => {
    const result = captureViewportState({ x: 0.123456789, y: 0.987654321 }, 3.14159, 0);
    expect(result.x).toBeCloseTo(0.123456789, 8);
    expect(result.y).toBeCloseTo(0.987654321, 8);
    expect(result.zoom).toBeCloseTo(3.14159, 4);
  });
});

/**
 * OSD's home view for a one-unit-wide image of aspect `ia` in a pane of aspect
 * `pane` (`getHomeBoundsNoRotate`): centred on the image, `1 / home` wide and
 * pane-shaped, so the letterbox is inside it. This is the rectangle the old
 * conversion measured on.
 */
function paneHomeBounds(ia: number, pane: number) {
  const home = Math.min(1, ia / pane);
  const width = 1 / home;
  const height = width / pane;
  return { x: 0.5 - width / 2, y: 0.5 / ia - height / 2, width, height };
}

describe("position is measured on the image, whatever the pane's shape", () => {
  const IMAGE_ASPECTS = [0.5, 0.8, 1, 1.5, 2];
  const PANE_ASPECTS = [0.8, 1, 1.053, 1.5, 2];
  // Off-centre on both axes, and both sides of the centre.
  const POINTS = [
    { u: 0.25, v: 0.25 },
    { u: 0.8, v: 0.3 },
    { u: 0.1, v: 0.9 },
  ];
  const W = 3000;

  for (const ia of IMAGE_ASPECTS) {
    for (const pane of PANE_ASPECTS) {
      it(`captures and restores the chosen image point, image ${ia} in pane ${pane}`, () => {
        const H = W / ia;
        const item = fakeItem(W, H);
        const home = paneHomeBounds(ia, pane);
        for (const { u, v } of POINTS) {
          // The viewport point that shows image point (u, v): the image is one
          // unit wide and `1 / ia` high from the origin.
          const vp = { x: u, y: v / ia };
          // At zoom 2, where the stored point is the view's centre.
          const captured = captureViewportState(vp, 2, 0, home, 1, item);
          expect(captured.x, `u at (${u}, ${v})`).toBeCloseTo(u, 9);
          expect(captured.y, `v at (${u}, ${v})`).toBeCloseTo(v, 9);

          const restored = normalisedToViewport(home, 1, u, v, 1, item);
          expect(restored.point.x, `restored x at (${u}, ${v})`).toBeCloseTo(vp.x, 9);
          expect(restored.point.y, `restored y at (${u}, ${v})`).toBeCloseTo(vp.y, 9);
        }
      });
    }
  }

  it("follows the item wherever it is placed, not the unit square", () => {
    // A tiled image OSD has positioned away from the origin and scaled.
    const item = fakeItem(2000, 1000, { x: 0.3, y: -0.2 }, 2.5);
    const home = paneHomeBounds(2, 1);
    const vp = item.imageToViewportCoordinates(0.7 * 2000, 0.4 * 1000);
    const captured = viewportToNormalised(home, 1, vp.x, vp.y, 1, item);
    expect(captured.x).toBeCloseTo(0.7, 9);
    expect(captured.y).toBeCloseTo(0.4, 9);
  });

  it("holds a centre in the letterbox to the nearest edge of the image", () => {
    // Image 1.5 in a square pane: left of the image and above it.
    const item = fakeItem(3000, 2000);
    const home = paneHomeBounds(1.5, 1);
    const captured = viewportToNormalised(home, 1, -0.1, -0.05, 1, item);
    expect(captured).toEqual({ x: 0, y: 0, zoom: 1 });
    const beyond = viewportToNormalised(home, 1, 1.2, 0.9, 1, item);
    expect(beyond.x).toBe(1);
    expect(beyond.y).toBe(1);
  });

  it("keeps the home-bounds reading where there is no item yet", () => {
    const home = { x: -0.25, y: 0, width: 1.5, height: 1 };
    expect(viewportToNormalised(home, 2, 0.5, 0.25, 4)).toEqual({ x: 0.5, y: 0.25, zoom: 2 });
    expect(viewportToNormalised(home, 2, 0.5, 0.25, 4, null)).toEqual({ x: 0.5, y: 0.25, zoom: 2 });
    expect(normalisedToViewport(home, 2, 0.5, 0.25, 2).point).toEqual({ x: 0.5, y: 0.25 });
  });
});

describe("the authoring frame's home zoom", () => {
  it("is the framework's fit: width for an image wider than the frame, height otherwise", () => {
    expect(authoringHomeZoom(1.5)).toBe(1);
    expect(authoringHomeZoom(AUTHORING_ASPECT)).toBe(1);
    expect(authoringHomeZoom(0.5)).toBeCloseTo(0.5 / 1.053, 12);
  });

  it("is the authoring home in a pane no wider than the frame, and scaled down in a wider one", () => {
    expect(inscribedFrameHomeZoom(0.5, 0.8)).toBeCloseTo(authoringHomeZoom(0.5), 12);
    expect(inscribedFrameHomeZoom(1.5, 1.053)).toBe(1);
    // A 2:1 pane: the frame is 1.053 / 2 of its width.
    expect(inscribedFrameHomeZoom(1.5, 2)).toBeCloseTo(1.053 / 2, 12);
    expect(inscribedFrameHomeZoom(0.5, 2)).toBeCloseTo((0.5 / 1.053) * (1.053 / 2), 12);
  });
});
