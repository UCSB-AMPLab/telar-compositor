/**
 * Shared IIIF types and pure utilities used by both client and server code.
 *
 * Server-only code (fetch, parse) stays in iiif.server.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Normalised metadata extracted from an IIIF manifest */
export interface IiifMetadata {
  title: string | null;
  creator: string | null;
  description: string | null;
  thumbnail: string | null;
  source: string | null;
  credit: string | null;
  period: string | null;
  object_type: string | null;
  image_available: boolean;
}

/** Discriminated union returned by fetchAndParseManifest */
export type IiifFetchResult =
  | { ok: true; metadata: IiifMetadata }
  | { ok: false; error: "fetch_failed" | "not_iiif" | "parse_error" };

/** Minimal object shape required by deriveStatus */
interface ObjectStatusInput {
  title: string | null | undefined;
  image_available: boolean | null | undefined;
  missing_from_repo: boolean | null | undefined;
  /** When true, skip the image_available check (video/audio don't need tiles) */
  skipImageCheck?: boolean;
}

// ---------------------------------------------------------------------------
// deriveStatus
// ---------------------------------------------------------------------------

/**
 * Derives an object's display status from its DB fields.
 *
 * Priority order:
 *   1. missing_from_repo → "missing_from_repo"
 *   2. title absent      → "no_metadata"
 *   3. image absent (IIIF only) → "image_missing"
 *   4. all present       → "ready"
 */
export function deriveStatus(
  obj: ObjectStatusInput
): "ready" | "no_metadata" | "image_missing" | "missing_from_repo" {
  if (obj.missing_from_repo) return "missing_from_repo";
  if (!obj.title) return "no_metadata";
  if (!obj.skipImageCheck && !obj.image_available) return "image_missing";
  return "ready";
}
