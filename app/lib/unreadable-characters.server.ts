/**
 * The warning for a file read at the head whose bytes are not valid UTF-8.
 *
 * The framework reads every file the Compositor writes with strict UTF-8, so
 * such a file is already broken on the site: a story's step CSV is left out,
 * a story layer file shows its own name in place of its text, and any other
 * file stops the build. A publish writes the file as valid UTF-8, with
 * U+FFFD where the invalid bytes were, which repairs it. The warning names
 * the file, says which of these the site does, and says what makes the next
 * publish write it.
 *
 * A site with Google Sheets on takes each sheet the published sheet has a tab
 * for from that tab, over GitHub's copy (`fetch_google_sheets.py`), so an
 * invalid byte in GitHub's copy of such a sheet changes nothing on the site.
 * The tabs are listed only when a warning names a sheet.
 *
 * A story CSV the import finds at an older path is not one the publish
 * writes: it writes the story to telar-content/spreadsheets. At `_data/` the
 * file is read by Jekyll as site data, which stops the build on such bytes;
 * anywhere else the framework does not read it (`csv_to_json.py` reads the
 * spreadsheets folder only), so the site is not affected. The publish that
 * first writes the story's CSV in the spreadsheets folder deletes such a copy
 * (`olderStoryCopies`), which is the repair either warning names. It deletes
 * a `_data` copy whose bytes are not valid UTF-8 whatever the story was read
 * from, and a root copy only when the story was read from it
 * (`stories.source_path`): the import reads a root copy, and so warns about
 * one, only when it is the story's source.
 *
 * @version v1.5.0-beta
 */

import { getFileAtRef } from "~/lib/github.server";
import { googleSheetsBlock, isPyYamlTrue, mappingValue, STR_TAG, type PyYamlNode } from "~/lib/pyyaml";
import type { SheetWarning, UnreadableEffect, UnreadableRepair } from "~/lib/sheet-warnings";
import { discoverSheetTabs } from "~/lib/sheets.server";
import { writtenSheetName } from "~/lib/site-sheets.server";

const SHEETS_DIR = "telar-content/spreadsheets/";
const JEKYLL_DATA_DIR = "_data/";
const STORY_TEXTS_DIR = "telar-content/texts/stories/";
/** The sheets the site stops building on; every other CSV is a story's steps. */
const SITE_SHEETS = new Set(["objects.csv", "objetos.csv", "project.csv", "proyecto.csv", "glossary.csv"]);

type UnreadableWarning = Extract<SheetWarning, { code: "unreadable_characters" }>;

/** Whether a repository path is a sheet the site reads: a CSV in the spreadsheets folder. */
function isSheetPath(path: string): boolean {
  return path.startsWith(SHEETS_DIR) && path.endsWith(".csv");
}

/** Whether a repository path is a CSV outside the spreadsheets folder, which no publish writes. */
function isOlderStoryPath(path: string): boolean {
  return !path.startsWith(SHEETS_DIR) && path.endsWith(".csv");
}

/** What the author sees: a sheet's file name, any other file's path. */
export function unreadableFileName(path: string): string {
  return isSheetPath(path) ? path.slice(SHEETS_DIR.length) : path;
}

/** What the site does with the file, before Google Sheets is considered. */
export function unreadableEffectOf(path: string): Exclude<UnreadableEffect, "from_sheets"> {
  if (path.startsWith(STORY_TEXTS_DIR)) return "name_shown";
  if (isOlderStoryPath(path)) return path.startsWith(JEKYLL_DATA_DIR) ? "build_stops" : "not_used";
  if (isSheetPath(path) && !SITE_SHEETS.has(unreadableFileName(path))) return "left_out";
  return "build_stops";
}

/**
 * Adds the warning for a file read lossily at the head to `sink`, once per
 * file: a list that already names the file is left as it is.
 */
export function pushUnreadable(sink: SheetWarning[] | undefined, path: string, repair: UnreadableRepair = "publish"): void {
  if (!sink) return;
  const file = unreadableFileName(path);
  if (names(sink, file)) return;
  sink.push({ code: "unreadable_characters", file, effect: unreadableEffectOf(path), repair: isOlderStoryPath(path) ? "remove_old_copy" : repair });
}

/**
 * Appends `from` to `into`, leaving out a warning for a file `into` already
 * names as unreadable.
 */
export function appendWarnings(into: SheetWarning[], from: readonly SheetWarning[]): void {
  for (const w of from) {
    if (w.code === "unreadable_characters" && names(into, w.file)) continue;
    into.push(w);
  }
}

/** The files `warnings` names as unreadable. */
export function unreadableNames(warnings: readonly SheetWarning[]): string[] {
  return warnings.flatMap((w) => (w.code === "unreadable_characters" ? [w.file] : []));
}

function names(warnings: readonly SheetWarning[], file: string): boolean {
  return warnings.some((w) => w.code === "unreadable_characters" && w.file === file);
}

/** A site's Google Sheets settings: whether the build fetches the sheet, and from where. */
export interface SheetsSource {
  enabled: boolean;
  publishedUrl: string | null | undefined;
}

/**
 * The Google Sheets settings a `_config.yml` gives the build, or null for no
 * file. The file is read as PyYAML's `safe_load` reads it (`composePyYaml`),
 * which is how the build reads it: the build fetches the published sheet when
 * `google_sheets.enabled` loads as the boolean true (`yes`, `on` and `TRUE`
 * included), from `google_sheets.published_url` loaded as a string, block
 * scalars and escapes resolved, with its surrounding whitespace removed. A file
 * that does not load stops the build's own read, and gives Sheets off. D1's
 * copy of the setting can disagree with the file, and only the file decides.
 */
export function configSheets(configYml: string | null): SheetsSource | null {
  if (configYml === null) return null;
  const block = googleSheetsBlock(configYml);
  const url = stringValue(block, "published_url")?.trim();
  return { enabled: isPyYamlTrue(block && mappingValue(block, "enabled")), publishedUrl: url || null };
}

/** The text of `key` in `block` where it loads as a string, else undefined. */
function stringValue(block: PyYamlNode | undefined, key: string): string | undefined {
  const node = block && mappingValue(block, key);
  return node?.kind === "scalar" && node.tag === STR_TAG ? node.text : undefined;
}

/**
 * The Google Sheets settings of the `_config.yml` at `head`, read when the
 * returned loader is called: null when there is no head, or the file is absent
 * or cannot be read, which marks no sheet as taken from Google Sheets.
 */
export function headConfigSheets(
  token: string,
  owner: string,
  repo: string,
  head: string | undefined,
): () => Promise<SheetsSource | null> {
  return async () => {
    if (!head) return null;
    const read = await getFileAtRef(token, owner, repo, "_config.yml", head, { strict: true });
    return read.status === "ok" ? configSheets(read.content.replace(/^\uFEFF/, "")) : null;
  };
}

/**
 * Whether `glossary.csv` stands at `head`, for `markSheetsEffects`: false only
 * where the read finds it absent, which is when the build reads `glosario.csv`
 * as the glossary. No head, or a read that fails, answers true, which leaves
 * the effect as `unreadableEffectOf` gave it.
 */
export function headHasGlossaryCsv(
  token: string,
  owner: string,
  repo: string,
  head: string | undefined,
): () => Promise<boolean> {
  return async () => {
    if (!head) return true;
    const read = await getFileAtRef(token, owner, repo, `${SHEETS_DIR}glossary.csv`, head, { strict: true });
    return read.status !== "absent";
  };
}

/** The sheet file names the build writes from the published sheet's tabs. */
function sheetFilesFromTabs(tabs: ReadonlyArray<{ name: string }>): Set<string> {
  return new Set(tabs.filter((tab) => !tab.name.startsWith("#")).map((tab) => `${tab.name.toLowerCase()}.csv`));
}

/** The warnings in `warnings` that name a sheet the site reads. */
function sheetFileWarnings(warnings: SheetWarning[]): UnreadableWarning[] {
  return warnings.filter(
    (w): w is UnreadableWarning =>
      w.code === "unreadable_characters" && w.effect !== "not_used" && !w.file.includes("/") && w.file.endsWith(".csv"),
  );
}

/**
 * Sets `from_sheets` on each warning naming a sheet the published sheet has a
 * tab for, when Google Sheets is on. The settings, when given as a loader, and
 * the tabs are read only when a warning names a sheet; a listing that fails
 * leaves every effect as it is.
 *
 * `glossaryCsvPresent` settles `glosario.csv`: the build reads it as the
 * glossary, and stops on it, only where `glossary.csv` is not there; beside
 * one it is a story, left out. Without it the file keeps the effect it has.
 *
 * Removes each misread-heading warning on such a sheet's repository file
 * (`dropSheetsSuppliedHeadings`).
 */
export async function markSheetsEffects(
  warnings: SheetWarning[] = [],
  source: SheetsSource | null | undefined | (() => Promise<SheetsSource | null>),
  listTabs: (url: string) => Promise<Array<{ name: string }>> = discoverSheetTabs,
  glossaryCsvPresent?: () => Promise<boolean>,
): Promise<void> {
  const named = sheetFileWarnings(warnings);
  if (named.length === 0 && !warnings.some((w) => w.code === "header_spelling")) return;
  await settleGlosario(named, glossaryCsvPresent);
  const fromTabs = await sheetFilesFromSheets(typeof source === "function" ? await source() : source, listTabs);
  for (const w of named) {
    if (fromTabs.has(w.file)) w.effect = "from_sheets";
  }
  dropSheetsSuppliedHeadings(warnings, fromTabs);
}

/**
 * `listTabs` made to list each published URL once, so the several readers of one
 * check (`markSheetsEffects`, `withoutSheetsSupplied`) share a single listing.
 */
export function listTabsOnce(
  listTabs: (url: string) => Promise<Array<{ name: string }>> = discoverSheetTabs,
): (url: string) => Promise<Array<{ name: string }>> {
  const listed = new Map<string, Promise<Array<{ name: string }>>>();
  return (url) => {
    if (!listed.has(url)) listed.set(url, listTabs(url));
    return listed.get(url)!;
  };
}

/**
 * The repository sheet files whose content the build reads, out of `files`:
 * those a Google Sheets tab does not supply (`suppliedByTab`). A listing that
 * fails, or Sheets off, keeps every file.
 */
export async function withoutSheetsSupplied(
  files: string[],
  source: SheetsSource | null | undefined | (() => Promise<SheetsSource | null>),
  listTabs: (url: string) => Promise<Array<{ name: string }>> = discoverSheetTabs,
): Promise<string[]> {
  if (files.length === 0) return files;
  const fromTabs = await sheetFilesFromSheets(typeof source === "function" ? await source() : source, listTabs);
  return files.filter((f) => !suppliedByTab(f, fromTabs));
}

/** Marks `glosario.csv` as stopping the build where `glossary.csv` is not there (`markSheetsEffects`). */
async function settleGlosario(named: UnreadableWarning[], glossaryCsvPresent?: () => Promise<boolean>): Promise<void> {
  const glosario = named.filter((w) => w.file === "glosario.csv" && w.effect === "left_out");
  if (glosario.length === 0 || !glossaryCsvPresent || (await glossaryCsvPresent())) return;
  for (const w of glosario) w.effect = "build_stops";
}

/**
 * Removes each misread-heading warning on a repository file whose sheet the
 * build takes from a Google Sheets tab instead (`fromTabs`): the publish that
 * rewrites the file changes nothing the site reads. Matched on the file the
 * publish writes, since `objetos.csv` is published as `objects.csv`, which the
 * build fetches the `objects` tab over. A warning on the tab itself
 * (`fromGoogleSheets`) stays.
 */
function dropSheetsSuppliedHeadings(warnings: SheetWarning[], fromTabs: ReadonlySet<string>): void {
  for (let i = warnings.length - 1; i >= 0; i--) {
    const w = warnings[i];
    if (w.code === "header_spelling" && !w.fromGoogleSheets && suppliedByTab(w.sheet, fromTabs)) warnings.splice(i, 1);
  }
}

/** Whether a tab supplies the file, under its own name or the one the publish writes it as. */
function suppliedByTab(fileName: string, fromTabs: ReadonlySet<string>): boolean {
  return fromTabs.has(fileName) || fromTabs.has(writtenSheetName(fileName));
}

/**
 * The sheet files the build takes from the published sheet: none when Google
 * Sheets is off, has no published URL, or its tabs cannot be listed.
 */
async function sheetFilesFromSheets(
  sheets: SheetsSource | null | undefined,
  listTabs: (url: string) => Promise<Array<{ name: string }>>,
): Promise<Set<string>> {
  if (!sheets?.enabled || !sheets.publishedUrl) return new Set();
  try {
    return sheetFilesFromTabs(await listTabs(sheets.publishedUrl));
  } catch {
    return new Set();
  }
}
