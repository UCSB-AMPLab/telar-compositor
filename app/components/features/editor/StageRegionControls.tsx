/**
 * The controls of the story editor's viewer, placed on the region the
 * published page frames the image into: the object and step bar along its
 * top, the zoom cluster at its right, the IIIF bar with Capture along its
 * bottom (the coordinate readout alone on the title card), the clip bar of a
 * video or audio step, and the Undo pill after a capture.
 *
 * They are drawn at stage pixels, never scaled with the visitor's window, so
 * their text stays the editor's size whatever the stage's scale. The region
 * wrapper passes no pointer events of its own, so the image and the card
 * beneath it still take drags and clicks; each control takes its own. The
 * wrapper is also the container the bottom bar's width queries read, so the
 * bar lays itself out for the region rather than the stage.
 *
 * Without a region the controls fill the column, as they did before the
 * stage existed.
 *
 * The controls report intent and own no state: the column holds the viewer,
 * the capture and the dialog chain they act on.
 *
 * @version v1.5.0-beta
 */

import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Check, Home, Image, Play, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { CoordinateReadout, ViewerBottomBar } from "~/components/features/editor/ViewerBottomBar";
import type { LiveCoords } from "~/components/features/editor/ViewerBottomBar";
import { ClipTimeline } from "~/components/features/editor/ClipTimeline";
import { DocsLink } from "~/components/ui/DocsLink";
import { Switch } from "~/components/ui/Switch";
import { secondsToMmss } from "~/lib/media-type";
import type { Box } from "~/lib/framing-stage";
import { zoomIsRow, type ChromeLayout } from "~/lib/stage-chrome";
import type { ChromeMeasure } from "~/hooks/use-chrome-sizes";
import { STAGE_Z } from "~/components/features/editor/FramingStage";

export interface MediaBarProps {
  mediaType: string;
  /** The step's key, so the timeline starts afresh for each step. */
  stepKey: number | undefined;
  videoDuration: number;
  videoCurrentTime: number;
  clipStartSeconds: number | null;
  clipEndSeconds: number | null;
  loopEnabled: boolean;
  onClipChange: (start: number, end: number) => void;
  onPreviewClip: () => void;
  onToggleLoop: (checked: boolean) => void;
  onOpenDoc?: (id: string) => void;
}

interface StageRegionControlsProps {
  /** The region in stage pixels, or null to fill the column. */
  region: Box | null;
  isStepZero: boolean;
  objectLabel: string;
  stepIndicatorLabel: string;
  changeObjectButtonRef: RefObject<HTMLButtonElement | null>;
  onChangeObject: () => void;
  /** The zoom cluster's actions, for an image; null for video and audio. */
  zoom: { onZoomIn: () => void; onZoomOut: () => void; onHome: () => void } | null;
  /** The IIIF bar, for an image step. */
  iiifBar: ComponentProps<typeof ViewerBottomBar> | null;
  /** The readout the title card shows in place of the bar. */
  stepZeroCoords: LiveCoords | null | undefined;
  mediaBar: MediaBarProps | null;
  undoShown: boolean;
  onUndo: () => void;
  /**
   * Controls a caller adds to the region, such as the alt-text chip, given
   * the distance from the region's bottom that clears the bottom bar.
   */
  children?: (aboveBar: number) => ReactNode;
  /**
   * On the framing stage: where the stage's chrome puts each control, in
   * stage pixels, and the measures it lays them out from. The controls are then
   * placed over the whole stage, each at its own box.
   */
  chrome?: StageChrome;
}

/** The stage chrome's say over the region's controls. */
export interface StageChrome {
  layout: ChromeLayout;
  measure: ChromeMeasure;
  compact: boolean;
  stage: { w: number; h: number };
}

/**
 * A bar drawn at `bottom-3 left-3 right-3` of its wrapper, at the chrome's box:
 * the wrapper is the box grown by that inset, and is the container the bar's
 * width queries read.
 */
function barWrapStyle(box: Box, stage: { w: number; h: number }) {
  return { left: box.x - 12, width: box.w + 24, bottom: stage.h - (box.y + box.h) - 12, height: box.h + 12 };
}

const boxStyle = (box: Box | undefined) => (box ? { left: box.x, top: box.y, width: box.w } : undefined);

/** The bar's inset from the region's bottom, and the gap kept above it. */
const BAR_INSET = 12;
const ABOVE_BAR_GAP = 8;
/** The one-row bar's height, until the bar has been measured. */
const BAR_HEIGHT_UNMEASURED = 40;

/**
 * How far above the region's bottom the bottom bar ends, measured, since the
 * bar wraps to two rows in a narrow region.
 */
function useAboveBar(wrap: RefObject<HTMLDivElement | null>, present: boolean): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const bar = wrap.current?.firstElementChild as HTMLElement | null | undefined;
    if (!present || !bar) return;
    const measureBar = () => setHeight(bar.offsetHeight);
    measureBar();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureBar);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [wrap, present]);
  return BAR_INSET + (height || BAR_HEIGHT_UNMEASURED) + ABOVE_BAR_GAP;
}

/** The region wrapper's placement: the region's box, or the whole column. */
function regionStyle(region: Box | null) {
  if (!region) return { left: 0, top: 0, right: 0, bottom: 0 };
  return { left: region.x, top: region.y, width: region.w, height: region.h };
}

export function StageRegionControls({
  region,
  isStepZero,
  objectLabel,
  stepIndicatorLabel,
  changeObjectButtonRef,
  onChangeObject,
  zoom,
  iiifBar,
  stepZeroCoords,
  mediaBar,
  undoShown,
  onUndo,
  children,
  chrome,
}: StageRegionControlsProps) {
  const barWrap = useRef<HTMLDivElement>(null);
  const aboveBar = useAboveBar(barWrap, iiifBar !== null);
  return (
    <div
      data-testid="stage-region-controls"
      className="@container absolute pointer-events-none [&>*]:pointer-events-auto"
      style={{ ...regionStyle(chrome ? null : region), zIndex: STAGE_Z.controls }}
    >
      <TopBar
        chrome={chrome}
        isStepZero={isStepZero}
        objectLabel={objectLabel}
        stepIndicatorLabel={stepIndicatorLabel}
        changeObjectButtonRef={changeObjectButtonRef}
        onChangeObject={onChangeObject}
      />

      {zoom && (
        <ZoomCluster
          {...zoom}
          at={chrome?.layout.zoom}
          row={zoomIsRow(chrome?.layout.zoom)}
          measureRef={chrome?.measure("zoom")}
        />
      )}

      <BottomBar chrome={chrome} barWrap={barWrap} iiifBar={iiifBar} mediaBar={mediaBar} />

      {stepZeroCoords !== undefined && (
        <div className="absolute bottom-3 left-3 right-3 bg-black/60 rounded px-3 py-2 font-mono text-xs text-qolle-pale">
          <CoordinateReadout coords={stepZeroCoords} />
        </div>
      )}

      {mediaBar && !chrome?.layout.bar && <MediaBar {...mediaBar} />}

      {/* After a capture, for five seconds: Undo reverts the step in one transaction */}
      {undoShown && <UndoPill chrome={chrome} region={region} onUndo={onUndo} />}

      {children?.(aboveBar)}
    </div>
  );
}

/**
 * The bottom bar: on the stage, the step's bar (the viewer's or the media's)
 * in a wrapper at the chrome's box, measured; without it, the viewer's bar in
 * the region's flow, where `barWrap` measures it.
 */
function BottomBar({
  chrome,
  barWrap,
  iiifBar,
  mediaBar,
}: Pick<StageRegionControlsProps, "chrome" | "iiifBar" | "mediaBar"> & { barWrap: RefObject<HTMLDivElement | null> }) {
  const bar = chrome?.layout.bar;
  if (!chrome || !bar) {
    return (
      <div ref={barWrap} className="contents">
        {iiifBar && <ViewerBottomBar {...iiifBar} />}
      </div>
    );
  }
  return (
    <div ref={chrome.measure("bar", true)} className="@container absolute" style={barWrapStyle(bar, chrome.stage)}>
      {iiifBar && <ViewerBottomBar {...iiifBar} />}
      {mediaBar && <MediaBar {...mediaBar} />}
    </div>
  );
}

/** Captured, with Undo: under the top bar at the region's centre on the stage, or at the viewer's top. */
function UndoPill({ chrome, region, onUndo }: Pick<StageRegionControlsProps, "chrome" | "region" | "onUndo">) {
  const { t } = useTranslation("editor");
  const placed = chrome && region;
  return (
    <div
      role="status"
      className={`absolute -translate-x-1/2 flex items-center gap-2 bg-charcoal text-cream rounded-full px-4 py-2 font-heading text-xs shadow-lg${chrome ? "" : " top-16 left-1/2"}`}
      style={placed ? { left: region.x + region.w / 2, top: chrome.layout.topBar.y + chrome.layout.topBar.h + 8 } : undefined}
    >
      <Check className="w-3.5 h-3.5 shrink-0" />
      <span>{t("capture_toast.captured")}</span>
      <span className="text-cream/40" aria-hidden="true">
        ·
      </span>
      <button
        type="button"
        onClick={onUndo}
        className="flex items-center gap-1 font-semibold hover:text-cream/80 transition-colors"
      >
        <Undo2 className="w-3.5 h-3.5 shrink-0" />
        {t("capture_toast.undo")}
      </button>
    </div>
  );
}

/** The object and step: the object opens the picker; the title card names step 1's. */
function TopBar({
  chrome,
  isStepZero,
  objectLabel,
  stepIndicatorLabel,
  changeObjectButtonRef,
  onChangeObject,
}: Pick<StageRegionControlsProps, "chrome" | "isStepZero" | "objectLabel" | "stepIndicatorLabel" | "changeObjectButtonRef" | "onChangeObject">) {
  const { t } = useTranslation("editor");
  return (
    <div
      ref={chrome?.measure("topBar")}
      className={`absolute${chrome ? "" : " top-3 left-3 right-3"} flex items-center justify-between bg-black/60 rounded text-sm font-body`}
      style={boxStyle(chrome?.layout.topBar)}
    >
      {isStepZero ? (
        <div className="flex items-start gap-1.5 text-cream/60 px-3 py-2 text-xs leading-snug cursor-default select-none">
          <Image className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{t("viewer.set_object_in_step1")}</span>
        </div>
      ) : (
        <button
          type="button"
          ref={changeObjectButtonRef}
          onClick={onChangeObject}
          aria-label={t("viewer.change_object")}
          className="flex items-center gap-1.5 text-cream px-3 py-2 hover:bg-white/10 rounded-l transition-colors min-w-0"
        >
          <Image className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{objectLabel}</span>
        </button>
      )}
      <div className="text-cream px-3 py-2 shrink-0">{stepIndicatorLabel}</div>
    </div>
  );
}

const ZOOM_BUTTON =
  "w-8 h-8 bg-black/60 hover:bg-black/80 rounded flex items-center justify-center text-cream/70 hover:text-cream transition-colors";

/**
 * Zoom in, zoom out and home: at the region's right, centred on its height, or
 * where the stage's chrome puts them, in a row in a compact region.
 */
function ZoomCluster({
  onZoomIn,
  onZoomOut,
  onHome,
  at,
  row = false,
  measureRef,
}: NonNullable<StageRegionControlsProps["zoom"]> & {
  at?: Box;
  row?: boolean;
  measureRef?: (el: HTMLElement | null) => void;
}) {
  const { t } = useTranslation("editor");
  return (
    <div
      ref={measureRef}
      data-testid="zoom-cluster"
      className={`absolute flex gap-1 ${row ? "flex-row" : "flex-col"}${at ? "" : " right-3 top-1/2 -translate-y-1/2"}`}
      style={at ? { left: at.x, top: at.y } : undefined}
    >
      <button type="button" onClick={onZoomIn} className={ZOOM_BUTTON} aria-label={t("viewer.zoom_in_aria")}>
        <ZoomIn className="w-4 h-4" />
      </button>
      <button type="button" onClick={onZoomOut} className={ZOOM_BUTTON} aria-label={t("viewer.zoom_out_aria")}>
        <ZoomOut className="w-4 h-4" />
      </button>
      <button type="button" onClick={onHome} className={ZOOM_BUTTON} aria-label={t("viewer.reset_aria")}>
        <Home className="w-4 h-4" />
      </button>
    </div>
  );
}

/** A video or audio step's clip: the timeline (video only), Preview, the range and Loop. */
function MediaBar({
  mediaType,
  stepKey,
  videoDuration,
  videoCurrentTime,
  clipStartSeconds,
  clipEndSeconds,
  loopEnabled,
  onClipChange,
  onPreviewClip,
  onToggleLoop,
  onOpenDoc,
}: MediaBarProps) {
  const { t } = useTranslation("editor");
  const hasClip = clipStartSeconds !== null || clipEndSeconds !== null;
  return (
    <div className="absolute bottom-3 left-3 right-3 bg-black/60 rounded p-2">
      {/* Audio carries its clip in the waveform */}
      {mediaType !== "audio" && videoDuration > 0 && (
        <div className="mb-2">
          <ClipTimeline
            key={`clip-${stepKey}`}
            duration={videoDuration}
            currentTime={videoCurrentTime}
            clipStart={clipStartSeconds ?? 0}
            clipEnd={clipEndSeconds ?? videoDuration}
            onClipChange={onClipChange}
          />
        </div>
      )}
      <div className="flex items-center font-mono text-xs">
        <div className="w-1/3">
          {hasClip && (
            <button
              type="button"
              onClick={onPreviewClip}
              className="flex items-center gap-1 px-2 py-1 bg-anil hover:bg-anil/80 text-charcoal rounded text-[10px] font-heading uppercase tracking-wider transition-colors"
            >
              <Play className="w-3 h-3" />
              {t("preview_clip")}
            </button>
          )}
        </div>
        <div className="w-1/3 text-center text-qolle-pale shrink-0">
          <ClipRange mediaType={mediaType} start={clipStartSeconds} end={clipEndSeconds} />
        </div>
        <div className="w-1/3 flex items-center justify-end gap-1.5">
          {onOpenDoc && (
            <DocsLink docId="video" onOpenDoc={onOpenDoc} className="!text-cream/60 hover:!text-cream" />
          )}
          <span className="font-heading text-xs text-cream/70 uppercase tracking-wider">{t("media.loop")}</span>
          <Switch checked={loopEnabled} onChange={onToggleLoop} label={t("media.loop")} />
        </div>
      </div>
    </div>
  );
}

/** The clip's start and end, or what the step has instead of a clip. */
function ClipRange({ mediaType, start, end }: { mediaType: string; start: number | null; end: number | null }) {
  const { t } = useTranslation("editor");
  if (start !== null || end !== null) {
    return <span>{t("media.clip_range", { start: secondsToMmss(start ?? 0), end: secondsToMmss(end ?? 0) })}</span>;
  }
  const key = mediaType === "google-drive" ? "media.google_drive_no_clip" : "media.no_clip_set";
  return <span className="opacity-70">{t(key)}</span>;
}
