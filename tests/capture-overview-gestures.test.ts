// @vitest-environment jsdom

/**
 * `holdOverviewCentred` on a real OpenSeadragon viewer, driven through its
 * own canvas tracker, so the drag, pinch, wheel and key handling are OSD's.
 *
 * At zoom 1 and below a pan must not move the image, and a zoom must still
 * reach the viewport: a touch double-tap-and-drag zooms through the same
 * `canvas-drag` event a pan does (`onCanvasDrag`, which zooms by
 * `zoomPerDblClickDrag` to the power of `delta.y / 50` while `draggingToZoom`
 * is set), so a guard on the event itself stops both. The viewer is built with
 * OSD's HTML drawer, the one jsdom can construct, and holds no image, so its
 * home is the unit square and its home zoom 1.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, afterEach } from "vitest";
import OpenSeadragon from "openseadragon";
import { holdOverviewCentred } from "~/lib/authoring-frame";
import type { CentredViewer } from "~/lib/authoring-frame";

type Handler = (event: Record<string, unknown>) => void;

interface Tracker {
  clickHandler: Handler;
  pressHandler: Handler;
  dragHandler: Handler;
  dragEndHandler: Handler;
  scrollHandler: Handler;
  pinchHandler: Handler;
  keyDownHandler: Handler;
}

const live: OpenSeadragon.Viewer[] = [];

afterEach(() => {
  for (const viewer of live.splice(0)) viewer.destroy();
  document.body.innerHTML = "";
});

function rig() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  // With no image OSD would cap the zoom at `maxZoomPixelRatio`, 1.1; the
  // editor's images allow far more, so the rig sets its own ceiling.
  const viewer = OpenSeadragon({
    element, showNavigationControl: false, drawer: "html", prefixUrl: "", animationTime: 0, maxZoomLevel: 10,
  });
  live.push(viewer);
  const release = holdOverviewCentred(viewer as unknown as CentredViewer);
  const tracker = (viewer as unknown as { innerTracker: Tracker }).innerTracker;
  const vp = viewer.viewport;
  const at = { x: 100, y: 100 };
  const point = (p: { x: number; y: number }) => new OpenSeadragon.Point(p.x, p.y);
  const base = { eventSource: tracker, pointerType: "touch", position: point(at), shift: false, originalEvent: {} };
  const settle = () => { for (let i = 0; i < 20; i += 1) vp.update(); };
  return {
    viewer,
    vp,
    release,
    zoom: () => vp.getZoom(true) / vp.getHomeZoom(),
    zoomTo: (z: number) => { vp.zoomTo(vp.getHomeZoom() * z, null as unknown as OpenSeadragon.Point, true); settle(); },
    /** A quick tap, then a press inside the double-tap window: OSD's double-tap-and-hold. */
    doubleTapHold: () => {
      tracker.clickHandler({ ...base, quick: true });
      tracker.pressHandler({ ...base, insideElementPressed: true });
    },
    drag: (dy: number, dx = 0) => {
      tracker.dragHandler({ ...base, delta: point({ x: dx, y: dy }), speed: 0, direction: 0 });
      settle();
    },
    dragEnd: () => { tracker.dragEndHandler({ ...base, speed: 0, direction: 0 }); settle(); },
    /** Two fingers moved together 40px across and 30px down, the same distance apart: travel, no zoom. */
    pinchTravel: () => {
      tracker.pinchHandler({
        ...base, gesturePoints: [], lastCenter: point(at), center: point({ x: at.x + 40, y: at.y + 30 }),
        lastDistance: 100, distance: 100,
      });
      settle();
    },
    settled: () => { viewer.raiseEvent("animation-finish", {}); settle(); },
    settle,
  };
}

describe("holdOverviewCentred with OSD's own gesture handling", () => {
  it("lets a double-tap-and-drag zoom in from 1: 50px down reaches 1.2", () => {
    const r = rig();
    expect(r.zoom()).toBeCloseTo(1, 12);
    r.doubleTapHold();
    r.drag(50);
    r.dragEnd();
    expect(r.zoom()).toBeCloseTo(1.2, 9);
  });

  it("lets a double-tap-and-drag from 1.1 zoom out past 1 and back in", () => {
    const r = rig();
    r.zoomTo(1.1);
    r.doubleTapHold();
    r.drag(-50);
    expect(r.zoom()).toBeCloseTo(1.1 / 1.2, 9);
    r.drag(50);
    expect(r.zoom()).toBeCloseTo(1.1, 9);
    r.dragEnd();
  });

  it("refuses a pan at zoom 1 and below, on both axes, and allows one above", () => {
    const r = rig();
    const before = r.vp.getCenter(true);
    r.drag(40, 30);
    r.dragEnd();
    expect(r.vp.getCenter(true).x).toBeCloseTo(before.x, 12);
    expect(r.vp.getCenter(true).y).toBeCloseTo(before.y, 12);
    r.zoomTo(1.5);
    const zoomed = r.vp.getCenter(true);
    r.drag(40, 30);
    r.dragEnd();
    expect(r.vp.getCenter(true).x).not.toBeCloseTo(zoomed.x, 6);
    expect(r.vp.getCenter(true).y).not.toBeCloseTo(zoomed.y, 6);
  });

  it("refuses a pinch's travel as the first gesture at an overview, and allows it above", () => {
    const overview = rig();
    const before = overview.vp.getCenter(true);
    overview.pinchTravel();
    expect(overview.vp.getCenter(true).x).toBeCloseTo(before.x, 12);
    expect(overview.vp.getCenter(true).y).toBeCloseTo(before.y, 12);
    const detail = rig();
    detail.zoomTo(1.5);
    const zoomed = detail.vp.getCenter(true);
    detail.pinchTravel();
    expect(detail.vp.getCenter(true).x).not.toBeCloseTo(zoomed.x, 6);
  });

  it("returns the view to the centre once a wheel zoom about the pointer settles at 1 or below", () => {
    const r = rig();
    r.zoomTo(1.5);
    const tracker = (r.viewer as unknown as { innerTracker: Tracker }).innerTracker;
    // A mouse wheel out, about a point off the centre: OSD zooms about the
    // pointer. OSD drops a wheel event within `minScrollDeltaTime` of the last,
    // and a new viewer counts its construction as the last one.
    (r.viewer as unknown as { _lastScrollTime: number })._lastScrollTime = 0;
    tracker.scrollHandler({
      eventSource: tracker, pointerType: "mouse", position: new OpenSeadragon.Point(20, 20),
      scroll: -3, shift: false, originalEvent: {}, preventDefault: false,
    });
    r.settle();
    expect(r.zoom()).toBeLessThanOrEqual(1);
    r.settled();
    const home = r.vp.getHomeBounds();
    expect(r.vp.getCenter(true).x).toBeCloseTo(home.x + home.width / 2, 9);
    expect(r.vp.getCenter(true).y).toBeCloseTo(home.y + home.height / 2, 9);
  });

  it("gives the viewer back its panning once released", () => {
    const r = rig();
    r.release();
    const before = r.vp.getCenter(true);
    r.drag(40, 30);
    r.dragEnd();
    expect(r.vp.getCenter(true).x).not.toBeCloseTo(before.x, 6);
  });
});
