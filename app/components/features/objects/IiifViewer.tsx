/**
 * IiifViewer — OpenSeadragon-based IIIF image viewer with page navigation.
 *
 * Renders an OpenSeadragon viewer from a manifest URL or info.json URL.
 * For multi-page manifests (e.g. PDFs), shows page indicators and prev/next.
 * For self-hosted objects, probes info.json first and shows a fallback
 * message if tiles are not yet available (build in progress).
 *
 * Client-only — guarded with typeof window check to avoid SSR crashes.
 *
 * An optional capture-guides overlay (the `enableCaptureGuides` prop) draws the
 * frame a captured zoom is measured in — the largest rectangle of the authoring
 * aspect centred in the pane — with a camera-style centre target, and at a
 * detail zoom the focal circle the published story keeps beside its card. The
 * capture viewer is also measured in that frame (`measureInAuthoringFrame`):
 * its home is the image filling it, so a captured zoom means what replay reads
 * whatever shape the pane has. Its keyboard cannot rotate or mirror the view,
 * since a step records neither (`holdOrientation`), and at zoom 1 and below it
 * keeps the image centred, as the published page does (`holdOverviewCentred`).
 *
 * The capture viewer can be confined to a region of its pane (`regionOf`):
 * the part of the visitor's window the published page frames the image into.
 * OSD's viewport margins leave only that region as the area it measures in,
 * from construction, on every resize and after any render that changes the
 * region without resizing the pane, so the frame is inscribed in the
 * region, a capture's centre is the region's centre, and the guides are drawn
 * there. Two labels then say which area is which: the frame is what every
 * visitor sees, and the pane is what a visitor with a window shaped like the
 * author's sees.
 *
 * A parent may drive the page (`page`), hide the built-in page controls
 * (`hidePageControls`) and watch the source (`onSourceState`). The viewer does
 * not keep a live OpenSeadragon instance across pages: every page or source
 * change destroys the instance and constructs a new one, taking every handler
 * the parent registered with it. Each source therefore carries a `generation`
 * counter, and both the tile-availability check and the manifest read drop
 * their results once it has moved on, so an instance is never constructed
 * against a source the viewer has left. `onViewerReady` names the source key,
 * generation and page each instance was constructed for, so the parent can
 * match its own pending work to the instance in front of it rather than to its
 * own current props, and `onViewerDestroyed` names the same instance as it goes,
 * so the parent's record never outlives the object it describes: there is a gap
 * between a destruction and the replacement's readiness, and a viewport applied
 * in that gap reaches nothing.
 *
 * @version v1.5.2-beta
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  ImageOff,
  ZoomIn,
  ZoomOut,
  Maximize,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  focalCircle,
  holdOrientation,
  holdOverviewCentred,
  frameInRegion,
  measureInAuthoringFrame as attachAuthoringFrame,
  reconfine,
  regionMargins,
  regionOrPane,
} from "~/lib/authoring-frame";
import type { CentredViewer, KeyedViewer, MeasuredViewer, PaneRect, RegionOf } from "~/lib/authoring-frame";
import { extractAllPages, sourceKeyFor } from "~/lib/iiif-pages";
import { TilesPlaceholder, Viewfinder, type ViewerChrome } from "~/components/features/objects/IiifViewerParts";
import type { ManifestPage } from "~/lib/iiif-pages";

/**
 * What the viewer knows about the source it is pointed at. `ready` describes the
 * selection — the page whose instance is being constructed — not the arrival of
 * tiles.
 */
export interface SourceState {
  sourceKey: string;
  generation: number;
  status: "loading" | "ready" | "unavailable";
  /** 0-based effective page */
  page: number;
  pageCount: number;
  pages: ManifestPage[];
}

/** The immutable facts about one constructed OpenSeadragon instance. */
export interface ViewerInstanceMeta {
  sourceKey: string;
  generation: number;
  /** 0-based page the instance was constructed for */
  page: number;
}

/** A target page counts as 0 unless it is a non-negative integer. */
function normalisePageProp(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

/** What the viewer has read for one source, each answer tagged with its generation. */
interface SourceRecord {
  key: string;
  generation: number;
  tiles: { generation: number; available: boolean } | null;
  loaded: { generation: number; pages: ManifestPage[] } | null;
}

/**
 * The tile availability and the pages that belong to the CURRENT generation.
 * A previous source's answers are dropped here rather than guarded at each
 * use, so no path can construct an instance against a source the viewer left.
 */
function currentRecords(source: SourceRecord, generation: number) {
  const tiles = source.tiles?.generation === generation ? source.tiles : null;
  const loaded = source.loaded?.generation === generation ? source.loaded : null;
  return { tiles, pages: loaded ? loaded.pages : null, pageCount: loaded ? loaded.pages.length : 0 };
}

/** The page an instance is constructed for: the request, clamped to the count. */
export function effectivePageOf(request: number, pageCount: number): number {
  return pageCount > 0 ? Math.min(request, pageCount - 1) : 0;
}

interface IiifViewerProps {
  /** Full URL to the IIIF manifest (Presentation API v2 or v3) */
  manifestUrl: string | null;
  /** Full URL to info.json (Image API) — used for self-hosted tile check */
  infoJsonUrl: string | null;
  /** Whether this is a self-hosted object (needs tile availability check) */
  isSelfHosted: boolean;
  /** Alt text for the image */
  alt?: string;
  /** Additional CSS classes for the container */
  className?: string;
  /**
   * Called once the OpenSeadragon viewer instance is ready. Receives the
   * viewer, a getter for that instance's 0-based page, and the construction
   * metadata identifying which source, generation and page it belongs to.
   */
  onViewerReady?: (
    viewer: OpenSeadragon.Viewer,
    getCurrentPage: () => number,
    meta: ViewerInstanceMeta
  ) => void;
  /**
   * Called as the instance named by `meta` is destroyed, before any replacement
   * is constructed. A parent holding that instance must drop it here: between a
   * destruction and the next `onViewerReady` there is no viewer to act on.
   */
  onViewerDestroyed?: (meta: ViewerInstanceMeta) => void;
  /** Hide the built-in zoom/fit controls (e.g. when the parent provides its own overlays) */
  hideZoomControls?: boolean;
  /** Called when the user clicks "Generate tiles" — parent dispatches the workflow */
  onGenerateTiles?: () => void;
  /** Whether tile generation is in progress */
  isGenerating?: boolean;
  /**
   * Show capture framing guides: the authoring frame a captured zoom is
   * measured in, the centre target, and at zoom 2 and above the focal circle
   * replay frames. They show what is measured, not what a reader will see
   * beside a card. Off by the parent for non-image media.
   */
  enableCaptureGuides?: boolean;
  /**
   * Measure this viewer's zoom in the authoring frame: its home becomes the
   * image filling the largest `AUTHORING_ASPECT` frame centred in the pane, on
   * open and on every resize. For the story editor's capture viewer only; the
   * object page's viewer keeps OSD's native home.
   */
  measureInAuthoringFrame?: boolean;
  /**
   * Confine the capture viewer to a region of its pane: a function of the
   * pane's size in pixels returning the region's box in the same pixels, or
   * null for the whole pane. Read only with `measureInAuthoringFrame`, since
   * the handler that keeps the margins in step on resize is the authoring
   * frame's. The function is read at each use, so a new identity does not
   * rebuild the viewer. Absent, the viewer is constructed with no margins and
   * no region handling. The object page never passes it.
   */
  regionOf?: RegionOf;
  /**
   * 0-based target page. The viewer navigates whenever this value changes; a
   * rerender with an unchanged value reasserts nothing, so the built-in buttons
   * can still move the page and the parent learns of it through
   * `onSourceState`. A value at or beyond the page count is clamped to the last
   * page, and re-resolved whenever the pages arrive or their count changes.
   */
  page?: number;
  /** Reports the source key, generation, status, effective page, count and page records. */
  onSourceState?: (state: SourceState) => void;
  /** Hide the built-in previous/next/counter (e.g. when the parent provides its own). */
  hidePageControls?: boolean;
  /**
   * OSD's `minZoomImageRatio` for the constructed instance. Optional, not a
   * default: OSD's own default (0.9) already lets browsing zoom out a little,
   * and the object detail page has no reason to zoom out further — only the
   * editor's capture flow needs to reach a framing the published story can
   * render. When absent, OSD is constructed exactly as before (the option is
   * not passed at all, not passed as `undefined`), so the detail route's
   * behaviour is unchanged.
   */
  minZoomImageRatio?: number;
  /** OSD's `maxZoomLevel`, passed only where given, as `minZoomImageRatio` is. */
  maxZoomLevel?: number;
  /** Told whether the capture guides are showing, when they are turned on or off. */
  onGuidesToggle?: (on: boolean) => void;
  /**
   * Put the stage label under the frame label rather than in the pane's
   * bottom-left corner: in portrait, where the bottom card covers that corner.
   */
  stageLabelUnderFrame?: boolean;
  /**
   * On the framing stage, whose chrome lays out every control and tag
   * together: the Viewfinder toggle is placed at `viewfinderAt` and measured
   * through `viewfinderRef`, and the frame and stage labels are left to the
   * stage's guide tags.
   */
  chrome?: ViewerChrome;
}

export function IiifViewer({
  manifestUrl,
  infoJsonUrl,
  isSelfHosted,
  alt,
  className = "",
  onViewerReady,
  onViewerDestroyed,
  hideZoomControls = false,
  onGenerateTiles,
  isGenerating = false,
  enableCaptureGuides = false,
  page,
  onSourceState,
  hidePageControls = false,
  minZoomImageRatio,
  maxZoomLevel,
  measureInAuthoringFrame = false,
  regionOf,
  onGuidesToggle,
  stageLabelUnderFrame = false,
  chrome,
}: IiifViewerProps) {
  const { t } = useTranslation("objects");
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameLabelRef = useRef<HTMLDivElement | null>(null);
  const stageLabelRef = useRef<HTMLDivElement | null>(null);
  // The region function in force, read through a ref so a parent's fresh
  // identity per render neither rebuilds the viewer nor re-binds the guides.
  const regionOfRef = useRef<RegionOf | undefined>(undefined);
  regionOfRef.current = regionInForce(measureInAuthoringFrame, regionOf);
  const inRegion = regionOfRef.current !== undefined;
  // Removes the live instance's authoring-frame and orientation handlers,
  // where it has them.
  const detachFrameRef = useRef<(() => void) | null>(null);
  // Bumped whenever a fresh OSD viewer is created, so the guide effect re-binds.
  const [viewerReadyTick, setViewerReadyTick] = useState(0);
  const [guidesOn, setGuidesOn] = useState(true);
  const onGuidesToggleRef = useRef(onGuidesToggle);
  onGuidesToggleRef.current = onGuidesToggle;
  useEffect(() => {
    onGuidesToggleRef.current?.(guidesOn);
  }, [guidesOn]);
  // Bumped by the retry button so the tile check runs again for the same source.
  const [retryTick, setRetryTick] = useState(0);

  const hasSource = Boolean(manifestUrl || infoJsonUrl);
  const sourceKey = sourceKeyFor(manifestUrl, infoJsonUrl);

  // The metadata of the instance that exists right now, so a destruction can
  // name it. The destroy callback is read through a ref: it must not be a
  // dependency of the construction effect, which would rebuild the instance
  // whenever a parent passes a fresh callback identity.
  const liveMetaRef = useRef<ViewerInstanceMeta | null>(null);
  const onViewerDestroyedRef = useRef(onViewerDestroyed);
  onViewerDestroyedRef.current = onViewerDestroyed;

  /** Destroy the live instance, if any, and tell the parent which one went. */
  const destroyViewer = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const meta = liveMetaRef.current;
    viewerRef.current = null;
    liveMetaRef.current = null;
    detachFrameRef.current?.();
    detachFrameRef.current = null;
    viewer.destroy();
    if (meta) onViewerDestroyedRef.current?.(meta);
  }, []);

  // The source and everything read for it. Tile availability and loaded pages
  // are tagged with the generation they were read under, and both are cleared
  // in the same render that changes the key, so a previous source's answers can
  // never authorise construction for the current one.
  const [source, setSource] = useState<SourceRecord>(
    () => ({ key: sourceKey, generation: 0, tiles: null, loaded: null })
  );

  if (source.key !== sourceKey) {
    setSource({
      key: sourceKey,
      generation: source.generation + 1,
      tiles: null,
      loaded: null,
    });
  }

  const generation = source.generation;
  const generationRef = useRef(generation);
  generationRef.current = generation;

  const {
    tiles: tilesRecord, pages: loadedPages, pageCount,
  } = currentRecords(source, generation);

  // The requested page: the prop's value, tracked by prop identity so an
  // unchanged prop reasserts nothing, and moved by the built-in buttons.
  const [pageRequest, setPageRequest] = useState<{
    prop: number | undefined;
    value: number;
  }>(() => ({ prop: page, value: normalisePageProp(page) }));

  // `Object.is`, not `!==`: a non-finite target counts as page 0, and `NaN`
  // never equals itself, so a strict comparison would re-request it forever.
  if (!Object.is(pageRequest.prop, page)) {
    setPageRequest({ prop: page, value: normalisePageProp(page) });
  }

  const currentPage = effectivePageOf(pageRequest.value, pageCount);

  // Check tile availability for self-hosted objects. The result is dropped when
  // the generation has moved on, so a pending HEAD for a previous source can
  // neither authorise nor block the current one.
  useEffect(() => {
    const gen = generation;
    const recordTiles = (available: boolean) =>
      setSource((s) =>
        s.generation === gen ? { ...s, tiles: { generation: gen, available } } : s
      );

    if (!isSelfHosted || !infoJsonUrl) {
      recordTiles(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(infoJsonUrl, { method: "HEAD", mode: "cors" });
        if (!cancelled) recordTiles(res.ok);
      } catch {
        if (!cancelled) recordTiles(false);
      }
    })();
    return () => { cancelled = true; };
  }, [generation, isSelfHosted, infoJsonUrl, retryTick]);

  // Read the manifest for this source. A non-OK HTTP status counts as a failure
  // exactly as a thrown fetch does: where an info.json is present the source
  // falls back to it as a single page, which is what the object detail page
  // relies on for self-hosted objects with no manifest.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!tilesRecord || !tilesRecord.available) return;

    const gen = generation;
    let cancelled = false;
    const recordPages = (pages: ManifestPage[]) => {
      if (cancelled) return;
      setSource((s) =>
        s.generation === gen ? { ...s, loaded: { generation: gen, pages } } : s
      );
    };
    const fallback = () => recordPages(infoJsonUrl ? [{ tileSource: infoJsonUrl }] : []);

    if (!manifestUrl) {
      fallback();
      return;
    }

    (async () => {
      try {
        const res = await fetch(manifestUrl);
        if (cancelled) return;
        if (!res.ok) { fallback(); return; }
        const manifest = await res.json() as Record<string, unknown>;
        if (cancelled) return;
        const extracted = extractAllPages(manifest);
        if (extracted.length > 0) recordPages(extracted);
        else fallback();
      } catch {
        fallback();
      }
    })();
    return () => { cancelled = true; };
  }, [generation, tilesRecord, manifestUrl, infoJsonUrl]);

  // Report the source to the parent. The status describes the selection, not
  // the arrival of tiles: `ready` means the page whose instance is being
  // constructed is known.
  useEffect(() => {
    if (!onSourceState) return;
    let status: SourceState["status"];
    if (!hasSource || (tilesRecord && !tilesRecord.available)) status = "unavailable";
    else if (loadedPages) status = loadedPages.length > 0 ? "ready" : "unavailable";
    else status = "loading";

    onSourceState({
      sourceKey,
      generation,
      status,
      page: status === "ready" ? currentPage : 0,
      pageCount: status === "ready" ? pageCount : 0,
      pages: status === "ready" ? loadedPages! : [],
    });
  }, [
    onSourceState,
    sourceKey,
    generation,
    hasSource,
    tilesRecord,
    loadedPages,
    currentPage,
    pageCount,
  ]);

  // Initialise/update OpenSeadragon. Runs only once both the tile availability
  // and the loaded pages belong to the current generation, and resolves the
  // effective page against the loaded count before dereferencing a tile source.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!tilesRecord || !tilesRecord.available) return;
    if (!loadedPages || loadedPages.length === 0 || !containerRef.current) return;

    const gen = generation;
    const key = sourceKey;
    const index = currentPage;
    const tileSource = loadedPages[index]?.tileSource;
    if (!tileSource) return;

    let destroyed = false;

    async function init() {
      const OpenSeadragon = (await import("openseadragon")).default;
      if (destroyed || !containerRef.current) return;
      if (generationRef.current !== gen) return;

      destroyViewer();

      const regionFn = regionOfRef.current;
      const pane = { w: containerRef.current.clientWidth, h: containerRef.current.clientHeight };

      viewerRef.current = OpenSeadragon({
        element: containerRef.current,
        tileSources: tileSource,
        showNavigationControl: false,
        // A click or tap never zooms, matching the published site (telar-story.js,
        // iiif-card.js, object-image.js). Zoom stays with the scroll wheel, pinch,
        // double-tap-and-drag on touch (OSD's dblClickDragToZoom, which
        // holdOverviewCentred expects), the keyboard and the zoom buttons. OSD
        // defaults clickToZoom true for mouse and pen, and dblClickToZoom true for
        // touch, so each is disabled here; the other gestures keep their defaults.
        gestureSettingsMouse: { scrollToZoom: true, clickToZoom: false, dblClickToZoom: false },
        gestureSettingsPen: { clickToZoom: false, dblClickToZoom: false },
        gestureSettingsTouch: {
          clickToZoom: false,
          dblClickToZoom: false,
          pinchToZoom: true,
          dragToPan: true,
          flickEnabled: true,
        },
        prefixUrl: "",
        // Force the Canvas2D drawer. OSD 6 defaults to WebGL, whose texImage2D()
        // throws SecurityError on cross-origin IIIF tiles loaded without
        // crossOrigin (the common case — tiles come from arbitrary external IIIF
        // servers). That made every tile fail ("Error creating texture in WebGL"),
        // OSD silently fell back to Canvas2D, and the failed-WebGL→canvas
        // transition left the viewer blank until an interaction forced a redraw.
        // Canvas2D renders cross-origin tiles regardless of CORS and is the drawer
        // OSD was already falling back to, so this is deterministic with no visual
        // change. (We never read pixels back, so canvas tainting is irrelevant.)
        drawer: "canvas",
        // Spread in only when present, so the options object holds the key for
        // a caller that asked for a floor and holds nothing for one that did
        // not: the detail route's construction is the call it was before this
        // prop existed. OSD 6.0.2's option merge does skip an undefined value,
        // so `minZoomImageRatio: undefined` would reach the same defaults
        // today — this does not rest on that, which is the point of writing it
        // as a presence rather than a value.
        ...(minZoomImageRatio !== undefined ? { minZoomImageRatio } : {}),
        ...(maxZoomLevel !== undefined ? { maxZoomLevel } : {}),
        // Present only for a viewer confined to a region, for the same reason.
        ...marginsOption(regionFn, pane),
      });

      // Before `onViewerReady`, so its `open` handler runs ahead of every
      // handler the parent registers: a saved framing and the first readout
      // are then taken against the authoring frame's home.
      if (measureInAuthoringFrame) {
        const detachFrame = regionFn
          ? attachAuthoringFrame(
              viewerRef.current as unknown as MeasuredViewer,
              () => regionOfRef.current
            )
          : attachAuthoringFrame(viewerRef.current as unknown as MeasuredViewer);
        const releaseOrientation = holdOrientation(
          viewerRef.current as unknown as KeyedViewer
        );
        const releaseOverview = holdOverviewCentred(
          viewerRef.current as unknown as CentredViewer
        );
        detachFrameRef.current = () => {
          detachFrame();
          releaseOrientation();
          releaseOverview();
        };
      }

      const meta: ViewerInstanceMeta = { sourceKey: key, generation: gen, page: index };
      liveMetaRef.current = meta;
      if (onViewerReady) onViewerReady(viewerRef.current, () => index, meta);
      if (!destroyed) setViewerReadyTick((n) => n + 1);
    }

    init();

    return () => {
      destroyed = true;
      destroyViewer();
    };
  // `onViewerReady` is deliberately not a dependency: a parent that supplies a
  // fresh callback identity per render must not destroy and rebuild the
  // instance, which would drop every handler registered on it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    generation,
    sourceKey,
    tilesRecord,
    loadedPages,
    currentPage,
    destroyViewer,
    minZoomImageRatio,
    maxZoomLevel,
    measureInAuthoringFrame,
    inRegion,
  ]);

  // A region that changes while the pane keeps its size (a media step's card,
  // the visitor's layout crossing a breakpoint at the same stage pixels) is
  // never reported by OSD's resize, so after every render the live instance
  // is brought to the region in force. `reconfine` does nothing while the
  // margins already match.
  useEffect(() => {
    const viewer = viewerRef.current;
    const regionFn = regionOfRef.current;
    if (!viewer || !regionFn) return;
    reconfine(viewer as unknown as MeasuredViewer, regionFn);
  });

  // Capture framing guides, in pane pixels: the authoring frame the zoom is
  // measured in, inscribed in the region (the pane where there is none); the
  // focal circle at zoom 2 and above; and the centre target at the region's
  // centre, which is where OSD's centre is drawn. The frame label follows the
  // frame's top edge. Redrawn on every viewport change via
  // requestAnimationFrame coalescing.
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    const viewer = viewerRef.current;
    const container = containerRef.current;
    const ctx = canvas?.getContext("2d") ?? null;

    const clear = () => {
      if (!canvas || !ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    if (!enableCaptureGuides || !guidesOn || !canvas || !ctx || !viewer || !container) {
      clear();
      return;
    }

    let raf = 0;

    const draw = () => {
      raf = 0;
      const vp = viewer.viewport;
      const dpr = window.devicePixelRatio || 1;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw === 0 || ch === 0) return;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        canvas.style.width = `${cw}px`;
        canvas.style.height = `${ch}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      let z: number;
      try {
        z = vp.getZoom() / vp.getHomeZoom();
      } catch {
        return;
      }
      if (!Number.isFinite(z) || z <= 0) return;

      // The frame, inset by the stroke so an edge on the pane's own edge shows.
      const region = regionOrPane(regionOfRef.current, { w: cw, h: ch });
      const frame = frameInRegion(region);
      placeFrameLabel(frameLabelRef.current, frame);
      if (stageLabelUnderFrame) placeUnderFrameLabel(stageLabelRef.current, frameLabelRef.current, frame);
      const outline = new Path2D();
      outline.rect(frame.x + 1.5, frame.y + 1.5, frame.width - 3, frame.height - 3);
      haloStroke(ctx, outline);

      const circle = focalCircle(frame, z);
      if (circle) {
        const path = new Path2D();
        path.arc(circle.cx, circle.cy, circle.radius, 0, Math.PI * 2);
        haloStroke(ctx, path);
      }

      drawCentreTarget(ctx, region.x + region.w / 2, region.y + region.h / 2);
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const events = ["animation", "animation-finish", "update-viewport", "open", "resize"];
    events.forEach((e) => viewer.addHandler(e as never, schedule));
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      events.forEach((e) => viewer.removeHandler(e as never, schedule));
      ro.disconnect();
      clear();
    };
  }, [enableCaptureGuides, guidesOn, viewerReadyTick, currentPage, inRegion, stageLabelUnderFrame]);

  function goToPage(target: number) {
    if (target >= 0 && target < pageCount) {
      setPageRequest({ prop: page, value: target });
    }
  }

  // No manifest URL at all
  if (!hasSource) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gray-100 rounded-lg ${className}`}
      >
        <ImageOff className="w-12 h-12 text-gray-300 mb-3" />
        <p className="font-body text-sm text-gray-400">{t("viewer_no_image")}</p>
      </div>
    );
  }

  // Self-hosted: checking or unavailable
  if (isSelfHosted && !tilesRecord?.available) {
    return (
      <TilesPlaceholder
        checking={tilesRecord === null}
        className={className}
        onGenerateTiles={onGenerateTiles}
        isGenerating={isGenerating}
        onRetry={() => setRetryTick((n) => n + 1)}
      />
    );
  }

  const isMultiPage = !hidePageControls && pageCount > 1;

  // Viewer container with controls
  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Telar weave pattern behind the image + drop-shadow on the image —
          see .iiif-viewer-surface in app/styles/app.css (ported from the
          framework's IIIF plates: 20px-tiled weave, shadow tracks the image). */}
      <div
        ref={containerRef}
        role="img"
        aria-label={alt ?? "IIIF image viewer"}
        className="iiif-viewer-surface w-full h-full"
      />

      {/* Capture framing guides — canvas overlay (drawn imperatively) + a toggle
          and legend. Shows the frame a captured zoom is measured in. */}
      {enableCaptureGuides && (
        <>
          <canvas
            ref={overlayCanvasRef}
            className="pointer-events-none absolute inset-0 z-[5]"
            aria-hidden="true"
          />
          <Viewfinder guidesOn={guidesOn} onToggle={() => setGuidesOn((v) => !v)} chrome={chrome} />
          <StageLabels
            inRegion={inRegion && !chrome}
            guidesOn={guidesOn}
            frameLabelRef={frameLabelRef}
            stageLabelRef={stageLabelRef}
            underFrame={stageLabelUnderFrame}
          />
        </>
      )}

      {/* Zoom controls — top left (hidden when parent provides its own overlays) */}
      {!hideZoomControls && <div className="absolute top-3 left-3 flex flex-col gap-1.5 z-10">
        <button
          type="button"
          onClick={() => viewerRef.current?.viewport.zoomBy(1.5)}
          className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 bg-white/90 hover:bg-white rounded-lg shadow flex items-center justify-center text-charcoal transition-colors"
          aria-label={t("viewer_zoom_in_aria")}
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => viewerRef.current?.viewport.zoomBy(0.67)}
          className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 bg-white/90 hover:bg-white rounded-lg shadow flex items-center justify-center text-charcoal transition-colors"
          aria-label={t("viewer_zoom_out_aria")}
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => viewerRef.current?.viewport.goHome()}
          className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 bg-white/90 hover:bg-white rounded-lg shadow flex items-center justify-center text-charcoal transition-colors"
          aria-label={t("viewer_reset_aria")}
        >
          <Maximize className="w-4 h-4" />
        </button>
      </div>}

      {/* Page navigation — bottom center */}
      {isMultiPage && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
          <button
            type="button"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage === 0}
            className="w-8 h-8 bg-white/90 hover:bg-white rounded-lg shadow flex items-center justify-center text-charcoal transition-colors disabled:opacity-40 disabled:cursor-default"
            aria-label={t("viewer_prev_page_aria")}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="h-8 min-w-8 bg-white/90 rounded-lg shadow flex items-center justify-center px-2 font-body text-xs text-charcoal font-medium tabular-nums">
            {currentPage + 1}/{pageCount}
          </span>
          <button
            type="button"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage === pageCount - 1}
            className="w-8 h-8 bg-white/90 hover:bg-white rounded-lg shadow flex items-center justify-center text-charcoal transition-colors disabled:opacity-40 disabled:cursor-default"
            aria-label={t("viewer_next_page_aria")}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/** The region function a viewer is confined by: only a capture viewer's. */
function regionInForce(measured: boolean, regionOf: RegionOf | undefined): RegionOf | undefined {
  return measured ? regionOf : undefined;
}

/**
 * The construction option that confines a viewer to its region, or nothing:
 * present only for a confined viewer, so an unconfined one is constructed
 * with the options it had before the region existed.
 */
function marginsOption(regionOf: RegionOf | undefined, pane: { w: number; h: number }) {
  return regionOf ? { viewportMargins: regionMargins(pane, regionOf(pane)) } : {};
}

/** Put the frame label at the top of `frame`, and show it once it is there. */
function placeFrameLabel(label: HTMLElement | null, frame: PaneRect) {
  if (!label) return;
  label.style.left = `${frame.x + frame.width / 2}px`;
  label.style.top = `${frame.y + 8}px`;
  label.style.visibility = "visible";
}

/** The gap between the frame label and the stage label under it. */
const LABEL_GAP = 6;
/** A one-line label's height, until the frame label has been laid out. */
const LABEL_HEIGHT_UNMEASURED = 20;

/** Put the stage label under the frame label, centred on the frame as it is. */
function placeUnderFrameLabel(label: HTMLElement | null, frameLabel: HTMLElement | null, frame: PaneRect) {
  if (!label) return;
  const above = frameLabel?.offsetHeight || LABEL_HEIGHT_UNMEASURED;
  label.style.left = `${frame.x + frame.width / 2}px`;
  label.style.top = `${frame.y + 8 + above + LABEL_GAP}px`;
  label.style.visibility = "visible";
}

/**
 * The frame and stage labels, for a viewer confined to a region, while the
 * guides show. The frame label is placed by the guide drawing, at the frame's
 * top edge, and stays hidden until it has been. The stage label sits in the
 * pane's bottom-left corner, or, `underFrame`, under the frame label, placed
 * by the same drawing. Neutral dark.
 */
function StageLabels({
  inRegion,
  guidesOn,
  frameLabelRef,
  stageLabelRef,
  underFrame,
}: {
  inRegion: boolean;
  guidesOn: boolean;
  frameLabelRef: RefObject<HTMLDivElement | null>;
  stageLabelRef: RefObject<HTMLDivElement | null>;
  underFrame: boolean;
}) {
  const { t } = useTranslation("editor");
  if (!inRegion || !guidesOn) return null;
  const chip = "pointer-events-none absolute z-[6] rounded-md bg-black/60 px-2 py-1 font-body text-[11px] leading-tight text-white/90";
  return (
    <>
      <div
        ref={frameLabelRef}
        data-testid="frame-label"
        style={{ visibility: "hidden" }}
        className={`${chip} -translate-x-1/2 max-w-[240px] text-center`}
      >
        {t("stage.frame_label")}
      </div>
      <div
        ref={stageLabelRef}
        data-testid="stage-label"
        style={underFrame ? { visibility: "hidden" } : undefined}
        className={underFrame ? `${chip} -translate-x-1/2 max-w-[260px] text-center` : `${chip} bottom-3 left-3 max-w-[260px]`}
      >
        {t("stage.stage_label")}
      </div>
    </>
  );
}

/** Stroke `path` white over a dark halo, so it reads on any image. */
function haloStroke(ctx: CanvasRenderingContext2D, path: Path2D, lw = 1.5) {
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = lw + 2;
  ctx.stroke(path);
  ctx.strokeStyle = "rgba(255,255,255,0.96)";
  ctx.lineWidth = lw;
  ctx.stroke(path);
}

/**
 * The centre target — a camera-style focus frame of four corner brackets
 * around the point a capture records, and a small dot on it.
 */
function drawCentreTarget(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  const s = 15; // half-size of the focus square
  const b = 7; // corner bracket arm length
  const target = new Path2D();
  // top-left
  target.moveTo(cx - s, cy - s + b);
  target.lineTo(cx - s, cy - s);
  target.lineTo(cx - s + b, cy - s);
  // top-right
  target.moveTo(cx + s - b, cy - s);
  target.lineTo(cx + s, cy - s);
  target.lineTo(cx + s, cy - s + b);
  // bottom-right
  target.moveTo(cx + s, cy + s - b);
  target.lineTo(cx + s, cy + s);
  target.lineTo(cx + s - b, cy + s);
  // bottom-left
  target.moveTo(cx - s + b, cy + s);
  target.lineTo(cx - s, cy + s);
  target.lineTo(cx - s, cy + s - b);
  haloStroke(ctx, target);

  const dot = new Path2D();
  dot.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 1.5;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fill(dot);
  ctx.stroke(dot);
}
