/**
 * VideoEmbed — embedded video player for YouTube, Vimeo, and Google Drive.
 *
 * Renders an iframe with the correct embed URL for each platform. For YouTube
 * and Vimeo, loads the platform's JS API in a once-guard pattern and exposes
 * getCurrentTimeRef so the parent can capture clip start/end times.
 *
 * Google Drive does not expose a player API; getCurrentTimeRef is set to null,
 * which causes the parent to fall back to the manual MM:SS input.
 */

import { useRef, useEffect } from "react";

// ---------------------------------------------------------------------------
// YouTube IFrame API types (minimal)
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    YT: {
      Player: new (
        el: HTMLIFrameElement,
        options: { events: { onReady: (event: { target: YTPlayer }) => void } }
      ) => YTPlayer;
      PlayerState: Record<string, number>;
    };
    onYouTubeIframeAPIReady: () => void;
    _ytApiPromise?: Promise<void>;
  }
}

interface YTPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VideoPlayerControls {
  seekTo: (seconds: number) => void;
  play: () => void;
  pause: () => void;
}

interface VideoEmbedProps {
  type: "youtube" | "vimeo" | "google-drive";
  videoId: string;
  /** Vimeo privacy hash for unlisted videos */
  vimeoHash?: string | null;
  getCurrentTimeRef?: React.MutableRefObject<(() => Promise<number>) | null>;
  getDurationRef?: React.MutableRefObject<(() => Promise<number>) | null>;
  playerControlsRef?: React.MutableRefObject<VideoPlayerControls | null>;
  onTimeUpdate?: (time: number) => void;
}

// ---------------------------------------------------------------------------
// YouTube API once-guard
// ---------------------------------------------------------------------------

function loadYouTubeApi(): Promise<void> {
  if (window._ytApiPromise) return window._ytApiPromise;

  window._ytApiPromise = new Promise<void>((resolve) => {
    if (window.YT?.Player) {
      resolve();
      return;
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prev) prev();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });

  return window._ytApiPromise;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VideoEmbed({ type, videoId, vimeoHash, getCurrentTimeRef, getDurationRef, playerControlsRef, onTimeUpdate }: VideoEmbedProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Build the embed URL for each platform
  let src: string;
  if (type === "youtube") {
    // Deliberately no `window.location.origin` here: it resolves differently
    // during SSR vs the client, which would mismatch the iframe `src` on
    // hydration and trip React #418. The `origin` param is only an optional
    // postMessage hardening — the JS API (enablejsapi) works without it.
    src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
  } else if (type === "vimeo") {
    src = `https://player.vimeo.com/video/${videoId}?api=1${vimeoHash ? `&h=${vimeoHash}` : ""}`;
  } else {
    src = `https://drive.google.com/file/d/${videoId}/preview`;
  }

  // YouTube: load IFrame API and wire getCurrentTime, getDuration, timeUpdate polling
  useEffect(() => {
    if (type !== "youtube") return;

    let player: YTPlayer | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    loadYouTubeApi().then(() => {
      if (!iframeRef.current) return;
      player = new window.YT.Player(iframeRef.current, {
        events: {
          onReady: (event) => {
            if (getCurrentTimeRef) {
              getCurrentTimeRef.current = async () => event.target.getCurrentTime();
            }
            if (getDurationRef) {
              getDurationRef.current = async () => event.target.getDuration();
            }
            if (playerControlsRef) {
              playerControlsRef.current = {
                seekTo: (s) => event.target.seekTo(s, true),
                play: () => event.target.playVideo(),
                pause: () => event.target.pauseVideo(),
              };
            }
            if (onTimeUpdate) {
              pollInterval = setInterval(() => {
                try {
                  const t = event.target.getCurrentTime();
                  onTimeUpdate(t);
                } catch { /* player may be destroyed */ }
              }, 250);
            }
          },
        },
      });
    });

    return () => {
      if (getCurrentTimeRef) getCurrentTimeRef.current = null;
      if (getDurationRef) getDurationRef.current = null;
      if (playerControlsRef) playerControlsRef.current = null;
      if (pollInterval) clearInterval(pollInterval);
      player?.destroy();
    };
  }, [type, videoId, getCurrentTimeRef, getDurationRef, playerControlsRef, onTimeUpdate]);

  // Vimeo: dynamically import SDK and wire getCurrentTime, getDuration, timeUpdate
  useEffect(() => {
    if (type !== "vimeo") return;

    let cancelled = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    import("@vimeo/player").then(({ default: Player }) => {
      if (cancelled || !iframeRef.current) return;
      const player = new Player(iframeRef.current);
      if (getCurrentTimeRef) {
        getCurrentTimeRef.current = () => player.getCurrentTime();
      }
      if (getDurationRef) {
        getDurationRef.current = () => player.getDuration();
      }
      if (playerControlsRef) {
        playerControlsRef.current = {
          seekTo: (s) => { player.setCurrentTime(s); },
          play: () => { player.play(); },
          pause: () => { player.pause(); },
        };
      }
      if (onTimeUpdate) {
        pollInterval = setInterval(async () => {
          try {
            const t = await player.getCurrentTime();
            onTimeUpdate(t);
          } catch { /* player may be destroyed */ }
        }, 250);
      }
    });

    return () => {
      cancelled = true;
      if (getCurrentTimeRef) getCurrentTimeRef.current = null;
      if (getDurationRef) getDurationRef.current = null;
      if (playerControlsRef) playerControlsRef.current = null;
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [type, videoId, getCurrentTimeRef, getDurationRef, onTimeUpdate]);

  // Google Drive: no API available
  useEffect(() => {
    if (type !== "google-drive") return;
    if (getCurrentTimeRef) getCurrentTimeRef.current = null;
  }, [type, getCurrentTimeRef]);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      className="w-full aspect-video rounded-sm video-embed-iframe"
      allow="autoplay; encrypted-media"
      allowFullScreen
      title={`${type} video player`}
    />
  );
}
