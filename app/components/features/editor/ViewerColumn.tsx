/**
 * This file renders the type-aware viewer column of the Story
 * Editor — the right-hand pane that shows the IIIF / video / audio
 * media tied to the active step, with capture-position controls so
 * the author can pin the current viewport into the step.
 *
 * Branches on media type to render either:
 *   - `IiifViewer` (for iiif and text-only objects)
 *   - `VideoEmbed` (for youtube, vimeo, google-drive objects)
 *   - `AudioPlayer` (for audio objects — WaveSurfer v7 waveform)
 *
 * Overlays adapt to media type:
 *   - IIIF: x/y/zoom coordinate display + Capture Position button
 *   - Video/audio: clip start/end display in MM:SS + Capture
 *     Start/End buttons + Loop toggle
 *
 * Also accepts a `children` slot for the layer panel overlay.
 *
 * @version v1.3.6-beta
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Image, Camera, RotateCcw, ZoomIn, ZoomOut, Home, Clock, Play, Check, Undo2 } from "lucide-react";
import { IiifViewer } from "~/components/features/objects/IiifViewer";
import { VideoEmbed } from "~/components/features/editor/VideoEmbed";
import { AudioPlayer } from "~/components/features/editor/AudioPlayer";
import { ClipTimeline } from "~/components/features/editor/ClipTimeline";
import { ObjectPickerDialog } from "~/components/features/editor/ObjectPickerDialog";
import { DocsLink } from "~/components/ui/DocsLink";
import { captureViewportState, normalisedToViewport, viewportToNormalised } from "~/lib/viewer-utils";
import { detectMediaType, extractVideoId, extractVimeoHash, secondsToMmss } from "~/lib/media-type";
import type { VideoPlayerControls } from "~/components/features/editor/VideoEmbed";
import { Switch } from "~/components/ui/Switch";
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
  clip_start?: string | null;
  clip_end?: string | null;
  loop?: string | null;
}

interface ObjectInfo {
  object_id: string;
  title: string | null;
  thumbnail: string | null;
  image_available: boolean | null;
  alt_text?: string | null;
  source_url?: string | null;
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
  onCaptureClip?: (field: "clip_start" | "clip_end", value: string) => void;
  onToggleLoop?: (value: string) => void;
  /** GitHub repo full name (e.g. "owner/repo") for constructing raw audio URLs */
  repoFullName?: string;
  /**
   * Capture-position Undo signal. `null` hides the toast; a number is a
   * per-capture nonce — the route bumps it on every capture (and nulls it on
   * step switch), so a repeated capture re-shows the pill and resets its 5s
   * timer.
   */
  captureUndoNonce?: number | null;
  /** Revert the just-captured step to its pre-capture baseline. */
  onUndoCapture?: () => void;
  /** Slot for layer panel overlay */
  children?: ReactNode;
  /** Callback to open the in-product docs drawer — threaded from the _app shell via outlet context. */
  onOpenDoc?: (id: string) => void;
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
  onCaptureClip,
  onToggleLoop,
  repoFullName,
  captureUndoNonce = null,
  onUndoCapture,
  children,
  onOpenDoc,
}: ViewerColumnProps) {
  const { t } = useTranslation("editor");

  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const currentPageRef = useRef<() => number>(() => 0);
  // Holds the position to restore when the viewer loads — updated whenever step changes
  const targetPositionRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const [liveCoords, setLiveCoords] = useState<LiveCoords | null>(null);
  const [captured, setCaptured] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Hold the "Captured" flash timer in a ref so a rapid re-capture
  // (replace-on-recapture) clears the prior timer before starting a new one —
  // otherwise overlapping 1500ms timers leak and an older timer fires
  // setCaptured(false) mid-flash of the newer capture. Cleared on unmount.
  const capturedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (capturedTimerRef.current) clearTimeout(capturedTimerRef.current);
    };
  }, []);

  // The capture-position Undo pill. The route drives visibility via
  // `captureUndoNonce` (bumped per capture, nulled on step switch). We show the
  // pill while a nonce is present and auto-dismiss it after 5s; a repeated
  // capture bumps the nonce, which restarts the timer (replace-on-recapture).
  const [captureToastShown, setCaptureToastShown] = useState(false);
  useEffect(() => {
    if (captureUndoNonce === null) {
      setCaptureToastShown(false);
      return;
    }
    setCaptureToastShown(true);
    const timer = setTimeout(() => setCaptureToastShown(false), 5000);
    return () => clearTimeout(timer);
  }, [captureUndoNonce]);

  // Ref for reading current time from embedded video player
  const getCurrentTimeRef = useRef<(() => Promise<number>) | null>(null);

  // Video player controls for preview clip
  const playerControlsRef = useRef<VideoPlayerControls | null>(null);

  // Video timeline state — poll current time from iframe player
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const videoDurationRef = useRef<(() => Promise<number>) | null>(null);

  const currentObjectId = step?.object_id ?? null;
  const currentObject = objects.find((o) => o.object_id === currentObjectId) ?? null;

  // Determine media type for the current object
  const mediaType = detectMediaType(currentObject?.source_url, currentObject?.object_id);
  const isMedia =
    mediaType === "youtube" ||
    mediaType === "vimeo" ||
    mediaType === "google-drive" ||
    mediaType === "audio";

  // Extract video ID for embedded players
  const videoId =
    (mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive") &&
    currentObject?.source_url
      ? extractVideoId(mediaType, currentObject.source_url)
      : null;

  // Poll for video duration once player is ready
  useEffect(() => {
    if (!videoId) { setVideoDuration(0); return; }
    const poll = setInterval(async () => {
      const getDur = videoDurationRef.current;
      if (getDur) {
        try {
          const dur = await getDur();
          if (dur > 0) { setVideoDuration(dur); clearInterval(poll); }
        } catch { /* not ready yet */ }
      }
    }, 500);
    return () => clearInterval(poll);
  }, [videoId]);

  // Reset video time when step changes
  useEffect(() => {
    setVideoCurrentTime(0);
    setVideoDuration(0);
  }, [step?.id]);

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

  // Track the viewer instance + animation handler currently registered so a new
  // viewer (new object) detaches the prior registration, and so the unmount
  // cleanup can detach the live one. Registration happens inside
  // handleViewerReady (below) where the viewer is known — NOT in an effect
  // keyed on viewerRef.current, which never re-runs because mutating a ref does
  // not trigger a render and React captures the dep value at render time.
  const animHandlerRef = useRef<{
    viewer: OpenSeadragon.Viewer;
    handler: () => void;
  } | null>(null);

  const detachAnimationHandler = useCallback(() => {
    const prev = animHandlerRef.current;
    if (prev) {
      prev.viewer.removeHandler("animation", prev.handler);
      prev.viewer.removeHandler("animation-finish", prev.handler);
      animHandlerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Detach on unmount.
    return () => detachAnimationHandler();
  }, [detachAnimationHandler]);

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

      // Register live-coordinate tracking handlers on THIS viewer. Detach any
      // handlers from a previous viewer first so we never leak across object
      // swaps. Previously this lived in a useEffect keyed on viewerRef.current,
      // which never re-ran when the ref was assigned — so the handlers were
      // never registered and the bottom-bar coordinates stopped updating on
      // pan/zoom (working only by render-timing coincidence).
      detachAnimationHandler();
      const handler = () => {
        const vp = viewer.viewport;
        const center = vp.getCenter();
        const homeBounds = vp.getHomeBounds();
        const homeZoom = vp.getHomeZoom();
        const norm = viewportToNormalised(homeBounds, homeZoom, center.x, center.y, vp.getZoom());
        setLiveCoords(norm);
      };
      viewer.addHandler("animation", handler);
      viewer.addHandler("animation-finish", handler);
      animHandlerRef.current = { viewer, handler };
    },
    [detachAnimationHandler]
  );

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

    // Brief "Captured" feedback. Clear any prior flash timer first so a rapid
    // re-capture doesn't leak overlapping timers (the older one would fire
    // setCaptured(false) mid-flash of this newer capture).
    if (capturedTimerRef.current) clearTimeout(capturedTimerRef.current);
    setCaptured(true);
    capturedTimerRef.current = setTimeout(() => setCaptured(false), 1500);
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

  async function handleCaptureClipField(field: "clip_start" | "clip_end") {
    const getTime = getCurrentTimeRef.current;
    if (getTime) {
      try {
        const seconds = await getTime();
        onCaptureClip?.(field, String(seconds));
      } catch {
        // If API fails, user sees no response — the manual fallback path applies
        // handled by the inline input rendered when getCurrentTimeRef.current is null
      }
    }
  }

  // Preview clip: seek to clip_start, play, stop at clip_end
  const clipPreviewTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  function handlePreviewClip() {
    const controls = playerControlsRef.current;
    const getTime = getCurrentTimeRef.current;
    if (!controls || !getTime || clipStartSeconds == null) return;

    // Clear any existing preview timer
    if (clipPreviewTimerRef.current) {
      clearInterval(clipPreviewTimerRef.current);
      clipPreviewTimerRef.current = null;
    }

    controls.seekTo(clipStartSeconds);
    controls.play();

    // Poll to stop at clip_end
    if (clipEndSeconds != null) {
      clipPreviewTimerRef.current = setInterval(async () => {
        try {
          const t = await getTime();
          if (t >= clipEndSeconds!) {
            controls.pause();
            if (clipPreviewTimerRef.current) {
              clearInterval(clipPreviewTimerRef.current);
              clipPreviewTimerRef.current = null;
            }
          }
        } catch { /* player not ready */ }
      }, 200);
    }
  }

  function formatCoord(n: number) {
    return n.toFixed(3);
  }

  const stepIndicatorLabel = isStepZero
    ? t("viewer.title_card_indicator")
    : t("viewer.step_indicator", { current: stepDisplayNumber, total: totalSteps });

  const objectLabel = currentObject?.title ?? currentObject?.object_id ?? t("viewer.no_object");

  // Clip values for display
  const clipStartSeconds = step?.clip_start ? parseFloat(step.clip_start) : null;
  const clipEndSeconds = step?.clip_end ? parseFloat(step.clip_end) : null;
  const loopEnabled = step?.loop === "true";

  // Picker objects: strip source_url for the ObjectPickerDialog (it doesn't need it)
  const pickerObjects = objects.map((o) => ({
    object_id: o.object_id,
    title: o.title,
    thumbnail: o.thumbnail,
    image_available: o.image_available,
    alt_text: o.alt_text,
  }));

  return (
    <div className="relative w-full h-full">
      {/* Main viewer area — branches on media type */}
      {(mediaType === "iiif" || mediaType === "text-only") && (
        <IiifViewer
          manifestUrl={manifestUrl}
          infoJsonUrl={infoJsonUrl}
          isSelfHosted={isSelfHosted}
          alt={step?.alt_text || currentObject?.alt_text || currentObject?.title || currentObject?.object_id || "IIIF viewer"}
          className="w-full h-full"
          onViewerReady={handleViewerReady}
          hideZoomControls
        />
      )}

      {(mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive") && videoId && (
        <div className="w-full h-full flex flex-col bg-black">
          <div className="flex-1 flex items-center justify-center">
            <div className="w-full">
              <VideoEmbed
                type={mediaType}
                videoId={videoId}
                vimeoHash={mediaType === "vimeo" && currentObject?.source_url ? extractVimeoHash(currentObject.source_url) : undefined}
                getCurrentTimeRef={getCurrentTimeRef}
                getDurationRef={videoDurationRef}
                playerControlsRef={playerControlsRef}
                onTimeUpdate={setVideoCurrentTime}
              />
            </div>
          </div>
        </div>
      )}

      {mediaType === "audio" && currentObject?.source_url && siteBaseUrl && (
        <div className="w-full h-full flex items-center justify-center p-6">
          <div className="w-full max-w-2xl">
            <AudioPlayer
              key={`${currentObject.object_id}-step-${step?.id}`}
              audioUrl={`${siteBaseUrl}/telar-content/objects/${currentObject.source_url}`}
              getCurrentTimeRef={getCurrentTimeRef}
              clipStart={step?.clip_start ? parseFloat(step.clip_start) : undefined}
              clipEnd={step?.clip_end ? parseFloat(step.clip_end) : undefined}
              onClipChange={(start, end) => {
                onCaptureClip?.("clip_start", String(start));
                onCaptureClip?.("clip_end", String(end));
              }}
            />
          </div>
        </div>
      )}

      {mediaType === "audio" && (!currentObject?.source_url || !siteBaseUrl) && (
        <div className="w-full h-full flex items-center justify-center">
          <p className="font-body text-sm text-gray-400">
            {t("media.media_preview_unavailable")}
          </p>
        </div>
      )}

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

      {/* Zoom controls — only for IIIF, centred vertically on the left */}
      {(mediaType === "iiif" || mediaType === "text-only") && (
        <div className="absolute left-3 top-1/2 -translate-y-1/2 z-10 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => viewerRef.current?.viewport.zoomBy(1.5)}
            className="w-8 h-8 bg-black/60 hover:bg-black/80 rounded flex items-center justify-center text-cream/70 hover:text-cream transition-colors"
            aria-label={t("viewer.zoom_in_aria")}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => viewerRef.current?.viewport.zoomBy(0.67)}
            className="w-8 h-8 bg-black/60 hover:bg-black/80 rounded flex items-center justify-center text-cream/70 hover:text-cream transition-colors"
            aria-label={t("viewer.zoom_out_aria")}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => viewerRef.current?.viewport.goHome()}
            className="w-8 h-8 bg-black/60 hover:bg-black/80 rounded flex items-center justify-center text-cream/70 hover:text-cream transition-colors"
            aria-label={t("viewer.reset_aria")}
          >
            <Home className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Bottom bar — IIIF: coordinates + capture; Video/audio: clip info + capture start/end + loop */}
      {!isStepZero && (mediaType === "iiif" || mediaType === "text-only") && (
        <div className="absolute bottom-3 left-3 right-3 z-10 flex items-center justify-between bg-black/60 rounded font-mono text-xs">
          {/* (a) Coordinates — left */}
          <div className="px-3 py-2 text-qolle-pale shrink-0">
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
            className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-4 py-2 bg-qolle text-charcoal hover:bg-qolle-deep rounded-full font-heading font-semibold text-xs uppercase tracking-wider transition-colors"
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

      {/* Step 0 — IIIF: just coordinates, no capture/reset */}
      {isStepZero && (mediaType === "iiif" || mediaType === "text-only") && (
        <div className="absolute bottom-3 left-3 right-3 z-10 bg-black/60 rounded px-3 py-2 font-mono text-xs text-qolle-pale">
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

      {/* Video/audio bottom bar: clip timeline + loop toggle */}
      {!isStepZero && isMedia && (
        <div className="absolute bottom-3 left-3 right-3 z-10 bg-black/60 rounded p-2">
          {/* Clip timeline (video only — audio has it in the waveform) */}
          {mediaType !== "audio" && videoDuration > 0 && (
            <div className="mb-2">
              <ClipTimeline
                key={`clip-${step?.id}`}
                duration={videoDuration}
                currentTime={videoCurrentTime}
                clipStart={step?.clip_start ? parseFloat(step.clip_start) : 0}
                clipEnd={step?.clip_end ? parseFloat(step.clip_end) : videoDuration}
                onClipChange={(s, e) => {
                  onCaptureClip?.("clip_start", String(s));
                  onCaptureClip?.("clip_end", String(e));
                }}
              />
            </div>
          )}
          {/* Clip info + preview + loop toggle row */}
          <div className="flex items-center font-mono text-xs">
            {/* Left — preview clip button */}
            <div className="w-1/3">
              {(clipStartSeconds !== null || clipEndSeconds !== null) && (
                <button
                  type="button"
                  onClick={handlePreviewClip}
                  className="flex items-center gap-1 px-2 py-1 bg-anil hover:bg-anil/80 text-charcoal rounded text-[10px] font-heading uppercase tracking-wider transition-colors"
                >
                  <Play className="w-3 h-3" />
                  {t("preview_clip")}
                </button>
              )}
            </div>
            {/* Centre — clip times */}
            <div className="w-1/3 text-center text-qolle-pale shrink-0">
              {clipStartSeconds !== null || clipEndSeconds !== null ? (
                <>
                  <span>clip {secondsToMmss(clipStartSeconds ?? 0)}</span>
                  <span className="mx-1 opacity-50">→</span>
                  <span>{secondsToMmss(clipEndSeconds ?? 0)}</span>
                </>
              ) : mediaType === "google-drive" ? (
                <span className="opacity-70">{t("media.google_drive_no_clip")}</span>
              ) : (
                <span className="opacity-70">{t("media.no_clip_set")}</span>
              )}
            </div>
            {/* Right — loop toggle + docs link */}
            <div className="w-1/3 flex items-center justify-end gap-1.5">
              {onOpenDoc && (
                <DocsLink
                  docId="video"
                  onOpenDoc={onOpenDoc}
                  className="!text-cream/60 hover:!text-cream"
                />
              )}
              <span className="font-heading text-xs text-cream/70 uppercase tracking-wider">
                {t("media.loop")}
              </span>
              <Switch
                checked={loopEnabled}
                onChange={(checked) => onToggleLoop?.(checked ? "true" : "")}
                label={t("media.loop")}
              />
            </div>
          </div>
        </div>
      )}

      {/* Capture-position Undo pill — charcoal pill above the viewer, below the
          top object/step bar, above the layer panel (z-30). 5s auto-dismiss;
          Undo reverts the just-captured step in one transaction. */}
      {captureToastShown && (
        <div
          role="status"
          className="absolute top-16 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-charcoal text-cream rounded-full px-4 py-2 font-heading text-xs shadow-lg"
        >
          <Check className="w-3.5 h-3.5 shrink-0" />
          <span>{t("capture_toast.captured")}</span>
          <span className="text-cream/40" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            onClick={() => {
              onUndoCapture?.();
              setCaptureToastShown(false);
            }}
            className="flex items-center gap-1 font-semibold hover:text-cream/80 transition-colors"
          >
            <Undo2 className="w-3.5 h-3.5 shrink-0" />
            {t("capture_toast.undo")}
          </button>
        </div>
      )}

      {/* Layer panel slot */}
      {children}

      {/* Object picker dialog */}
      <ObjectPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(objectId) => {
          onChangeObject(objectId);
          setPickerOpen(false);
        }}
        objects={pickerObjects}
        currentObjectId={currentObjectId}
        siteBaseUrl={siteBaseUrl}
      />
    </div>
  );
}
