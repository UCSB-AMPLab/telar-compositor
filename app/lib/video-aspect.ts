/**
 * video-aspect — the shape of a video, found as the published page finds it,
 * so the framing stage arranges a video step as the site does.
 *
 * The framework (`video-card.js`) learns a video's aspect three ways. A YouTube
 * video's is read from its `maxresdefault.jpg` thumbnail, the only signal that
 * reflects the source: it is trusted only at 320×180 or larger, since YouTube
 * serves a small grey placeholder where none exists. A Vimeo video's is what
 * its player reports once ready (`getVideoWidth`, `getVideoHeight`). A Google
 * Drive video's is unknowable. Until it is known, a video is placed and
 * compared at 16:9; where it never will be (Google Drive, a YouTube video with
 * no full-size thumbnail) the player takes the whole region and the provider
 * letterboxes the video inside it.
 *
 * @version v1.5.0-beta
 */

export type VideoProvider = "youtube" | "vimeo" | "google-drive";

/** What the stage knows of a video's shape: its aspect, or that it takes the whole region. */
export interface VideoAspect {
  /** Width over height; null while unknown, and where it never will be. */
  aspect: number | null;
  /** The player takes the whole region and the provider letterboxes (`videoLetterboxRegion`). */
  letterbox: boolean;
}

/**
 * `detectYouTubeAspect`: the aspect of a YouTube video's full-size thumbnail,
 * or null where it is missing or is the placeholder.
 */
export function detectYouTubeAspect(videoId: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve(img.naturalWidth >= 320 && img.naturalHeight >= 180 ? img.naturalWidth / img.naturalHeight : null);
    img.onerror = () => resolve(null);
    img.src = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  });
}

/**
 * The shape the page holds for a video of `provider`, given what has been
 * learned of it: undefined before the probe or the player has answered, a
 * number for an aspect, null for a probe that found none.
 */
export function videoAspectOf(provider: VideoProvider, learned: number | null | undefined): VideoAspect {
  if (provider === "google-drive") return { aspect: null, letterbox: true };
  if (provider === "youtube") {
    if (learned === undefined) return { aspect: null, letterbox: false };
    return learned ? { aspect: learned, letterbox: false } : { aspect: null, letterbox: true };
  }
  return { aspect: learned || null, letterbox: false };
}
