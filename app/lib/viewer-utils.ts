/**
 * viewer-utils — Pure helpers for IIIF viewport state capture and restore.
 *
 * Telar stores coordinates as normalised values:
 *   x, y: 0–1 fractions of image dimensions (0 = top/left, 1 = bottom/right)
 *   zoom: multiplier relative to home zoom level
 *
 * OpenSeadragon uses absolute viewport coordinates internally.
 * These helpers convert between the two systems.
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
