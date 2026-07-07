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
 * @version v1.4.0-beta
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, RotateCcw, Volume2, VolumeX } from "lucide-react";

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
}

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
          height: 80,
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

  return (
    <div className="w-full">
    <div className="rounded-lg bg-anil overflow-hidden">
      {/* Waveform area */}
      <div className="px-4 pt-4 pb-2">
        {isLoading && (
          <div className="h-20 flex items-center justify-center">
            <p className="font-body text-sm text-charcoal/50">
              {t("media.audio_loading")}
            </p>
          </div>
        )}
        <div ref={containerRef} className={isLoading ? "invisible h-0" : "w-full"} />
      </div>

      {/* Controls bar */}
      {!isLoading && !hasError && (
        <div className="flex items-center justify-between px-4 pb-3">
          {/* Time counter — left */}
          <span className="font-mono text-xs text-charcoal/60">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          {/* Buttons — right */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handlePlayPause}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-charcoal/10 hover:bg-charcoal/20 text-charcoal transition-colors"
              aria-label={isPlaying ? t("media.pause_aria") : t("media.play_aria")}
            >
              {isPlaying ? (
                <Pause className="w-4 h-4" />
              ) : (
                <Play className="w-4 h-4 ml-0.5" />
              )}
            </button>
            <button
              type="button"
              onClick={handleRewind}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-charcoal/10 hover:bg-charcoal/20 text-charcoal transition-colors"
              aria-label={t("media.restart_clip_aria")}
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleMuteToggle}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-charcoal/10 hover:bg-charcoal/20 text-charcoal transition-colors"
              aria-label={isMuted ? t("media.unmute_aria") : t("media.mute_aria")}
            >
              {isMuted ? (
                <VolumeX className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
    {/* Saved clip indicator — below the player */}
    {shouldShowRegion && (saved || showSavedMsg) && (
      <div className="mt-1.5 text-center">
        <span className={`font-mono text-xs text-qolle-deep transition-opacity ${showSavedMsg ? "opacity-100" : "opacity-70"}`}>
          {formatTime(regionStart)} → {formatTime(regionEnd)}
          {showSavedMsg && (
            <span className="ml-2 font-body text-[10px] uppercase tracking-wider">
              ✓ Clip saved
            </span>
          )}
        </span>
      </div>
    )}
    </div>
  );
}
