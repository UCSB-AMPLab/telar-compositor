/**
 * StageMedia — where a video or audio step's media goes on the framing stage,
 * from framing-stage.ts's media functions, in stage pixels.
 *
 * The embed fills the box the page gives the video's player: at the video's
 * own aspect where that is known, at 16:9 until it is, and the whole region
 * where it never will be (`video-aspect.ts`); the provider letterboxes the
 * video inside it. An audio step's waveform takes the page's waveform box, and with
 * the scene's card below its player the waveform, the controls row and the
 * playing time each take their own box (`audioBelowLayout`).
 *
 * Without a stage the media fill the column, as they did before it.
 *
 * @version v1.5.0-beta
 */

import type { ReactNode } from "react";
import {
  audioBelowLayout,
  audioControlsBelowBox,
  audioElapsedBelowAnchor,
  audioWaveformBox,
  regionOf,
  mediaTopBand,
  videoLayout,
  videoLetterboxRegion,
  type Box,
  type MediaBelow,
  type MediaKind,
} from "~/lib/framing-stage";
import { STAGE_Z, stageBox } from "~/components/features/editor/FramingStage";
import type { StageGeometry } from "~/hooks/use-stage-geometry";
import type { VideoAspect } from "~/lib/video-aspect";

/** The aspect a video is placed at until its own is known. */
const UNKNOWN_ASPECT = 16 / 9;

export interface AudioPlacement {
  wave: Box;
  controls: Box;
  elapsed: { right: number; bottom: number };
  scale: number;
}

export interface StageMediaBoxes {
  /** The region the controls sit on. */
  region: Box | null;
  video: Box | null;
  waveform: Box | null;
  audio: AudioPlacement | undefined;
}

/** The stage's media boxes for a step, or none without a stage. */
export function stageMediaBoxes(
  stage: StageGeometry | null,
  below: MediaBelow | null,
  media: boolean,
  video: VideoAspect | null = null,
): StageMediaBoxes {
  if (!stage) return { region: null, video: null, waveform: null, audio: undefined };
  const { layout, window: win } = stage;
  const s = stage.stage.scale;
  const audioBelow = below && layout.mode === "horizontal" ? below : null;
  const waveform = stageBox(
    audioBelow ? audioBelowLayout(win.w, win.h, audioBelow).wave : audioWaveformBox(layout.mode, win.w, win.h),
    s,
  );
  return {
    region: stageBox(regionOf(layout, win.w, win.h, { media, below }), s),
    video: stageBox(videoPlayerBox(layout.mode, win, video, below), s),
    waveform,
    audio: audioBelowPlacement(win, audioBelow, waveform, s),
  };
}

/** The video player's box in stage units: the letterbox region, or the player laid out for its aspect. */
function videoPlayerBox(
  mode: StageGeometry["layout"]["mode"],
  win: StageGeometry["window"],
  video: VideoAspect | null,
  below: MediaBelow | null,
) {
  const band = mediaTopBand(win.w, win.h);
  if (video?.letterbox) return videoLetterboxRegion(mode, win.w, win.h, below, band);
  return videoLayout(mode, win.w, win.h, video?.aspect ?? UNKNOWN_ASPECT, below, band).player;
}

/**
 * The lowest edge of a scene's player with its card below it, in visitor
 * pixels: the video's box as the stage draws it, or the audio controls row
 * under the waveform. None where the card is not below a player.
 */
export function playerBottomBelow(
  win: StageGeometry["window"],
  below: MediaBelow | null,
  kind: MediaKind | null,
  video: VideoAspect | null,
): number | undefined {
  if (!below || !kind) return undefined;
  const box = kind === "audio" ? audioControlsBelowBox(win.w, win.h, below) : videoPlayerBox("horizontal", win, video, below);
  return box.y + box.h;
}

/** The audio parts with the card below the stage, or none when the card is not below. */
function audioBelowPlacement(
  win: StageGeometry["window"],
  audioBelow: MediaBelow | null,
  waveform: Box,
  s: number,
): AudioPlacement | undefined {
  const elapsed = audioBelow && audioElapsedBelowAnchor(win.w, win.h, audioBelow);
  if (!audioBelow || !elapsed) return undefined;
  return {
    wave: waveform,
    controls: stageBox(audioControlsBelowBox(win.w, win.h, audioBelow), s),
    elapsed: { right: elapsed.right * s, bottom: elapsed.bottom * s },
    scale: s,
  };
}

/** The embed at its box, or centred in the column without a stage. */
export function StageVideo({ box, children }: { box: Box | null; children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col bg-black" style={{ zIndex: STAGE_Z.image }}>
      <div
        className={box ? "absolute" : "flex-1 flex items-center justify-center"}
        style={box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined}
      >
        <div className={box ? "w-full h-full" : "w-full"}>{children}</div>
      </div>
    </div>
  );
}

/**
 * The audio player at the waveform's box, centred on it; with the card below,
 * over the stage, where the player places its parts itself; centred in the
 * column without a stage.
 */
export function StageAudio({
  waveform,
  placement,
  children,
}: {
  waveform: Box | null;
  placement: AudioPlacement | undefined;
  children: ReactNode;
}) {
  if (placement) {
    return (
      <div className="absolute inset-0" style={{ zIndex: STAGE_Z.image }}>
        <div className="contents">{children}</div>
      </div>
    );
  }
  return (
    <div
      className={waveform ? "absolute" : "absolute inset-0 flex items-center justify-center p-6"}
      style={
        waveform
          ? { left: waveform.x, width: waveform.w, top: waveform.y + waveform.h / 2, transform: "translateY(-50%)", zIndex: STAGE_Z.image }
          : { zIndex: STAGE_Z.image }
      }
    >
      <div className={waveform ? "w-full" : "w-full max-w-2xl"}>{children}</div>
    </div>
  );
}
