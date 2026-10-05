/**
 * authoring-frame — the capture viewer measures a zoom in the frame replay reads.
 *
 * A stored zoom is a multiple of the whole-object fit in a frame of aspect
 * `AUTHORING_ASPECT`, which is how the framework's `computeFocalTarget` reads
 * it back. The editor's pane has whatever shape the layout gives it, so the
 * capture viewer measures against the largest frame of that aspect centred in
 * the pane: it sets OSD's `defaultZoomLevel` to the zoom at which the image
 * fills that frame. Everything OSD derives from home — `getHomeZoom()`,
 * `getHomeBounds()`, `goHome()`, the `0` key, `getMinZoom()` and
 * `getMaxZoom()` — then reads the frame, and `getZoom() / getHomeZoom()` is
 * the stored zoom.
 *
 * The frame depends on the pane's aspect and the image's, so it is set when the
 * image opens and again on every resize. Only the capture viewer is measured
 * this way; the object page's viewer keeps OSD's native home.
 *
 * The capture viewer can also be confined to a region of its pane: the part
 * of the visitor's window the published page frames the image into, beside or
 * above the text card. OSD's viewport margins do the confining. They shrink
 * the area OSD measures zoom against and offset its pixel mapping, so the
 * centre, the zoom and home all refer to the region, and the frame is
 * inscribed in the region rather than the pane. The region is a function of
 * the pane's size, and the margins are recomputed from it on every resize,
 * and by `reconfine` when the region changes while the pane keeps its size.
 *
 * A step records no rotation and no flip, and replay applies neither, so the
 * capture viewer also refuses OSD's keys for them (`holdOrientation`): a view
 * turned or mirrored while framing would be stored as a point and a width on
 * the upright image and replayed with a different composition.
 *
 * At zoom 1 and below the published page centres the image in the region
 * whatever a step stores, so the capture viewer keeps it centred there too
 * (`holdOverviewCentred`): a pan does not move it, a zoom still works, and a
 * zoom that ends at or below 1 off the centre returns to it.
 *
 * On an axis where the image is shorter than the region, the published page
 * keeps the whole image inside the region (`_clampFocalPx`), so the
 * capture viewer does too (`keepShortImageInRegion`): a view that would hang
 * part of the image outside the region settles where the site will show it.
 *
 * The guide geometry the capture viewer draws is here too, as pure functions
 * of the pane size, so what the overlay shows is the same frame the zoom is
 * measured in.
 *
 * @version v1.5.0-beta
 */

import {
  AUTHORING_ASPECT,
  FOCAL_DIAMETER_FRAC,
  OVERVIEW_ANCHOR_MAX_ZOOM,
  inscribedFrameHomeZoom,
  normalisedToViewport,
  pageCentres,
  siteScale,
} from "~/lib/viewer-utils";
import type { ImageItem } from "~/lib/viewer-utils";

type Point = { x: number; y: number };

/**
 * The parts of an OpenSeadragon viewer this module touches. `defaultZoomLevel`
 * is a property of OSD's Viewport that its type declarations leave out;
 * `getHomeZoom()` returns it whenever it is set.
 */
export interface MeasuredViewer {
  viewport: {
    defaultZoomLevel?: number;
    getContainerSize(): Point;
    /** OSD's margins, in pane pixels; read where present, zero where not. */
    getMargins?(): Margins;
    setMargins?(margins: Margins): unknown;
    getZoom(current?: boolean): number;
    getHomeZoom(): number;
    getCenter(current?: boolean): Point;
    goHome(immediately?: boolean): unknown;
    zoomTo(zoom: number, refPoint?: Point | null, immediately?: boolean): unknown;
    panTo(center: Point, immediately?: boolean): unknown;
    applyConstraints(immediately?: boolean): unknown;
    /** OSD's bounds after its constraints; the rectangle is in viewport units and carries the flags below. */
    getConstrainedBounds?(current?: boolean): ConstrainedBounds;
  };
  world: { getItemAt(index: number): { getContentSize(): Point } | null | undefined };
  addHandler(event: string, handler: (event: never) => void): unknown;
  removeHandler(event: string, handler: (event: never) => void): unknown;
}

/** A rectangle in viewport units, as OSD's constraints return it. */
export interface ConstrainedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  constraintApplied?: boolean;
  xConstrained?: boolean;
  yConstrained?: boolean;
}

/** OSD's viewport margins, in pane pixels. */
export interface Margins {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A rectangle in pane pixels, as `framing-stage` writes one. */
export interface RegionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The region the capture viewer is confined to, for a pane of `pane.w` ×
 * `pane.h` pixels, or null for the whole pane.
 */
export type RegionOf = (pane: { w: number; h: number }) => RegionBox | null;

/**
 * The margins that leave `region` as the area OSD measures in, for a pane of
 * `pane`. A region reaching past the pane's edge leaves no margin on that side,
 * since OSD reads a negative margin as a larger area.
 */
export function regionMargins(pane: { w: number; h: number }, region: RegionBox | null): Margins {
  if (!region) return { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    left: Math.max(0, region.x),
    top: Math.max(0, region.y),
    right: Math.max(0, pane.w - region.x - region.w),
    bottom: Math.max(0, pane.h - region.y - region.h),
  };
}

/**
 * Keep `viewer`'s home at the image filling the inscribed authoring frame.
 *
 * Register it straight after the viewer is constructed and before any other
 * `open` handler: OSD raises handlers in registration order and has already
 * gone home by the time `open` fires, so this handler re-homes the view before
 * a later one applies a saved framing or reads the first zoom.
 *
 * On `resize` OSD raises the event inside `viewport.resize`, with the new
 * container size in the event and the view not yet moved, and afterwards fits
 * the old bounds to the new area and pans and zooms by its own ratio without
 * constraints (`doViewerResize`). So the authored zoom and centre are read
 * here, the margins are set for the new size, the new home is set, and the
 * view is put back in a microtask, which runs after OSD's own adjustment
 * returns. The margins must be set inside this event: OSD's fit that follows
 * reads them, and anything later would run after the view had been moved
 * against the old ones.
 *
 * `readRegion`, where given, returns the current region function; it is read
 * at each event rather than captured, so a caller can change the function
 * without reattaching. Without it the margins are never touched.
 *
 * Returns a function that removes both handlers.
 */
export function measureInAuthoringFrame(
  viewer: MeasuredViewer,
  readRegion?: () => RegionOf | null | undefined
): () => void {
  let attached = true;

  /** Set the margins for a pane of `container`, where the viewer is confined. */
  const setMargins = (container: Point) => {
    if (!readRegion || !viewer.viewport.setMargins) return;
    viewer.viewport.setMargins(marginsFor(container, readRegion()));
  };

  const onOpen = () => {
    const container = viewer.viewport.getContainerSize();
    setMargins(container);
    if (setHome(viewer, container)) viewer.viewport.goHome(true);
  };

  const onResize = (event: { newContainerSize?: Point }) => {
    const viewport = viewer.viewport;
    const container = event?.newContainerSize ?? viewport.getContainerSize();
    const authored = viewport.getZoom() / viewport.getHomeZoom();
    const centre = viewport.getCenter();
    setMargins(container);
    if (!Number.isFinite(authored) || authored <= 0) return;
    if (!setHome(viewer, container)) return;
    queueMicrotask(() => {
      if (!attached) return;
      restoreView(viewer, authored, centre);
    });
  };

  viewer.addHandler("open", onOpen as (event: never) => void);
  viewer.addHandler("resize", onResize as (event: never) => void);
  const releaseImageHold = readRegion ? keepShortImageInRegion(viewer, readRegion) : () => {};

  return () => {
    attached = false;
    releaseImageHold();
    viewer.removeHandler("open", onOpen as (event: never) => void);
    viewer.removeHandler("resize", onResize as (event: never) => void);
  };
}

/**
 * Keep the view where the published page shows it near an image's edge. On an
 * axis where the image is shorter than the region the page holds the whole
 * image inside the region (`_clampFocalPx`); on one where it covers
 * the region it holds the image's edge on the region's, so no background shows.
 * OSD's own boundary constraint asks only that half the image stay in view, so
 * it lets the view hang past the edge; this narrows the centre to what the page
 * allows (`pageCentres`), judged at the scale the page draws the step at
 * (`siteScale`), not the scale of the editor's stage, since the two differ
 * between zoom 1 and 2. Above zoom 1 only: at 1 and below the image is centred
 * (`holdOverviewCentred`).
 *
 * The region is `readRegion`'s, the area OSD measures in, and the image is one
 * lone image at the origin, one unit wide, as OSD places it. `applyConstraints`,
 * which every gesture and every restore ends on, reads the bounds through
 * `getConstrainedBounds`, so it is wrapped on the viewport itself.
 *
 * Returns a function that takes the wrapper off.
 */
export function keepShortImageInRegion(
  viewer: MeasuredViewer,
  readRegion: () => RegionOf | null | undefined
): () => void {
  const viewport = viewer.viewport;
  const inherited = viewport.getConstrainedBounds;
  if (typeof inherited !== "function") return () => {};
  const own = Object.prototype.hasOwnProperty.call(viewport, "getConstrainedBounds");

  viewport.getConstrainedBounds = function (this: unknown, current?: boolean) {
    const bounds = inherited.call(this, current);
    const item = viewer.world.getItemAt(0);
    const container = viewport.getContainerSize();
    const region = readRegion()?.({ w: container.x, h: container.y });
    const homeZoom = viewport.getHomeZoom();
    if (!item || !region || !(homeZoom > 0)) return bounds;
    const zoom = viewport.getZoom(current) / homeZoom;
    if (!(zoom > OVERVIEW_ANCHOR_MAX_ZOOM)) return bounds;
    const size = item.getContentSize();
    if (!(size.x > 0 && size.y > 0)) return bounds;

    const s = siteScale(region, { w: size.x, h: size.y }, zoom);
    const height = size.y / size.x;
    const fit = (centre: number, length: number, extent: number, unit: number) => {
      const range = pageCentres(length * s, extent);
      if (!range) return centre;
      return Math.min(range.max, Math.max(range.min, centre / unit)) * unit;
    };
    const cx = fit(bounds.x + bounds.width / 2, size.x, region.w, 1);
    const cy = fit(bounds.y + bounds.height / 2, size.y, region.h, height);
    if (Math.abs(cx - (bounds.x + bounds.width / 2)) > MEET_UNITS) {
      bounds.x = cx - bounds.width / 2;
      bounds.xConstrained = true;
      bounds.constraintApplied = true;
    }
    if (Math.abs(cy - (bounds.y + bounds.height / 2)) > MEET_UNITS) {
      bounds.y = cy - bounds.height / 2;
      bounds.yConstrained = true;
      bounds.constraintApplied = true;
    }
    return bounds;
  };

  return () => {
    if (own) viewport.getConstrainedBounds = inherited;
    else delete viewport.getConstrainedBounds;
  };
}

/**
 * Move the view's centre to where the constraints hold it, and leave its zoom
 * alone. A restored framing has to show the saved zoom, which the site applies
 * whatever OSD's maximum is (`_isSane` asks only that it be positive), and the
 * centre the site shows, which is what the constrained bounds carry once
 * `keepShortImageInRegion` is on the viewport. `applyConstraints` would take the
 * zoom to OSD's limits as well, so the centre is read off the constrained bounds
 * and panned to alone, at once or on OSD's spring as `immediately` says.
 */
export function settleCentre(viewer: MeasuredViewer, immediately = true): void {
  const viewport = viewer.viewport;
  const bounds = viewport.getConstrainedBounds?.(immediately);
  if (!bounds?.constraintApplied) return;
  viewport.panTo({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, immediately);
}

/** Viewport units below which two positions are the same; far under a device pixel at any zoom the editor allows. */
const MEET_UNITS = 1e-9;

/**
 * Confine `viewer` to the region `regionOf` gives its pane now, where that is
 * not the region its margins already leave.
 *
 * The region can change while the pane keeps its size: a media step's card,
 * or the visitor's layout crossing a breakpoint while the stage keeps its
 * pixels. OSD raises no `resize` for either, so the caller asks after each
 * change it makes. The authored zoom and centre are kept as a resize keeps
 * them: read, the margins set, home set for the new region, and the view put
 * back, here at once, since no fit of OSD's follows.
 *
 * Returns whether the margins changed.
 */
export function reconfine(viewer: MeasuredViewer, regionOf: RegionOf | null | undefined): boolean {
  const viewport = viewer.viewport;
  if (!viewport.setMargins || !viewport.getMargins) return false;
  const container = viewport.getContainerSize();
  const next = marginsFor(container, regionOf);
  if (sameMargins(viewport.getMargins(), next)) return false;
  const authored = viewport.getZoom() / viewport.getHomeZoom();
  const centre = viewport.getCenter();
  viewport.setMargins(next);
  if (!Number.isFinite(authored) || authored <= 0) return true;
  if (setHome(viewer, container)) restoreView(viewer, authored, centre);
  return true;
}

/** The margins for a pane of `container` confined by `regionOf`. */
function marginsFor(container: Point, regionOf: RegionOf | null | undefined): Margins {
  const pane = { w: container.x, h: container.y };
  return regionMargins(pane, regionOf ? regionOf(pane) : null);
}

/** Margins equal to a thousandth of a pixel, which is below anything OSD draws. */
function sameMargins(a: Margins, b: Margins): boolean {
  return (["left", "top", "right", "bottom"] as const).every((side) => Math.abs(a[side] - b[side]) < 1e-3);
}

/**
 * Set `viewer`'s home for `container` less its margins; false where there is
 * no image or no area yet.
 */
function setHome(viewer: MeasuredViewer, container: Point): boolean {
  const item = viewer.world.getItemAt(0);
  if (!item) return false;
  const size = item.getContentSize();
  const m = viewer.viewport.getMargins?.() ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const innerW = container.x - m.left - m.right;
  const innerH = container.y - m.top - m.bottom;
  if (!(size.x > 0 && size.y > 0 && innerW > 0 && innerH > 0)) return false;
  viewer.viewport.defaultZoomLevel = inscribedFrameHomeZoom(size.x / size.y, innerW / innerH);
  return true;
}

/** Put the view back at an authored zoom, relative to the new home, and centre. */
function restoreView(viewer: MeasuredViewer, authored: number, centre: Point) {
  const viewport = viewer.viewport;
  viewport.zoomTo(authored * viewport.getHomeZoom(), null, true);
  viewport.panTo(centre, true);
  settleCentre(viewer);
}

/**
 * OSD's orientation keys, by the `keyCode` its canvas handler switches on:
 * `r` / `R` rotate by `rotationIncrement`, `f` / `F` mirror the view
 * (`onCanvasKeyDown`, openseadragon.js 6.0.2).
 */
const ORIENTATION_KEY_CODES = new Set([82, 70]);

/** The part of an OpenSeadragon viewer `holdOrientation` touches. */
export interface KeyedViewer {
  addHandler(event: string, handler: (event: never) => void): unknown;
  removeHandler(event: string, handler: (event: never) => void): unknown;
}

/**
 * Stop `viewer`'s keyboard from rotating or mirroring the view.
 *
 * OSD raises `canvas-key` before it acts on a key, and skips its own handling
 * when a subscriber sets `preventDefaultAction`. Only the orientation keys are
 * refused, so panning, zooming and `0` for home still work from the keyboard,
 * and the browser keeps the key.
 *
 * Returns a function that removes the handler.
 */
export function holdOrientation(viewer: KeyedViewer): () => void {
  const onKey = (event: {
    originalEvent?: { keyCode?: number };
    preventDefaultAction: boolean;
  }) => {
    const code = event.originalEvent?.keyCode;
    if (code !== undefined && ORIENTATION_KEY_CODES.has(code)) {
      event.preventDefaultAction = true;
    }
  };
  viewer.addHandler("canvas-key", onKey as (event: never) => void);
  return () => viewer.removeHandler("canvas-key", onKey as (event: never) => void);
}

/** The part of an OpenSeadragon viewer `holdOverviewCentred` touches. */
export interface CentredViewer extends KeyedViewer {
  viewport: {
    getZoom(current?: boolean): number;
    getHomeZoom(): number;
    getHomeBounds(): { x: number; y: number; width: number; height: number };
    getCenter(current?: boolean): Point;
    panTo(center: Point, immediately?: boolean): unknown;
  };
  world: { getItemAt(index: number): ImageItem | null | undefined };
  /** OSD's switches for panning along each axis, read by every pan gesture. */
  panHorizontal?: boolean;
  panVertical?: boolean;
}

/**
 * The gestures whose pan OSD takes from `panHorizontal` and `panVertical`,
 * read after the event is raised: a drag, its flick, and a pinch's travel.
 */
const PAN_GESTURE_EVENTS = ["canvas-drag", "canvas-drag-end", "canvas-pinch"] as const;

/**
 * Keep `viewer`'s image centred while its zoom is 1 or below, as the published
 * page centres an overview whatever a step stores.
 *
 * Only panning is refused, never zooming. OSD sends a touch double-tap-and-drag
 * zoom through the same `canvas-drag` event as a pan, so the event itself
 * cannot be refused; instead, before each pan gesture acts, the viewer's
 * `panHorizontal` and `panVertical` are switched off at an overview and back
 * on above it, which OSD's pan branches read and its zoom branches do not. A
 * zoom by the wheel, a pinch or a double-tap-drag about a point off the centre
 * moves the centre with it; once its animation finishes at or below 1, the view
 * is panned back to the image's centre. The switches are also set when the
 * hold starts and whenever an animation finishes, so between gestures they
 * say what the settled zoom allows.
 *
 * The arrow keys are not held. OSD 6.0.2 pans on them each frame unless
 * `viewer.preventHorizontalPan` or `preventVerticalPan` is set, properties it
 * never sets itself, and it ignores the flags of the same names on the
 * `canvas-key` event. A capture after an arrow-key pan still stores the
 * image's centre and settles there.
 *
 * Returns a function that removes the handlers and gives the viewer back the
 * pan switches it had.
 */
export function holdOverviewCentred(viewer: CentredViewer): () => void {
  const vp = viewer.viewport;
  const initial = { horizontal: viewer.panHorizontal ?? true, vertical: viewer.panVertical ?? true };
  const atOverview = () => vp.getZoom() / vp.getHomeZoom() <= OVERVIEW_ANCHOR_MAX_ZOOM;
  const onPanGesture = () => {
    const held = atOverview();
    viewer.panHorizontal = held ? false : initial.horizontal;
    viewer.panVertical = held ? false : initial.vertical;
  };
  const onSettled = () => {
    onPanGesture();
    if (!atOverview()) return;
    const { point } = normalisedToViewport(
      vp.getHomeBounds(), vp.getHomeZoom(), 0.5, 0.5, 1, viewer.world.getItemAt(0)
    );
    const centre = vp.getCenter();
    if (Math.abs(centre.x - point.x) > 1e-12 || Math.abs(centre.y - point.y) > 1e-12) vp.panTo(point);
  };
  onPanGesture();
  for (const name of PAN_GESTURE_EVENTS) viewer.addHandler(name, onPanGesture as (event: never) => void);
  viewer.addHandler("animation-finish", onSettled as (event: never) => void);
  return () => {
    for (const name of PAN_GESTURE_EVENTS) viewer.removeHandler(name, onPanGesture as (event: never) => void);
    viewer.removeHandler("animation-finish", onSettled as (event: never) => void);
    viewer.panHorizontal = initial.horizontal;
    viewer.panVertical = initial.vertical;
  };
}

/** A rectangle in pane pixels. */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The largest rectangle of aspect `AUTHORING_ASPECT` centred in a pane of
 * `width` × `height` pixels: the frame a stored zoom is measured in. It meets
 * the pane on its limiting axis — the height where the pane is wider than the
 * frame, the width otherwise.
 */
export function authoringFrameRect(width: number, height: number): PaneRect {
  const frameW = Math.min(width, height * AUTHORING_ASPECT);
  const frameH = frameW / AUTHORING_ASPECT;
  return { x: (width - frameW) / 2, y: (height - frameH) / 2, width: frameW, height: frameH };
}

/** `regionOf`'s region for `pane`, or the whole pane where there is none. */
export function regionOrPane(
  regionOf: RegionOf | null | undefined,
  pane: { w: number; h: number }
): RegionBox {
  return regionOf?.(pane) ?? { x: 0, y: 0, w: pane.w, h: pane.h };
}

/** The authoring frame inscribed in `region`, in the pane's pixels. */
export function frameInRegion(region: RegionBox): PaneRect {
  const inner = authoringFrameRect(region.w, region.h);
  return { ...inner, x: region.x + inner.x, y: region.y + inner.y };
}

/**
 * The focal circle replay keeps beside the card, drawn in `frame`, or null
 * below zoom 2. At 2 and above replay reads the zoom as the frame's width and
 * frames a circle of `FOCAL_DIAMETER_FRAC` of it; below 2 its overview rules
 * frame the object by other means, and a circle would promise nothing.
 */
export function focalCircle(
  frame: PaneRect,
  zoom: number
): { cx: number; cy: number; radius: number } | null {
  if (!(zoom >= 2)) return null;
  return {
    cx: frame.x + frame.width / 2,
    cy: frame.y + frame.height / 2,
    radius: (FOCAL_DIAMETER_FRAC * frame.width) / 2,
  };
}
