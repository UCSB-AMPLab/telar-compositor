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
 */

import { useEffect, useState } from "react";

interface IiifSize {
  width: number;
  height: number;
}

/**
 * Pick the best thumbnail size from the available sizes array.
 * Returns the smallest size >= minWidth, or the largest available.
 */
function pickThumbnailSize(
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

        const sizes = (info.sizes ?? []) as IiifSize[];
        const baseUrl = ((info.id ?? info["@id"]) as string) || undefined;
        if (!baseUrl) return;

        const size = pickThumbnailSize(sizes, minWidth);
        if (size && !cancelled) {
          setThumbnailUrl(
            `${baseUrl}/full/${size.width},${size.height}/0/default.jpg`
          );
        }
      } catch {
        // Tiles not available yet — leave null
      }
    }

    resolve();
    return () => { cancelled = true; };
  }, [infoJsonUrl, minWidth]);

  return thumbnailUrl;
}
