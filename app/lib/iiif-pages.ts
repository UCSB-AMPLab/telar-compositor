/**
 * iiif-pages — the page library behind every multi-page object in the
 * compositor.
 *
 * A IIIF manifest is the only description of how many pages an object has and
 * what each one looks like. This module turns a fetched manifest (Presentation
 * API v2 or v3) into a flat list of `ManifestPage` records: the tile source
 * OpenSeadragon opens, and, where the manifest offers them, a thumbnail URL and
 * a human label for that canvas. The viewer opens pages from that list and the
 * page chooser draws its grid from the same list, so a single read of the
 * manifest serves both and neither can show a different revision of it.
 *
 * `sourceKeyFor` is the shared name for a source — the pair of URLs a viewer is
 * pointed at. The viewer and the story editor's viewer column both derive it
 * the same way, so a record made against one source can never be matched
 * against another.
 *
 * Client-safe: pure functions over already-fetched JSON, no fetching of its own.
 *
 * @version v1.5.0-beta
 */

import type { TOptions } from "i18next";
import { pickThumbnailSize } from "~/lib/use-iiif-thumbnail";

export interface ManifestPage {
  /** info.json or direct image URL for this page */
  tileSource: string;
  /** Thumbnail image URL declared by the manifest for this canvas, when it has one */
  thumbnail?: string;
  /** Human-readable canvas label, when the manifest carries one */
  label?: string;
}

/**
 * The stable name of a source. A source is the pair of URLs a viewer is pointed
 * at; two viewers derive the same key for the same pair and different keys for
 * any other pair.
 */
export function sourceKeyFor(
  manifestUrl: string | null,
  infoJsonUrl: string | null
): string {
  // A separator no URL can contain, so no pair of URLs can collide with another.
  return `${manifestUrl ?? ""}\u0000${infoJsonUrl ?? ""}`;
}

/**
 * A page number or count as the reader's locale groups it. Grouping is forced
 * because Spanish leaves four-digit numbers ungrouped by default, so a
 * thousand-page manuscript would read `1240` in one language and `1,240` in the
 * other within the same indicator. Engines that reject the `"always"` keyword
 * fall back to the boolean form.
 */
export function formatPageNumber(language: string, value: number): string {
  try {
    return new Intl.NumberFormat(language, {
      useGrouping: "always",
    } as unknown as Intl.NumberFormatOptions).format(value);
  } catch {
    return new Intl.NumberFormat(language, { useGrouping: true }).format(value);
  }
}

/**
 * Interpolation values for a page string. i18next reserves `count` for plural
 * selection and types it as a number, while these strings interpolate a count
 * already grouped for the reader's locale, so the dictionary passes through
 * unnarrowed. The chooser only ever opens above a count of one, so no string
 * here needs a plural pair.
 */
export function pageValues(values: Record<string, string>): TOptions {
  return values as unknown as TOptions;
}

/** The first entry a reader accepts, so a value and an array of it read alike. */
function firstUsable(
  entries: unknown[],
  read: (value: unknown) => string | undefined
): string | undefined {
  for (const entry of entries) {
    const found = read(entry);
    if (found) return found;
  }
  return undefined;
}

/**
 * The first usable image URL in a IIIF thumbnail value. A thumbnail may be a
 * bare string, an object carrying `id` (v3) or `@id` (v2), or an array of
 * either; anything else yields nothing.
 */
function normaliseThumbnail(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) return firstUsable(value, normaliseThumbnail);
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const id = rec.id ?? rec["@id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The first usable label string. v3 carries a language map (`{ en: ["..."] }`),
 * v2 a bare string or a language-tagged value (`{ "@value": "..." }`), possibly
 * in an array. Any language will do — the label is a hint, not content.
 */
function normaliseLabel(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) return firstUsable(value, normaliseLabel);
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  const tagged = rec["@value"];
  if (typeof tagged === "string" && tagged.length > 0) return tagged;
  return firstUsable(Object.values(rec), normaliseLabel);
}

/**
 * The image API service a body names, as the first entry (v3's `service` array,
 * or v2's single `service` object) that carries a usable id.
 */
function bodyImageService(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const service = body.service;
  const candidates = Array.isArray(service) ? service : service ? [service] : [];
  for (const entry of candidates) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const id = rec.id ?? rec["@id"];
    if (typeof id === "string" && id.length > 0) return rec;
  }
  return undefined;
}

/**
 * The finite positive dimension a IIIF size entry must carry to be usable. A
 * manifest is untrusted input: an entry that isn't an object, or whose width
 * or height is missing, non-numeric, non-finite or non-positive, is dropped
 * rather than handed to the size picker, so a malformed entry can never take
 * down the pages after it.
 */
function isUsableDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** The declared sizes worth offering to `pickThumbnailSize`, malformed entries dropped. */
function usableSizes(value: unknown): Array<{ width: number; height: number }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is { width: number; height: number } =>
      !!entry &&
      typeof entry === "object" &&
      isUsableDimension((entry as Record<string, unknown>).width) &&
      isUsableDimension((entry as Record<string, unknown>).height)
  );
}

/**
 * A thumbnail built from the body's image service, for a canvas that declares
 * no thumbnail of its own — a vips-generated level-0 service names no
 * `thumbnail` but does declare `sizes`, which is enough to derive one.
 */
function serviceDerivedThumbnail(body: Record<string, unknown>): string | undefined {
  const service = bodyImageService(body);
  if (!service) return undefined;
  const id = (service.id ?? service["@id"]) as string;
  const sizes = usableSizes(service.sizes);
  if (sizes.length === 0) return undefined;
  const size = pickThumbnailSize(sizes);
  if (!size) return undefined;
  return `${id}/full/${size.width},${size.height}/0/default.jpg`;
}

/**
 * The body's own image, when it is already a small derivative — a last resort
 * for a service that declares no sizes at all.
 */
function smallBodyThumbnail(body: Record<string, unknown>): string | undefined {
  const id = body.id ?? body["@id"];
  if (typeof id !== "string" || id.length === 0) return undefined;
  const width = body.width;
  const height = body.height;
  if (typeof width !== "number" || typeof height !== "number") return undefined;
  if (Math.max(width, height) > 1000) return undefined;
  return id;
}

/**
 * Attach a thumbnail and a label to a page. The thumbnail is the canvas's own,
 * else the body's, else one derived from the body's image service sizes, else
 * the body's own image when it is already a small derivative, else none.
 */
function decorate(
  page: ManifestPage,
  canvasThumb: unknown,
  body: Record<string, unknown>,
  label: unknown
): ManifestPage {
  const thumbnail =
    normaliseThumbnail(canvasThumb) ??
    normaliseThumbnail(body.thumbnail) ??
    serviceDerivedThumbnail(body) ??
    smallBodyThumbnail(body);
  const labelText = normaliseLabel(label);
  if (thumbnail) page.thumbnail = thumbnail;
  if (labelText) page.label = labelText;
  return page;
}

/** Extract every page of a manifest, trying Presentation v3 before v2. */
export function extractAllPages(manifest: Record<string, unknown>): ManifestPage[] {
  const v3Pages = extractV3Pages(manifest);
  if (v3Pages.length > 0) return v3Pages;

  const v2Pages = extractV2Pages(manifest);
  if (v2Pages.length > 0) return v2Pages;

  return [];
}

/** The image body of a v3 canvas's first annotation, when it carries one. */
function v3CanvasBody(canvas: Record<string, unknown>): Record<string, unknown> | null {
  const annoPages = canvas.items as Array<Record<string, unknown>> | undefined;
  if (!annoPages?.[0]) return null;
  const annos = annoPages[0].items as Array<Record<string, unknown>> | undefined;
  if (!annos?.[0]) return null;
  return (annos[0].body as Record<string, unknown> | undefined) ?? null;
}

/**
 * The tile source a v3 body names: an Image API service first, then the body's
 * own Image URL with an info.json derived from it, and the image URL itself as
 * a last resort.
 */
function v3TileSource(body: Record<string, unknown>): string | null {
  const service = body.service as Array<Record<string, string>> | undefined;
  if (service?.[0]?.id) return service[0].id + "/info.json";
  const id = body.id;
  if (typeof id !== "string" || id.length === 0) return null;
  if (body.type !== "Image") return null;
  return deriveInfoJsonFromImageUrl(id) ?? id;
}

export function extractV3Pages(manifest: Record<string, unknown>): ManifestPage[] {
  const pages: ManifestPage[] = [];
  try {
    const items = manifest.items as Array<Record<string, unknown>> | undefined;
    if (!items) return pages;

    for (const canvas of items) {
      const body = v3CanvasBody(canvas);
      if (!body) continue;
      const tileSource = v3TileSource(body);
      if (!tileSource) continue;
      pages.push(decorate({ tileSource }, canvas.thumbnail, body, canvas.label));
    }
  } catch { /* fall through */ }
  return pages;
}

/** The tile source a v2 resource names: its Image API service, else its own id. */
function v2TileSource(resource: Record<string, unknown>): string | null {
  const service = resource.service as Record<string, string> | undefined;
  if (service?.["@id"]) return service["@id"] + "/info.json";
  const id = resource["@id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function extractV2Pages(manifest: Record<string, unknown>): ManifestPage[] {
  const pages: ManifestPage[] = [];
  try {
    const sequences = manifest.sequences as Array<Record<string, unknown>> | undefined;
    if (!sequences?.[0]) return pages;
    const canvases = sequences[0].canvases as Array<Record<string, unknown>> | undefined;
    if (!canvases) return pages;

    for (const canvas of canvases) {
      const images = canvas.images as Array<Record<string, unknown>> | undefined;
      if (!images?.[0]) continue;
      const resource = images[0].resource as Record<string, unknown> | undefined;
      if (!resource) continue;
      const tileSource = v2TileSource(resource);
      if (!tileSource) continue;
      pages.push(decorate({ tileSource }, canvas.thumbnail, resource, canvas.label));
    }
  } catch { /* fall through */ }
  return pages;
}

/**
 * Derives an info.json URL from an IIIF Image API URL.
 * E.g. ".../iiif/3/{id}/full/max/0/default.jpg" → ".../iiif/3/{id}/info.json"
 */
export function deriveInfoJsonFromImageUrl(url: string): string | null {
  // Match IIIF Image API URL pattern: {base}/{region}/{size}/{rotation}/{quality}.{format}
  const match = url.match(/^(.+\/iiif\/\d+\/[^/]+)\/[^/]+\/[^/]+\/[^/]+\/[^/]+$/);
  if (match) {
    return match[1] + "/info.json";
  }
  return null;
}
