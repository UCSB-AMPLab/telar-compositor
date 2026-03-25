/**
 * Unit tests for media-type.ts — media type detection utility.
 *
 * Tests cover:
 *   - detectMediaType: YouTube, Vimeo, Google Drive, audio, IIIF, text-only
 *   - extractVideoId: YouTube, Vimeo, Google Drive ID extraction
 *   - secondsToMmss: seconds to mm:ss string conversion
 *   - mmssToSeconds: mm:ss string to seconds conversion
 */
import { describe, it, expect } from "vitest";
import {
  detectMediaType,
  extractVideoId,
  secondsToMmss,
  mmssToSeconds,
} from "~/lib/media-type";

// ---------------------------------------------------------------------------
// detectMediaType
// ---------------------------------------------------------------------------

describe("detectMediaType", () => {
  it("returns 'youtube' for a standard YouTube watch URL", () => {
    expect(detectMediaType("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
  });

  it("returns 'youtube' for a youtu.be short URL", () => {
    expect(detectMediaType("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
  });

  it("returns 'youtube' for a YouTube embed URL", () => {
    expect(detectMediaType("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("youtube");
  });

  it("returns 'vimeo' for a Vimeo URL", () => {
    expect(detectMediaType("https://vimeo.com/123456789")).toBe("vimeo");
  });

  it("returns 'vimeo' for a Vimeo player URL", () => {
    expect(detectMediaType("https://player.vimeo.com/video/123456789")).toBe("vimeo");
  });

  it("returns 'google-drive' for a Google Drive file URL", () => {
    expect(detectMediaType("https://drive.google.com/file/d/abc123/view")).toBe("google-drive");
  });

  it("returns 'audio' for an mp3 object ID", () => {
    expect(detectMediaType(null, "interview.mp3")).toBe("audio");
  });

  it("returns 'audio' for an ogg object ID", () => {
    expect(detectMediaType(null, "recording.ogg")).toBe("audio");
  });

  it("returns 'audio' for an m4a object ID", () => {
    expect(detectMediaType(null, "song.m4a")).toBe("audio");
  });

  it("returns 'iiif' for a non-video, non-audio source URL", () => {
    expect(detectMediaType("https://example.org/iiif/manifest.json")).toBe("iiif");
  });

  it("returns 'text-only' when both sourceUrl and objectId are null", () => {
    expect(detectMediaType(null, null)).toBe("text-only");
  });

  it("returns 'iiif' for a jpg object ID (image, not audio)", () => {
    expect(detectMediaType(null, "photo.jpg")).toBe("iiif");
  });
});

// ---------------------------------------------------------------------------
// extractVideoId
// ---------------------------------------------------------------------------

describe("extractVideoId", () => {
  it("extracts YouTube video ID from watch URL", () => {
    expect(extractVideoId("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts Vimeo video ID", () => {
    expect(extractVideoId("vimeo", "https://vimeo.com/123456789")).toBe("123456789");
  });

  it("extracts Google Drive file ID", () => {
    expect(extractVideoId("google-drive", "https://drive.google.com/file/d/abc123/view")).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// secondsToMmss
// ---------------------------------------------------------------------------

describe("secondsToMmss", () => {
  it("converts 72 seconds to '1:12'", () => {
    expect(secondsToMmss(72)).toBe("1:12");
  });

  it("converts 0 seconds to '0:00'", () => {
    expect(secondsToMmss(0)).toBe("0:00");
  });

  it("converts 125.7 seconds to '2:05' (truncates fractional seconds)", () => {
    expect(secondsToMmss(125.7)).toBe("2:05");
  });
});

// ---------------------------------------------------------------------------
// mmssToSeconds
// ---------------------------------------------------------------------------

describe("mmssToSeconds", () => {
  it("converts '1:12' to 72", () => {
    expect(mmssToSeconds("1:12")).toBe(72);
  });

  it("converts '0:00' to 0", () => {
    expect(mmssToSeconds("0:00")).toBe(0);
  });

  it("converts '2:05' to 125", () => {
    expect(mmssToSeconds("2:05")).toBe(125);
  });
});
