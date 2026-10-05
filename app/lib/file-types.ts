/**
 * File-type declarations for the Compositor.
 *
 * Four separate questions are answered here, by separately-declared sets:
 *
 *   1. Which object ids will have IIIF tiles? TILEABLE_EXTENSIONS
 *   2. What kind of media is this?            AUDIO_EXTENSIONS
 *   3. What may an author upload?             UPLOAD_ACCEPTED_EXTENSIONS
 *   4. What does the framework strip from an
 *      object id, at a given release?         OBJECT_ID_STRIPPED_EXTENSIONS
 *
 * They hold overlapping values today. That overlap is a fact about this
 * release, not a rule, and the sets must not be merged into one: an audio
 * object is a legitimate object that the framework will never tile, so the
 * upload set is allowed to be strictly larger than the tileable set, and
 * recognising a file as media says nothing about whether tiles exist for it.
 * Collapsing them would make audio impossible to accept without also claiming
 * tiles for it.
 *
 * TILEABLE_EXTENSIONS is not ours to choose. It is the tiler's search list
 * (`scripts/generate_iiif.py`) at the site's framework release: an object
 * whose file has an extension the objects processor does not list is kept
 * with a warning and still tiled and shown. A site keeps the list of the
 * release it runs, so the set is declared per release, and read for a site
 * through `tileableExtensions` in `object-id.ts`.
 * `tests/template-coupling.live.test.ts` asserts that the set for the live
 * template's own version equals its tiler's list at the release gate.
 *
 * MIME types, `accept` attributes and user-facing format lists are all derived
 * from FILE_FORMATS rather than maintained as parallel lists, so a format is
 * added in one place.
 *
 * @version v1.5.0-beta
 */

// ---------------------------------------------------------------------------
// The format table
// ---------------------------------------------------------------------------

interface FileFormat {
  /** MIME type the browser reports and the upload validator gates on. */
  mime: string;
  /** Human-readable format name for user-facing format lists, uppercased. */
  label: string;
  /** Further MIME types a browser reports for the same extension. */
  aliasMimes?: readonly string[];
}

/**
 * Every file extension the Compositor knows anything about, with the MIME type
 * and display name that belong to it.
 *
 * Insertion order is load-bearing in two ways: it fixes the order formats are
 * listed to a user, and the FIRST extension mapped to a MIME type is the one
 * `extensionForMimeType` returns, which is the extension an uploaded file is
 * stored under. `jpg` before `jpeg` and `tif` before `tiff` are therefore the
 * stored spellings.
 */
const FILE_FORMATS: Record<string, FileFormat> = {
  jpg: { mime: "image/jpeg", label: "JPG" },
  jpeg: { mime: "image/jpeg", label: "JPG" },
  png: { mime: "image/png", label: "PNG" },
  webp: { mime: "image/webp", label: "WEBP" },
  tif: { mime: "image/tiff", label: "TIFF" },
  tiff: { mime: "image/tiff", label: "TIFF" },
  pdf: { mime: "application/pdf", label: "PDF" },
  mp3: { mime: "audio/mpeg", label: "MP3" },
  ogg: { mime: "audio/ogg", label: "OGG" },
  // WebKit's MIMETypeRegistry lists audio/x-m4a for .m4a.
  m4a: { mime: "audio/mp4", label: "M4A", aliasMimes: ["audio/x-m4a"] },
};

// ---------------------------------------------------------------------------
// The four questions
// ---------------------------------------------------------------------------

/** A framework release, as the three numbers of its version. */
export type FrameworkRelease = readonly [major: number, minor: number, patch: number];

/**
 * Question 1 — which object ids will have IIIF tiles.
 *
 * Each extension the tiler searches, in its search order, with the first
 * framework release whose tiler searches it. Every site that reads this is
 * predicting the tiler's output from a repo tree, so a value here that the
 * framework does not tile produces an object the Compositor claims has an
 * image and the published site cannot show.
 *
 * The tiler looks for `{site id}{ext}` with each extension spelled as listed
 * and in uppercase, and nothing else, on a case-sensitive filesystem; a
 * mixed-case extension is never found. A release before 0.5.0 tiled every
 * file in the folder under its own stem instead, which this declaration does
 * not describe.
 */
export const TILEABLE_EXTENSIONS: ReadonlyArray<{ ext: string; since: FrameworkRelease }> = [
  { ext: "jpg", since: [0, 1, 0] },
  { ext: "jpeg", since: [0, 1, 0] },
  { ext: "png", since: [0, 1, 0] },
  { ext: "heic", since: [0, 5, 0] },
  { ext: "heif", since: [0, 5, 0] },
  { ext: "webp", since: [0, 5, 0] },
  { ext: "tif", since: [0, 1, 0] },
  { ext: "tiff", since: [0, 1, 0] },
  { ext: "pdf", since: [0, 9, 0] },
  { ext: "gif", since: [1, 8, 0] },
  { ext: "bmp", since: [1, 8, 0] },
  { ext: "svg", since: [1, 8, 0] },
];

/**
 * Question 2 — what kind of media a file is.
 *
 * Extensions that mark an object as audio rather than an image. Nothing here
 * is ever tiled, which is why this set and TILEABLE_EXTENSIONS are separate
 * declarations rather than one.
 *
 * The framework's `scripts/telar/media_type.py` enumerates uppercase variants
 * alongside lowercase ones; comparisons against this set must lowercase the
 * extension first, as every call site does.
 */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(["mp3", "ogg", "m4a"]);

/**
 * The source_url an uploaded file is registered with: an audio file is named
 * there, as an imported recording is, because the objects screens read the
 * media kind from it and an object with no tiles would otherwise read as one
 * still waiting for them. Anything else has none.
 */
export function uploadedSourceUrl(objectId: string, ext: string): string | null {
  return AUDIO_EXTENSIONS.has(ext) ? `${objectId}.${ext}` : null;
}

/**
 * Question 3 — what an author may upload.
 *
 * Declared in full rather than derived from TILEABLE_EXTENSIONS. It is a
 * subset of the tileable set of every release from 0.9.0 and is not required
 * to be: an audio format can be accepted here without becoming tileable, as a
 * one-line edit rather than a restructuring. Everything downstream — the
 * MIME gate, the file input's `accept`, the format list a user reads —
 * derives from this set, so widening it widens all three together. The audio
 * extensions are in it and still not in TILEABLE_EXTENSIONS.
 */
export const UPLOAD_ACCEPTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "tif",
  "tiff",
  "pdf",
  "mp3",
  "ogg",
  "m4a",
]);

/**
 * The formats the upload dialog may put in an `<img>` before commit.
 *
 * Narrower than UPLOAD_ACCEPTED_EXTENSIONS by design. A PDF cannot render in
 * an `<img>` at all, and TIFF renders in no browser but Safari, so an
 * unconditional preview shows a broken image. The narrower reason is SVG: the
 * only thing that makes a rendered SVG safe is `<img>`'s restricted mode
 * (scripts disabled, external references blocked), a guarantee that would live
 * entirely in an unwritten tag choice. Gating on this set instead makes "the
 * Compositor never renders an author's markup" true by construction, before
 * SVG is ever accepted.
 */
export const BROWSER_RENDERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
]);

/**
 * Question 4 — the extensions the framework strips from an object id, and
 * from a step's `object`, before it tiles, pages or matches the object
 * (`_clean_object_ids`, `_validate_object_references`), each with the first
 * framework release whose objects processor strips it.
 *
 * Not ours to choose either: the framework's list is `csv_utils.IMAGE_EXTENSIONS`,
 * and a site keeps the set of the release it runs, so the set is declared
 * per release rather than as one list. It is a question about ids, not about
 * files, and so does not follow TILEABLE_EXTENSIONS: before 1.8.0, `.gif`,
 * `.bmp` and `.svg` are stripped from an id although the tiler does not
 * search them, and `.heic` and `.heif` are searched although they are not
 * stripped. `tests/template-coupling.live.test.ts` asserts that the set for the
 * live template's own version equals its IMAGE_EXTENSIONS.
 */
export const OBJECT_ID_STRIPPED_EXTENSIONS: ReadonlyArray<{ ext: string; since: FrameworkRelease }> = [
  { ext: "jpg", since: [0, 3, 0] },
  { ext: "jpeg", since: [0, 3, 0] },
  { ext: "png", since: [0, 3, 0] },
  { ext: "heic", since: [1, 8, 0] },
  { ext: "heif", since: [1, 8, 0] },
  { ext: "webp", since: [0, 3, 0] },
  { ext: "tif", since: [0, 3, 0] },
  { ext: "tiff", since: [0, 3, 0] },
  { ext: "pdf", since: [0, 9, 0] },
  { ext: "gif", since: [0, 3, 0] },
  { ext: "bmp", since: [0, 3, 0] },
  { ext: "svg", since: [0, 3, 0] },
];

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * The MIME types belonging to a set of extensions.
 *
 * Throws on an extension with no FILE_FORMATS entry: a set widened without the
 * table being widened would otherwise silently accept a file the rest of the
 * code cannot name.
 */
export function mimeTypesFor(extensions: Iterable<string>): Set<string> {
  const mimes = new Set<string>();
  for (const ext of extensions) {
    const format = FILE_FORMATS[ext];
    if (!format) {
      throw new Error(`file-types: no MIME type declared for extension "${ext}"`);
    }
    mimes.add(format.mime);
    for (const alias of format.aliasMimes ?? []) mimes.add(alias);
  }
  return mimes;
}

/**
 * A human-readable, comma-separated list of format names for a set of
 * extensions, deduplicated by format (jpg and jpeg are one format to a reader).
 * This is what the i18n catalogue interpolates, so the strings stay consumers
 * of the declaration rather than another copy of it.
 */
export function formatListFor(extensions: Iterable<string>): string {
  const labels: string[] = [];
  for (const ext of extensions) {
    const label = FILE_FORMATS[ext]?.label ?? ext.toUpperCase();
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(", ");
}

/** The `accept` attribute value for a file input over a set of extensions. */
export function acceptAttributeFor(extensions: Iterable<string>): string {
  return [...extensions].map((ext) => `.${ext}`).join(",");
}

/**
 * The extension a file of this MIME type is stored under, or null when the
 * MIME type is not one we accept. Callers derive the stored extension from the
 * MIME type rather than the filename so a renamed file cannot choose its own.
 */
export function extensionForMimeType(mime: string): string | null {
  for (const [ext, format] of Object.entries(FILE_FORMATS)) {
    if (format.mime === mime || format.aliasMimes?.includes(mime)) return ext;
  }
  return null;
}

/**
 * The extension an accepted upload is stored under.
 *
 * Total over UPLOAD_ACCEPTED_MIME_TYPES by construction — that set is derived
 * from UPLOAD_ACCEPTED_EXTENSIONS through this same table, so every MIME type
 * the upload gate admits has an extension here. The throw is the guarantee, not
 * a case a caller is expected to handle: an upload path that reached it would
 * otherwise store a file under some other format's extension and never be
 * tiled.
 */
export function storedExtensionFor(mime: string): string {
  const ext = extensionForMimeType(mime);
  if (!ext) {
    throw new Error(`file-types: no extension declared for MIME type "${mime}"`);
  }
  return ext;
}

/** The display name for an extension, e.g. "TIFF" for both tif and tiff. */
export function formatLabelFor(extension: string): string {
  return FILE_FORMATS[extension]?.label ?? extension.toUpperCase();
}

/**
 * The extension a staged upload is treated as: taken from the MIME type the
 * browser reported, and only from the filename when that MIME type is not one
 * we declare. A renamed file therefore cannot talk its way into a preview.
 */
export function uploadFileExtension(file: { type: string; name: string }): string {
  const fromMime = extensionForMimeType(file.type);
  if (fromMime) return fromMime;
  const match = file.name.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

/** Whether a staged upload may be shown in an `<img>` before it is committed. */
export function isBrowserRenderable(file: { type: string; name: string }): boolean {
  return BROWSER_RENDERABLE_EXTENSIONS.has(uploadFileExtension(file));
}

// ---------------------------------------------------------------------------
// Upload derivations (the shapes call sites actually consume)
// ---------------------------------------------------------------------------

/** MIME types accepted for upload, derived from UPLOAD_ACCEPTED_EXTENSIONS. */
export const UPLOAD_ACCEPTED_MIME_TYPES: ReadonlySet<string> = mimeTypesFor(
  UPLOAD_ACCEPTED_EXTENSIONS,
);

/** `accept` attribute for the upload file input. */
export const UPLOAD_ACCEPT_ATTRIBUTE = acceptAttributeFor(UPLOAD_ACCEPTED_EXTENSIONS);

/** Format list interpolated into the upload hint and format-error strings. */
export const UPLOAD_ACCEPTED_FORMAT_LIST = formatListFor(UPLOAD_ACCEPTED_EXTENSIONS);
