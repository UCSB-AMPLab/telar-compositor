// @vitest-environment jsdom

/**
 * A region that changes while the capture viewer's pane keeps its size.
 *
 * OSD recomputes nothing unless its container resizes, so the margins the
 * viewer was confined with would go on describing the old region: a media
 * step's card, or the visitor's layout crossing a breakpoint while the stage
 * keeps its pixels. `reconfine` moves the margins to the region in force and
 * keeps the authored zoom and centre, as a resize does. The oracles are the
 * region's own geometry read back through OSD's pixel mapping on a real
 * `Viewport`, never through the function under test.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import OpenSeadragon from "openseadragon";
import { authoringFrameRect, reconfine, regionMargins } from "~/lib/authoring-frame";
import type { RegionOf } from "~/lib/authoring-frame";
import { regionOf, visitorLayout } from "~/lib/framing-stage";
import { authoredZoom, openRig, settle, viewportRig } from "./helpers/viewport-rig";

const pane = { x: 800, y: 1000 };
const image = { x: 3000, y: 2000 };

/** The region beside a side card, and the band above a bottom card, of a pane-sized window. */
const beside: RegionOf = (p) => regionOf({ mode: "horizontal", cardPlacement: "side" }, p.w, p.h);
const above: RegionOf = (p) => regionOf(visitorLayout(p.w, p.h), p.w, p.h);

function pixelOf(viewport: OpenSeadragon.Viewport, p: { x: number; y: number }) {
  return viewport.pixelFromPoint(new OpenSeadragon.Point(p.x, p.y), true);
}

describe("reconfine", () => {
  it("moves the margins to the new region and keeps the authored zoom and centre, drawn at its centre", () => {
    let current: RegionOf = beside;
    const r = viewportRig(image, pane, (p) => current(p));
    openRig(r);
    r.viewport.panTo(new OpenSeadragon.Point(0.4, 0.3), true);
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 3, null as unknown as OpenSeadragon.Point, true);
    settle(r.viewport);
    const centre = r.viewport.getCenter();

    current = above;
    expect(reconfine(r.viewer, current)).toBe(true);
    settle(r.viewport);

    const region = above({ w: pane.x, h: pane.y })!;
    expect(region.h).toBeLessThan(pane.y);
    expect(r.viewport.getMargins()).toEqual(regionMargins({ w: pane.x, h: pane.y }, region));
    expect(authoredZoom(r.viewport)).toBeCloseTo(3, 12);
    expect(r.viewport.getCenter().x).toBeCloseTo(centre.x, 12);
    expect(r.viewport.getCenter().y).toBeCloseTo(centre.y, 12);
    const drawn = pixelOf(r.viewport, r.viewport.getCenter(true));
    expect(drawn.x).toBeCloseTo(region.x + region.w / 2, 6);
    expect(drawn.y).toBeCloseTo(region.y + region.h / 2, 6);

    // Home is the image filling the frame inscribed in the new region.
    r.viewport.goHome(true);
    settle(r.viewport);
    const frame = authoringFrameRect(region.w, region.h);
    const tl = pixelOf(r.viewport, { x: 0, y: 0 });
    const br = pixelOf(r.viewport, { x: 1, y: image.y / image.x });
    expect(br.x - tl.x).toBeCloseTo(Math.min(frame.width, frame.height * (image.x / image.y)), 6);
  });

  it("changes nothing while the margins already leave the region in force", () => {
    const r = viewportRig(image, pane, beside);
    openRig(r);
    const setMargins = vi.spyOn(r.viewport, "setMargins");
    const zoomTo = vi.spyOn(r.viewport, "zoomTo");
    expect(reconfine(r.viewer, beside)).toBe(false);
    expect(setMargins).not.toHaveBeenCalled();
    expect(zoomTo).not.toHaveBeenCalled();
  });

  it("clears the margins of a viewer whose region has gone", () => {
    const r = viewportRig(image, pane, beside);
    openRig(r);
    expect(reconfine(r.viewer, null)).toBe(true);
    expect(r.viewport.getMargins()).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});
