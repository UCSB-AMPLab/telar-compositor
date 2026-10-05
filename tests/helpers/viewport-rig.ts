/**
 * A capture viewer around a real OpenSeadragon `Viewport`.
 *
 * The viewer around the viewport is OSD's own `EventSource`, so handlers run in
 * registration order as they do in the editor, plus the world and the redraw
 * hook the viewport calls into. `viewport.resize` raises `resize` through it,
 * as it does inside a real viewer, and `doViewerResize` below replays what OSD's
 * viewer does around that call. The viewport is built with the margins
 * `IiifViewer` passes as `viewportMargins` for a viewer confined to a region,
 * and `measureInAuthoringFrame` is attached before `open`, as `IiifViewer`
 * attaches it.
 *
 * Requires a jsdom environment in the calling test file.
 *
 * @version v1.5.0-beta
 */

import OpenSeadragon from "openseadragon";
import { measureInAuthoringFrame, regionMargins } from "~/lib/authoring-frame";
import type { MeasuredViewer, RegionOf } from "~/lib/authoring-frame";
import { CAPTURE_MAX_ZOOM_LEVEL, CAPTURE_MIN_ZOOM_RATIO } from "~/lib/viewer-utils";
import type { ImageItem } from "~/lib/viewer-utils";
import { osdImageItem } from "./osd-fake";

export type Size = { x: number; y: number };

export interface ViewportRig {
  viewer: MeasuredViewer & OpenSeadragon.EventSource;
  viewport: OpenSeadragon.Viewport;
  item: ImageItem;
  container: Size;
  detach: () => void;
}

/**
 * Build the rig for an `image` of pixels in a pane of `container` pixels.
 * `regionOf`, where given, confines the viewer as `IiifViewer`'s prop does; a
 * `let` binding read through the closure lets a test swap it. `later` runs
 * after the authoring frame is attached, as the column's handlers are.
 */
export function viewportRig(
  image: Size,
  container: Size,
  regionOf?: RegionOf,
  later?: (r: ViewportRig) => void
): ViewportRig {
  const d = OpenSeadragon.DEFAULT_SETTINGS;
  const item = osdImageItem(image.x, image.y);
  const source = new OpenSeadragon.EventSource() as OpenSeadragon.EventSource & Record<string, unknown>;
  const pane = { w: container.x, h: container.y };
  // `viewer` and `margins` are Viewport options OSD reads (openseadragon.js
  // :26671, :26650-26655) and its type declarations leave out.
  const viewport = new OpenSeadragon.Viewport({
    containerSize: new OpenSeadragon.Point(container.x, container.y),
    contentSize: new OpenSeadragon.Point(image.x, image.y),
    ...(regionOf ? { margins: regionMargins(pane, regionOf(pane)) } : {}),
    minZoomImageRatio: CAPTURE_MIN_ZOOM_RATIO,
    maxZoomPixelRatio: d.maxZoomPixelRatio,
    visibilityRatio: d.visibilityRatio,
    defaultZoomLevel: d.defaultZoomLevel,
    minZoomLevel: d.minZoomLevel,
    maxZoomLevel: CAPTURE_MAX_ZOOM_LEVEL,
    springStiffness: d.springStiffness,
    animationTime: 0,
    wrapHorizontal: false,
    wrapVertical: false,
    degrees: 0,
    homeFillsViewer: false,
    silenceMultiImageWarnings: true,
    viewer: source as unknown as OpenSeadragon.Viewer,
  } as OpenSeadragon.ViewportOptions);
  viewport.resetContentSize(new OpenSeadragon.Point(image.x, image.y));
  source.viewport = viewport;
  source.world = { getItemAt: () => item, getItemCount: () => 1 };
  source.forceRedraw = () => {};
  const viewer = source as unknown as ViewportRig["viewer"];
  const r: ViewportRig = { viewer, viewport, item, container: { ...container }, detach: () => {} };
  r.detach = regionOf
    ? measureInAuthoringFrame(viewer, () => regionOf)
    : measureInAuthoringFrame(viewer);
  later?.(r);
  return r;
}

/** Advance the springs to their endpoint. */
export function settle(viewport: OpenSeadragon.Viewport) {
  for (let i = 0; i < 20; i += 1) viewport.update();
}

/** What OSD does as a tile source opens: home, then `open` (openseadragon.js:8997, :9029). */
export function openRig(r: ViewportRig) {
  r.viewport.goHome(true);
  r.viewport.update();
  r.viewer.raiseEvent("open", {});
  settle(r.viewport);
}

/**
 * `doViewerResize` (openseadragon.js:12331-12351), step by step, with
 * `preserveImageSizeOnResize` false as the editor constructs it.
 */
export function doViewerResize(r: ViewportRig, next: Size) {
  const viewport = r.viewport;
  const zoom = viewport.getZoom();
  const center = viewport.getCenter();
  viewport.resize(new OpenSeadragon.Point(next.x, next.y), false);
  viewport.panTo(center, true);
  const prevDiag = Math.hypot(r.container.x, r.container.y);
  const newDiag = Math.hypot(next.x, next.y);
  const resizeRatio = (newDiag / prevDiag) * (r.container.x / next.x);
  viewport.zoomTo(zoom * resizeRatio, null as unknown as OpenSeadragon.Point, true);
  r.container = { ...next };
}

/** The stored zoom the viewer reads now. */
export function authoredZoom(viewport: OpenSeadragon.Viewport) {
  return viewport.getZoom() / viewport.getHomeZoom();
}
