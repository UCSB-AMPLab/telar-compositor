/**
 * viewer-utils — Pure helpers for IIIF viewport state capture and restore.
 *
 * Telar stores coordinates as normalised values:
 *   x, y: 0–1 fractions of image dimensions (0 = top/left, 1 = bottom/right)
 *   zoom: multiplier relative to home zoom level
 *
 * OpenSeadragon uses absolute viewport coordinates internally.
 * These helpers convert between the two systems: position through the tiled
 * image, zoom against the viewport's home. The constants and home-zoom
 * functions of the authoring frame, which replay reads a zoom against, are
 * here too; `authoring-frame.ts` applies them to the capture viewer.
 *
 * At zoom 1 and below a stored x and y are not the point a visitor sees at
 * the centre of the region: replay centres an overview whatever they hold.
 * So the editor shows a stored framing where the site will put it
 * (`visitorViewCentre`) and captures the x and y that replay to the view the
 * author framed (`captureFocal`).
 *
 * @version v1.5.0-beta
 */

/**
 * The two conversions and the size of the tiled image a framing is measured on
 * — the shape of OpenSeadragon's `TiledImage`, which `viewer.world.getItemAt(0)`
 * returns. Called with two numbers rather than a Point: OSD tests its argument
 * with `instanceof Point`, which a plain object fails.
 */
export interface ImageItem {
  viewportToImageCoordinates(x: number, y: number): { x: number; y: number };
  imageToViewportCoordinates(x: number, y: number): { x: number; y: number };
  getContentSize(): { x: number; y: number };
}

/** The item's width and height, or null where it has no area to divide by. */
function contentSizeOf(item: ImageItem | null | undefined): { w: number; h: number } | null {
  if (!item) return null;
  const size = item.getContentSize();
  if (!(size.x > 0) || !(size.y > 0)) return null;
  return { w: size.x, h: size.y };
}

/** `value` held to 0…1, the range of a stored x or y. */
function unitClamp(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Convert normalised Telar coordinates to OSD viewport values.
 *
 * x and y are fractions of the image, so they are placed through the image
 * `item`: OSD's home bounds are pane-shaped and include the letterbox, and a
 * fraction of them is a different point on the image for every pane shape.
 * Without an item — a read before the image opens — the home bounds stand in.
 * The zoom is a multiple of the viewport's home zoom.
 */
export function normalisedToViewport(
  homeBounds: { x: number; y: number; width: number; height: number },
  homeZoom: number,
  nx: number,
  ny: number,
  nzoom: number,
  item?: ImageItem | null
): { point: { x: number; y: number }; actualZoom: number } {
  const size = contentSizeOf(item);
  const point = size
    ? (item as ImageItem).imageToViewportCoordinates(nx * size.w, ny * size.h)
    : { x: homeBounds.x + nx * homeBounds.width, y: homeBounds.y + ny * homeBounds.height };
  return { point: { x: point.x, y: point.y }, actualZoom: homeZoom * nzoom };
}

/**
 * Convert OSD viewport values back to normalised Telar coordinates.
 * Inverse of normalisedToViewport.
 *
 * Through an item the centre is measured on the image and held to 0…1: a
 * centre in the letterbox stores the nearest edge of the image, which the
 * published site frames, rather than a value outside the range it refuses.
 */
export function viewportToNormalised(
  homeBounds: { x: number; y: number; width: number; height: number },
  homeZoom: number,
  vx: number,
  vy: number,
  vzoom: number,
  item?: ImageItem | null
): { x: number; y: number; zoom: number } {
  const size = contentSizeOf(item);
  if (size) {
    const image = (item as ImageItem).viewportToImageCoordinates(vx, vy);
    return {
      x: unitClamp(image.x / size.w),
      y: unitClamp(image.y / size.h),
      zoom: vzoom / homeZoom,
    };
  }
  return {
    x: (vx - homeBounds.x) / homeBounds.width,
    y: (vy - homeBounds.y) / homeBounds.height,
    zoom: vzoom / homeZoom,
  };
}

/**
 * The aspect ratio (width / height) of the frame a stored zoom is measured in.
 * It is the framework's `AUTHORING_ASPECT` (`telar-story/authoring-frame.js`),
 * which replay divides by; the two must be equal, and
 * `tests/capture-zoom-floor-parity.test.ts` holds them together.
 */
export const AUTHORING_ASPECT = 1.053;

/**
 * The focal circle's diameter as a fraction of the authored frame's width at a
 * detail zoom (2 and above): the framework's `FOCAL_DIAMETER_FRAC`
 * (`telar-story/iiif-card.js`), pinned by the same parity test.
 */
export const FOCAL_DIAMETER_FRAC = 0.9;

/**
 * OSD's home zoom for an image of aspect `imageAspect` in a pane of aspect
 * `AUTHORING_ASPECT`: an image wider than the frame fills its width (1), a
 * taller one fits by height. Replay reads a stored zoom against this.
 */
export function authoringHomeZoom(imageAspect: number): number {
  return Math.min(1, imageAspect / AUTHORING_ASPECT);
}

/**
 * The OSD zoom at which the image fills the largest `AUTHORING_ASPECT` frame
 * centred in a pane of aspect `paneAspect`. That frame is the pane's full width
 * where the pane is no wider than `AUTHORING_ASPECT`, and `AUTHORING_ASPECT /
 * paneAspect` of it where it is wider; used as the capture viewer's home zoom,
 * `zoom / home` is then a zoom measured in that frame, which is what replay reads.
 */
export function inscribedFrameHomeZoom(imageAspect: number, paneAspect: number): number {
  return authoringHomeZoom(imageAspect) / Math.max(1, paneAspect / AUTHORING_ASPECT);
}

/**
 * The smallest fraction of the whole-object fit the framework honours for an
 * authored zoom. At and below 1 the framework reads zoom as a fraction of the
 * fit — 1 is the whole object filling the frame, and anything under it stands
 * the object back with proportional margin — but it will not stand back
 * further than this floor, matching `OVERVIEW_MIN_FRACTION` in the framework's
 * own `telar-story/iiif-card.js`. The editor's capture viewer must be able to
 * reach the same floor, or an author composing here cannot frame what a
 * spreadsheet author typing raw x/y/zoom values could already ask the
 * published site for.
 *
 * `tests/capture-zoom-floor-parity.test.ts` holds the two together where a
 * framework checkout is present: it drives the framework's clamp, drives the
 * framing that clamp feeds through the module's own `snapIiifToPosition`, and
 * reads the declaration so a rename fails rather than passes.
 */
export const CAPTURE_MIN_ZOOM_RATIO = 0.1;

/**
 * The capture viewer's `maxZoomLevel`, in OSD's viewport zoom (container widths
 * per image width). The published page accepts any finite zoom above 0 a step
 * stores (`_isSane` in the framework's `telar-story/iiif-card.js`) and fits the
 * view with `fitBounds`, so no maximum applies there; OSD's default, from a
 * pixel ratio of the image, stops a small image at a zoom the site shows past.
 * A million container widths across the image is a view of well under a pixel
 * of any image a IIIF server serves, so nothing the site shows is beyond it.
 * A stored zoom above it can only come from a hand-edited spreadsheet; a
 * gesture on such a step takes the zoom down to this level, which is the limit.
 */
export const CAPTURE_MAX_ZOOM_LEVEL = 1e6;

/**
 * The whole-object framing a published site substitutes for a stored value it
 * cannot read as a number.
 *
 * It has two sources, in two languages, and the build's is the one that governs
 * every site published today: `_apply_coordinate_defaults` in
 * `scripts/telar/processors/stories.py` rewrites an empty or `'nan'` cell to
 * these three numbers before the JSON is written. The framework's browser-side
 * fallback — `FULL_OBJECT_FRAMING`, exported from
 * `telar-story/plates/iiif-plate.js` — arrives in 1.8.0 and catches what the
 * build's match misses, which is a non-empty cell holding something that is
 * not a number.
 *
 * Both are pinned against this constant in tests/capture-zoom-floor-parity.
 */
export const FULL_OBJECT_FRAMING = { x: 0.5, y: 0.5, zoom: 1 };

/** `parseFloat`'s number, or `fallback` where it is not one — `num` in `_stepFraming`. */
function parsedOr(value: unknown, fallback: number): number {
  const parsed = parseFloat(value as string);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The framing a published story derives from a step's stored x, y and zoom, or
 * null where it frames nothing at all.
 *
 * Two framework functions decide this between them, and either one read on its
 * own gives the wrong answer for half the inputs. `_stepFraming`
 * (`telar-story/card-pool.js`) reads each field with `parseFloat` and puts the
 * whole-object value in place of a result that is not finite. Only then does
 * `_isSane` (`telar-story/iiif-card.js`) see the step, and what it rejects
 * `computeFocalTarget` returns null for, so `_applyFocalTarget` leaves the
 * viewer showing exactly what it was showing.
 *
 * Per stored value, therefore:
 *
 *   | stored                        | what the published story does            |
 *   |-------------------------------|------------------------------------------|
 *   | NaN, ±Infinity, "", "garbage" | substitutes the whole-object value for    |
 *   |                               | THAT field — x 0.5, y 0.5, zoom 1         |
 *   | "0.5", and other numeric      | parseFloat's number: a framing like any   |
 *   | strings                       | other                                     |
 *   | a zoom at or below zero       | no framing — the viewer keeps the view it |
 *   |                               | has                                       |
 *   | an x or y outside 0…1         | no framing, the same way                  |
 *   | a zoom under the floor        | a framing, rendered at the floor          |
 *
 * The substitution is per FIELD rather than per step: a step holding a centre
 * and a zoom that is not a number frames that centre at 1.
 *
 * `_isSane`'s finiteness clauses cannot bite after the parse, which has already
 * substituted for everything that is not finite; its range clauses are what is
 * left of it here. The floor belongs to the caller — this returns the zoom the
 * framework carries into its framing, and `clampCaptureZoom` is where the
 * editor's viewer stops.
 *
 * A step whose x, y or zoom is null never reaches here: `savedFramingOf`
 * discards the whole framing on any one of the three, and the column asks for
 * home instead. Two functions put it there — `stepFromYMap` normalises an
 * absent cell with `?? null` before the column sees the step, so nothing
 * arrives as `undefined`, and `savedFramingOf` then tests for literal null
 * rather than for falsehood — a stored x or y of 0 is an edge of the image,
 * not an absence. A stored zoom of 0 survives that test and is refused here
 * instead, which is the site's answer to it too.
 *
 * That is where the editor stops following the framework, and it is any one of
 * the three fields rather than the zoom alone, because the site substitutes per
 * field and validates only what it has afterwards:
 *
 *   | stored                 | the editor | the published story         |
 *   |------------------------|------------|-----------------------------|
 *   | x null, y 0.6, zoom 2  | home       | frames 0.5, 0.6, 2          |
 *   | x null, y null, zoom 2 | home       | frames 0.5, 0.5, 2          |
 *   | x null, y 0.6, zoom 0  | home       | no framing — keeps the view |
 *
 * It stays that way because `savedFramingOf`'s answer is also what decides
 * whether Reset is offered and whether the column reports a saved position at
 * all: a step the editor reports no position for cannot be shown one either.
 * Home in the editor's own viewer, whose panel no card covers, is the whole
 * object centred.
 */
export function publishedFraming(stored: {
  x: unknown;
  y: unknown;
  zoom: unknown;
}): { x: number; y: number; zoom: number } | null {
  const x = parsedOr(stored.x, FULL_OBJECT_FRAMING.x);
  const y = parsedOr(stored.y, FULL_OBJECT_FRAMING.y);
  const zoom = parsedOr(stored.zoom, FULL_OBJECT_FRAMING.zoom);
  if (x < 0 || x > 1) return null;
  if (y < 0 || y > 1) return null;
  if (zoom <= 0) return null;
  return { x, y, zoom };
}

/**
 * An authored zoom held at or above the floor.
 *
 * Three different promises meet at this number, and they are not the same
 * promise:
 *
 *   - A NEW CAPTURE is clamped because the site clamps. A stored zoom is what
 *     the published story reads, and the framework raises anything under
 *     `OVERVIEW_MIN_FRACTION` to it before framing, so a step holding 0.05
 *     describes a view no visitor will ever be shown. The floor is spent where
 *     a capture derives a fresh number from the viewport.
 *
 *     It is a CAPTURE invariant, not a store one. Paths that write a zoom
 *     without passing it through here include import, a step seeded from
 *     another, an undo after a capture, another client's write, a direct
 *     `capture-position` post, and the D1-to-Y.Doc hydration that rebuilds a
 *     document from its rows (`buildFromD1Rows` in `workers/collaboration.ts`).
 *     The list is not claimed to be complete — anything holding the Y map can
 *     set the key — and the omission is deliberate: each of these carries a
 *     value an author already has, and rewriting it would break the rule below
 *     from the other end.
 *   - THE DISPLAY is clamped because the author has to see what will publish.
 *     The editor's viewer stops where the site stops, so pulling back lands on
 *     the floor rather than sliding past it and having the number corrected
 *     behind them.
 *   - THE STORED VALUE IS NOT REWRITTEN ON LOAD, because loading is not
 *     editing. A step captured under an earlier release can hold a zoom below
 *     the floor; opening it shows the framing the site would render, and the
 *     step keeps the number it has until the author captures again.
 *
 * A comparison rather than `Math.max`, because `Math.max(0.1, NaN)` is NaN: the
 * form is what puts a zoom arithmetic has ruined on the floor instead of
 * carrying it out. The comparison coerces, so what a value that is not a number
 * leaves as depends on what it coerces to, and only where it coerces at all:
 * one above the floor leaves as it arrived — the string `"0.2"` leaves as that
 * string — and every other value whose comparison completes, `"0.05"` and
 * `"garbage"` alike, leaves as the floor. A value the comparison cannot get a
 * number out of at all leaves as nothing: a Symbol throws at the `>`, and so
 * does an object with no inherited `valueOf` or `toString` to call. An object
 * carrying either of those, however it was made, converts like any other.
 * `(zoom: number)` is the honest statement
 * of what this takes, and nothing hands it otherwise: a capture derives its
 * argument from the viewport, and a restore puts a stored value through
 * `publishedFraming` before reaching here.
 */
export function clampCaptureZoom(zoom: number): number {
  return zoom > CAPTURE_MIN_ZOOM_RATIO ? zoom : CAPTURE_MIN_ZOOM_RATIO;
}

/**
 * Replay places the image's centre at the region's centre at and below this
 * zoom, whatever the stored x and y, and the stored point itself at any zoom
 * above it (`_placedPoint` in the framework's `telar-story/iiif-card.js`).
 */
export const OVERVIEW_ANCHOR_MAX_ZOOM = 1;

/**
 * The point of the image, as fractions of it, a published step puts at the
 * centre of the region beside its card: the image's centre at zoom 1 and
 * below, the stored point above 1. This is the framework's `_placedPoint` in
 * fractions of the image rather than its pixels.
 *
 * It is where the site starts: `_clampFocalPx` can still move that point off
 * the centre, on an axis where the replayed image covers the region so that
 * no background shows, and on one where it is shorter than the region so that
 * the image stays inside it. The editor models both
 * (`pageCentres`, held by the capture viewer).
 */
export function visitorViewCentre(
  stored: { x: number; y: number },
  zoom: number
): { x: number; y: number } {
  if (zoom <= OVERVIEW_ANCHOR_MAX_ZOOM) return { x: 0.5, y: 0.5 };
  return { x: stored.x, y: stored.y };
}

/**
 * The scale the published page draws a step at, in region pixels per image
 * pixel: `framePlacement`'s `s` in the framework's `telar-story/iiif-card.js`.
 * At and below zoom 1 it is the whole-object fit in the region times the zoom
 * (floored at a tenth); from zoom 2 it is the larger of that fit and the scale
 * that draws the authored circle, `FOCAL_DIAMETER_FRAC` of the authored frame's
 * width, across the region's shorter side; between 1 and 2 it runs in a straight
 * line from the fit to the circle's scale at 2. `region` is the region beside
 * the card, in any unit: the result is in that unit per image pixel.
 */
export function siteScale(
  region: { w: number; h: number },
  image: { w: number; h: number },
  zoom: number
): number {
  const fit = Math.min(region.w / image.w, region.h / image.h);
  if (zoom <= OVERVIEW_ANCHOR_MAX_ZOOM) return fit * Math.min(1, Math.max(CAPTURE_MIN_ZOOM_RATIO, zoom));
  const frameWidth = image.w / (authoringHomeZoom(image.w / image.h) * zoom);
  const match = Math.min(region.w, region.h) / (FOCAL_DIAMETER_FRAC * frameWidth);
  if (zoom < 2) return fit + (zoom - 1) * (Math.max(match * (2 / zoom), fit) - fit);
  return Math.max(match, fit);
}

/**
 * The fractions of an image the page can put at the region's centre on one
 * axis, where the image is `length` long at the page's scale and the region
 * `extent` long (`_clampFocalPx`).
 *
 * Where the image is shorter than the region, the whole image stays inside it,
 * so a centre at fraction `f` needs the image's near end `f` of its
 * length inside the region's half and its far end `1 - f` inside the other.
 * Where it covers the region, the page holds the image's edge on the region's
 * so no background shows, which needs the region's half to fit inside the
 * image on both sides of the centre. Both give `f` from `1 - h` to `h`, or
 * from `h` to `1 - h` where `h` is the smaller, with `h = extent / (2 * length)`;
 * the two meet at 0.5 where the image is exactly as long as the region. The
 * page's circle bound never narrows this: the ideal centre is the region's
 * middle, and a circle reaching past the region's half is dropped in favour of
 * coverage. Null where the image has no length.
 */
export function pageCentres(length: number, extent: number): { min: number; max: number } | null {
  if (!(length > 0)) return null;
  const half = extent / (2 * length);
  return { min: Math.min(half, 1 - half), max: Math.max(half, 1 - half) };
}

/**
 * The x and y to store for a view centred on `view` (fractions of the image)
 * at a stored `zoom`, and the view the site will then show, which is where the
 * editor settles.
 *
 * At zoom 1 and below replay centres the image whatever is stored, so the
 * image's centre is stored and shown. Above 1 the view's centre is stored as
 * it is, and replay puts it back at the region's centre.
 */
export function captureFocal(
  view: { x: number; y: number },
  zoom: number
): { x: number; y: number; view: { x: number; y: number } } {
  const stored = zoom <= OVERVIEW_ANCHOR_MAX_ZOOM ? { x: 0.5, y: 0.5 } : { x: view.x, y: view.y };
  return { ...stored, view: visitorViewCentre(stored, zoom) };
}

/**
 * Captures the current viewport state as normalised Telar coordinates.
 *
 * This is the one place a framing is DERIVED from a viewport, so it is where the
 * floor is applied: every capture button in the editor arrives here, rather than
 * each of them being trusted to remember the floor. The paths that carry a zoom
 * an author already has do not come through here at all — see `clampCaptureZoom`.
 *
 * The x and y stored are `captureFocal`'s for the viewport's centre at the
 * floored zoom, so at zoom 1 and below they are the image's centre, which
 * replay shows there whatever is stored, not the view's centre.
 */
export function captureViewportState(
  center: { x: number; y: number },
  zoom: number,
  pageIndex: number | null,
  homeBounds?: { x: number; y: number; width: number; height: number },
  homeZoom?: number,
  item?: ImageItem | null
): { x: number; y: number; zoom: number; page: string } {
  const normalised =
    homeBounds && homeZoom
      ? viewportToNormalised(homeBounds, homeZoom, center.x, center.y, zoom, item)
      // Fallback: raw coordinates (shouldn't happen in practice)
      : { x: center.x, y: center.y, zoom };
  const zoomStored = clampCaptureZoom(normalised.zoom);
  const focal = captureFocal(normalised, zoomStored);
  return {
    x: focal.x,
    y: focal.y,
    zoom: zoomStored,
    page: pageIndex !== null ? String(pageIndex + 1) : "1",
  };
}
