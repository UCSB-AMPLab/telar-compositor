/**
 * IIIF manifest fetch and parse utility for Telar Compositor.
 *
 * Supports IIIF Presentation API v2 and v3. Detects the version from
 * the @context field, extracts a normalised IiifMetadata shape, and
 * checks for an ImageService to determine whether IIIF tiles are available.
 *
 * Exports:
 *   fetchAndParseManifest(url) — fetches and parses a manifest URL
 *   deriveStatus(obj)          — derives object status from DB fields
 *   IiifMetadata               — normalised metadata interface
 *   IiifFetchResult            — discriminated union result type
 *   extractV2Label             — helper (exported for testing)
 *   extractV3Label             — helper (exported for testing)
 */

// ---------------------------------------------------------------------------
// Shared types and pure utilities (re-exported from iiif-types.ts for
// backwards compatibility — server consumers can import from either file)
// ---------------------------------------------------------------------------

export type { IiifMetadata, IiifFetchResult } from "./iiif-types";

import type { IiifMetadata, IiifFetchResult } from "./iiif-types";

// ---------------------------------------------------------------------------
// Label extraction helpers
// ---------------------------------------------------------------------------

type V2LabelValue =
  | string
  | Array<{ "@value": string; "@language"?: string }>;

/**
 * Extracts a plain string from a IIIF v2 label field.
 *
 * v2 labels can be:
 *   - a plain string
 *   - an array of { "@value": string, "@language": string } objects
 */
export function extractV2Label(label: V2LabelValue): string {
  if (typeof label === "string") return label;
  if (Array.isArray(label)) {
    if (label.length === 0) return "";
    return label[0]["@value"] ?? "";
  }
  return "";
}

type V3LabelMap = Record<string, string[]>;

/**
 * Extracts a plain string from a IIIF v3 language map label.
 *
 * Tries "en" first, then "none", then the first available language.
 */
export function extractV3Label(label: V3LabelMap): string {
  if (label["en"] && label["en"].length > 0) return label["en"][0];
  if (label["none"] && label["none"].length > 0) return label["none"][0];
  const keys = Object.keys(label);
  if (keys.length === 0) return "";
  return label[keys[0]][0] ?? "";
}

// ---------------------------------------------------------------------------
// Metadata array extraction
// ---------------------------------------------------------------------------

/**
 * Searches a v2 metadata array for a key (case-insensitive) and returns
 * the value as a plain string, or null if not found.
 */
function extractV2MetadataValue(
  metadata: Array<{ label: V2LabelValue; value: V2LabelValue }> | undefined,
  key: string
): string | null {
  if (!Array.isArray(metadata)) return null;
  const lowerKey = key.toLowerCase();
  for (const entry of metadata) {
    const labelText = extractV2Label(entry.label).toLowerCase();
    if (labelText === lowerKey || labelText.includes(lowerKey)) {
      return extractV2Label(entry.value) || null;
    }
  }
  return null;
}

/**
 * Searches a v3 metadata array for a key (case-insensitive) and returns
 * the value as a plain string, or null if not found.
 */
function extractV3MetadataValue(
  metadata:
    | Array<{ label: V3LabelMap; value: V3LabelMap }>
    | undefined,
  key: string
): string | null {
  if (!Array.isArray(metadata)) return null;
  const lowerKey = key.toLowerCase();
  for (const entry of metadata) {
    const labelText = extractV3Label(entry.label).toLowerCase();
    if (labelText === lowerKey || labelText.includes(lowerKey)) {
      return extractV3Label(entry.value) || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// IIIF tile detection
// ---------------------------------------------------------------------------

/** Returns true if the v2 manifest has an ImageService on the first canvas */
function hasV2IiifTiles(manifest: Record<string, unknown>): boolean {
  try {
    const sequences = manifest["sequences"] as Array<Record<string, unknown>>;
    const canvas = (sequences[0]["canvases"] as Array<Record<string, unknown>>)[0];
    const image = (canvas["images"] as Array<Record<string, unknown>>)[0];
    const resource = image["resource"] as Record<string, unknown>;
    return !!resource["service"];
  } catch {
    return false;
  }
}

/** Returns true if the v3 manifest has an ImageService on the first canvas */
function hasV3IiifTiles(manifest: Record<string, unknown>): boolean {
  try {
    const items = manifest["items"] as Array<Record<string, unknown>>;
    const annotationPages = items[0]["items"] as Array<Record<string, unknown>>;
    const annotations = annotationPages[0]["items"] as Array<Record<string, unknown>>;
    const body = annotations[0]["body"] as Record<string, unknown>;
    const services = body["service"] as Array<Record<string, unknown>>;
    return Array.isArray(services) && services.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Thumbnail extraction
// ---------------------------------------------------------------------------

function extractV2Thumbnail(manifest: Record<string, unknown>): string | null {
  // Check manifest-level thumbnail first
  const thumb = manifest["thumbnail"] as
    | { "@id": string }
    | string
    | undefined;
  if (thumb) {
    if (typeof thumb === "string") return thumb;
    if (typeof thumb === "object" && thumb["@id"]) return thumb["@id"];
  }
  // Fallback: first canvas thumbnail or image service
  const sequences = manifest["sequences"] as Array<{ canvases?: Array<Record<string, unknown>> }> | undefined;
  const canvas = sequences?.[0]?.canvases?.[0];
  if (canvas) {
    const canvasThumb = canvas["thumbnail"] as { "@id"?: string } | string | undefined;
    if (canvasThumb) {
      if (typeof canvasThumb === "string") return canvasThumb;
      if (typeof canvasThumb === "object" && canvasThumb["@id"]) return canvasThumb["@id"];
    }
    // Last resort: derive from image service
    const images = canvas["images"] as Array<{ resource?: { service?: { "@id"?: string } } }> | undefined;
    const serviceId = images?.[0]?.resource?.service?.["@id"];
    if (serviceId) return `${serviceId}/full/!400,400/0/default.jpg`;
  }
  return null;
}

function extractV3Thumbnail(manifest: Record<string, unknown>): string | null {
  const thumb = manifest["thumbnail"];
  if (!thumb) return null;
  if (Array.isArray(thumb) && thumb.length > 0) {
    const first = thumb[0] as { id?: string };
    return first.id ?? null;
  }
  if (typeof thumb === "object" && (thumb as Record<string, string>)["id"]) {
    return (thumb as Record<string, string>)["id"];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

function getIiifVersion(manifest: Record<string, unknown>): 2 | 3 | null {
  const ctx = manifest["@context"];
  if (typeof ctx === "string") {
    if (ctx.includes("/presentation/3/")) return 3;
    if (ctx.includes("/presentation/2/")) return 2;
  }
  if (Array.isArray(ctx)) {
    for (const c of ctx as string[]) {
      if (typeof c === "string") {
        if (c.includes("/presentation/3/")) return 3;
        if (c.includes("/presentation/2/")) return 2;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Fetches a URL, parses it as a IIIF v2 or v3 manifest, and returns
 * normalised IiifMetadata.
 *
 * Errors:
 *   fetch_failed — network error or non-OK HTTP response
 *   not_iiif     — response is valid JSON but has no recognised @context
 *   parse_error  — parsing failed unexpectedly after context detected
 */
export async function fetchAndParseManifest(
  url: string
): Promise<IiifFetchResult> {
  let manifest: Record<string, unknown>;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: "fetch_failed" };
    }
    manifest = (await response.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "fetch_failed" };
  }

  const version = getIiifVersion(manifest);
  if (version === null) {
    return { ok: false, error: "not_iiif" };
  }

  try {
    let metadata: IiifMetadata;

    if (version === 2) {
      const rawMetadata = manifest["metadata"] as
        | Array<{ label: V2LabelValue; value: V2LabelValue }>
        | undefined;

      // Credit: metadata fields first, then attribution with boilerplate check
      let v2Credit =
        extractV2MetadataValue(rawMetadata, "credit") ??
        extractV2MetadataValue(rawMetadata, "credit line");

      if (!v2Credit) {
        const attribution = typeof manifest["attribution"] === "string"
          ? manifest["attribution"] as string
          : null;
        if (attribution && !isLegalBoilerplate(attribution)) {
          v2Credit = attribution;
        }
      }

      if (!v2Credit) {
        v2Credit =
          extractV2MetadataValue(rawMetadata, "repository") ??
          extractV2MetadataValue(rawMetadata, "institution");
      }

      metadata = {
        title: extractV2Label(manifest["label"] as V2LabelValue) || null,
        creator:
          extractV2MetadataValue(rawMetadata, "creator") ??
          extractV2MetadataValue(rawMetadata, "artist") ??
          extractV2MetadataValue(rawMetadata, "author") ??
          extractV2MetadataValue(rawMetadata, "maker") ??
          extractV2MetadataValue(rawMetadata, "contributor"),
        description: extractV2MetadataValue(rawMetadata, "description"),
        thumbnail: extractV2Thumbnail(manifest),
        source:
          extractV2MetadataValue(rawMetadata, "repository") ??
          extractV2MetadataValue(rawMetadata, "holding institution") ??
          extractV2MetadataValue(rawMetadata, "institution") ??
          extractV2MetadataValue(rawMetadata, "source"),
        credit: v2Credit,
        period:
          extractV2MetadataValue(rawMetadata, "date") ??
          extractV2MetadataValue(rawMetadata, "period") ??
          extractV2MetadataValue(rawMetadata, "creation date") ??
          extractV2MetadataValue(rawMetadata, "temporal"),
        object_type:
          extractV2MetadataValue(rawMetadata, "medium") ??
          extractV2MetadataValue(rawMetadata, "type"),
        image_available: hasV2IiifTiles(manifest),
      };
    } else {
      const rawMetadata = manifest["metadata"] as
        | Array<{ label: V3LabelMap; value: V3LabelMap }>
        | undefined;

      // --- Credit extraction (matches Telar's extract_credit logic) ---
      // 1. Try metadata fields first (most specific)
      let credit =
        extractV3MetadataValue(rawMetadata, "credit") ??
        extractV3MetadataValue(rawMetadata, "credit line");

      // 2. Try requiredStatement
      if (!credit) {
        const reqStatement = manifest["requiredStatement"] as
          | { label: V3LabelMap; value: V3LabelMap }
          | undefined;
        if (reqStatement) {
          const reqValue = extractV3Label(reqStatement.value);
          // Skip if it's legal boilerplate (URLs, rights statements, etc.)
          if (reqValue && !isLegalBoilerplate(reqValue)) {
            credit = reqValue;
          }
        }
      }

      // 3. Try provider.label as fallback (institution name)
      if (!credit) {
        const providers = manifest["provider"] as
          | Array<{ label: V3LabelMap }>
          | undefined;
        if (providers?.[0]?.label) {
          credit = extractV3Label(providers[0].label) || null;
        }
      }

      // --- Source/location (repository/institution) ---
      let source =
        extractV3MetadataValue(rawMetadata, "repository") ??
        extractV3MetadataValue(rawMetadata, "holding institution") ??
        extractV3MetadataValue(rawMetadata, "institution") ??
        extractV3MetadataValue(rawMetadata, "current location");

      // Fallback: provider.label (if not already used as credit)
      if (!source) {
        const providers = manifest["provider"] as
          | Array<{ label: V3LabelMap }>
          | undefined;
        if (providers?.[0]?.label) {
          const providerName = extractV3Label(providers[0].label);
          if (providerName && providerName !== credit) {
            source = providerName;
          }
        }
      }

      metadata = {
        title: extractV3Label(manifest["label"] as V3LabelMap) || null,
        creator:
          extractV3MetadataValue(rawMetadata, "creator") ??
          extractV3MetadataValue(rawMetadata, "artist") ??
          extractV3MetadataValue(rawMetadata, "author") ??
          extractV3MetadataValue(rawMetadata, "maker") ??
          extractV3MetadataValue(rawMetadata, "contributor") ??
          extractV3MetadataValue(rawMetadata, "painter") ??
          extractV3MetadataValue(rawMetadata, "sculptor"),
        description:
          extractV3MetadataValue(rawMetadata, "description") ??
          (manifest["summary"]
            ? extractV3Label(manifest["summary"] as V3LabelMap)
            : null),
        thumbnail: extractV3Thumbnail(manifest),
        source,
        credit,
        period:
          extractV3MetadataValue(rawMetadata, "date") ??
          extractV3MetadataValue(rawMetadata, "period") ??
          extractV3MetadataValue(rawMetadata, "creation date") ??
          extractV3MetadataValue(rawMetadata, "temporal"),
        object_type:
          extractV3MetadataValue(rawMetadata, "medium") ??
          extractV3MetadataValue(rawMetadata, "type"),
        image_available: hasV3IiifTiles(manifest),
      };
    }

    return { ok: true, metadata };
  } catch {
    return { ok: false, error: "parse_error" };
  }
}

// ---------------------------------------------------------------------------
// Legal boilerplate detection (matches Telar's is_legal_boilerplate)
// ---------------------------------------------------------------------------

/**
 * Detects if attribution text is generic legal boilerplate rather than a
 * useful credit line (e.g. museum name). Boilerplate often contains URLs,
 * rights statements, or phrases about permissions.
 */
function isLegalBoilerplate(text: string): boolean {
  const lower = text.toLowerCase();

  // Starts with a URL
  if (lower.startsWith("http")) return true;

  const indicators = [
    "for information on use",
    "rights and permissions",
    "http://",
    "https://",
    "licensed under",
    "license",
    "see library",
    "please see",
    "for more information",
  ];

  const count = indicators.filter((i) => lower.includes(i)).length;
  return count >= 2 || text.length > 200;
}
