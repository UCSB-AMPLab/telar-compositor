/**
 * The files a publish deletes because the story that named them is not
 * written: a story deleted, one whose ID was changed, which the publish
 * writes under the new ID, or a story whose layer was retitled or removed.
 * The step CSVs it leaves are `computeStoryDeletions`'s, and for a renamed
 * story `renamedStorySheets`'s; the layer files are the ones each such CSV
 * names at the head the publish is built on, read as the import reads them,
 * less any a story CSV the publish writes, or another one at the head, names.
 * Each name is resolved to the path the framework reads it from, so the file
 * deleted is the one held, whatever case the CSV spells it in. A left CSV's
 * names are resolved against the files at the head, which is what the site read
 * through it; the names that stay protective are resolved against the files
 * after the publish.
 *
 * @version v1.5.0-beta
 */

import type { CommitFile } from "~/lib/commit.server";
import { getFileAtRef, getSubtreeOids, listSubtreeEntries } from "~/lib/github.server";
import { listStorySheets } from "~/lib/publish.server";
import { namedLayerFiles, resolveLayerPath } from "~/lib/story-content.server";
import { SPREADSHEETS_DIR, STORY_TEXTS_DIR } from "~/lib/story-files.server";
import type { CommitFiles } from "~/lib/story-files.server";

/** The story texts folder as `resolveLayerPath` reads it: files and directories, relative to the folder. */
type TextFiles = Pick<CommitFiles, "texts" | "textDirs">;

type RepoAtRef = { token: string; owner: string; repo: string; ref: string };

/** The sheets the framework does not read as stories (scripts/telar/core.py). */
const NOT_STORY_SHEETS = new Set(["project.csv", "proyecto.csv", "objects.csv", "objetos.csv"]);

/**
 * The CSVs that stories whose ID changed were last written to, as their
 * `source_path` records it in the spreadsheets folder, that no story writes.
 * The Compositor's own record, so it holds with no publish snapshot.
 */
export function renamedStorySheets(stories: ReadonlyArray<{ story_id: string; source_path: string | null }>): string[] {
  const own = new Set(stories.map((s) => `${SPREADSHEETS_DIR}/${s.story_id}.csv`));
  const left = stories
    .map((s) => s.source_path)
    .filter((path): path is string => Boolean(path?.startsWith(`${SPREADSHEETS_DIR}/`)) && !own.has(path!));
  return [...new Set(left)];
}

/**
 * The CSVs this publish writes for stories, whose earlier version at the head
 * names the layer files the story no longer writes: a layer retitled or removed
 * leaves its old file, which only the earlier CSV names.
 */
export function sheetsOfStoriesWritten(
  stories: ReadonlyArray<{ story_id: string }>,
  written: readonly CommitFile[],
): string[] {
  const writes = new Set(written.map((f) => f.path));
  return stories.map((s) => `${SPREADSHEETS_DIR}/${s.story_id}.csv`).filter((path) => writes.has(path));
}

/** The layer references a story CSV at the ref names, or null when it cannot be read or parsed. */
async function layerNamesAt(source: RepoAtRef, csvPath: string): Promise<string[] | null> {
  const read = await getFileAtRef(source.token, source.owner, source.repo, csvPath, source.ref, { strict: true });
  if (read.status !== "ok") return null;
  try {
    const slug = csvPath.slice(csvPath.lastIndexOf("/") + 1).replace(/\.csv$/, "");
    return namedLayerFiles(slug, read.content.replace(/^\uFEFF/, ""), "keep-last");
  } catch {
    return null;
  }
}

/**
 * The files and directories in the story texts folder at the ref, relative to
 * it, or null when the folder cannot be listed completely; empty when it is absent.
 */
async function storyTextFilesAt(source: RepoAtRef): Promise<TextFiles | null> {
  const trees = await getSubtreeOids(source.token, source.owner, source.repo, [source.ref], [STORY_TEXTS_DIR]).catch(() => null);
  if (trees === null || !trees.ok) return null;
  const at = trees.at(source.ref, STORY_TEXTS_DIR);
  if (at.kind === "absent") return { texts: new Map(), textDirs: new Set() };
  if (at.kind !== "tree") return null;
  const listing = await listSubtreeEntries(source.token, source.owner, source.repo, at.oid).catch(() => null);
  return listing === null ? null : { texts: listing.files, textDirs: listing.dirs };
}

/**
 * The layer paths, as the framework resolves them, that the
 * story CSVs directly in the spreadsheets folder at the ref (the framework
 * globs `*.csv` there, not its subfolders) name other than `left` and those this publish writes;
 * null when the folder or any of them cannot be read, or one names a reference
 * whose reading cannot be told (`resolveLayerPath`), since then no
 * file is known to be unnamed.
 */
async function namedByOtherSheets(
  source: RepoAtRef,
  files: TextFiles,
  left: ReadonlySet<string>,
  written: ReadonlySet<string>,
): Promise<Set<string> | null> {
  const listing = await listStorySheets(source).catch(() => null);
  if (listing === null) return null;
  const named = new Set<string>();
  for (const name of listing.keys()) {
    const path = `${SPREADSHEETS_DIR}/${name}`;
    if (name.includes("/") || !name.endsWith(".csv") || NOT_STORY_SHEETS.has(name) || left.has(path) || written.has(path)) continue;
    const names = await layerNamesAt(source, path);
    if (names === null) return null;
    for (const n of names) {
      const resolved = resolveLayerPath(n, files);
      if (resolved.kind === "unreadable") return null;
      if (resolved.kind === "file") named.add(`${STORY_TEXTS_DIR}/${resolved.path}`);
    }
  }
  return named;
}

/**
 * The layer paths, as the framework resolves them, that the story CSVs among
 * `written` name, read as the import reads them; null when one cannot be parsed
 * or names a reference whose reading cannot be told, since then no file is
 * known to be unnamed.
 */
function namedByWrittenSheets(files: TextFiles, written: readonly CommitFile[]): Set<string> | null {
  const named = new Set<string>();
  for (const file of written) {
    const name = file.path.slice(SPREADSHEETS_DIR.length + 1);
    if (!file.path.startsWith(`${SPREADSHEETS_DIR}/`) || name.includes("/") || !name.endsWith(".csv") || NOT_STORY_SHEETS.has(name)) continue;
    try {
      for (const n of namedLayerFiles(name.replace(/\.csv$/, ""), file.content.replace(/^\uFEFF/, ""), "keep-last")) {
        const resolved = resolveLayerPath(n, files);
        if (resolved.kind === "unreadable") return null;
        if (resolved.kind === "file") named.add(`${STORY_TEXTS_DIR}/${resolved.path}`);
      }
    } catch {
      return null;
    }
  }
  return named;
}

/** The layer references the left CSVs name at the ref. */
async function namesInLeftSheets(source: RepoAtRef, leftCsvPaths: readonly string[]): Promise<string[]> {
  const names: string[] = [];
  for (const csvPath of leftCsvPaths) {
    names.push(...((await layerNamesAt(source, csvPath)) ?? []));
  }
  return names;
}

/**
 * The story texts folder after the publish: the files at the head and those it
 * writes, the directories at the head and those the written paths sit in.
 */
function textFilesAfter(atHead: TextFiles, written: readonly CommitFile[]): TextFiles {
  const prefix = `${STORY_TEXTS_DIR}/`;
  const texts = new Map(atHead.texts);
  const textDirs = new Set(atHead.textDirs);
  for (const file of written) {
    if (!file.path.startsWith(prefix)) continue;
    const path = file.path.slice(prefix.length);
    texts.set(path, "");
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) textDirs.add(path.slice(0, slash));
  }
  return { texts, textDirs };
}

/**
 * The layer files each of `leftCsvPaths` names at `source.ref`, other than the
 * files this publish writes (`written`) and those a story CSV in `written`, or
 * another one there, still names. A left CSV that is absent, cannot be read or cannot be parsed
 * names nothing, as does a reference of a left CSV whose reading at the head
 * cannot be told (a directory in its way, a non-ASCII spelling no file matches
 * exactly): the site reads a layer file only through a CSV that names it,
 * so a file left behind changes nothing on the site, and the publish is not
 * refused over it.
 */
export async function deletedStoryLayerFiles(
  source: RepoAtRef,
  leftCsvPaths: readonly string[],
  written: readonly CommitFile[],
): Promise<string[]> {
  const names = await namesInLeftSheets(source, leftCsvPaths);
  if (names.length === 0) return [];
  const atHead = await storyTextFilesAt(source);
  if (atHead === null) return [];
  const files = textFilesAfter(atHead, written);
  const writtenPaths = new Set(written.map((f) => f.path));
  const paths = new Set<string>();
  for (const name of names) {
    const resolved = resolveLayerPath(name, atHead);
    if (resolved.kind !== "file") continue;
    const path = `${STORY_TEXTS_DIR}/${resolved.path}`;
    if (!writtenPaths.has(path)) paths.add(path);
  }
  const writtenNames = paths.size === 0 ? null : namedByWrittenSheets(files, written);
  if (writtenNames === null) return [];
  const named = await namedByOtherSheets(source, files, new Set(leftCsvPaths), writtenPaths);
  return named === null ? [] : [...paths].filter((path) => !named.has(path) && !writtenNames.has(path));
}
