/**
 * An object's id as the published site reads it.
 *
 * The framework removes one image extension from every object_id before it
 * builds the site (`_clean_object_ids`, `scripts/telar/processors/objects/
 * frame.py`): `map.jpg` becomes `map`, `MAP.JPG` becomes `MAP`, `map.jpg.png`
 * becomes `map.jpg`. It tiles, pages and links the object under that result,
 * and it looks for the object's file in `telar-content/objects` under it too.
 * A story step's `object` is stripped the same way and then matched exactly,
 * else case-insensitively, against those ids (`_validate_object_references`,
 * `scripts/telar/processors/stories.py`).
 *
 * The Compositor keeps the id as the author wrote it, and shows, stores and
 * writes it unchanged. Wherever it has to predict what the site does with the
 * id — an image address, a file in the repository, a step's object, a count of
 * uses — it asks this module for the site's form.
 *
 * Pure data and functions, with no server imports, so both the loaders and the
 * editor's components can take it.
 *
 * @version v1.5.0-beta
 */

import { OBJECT_ID_STRIPPED_EXTENSIONS, TILEABLE_EXTENSIONS, type FrameworkRelease } from "~/lib/file-types";
import { pythonStrip } from "~/lib/python-whitespace";
import { detectMediaType, type MediaType } from "~/lib/media-type";
import type { SheetIssue } from "~/lib/sheet-warnings";

/**
 * The release a site with no readable `telar_version` is taken to run. On
 * 1.7.0 the tiler searches `.heic`, `.heif`, `.webp` and `.pdf` but not
 * `.gif`, `.bmp` or `.svg`; ids lose `.gif`, `.bmp` and `.svg` but not
 * `.heic` or `.heif`; and the story reader takes pandas' missing-value tokens
 * as empty cells.
 */
const UNKNOWN_VERSION_READS_AS: FrameworkRelease = [1, 7, 0];

/**
 * pandas' default missing-value tokens (`STR_NA_VALUES` in pandas 3.0.5, the
 * version v1.7.0 requires), which `read_csv` with its default `na_values`
 * reads as missing when a cell equals one exactly. The stories processor
 * then fills a missing cell with "". Before 1.8.0 the framework reads a story CSV that way
 * (`csv_to_json`, scripts/telar/core.py); from 1.8.0 it reads only a blank
 * cell as missing (`keep_default_na=False, na_values=['']`).
 */
const PANDAS_MISSING_VALUE_TOKENS: ReadonlySet<string> = new Set([
  "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan", "1.#IND", "1.#QNAN",
  "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a", "nan", "null",
]);

/** The first release whose story reader keeps a missing-value token as text. */
const TOKENS_KEPT_AS_TEXT_SINCE: FrameworkRelease = [1, 8, 0];

/**
 * Whether the story reader of a site running `frameworkVersion` reads `cell`
 * as an empty cell: before 1.8.0, when it is one of pandas' missing-value
 * tokens exactly (`PANDAS_MISSING_VALUE_TOKENS`).
 */
function readAsEmptyCell(cell: string, frameworkVersion: string | null | undefined): boolean {
  return PANDAS_MISSING_VALUE_TOKENS.has(cell) && !atLeast(releaseOf(frameworkVersion), TOKENS_KEPT_AS_TEXT_SINCE);
}

/**
 * Whether pandas' default `read_csv` could read `id` as a number or a boolean
 * rather than keeping it as text. A column holding only such values is
 * inferred as a numeric or boolean dtype, so the id builds as another string:
 * `1e3` as `1000.0`, `007` as `7`, `true` as `True`.
 *
 * The test is conservative: it trims surrounding whitespace (which the parser
 * drops for some spellings and keeps for others) and then refuses
 *  - a decimal number with an optional sign, fraction and exponent: `7`, `007`,
 *    `-2`, `+3`, `1.5`, `.5`, `5.`, `1e3`, `1E-3`;
 *  - `inf`, `infinity` and `nan` in any letter case, with an optional sign;
 *  - the `1.#INF`, `1.#IND` and `1.#QNAN` spellings, with an optional sign;
 *  - `true` and `false` in any letter case.
 * An id with any other character, such as `1e3-map` or `true-north`, is text.
 */
function pandasMayInferNonText(id: string): boolean {
  const text = id.trim();
  return (
    /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text) ||
    /^[+-]?(?:inf|infinity|nan)$/i.test(text) ||
    /^[+-]?1\.#(?:inf|ind|qnan)$/i.test(text) ||
    /^(?:true|false)$/i.test(text)
  );
}

/**
 * Whether the sheet reader of a site running `frameworkVersion` loses `id`
 * as an object id. A release under 1.8.0 reads objects.csv with `read_csv`'s
 * defaults: one of pandas' missing-value tokens is read as missing, and an id
 * pandas could infer as a number or boolean (`pandasMayInferNonText`) is
 * rewritten. 1.8.0 and later pin the `object_id` column to text and read only
 * a blank cell as missing (`TEXT_COLUMNS`, scripts/telar/csv_utils.py).
 */
export function sheetReaderLosesId(id: string, frameworkVersion: string | null | undefined): boolean {
  if (atLeast(releaseOf(frameworkVersion), TOKENS_KEPT_AS_TEXT_SINCE)) return false;
  return PANDAS_MISSING_VALUE_TOKENS.has(id) || pandasMayInferNonText(id);
}

/**
 * The numeric release in a version string, with or without a leading `v`. A
 * pre-release suffix is ignored: `0.9.0-beta` and `1.8.0-rc.1` carry the
 * extension set of the release they name.
 */
function releaseOf(version: string | null | undefined): FrameworkRelease {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec((version ?? "").trim());
  if (!match) return UNKNOWN_VERSION_READS_AS;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(release: FrameworkRelease, since: FrameworkRelease): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (release[i] !== since[i]) return release[i] > since[i];
  }
  return true;
}

/**
 * The release from which the build keeps one row per object id, the last, so
 * that every page reads the same row (`_keep_the_last_of_each_id`,
 * `scripts/telar/processors/objects/frame.py`). Every earlier supported
 * release keeps them all, and has at least one reader of each kind: the
 * object page and the story viewer take the last row, the homepage
 * thumbnails the first. Which other readers take which row varies by release.
 */
const ONE_ROW_PER_ID_SINCE: FrameworkRelease = [1, 8, 0];

/** Whether a site running `frameworkVersion` reads the last row of an id everywhere. */
function readsLastRowEverywhere(frameworkVersion: string | null | undefined): boolean {
  return atLeast(releaseOf(frameworkVersion), ONE_ROW_PER_ID_SINCE);
}

/** The extensions a site running `frameworkVersion` strips from an id. */
export function strippedExtensions(frameworkVersion: string | null | undefined): string[] {
  const release = releaseOf(frameworkVersion);
  return OBJECT_ID_STRIPPED_EXTENSIONS.filter((e) => atLeast(release, e.since)).map((e) => `.${e.ext}`);
}

/** The extensions the tiler of a site running `frameworkVersion` searches, in its order. */
export function tileableExtensions(frameworkVersion: string | null | undefined): string[] {
  const release = releaseOf(frameworkVersion);
  return TILEABLE_EXTENSIONS.filter((e) => atLeast(release, e.since)).map((e) => `.${e.ext}`);
}

/**
 * The stem of `filename` when its extension is one the site's tiler searches,
 * spelled all lowercase or all uppercase, as the tiler tries each; else null.
 * Only the last extension comes off: `map.jpg.png` has the stem `map.jpg`.
 */
export function tileableStem(filename: string, frameworkVersion: string | null | undefined): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot);
  const lower = ext.toLowerCase();
  if (ext !== lower && ext !== ext.toUpperCase()) return null;
  return tileableExtensions(frameworkVersion).includes(lower) ? filename.slice(0, dot) : null;
}

/**
 * The stems of the files in a repository tree that the site's tiler can find:
 * blobs directly in telar-content/objects with a tileable extension
 * (`tileableStem`). Whether an object is tiled from them is `tiledFromFiles`.
 */
export function tileableStems(
  tree: ReadonlyArray<{ path: string; type: string }>,
  frameworkVersion: string | null | undefined,
): Set<string> {
  const stems = new Set<string>();
  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    const parts = entry.path.split("/");
    if (parts.length !== 3 || parts[0] !== "telar-content" || parts[1] !== "objects") continue;
    const stem = tileableStem(parts[2], frameworkVersion);
    if (stem !== null) stems.add(stem);
  }
  return stems;
}

/**
 * `trimmed` with one extension from the site's set removed, matched in any
 * case, the stem keeping its own case; null when it ends in none. At most one
 * extension of the set can end a value, so the order the framework tries them
 * in does not matter.
 */
function withoutImageExtension(trimmed: string, frameworkVersion: string | null | undefined): string | null {
  const lower = trimmed.toLowerCase();
  for (const ext of strippedExtensions(frameworkVersion)) {
    if (lower.endsWith(ext)) return trimmed.slice(0, trimmed.length - ext.length);
  }
  return null;
}

/**
 * The id the site gives an object written `id`.
 *
 * `_clean_object_ids` trims the id as Python's `str.strip()` does only to look
 * for an extension, and writes the result back only when it removed one: an
 * id with an extension becomes its trimmed stem (`map.jpg ` is `map`), and any
 * other id stays exactly as written, whitespace included (` map ` is ` map `).
 */
export function siteObjectId(id: string, frameworkVersion: string | null | undefined): string {
  return withoutImageExtension(pythonStrip(id), frameworkVersion) ?? id;
}

/**
 * What a step's `object` value is looked up as. `_validate_object_references`
 * trims the value as `str.strip()` does and then strips one extension, and
 * matches that, whether or not an extension came off. A value the story
 * reader reads as an empty cell (`readAsEmptyCell`) is looked up as nothing.
 */
export function stepReference(value: string, frameworkVersion: string | null | undefined): string {
  if (readAsEmptyCell(value, frameworkVersion)) return "";
  const trimmed = pythonStrip(value);
  return withoutImageExtension(trimmed, frameworkVersion) ?? trimmed;
}

/**
 * An object's source as the framework reads it (`get_source_url`): trimmed as
 * `str.strip()` trims it.
 */
function trimmedSource(sourceUrl: string | null | undefined): string {
  return pythonStrip(sourceUrl ?? "");
}

/**
 * Whether an object's source is an address outside the site: the framework
 * takes a source whose scheme `urlparse` reads as `http` or `https`, which it
 * lowercases, so the scheme matches in any case. Such an object is shown from
 * its own manifest and has no `iiif/objects/…` address, whatever its id.
 */
export function isExternalSource(sourceUrl: string | null | undefined): boolean {
  return /^https?:\/\//i.test(trimmedSource(sourceUrl));
}

/**
 * Whether the framework's tiler accepts a site id (`_SAFE_OBJECT_ID` in
 * `generate_iiif.py`); it skips any other, so no tiles are built for it,
 * whatever file is there. Narrower than the importer's `isSafeObjectId`, which
 * also accepts a dot.
 */
export function isTilerObjectId(siteId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(siteId);
}

/**
 * Whether the site tiles `objectId` from a file in telar-content/objects,
 * given the stems of the tileable files there: the tiler looks for its image
 * under the site id, and only for a site id it accepts.
 */
export function tiledFromFiles(
  tileableStems: ReadonlySet<string>,
  objectId: string,
  frameworkVersion: string | null | undefined,
): boolean {
  const siteId = siteObjectId(objectId, frameworkVersion);
  return isTilerObjectId(siteId) && tileableStems.has(siteId);
}

/** The deployed site's base (`url` then `baseurl`) a `project_config` row records, or null with no `url`. */
export function configSiteBase(config: { url?: string | null; baseurl?: string | null } | null | undefined): string | null {
  return config?.url ? `${config.url}${config.baseurl ?? ""}` : null;
}

/** The framework version a `project_config` row records, or null. */
export function configFrameworkVersion(config: { telar_version?: string | null } | null | undefined): string | null {
  return config?.telar_version ?? null;
}

/**
 * The `info.json` a thumbnail is read from for an object with no stored
 * thumbnail: a self-hosted object with an image, under its site id. Null for
 * an object with a stored thumbnail, no image, an external source, or no site
 * base yet.
 */
export function thumbnailInfoJsonUrl(
  object: { objectId: string; thumbnail: string | null; imageAvailable: boolean | null | undefined; sourceUrl: string | null | undefined },
  siteBaseUrl: string | null | undefined,
  frameworkVersion: string | null | undefined,
): string | null {
  if (object.thumbnail || !object.imageAvailable || isExternalSource(object.sourceUrl) || !siteBaseUrl) return null;
  return `${siteIiifObjectBase(siteBaseUrl, object.objectId, frameworkVersion)}/info.json`;
}

/** Where the site keeps a self-hosted object's tiles: `<base>/iiif/objects/<site id>`. */
export function siteIiifObjectBase(
  siteBaseUrl: string,
  objectId: string,
  frameworkVersion: string | null | undefined,
): string {
  return `${siteBaseUrl}/iiif/objects/${siteObjectId(objectId, frameworkVersion)}`;
}

/**
 * The manifest and `info.json` a viewer reads for `object`: an external
 * object's own manifest, or a self-hosted object's under its site id. A
 * self-hosted object with no site base has no address yet.
 */
export function iiifUrlsFor(
  object: { object_id: string; source_url: string | null } | null | undefined,
  siteBaseUrl: string | null,
  frameworkVersion: string | null | undefined,
): { manifestUrl: string | null; infoJsonUrl: string | null; isSelfHosted: boolean } {
  if (!object) return { manifestUrl: null, infoJsonUrl: null, isSelfHosted: false };
  if (isExternalSource(object.source_url)) {
    return { manifestUrl: trimmedSource(object.source_url), infoJsonUrl: null, isSelfHosted: false };
  }
  if (!siteBaseUrl) return { manifestUrl: null, infoJsonUrl: null, isSelfHosted: true };
  const base = siteIiifObjectBase(siteBaseUrl, object.object_id, frameworkVersion);
  return { manifestUrl: `${base}/manifest.json`, infoJsonUrl: `${base}/info.json`, isSelfHosted: true };
}

/**
 * The site ids of `objects` (in the objects sheet's order), and a lookup of a
 * step's reference among them: exactly, else by its lowercase form, where
 * among site ids that differ only in case the one that first appeared latest
 * wins (`_validate_object_references`' `objects_lower_map`). The framework
 * keys its objects by site id, so where several rows share one the later
 * row's data wins, keyed where the first appeared.
 */
function siteIdIndex<T extends { object_id: string }>(
  objects: readonly T[],
  frameworkVersion: string | null | undefined,
): { bySiteId: Map<string, T>; match: (reference: string) => { siteId: string; exact: boolean } | null } {
  const bySiteId = new Map<string, T>();
  for (const object of objects) {
    const siteId = siteObjectId(object.object_id, frameworkVersion);
    if (siteId) bySiteId.set(siteId, object);
  }
  const byLowerSiteId = new Map<string, string>();
  for (const siteId of bySiteId.keys()) byLowerSiteId.set(siteId.toLowerCase(), siteId);
  const match = (reference: string) => {
    if (bySiteId.has(reference)) return { siteId: reference, exact: true };
    const folded = byLowerSiteId.get(reference.toLowerCase());
    return folded === undefined ? null : { siteId: folded, exact: false };
  };
  return { bySiteId, match };
}

/**
 * A resolver from a step's `object` value to the object the site shows for
 * it, built once over `objects` in the objects sheet's order.
 *
 * The step's value is stripped as an id is, then looked up among the site ids
 * as `siteIdIndex` looks it up. A value that strips to nothing names no object.
 */
export function stepObjectResolver<T extends { object_id: string }>(
  objects: readonly T[],
  frameworkVersion: string | null | undefined,
): (stepValue: string | null | undefined) => T | null {
  const { bySiteId, match } = siteIdIndex(objects, frameworkVersion);
  return (stepValue) => {
    const reference = stepReference(stepValue ?? "", frameworkVersion);
    if (!reference) return null;
    const found = match(reference);
    return found === null ? null : (bySiteId.get(found.siteId) ?? null);
  };
}

/**
 * A resolver from a step's published `object` cell to the value the
 * framework's reference pass leaves in it in the story JSON
 * (`_validate_object_references`), matching as `stepObjectResolver` does.
 *
 * The pass trims the cell as `str.strip()` does only to read it, and writes
 * the cell in two cases alone: when one extension came off, the trimmed,
 * stripped value, or the matched site id where the match was
 * case-insensitive; and, with no extension removed, the matched site id on a
 * case-insensitive match. Every other cell, including one that trims to
 * nothing, stays exactly as read, whitespace included. Before 1.8.0 a cell
 * that is one of pandas' missing-value tokens is read as empty before the
 * pass sees it (`readAsEmptyCell`).
 */
export function stepObjectCellResolver(
  objects: ReadonlyArray<{ object_id: string }>,
  frameworkVersion: string | null | undefined,
): (cell: string) => string {
  const { match } = siteIdIndex(objects, frameworkVersion);
  return (cell) => {
    if (readAsEmptyCell(cell, frameworkVersion)) return "";
    const trimmed = pythonStrip(cell);
    if (!trimmed) return cell;
    const stripped = withoutImageExtension(trimmed, frameworkVersion);
    const found = match(stripped ?? trimmed);
    if (found !== null && !found.exact) return found.siteId;
    return stripped ?? cell;
  };
}

/**
 * The media type of the object the site shows for each step's `object` value,
 * keyed by that value. A null-prototype record: a value is the author's text,
 * and `constructor` must not read as a type.
 */
export function mediaTypesByStepValue(
  steps: ReadonlyArray<{ object_id: string | null }>,
  objects: ReadonlyArray<{ object_id: string; source_url: string | null }>,
  frameworkVersion: string | null | undefined,
): Record<string, MediaType> {
  const resolve = stepObjectResolver(objects, frameworkVersion);
  const types: Record<string, MediaType> = Object.create(null);
  for (const step of steps) {
    const shown = step.object_id ? resolve(step.object_id) : null;
    if (shown) types[step.object_id as string] = detectMediaType(shown.source_url, shown.object_id);
  }
  return types;
}

/** The object the site shows for one step's `object` value; see `stepObjectResolver`. */
export function resolveStepObject<T extends { object_id: string }>(
  objects: readonly T[],
  stepValue: string | null | undefined,
  frameworkVersion: string | null | undefined,
): T | null {
  return stepObjectResolver(objects, frameworkVersion)(stepValue);
}

/**
 * How many of `stepValues` the site shows each object for, keyed by the
 * object's id as written. An object no step resolves to is absent.
 */
export function stepUseCounts<T extends { object_id: string }>(
  objects: readonly T[],
  stepValues: Iterable<string | null | undefined>,
  frameworkVersion: string | null | undefined,
): Map<string, number> {
  const resolve = stepObjectResolver(objects, frameworkVersion);
  const counts = new Map<string, number>();
  for (const value of stepValues) {
    const object = resolve(value);
    if (object) counts.set(object.object_id, (counts.get(object.object_id) ?? 0) + 1);
  }
  return counts;
}

/** The other rows a row shares its site id with, and the one the site shows for it. */
export interface SharedSiteId {
  /** The other rows' ids as written, in sheet order. */
  others: string[];
  /** The id, as written, of the row the site's object page and steps show. */
  shown: string;
}

/**
 * Every row whose site id another row also has, with those rows and the row
 * the site shows: the later one in the objects sheet's order, as
 * `stepObjectResolver` takes it. `objects` is in that order.
 */
export function sharedSiteIds<T extends { object_id: string }>(
  objects: readonly T[],
  frameworkVersion: string | null | undefined,
): Map<string, SharedSiteId> {
  const groups = new Map<string, string[]>();
  for (const object of objects) {
    const siteId = siteObjectId(object.object_id, frameworkVersion);
    const group = groups.get(siteId) ?? [];
    group.push(object.object_id);
    groups.set(siteId, group);
  }
  const shared = new Map<string, SharedSiteId>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const shown = group[group.length - 1];
    for (const id of group) shared.set(id, { others: group.filter((other) => other !== id), shown });
  }
  return shared;
}

/**
 * The flat-file stems in telar-content/objects that are `objectId`'s alone:
 * the id as written, under which the Compositor stores an upload, and the id
 * the site gives it, under which the framework looks for its image. A stem
 * another row of `allObjectIds` also reads as is left out, since a file under
 * it is the image of both rows. A row carrying `objectId` itself is never
 * another row, however many there are: they are one object, and a delete
 * removes all of them.
 */
export function objectFileStems(
  objectId: string,
  allObjectIds: readonly string[],
  frameworkVersion: string | null | undefined,
): Set<string> {
  const others = allObjectIds.filter((other) => other !== objectId);
  const othersRead = new Set(others.map((other) => siteObjectId(other, frameworkVersion)));
  const stems = new Set<string>();
  for (const stem of [objectId, siteObjectId(objectId, frameworkVersion)]) {
    if (stem !== "" && !othersRead.has(stem)) stems.add(stem);
  }
  return stems;
}

/**
 * One sheet issue for each group of rows the site reads as one object, naming
 * them in sheet order and the row its object page and steps show
 * (`sharedSiteIds`), and whether every other page shows that row too.
 */
export function sharedSiteIdIssues<T extends { object_id: string }>(
  objects: readonly T[],
  frameworkVersion: string | null | undefined,
): SheetIssue[] {
  const issues: SheetIssue[] = [];
  const sameRowEverywhere = readsLastRowEverywhere(frameworkVersion);
  const named = new Set<string>();
  for (const [id, share] of sharedSiteIds(objects, frameworkVersion)) {
    if (named.has(id)) continue;
    const ids = [...new Set(objects.map((o) => o.object_id).filter((o) => o === id || share.others.includes(o)))];
    for (const each of ids) named.add(each);
    // One id written in several rows is not two ids the site reads as one:
    // `repeatedIdIssues` names it.
    if (ids.length > 1) issues.push({ code: "object_site_id_shared", ids, shown: share.shown, sameRowEverywhere });
  }
  return issues;
}

/**
 * One issue for each object_id written in more than one row, in the order the
 * ids first appear, and whether a site running `frameworkVersion` reads the
 * last row everywhere. The Compositor holds one row per id, the last, so a
 * publish keeps only that row.
 */
export function repeatedIdIssues<T extends { object_id: string }>(
  objects: readonly T[],
  frameworkVersion: string | null | undefined,
): SheetIssue[] {
  const sameRowEverywhere = readsLastRowEverywhere(frameworkVersion);
  const counts = new Map<string, number>();
  for (const o of objects) counts.set(o.object_id, (counts.get(o.object_id) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([id]) => ({ code: "object_id_repeated", id, sameRowEverywhere }));
}
