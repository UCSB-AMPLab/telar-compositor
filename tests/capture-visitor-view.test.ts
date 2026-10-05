// @vitest-environment jsdom

/**
 * The editor shows and stores the visitor's view (ruling 17).
 *
 * `visitorViewCentre` is where the published page puts a stored framing: the
 * image's centre at zoom 1 and below, zoom 1 itself included, and the stored
 * point at any zoom above 1. `captureFocal` is the capture rule that inverts
 * it, naming the view the site will then show. The expectations are worked by
 * hand from those rules, not computed by the functions under test.
 *
 * `holdOverviewCentred` keeps the capture viewer's image centred at an
 * overview, through a real OpenSeadragon `Viewport` in the rig of
 * `helpers/viewport-rig.ts`: here the pan switches it sets and the return to
 * the centre; `capture-overview-gestures.test.ts` drives OSD's own gestures.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import OpenSeadragon from "openseadragon";
import { holdOverviewCentred } from "~/lib/authoring-frame";
import type { CentredViewer } from "~/lib/authoring-frame";
import { captureFocal, captureViewportState, visitorViewCentre } from "~/lib/viewer-utils";
import { openRig, settle, viewportRig } from "./helpers/viewport-rig";

/** Each named field to twelve places. */
function close(actual: object, expected: Record<string, number>): void {
  const fields = actual as Record<string, number>;
  for (const [k, v] of Object.entries(expected)) expect(fields[k], k).toBeCloseTo(v, 12);
}

describe("visitorViewCentre", () => {
  it("is the image's centre at zoom 1 and below, whatever is stored", () => {
    expect(visitorViewCentre({ x: 0.2, y: 0.9 }, 0.5)).toEqual({ x: 0.5, y: 0.5 });
    expect(visitorViewCentre({ x: 0.2, y: 0.9 }, 1)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("is the stored point at any zoom above 1", () => {
    expect(visitorViewCentre({ x: 0.2, y: 0.9 }, 1.000001)).toEqual({ x: 0.2, y: 0.9 });
    expect(visitorViewCentre({ x: 0.2, y: 0.9 }, 1.25)).toEqual({ x: 0.2, y: 0.9 });
    expect(visitorViewCentre({ x: 0.2, y: 0.9 }, 1.5)).toEqual({ x: 0.2, y: 0.9 });
    expect(visitorViewCentre({ x: 0.2, y: 0.9 }, 2)).toEqual({ x: 0.2, y: 0.9 });
    expect(visitorViewCentre({ x: 0.2, y: 0.9 }, 3)).toEqual({ x: 0.2, y: 0.9 });
  });
});

describe("captureFocal", () => {
  it("stores and shows the image's centre at zoom 1 and below", () => {
    expect(captureFocal({ x: 0.3, y: 0.7 }, 0.5)).toEqual({ x: 0.5, y: 0.5, view: { x: 0.5, y: 0.5 } });
    expect(captureFocal({ x: 0.3, y: 0.7 }, 1)).toEqual({ x: 0.5, y: 0.5, view: { x: 0.5, y: 0.5 } });
  });

  it("stores the view's centre as it is at any zoom above 1", () => {
    expect(captureFocal({ x: 0.3, y: 0.7 }, 1.000001)).toEqual({ x: 0.3, y: 0.7, view: { x: 0.3, y: 0.7 } });
    expect(captureFocal({ x: 0.4, y: 0.6 }, 1.5)).toEqual({ x: 0.4, y: 0.6, view: { x: 0.4, y: 0.6 } });
    expect(captureFocal({ x: 0.3, y: 0.85 }, 1.25)).toEqual({ x: 0.3, y: 0.85, view: { x: 0.3, y: 0.85 } });
    expect(captureFocal({ x: 0.3, y: 0.7 }, 2)).toEqual({ x: 0.3, y: 0.7, view: { x: 0.3, y: 0.7 } });
    expect(captureFocal({ x: 0.05, y: 0.95 }, 3)).toEqual({ x: 0.05, y: 0.95, view: { x: 0.05, y: 0.95 } });
  });

  it("is what captureViewportState stores, at the floored zoom", () => {
    const home = { x: 0, y: 0, width: 1, height: 1 };
    const stored = captureViewportState({ x: 0.4, y: 0.6 }, 1.5, 0, home, 1);
    close(stored, { x: 0.4, y: 0.6, zoom: 1.5 });
    // Below the floor the zoom is stored at 0.1, an overview, so centred.
    expect(captureViewportState({ x: 0.4, y: 0.6 }, 0.02, 0, home, 1)).toMatchObject({ x: 0.5, y: 0.5 });
  });
});

describe("holdOverviewCentred, on a real Viewport", () => {
  /** A capture viewer on a 1.5 image in a 900 × 600 pane, opened at home, held. */
  function held() {
    const r = viewportRig({ x: 3000, y: 2000 }, { x: 900, y: 600 });
    openRig(r);
    const release = holdOverviewCentred(r.viewer as unknown as CentredViewer);
    const imageCentre = r.item.imageToViewportCoordinates(1500, 1000);
    return { r, release, imageCentre };
  }

  /** Raise a pan gesture on the rig's viewer and report the pan switches it leaves. */
  function panSwitches(r: ReturnType<typeof held>["r"], name: "canvas-drag" | "canvas-drag-end" | "canvas-pinch") {
    const event = { preventDefaultAction: false };
    r.viewer.raiseEvent(name, event);
    const v = r.viewer as unknown as CentredViewer;
    // The drag itself is never refused: a double-tap-drag zoom arrives as one.
    expect(event.preventDefaultAction, name).toBe(false);
    return { horizontal: v.panHorizontal, vertical: v.panVertical };
  }

  it("switches panning off at zoom 1 and below, and back on above, for each pan gesture", () => {
    const { r } = held();
    const off = { horizontal: false, vertical: false };
    const on = { horizontal: true, vertical: true };
    for (const name of ["canvas-drag", "canvas-drag-end", "canvas-pinch"] as const) expect(panSwitches(r, name), name).toEqual(off);
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 0.6, null as unknown as OpenSeadragon.Point, true);
    expect(panSwitches(r, "canvas-drag")).toEqual(off);
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 1.2, null as unknown as OpenSeadragon.Point, true);
    for (const name of ["canvas-drag", "canvas-drag-end", "canvas-pinch"] as const) expect(panSwitches(r, name), name).toEqual(on);
  });

  it("sets the pan switches when the hold starts and whenever a zoom settles, with no gesture between", () => {
    const { r } = held();
    const v = r.viewer as unknown as CentredViewer;
    const switches = () => ({ horizontal: v.panHorizontal, vertical: v.panVertical });
    expect(switches(), "at the hold's start, at home").toEqual({ horizontal: false, vertical: false });
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 1.5, null as unknown as OpenSeadragon.Point, true);
    r.viewer.raiseEvent("animation-finish", {});
    expect(switches(), "zoomed in by a button").toEqual({ horizontal: true, vertical: true });
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 0.9, null as unknown as OpenSeadragon.Point, true);
    r.viewer.raiseEvent("animation-finish", {});
    expect(switches(), "zoomed out by the wheel").toEqual({ horizontal: false, vertical: false });
  });

  it("returns an overview left off the centre to it once the animation finishes", () => {
    const { r, imageCentre } = held();
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 0.8, null as unknown as OpenSeadragon.Point, true);
    r.viewport.panTo(new OpenSeadragon.Point(imageCentre.x - 0.2, imageCentre.y + 0.1), true);
    r.viewer.raiseEvent("animation-finish", {});
    settle(r.viewport);
    const centre = r.viewport.getCenter();
    expect(centre.x).toBeCloseTo(imageCentre.x, 9);
    expect(centre.y).toBeCloseTo(imageCentre.y, 9);
  });

  it("leaves a view above zoom 1 where it is", () => {
    const { r, imageCentre } = held();
    r.viewport.zoomTo(r.viewport.getHomeZoom() * 1.5, null as unknown as OpenSeadragon.Point, true);
    const off = new OpenSeadragon.Point(imageCentre.x - 0.1, imageCentre.y + 0.05);
    r.viewport.panTo(off, true);
    r.viewer.raiseEvent("animation-finish", {});
    settle(r.viewport);
    const centre = r.viewport.getCenter();
    expect(centre.x).toBeCloseTo(off.x, 9);
    expect(centre.y).toBeCloseTo(off.y, 9);
  });

  it("holds nothing once released, and gives back the pan switches", () => {
    const { r, release, imageCentre } = held();
    panSwitches(r, "canvas-drag");
    release();
    expect(panSwitches(r, "canvas-drag")).toEqual({ horizontal: true, vertical: true });
    const off = new OpenSeadragon.Point(imageCentre.x - 0.2, imageCentre.y);
    r.viewport.panTo(off, true);
    r.viewer.raiseEvent("animation-finish", {});
    settle(r.viewport);
    expect(r.viewport.getCenter().x).toBeCloseTo(off.x, 9);
  });
});
