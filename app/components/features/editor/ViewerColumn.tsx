/**
 * ViewerColumn — IIIF viewer wrapper with overlays and capture button.
 *
 * Renders the IiifViewer and adds four overlays:
 *   - Object picker trigger (top-left): opens ObjectPickerDialog
 *   - Step indicator (top-right): "Step N of M" or "Title Card"
 *   - Coordinate display (bottom-left): live x, y, zoom in gold monospace
 *   - Capture position button (bottom-right): records viewport state to D1
 *
 * Also accepts a `children` slot for the layer panel overlay (Plan 04).
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Image, Camera, RotateCcw, ZoomIn, ZoomOut, Home } from "lucide-react";
import { IiifViewer } from "~/components/features/objects/IiifViewer";
import { ObjectPickerDialog } from "~/components/features/editor/ObjectPickerDialog";
import { captureViewportState, normalisedToViewport, viewportToNormalised } from "~/lib/viewer-utils";
import type { ReactNode } from "react";

interface StepData {
  id: number;
  step_number: number;
  object_id: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
  page: string | null;
  alt_text?: string | null;
}

interface ObjectInfo {
  object_id: string;
  title: string | null;
  thumbnail: string | null;
  image_available: boolean | null;
  alt_text?: string | null;
}

interface ViewerColumnProps {
  step: StepData | null;
  isStepZero: boolean;
  /** 1-indexed display number for the current step */
  stepDisplayNumber: number;
  totalSteps: number;
  objects: ObjectInfo[];
  manifestUrl: string | null;
  infoJsonUrl: string | null;
  isSelfHosted: boolean;
  siteBaseUrl: string | null;
  onCapturePosition: (position: { x: number; y: number; zoom: number; page: string }) => void;
  onChangeObject: (objectId: string) => void;
  /** Slot for layer panel overlay (Plan 04) */
  children?: ReactNode;
}

interface LiveCoords {
  x: number;
  y: number;
  zoom: number;
}

export function ViewerColumn({
  step,
  isStepZero,
  stepDisplayNumber,
  totalSteps,
  objects,
  manifestUrl,
  infoJsonUrl,
  isSelfHosted,
  siteBaseUrl,
  onCapturePosition,
  onChangeObject,
  children,
}: ViewerColumnProps) {
  const { t } = useTranslation("editor");

  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const currentPageRef = useRef<() => number>(() => 0);
  // Holds the position to restore when the viewer loads — updated whenever step changes
  const targetPositionRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const [liveCoords, setLiveCoords] = useState<LiveCoords | null>(null);
  const [captured, setCaptured] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const currentObjectId = step?.object_id ?? null;
  const currentObject = objects.find((o) => o.object_id === currentObjectId) ?? null;

  // Keep the restore-position ref in sync with the active step,
  // and navigate the viewer if it's already open
  useEffect(() => {
    if (step?.x != null && step?.y != null && step?.zoom != null) {
      targetPositionRef.current = { x: step.x, y: step.y, zoom: step.zoom };
      // If viewer is already open, navigate immediately
      const v = viewerRef.current;
      if (v && v.isOpen()) {
        const vp = v.viewport;
        const homeBounds = vp.getHomeBounds();
        const homeZoom = vp.getHomeZoom();
        const { point, actualZoom } = normalisedToViewport(
          homeBounds, homeZoom, step.x, step.y, step.zoom
        );
        vp.panTo(point as OpenSeadragon.Point, true);
        vp.zoomTo(actualZoom, null as unknown as OpenSeadragon.Point, true);
      }
    } else {
      targetPositionRef.current = null;
      // Reset to home position if no coordinates
      const v = viewerRef.current;
      if (v && v.isOpen()) {
        v.viewport.goHome(true);
      }
    }
  }, [step?.id, step?.x, step?.y, step?.zoom]);

  const handleViewerReady = useCallback(
    (viewer: OpenSeadragon.Viewer, getCurrentPage: () => number) => {
      viewerRef.current = viewer;
      currentPageRef.current = getCurrentPage;

      // Restore saved position once the image fully opens
      const pos = targetPositionRef.current;
      if (pos) {
        viewer.addOnceHandler("open", () => {
          const vp = viewer.viewport;
          const homeBounds = vp.getHomeBounds();
          const homeZoom = vp.getHomeZoom();
          const { point, actualZoom } = normalisedToViewport(
            homeBounds, homeZoom, pos.x, pos.y, pos.zoom
          );
          vp.panTo(point as OpenSeadragon.Point, true);
          vp.zoomTo(actualZoom, null as unknown as OpenSeadragon.Point, true);
        });
      }

      // Read initial coordinates (normalised)
      viewer.addOnceHandler("open", () => {
        const vp = viewer.viewport;
        const center = vp.getCenter();
        const homeBounds = vp.getHomeBounds();
        const homeZoom = vp.getHomeZoom();
        const norm = viewportToNormalised(homeBounds, homeZoom, center.x, center.y, vp.getZoom());
        setLiveCoords(norm);
      });
    },
    []
  );

  // Register animation handler for live coordinate tracking.
  // Re-registers whenever the viewer instance changes.
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;

    function handler() {
      if (!v) return;
      const vp = v.viewport;
      const center = vp.getCenter();
      const homeBounds = vp.getHomeBounds();
      const homeZoom = vp.getHomeZoom();
      const norm = viewportToNormalised(homeBounds, homeZoom, center.x, center.y, vp.getZoom());
      setLiveCoords(norm);
    }

    v.addHandler("animation", handler);
    // Also handle the end of animation (to catch the final position)
    v.addHandler("animation-finish", handler);

    return () => {
      v.removeHandler("animation", handler);
      v.removeHandler("animation-finish", handler);
    };
  // Re-register when viewer instance changes (new step with different object)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerRef.current]);

  function handleCapture() {
    const v = viewerRef.current;
    if (!v || !step) return;

    const vp = v.viewport;
    const center = vp.getCenter();
    const zoom = vp.getZoom();
    const pageIndex = currentPageRef.current();
    const homeBounds = vp.getHomeBounds();
    const homeZoom = vp.getHomeZoom();
    const pos = captureViewportState(center, zoom, pageIndex, homeBounds, homeZoom);

    onCapturePosition(pos);

    // Brief "Captured" feedback
    setCaptured(true);
    setTimeout(() => setCaptured(false), 1500);
  }

  function handleResetPosition() {
    const v = viewerRef.current;
    if (!v || !v.isOpen() || !step?.x || !step?.y || !step?.zoom) return;
    const vp = v.viewport;
    const homeBounds = vp.getHomeBounds();
    const homeZoom = vp.getHomeZoom();
    const { point, actualZoom } = normalisedToViewport(
      homeBounds, homeZoom, step.x, step.y, step.zoom
    );
    vp.panTo(point as OpenSeadragon.Point, false);
    vp.zoomTo(actualZoom, null as unknown as OpenSeadragon.Point, false);
  }

  function formatCoord(n: number) {
    return n.toFixed(3);
  }

  const stepIndicatorLabel = isStepZero
    ? t("viewer.title_card_indicator")
    : t("viewer.step_indicator", { current: stepDisplayNumber, total: totalSteps });

  const objectLabel = currentObject?.title ?? currentObject?.object_id ?? t("viewer.no_object");

  return (
    <div className="relative w-full h-full">
      {/* IiifViewer fills the column — zoom controls hidden (ViewerColumn owns the overlay area) */}
      <IiifViewer
        manifestUrl={manifestUrl}
        infoJsonUrl={infoJsonUrl}
        isSelfHosted={isSelfHosted}
        alt={step?.alt_text || currentObject?.alt_text || currentObject?.title || currentObject?.object_id || "IIIF viewer"}
        className="w-full h-full"
        onViewerReady={handleViewerReady}
        hideZoomControls
      />

      {/* Top bar — full-width dark bar with object info (left) and step indicator (right) */}
      <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between bg-black/60 rounded text-sm font-body">
        {isStepZero ? (
          <div className="flex items-start gap-1.5 text-cream/60 px-3 py-2 text-xs leading-snug cursor-default select-none">
            <Image className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{t("viewer.set_object_in_step1")}</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-1.5 text-cream px-3 py-2 hover:bg-white/10 rounded-l transition-colors min-w-0"
          >
            <Image className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{objectLabel}</span>
          </button>
        )}
        <div className="text-cream px-3 py-2 shrink-0">
          {stepIndicatorLabel}
        </div>
      </div>

      {/* Zoom controls — centred vertically on the left */}
      <div className="absolute left-3 top-1/2 -translate-y-1/2 z-10 flex flex-col gap-1">
        <button
          type="button"
          onClick={() => viewerRef.current?.viewport.zoomBy(1.5)}
          className="w-8 h-8 bg-black/60 hover:bg-black/80 rounded flex items-center justify-center text-cream/70 hover:text-cream transition-colors"
          aria-label="Zoom in"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => viewerRef.current?.viewport.zoomBy(0.67)}
          className="w-8 h-8 bg-black/60 hover:bg-black/80 rounded flex items-center justify-center text-cream/70 hover:text-cream transition-colors"
          aria-label="Zoom out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => viewerRef.current?.viewport.goHome()}
          className="w-8 h-8 bg-black/60 hover:bg-black/80 rounded flex items-center justify-center text-cream/70 hover:text-cream transition-colors"
          aria-label="Reset view"
        >
          <Home className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom bar — coordinates (left), capture button (centre), reset (right) */}
      {!isStepZero && (
        <div className="absolute bottom-3 left-3 right-3 z-10 flex items-center justify-between bg-black/60 rounded font-mono text-xs">
          {/* (a) Coordinates — left */}
          <div className="px-3 py-2 text-[#DAB95C] shrink-0">
            {liveCoords ? (
              <>
                <span>x {formatCoord(liveCoords.x)}</span>
                <span className="mx-0.5 opacity-50">·</span>
                <span>y {formatCoord(liveCoords.y)}</span>
                <span className="mx-0.5 opacity-50">·</span>
                <span>z {formatCoord(liveCoords.zoom)}</span>
              </>
            ) : (
              <span className="opacity-70">{t("viewer.no_position")}</span>
            )}
          </div>

          {/* (b) Capture button — absolute centre */}
          <button
            type="button"
            onClick={handleCapture}
            className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-4 py-2 bg-[#DAB95C] text-charcoal hover:bg-yellow-300 rounded-full font-heading font-semibold text-xs uppercase tracking-wider transition-colors"
          >
            <Camera className="w-3.5 h-3.5" />
            {captured ? t("viewer.captured") : t("viewer.capture_position")}
          </button>

          {/* (c) Reset to last captured position — right */}
          <button
            type="button"
            onClick={handleResetPosition}
            disabled={!step?.x || !step?.y || !step?.zoom}
            className="flex items-center gap-1.5 px-3 py-2 text-cream/60 hover:text-yellow-300 rounded transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default font-heading text-xs uppercase tracking-wider"
          >
            <RotateCcw className="w-3 h-3" />
            {t("viewer.reset_position")}
          </button>
        </div>
      )}

      {/* Step 0 — just coordinates, no capture/reset */}
      {isStepZero && (
        <div className="absolute bottom-3 left-3 right-3 z-10 bg-black/60 rounded px-3 py-2 font-mono text-xs text-[#DAB95C]">
          {liveCoords ? (
            <>
              <span>x {formatCoord(liveCoords.x)}</span>
              <span className="mx-0.5 opacity-50">·</span>
              <span>y {formatCoord(liveCoords.y)}</span>
              <span className="mx-0.5 opacity-50">·</span>
              <span>z {formatCoord(liveCoords.zoom)}</span>
            </>
          ) : (
            <span className="opacity-70">{t("viewer.no_position")}</span>
          )}
        </div>
      )}

      {/* Layer panel slot (Plan 04) */}
      {children}

      {/* Object picker dialog */}
      <ObjectPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(objectId) => {
          onChangeObject(objectId);
          setPickerOpen(false);
        }}
        objects={objects}
        currentObjectId={currentObjectId}
        siteBaseUrl={siteBaseUrl}
      />
    </div>
  );
}
