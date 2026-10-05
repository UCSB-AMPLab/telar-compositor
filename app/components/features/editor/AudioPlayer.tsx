/**
 * AudioPlayer — WaveSurfer v7 waveform player with clip region capture.
 *
 * Renders a waveform with a draggable region overlay for setting clip
 * start/end times. Matches the Telar framework's audio object page design:
 * anil background, white/charcoal waveform, region handles, and
 * play/rewind/volume controls.
 *
 * When `clipStart`/`clipEnd` are provided, the region is initialised to
 * those values. When the user drags region handles, `onClipChange` fires
 * with the new start/end values (in seconds).
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, RotateCcw, Volume2, VolumeX } from "lucide-react";
import {
  AUDIO_CONTROL_ICON,
  AUDIO_CONTROLS_BUTTON_GAP,
  AUDIO_ELAPSED,
  AUDIO_PLAY_ICON,
  type Box,
} from "~/lib/framing-stage";

interface AudioPlayerProps {
  audioUrl: string;
  getCurrentTimeRef?: React.MutableRefObject<(() => Promise<number>) | null>;
  /** Initial clip start in seconds */
  clipStart?: number;
  /** Initial clip end in seconds (defaults to full duration) */
  clipEnd?: number;
  /** Called when region handles are dragged */
  onClipChange?: (start: number, end: number) => void;
  /** Show the draggable clip region (defaults to true when onClipChange provided) */
  showRegion?: boolean;
  /**
   * The waveform's height in pixels: on the framing stage, the height the
   * published page gives it (`audioWaveformBox`); 80 elsewhere.
   */
  waveformHeight?: number;
  /**
   * On the framing stage with the card below: the waveform's box and the
   * controls row's box, each placed on its own in stage pixels relative to
   * the positioned parent, with the stage's scale for the row's gap. The
   * waveform fills its box and the row's buttons are as tall as the row.
   */
  placement?: {
    wave: Box;
    controls: Box;
    /** The playing time's anchor from the parent's right and bottom edges. */
    elapsed: { right: number; bottom: number };
    scale: number;
  };
}

const DEFAULT_WAVEFORM_HEIGHT = 80;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Reads a theme colour token's live value off `:root` so WaveSurfer (which
 * takes real colour strings, not Tailwind classes) stays in sync with the
 * `@theme` block in app.css instead of carrying its own hex copy. Falls back
 * to the literal if the token is missing or this runs outside a browser.
 */
function themeColor(cssVar: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  return value || fallback;
}

export function AudioPlayer({
  audioUrl,
  getCurrentTimeRef,
  clipStart,
  clipEnd,
  onClipChange,
  showRegion,
  waveformHeight = DEFAULT_WAVEFORM_HEIGHT,
  placement,
}: AudioPlayerProps) {
  const { t } = useTranslation("editor");
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<import("wavesurfer.js").default | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [regionStart, setRegionStart] = useState(clipStart ?? 0);
  const [regionEnd, setRegionEnd] = useState(clipEnd ?? 0);
  const [saved, setSaved] = useState(false);
  const [showSavedMsg, setShowSavedMsg] = useState(false);
  const regionRef = useRef<any>(null);

  // Region starts gold if clip values were loaded from DB
  const hasSavedClip = !!(clipStart || clipEnd);

  const shouldShowRegion = showRegion ?? !!onClipChange;

  // Read at construction, and applied to the live waveform when it changes,
  // so a resized stage redraws the waveform rather than rebuilding the player.
  const heightRef = useRef(waveformHeight);
  heightRef.current = waveformHeight;
  useEffect(() => {
    wsRef.current?.setOptions({ height: waveformHeight });
  }, [waveformHeight]);

  useEffect(() => {
    if (!containerRef.current) return;

    let ws: import("wavesurfer.js").default | null = null;
    let destroyed = false;

    (async () => {
      try {
        const [WaveSurferMod, RegionsMod] = await Promise.all([
          import("wavesurfer.js"),
          shouldShowRegion ? import("wavesurfer.js/dist/plugins/regions.js") : null,
        ]);
        const WaveSurfer = WaveSurferMod.default;

        if (destroyed) return;

        const plugins: any[] = [];
        let regionsPlugin: any = null;

        if (RegionsMod && shouldShowRegion) {
          regionsPlugin = RegionsMod.default.create();
          plugins.push(regionsPlugin);
        }

        ws = WaveSurfer.create({
          container: containerRef.current!,
          waveColor: themeColor("--color-surface", "#FFFFFF"),
          progressColor: themeColor("--color-charcoal", "#333333"),
          cursorColor: themeColor("--color-charcoal", "#333333"),
          url: audioUrl,
          height: heightRef.current,
          barWidth: 3,
          barGap: 2,
          barRadius: 2,
          normalize: true,
          plugins,
        });

        wsRef.current = ws;

        if (getCurrentTimeRef) {
          getCurrentTimeRef.current = async () => ws!.getCurrentTime();
        }

        ws.on("ready", () => {
          if (destroyed) return;
          const dur = ws!.getDuration();
          setIsLoading(false);
          setDuration(dur);

          // Initialise clip region
          if (regionsPlugin) {
            const start = clipStart ?? 0;
            const end = clipEnd ?? dur;
            const isSaved = !!(clipStart || clipEnd);
            setRegionStart(start);
            setRegionEnd(end);
            setSaved(isSaved);

            const region = regionsPlugin.addRegion({
              start,
              end,
              color: isSaved
                ? "rgba(156, 123, 31, 0.25)"  // qolle when saved
                : "rgba(136, 60, 54, 0.15)",   // terracotta when unsaved
              drag: true,
              resize: true,
            });
            regionRef.current = region;

            region.on("update-end", () => {
              const s = region.start;
              const e = region.end;
              setRegionStart(s);
              setRegionEnd(e);
              onClipChange?.(s, e);
              // Turn qolle and show saved message
              region.setOptions({ color: "rgba(156, 123, 31, 0.25)" });
              setSaved(true);
              setShowSavedMsg(true);
              setTimeout(() => setShowSavedMsg(false), 2000);
            });
          }
        });

        ws.on("timeupdate", (time: number) => {
          if (!destroyed) setCurrentTime(time);
        });

        ws.on("play", () => {
          if (!destroyed) setIsPlaying(true);
        });

        ws.on("pause", () => {
          if (!destroyed) setIsPlaying(false);
        });

        ws.on("finish", () => {
          if (!destroyed) setIsPlaying(false);
        });

        ws.on("error", () => {
          if (!destroyed) {
            setIsLoading(false);
            setHasError(true);
          }
        });
      } catch {
        if (!destroyed) {
          setIsLoading(false);
          setHasError(true);
        }
      }
    })();

    return () => {
      destroyed = true;
      if (getCurrentTimeRef) {
        getCurrentTimeRef.current = null;
      }
      ws?.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  const handlePlayPause = useCallback(() => {
    wsRef.current?.playPause();
  }, []);

  const handleRewind = useCallback(() => {
    if (wsRef.current) {
      const seekTo = shouldShowRegion ? regionStart : Math.max(0, wsRef.current.getCurrentTime() - 5);
      wsRef.current.seekTo(seekTo / wsRef.current.getDuration());
      wsRef.current.play();
    }
  }, [regionStart, shouldShowRegion]);

  const handleMuteToggle = useCallback(() => {
    if (wsRef.current) {
      const newMuted = !isMuted;
      wsRef.current.setVolume(newMuted ? 0 : 1);
      setIsMuted(newMuted);
    }
  }, [isMuted]);

  if (hasError) {
    return (
      <div className="w-full rounded-lg bg-anil p-6 flex items-center justify-center">
        <p className="font-body text-sm text-charcoal/50">
          {t("media.media_preview_unavailable")}
        </p>
      </div>
    );
  }

  const buttons = (size?: number) => (
    <AudioButtons
      size={size}
      scale={placement?.scale}
      isPlaying={isPlaying}
      isMuted={isMuted}
      onPlayPause={handlePlayPause}
      onRewind={handleRewind}
      onMuteToggle={handleMuteToggle}
    />
  );
  const elapsed = (
    <span className="font-mono text-xs text-charcoal/60">
      {formatTime(currentTime)} / {formatTime(duration)}
    </span>
  );
  const savedClip = shouldShowRegion && (saved || showSavedMsg) && (
    <span className={`font-mono text-xs text-qolle-deep transition-opacity ${showSavedMsg ? "opacity-100" : "opacity-70"}`}>
      {formatTime(regionStart)} → {formatTime(regionEnd)}
      {showSavedMsg && (
        <span className="ml-2 font-body text-[10px] uppercase tracking-wider">✓ {t("media.clip_saved")}</span>
      )}
    </span>
  );
  const loading = isLoading && (
    <div className="h-20 flex items-center justify-center">
      <p className="font-body text-sm text-charcoal/50">{t("media.audio_loading")}</p>
    </div>
  );

  // One tree in both placements, so the element WaveSurfer draws into is the
  // same element whichever is in force: the placement only positions it.
  const wave = placement?.wave;
  const controls = placement?.controls;
  return (
    <div className={placement ? "contents" : "w-full"}>
      <div
        data-testid={placement ? "audio-wave" : undefined}
        className={placement ? "absolute rounded-lg bg-anil overflow-hidden" : "rounded-lg bg-anil overflow-hidden"}
        style={wave ? { left: wave.x, top: wave.y, width: wave.w, height: wave.h } : undefined}
      >
        <div className={placement ? undefined : "px-4 pt-4 pb-2"}>
          {loading}
          <div ref={containerRef} className={isLoading ? "invisible h-0" : "w-full"} />
        </div>
        {!placement && !isLoading && !hasError && (
          <div className="flex items-center justify-between px-4 pb-3">
            {elapsed}
            <div className="flex items-center gap-1">{buttons()}</div>
          </div>
        )}
      </div>
      {controls && !isLoading && (
        <>
          <div
            data-testid="audio-controls"
            className="absolute flex items-center justify-center"
            style={{
              left: controls.x,
              top: controls.y,
              width: controls.w,
              height: controls.h,
              gap: AUDIO_CONTROLS_BUTTON_GAP * placement.scale,
            }}
          >
            {buttons(controls.h)}
          </div>
          <SavedClipReadout row={controls}>{savedClip}</SavedClipReadout>
        </>
      )}
      {placement && !isLoading && (
        <ElapsedReadout placement={placement} text={`${formatTime(currentTime)} / ${formatTime(duration)}`} />
      )}
      {!placement && savedClip && <div className="mt-1.5 text-center">{savedClip}</div>}
    </div>
  );
}

/**
 * Play or pause, restart and mute: 36px round buttons with 16px icons, or on
 * the stage buttons `size` tall with the framework's icons at the stage's scale.
 */
function AudioButtons({
  size,
  scale,
  isPlaying,
  isMuted,
  onPlayPause,
  onRewind,
  onMuteToggle,
}: {
  size?: number;
  scale?: number;
  isPlaying: boolean;
  isMuted: boolean;
  onPlayPause: () => void;
  onRewind: () => void;
  onMuteToggle: () => void;
}) {
  const { t } = useTranslation("editor");
  const button = {
    className: `flex items-center justify-center rounded-full bg-charcoal/10 hover:bg-charcoal/20 text-charcoal transition-colors${size ? "" : " w-9 h-9"}`,
    style: size ? { width: size, height: size } : undefined,
  };
  const play = scale ? AUDIO_PLAY_ICON * scale : 16;
  const other = scale ? AUDIO_CONTROL_ICON * scale : 16;
  return (
    <>
      <button type="button" onClick={onPlayPause} {...button} aria-label={isPlaying ? t("media.pause_aria") : t("media.play_aria")}>
        {isPlaying ? <Pause size={play} /> : <Play size={play} className="ml-0.5" />}
      </button>
      <button type="button" onClick={onRewind} {...button} aria-label={t("media.restart_clip_aria")}>
        <RotateCcw size={other} />
      </button>
      <button type="button" onClick={onMuteToggle} {...button} aria-label={isMuted ? t("media.unmute_aria") : t("media.mute_aria")}>
        {isMuted ? <VolumeX size={other} /> : <Volume2 size={other} />}
      </button>
    </>
  );
}

/**
 * The saved clip on the stage. The framework has no such readout; the
 * editor's sits at the controls row's left edge, clear of the playing time at
 * its right and of the centred buttons.
 */
function SavedClipReadout({ row, children }: { row: Box; children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div
      data-testid="audio-saved-clip"
      className="absolute flex items-center pointer-events-none"
      style={{ left: row.x, top: row.y, height: row.h }}
    >
      {children}
    </div>
  );
}

/** The playing time on the stage, as the framework's `.audio-elapsed` pill, at the stage's scale. */
function ElapsedReadout({ placement, text }: { placement: { elapsed: { right: number; bottom: number }; scale: number }; text: string }) {
  const k = placement.scale;
  return (
    <span
      data-testid="audio-elapsed"
      className="absolute pointer-events-none bg-white/60 text-black/70 backdrop-blur-sm"
      style={{
        right: placement.elapsed.right,
        bottom: placement.elapsed.bottom,
        fontSize: AUDIO_ELAPSED.fontSize * k,
        padding: `${AUDIO_ELAPSED.paddingY * k}px ${AUDIO_ELAPSED.paddingX * k}px`,
        borderRadius: AUDIO_ELAPSED.radius * k,
      }}
    >
      {text}
    </span>
  );
}
