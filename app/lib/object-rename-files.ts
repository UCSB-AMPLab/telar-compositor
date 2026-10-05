/**
 * The repository files an object's rename moves, copies and rewrites.
 *
 * Every move and copy names a blob already in the tree by its SHA and mode,
 * so no image is downloaded or uploaded: the commit puts the same blob at the
 * new path and, for a move, removes the path it stood at.
 *
 * The object's own flat stems are `objectFileStems` over the sheet's ids, which
 * counts every row repeating the old id as the object itself. The flat files under the site-id stem move to
 * `<new id><ext>`, each keeping its own extension. The flat files under the
 * as-written stem, where it differs, move the same way. The old folder layout
 * `<old id>/…` moves to `<new id>/…`. A stem another row also reads as is not
 * the object's alone: each flat file under it is copied, and the file it was
 * copied from stays for the other row.
 *
 * A target is free when no path in the tree, compared ignoring letter case,
 * is already there, other than a file the plan moves away, and no earlier
 * target of the plan claims it; a target that is not free refuses the whole
 * rename with `rename_file_exists`, naming the file in the way.
 *
 * @version v1.5.0-beta
 */

import type { TreeEntry } from "~/lib/github.server";
import { objectFileStems, siteObjectId } from "~/lib/object-id";

/** Where a Telar site keeps its object images. */
const OBJECTS_DIR = "telar-content/objects";

/** A blob put at a path by the SHA and mode it already has in the tree. */
export interface PlacedBlob {
  path: string;
  sha: string;
  mode: string;
}

/** What a rename does to the object's files. */
export type ObjectFilePlan =
  | {
      ok: true;
      /** Blobs placed at their new paths, moves and copies alike. */
      placed: PlacedBlob[];
      /** Old paths a move removes, with the mode they had. */
      removed: { path: string; mode: string }[];
      /** Flat file names moved, each with its new name, for the text rewrites. */
      moved: { from: string; to: string }[];
    }
  | { ok: false; error: "rename_file_exists"; file: string };

/** The plan's inputs, read at one head. */
export interface ObjectFilePlanInput {
  tree: readonly TreeEntry[];
  oldId: string;
  newId: string;
  /** Every row's id in objects.csv at the head, repeats included. */
  sheetIds: readonly string[];
  version: string | null | undefined;
}

/** A flat file of the objects folder: its name, its stem and its extension (dot included). */
interface FlatFile {
  entry: TreeEntry;
  name: string;
  stem: string;
  ext: string;
}

/** The blobs directly in the objects folder, named the way the delete names them. */
function flatFiles(tree: readonly TreeEntry[]): FlatFile[] {
  const files: FlatFile[] = [];
  for (const entry of tree) {
    const parts = entry.path.split("/");
    if (entry.type !== "blob" || parts.length !== 3 || `${parts[0]}/${parts[1]}` !== OBJECTS_DIR) continue;
    const name = parts[2];
    const stem = name.replace(/\.[^.]+$/, "");
    files.push({ entry, name, stem, ext: name.slice(stem.length) });
  }
  return files;
}

/** The blobs under the old folder layout `<old id>/…`. */
function folderFiles(tree: readonly TreeEntry[], oldId: string): TreeEntry[] {
  const prefix = `${OBJECTS_DIR}/${oldId}/`;
  return tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix));
}

/** The stems a rename moves files under and the stems it copies them under. */
function stemsOf(input: ObjectFilePlanInput): { moving: string[]; copying: string[] } {
  const { oldId, sheetIds, version } = input;
  const owned = objectFileStems(oldId, sheetIds, version);
  const siteId = siteObjectId(oldId, version);
  const ordered = [...new Set([siteId, oldId])].filter((stem) => stem !== "");
  return {
    moving: ordered.filter((stem) => owned.has(stem)),
    copying: ordered.filter((stem) => !owned.has(stem)),
  };
}

/** The paths already taken, lowercased, each mapped to its own spelling. */
function takenPaths(tree: readonly TreeEntry[], leaving: ReadonlySet<string>): Map<string, string> {
  const taken = new Map<string, string>();
  for (const entry of tree) {
    if (!leaving.has(entry.path)) taken.set(entry.path.toLowerCase(), entry.path);
  }
  return taken;
}

/**
 * The plan for renaming `oldId` to `newId`'s files, or `rename_file_exists`
 * with the name, inside the objects folder, of the first file in the way.
 */
export function planObjectFileMoves(input: ObjectFilePlanInput): ObjectFilePlan {
  const { tree, oldId, newId } = input;
  const { moving, copying } = stemsOf(input);
  const flat = flatFiles(tree);
  const movingFiles = flat.filter((file) => moving.includes(file.stem));
  const copyingFiles = flat.filter((file) => copying.includes(file.stem));
  const folder = folderFiles(tree, oldId);

  const leaving = new Set([...movingFiles.map((file) => file.entry.path), ...folder.map((entry) => entry.path)]);
  const taken = takenPaths(tree, leaving);
  const placed: PlacedBlob[] = [];
  const place = (entry: TreeEntry, path: string): string | null => {
    const existing = taken.get(path.toLowerCase());
    if (existing !== undefined) return existing.slice(OBJECTS_DIR.length + 1);
    taken.set(path.toLowerCase(), path);
    placed.push({ path, sha: entry.sha, mode: entry.mode });
    return null;
  };

  const moved: { from: string; to: string }[] = [];
  for (const file of [...movingFiles, ...copyingFiles]) {
    const blocked = place(file.entry, `${OBJECTS_DIR}/${newId}${file.ext}`);
    if (blocked !== null) return { ok: false, error: "rename_file_exists", file: blocked };
    if (movingFiles.includes(file)) moved.push({ from: file.name, to: `${newId}${file.ext}` });
  }
  for (const entry of folder) {
    const blocked = place(entry, `${OBJECTS_DIR}/${newId}/${entry.path.slice(OBJECTS_DIR.length + oldId.length + 2)}`);
    if (blocked !== null) return { ok: false, error: "rename_file_exists", file: blocked };
  }

  const removed = [...movingFiles.map((file) => file.entry), ...folder].map((entry) => ({ path: entry.path, mode: entry.mode }));
  return { ok: true, placed, removed, moved };
}

/**
 * The moved names a bare carousel value would find in `assets/images` first,
 * as `_find_file` looks there (scripts/telar/images.py): the name as written,
 * its lowercase form, and the name with its extension in upper or lower case.
 */
export function carouselShadowedNames(tree: readonly TreeEntry[], names: readonly string[]): string[] {
  const images = new Set(
    tree
      .filter((entry) => entry.type === "blob" && /^assets\/images\/[^/]+$/.test(entry.path))
      .map((entry) => entry.path.slice("assets/images/".length)),
  );
  return names.filter((name) => {
    const dot = name.lastIndexOf(".");
    const variants = [name, name.toLowerCase()];
    if (dot > 0) {
      const stem = name.slice(0, dot);
      variants.push(stem + name.slice(dot).toUpperCase(), stem + name.slice(dot).toLowerCase());
    }
    return variants.some((variant) => images.has(variant));
  });
}

/** The CSVs the framework never reads as stories (scripts/telar/core.py `system_csvs`). */
const SYSTEM_CSVS = new Set(["project.csv", "proyecto.csv", "objects.csv", "objetos.csv"]);

/**
 * True for a story CSV: a `.csv` directly in telar-content/spreadsheets other
 * than the system files, named exactly as the framework's glob and exclusion
 * name them. glossary.csv is among them, as the framework converts it too.
 */
export function isStoryCsvPath(path: string): boolean {
  const match = /^telar-content\/spreadsheets\/([^/]+\.csv)$/.exec(path);
  return match !== null && !SYSTEM_CSVS.has(match[1]);
}

/** The folders whose Markdown files a rename reads and rewrites. */
const TEXT_FOLDERS = ["telar-content/texts/stories/", "telar-content/texts/pages/", "telar-content/texts/glossary/"];

/**
 * The Markdown files a rename rewrites: every `.md` blob, at any depth, under
 * the story layer, page and glossary folders.
 */
export function renameTextFilePaths(tree: readonly TreeEntry[]): string[] {
  return tree
    .filter((entry) => entry.type === "blob" && entry.path.endsWith(".md"))
    .map((entry) => entry.path)
    .filter((path) => TEXT_FOLDERS.some((folder) => path.startsWith(folder)));
}
