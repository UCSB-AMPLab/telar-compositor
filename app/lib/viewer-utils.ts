/**
 * viewer-utils — Pure helpers for IIIF viewport state capture and restore.
 *
 * Telar stores coordinates as normalised values:
 *   x, y: 0–1 fractions of image dimensions (0 = top/left, 1 = bottom/right)
 *   zoom: multiplier relative to home zoom level
 *
 * OpenSeadragon uses absolute viewport coordinates internally.
 * These helpers convert between the two systems.
 *
 * They also derive the capture-framing rectangles the editor's viewfinder
 * overlay draws — the region a published-site visitor is guaranteed to see
 * regardless of their screen's aspect ratio, and a safe zone inside it — so an
 * author can frame an object's important content around the constant centre
 * that survives any device.
 */

/**
 * Convert normalised Telar coordinates to OSD viewport values.
 * Matches Telar's calculateViewportPosition() in telar-story/utils.js.
 */
export function normalisedToViewport(
  homeBounds: { x: number; y: number; width: number; height: number },
  homeZoom: number,
  nx: number,
  ny: number,
  nzoom: number
): { point: { x: number; y: number }; actualZoom: number } {
  return {
    point: {
      x: homeBounds.x + nx * homeBounds.width,
      y: homeBounds.y + ny * homeBounds.height,
    },
    actualZoom: homeZoom * nzoom,
  };
}

/**
 * Convert OSD viewport values back to normalised Telar coordinates.
 * Inverse of normalisedToViewport.
 */
export function viewportToNormalised(
  homeBounds: { x: number; y: number; width: number; height: number },
  homeZoom: number,
  vx: number,
  vy: number,
  vzoom: number
): { x: number; y: number; zoom: number } {
  return {
    x: (vx - homeBounds.x) / homeBounds.width,
    y: (vy - homeBounds.y) / homeBounds.height,
    zoom: vzoom / homeZoom,
  };
}

/**
 * Representative published-viewer aspect ratios (width / height). The published
 * Telar story viewer is full-screen, so a visitor's framing is their whole
 * screen: wide on desktop, tall on a phone in portrait.
 */
export const ASPECT_DESKTOP = 16 / 9; // ≈ 1.778 — typical desktop/laptop, landscape
export const ASPECT_PHONE = 9 / 18; // = 0.5 — typical phone, portrait

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The region a published full-screen visitor of pixel aspect ratio `aspect`
 * (width / height) sees for a captured view, in OpenSeadragon viewport
 * coordinates.
 *
 * Capture stores a centre (x, y) plus a zoom normalised to home zoom. The
 * framework recomputes home zoom per visitor aspect, so the *centre* is constant
 * across devices but the visible *extent* around it changes with aspect — which
 * is why the editor's own panel shape can't preview what visitors see. Given the
 * image's home bounds, the current centre, and the normalised zoom, this returns
 * the centred rect a viewer of `aspect` would show, so the editor can draw it as
 * a framing guide regardless of the editor panel's shape.
 */
export function visitorVisibleRect(
  homeBounds: { x: number; y: number; width: number; height: number },
  center: { x: number; y: number },
  normalizedZoom: number,
  aspect: number
): ViewportRect {
  const imgAspect = homeBounds.width / homeBounds.height;
  // Home-fit visible size for this aspect (whole image contained, letterboxed).
  let homeW: number;
  let homeH: number;
  if (aspect >= imgAspect) {
    // Viewport wider than the image → fit height, letterbox the sides.
    homeH = homeBounds.height;
    homeW = homeBounds.height * aspect;
  } else {
    // Viewport taller than the image → fit width, letterbox top/bottom.
    homeW = homeBounds.width;
    homeH = homeBounds.width / aspect;
  }
  const width = homeW / normalizedZoom;
  const height = homeH / normalizedZoom;
  return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}

/**
 * The "safe zone" — the region guaranteed visible across the given aspects
 * (their intersection, all centred on the same point). Content kept inside this
 * is seen by every visitor regardless of device.
 */
export function safeZoneRect(
  center: { x: number; y: number },
  rects: ViewportRect[]
): ViewportRect {
  const width = Math.min(...rects.map((r) => r.width));
  const height = Math.min(...rects.map((r) => r.height));
  return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}

/**
 * Captures the current viewport state as normalised Telar coordinates.
 */
export function captureViewportState(
  center: { x: number; y: number },
  zoom: number,
  pageIndex: number | null,
  homeBounds?: { x: number; y: number; width: number; height: number },
  homeZoom?: number
): { x: number; y: number; zoom: number; page: string } {
  if (homeBounds && homeZoom) {
    const normalised = viewportToNormalised(homeBounds, homeZoom, center.x, center.y, zoom);
    return {
      x: normalised.x,
      y: normalised.y,
      zoom: normalised.zoom,
      page: pageIndex !== null ? String(pageIndex + 1) : "1",
    };
  }
  // Fallback: raw coordinates (shouldn't happen in practice)
  return {
    x: center.x,
    y: center.y,
    zoom,
    page: pageIndex !== null ? String(pageIndex + 1) : "1",
  };
}
