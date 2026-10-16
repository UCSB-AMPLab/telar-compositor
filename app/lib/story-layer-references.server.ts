/**
 * The layer files a story's step CSV names, and how the framework resolves
 * each reference at a commit: the candidate paths in its order, the ones this
 * side declines to guess at, and the strict read of the files that answer.
 *
 * @version v1.5.5-beta
 */
import { pythonStrip } from "~/lib/column-mapping";
import { STORY_CANONICAL_SCOPE, isLayerFileReference, parseTelarCsv } from "~/lib/import.server";
import type { SeveralHoldValues } from "~/lib/import.server";
import type { SheetWarning } from "~/lib/sheet-warnings";
import { STORY_TEXTS_DIR, readReportedBlobText } from "~/lib/story-files.server";
import type { CommitFiles, RepoAccess } from "~/lib/story-files.server";
import { LayerReferenceUnreadable } from "~/lib/story-unreadable.server";
import type { UnreadableReason } from "~/lib/story-canonical";

/** Every column the framework reads a layer from, however many layers the sheet has (processors/stories.py). */
const LAYER_CELL_SUFFIX = /_(content|file)$/;


/**
 * The paths the framework tries for a layer reference, in its order
 * (the framework's scripts/telar/images.py:143-177,
 * `resolve_path_case_insensitive`, called from markdown.py:187 with
 * `stories/<cell>` under telar-content/texts): the reference as written; its
 * filename lowercased, the directories kept; the whole reference lowercased.
 * Relative to texts/stories, as the story subtree listing is. The two
 * lowercased forms are tried only for an ASCII reference (see
 * `resolveLayerPath`).
 */
export function layerPathCandidates(name: string): string[] {
  if (!isAscii(name)) return [name];
  const slash = name.lastIndexOf("/");
  const lowerFile = slash === -1 ? name.toLowerCase() : name.slice(0, slash + 1) + name.slice(slash + 1).toLowerCase();
  return [name, lowerFile, name.toLowerCase()];
}

export function isAscii(text: string): boolean {
  return /^[\x00-\x7f]*$/.test(text);
}

/** Every segment non-empty and none "." or "..": no "./", no "//", no trailing "/". */
export function isPlainReference(name: string): boolean {
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export type LayerResolution = { kind: "file"; path: string } | { kind: "absent" } | { kind: "unreadable"; reason: UnreadableReason };

/**
 * The file the framework reads for a layer reference at a commit, that it
 * reads none (so it shows the cell's own text), or that this cannot be told.
 *
 * Complete by construction: the only references resolved are plain ASCII
 * ones, whose three candidate paths Python's `Path` and `str.lower()` and
 * JavaScript's string operations compute alike, and exact matches of any
 * reference. Everything else is unreadable, never a wrong reading:
 * - a reference that is not a plain path (`isPlainReference`), which
 *   Python's `Path` normalises in ways not emulated here;
 * - a non-ASCII reference with no exact match, since the two languages'
 *   Unicode lowercasing tables differ (U+A7CE lowercases in one and not the
 *   other);
 * - a directory at a path the framework tries before any file, where
 *   `exists()` finds the directory and the framework falls back to the
 *   cell's text. The paths are tried in the framework's order, so a file
 *   found first is read whatever a later path holds.
 */
export function resolveLayerPath(name: string, files: Pick<CommitFiles, "texts" | "textDirs">): LayerResolution {
  if (!isPlainReference(name)) return { kind: "unreadable", reason: { code: "layer_reference_not_plain", reference: name } };
  for (const path of layerPathCandidates(name)) {
    if (files.textDirs.has(path)) return { kind: "unreadable", reason: { code: "layer_reference_directory", reference: name } };
    if (files.texts.has(path)) return { kind: "file", path };
  }
  if (!isAscii(name)) {
    return { kind: "unreadable", reason: { code: "layer_reference_non_ascii", reference: name } };
  }
  return { kind: "absent" };
}

/** The layer file names a step CSV's cells reference, as the import resolves them. */
export function namedLayerFiles(slug: string, csv: string, severalHoldValues: SeveralHoldValues = "refuse"): string[] {
  const rows = parseTelarCsv(csv, undefined, false, STORY_CANONICAL_SCOPE, {
    severalHoldValues,
    sheetName: `${slug}.csv`,
  });
  const names = new Set<string>();
  for (const row of rows) {
    for (const col of Object.keys(row)) {
      if (LAYER_CELL_SUFFIX.test(col) && isLayerFileReference(row[col])) names.add(pythonStrip(row[col]));
    }
  }
  return [...names];
}

/**
 * The layer files a story's CSV names, read strictly at `commit`: as the
 * framework reads the references (`resolveLayerPath`), and as the import
 * does, which fetches the exact name only. A reference no file answers is
 * left out of both, so its cell reads inline. `severalHoldValues` is the CSV
 * parse's, as `readStory` takes it; `warnings` names each file of invalid
 * UTF-8, and `onLossy` is handed its path.
 */
export async function layerFilesAt(
  input: RepoAccess,
  commit: string,
  files: CommitFiles,
  id: string,
  csv: string,
  severalHoldValues: SeveralHoldValues = "refuse",
  warnings?: SheetWarning[],
  onLossy?: (path: string) => void,
): Promise<{ framework: Record<string, string>; imported: Record<string, string> }> {
  const framework: Record<string, string> = {};
  const imported: Record<string, string> = {};
  for (const name of namedLayerFiles(id, csv, severalHoldValues)) {
    const resolved = resolveLayerPath(name, files);
    if (resolved.kind === "unreadable") throw new LayerReferenceUnreadable(resolved.reason);
    if (resolved.kind === "absent") continue;
    const path = resolved.path;
    const text = await readReportedBlobText(input, commit, `${STORY_TEXTS_DIR}/${path}`, files.texts.get(path)!, warnings, undefined, onLossy);
    framework[name] = text;
    if (path === name) imported[name] = text;
  }
  return { framework, imported };
}
