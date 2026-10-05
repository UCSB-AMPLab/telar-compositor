/**
 * useIiifThumbnail — client-side hook to resolve a thumbnail URL from
 * an IIIF info.json endpoint.
 *
 * For Level 0 servers (self-hosted tiles), you can't request arbitrary
 * sizes — you must pick from the pre-generated sizes in info.json.
 * This hook fetches info.json, picks the best available size, and
 * returns the constructed thumbnail URL.
 *
 * Matches Telar's pickThumbnailSize logic:
 *   smallest size >= minWidth, or the largest available.
 *
 * `thumbnailUrlFromInfo` is the same choice as a pure function over an
 * already-fetched info.json, for callers that do their own fetching (the page
 * chooser fetches per tile only as tiles are rendered). A level-0 image server
 * answers only the sizes it declares, so a URL is only ever built from a size
 * the source offered.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useState } from "react";

interface IiifSize {
  width: number;
  height: number;
}

/**
 * Pick the best thumbnail size from the available sizes array.
 * Returns the smallest size >= minWidth, or the largest available.
 *
 * Exported for `app/lib/iiif-pages.ts`, which derives a thumbnail from a
 * manifest body's image service sizes using the same choice.
 */
export function pickThumbnailSize(
  sizes: IiifSize[],
  minWidth = 150
): IiifSize | null {
  if (sizes.length === 0) return null;

  // Sort by width ascending
  const sorted = [...sizes].sort((a, b) => a.width - b.width);

  // Find smallest >= minWidth
  const fit = sorted.find((s) => s.width >= minWidth);
  if (fit) return fit;

  // Otherwise use the largest available
  return sorted[sorted.length - 1];
}

/**
 * Build a thumbnail URL from an already-fetched info.json body. Returns null
 * when the document declares no sizes or names no base URL. A declared size
 * names both dimensions, which Image API v2 and v3 both accept in the `w,h`
 * size form.
 */
export function thumbnailUrlFromInfo(
  info: Record<string, unknown>,
  minWidth = 150
): string | null {
  const sizes = Array.isArray(info.sizes) ? (info.sizes as IiifSize[]) : [];
  const baseUrl = (info.id ?? info["@id"]) as string | undefined;
  if (!baseUrl || typeof baseUrl !== "string") return null;
  const size = pickThumbnailSize(sizes, minWidth);
  if (!size) return null;
  return `${baseUrl}/full/${size.width},${size.height}/0/default.jpg`;
}

export function useIiifThumbnail(
  infoJsonUrl: string | null,
  minWidth = 150
): string | null {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!infoJsonUrl) return;

    let cancelled = false;

    async function resolve() {
      try {
        const res = await fetch(infoJsonUrl!);
        if (!res.ok || cancelled) return;
        const info = (await res.json()) as Record<string, unknown>;

        const url = thumbnailUrlFromInfo(info, minWidth);
        if (url && !cancelled) setThumbnailUrl(url);
      } catch {
        // Tiles not available yet — leave null
      }
    }

    resolve();
    return () => { cancelled = true; };
  }, [infoJsonUrl, minWidth]);

  return thumbnailUrl;
}
