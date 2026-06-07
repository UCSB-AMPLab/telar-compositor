/**
 * ClipTimeline — draggable clip range bar for video steps.
 *
 * Renders a thin horizontal timeline showing the full duration with a
 * highlighted draggable region for clip start/end. Handles can be dragged
 * to adjust the clip range. A playback indicator shows current position.
 *
 * Anil background, qolle highlight for the clip region, terracotta
 * for the playback indicator.
 */

import { useRef, useState, useCallback, useEffect } from "react";

interface ClipTimelineProps {
  /** Total video duration in seconds */
  duration: number;
  /** Current playback position in seconds */
  currentTime: number;
  /** Clip start in seconds */
  clipStart: number;
  /** Clip end in seconds */
  clipEnd: number;
  /** Called when clip range changes (from handle drag) */
  onClipChange: (start: number, end: number) => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ClipTimeline({
  duration,
  currentTime,
  clipStart,
  clipEnd,
  onClipChange,
}: ClipTimelineProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | "region" | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [localStart, setLocalStart] = useState(clipStart);
  const [localEnd, setLocalEnd] = useState(clipEnd);
  const [saved, setSaved] = useState(!!(clipStart || clipEnd));
  const [showSaved, setShowSaved] = useState(false);

  // Sync from props when not dragging
  useEffect(() => {
    if (!dragging) {
      setLocalStart(clipStart);
      setLocalEnd(clipEnd);
    }
  }, [clipStart, clipEnd, dragging]);

  const toPercent = useCallback(
    (seconds: number) => (duration > 0 ? (seconds / duration) * 100 : 0),
    [duration],
  );

  const toSeconds = useCallback(
    (clientX: number) => {
      if (!barRef.current || duration <= 0) return 0;
      const rect = barRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, handle: "start" | "end" | "region") => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(handle);
      if (handle === "region") {
        const sec = toSeconds(e.clientX);
        setDragOffset(sec - localStart);
      }
    },
    [toSeconds, localStart],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const sec = toSeconds(e.clientX);

      if (dragging === "start") {
        const newStart = Math.max(0, Math.min(sec, localEnd - 0.5));
        setLocalStart(newStart);
      } else if (dragging === "end") {
        const newEnd = Math.min(duration, Math.max(sec, localStart + 0.5));
        setLocalEnd(newEnd);
      } else if (dragging === "region") {
        const regionLen = localEnd - localStart;
        let newStart = sec - dragOffset;
        newStart = Math.max(0, Math.min(newStart, duration - regionLen));
        setLocalStart(newStart);
        setLocalEnd(newStart + regionLen);
      }
    },
    [dragging, toSeconds, localStart, localEnd, duration, dragOffset],
  );

  const handlePointerUp = useCallback(() => {
    if (dragging) {
      setDragging(null);
      onClipChange(localStart, localEnd);
      setSaved(true);
      setShowSaved(true);
      setTimeout(() => setShowSaved(false), 2000);
    }
  }, [dragging, localStart, localEnd, onClipChange]);

  const startPct = toPercent(localStart);
  const endPct = toPercent(localEnd);
  const playPct = toPercent(currentTime);
  const hasClip = localStart > 0 || localEnd < duration;

  return (
    <div className="w-full">
      {/* Timeline bar */}
      <div
        ref={barRef}
        className="relative w-full h-8 bg-anil rounded-md cursor-crosshair select-none touch-none"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* Clip region highlight */}
        <div
          className={`absolute top-0 h-full rounded-sm cursor-grab active:cursor-grabbing ${
            saved ? "bg-qolle/30" : "bg-charcoal/10"
          }`}
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
          onPointerDown={(e) => handlePointerDown(e, "region")}
        />

        {/* Start handle */}
        <div
          className={`absolute top-0 h-full w-1.5 cursor-col-resize rounded-l-sm ${
            saved ? "bg-qolle" : "bg-charcoal/40"
          }`}
          style={{ left: `${startPct}%` }}
          onPointerDown={(e) => handlePointerDown(e, "start")}
        />

        {/* End handle */}
        <div
          className={`absolute top-0 h-full w-1.5 cursor-col-resize rounded-r-sm ${
            saved ? "bg-qolle" : "bg-charcoal/40"
          }`}
          style={{ left: `calc(${endPct}% - 6px)` }}
          onPointerDown={(e) => handlePointerDown(e, "end")}
        />

        {/* Playback indicator */}
        <div
          className="absolute top-0 h-full w-0.5 bg-terracotta pointer-events-none"
          style={{ left: `${playPct}%` }}
        />
      </div>

      {/* Time labels below */}
      <div className="flex items-center justify-between mt-1">
        <span className={`font-mono text-xs ${saved ? "text-qolle-deep" : "text-charcoal/50"}`}>
          {formatTime(localStart)}
        </span>
        {showSaved && (
          <span className="font-mono text-xs text-qolle-deep">
            ✓ Clip saved
          </span>
        )}
        {!showSaved && hasClip && (
          <span className="font-mono text-xs text-charcoal/40">
            {formatTime(localEnd - localStart)} clip
          </span>
        )}
        <span className={`font-mono text-xs ${saved ? "text-qolle-deep" : "text-charcoal/50"}`}>
          {formatTime(localEnd)}
        </span>
      </div>
    </div>
  );
}
