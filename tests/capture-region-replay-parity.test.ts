// @vitest-environment jsdom

/**
 * A framing captured in the region, replayed by the framework.
 *
 * CAPTURE runs through a real OpenSeadragon `Viewport` confined to the region
 * by viewport margins, in a stage of 0.625 of the visitor's window, as the
 * framing stage will draw it: the author zooms and pans, and
 * `captureViewportState` stores what the viewport reads: the view's centre
 * above zoom 1, and at 1 and below the image's centre, which replay shows
 * there whatever is stored (ruling 17).
 *
 * REPLAY runs through the framework's own `snapIiifToPosition`, imported into
 * a jsdom window of the visitor's size with the live card rect from `cardBox`
 * as `state.cardOverlayRect`, so `_applyFocalTarget`, `computeFocalTarget` and
 * `_clampFocalPx` are the framework's and none of them is transcribed. Its
 * viewer card is stubbed down to what that path reads: the source size, the
 * container rect (the whole window, as the published plate is), and a viewport
 * whose `imageToViewportRectangle` converts as OSD does for a lone image at
 * the origin, one viewport unit wide, and whose `fitBounds` records the
 * rectangle it is handed. That rectangle is fitted as recorded, with no
 * conversion on this side, by a real OSD `Viewport` of the window's size with
 * no margins, as the published viewer has none, and every replayed position
 * below is read back through that viewport's pixel mapping. What is not
 * driven is a live published viewer: the plate's DOM, its tiles, and the
 * spring animation of the non-immediate path.
 *
 * Each replay places one image point, the anchor, at the region's centre. The
 * anchor is the image's centre at zoom 1 and below, whatever the stored x and
 * y, and the stored point at any zoom above 1. The expectations, by
 * regime:
 * - Every framing replays with its anchor at the region's centre, except on an
 *   axis where the replayed image is at least as long as the region (to a
 *   thousandth of a pixel) and the anchor there would leave background at one
 *   end: the image's edge then sits on the region's edge, so none shows; and
 *   on an axis where the image is shorter than the region and the anchor
 *   there would put part of it outside: the image then stands inside the
 *   region, as near the centre as that allows. All are worked here
 *   from the region, the scale and the anchor, at a zoom inside each regime,
 *   for points near the centre and by an edge.
 * - At zoom 2 and above the authored circle, 0.9 of the frame the editor draws
 *   in the region, covers the same image pixels as the circle the framework
 *   derives; and the framework draws that circle across the region's shorter
 *   side. Both are asserted.
 * - At zoom 1 the image is the whole-object fit, as long as the region on one
 *   axis: on that axis its edges sit on the region's edges wherever the point
 *   is, and on the other the image's centre sits at the region's, including
 *   where the fitted length equals the region's only within rounding.
 * - The replay scale at zooms 1, 1.5 and 2 is the scale the framework's rules
 *   give, worked here from the region and the authored circle: the whole-object
 *   fit in the region at 1, the circle drawn across the region's shorter side
 *   at 2, and a straight line between them.
 * - Below zoom 1 the framework fits the whole object to the region, the
 *   editor to the frame inscribed in it (ruling 1, accepted). The replayed
 *   image is larger than the one the author saw by the ratio of the two fits,
 *   and that ratio is recorded per window and image as an exact expectation.
 *   The image's centre sits at the region's, wherever the author's point was.
 *
 * @version v1.5.0-beta
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, it, expect } from "vitest";
import OpenSeadragon from "openseadragon";

import { applyFraming, zoomConstrained } from "~/components/features/editor/ViewerColumn";
import { authoringFrameRect } from "~/lib/authoring-frame";
import { cardBox, regionOf, visitorLayout } from "~/lib/framing-stage";
import type { Box } from "~/lib/framing-stage";
import { FOCAL_DIAMETER_FRAC, authoringHomeZoom, captureFocal, captureViewportState } from "~/lib/viewer-utils";
import {
  describeWithRequiredFramework as describeWithFramework,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
} from "./helpers/framework-checkout";
import { jsdomPrelude } from "./helpers/framework-jsdom";
import { doViewerResize, openRig, settle, viewportRig } from "./helpers/viewport-rig";

const STORY_DIR = join(FRAMEWORK_SCRIPTS_DIR, "..", "assets", "js", "telar-story");

/** The stage is this fraction of the visitor's window, as the editor letterboxes it. */
const STAGE_SCALE = 0.625;

const WINDOWS: Array<{ w: number; h: number }> = [
  { w: 1440, h: 757 },
  { w: 1280, h: 1024 },
  { w: 1100, h: 800 },
  { w: 390, h: 844 },
];

const IMAGES: Array<{ aspect: number; w: number; h: number }> = [
  { aspect: 0.5, w: 1500, h: 3000 },
  { aspect: 1.0, w: 3000, h: 3000 },
  { aspect: 1.5, w: 3000, h: 2000 },
];

/** An overview, the bridge between 1 and 2 with both its ends, and a detail. */
const ZOOMS = [0.6, 1, 1.5, 2, 3] as const;

/**
 * The zooms the grid's position checks run at: one inside each regime. Zoom 1
 * has its own placement cases below, since its expectation differs.
 */
const POSITION_ZOOMS: ReadonlySet<number> = new Set([0.6, 1.5, 3]);


/**
 * Near the centre, a point by the left edge, a point by the bottom edge, and
 * one near the bottom-left corner, which only the zoom-1 placement cases use.
 */
const FOCALS = {
  interior: { x: 0.47, y: 0.53 },
  left: { x: 0.04, y: 0.5 },
  bottom: { x: 0.5, y: 0.96 },
  corner: { x: 0.04, y: 0.9 },
} as const;

type FocalKind = keyof typeof FOCALS;

/** The focal points of the main grid. */
const GRID_FOCALS: FocalKind[] = ["interior", "left", "bottom"];

interface Case {
  win: { w: number; h: number };
  image: { aspect: number; w: number; h: number };
  zoom: number;
  focal: FocalKind;
  label: string;
}

const CASES: Case[] = WINDOWS.flatMap((win) =>
  IMAGES.flatMap((image) =>
    ZOOMS.flatMap((zoom) =>
      GRID_FOCALS.map((focal) => ({
        win,
        image,
        zoom,
        focal,
        label: `${win.w}×${win.h}, image ${image.aspect}, zoom ${zoom}, ${focal}`,
      }))
    )
  )
);

/**
 * The zoom-1 placement cases: every window, image and focal point, the corner
 * included, each replayed twice. `captured` replays what the editor stored,
 * which carries the conversions' last-digit error; `typed` replays the values
 * exactly as a spreadsheet author would type them. At zoom 1 the fitted length
 * on the limiting axis equals the region's only within those last digits, so
 * both must land edge to edge.
 */
type ZoomOneSource = "captured" | "typed";

const ZOOM_ONE_CASES: Array<Case & { source: ZoomOneSource }> = WINDOWS.flatMap((win) =>
  IMAGES.flatMap((image) =>
    (Object.keys(FOCALS) as FocalKind[]).flatMap((focal) =>
      (["captured", "typed"] as const).map((source) => ({
        win,
        image,
        zoom: 1,
        focal,
        source,
        label: `${win.w}×${win.h}, image ${image.aspect}, zoom 1, ${focal}, ${source}`,
      }))
    )
  )
);

/** What the author's viewer showed and stored. */
interface Captured {
  stored: { x: number; y: number; zoom: number };
  /** The view's centre, as fractions of the image. */
  view: { x: number; y: number };
  /** Where the editor drew the stored point, in the visitor's pixels. */
  drawnAt: { x: number; y: number };
  /** The image's drawn width, in the visitor's pixels (stage pixels over the scale). */
  imageWidthPx: number;
  /** The authored circle, in image pixels. */
  circleImagePx: number;
}

/** The region the framework frames into at `win`, in the visitor's pixels. */
function visitorRegion(win: { w: number; h: number }): Box {
  return regionOf(visitorLayout(win.w, win.h), win.w, win.h);
}

/** Frame, zoom and pan as the author would, in a stage confined to the region, and capture. */
function capture(c: Case, f: { x: number; y: number } = FOCALS[c.focal]): Captured {
  const region = visitorRegion(c.win);
  const pane = { x: c.win.w * STAGE_SCALE, y: c.win.h * STAGE_SCALE };
  const r = viewportRig({ x: c.image.w, y: c.image.h }, pane, (p) => {
    const k = p.w / c.win.w;
    return { x: region.x * k, y: region.y * k, w: region.w * k, h: region.h * k };
  });
  openRig(r);
  const target = r.item.imageToViewportCoordinates(f.x * c.image.w, f.y * c.image.h);
  r.viewport.zoomTo(r.viewport.getHomeZoom() * c.zoom, null as unknown as OpenSeadragon.Point, true);
  r.viewport.panTo(new OpenSeadragon.Point(target.x, target.y), true);
  r.viewport.applyConstraints(true);
  settle(r.viewport);

  const vp = r.viewport;
  const stored = captureViewportState(
    vp.getCenter(), vp.getZoom(), 0, vp.getHomeBounds(), vp.getHomeZoom(), r.item
  );
  const centre = vp.pixelFromPoint(vp.getCenter(true), true);
  const imageCentre = r.item.viewportToImageCoordinates(vp.getCenter().x, vp.getCenter().y);
  const left = vp.pixelFromPoint(new OpenSeadragon.Point(0, 0), true);
  const right = vp.pixelFromPoint(new OpenSeadragon.Point(1, 0), true);
  const stagePxPerImagePx = (right.x - left.x) / c.image.w;
  const frame = authoringFrameRect(region.w * STAGE_SCALE, region.h * STAGE_SCALE);
  return {
    stored: { x: stored.x, y: stored.y, zoom: stored.zoom },
    view: { x: imageCentre.x / c.image.w, y: imageCentre.y / c.image.h },
    drawnAt: { x: centre.x / STAGE_SCALE, y: centre.y / STAGE_SCALE },
    imageWidthPx: (right.x - left.x) / STAGE_SCALE,
    circleImagePx: (FOCAL_DIAMETER_FRAC * frame.width) / stagePxPerImagePx,
  };
}

/** What the framework made of a stored framing. */
interface FrameworkReplay {
  /** The rectangle handed to `fitBounds`, in viewport units. */
  applied: { x: number; y: number; width: number; height: number } | null;
  /** `computeFocalTarget`'s region and circle, for the same inputs. */
  region: Box;
  diameterImg: number;
}

/** Replay every case through the framework in one subprocess. */
function frameworkReplay(inputs: Array<{ c: Case; stored: Captured["stored"] }>): FrameworkReplay[] {
  const cases = inputs.map(({ c, stored }) => {
    const card = cardBox(visitorLayout(c.win.w, c.win.h), c.win.w, c.win.h);
    return {
      W: c.win.w,
      H: c.win.h,
      card: { x: card.x, y: card.y, width: card.w, height: card.h },
      imgW: c.image.w,
      imgH: c.image.h,
      ...stored,
    };
  });
  const script = [
    ...jsdomPrelude({ sizedWindow: true }),
    "dom.window.OpenSeadragon = { Rect: class { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } } };",
    `const { state } = await import(${JSON.stringify(`file://${join(STORY_DIR, "state.js")}`)});`,
    `const m = await import(${JSON.stringify(`file://${join(STORY_DIR, "iiif-card.js")}`)});`,
    "if (typeof m.snapIiifToPosition !== 'function' || typeof m.computeFocalTarget !== 'function') {",
    "  throw new Error('iiif-card.js exports no snapIiifToPosition/computeFocalTarget');",
    "}",
    "const out = [];",
    "for (const c of JSON.parse(process.argv[1])) {",
    "  W = c.W; H = c.H;",
    "  state.cardOverlayRect = c.card;",
    "  const applied = [];",
    "  m.snapIiifToPosition({",
    "    osdViewer: {",
    "      world: { getItemAt: () => ({ source: { width: c.imgW, height: c.imgH } }) },",
    "      viewport: {",
    // OSD's conversion for a lone image at the origin, one unit wide.
    "        imageToViewportRectangle: (r) => ({ x: r.x / c.imgW, y: r.y / c.imgW, width: r.width / c.imgW, height: r.height / c.imgW }),",
    "        fitBounds: (r) => applied.push({ x: r.x, y: r.y, width: r.width, height: r.height }),",
    "      },",
    "    },",
    "    osdWrapper: { containerEl: { getBoundingClientRect: () => ({ width: c.W, height: c.H }) } },",
    "  }, c.x, c.y, c.zoom);",
    "  const box = { x: c.card.x, y: c.card.y, w: c.card.width, h: c.card.height };",
    "  const target = m.computeFocalTarget(c.x, c.y, c.zoom, c.imgW, c.imgH, box, m._deriveCardPlacement(box, W, H));",
    "  out.push({ applied: applied.length === 1 ? applied[0] : null, region: target.region, diameterImg: target.diameterImg });",
    "}",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify(cases)],
    { encoding: "utf-8", timeout: FRAMEWORK_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out.trim().split("\n").at(-1) as string) as FrameworkReplay[];
}

/** Where the published viewer draws things once it has fitted `applied`. */
interface Replayed {
  focal: { x: number; y: number };
  /** The image's drawn box, in window pixels. */
  image: { left: number; top: number; right: number; bottom: number };
  /** Window pixels per image pixel. */
  scale: number;
}

/**
 * Fit the framework's rectangle in a real OSD `Viewport` of the window's size,
 * with no margins, and read positions back through its pixel mapping. A lone
 * image sits at the origin one viewport unit wide, so image pixels over the
 * image's width are viewport units on both axes.
 */
function fitInPublishedViewer(c: Case, stored: Captured["stored"], applied: NonNullable<FrameworkReplay["applied"]>): Replayed {
  const d = OpenSeadragon.DEFAULT_SETTINGS;
  const viewport = new OpenSeadragon.Viewport({
    containerSize: new OpenSeadragon.Point(c.win.w, c.win.h),
    contentSize: new OpenSeadragon.Point(c.image.w, c.image.h),
    maxZoomPixelRatio: Infinity,
    minZoomImageRatio: 0,
    visibilityRatio: d.visibilityRatio,
    springStiffness: d.springStiffness,
    animationTime: 0,
    wrapHorizontal: false,
    wrapVertical: false,
    degrees: 0,
    homeFillsViewer: false,
    silenceMultiImageWarnings: true,
  } as OpenSeadragon.ViewportOptions);
  viewport.resetContentSize(new OpenSeadragon.Point(c.image.w, c.image.h));
  viewport.fitBounds(new OpenSeadragon.Rect(applied.x, applied.y, applied.width, applied.height), true);
  const k = 1 / c.image.w;
  viewport.update();
  const px = (ix: number, iy: number) => viewport.pixelFromPoint(new OpenSeadragon.Point(ix * k, iy * k), true);
  const tl = px(0, 0);
  const br = px(c.image.w, c.image.h);
  return {
    focal: px(stored.x * c.image.w, stored.y * c.image.h),
    image: { left: tl.x, top: tl.y, right: br.x, bottom: br.y },
    scale: (br.x - tl.x) / c.image.w,
  };
}

/**
 * Window pixels per image pixel the framework's rules give, worked from the
 * region and the authored circle: at and below 1 the whole-object fit in the
 * region times the zoom, down to a tenth of it; from 2 the circle, 0.9 of the
 * authored frame's width, drawn across the region's shorter side, never less
 * than the fit; and between 1 and 2 the straight line from the fit to the
 * circle's scale at 2.
 */
function workedScale(c: Case): number {
  const region = visitorRegion(c.win);
  const fit = Math.min(region.w / c.image.w, region.h / c.image.h);
  const circle = (FOCAL_DIAMETER_FRAC * c.image.w) / (authoringHomeZoom(c.image.aspect) * c.zoom);
  const match = Math.min(region.w, region.h) / circle;
  if (c.zoom <= 1) return fit * Math.min(1, Math.max(0.1, c.zoom));
  if (c.zoom < 2) return fit + (c.zoom - 1) * (Math.max(match * (2 / c.zoom), fit) - fit);
  return Math.max(match, fit);
}

/**
 * The image point, as fractions of the image, that replay places at the
 * region's centre: the image's centre at zoom 1 and below, zoom 1 included,
 * and the stored point at any zoom above 1.
 */
function workedAnchor(stored: { x: number; y: number }, zoom: number): { x: number; y: number } {
  if (zoom <= 1) return { x: 0.5, y: 0.5 };
  return { x: stored.x, y: stored.y };
}

/**
 * The x and y a capture stores for a view centred on `view`, worked from the
 * anchor rule backwards: the image's centre at zoom 1 and below, where replay
 * centres the image anyway, and the view itself above 1.
 */
function workedStored(view: { x: number; y: number }, zoom: number): { x: number; y: number } {
  if (zoom <= 1) return { x: 0.5, y: 0.5 };
  return { x: view.x, y: view.y };
}

/**
 * Where the anchor lands on one axis of the region, which runs `extent` from
 * `start`, for an image `dim` image pixels long drawn at `s`, with the anchor
 * `a` image pixels in: the region's centre, unless that would leave background
 * at one end of an image at least as long as the region, or put part of an
 * image shorter than the region outside it. The anchor then stands
 * as near the centre as keeps the image's edge on the region's, or the image
 * inside the region.
 */
function workedAxis(start: number, extent: number, dim: number, a: number, s: number): number {
  const centre = start + extent / 2;
  const farEdgeHeld = start + extent - (dim - a) * s;
  const nearEdgeHeld = start + a * s;
  return Math.max(Math.min(farEdgeHeld, nearEdgeHeld), Math.min(Math.max(farEdgeHeld, nearEdgeHeld), centre));
}

/**
 * The stated difference at an overview (ruling 1): the whole-object fit in the
 * region over the fit in the frame inscribed in it, for each window and image
 * aspect, worked by hand from the region and `AUTHORING_ASPECT`. It is 1 where
 * the image is limited by an axis the frame shares with the region: the height
 * of a region wider than the frame for an image narrower than the frame, the
 * width of a region narrower than the frame for an image wider than the frame.
 * 1.053 is a square image in a region narrower than the frame.
 */
const OVERVIEW_RATIO: Record<string, number> = {
  "1440×757, 0.5": 1,
  "1440×757, 1": 1,
  "1440×757, 1.5": 1.08365,
  "1280×1024, 0.5": 1.404732,
  "1280×1024, 1": 1.053,
  "1280×1024, 1.5": 1,
  "1100×800, 0.5": 1.276364,
  "1100×800, 1": 1.053,
  "1100×800, 1.5": 1,
  "390×844, 0.5": 1.32408,
  "390×844, 1": 1.053,
  "390×844, 1.5": 1,
};

describeWithFramework("a framing captured in the region, replayed by the framework", () => {
  let results: Array<{ c: Case; captured: Captured; framework: FrameworkReplay }> = [];
  const zoomOne = new Map<string, { c: Case; captured: Captured; framework: FrameworkReplay }>();
  // At an overview a capture stores the image's centre, so the grid's points
  // below 2 are also replayed exactly as typed, which is where an overview's
  // x and y still reach the framework.
  let typedGrid: Array<{ c: Case; captured: Captured; framework: FrameworkReplay }> = [];

  beforeAll(() => {
    const all = [...CASES, ...ZOOM_ONE_CASES];
    const captured = all.map((c) => ({ c, captured: capture(c) }));
    const replays = frameworkReplay(captured.map(({ c, captured: cap }) => ({ c, stored: cap.stored })));
    const replayed = captured.map((entry, i) => ({ ...entry, framework: replays[i] }));
    results = replayed.slice(0, CASES.length);
    for (const entry of replayed.slice(CASES.length)) zoomOne.set(entry.c.label, entry);
    // The typed cases replay the exact values, in one further batch.
    const typed = ZOOM_ONE_CASES.filter((c) => c.source === "typed");
    const typedReplays = frameworkReplay(
      typed.map((c) => ({ c, stored: { x: FOCALS[c.focal].x, y: FOCALS[c.focal].y, zoom: 1 } }))
    );
    const grid = results.filter((r) => r.c.zoom < 2 && POSITION_ZOOMS.has(r.c.zoom));
    const asTyped = (c: Case) => ({ x: FOCALS[c.focal].x, y: FOCALS[c.focal].y, zoom: c.zoom });
    const gridReplays = frameworkReplay(grid.map(({ c }) => ({ c, stored: asTyped(c) })));
    typedGrid = grid.map((entry, i) => ({
      c: { ...entry.c, label: `${entry.c.label}, typed` },
      captured: { ...entry.captured, stored: asTyped(entry.c) },
      framework: gridReplays[i],
    }));
    typed.forEach((c, i) => {
      const entry = zoomOne.get(c.label)!;
      zoomOne.set(c.label, {
        ...entry,
        captured: { ...entry.captured, stored: { x: FOCALS[c.focal].x, y: FOCALS[c.focal].y, zoom: 1 } },
        framework: typedReplays[i],
      });
    });
  }, FRAMEWORK_TIMEOUT_MS);

  describe("at zoom 1, the image spans the region on its limiting axis", () => {
    for (const c of ZOOM_ONE_CASES) {
      it(c.label, () => {
        const { captured, framework } = zoomOne.get(c.label)!;
        expect(framework.applied, c.label).not.toBeNull();
        const replayed = fitInPublishedViewer(c, captured.stored, framework.applied!);
        const region = visitorRegion(c.win);
        const { image } = replayed;
        // The limiting axis is the one whose fit is smaller.
        const widthLimits = region.w / c.image.w <= region.h / c.image.h;
        if (widthLimits) {
          expect(image.left, "left edge on the region's").toBeCloseTo(region.x, 6);
          expect(image.right, "right edge on the region's").toBeCloseTo(region.x + region.w, 6);
          expect((image.top + image.bottom) / 2, "centred across").toBeCloseTo(region.y + region.h / 2, 6);
        } else {
          expect(image.top, "top edge on the region's").toBeCloseTo(region.y, 6);
          expect(image.bottom, "bottom edge on the region's").toBeCloseTo(region.y + region.h, 6);
          expect((image.left + image.right) / 2, "centred across").toBeCloseTo(region.x + region.w / 2, 6);
        }
      });
    }
  });

  it("frames the view the author set, and stores what replays to it, at every window, image and zoom", () => {
    expect(results).toHaveLength(CASES.length);
    for (const { c, captured } of results) {
      const f = FOCALS[c.focal];
      // Above zoom 1 the view is held where the site shows it: the whole image
      // inside the region on an axis where the site's image is shorter than the
      // region, and the image's edge on the region's on one it covers.
      const region = visitorRegion(c.win);
      const held = (fraction: number, dim: number, extent: number) => {
        if (c.zoom <= 1) return fraction;
        const half = extent / (2 * dim * workedScale(c));
        return Math.min(Math.max(half, 1 - half), Math.max(Math.min(half, 1 - half), fraction));
      };
      expect(captured.view.x, c.label).toBeCloseTo(held(f.x, c.image.w, region.w), 9);
      expect(captured.view.y, c.label).toBeCloseTo(held(f.y, c.image.h, region.h), 9);
      const want = workedStored(captured.view, c.zoom);
      expect(captured.stored.x, c.label).toBeCloseTo(want.x, 9);
      expect(captured.stored.y, c.label).toBeCloseTo(want.y, 9);
      expect(captured.stored.zoom, c.label).toBeCloseTo(c.zoom, 9);
    }
  });

  it("replays into the region the stage confined the capture to", () => {
    for (const { c, framework } of results) {
      const region = visitorRegion(c.win);
      for (const key of ["x", "y", "w", "h"] as const) {
        expect(framework.region[key], `${c.label} region ${key}`).toBeCloseTo(region[key], 6);
      }
    }
  });

  it("draws an interior framing's view centre at the region's centre in the editor", () => {
    for (const { c, captured } of results.filter((r) => r.c.focal === "interior" && POSITION_ZOOMS.has(r.c.zoom))) {
      const region = visitorRegion(c.win);
      expect(captured.drawnAt.x, `${c.label} editor x`).toBeCloseTo(region.x + region.w / 2, 6);
      expect(captured.drawnAt.y, `${c.label} editor y`).toBeCloseTo(region.y + region.h / 2, 6);
    }
  });

  it("replays at the scale the framework's rules give, in every regime", () => {
    for (const { c, captured, framework } of results) {
      const replayed = fitInPublishedViewer(c, captured.stored, framework.applied!);
      expect(replayed.scale, `${c.label} replay scale`).toBeCloseTo(workedScale(c), 9);
    }
  });

  it("replays the anchor at the region's centre, or as near it as keeps the image's edge on the region's or the image inside it", () => {
    const clamped: string[] = [];
    for (const { c, captured, framework } of [...results.filter((r) => POSITION_ZOOMS.has(r.c.zoom)), ...typedGrid]) {
      expect(framework.applied, c.label).not.toBeNull();
      const replayed = fitInPublishedViewer(c, captured.stored, framework.applied!);
      const region = visitorRegion(c.win);
      const s = workedScale(c);
      const anchor = workedAnchor(captured.stored, c.zoom);
      const ax = anchor.x * c.image.w;
      const ay = anchor.y * c.image.h;
      const want = {
        x: workedAxis(region.x, region.w, c.image.w, ax, s),
        y: workedAxis(region.y, region.h, c.image.h, ay, s),
      };
      expect(replayed.image.left + ax * replayed.scale, `${c.label} anchor x`).toBeCloseTo(want.x, 6);
      expect(replayed.image.top + ay * replayed.scale, `${c.label} anchor y`).toBeCloseTo(want.y, 6);
      if (Math.abs(want.x - (region.x + region.w / 2)) > 1e-6 || Math.abs(want.y - (region.y + region.h / 2)) > 1e-6) {
        clamped.push(c.label);
      }
    }
    // The editor settles a view by an edge where the site holds it, so the site moves none of them.
    expect(clamped.filter((l) => !l.endsWith(", typed"))).toEqual([]);
    // A spreadsheet author who types a point by an edge still gets the clamp.
    expect(clamped.filter((l) => l.endsWith(", typed")).length).toBeGreaterThan(0);
    // An overview is never moved: it stands inside the region, centred.
    for (const c of CASES.filter((k) => k.zoom < 1)) {
      expect(clamped, c.label).not.toContain(c.label);
      expect(clamped, c.label).not.toContain(`${c.label}, typed`);
    }
  });

  it("at zoom 2 and above, keeps the authored circle's image and draws it across the region's shorter side", () => {
    for (const { c, captured, framework } of results.filter((r) => r.c.zoom >= 2)) {
      // The author's circle and the framework's cover the same image pixels.
      expect(captured.circleImagePx, `${c.label} authored circle`).toBeCloseTo(framework.diameterImg, 6);
      // Replay draws it across the region's shorter side, whatever the window.
      const replayed = fitInPublishedViewer(c, captured.stored, framework.applied!);
      const region = visitorRegion(c.win);
      expect(framework.diameterImg * replayed.scale, `${c.label} replayed circle`).toBeCloseTo(
        Math.min(region.w, region.h), 6
      );
    }
  });

  it("replays at the whole-object fit at 1, the circle's scale at 2, and on the line between them at 1.5", () => {
    for (const { c, captured, framework } of results.filter((r) => r.c.zoom >= 1 && r.c.zoom <= 2)) {
      const region = visitorRegion(c.win);
      // Window pixels per image pixel with the whole object fitted in the region.
      const atOne = Math.min(region.w / c.image.w, region.h / c.image.h);
      // At 2 the authored frame is half the home frame wide, and its circle,
      // 0.9 of that width, is drawn across the region's shorter side.
      const circleAtTwo = (FOCAL_DIAMETER_FRAC * c.image.w) / (authoringHomeZoom(c.image.aspect) * 2);
      const atTwo = Math.min(region.w, region.h) / circleAtTwo;
      // In every window here the circle needs more than the whole-object fit.
      expect(atTwo, `${c.label}: the circle's scale exceeds the fit`).toBeGreaterThan(atOne);
      const expected = atOne + (c.zoom - 1) * (atTwo - atOne);
      const replayed = fitInPublishedViewer(c, captured.stored, framework.applied!);
      expect(replayed.scale, `${c.label} replay scale`).toBeCloseTo(expected, 9);
    }
  });

  it("below zoom 1, replays the object larger than the author saw it by the recorded ratio", () => {
    for (const { c, captured, framework } of results.filter((r) => r.c.zoom < 1)) {
      const replayed = fitInPublishedViewer(c, captured.stored, framework.applied!);
      const region = visitorRegion(c.win);
      // The whole object stands inside the region, centred, wherever the captured point was.
      const { image } = replayed;
      expect((image.left + image.right) / 2, `${c.label} x`).toBeCloseTo(region.x + region.w / 2, 6);
      expect((image.top + image.bottom) / 2, `${c.label} y`).toBeCloseTo(region.y + region.h / 2, 6);
      const ratio = (replayed.image.right - replayed.image.left) / captured.imageWidthPx;
      const key = `${c.win.w}×${c.win.h}, ${c.image.aspect}`;
      expect(ratio, `${c.label} overview ratio`).toBeCloseTo(OVERVIEW_RATIO[key], 4);
    }
  });
});

/**
 * Round trips below and across zoom 2 (ruling 17): the author frames a view,
 * the editor captures it and settles where the site will put it
 * (`captureFocal`'s view, which is what the column then shows), and the
 * framework replays what was stored. The views are near the centre, near the
 * left edge, and near the bottom-left corner.
 */
const ROUND_TRIP_ZOOMS = [0.5, 1, 1.25, 1.5, 1.9, 2, 3] as const;

const ROUND_TRIP_VIEWS = {
  interior: { x: 0.47, y: 0.53 },
  nearLeft: { x: 0.08, y: 0.5 },
  nearCorner: { x: 0.1, y: 0.9 },
} as const;

interface RoundTrip {
  c: Case;
  captured: Captured;
  settled: { x: number; y: number };
  framework: FrameworkReplay;
}

describeWithFramework("a view captured below zoom 2, settled, and replayed by the framework", () => {
  let trips: RoundTrip[] = [];

  beforeAll(() => {
    const cases = WINDOWS.flatMap((win) =>
      IMAGES.flatMap((image) =>
        ROUND_TRIP_ZOOMS.flatMap((zoom) =>
          (Object.keys(ROUND_TRIP_VIEWS) as Array<keyof typeof ROUND_TRIP_VIEWS>).map((view) => ({
            c: { win, image, zoom, focal: "interior" as FocalKind, label: `${win.w}×${win.h}, image ${image.aspect}, zoom ${zoom}, ${view}` },
            view: ROUND_TRIP_VIEWS[view],
          }))
        )
      )
    );
    const captured = cases.map(({ c, view }) => ({ c, captured: capture(c, view) }));
    const replays = frameworkReplay(captured.map(({ c, captured: cap }) => ({ c, stored: cap.stored })));
    trips = captured.map(({ c, captured: cap }, i) => ({
      c,
      captured: cap,
      settled: captureFocal(cap.view, cap.stored.zoom).view,
      framework: replays[i],
    }));
  }, FRAMEWORK_TIMEOUT_MS);

  it("stores the image's centre at an overview and the author's view above zoom 1, near an edge as well", () => {
    expect(trips).toHaveLength(WINDOWS.length * IMAGES.length * ROUND_TRIP_ZOOMS.length * 3);
    for (const { c, captured } of trips) {
      const want = workedStored(captured.view, c.zoom);
      expect(captured.stored.x, `${c.label} x`).toBeCloseTo(want.x, 9);
      expect(captured.stored.y, `${c.label} y`).toBeCloseTo(want.y, 9);
    }
  });

  it("settles on the author's view above zoom 1, and on the image's centre at an overview", () => {
    for (const { c, captured, settled } of trips) {
      if (c.zoom <= 1) {
        expect(settled, c.label).toEqual({ x: 0.5, y: 0.5 });
      } else {
        expect(settled.x, `${c.label} x`).toBeCloseTo(captured.view.x, 9);
        expect(settled.y, `${c.label} y`).toBeCloseTo(captured.view.y, 9);
      }
    }
  });

  it("shows in the editor the view the site shows, on an axis where the image is shorter than the region and on one it covers", () => {
    const checked: string[] = [];
    const shortChecked: string[] = [];
    for (const { c, captured, framework } of trips.filter((t) => t.c.zoom > 1)) {
      const replayed = fitInPublishedViewer(c, captured.stored, framework.applied!);
      const region = visitorRegion(c.win);
      // The image point replay shows at the region's centre, as fractions of the image.
      const shown = {
        x: (region.x + region.w / 2 - replayed.image.left) / replayed.scale / c.image.w,
        y: (region.y + region.h / 2 - replayed.image.top) / replayed.scale / c.image.h,
      };
      const short = {
        x: replayed.image.right - replayed.image.left < region.w - 1e-6,
        y: replayed.image.bottom - replayed.image.top < region.h - 1e-6,
      };
      for (const axis of ["x", "y"] as const) {
        checked.push(`${c.label} ${axis}`);
        if (short[axis]) shortChecked.push(`${c.label} ${axis}`);
        expect(captured.view[axis], `${c.label} ${axis}`).toBeCloseTo(shown[axis], 6);
      }
    }
    // The cases the site moves are among those checked: a view by an edge of an image shorter than the region.
    expect(shortChecked.length).toBeGreaterThan(0);
    expect(shortChecked.filter((l) => / zoom 1\.25,/.test(l) && l.includes("image 1,") && l.includes("1280×1024")).length).toBeGreaterThan(0);
    // And a view by an edge of an image that covers the region, where the site holds the image's edge on the region's.
    expect(checked.length).toBeGreaterThan(shortChecked.length);
  });

  it("replays the settled view at the region's centre, with the framework's edge clamp moving none of them", () => {
    const moved: string[] = [];
    const settledAway: string[] = [];
    for (const { c, captured, settled, framework } of trips) {
      expect(framework.applied, c.label).not.toBeNull();
      const replayed = fitInPublishedViewer(c, captured.stored, framework.applied!);
      const region = visitorRegion(c.win);
      const s = workedScale(c);
      const anchor = workedAnchor(captured.stored, c.zoom);
      const want = {
        x: workedAxis(region.x, region.w, c.image.w, anchor.x * c.image.w, s),
        y: workedAxis(region.y, region.h, c.image.h, anchor.y * c.image.h, s),
      };
      // The image point replay shows at the region's centre, as fractions of the image.
      const shown = {
        x: (region.x + region.w / 2 - replayed.image.left) / replayed.scale / c.image.w,
        y: (region.y + region.h / 2 - replayed.image.top) / replayed.scale / c.image.h,
      };
      if (Math.abs(want.x - (region.x + region.w / 2)) < 1e-9 && Math.abs(want.y - (region.y + region.h / 2)) < 1e-9) {
        expect(shown.x, `${c.label} x`).toBeCloseTo(settled.x, 6);
        expect(shown.y, `${c.label} y`).toBeCloseTo(settled.y, 6);
        if (c.zoom > 1 && Math.hypot(settled.x - captured.view.x, settled.y - captured.view.y) > 1e-6) settledAway.push(c.label);
      } else {
        // The image's edge is held on the region's, or the image inside it (`_clampFocalPx`).
        moved.push(c.label);
        expect(replayed.image.left + anchor.x * c.image.w * replayed.scale, `${c.label} anchor x`).toBeCloseTo(want.x, 6);
        expect(replayed.image.top + anchor.y * c.image.h * replayed.scale, `${c.label} anchor y`).toBeCloseTo(want.y, 6);
      }
    }
    // Above zoom 1 the editor settles on the author's own view.
    expect(settledAway).toEqual([]);
    // The editor holds a view where the site shows it, near the centre and by an
    // edge alike, so the clamp moves none of them.
    expect(moved).toEqual([]);
  });
});

/**
 * A stored framing restored (a step opened, or Reset) shows where the site
 * shows it: `applyFraming` puts the stored point through the same constraints
 * as a gesture, so a point by an image's edge opens at the framework's
 * `framePlacement` position and not at the stored one.
 */
describeWithFramework("a stored framing restored in the editor, replayed by the framework", () => {
  const STORED: Array<{ x: number; y: number }> = [
    { x: 0.04, y: 0.5 },
    { x: 0.5, y: 0.96 },
    { x: 0.04, y: 0.9 },
    { x: 0.47, y: 0.53 },
  ];
  const RESTORE_ZOOMS = [1.5, 3] as const;
  let restored: Array<{
    c: Case;
    shown: { x: number; y: number };
    site: { x: number; y: number };
    stored: { x: number; y: number };
    zoom: number;
    recaptured: number;
  }> = [];

  beforeAll(() => {
    const cases = WINDOWS.flatMap((win) =>
      IMAGES.flatMap((image) =>
        RESTORE_ZOOMS.flatMap((zoom) =>
          STORED.map((f, i) => ({
            c: { win, image, zoom, focal: "interior" as FocalKind, label: `${win.w}×${win.h}, image ${image.aspect}, zoom ${zoom}, stored ${i}` },
            f,
          }))
        )
      )
    );
    const replays = frameworkReplay(cases.map(({ c, f }) => ({ c, stored: { x: f.x, y: f.y, zoom: c.zoom } })));
    restored = cases.map(({ c, f }, i) => {
      const region = visitorRegion(c.win);
      const pane = { x: c.win.w * STAGE_SCALE, y: c.win.h * STAGE_SCALE };
      const r = viewportRig({ x: c.image.w, y: c.image.h }, pane, (p) => {
        const k = p.w / c.win.w;
        return { x: region.x * k, y: region.y * k, w: region.w * k, h: region.h * k };
      });
      openRig(r);
      applyFraming(r.viewer as unknown as OpenSeadragon.Viewer, { x: f.x, y: f.y, zoom: c.zoom, page: "1" } as never);
      settle(r.viewport);
      const centre = r.item.viewportToImageCoordinates(r.viewport.getCenter().x, r.viewport.getCenter().y);
      const replayed = fitInPublishedViewer(c, { x: f.x, y: f.y, zoom: c.zoom }, replays[i].applied!);
      const vp = r.viewport;
      const again = captureViewportState(vp.getCenter(), vp.getZoom(), 0, vp.getHomeBounds(), vp.getHomeZoom(), r.item);
      return {
        c,
        stored: f,
        zoom: vp.getZoom() / vp.getHomeZoom(),
        recaptured: again.zoom,
        shown: { x: centre.x / c.image.w, y: centre.y / c.image.h },
        site: {
          x: (region.x + region.w / 2 - replayed.image.left) / replayed.scale / c.image.w,
          y: (region.y + region.h / 2 - replayed.image.top) / replayed.scale / c.image.h,
        },
      };
    });
  }, FRAMEWORK_TIMEOUT_MS);

  it("opens a stored framing where the site shows it, by an edge as well as near the centre", () => {
    expect(restored).toHaveLength(WINDOWS.length * IMAGES.length * RESTORE_ZOOMS.length * STORED.length);
    for (const { c, shown, site } of restored) {
      expect(shown.x, `${c.label} x`).toBeCloseTo(site.x, 6);
      expect(shown.y, `${c.label} y`).toBeCloseTo(site.y, 6);
    }
  });

  it("keeps the saved zoom on restore, and a Capture right after writes the same zoom back", () => {
    for (const { c, zoom, recaptured } of restored) {
      expect(zoom, `${c.label} zoom`).toBeCloseTo(c.zoom, 9);
      expect(recaptured, `${c.label} captured zoom`).toBeCloseTo(c.zoom, 9);
    }
  });

  it("includes stored points the site moves off where they were stored", () => {
    const moved = restored.filter(({ stored, site }) => Math.hypot(stored.x - site.x, stored.y - site.y) > 1e-3);
    expect(moved.length).toBeGreaterThan(0);
  });
});

describe("a zoom past OSD's default maximum, in the editor", () => {
  // A 100×100 image in a 900×473 pane confined to a 640×473 region: OSD's
  // default maximum zoom is home's, and the site shows zoom 3 all the same.
  const smallRig = () => {
    const r = viewportRig({ x: 100, y: 100 }, { x: 900, y: 473 }, (p) => ({ x: 0, y: 0, w: (p.w * 640) / 900, h: p.h }));
    openRig(r);
    return r;
  };
  const viewerOf = (r: ReturnType<typeof smallRig>) => r.viewer as unknown as OpenSeadragon.Viewer;
  const shown = (r: ReturnType<typeof smallRig>) => {
    const vp = r.viewport;
    const c = r.item.viewportToImageCoordinates(vp.getCenter().x, vp.getCenter().y);
    return {
      zoom: vp.getZoom() / vp.getHomeZoom(),
      x: c.x / 100,
      y: c.y / 100,
      captured: captureViewportState(vp.getCenter(), vp.getZoom(), 0, vp.getHomeBounds(), vp.getHomeZoom(), r.item).zoom,
    };
  };
  const restore = (r: ReturnType<typeof smallRig>, x = 0.5, y = 0.5, zoom = 3) => {
    applyFraming(viewerOf(r), { x, y, zoom, page: "1" } as never);
    settle(r.viewport);
  };

  it("opens at the saved zoom, and a Capture right after writes it back", () => {
    const r = smallRig();
    restore(r);
    const now = shown(r);
    expect(now.zoom).toBeCloseTo(3, 9);
    expect(now.captured).toBeCloseTo(3, 9);
  });

  it("keeps the saved zoom and the site's centre through a pane resize", async () => {
    const r = smallRig();
    restore(r, 0.04, 0.5);
    const before = shown(r);
    doViewerResize(r, { x: 1000, y: 600 });
    await Promise.resolve();
    settle(r.viewport);
    const after = shown(r);
    expect(after.zoom).toBeCloseTo(3, 9);
    expect(after.captured).toBeCloseTo(3, 9);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("zooms in past the old maximum with the button, and a Capture writes the zoom shown", () => {
    const r = smallRig();
    restore(r);
    for (let i = 0; i < 4; i += 1) {
      zoomConstrained(viewerOf(r), 1.5);
      settle(r.viewport);
    }
    const now = shown(r);
    expect(now.zoom).toBeCloseTo(3 * 1.5 ** 4, 6);
    expect(now.captured).toBeCloseTo(now.zoom, 9);
    // And the button does not take a zoom the site accepts back down.
    zoomConstrained(viewerOf(r), 0.99);
    settle(r.viewport);
    expect(shown(r).zoom).toBeCloseTo(now.zoom * 0.99, 6);
  });

  it("keeps a stored zoom beyond even the raised maximum, through a resize and the zoom button", async () => {
    const r = smallRig();
    restore(r, 0.5, 0.5, 2e7);
    doViewerResize(r, { x: 1000, y: 600 });
    await Promise.resolve();
    settle(r.viewport);
    expect(shown(r).zoom / 2e7).toBeCloseTo(1, 6);
    zoomConstrained(viewerOf(r), 1.5);
    settle(r.viewport);
    expect(shown(r).zoom / 2e7).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it("zooms in by gesture on a small image to a zoom above OSD's default maximum", () => {
    const r = smallRig();
    r.viewport.zoomBy(6, null as unknown as OpenSeadragon.Point, true);
    r.viewport.applyConstraints(true);
    settle(r.viewport);
    const now = shown(r);
    expect(now.zoom).toBeCloseTo(6, 6);
    expect(now.captured).toBeCloseTo(6, 6);
  });
});
