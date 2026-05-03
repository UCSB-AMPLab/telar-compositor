/**
 * Media type detection utility for Telar Compositor.
 *
 * Provides URL-based media type detection, video ID extraction, and
 * time format conversion helpers. Ported from the Telar framework's
 * card-type.js regex patterns.
 *
 * Used by the story editor to render the correct player/viewer component
 * for each step based on the object's source URL or file extension.
 */

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

const YOUTUBE_RE =
  /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

const VIMEO_RE = /vimeo\.com\/(?:video\/)?(\d+)(?:\/([a-zA-Z0-9]+))?/;

const GDRIVE_RE = /drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]+)/;

const AUDIO_FILE_RE = /\.(mp3|ogg|m4a)$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaType = "iiif" | "youtube" | "vimeo" | "google-drive" | "audio" | "text-only";

// ---------------------------------------------------------------------------
// detectMediaType
// ---------------------------------------------------------------------------

/**
 * Detects the media type of a story step based on source URL and/or object ID.
 *
 * Priority order:
 *   1. YouTube (source URL matches YouTube pattern)
 *   2. Vimeo (source URL matches Vimeo pattern)
 *   3. Google Drive (source URL matches Drive pattern)
 *   4. Audio (object ID ends with .mp3, .ogg, or .m4a)
 *   5. Text-only (no source URL and no object ID)
 *   6. IIIF (default — object ID is a static image or manifest URL)
 *
 * @param sourceUrl - The object's source_url field (external video/audio URL)
 * @param objectId - The object's object_id field (local image filename or IIIF ID)
 */
export function detectMediaType(
  sourceUrl?: string | null,
  objectId?: string | null,
): MediaType {
  // Check video platforms (sourceUrl only)
  if (sourceUrl) {
    if (YOUTUBE_RE.test(sourceUrl)) return "youtube";
    if (VIMEO_RE.test(sourceUrl)) return "vimeo";
    if (GDRIVE_RE.test(sourceUrl)) return "google-drive";
    if (AUDIO_FILE_RE.test(sourceUrl)) return "audio";
  }

  // Check audio by objectId (e.g. "recording.mp3") — covers both
  // cases: sourceUrl absent, or sourceUrl is a non-audio URL
  if (objectId && AUDIO_FILE_RE.test(objectId)) return "audio";

  // No inputs at all → text-only step
  if (!sourceUrl && !objectId) return "text-only";

  // Default: IIIF image (self-hosted or external manifest)
  return "iiif";
}

// ---------------------------------------------------------------------------
// extractVideoId
// ---------------------------------------------------------------------------

/**
 * Extracts the platform-specific video or file ID from a URL.
 *
 * Returns the capture group from the corresponding regex, or null if no
 * match is found.
 *
 * @param type - The media type (youtube | vimeo | google-drive)
 * @param sourceUrl - The full URL to extract from
 */
export function extractVideoId(
  type: "youtube" | "vimeo" | "google-drive",
  sourceUrl: string,
): string | null {
  let match: RegExpMatchArray | null = null;

  if (type === "youtube") {
    match = sourceUrl.match(YOUTUBE_RE);
  } else if (type === "vimeo") {
    match = sourceUrl.match(VIMEO_RE);
  } else if (type === "google-drive") {
    match = sourceUrl.match(GDRIVE_RE);
  }

  return match ? match[1] : null;
}

/**
 * Extracts the Vimeo privacy hash from a URL like vimeo.com/123456/abcdef.
 * Returns null if no hash is present (public video).
 */
export function extractVimeoHash(sourceUrl: string): string | null {
  const match = sourceUrl.match(VIMEO_RE);
  return match?.[2] ?? null;
}

// ---------------------------------------------------------------------------
// Time conversion helpers
// ---------------------------------------------------------------------------

/**
 * Converts a duration in seconds to mm:ss string format.
 *
 * Fractional seconds are truncated (floor). Seconds are zero-padded to 2
 * digits. Minutes are not padded.
 *
 * Examples: 72 → "1:12", 0 → "0:00", 125.7 → "2:05"
 */
export function secondsToMmss(s: number): string {
  const minutes = Math.floor(s / 60);
  const seconds = Math.floor(s % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Converts a mm:ss string to total seconds.
 *
 * Examples: "1:12" → 72, "0:00" → 0, "2:05" → 125
 */
export function mmssToSeconds(s: string): number {
  const [minutes, seconds] = s.split(":").map(Number);
  return minutes * 60 + seconds;
}
