/**
 * A story's step and layer rows read from its files at one commit, for the
 * kept-columns capture: the rows as the framework renders them, and each step's
 * row with its layer file references resolved as the import resolves them.
 *
 * @version v1.5.0-beta
 */

import { resolveLayerFileReferences } from "~/lib/import.server";
import type { StoryLayerRow, StoryStepRow } from "~/lib/publish.server";
import { layerFilesAt, readStory, rowsFromContent } from "~/lib/story-content.server";
import { SPREADSHEETS_DIR, readBlobText } from "~/lib/story-files.server";
import type { CommitFiles, RepoAccess } from "~/lib/story-files.server";

/**
 * A story's rows as `rowsFromContent` gives them, and each step's row with its
 * layer file references resolved as the import resolves them (`imported`:
 * exact names only), by the step row's `id`. The import tested a row's cells
 * after that resolution and before mapping it, so these are the cells it saw.
 */
export interface StoryFileRows {
  stepRows: StoryStepRow[];
  layerRows: StoryLayerRow[];
  importedCells: Record<string, string>[];
}

/**
 * A story's CSV and layer files read into `StoryFileRows`: the layers as the
 * framework reads the references, the cells as the import resolved them.
 */
export async function storyRowsFromFiles(
  id: string,
  csv: string,
  framework: Record<string, string>,
  imported: Record<string, string>,
): Promise<StoryFileRows> {
  const read = await readStory(id, csv, framework);
  const rows = rowsFromContent(read.steps);
  if ("unreadable" in rows) throw new Error(`${id}'s step order could not be read: ${rows.unreadable}`);
  const importedCells = await resolveLayerFileReferences(read.sources, async (name) =>
    Object.hasOwn(imported, name) ? imported[name] : null,
  );
  return { ...rows, importedCells };
}

/** One story's `StoryFileRows` at `head`, from its listed subtrees, read as `storyRowsAt` reads it. */
export async function storyFileRowsAt(
  input: RepoAccess,
  head: string,
  files: CommitFiles,
  id: string,
): Promise<StoryFileRows> {
  const csvSha = files.sheets.get(`${id}.csv`);
  if (csvSha === undefined) return { stepRows: [], layerRows: [], importedCells: [] };
  const csv = await readBlobText(input, head, `${SPREADSHEETS_DIR}/${id}.csv`, csvSha);
  const { framework, imported } = await layerFilesAt(input, head, files, id, csv);
  return storyRowsFromFiles(id, csv, framework, imported);
}
