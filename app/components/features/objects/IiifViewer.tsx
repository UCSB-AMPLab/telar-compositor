/**
 * IiifViewer — OpenSeadragon-based IIIF image viewer with page navigation.
 *
 * Renders an OpenSeadragon viewer from a manifest URL or info.json URL.
 * For multi-page manifests (e.g. PDFs), shows page indicators and prev/next.
 * For self-hosted objects, probes info.json first and shows a fallback
 * message if tiles are not yet available (build in progress).
 *
 * Client-only — guarded with typeof window check to avoid SSR crashes.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ImageOff,
  RefreshCw,
  ZoomIn,
  ZoomOut,
  Maximize,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

interface PageInfo {
  /** info.json or direct image URL for this page */
  tileSource: string;
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
   * Called once the OpenSeadragon viewer instance is ready.
   * Receives the viewer and a getter for the current 0-based page index.
   */
  onViewerReady?: (viewer: OpenSeadragon.Viewer, getCurrentPage: () => number) => void;
  /** Hide the built-in zoom/fit controls (e.g. when the parent provides its own overlays) */
  hideZoomControls?: boolean;
  /** Called when the user clicks "Generate tiles" — parent dispatches the workflow */
  onGenerateTiles?: () => void;
  /** Whether tile generation is in progress */
  isGenerating?: boolean;
}

export function IiifViewer({
  manifestUrl,
  infoJsonUrl,
  isSelfHosted,
  alt,
  className = "",
  onViewerReady,
  hideZoomControls = false,
  onGenerateTiles,
  isGenerating = false,
}: IiifViewerProps) {
  const { t } = useTranslation("objects");
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const [tilesAvailable, setTilesAvailable] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [currentPage, setCurrentPage] = useState(0);

  // Check tile availability for self-hosted objects
  const checkTiles = useCallback(async () => {
    if (!isSelfHosted || !infoJsonUrl) {
      setTilesAvailable(true);
      return;
    }
    setChecking(true);
    try {
      const res = await fetch(infoJsonUrl, { method: "HEAD", mode: "cors" });
      setTilesAvailable(res.ok);
    } catch {
      setTilesAvailable(false);
    } finally {
      setChecking(false);
    }
  }, [isSelfHosted, infoJsonUrl]);

  useEffect(() => {
    checkTiles();
  }, [checkTiles]);

  // Parse manifest to extract page tile sources
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!tilesAvailable) return;

    if (!manifestUrl) {
      // No manifest — fall back to info.json as single page
      if (infoJsonUrl) {
        setPages([{ tileSource: infoJsonUrl }]);
      }
      return;
    }

    let cancelled = false;

    async function parseManifest() {
      try {
        const res = await fetch(manifestUrl!);
        if (!res.ok || cancelled) return;
        const manifest = await res.json() as Record<string, unknown>;
        const extracted = extractAllPages(manifest);
        if (!cancelled) {
          if (extracted.length > 0) {
            setPages(extracted);
          } else if (infoJsonUrl) {
            // Manifest parsed but no pages extracted — fall back to info.json
            setPages([{ tileSource: infoJsonUrl }]);
          }
        }
      } catch {
        // Manifest fetch failed — fall back to info.json if available
        if (!cancelled && infoJsonUrl) {
          setPages([{ tileSource: infoJsonUrl }]);
        }
      }
    }

    parseManifest();
    return () => { cancelled = true; };
  }, [tilesAvailable, manifestUrl, infoJsonUrl]);

  // Initialise/update OpenSeadragon when pages or currentPage change
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pages.length === 0 || !containerRef.current) return;

    let destroyed = false;

    async function init() {
      const OpenSeadragon = (await import("openseadragon")).default;
      if (destroyed || !containerRef.current) return;

      // Destroy previous instance
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }

      viewerRef.current = OpenSeadragon({
        element: containerRef.current,
        tileSources: pages[currentPage].tileSource,
        showNavigationControl: false,
        gestureSettingsMouse: { scrollToZoom: true },
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
      });

      if (onViewerReady) {
        onViewerReady(viewerRef.current, () => currentPage);
      }
    }

    init();

    return () => {
      destroyed = true;
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
    };
  }, [pages, currentPage]);

  function goToPage(page: number) {
    if (page >= 0 && page < pages.length) {
      setCurrentPage(page);
    }
  }

  // No manifest URL at all
  if (!manifestUrl && !infoJsonUrl) {
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
  if (isSelfHosted && tilesAvailable !== true) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gray-100 rounded-lg ${className}`}
      >
        {checking ? (
          <>
            <div className="w-6 h-6 border-2 border-anil border-t-transparent rounded-full animate-spin mb-3" />
            <p className="font-body text-sm text-gray-400">
              {t("viewer_checking_tiles")}
            </p>
          </>
        ) : (
          <>
            <ImageOff className="w-12 h-12 text-gray-300 mb-3" />
            <p className="font-body text-sm text-gray-500 text-center max-w-xs mb-3">
              {t("viewer_tiles_unavailable")}
            </p>
            <div className="flex items-center gap-2">
              {onGenerateTiles && (
                <button
                  type="button"
                  onClick={onGenerateTiles}
                  disabled={isGenerating}
                  className="inline-flex items-center gap-2 font-heading font-semibold text-xs uppercase tracking-wider text-white bg-terracotta hover:bg-terracotta/90 rounded-full px-4 py-1.5 transition-colors disabled:opacity-50"
                >
                  {isGenerating ? (
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  {isGenerating ? t("viewer_generating") : t("viewer_generate_tiles")}
                </button>
              )}
              <button
                type="button"
                onClick={checkTiles}
                className="inline-flex items-center gap-2 font-heading font-semibold text-xs uppercase tracking-wider text-charcoal border border-gray-300 rounded-full px-4 py-1.5 hover:bg-gray-50 transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                {t("viewer_retry")}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const isMultiPage = pages.length > 1;

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

      {/* Zoom controls — top left (hidden when parent provides its own overlays) */}
      {!hideZoomControls && <div className="absolute top-3 left-3 flex flex-col gap-1.5 z-10">
        <button
          type="button"
          onClick={() => viewerRef.current?.viewport.zoomBy(1.5)}
          className="w-8 h-8 bg-white/90 hover:bg-white rounded-lg shadow flex items-center justify-center text-charcoal transition-colors"
          aria-label={t("viewer_zoom_in_aria")}
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => viewerRef.current?.viewport.zoomBy(0.67)}
          className="w-8 h-8 bg-white/90 hover:bg-white rounded-lg shadow flex items-center justify-center text-charcoal transition-colors"
          aria-label={t("viewer_zoom_out_aria")}
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => viewerRef.current?.viewport.goHome()}
          className="w-8 h-8 bg-white/90 hover:bg-white rounded-lg shadow flex items-center justify-center text-charcoal transition-colors"
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
            {currentPage + 1}/{pages.length}
          </span>
          <button
            type="button"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage === pages.length - 1}
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

// ---------------------------------------------------------------------------
// Extract all page tile sources from a IIIF manifest
// ---------------------------------------------------------------------------

function extractAllPages(manifest: Record<string, unknown>): PageInfo[] {
  // Try IIIF Presentation v3
  const v3Pages = extractV3Pages(manifest);
  if (v3Pages.length > 0) return v3Pages;

  // Try IIIF Presentation v2
  const v2Pages = extractV2Pages(manifest);
  if (v2Pages.length > 0) return v2Pages;

  return [];
}

function extractV3Pages(manifest: Record<string, unknown>): PageInfo[] {
  const pages: PageInfo[] = [];
  try {
    const items = manifest.items as Array<Record<string, unknown>> | undefined;
    if (!items) return pages;

    for (const canvas of items) {
      const annoPages = canvas.items as Array<Record<string, unknown>> | undefined;
      if (!annoPages?.[0]) continue;
      const annos = annoPages[0].items as Array<Record<string, unknown>> | undefined;
      if (!annos?.[0]) continue;
      const body = annos[0].body as Record<string, unknown> | undefined;
      if (!body) continue;

      // Option 1: body has a service array with an Image API endpoint
      const service = body.service as Array<Record<string, string>> | undefined;
      if (service?.[0]?.id) {
        pages.push({ tileSource: service[0].id + "/info.json" });
        continue;
      }

      // Option 2: body.id is an Image API URL — derive info.json from it
      if (body.id && typeof body.id === "string" && body.type === "Image") {
        const infoUrl = deriveInfoJsonFromImageUrl(body.id as string);
        if (infoUrl) {
          pages.push({ tileSource: infoUrl });
          continue;
        }
        // Last resort: use the image URL directly
        pages.push({ tileSource: body.id as string });
      }
    }
  } catch { /* fall through */ }
  return pages;
}

function extractV2Pages(manifest: Record<string, unknown>): PageInfo[] {
  const pages: PageInfo[] = [];
  try {
    const sequences = manifest.sequences as Array<Record<string, unknown>> | undefined;
    if (!sequences?.[0]) return pages;
    const canvases = sequences[0].canvases as Array<Record<string, unknown>> | undefined;
    if (!canvases) return pages;

    for (const canvas of canvases) {
      const images = canvas.images as Array<Record<string, unknown>> | undefined;
      if (!images?.[0]) continue;
      const resource = images[0].resource as Record<string, unknown> | undefined;
      if (!resource) continue;

      const service = resource.service as Record<string, string> | undefined;
      if (service?.["@id"]) {
        pages.push({ tileSource: service["@id"] + "/info.json" });
        continue;
      }

      // Fallback: resource @id
      if (resource["@id"] && typeof resource["@id"] === "string") {
        pages.push({ tileSource: resource["@id"] as string });
      }
    }
  } catch { /* fall through */ }
  return pages;
}

/**
 * Derives an info.json URL from an IIIF Image API URL.
 * E.g. ".../iiif/3/{id}/full/max/0/default.jpg" → ".../iiif/3/{id}/info.json"
 */
function deriveInfoJsonFromImageUrl(url: string): string | null {
  // Match IIIF Image API URL pattern: {base}/{region}/{size}/{rotation}/{quality}.{format}
  const match = url.match(/^(.+\/iiif\/\d+\/[^/]+)\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/);
  if (match) {
    return match[1] + "/info.json";
  }
  return null;
}
