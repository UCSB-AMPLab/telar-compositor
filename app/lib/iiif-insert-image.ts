/**
 * iiif-insert-image — the image the editor's image dialog inserts for an
 * object, read from the object's IIIF manifest or Image API info.json.
 *
 * An external object's source is a Presentation v3 or v2 manifest, or an Image
 * API info.json; a self-hosted object's is the manifest the site writes under
 * its tiles. A manifest of more than one canvas, or whose first canvas shows
 * a PDF, is refused: neither can be inserted as a single image. A painting
 * body that is not an image (a video, audio) names no image.
 *
 * Client-safe: every lookup goes through the one fetch in `fetchIiifJson`.
 *
 * @version v1.5.0-beta
 */

/** A source the dialog refuses: a multi-page manifest, or a PDF. */
export const MULTI_PAGE = Symbol("multi-page");

/** An image address, a refusal, or null when the source names no image. */
export type ObjectImage = string | typeof MULTI_PAGE | null;

const IMAGE_API = "http://iiif.io/api/image";
const IMAGE_API_V3_CONTEXT = "http://iiif.io/api/image/3/context.json";

/** A fetched document's JSON, or null when it cannot be fetched or parsed. */
async function fetchIiifJson(url: string): Promise<unknown> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The value at `path` inside a parsed document; undefined where it stops. */
function iiifPath(value: unknown, path: ReadonlyArray<string | number>): unknown {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return at;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * The image a manifest's first canvas shows: a v3 annotation body's `id`,
 * else a v2 image resource's `@id`. `MULTI_PAGE` when the manifest has more
 * than one canvas (v3 `items`, else v2's first sequence's `canvases`) or its
 * first canvas shows a PDF; null when it names no image; undefined for a
 * document that is not a manifest.
 */
function manifestImage(doc: unknown): ObjectImage | undefined {
  const v3 = iiifPath(doc, ["items"]);
  const canvases = Array.isArray(v3) ? v3 : iiifPath(doc, ["sequences", 0, "canvases"]);
  if (!Array.isArray(canvases)) return undefined;
  const body = iiifPath(canvases, [0, "items", 0, "items", 0, "body"]);
  const resource = iiifPath(canvases, [0, "images", 0, "resource"]);
  const format = iiifPath(body, ["format"]) ?? iiifPath(resource, ["format"]);
  if (canvases.length > 1 || format === "application/pdf") return MULTI_PAGE;
  if (!isImageBody(body) && !isImageBody(resource)) return null;
  return nonEmptyString(iiifPath(body, ["id"])) ?? nonEmptyString(iiifPath(resource, ["@id"]));
}

/**
 * Whether a painting body (v3) or image resource (v2) is an image. A declared
 * type or format decides: type `Image` (`dctypes:Image` in v2) or a format
 * starting `image/` is an image, and any other declared type or format (a
 * video or audio that also carries an image service) is not. Only a body that
 * declares neither is judged by an image service.
 */
function isImageBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const type = iiifPath(body, ["type"]) ?? iiifPath(body, ["@type"]);
  const format = iiifPath(body, ["format"]);
  if (type === "Image" || type === "dctypes:Image") return true;
  if (typeof format === "string" && format.startsWith("image/")) return true;
  if (type !== undefined || format !== undefined) return false;
  return hasImageService(iiifPath(body, ["service"]));
}

function hasImageService(service: unknown): boolean {
  return (Array.isArray(service) ? service : [service]).some(
    (s) => s && typeof s === "object" && isImageService(s as Record<string, unknown>),
  );
}

function isImageService(doc: Record<string, unknown>): boolean {
  return doc.protocol === IMAGE_API || (typeof doc.type === "string" && /^ImageService\d$/.test(doc.type));
}

/** A v3 service: `type` ImageService3, or the v3 context. */
function isImageServiceV3(doc: Record<string, unknown>): boolean {
  const context = doc["@context"];
  const contexts = Array.isArray(context) ? context : [context];
  return doc.type === "ImageService3" || contexts.includes(IMAGE_API_V3_CONTEXT);
}

/**
 * The full image an Image API info.json describes, from its service id (`id`
 * in v3, `@id` in v2). The size is `max` for a v3 service and `full`
 * otherwise: v2 requires every service to answer `full` and leaves `max`
 * optional, and v3 has no `full`. Null for any other document.
 */
function infoJsonFullImage(info: unknown): string | null {
  if (!info || typeof info !== "object") return null;
  const doc = info as Record<string, unknown>;
  const id = nonEmptyString(doc.id ?? doc["@id"]);
  if (!isImageService(doc) || !id) return null;
  return `${id.replace(/\/+$/, "")}/full/${isImageServiceV3(doc) ? "max" : "full"}/0/default.jpg`;
}

/**
 * An external object's image: a manifest's image, else an info.json's full
 * image; `MULTI_PAGE` for a multi-page or PDF manifest.
 */
export async function externalObjectImage(sourceUrl: string): Promise<ObjectImage> {
  const doc = await fetchIiifJson(sourceUrl.trim());
  return manifestImage(doc) ?? infoJsonFullImage(doc);
}

/**
 * A self-hosted object's image: the one its manifest names, else, for an
 * object known to have an image, the page-1 image under its tiles; null for
 * any other object whose manifest names none. `MULTI_PAGE` for a multi-page or
 * PDF manifest.
 */
export async function selfHostedObjectImage(base: string, hasImage: boolean): Promise<ObjectImage> {
  const named = manifestImage(await fetchIiifJson(`${base}/manifest.json`));
  return named ?? (hasImage ? `${base}/page-1/full/max/0/default.jpg` : null);
}
