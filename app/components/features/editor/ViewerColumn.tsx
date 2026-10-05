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
 * The controls over the media (`StageRegionControls`) adapt to its type:
 *   - IIIF: x/y/zoom coordinate display + Capture Position button
 *   - Video/audio: clip start/end display in MM:SS + Capture
 *     Start/End buttons + Loop toggle
 *
 * Inside the framing stage (`stage`) the column is the stage: the controls
 * sit on the region the published page frames into, the capture viewer is
 * confined to that region, a video or audio player is placed where the page
 * places it, and the caller's visitor layer is drawn between the media and
 * the controls.
 *
 * For a multi-page object the column owns which page the step shows. The
 * viewer destroys and rebuilds OpenSeadragon on every page and source change,
 * so nothing the column asks for can be asserted against "the viewer": a page
 * change, an object change or a step switch creates a pending framing request
 * naming the selection, the source and the page it belongs to, and that request
 * is applied only on the instance whose construction metadata matches it, once
 * that instance has opened. The record of that instance is dropped the moment
 * the viewer reports it destroyed, so nothing is applied to, or consumed by, a
 * viewer that has gone while its replacement is still being built. Capture is
 * gated on the same match, read live at the press rather than from the render,
 * so an author can never pin the viewport of one page onto another page's step;
 * and it hands the write the identity of what it read from, so the write can
 * refuse a step whose object a peer has replaced in the meantime.
 *
 * The column also owns the dialog chain — keep-or-choose, object picker, page
 * chooser — because only it knows when a chain has ended and which persistent
 * control focus should land on. The chain's own rules live in
 * `use-viewer-dialog-chain`, the readings that decide whether the instance in
 * front of the author is the step's in `viewer-column-state`, and the IIIF bar
 * with its page cluster in `ViewerBottomBar`; what stays here is the media
 * branching, the instance the column holds, and the framing it asks for.
 *
 * @version v1.5.0-beta
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { StageWrite } from "~/hooks/use-stage-write-failure";
import { StageWriteFailureNotice } from "~/components/features/editor/StageWriteFailureNotice";
import { IiifViewer } from "~/components/features/objects/IiifViewer";
import type { SourceState } from "~/components/features/objects/IiifViewer";
import type { ViewerInstanceMeta } from "~/components/features/objects/IiifViewer";
import { PageChooserDialog } from "~/components/features/editor/PageChooserDialog";
import type { PageChooserSession } from "~/components/features/editor/PageChooserDialog";
import { NewStepDialog } from "~/components/features/editor/NewStepDialog";
import type { LiveCoords } from "~/components/features/editor/ViewerBottomBar";
import { StageRegionControls, type StageChrome } from "~/components/features/editor/StageRegionControls";
import { STAGE_Z, stageBox, useStageRegionOf } from "~/components/features/editor/FramingStage";
import type { Box, MediaBelow } from "~/lib/framing-stage";
import { StageAudio, StageVideo, stageMediaBoxes } from "~/components/features/editor/StageMedia";
import type { StageGeometry } from "~/hooks/use-stage-geometry";
import { useViewerDialogChain } from "~/components/features/editor/use-viewer-dialog-chain";
import {
  captureBindingOf, captureIsReady, framingMatches, readyPages, savedFramingOf,
  savedPageOf, triggerInputs, triggerVerdict,
} from "~/components/features/editor/viewer-column-state";
import type {
  InstanceRecord, SavedFraming, TriggerInputs,
} from "~/components/features/editor/viewer-column-state";
import { sourceKeyFor } from "~/lib/iiif-pages";
import { targetKeyFor } from "~/lib/step-writes";
import type { WriteBinding } from "~/lib/step-writes";
import type { VideoAspect } from "~/lib/video-aspect";
import { VideoEmbed } from "~/components/features/editor/VideoEmbed";
import { AudioPlayer } from "~/components/features/editor/AudioPlayer";
import { ObjectPickerDialog } from "~/components/features/editor/ObjectPickerDialog";
import {
  captureFocal,
  captureViewportState,
  clampCaptureZoom,
  publishedFraming,
  normalisedToViewport,
  viewportToNormalised,
  visitorViewCentre,
  CAPTURE_MAX_ZOOM_LEVEL,
  CAPTURE_MIN_ZOOM_RATIO,
} from "~/lib/viewer-utils";
import type { ImageItem } from "~/lib/viewer-utils";
import { settleCentre } from "~/lib/authoring-frame";
import type { MeasuredViewer } from "~/lib/authoring-frame";
import { detectMediaType, extractVideoId, extractVimeoHash } from "~/lib/media-type";
import { resolveStepObject } from "~/lib/object-id";
import type { VideoPlayerControls } from "~/components/features/editor/VideoEmbed";
import type { ReactNode } from "react";

interface StepData {
  id: number;
  /** Stable id for a step the Y.Doc created and D1 has not yet backfilled. */
  _tempId?: string | null;
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

/**
 * A pending framing request: what the column wants applied, and to which
 * instance. `page` is the page the request asked for, kept as asked; the count
 * that resolves it belongs to the source state at the moment of application,
 * not to the moment of the request. It is applied only on the instance the
 * request resolves to, and only once that instance has opened.
 */
interface FramingRequest {
  selectionKey: string;
  sourceKey: string;
  page: number;
  framing: { x: number; y: number; zoom: number } | "home";
}

interface ViewerColumnProps {
  step: StepData | null;
  isStepZero: boolean;
  /**
   * The identity of what the column is showing: `step0`, `tmp:<tempId>`,
   * `id:<id>` or `none`. Everything the column remembers about browsing and
   * framing is scoped to it, and the temp id comes first so the D1 id backfill
   * that follows a snapshot is not mistaken for a selection change.
   */
  selectionKey: string;
  /** 1-indexed display number for the current step */
  stepDisplayNumber: number;
  totalSteps: number;
  objects: ObjectInfo[];
  manifestUrl: string | null;
  infoJsonUrl: string | null;
  isSelfHosted: boolean;
  siteBaseUrl: string | null;
  /** The site's `telar_version`, which decides how a step's `object` names an object. */
  frameworkVersion?: string | null;
  /**
   * The captured viewport, with the identity of what the viewer was showing
   * when it was read: the write lands only where all of it still holds.
   */
  onCapturePosition: (
    position: { x: number; y: number; zoom: number; page: string },
    binding: WriteBinding
  ) => void;
  /** `targetKey` binds the write to one step; without it the active step is the target. */
  onChangeObject: (objectId: string, targetKey?: string) => void;
  /** Write a chosen 1-based page to the step the session names. */
  onChoosePage?: (page: number, session: PageChooserSession) => void;
  /** A seeded new step awaiting its keep-or-choose dialog. */
  pendingNewStep?: { tempId: string } | null;
  /** Acknowledge the request above; the route clears it only for a matching id. */
  onNewStepConsumed?: (tempId: string) => void;
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
  /** The writes the author made on this step that came back failed; the column says so. */
  writeFailures?: StageWrite[];
  /**
   * The framing stage the column draws into. The controls are placed on the
   * region the published page frames into, the capture viewer is confined to
   * it, and a video or audio player is placed as the page places it. Absent,
   * the column fills its pane and the pane is the region.
   */
  stage?: StageGeometry | null;
  /** A media scene's arrangement with its cards below the player, or null (`mediaCardBelow`). */
  mediaBelow?: MediaBelow | null;
  /** The video's shape as the page holds it (`video-aspect.ts`); null for a step that is not a video. */
  videoAspect?: VideoAspect | null;
  /** The aspect the Vimeo player reports once ready. */
  onVideoAspect?: (aspect: number) => void;
  /** Where the stage's chrome puts the controls (`layoutStageChrome`), and the measures it takes. */
  chrome?: StageChrome;
  /** The visitor layer, drawn over the image and under the controls. */
  visitorLayer?: ReactNode;
  /**
   * Controls a caller adds to the region, given whether the step shows an
   * image and the distance from the region's bottom that clears its bar.
   */
  stageOverlay?: (placement: { isImage: boolean; aboveBar: number }) => ReactNode;
  /** Told whether the capture guides show, which the stage's other guide labels follow. */
  onGuidesChange?: (shown: boolean) => void;
  /** Callback to open the in-product docs drawer — threaded from the _app shell via outlet context. */
  onOpenDoc?: (id: string) => void;
}

/**
 * Pan and zoom to a saved framing, or go home when there is none to restore.
 *
 * A stored framing gets whichever of three answers the published story gives
 * it, and `publishedFraming` is where that is decided: the stored framing; the
 * whole-object value in place of a field that reads as no number; or no framing
 * at all, for a zoom at or below zero or a centre outside the image, where the
 * viewer keeps the view it has.
 *
 * The zoom it hands back is shown through the floor, so a step captured under a
 * release that did not hold the floor appears as the site renders it rather than
 * as a framing no visitor can see. The centre is the point the site puts at the
 * region's centre (`visitorViewCentre`), which at zoom 1 and below is the
 * image's centre rather than the stored x and y. The step keeps the numbers it has either way: this hands the
 * viewport a value, it does not write one back, because opening a step is not
 * editing it. A capture comes through here too, to settle on what it stored.
 */
export function applyFraming(
  viewer: OpenSeadragon.Viewer,
  framing: SavedFraming | "home"
) {
  const viewport = viewer.viewport;
  if (framing === "home") {
    viewport.goHome(true);
    return;
  }
  const framed = publishedFraming(framing);
  if (!framed) return;
  const homeBounds = viewport.getHomeBounds();
  const homeZoom = viewport.getHomeZoom();
  const view = visitorViewCentre(framed, framed.zoom);
  const { point, actualZoom } = normalisedToViewport(
    homeBounds, homeZoom, view.x, view.y, clampCaptureZoom(framed.zoom), imageItemOf(viewer)
  );
  viewport.panTo(point as OpenSeadragon.Point, true);
  viewport.zoomTo(actualZoom, null as unknown as OpenSeadragon.Point, true);
  // The centre is held where the site shows it and the zoom stays the saved
  // one, which the site applies past OSD's maximum too.
  settleCentre(viewer as unknown as MeasuredViewer);
}

/**
 * The tiled image a stored x and y are fractions of, or null before it opens.
 * Pagination replaces the one item rather than adding a second, so it is
 * always item 0.
 */
function imageItemOf(viewer: OpenSeadragon.Viewer): ImageItem | null {
  return (viewer.world?.getItemAt(0) as unknown as ImageItem | undefined) ?? null;
}

/** The viewer's current framing as normalised Telar coordinates, x and y as a capture would store them. */
function liveFramingOf(viewer: OpenSeadragon.Viewer) {
  const vp = viewer.viewport;
  const center = vp.getCenter();
  const live = viewportToNormalised(
    vp.getHomeBounds(), vp.getHomeZoom(), center.x, center.y, vp.getZoom(), imageItemOf(viewer)
  );
  const { x, y } = captureFocal(live, clampCaptureZoom(live.zoom));
  return { x, y, zoom: live.zoom };
}

/**
 * Zoom the capture viewer by `factor`, clamped to the viewport's own zoom bounds
 * and then held inside its pan bounds, as every other way to zoom this viewer is.
 *
 * `minZoomImageRatio` bounds OSD's gestures, not a programmatic `zoomBy`: six
 * clicks of the zoom-out button settle at about 0.09 of home on an instance
 * whose floor is 0.1, so the button asserts the floor itself or the author feels
 * none where the published story has one.
 *
 * `applyConstraints()` is what the wheel, the pinch, the double-tap and OSD's
 * own keyboard handlers all end on, and `settleCentre` takes its pan bounds
 * without its zoom limits. The pan bounds move with the zoom, so it can
 * move a centre that was inside them at the previous zoom — that is the viewer
 * keeping the image on screen, not an overreach. Without it, repeated zoom-in on
 * an off-centre framing reaches a view the image lies entirely outside of, and a
 * capture taken there stores a centre outside 0…1 that the published site
 * refuses to frame at all.
 */
export function zoomConstrained(viewer: OpenSeadragon.Viewer | null, factor: number) {
  if (!viewer) return;
  const viewport = viewer.viewport;
  const requested = viewport.getZoom() * factor;
  // A zoom the site accepts is never taken down: past the maximum the button
  // holds the zoom it has.
  viewport.zoomTo(
    Math.min(Math.max(requested, viewport.getMinZoom()), Math.max(viewport.getMaxZoom(), viewport.getZoom()))
  );
  settleCentre(viewer as unknown as MeasuredViewer, false);
}

/** What the stage's chrome says to the viewer about its Viewfinder column. */
function viewerChromeOf(chrome: StageChrome) {
  const vf = chrome.layout.viewfinder;
  return {
    viewfinderAt: vf && { right: chrome.stage.w - (vf.x + vf.w), top: vf.y },
    viewfinderRef: chrome.measure("viewfinder"),
    hintRef: chrome.measure("hint"),
    showHint: !!chrome.layout.hint,
  };
}

/** The object the picker marks as current: the one the step shows, else the step's own value. */
function pickerSelection(shown: { object_id: string } | null, stepValue: string | null): string | null {
  return shown ? shown.object_id : stepValue;
}

export function ViewerColumn({
  step,
  isStepZero,
  selectionKey,
  stepDisplayNumber,
  totalSteps,
  objects,
  manifestUrl,
  infoJsonUrl,
  isSelfHosted,
  siteBaseUrl,
  frameworkVersion,
  onCapturePosition,
  onChangeObject,
  onChoosePage,
  pendingNewStep = null,
  onNewStepConsumed,
  onCaptureClip,
  onToggleLoop,
  repoFullName,
  captureUndoNonce = null,
  onUndoCapture,
  writeFailures = [],
  stage = null,
  mediaBelow = null,
  videoAspect = null,
  onVideoAspect,
  chrome,
  visitorLayer,
  stageOverlay,
  onGuidesChange,
  onOpenDoc,
}: ViewerColumnProps) {
  const { t, i18n } = useTranslation("editor");

  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const currentPageRef = useRef<() => number>(() => 0);
  const [liveCoords, setLiveCoords] = useState<LiveCoords | null>(null);
  const [captured, setCaptured] = useState(false);
  const [guidesOn, setGuidesOn] = useState(true);

  // The instance in front of the author, with the source key, generation and
  // page it was constructed for. Held in state so the Capture button's enabled
  // condition is reactive, and in a ref so the instance's own open handler can
  // read it without being rebound.
  const [instance, setInstance] = useState<InstanceRecord | null>(null);
  const instanceRef = useRef<InstanceRecord | null>(null);

  const [sourceState, setSourceState] = useState<SourceState | null>(null);
  const sourceStateRef = useRef<SourceState | null>(null);
  sourceStateRef.current = sourceState;

  const [targetPage, setTargetPage] = useState(0);
  const targetPageRef = useRef(0);
  targetPageRef.current = targetPage;

  const pendingFramingRef = useRef<FramingRequest | null>(null);

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
  const currentObject = resolveStepObject(objects, currentObjectId, frameworkVersion);

  // Determine media type for the current object
  const mediaType = detectMediaType(currentObject?.source_url, currentObject?.object_id);
  const isMedia =
    mediaType === "youtube" ||
    mediaType === "vimeo" ||
    mediaType === "google-drive" ||
    mediaType === "audio";

  // ---------------------------------------------------------------------------
  // Source identity, page selection and framing
  // ---------------------------------------------------------------------------

  const isIiif = mediaType === "iiif" || mediaType === "text-only";
  const columnSourceKey = sourceKeyFor(manifestUrl, infoJsonUrl);
  const currentTargetKey = step ? targetKeyFor(step) : null;

  // A change of source or media type invalidates everything the column holds
  // about the viewer, in the same render and independently of any child
  // callback: video and audio unmount the viewer, which therefore reports
  // nothing. The epoch keys the viewer element, so a remount is a distinct
  // component whose generations are never confused with an earlier mount's.
  const [epoch, setEpoch] = useState(() => ({
    key: columnSourceKey,
    media: mediaType as string,
    value: 0,
  }));
  if (epoch.key !== columnSourceKey || epoch.media !== mediaType) {
    setEpoch({ key: columnSourceKey, media: mediaType, value: epoch.value + 1 });
    setInstance(null);
    setSourceState(null);
    instanceRef.current = null;
    sourceStateRef.current = null;
  }

  const selectionKeyRef = useRef(selectionKey);
  selectionKeyRef.current = selectionKey;

  const savedPage = savedPageOf(step);
  /** The saved page as a 0-based index; 0 when the step stores none. */
  const savedPageIndex = (savedPage ?? 1) - 1;
  const savedFraming = savedFramingOf(step);

  /**
   * Apply the pending request to the instance in front of the author, if that
   * instance is the one the request was made for and it has opened. Called from
   * every trigger and from every instance's open handler, so a request that
   * arrives before an instance opens and one that arrives after are served by
   * the same path.
   */
  const applyPending = useCallback(() => {
    const req = pendingFramingRef.current;
    const viewer = viewerRef.current;
    const inst = instanceRef.current;
    const src = sourceStateRef.current;
    if (!req || !viewer || !inst || !inst.opened || !src) return;
    if (req.selectionKey !== selectionKeyRef.current) {
      pendingFramingRef.current = null;
      return;
    }
    if (!framingMatches(req, inst, src)) return;

    applyFraming(viewer, req.framing);
    pendingFramingRef.current = null;
  }, []);

  const requestFraming = useCallback(
    (page: number, framing: FramingRequest["framing"]) => {
      pendingFramingRef.current = {
        selectionKey: selectionKeyRef.current,
        sourceKey: columnSourceKey,
        page,
        framing,
      };
      applyPending();
    },
    [applyPending, columnSourceKey]
  );

  // Page selection and framing are two triggers over the same inputs. The page
  // moves to the step's own page on a selection change, a saved-page change and
  // a source change; a framing request is created for all three and, without
  // moving the page, when the saved coordinates change under the same key.
  const prevInputsRef = useRef<TriggerInputs | null>(null);

  useEffect(() => {
    const cur = triggerInputs(step, selectionKey, columnSourceKey);
    const prev = prevInputsRef.current;
    prevInputsRef.current = cur;

    const verdict = triggerVerdict(prev, cur);
    if (verdict === "none") return;
    if (verdict === "retarget") {
      setTargetPage(savedPageIndex);
      targetPageRef.current = savedPageIndex;
    }
    // Under `reframe` the author's own browsing is left alone: the request
    // belongs to the saved page and waits until they reach it.
    requestFraming(savedPageIndex, savedFraming ?? "home");
  // `savedFraming` is rebuilt every render from the three scalars already in the deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, step?.page, step?.x, step?.y, step?.zoom, columnSourceKey, savedPageIndex, requestFraming]);

  const handleSourceState = useCallback((state: SourceState) => {
    setSourceState(state);
    sourceStateRef.current = state;
  }, []);

  // A request outlives the count it was made under, so every arrival of a
  // source state is another chance for it to resolve: `applyPending` matches
  // the requested page against the count the state reports.
  useEffect(() => {
    applyPending();
  }, [sourceState, applyPending]);

  const captureReady = captureIsReady(instance, sourceState);

  const { page: livePage, count: pageCount } = readyPages(sourceState);
  const showPageCluster = !isStepZero && isIiif && pageCount > 1;

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
    (
      viewer: OpenSeadragon.Viewer,
      getCurrentPage: () => number,
      meta: ViewerInstanceMeta
    ) => {
      viewerRef.current = viewer;
      currentPageRef.current = getCurrentPage;

      const record: InstanceRecord = { meta, opened: false };
      instanceRef.current = record;
      setInstance(record);

      // A persistent open handler: it marks this instance opened and runs the
      // one apply routine, which covers a request created before the open and,
      // through the triggers, one created after it.
      viewer.addHandler("open", () => {
        if (instanceRef.current?.meta !== meta) return;
        const opened: InstanceRecord = { meta, opened: true };
        instanceRef.current = opened;
        setInstance(opened);
        applyPending();
      });

      // Read initial coordinates (normalised)
      viewer.addOnceHandler("open", () => {
        setLiveCoords(liveFramingOf(viewer));
      });

      // Live-coordinate tracking belongs to THIS viewer. Any registration on a
      // previous viewer is detached first, so handlers never leak across the
      // destroy-and-rebuild that every page or object change performs.
      detachAnimationHandler();
      const handler = () => {
        setLiveCoords(liveFramingOf(viewer));
      };
      viewer.addHandler("animation", handler);
      viewer.addHandler("animation-finish", handler);
      animHandlerRef.current = { viewer, handler };
    },
    [detachAnimationHandler, applyPending]
  );

  /**
   * The instance named by `meta` has gone. Between here and the replacement's
   * `onViewerReady` there is nothing to pan, so the record is dropped rather
   * than left describing a destroyed viewer; a request made in the gap waits
   * for the replacement instead of being consumed by the one that went.
   */
  const handleViewerDestroyed = useCallback((meta: ViewerInstanceMeta) => {
    if (instanceRef.current?.meta !== meta) return;
    instanceRef.current = null;
    viewerRef.current = null;
    setInstance(null);
  }, []);

  function handleCapture() {
    const v = viewerRef.current;
    // Live state, not the rendered `captureReady`: the instance the render was
    // drawn from can have been destroyed by a page change since. The binding
    // travels with the viewport so the write lands only where the step, the
    // object and the source it was read from all still hold.
    if (!v || !step) return;
    const binding = captureBindingOf(
      instanceRef.current,
      sourceStateRef.current,
      selectionKeyRef.current,
      currentTargetKey,
      currentObjectId
    );
    if (!binding) return;

    const vp = v.viewport;
    const center = vp.getCenter();
    const zoom = vp.getZoom();
    const pageIndex = currentPageRef.current();
    const homeBounds = vp.getHomeBounds();
    const homeZoom = vp.getHomeZoom();
    const pos = captureViewportState(
      center, zoom, pageIndex, homeBounds, homeZoom, imageItemOf(v)
    );

    onCapturePosition(pos, binding);
    // At zoom 1 and below the site centres the image wherever the author left it.
    applyFraming(v, pos);

    // Brief "Captured" feedback. Clear any prior flash timer first so a rapid
    // re-capture doesn't leak overlapping timers (the older one would fire
    // setCaptured(false) mid-flash of this newer capture).
    if (capturedTimerRef.current) clearTimeout(capturedTimerRef.current);
    setCaptured(true);
    capturedTimerRef.current = setTimeout(() => setCaptured(false), 1500);
  }

  // Reset returns to the saved page as well as the saved framing, and tests the
  // saved coordinates for null rather than truthiness, so a saved x or y of 0
  // is a valid position and not an absent one.
  function handleResetPosition() {
    if (!savedFraming) return;
    setTargetPage(savedPageIndex);
    targetPageRef.current = savedPageIndex;
    requestFraming(savedPageIndex, savedFraming);
  }

  // ---------------------------------------------------------------------------
  // The dialog chain
  // ---------------------------------------------------------------------------

  const {
    chain,
    changePageButtonRef,
    changeObjectButtonRef,
    endChain,
    openChooser,
    openPicker,
    handlePickerSelect,
    handlePickerClose,
  } = useViewerDialogChain({
    activeTempId: step?._tempId ?? null,
    hasStep: step !== null,
    selectionKey,
    currentObjectId,
    currentTargetKey,
    columnSourceKey,
    isIiif,
    sourceState,
    pendingNewStep,
    onNewStepConsumed,
    onChangeObject,
  });

  /**
   * A choice is a navigation command as well as a write: the page moves and a
   * home framing request lands on it, so choosing the already-saved page while
   * browsing elsewhere still returns the viewer to that page.
   */
  function handleChooserChoice(page: number, session: PageChooserSession) {
    onChoosePage?.(page, session);
    setTargetPage(page - 1);
    targetPageRef.current = page - 1;
    requestFraming(page - 1, "home");
    endChain();
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
    source_url: o.source_url,
  }));

  const boxes = stageMediaBoxes(stage, mediaBelow, isMedia, videoAspect);
  const regionStage = boxes.region;
  const imageRegionOf = useStageRegionOf(stage);
  const guidesShown = mediaType === "iiif" && guidesOn;
  useEffect(() => {
    onGuidesChange?.(guidesShown);
  }, [guidesShown, onGuidesChange]);

  return (
    <div className="relative w-full h-full">
      {/* Main viewer area — branches on media type */}
      {isIiif && (
        <div className="absolute inset-0" style={{ zIndex: STAGE_Z.image }}>
          <IiifViewer
            key={`source-${epoch.value}`}
            manifestUrl={manifestUrl}
            infoJsonUrl={infoJsonUrl}
            isSelfHosted={isSelfHosted}
            alt={step?.alt_text || currentObject?.alt_text || currentObject?.title || currentObject?.object_id || "IIIF viewer"}
            className="w-full h-full"
            onViewerReady={handleViewerReady}
            onViewerDestroyed={handleViewerDestroyed}
            hideZoomControls
            hidePageControls
            page={targetPage}
            onSourceState={handleSourceState}
            enableCaptureGuides={mediaType === "iiif"}
            measureInAuthoringFrame
            regionOf={imageRegionOf}
            onGuidesToggle={setGuidesOn}
            stageLabelUnderFrame={stage?.layout.cardPlacement === "bottom"}
            chrome={chrome && viewerChromeOf(chrome)}
            minZoomImageRatio={CAPTURE_MIN_ZOOM_RATIO}
            maxZoomLevel={CAPTURE_MAX_ZOOM_LEVEL}
          />
        </div>
      )}

      {(mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive") && videoId && (
        <StageVideo box={boxes.video}>
              <VideoEmbed
                type={mediaType}
                videoId={videoId}
                vimeoHash={mediaType === "vimeo" && currentObject?.source_url ? extractVimeoHash(currentObject.source_url) : undefined}
                getCurrentTimeRef={getCurrentTimeRef}
                getDurationRef={videoDurationRef}
                playerControlsRef={playerControlsRef}
                onTimeUpdate={setVideoCurrentTime}
                fill={boxes.video !== null}
                onAspect={onVideoAspect}
              />
        </StageVideo>
      )}

      {mediaType === "audio" && currentObject?.source_url && siteBaseUrl && (
        <StageAudio waveform={boxes.waveform} placement={boxes.audio}>
            <AudioPlayer
              placement={boxes.audio}
              key={`${currentObject.object_id}-step-${step?.id}`}
              audioUrl={`${siteBaseUrl}/telar-content/objects/${currentObject.source_url}`}
              getCurrentTimeRef={getCurrentTimeRef}
              clipStart={step?.clip_start ? parseFloat(step.clip_start) : undefined}
              clipEnd={step?.clip_end ? parseFloat(step.clip_end) : undefined}
              waveformHeight={boxes.waveform ? Math.round(boxes.waveform.h) : undefined}
              onClipChange={(start, end) => {
                onCaptureClip?.("clip_start", String(start));
                onCaptureClip?.("clip_end", String(end));
              }}
            />
        </StageAudio>
      )}

      {mediaType === "audio" && (!currentObject?.source_url || !siteBaseUrl) && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: STAGE_Z.image }}>
          <p className="font-body text-sm text-gray-400">
            {t("media.media_preview_unavailable")}
          </p>
        </div>
      )}

      {/* The step card, at the visitor's size */}
      {visitorLayer}

      <StageRegionControls
        chrome={chrome}
        region={regionStage}
        isStepZero={isStepZero}
        objectLabel={objectLabel}
        stepIndicatorLabel={stepIndicatorLabel}
        changeObjectButtonRef={changeObjectButtonRef}
        onChangeObject={openPicker}
        zoom={
          isIiif
            ? {
                onZoomIn: () => zoomConstrained(viewerRef.current, 1.5),
                onZoomOut: () => zoomConstrained(viewerRef.current, 0.67),
                onHome: () => viewerRef.current?.viewport.goHome(),
              }
            : null
        }
        iiifBar={
          !isStepZero && isIiif
            ? {
                coords: liveCoords,
                showPageCluster,
                page: livePage,
                pageCount,
                onPrevPage: () => setTargetPage(Math.max(0, livePage - 1)),
                onNextPage: () => setTargetPage(Math.min(pageCount - 1, livePage + 1)),
                onOpenChooser: openChooser,
                changePageButtonRef,
                captureReady,
                captured,
                onCapture: handleCapture,
                canReset: savedFraming !== null,
                onReset: handleResetPosition,
              }
            : null
        }
        stepZeroCoords={isStepZero && isIiif ? liveCoords : undefined}
        mediaBar={
          !isStepZero && isMedia
            ? {
                mediaType,
                stepKey: step?.id,
                videoDuration,
                videoCurrentTime,
                clipStartSeconds,
                clipEndSeconds,
                loopEnabled,
                onClipChange: (start, end) => {
                  onCaptureClip?.("clip_start", String(start));
                  onCaptureClip?.("clip_end", String(end));
                },
                onPreviewClip: handlePreviewClip,
                onToggleLoop: (checked) => onToggleLoop?.(checked ? "true" : ""),
                onOpenDoc,
              }
            : null
        }
        undoShown={captureToastShown}
        onUndo={() => {
          onUndoCapture?.();
          setCaptureToastShown(false);
        }}
      >
        {(aboveBar) => stageOverlay?.({ isImage: isIiif, aboveBar })}
      </StageRegionControls>

      <StageWriteFailureNotice writes={writeFailures} />

      {/* Object picker dialog */}
      <ObjectPickerDialog
        open={chain?.stage === "picker"}
        onClose={handlePickerClose}
        onSelect={handlePickerSelect}
        objects={pickerObjects}
        currentObjectId={pickerSelection(currentObject, currentObjectId)}
        siteBaseUrl={siteBaseUrl}
        frameworkVersion={frameworkVersion}
      />

      {/* Keep-or-choose, for a step seeded from the one before it */}
      <NewStepDialog
        open={chain?.stage === "confirm"}
        objectTitle={currentObject?.title ?? null}
        onKeep={endChain}
        onChoose={openPicker}
      />

      {/* Page chooser */}
      <PageChooserDialog
        open={chain?.stage === "chooser"}
        onClose={endChain}
        session={chain?.session ?? null}
        pages={sourceState?.status === "ready" ? sourceState.pages : []}
        objectTitle={currentObject?.title ?? null}
        savedPage={savedPage}
        effectivePage={livePage}
        onChoose={handleChooserChoice}
      />
    </div>
  );
}
