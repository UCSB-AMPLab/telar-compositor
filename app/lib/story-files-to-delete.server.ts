/**
 * The story CSVs a first publish owes the repository a deletion of
 * (`projects.story_files_to_delete_json`). With no publish snapshot nothing
 * names a deleted story's CSV, so the reads that bring a story in (the import,
 * a sync that inserts one) record its CSV in the spreadsheets folder with the
 * blob read. The publish deletes a recorded CSV, with its layer files, when
 * D1 no longer holds its story and the file still has the blob read; a file
 * changed since is left and named. The record is cleared when the publish
 * lands, and nothing is recorded once a snapshot exists.
 *
 * @version v1.5.0-beta
 */

import { eq } from "drizzle-orm";
import { projects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import type { FileAtRef } from "~/lib/github.server";
import type { ValidationItem } from "~/lib/publish.server";
import { SPREADSHEETS_DIR, gitBlobSha } from "~/lib/story-files.server";

export interface OwedStoryFile {
  path: string;
  sha: string;
}

/** The recorded files, or none for a missing or unreadable record. */
export function parseOwedStoryFiles(json: string | null | undefined): OwedStoryFile[] {
  try {
    const parsed: unknown = JSON.parse(json ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((e): e is OwedStoryFile => typeof e?.path === "string" && typeof e?.sha === "string")
      : [];
  } catch {
    return [];
  }
}

/** The warning naming a recorded file the publish leaves because it changed on GitHub. */
export function keptChangedWarnings(paths: readonly string[]): ValidationItem[] {
  return paths.map((file) => ({ code: "story_file_kept_changed", message: "story_file_kept_changed", entityId: file, params: { file } }));
}

/**
 * The record of a story CSV read: its path in the spreadsheets folder and the
 * blob of `raw`, the file's text as a strict read gives it, a leading
 * byte-order mark kept, which is what the publish compares against.
 */
export async function storyFileRead(path: string | null, raw: string | null): Promise<OwedStoryFile[]> {
  return path?.startsWith(`${SPREADSHEETS_DIR}/`) && raw !== null ? [{ path, sha: await gitBlobSha(raw) }] : [];
}

/**
 * Adds `reads` to the record, a path read again replacing its entry. Nothing is
 * recorded once the project has a publish snapshot. A failure is logged and
 * returns: a missing entry leaves a file in the repository, as before.
 */
export async function recordStoryFileReads(
  db: ReturnType<typeof getDb>,
  projectId: number,
  reads: readonly OwedStoryFile[],
): Promise<void> {
  if (reads.length === 0) return;
  try {
    const [project] = await db
      .select({ snapshot: projects.publish_snapshot, owed: projects.story_files_to_delete_json })
      .from(projects)
      .where(eq(projects.id, projectId));
    if (!project || project.snapshot) return;
    const paths = new Set(reads.map((r) => r.path));
    const next = [...parseOwedStoryFiles(project.owed).filter((e) => !paths.has(e.path)), ...reads];
    await db.update(projects).set({ story_files_to_delete_json: JSON.stringify(next) }).where(eq(projects.id, projectId));
  } catch (err) {
    console.error("[stories] recording the story files read failed", { projectId, err });
  }
}

/**
 * The recorded CSVs to delete (`paths`) and those left because the file is no
 * longer the blob read (`changed`). A story D1 holds, or a file already gone,
 * owes nothing. A read that fails throws, since a file left unjudged would be
 * dropped from the record when the publish lands.
 */
export async function owedStoryDeletions(
  owed: readonly OwedStoryFile[],
  d1StoryIds: readonly string[],
  read: (path: string) => Promise<FileAtRef>,
): Promise<{ paths: string[]; changed: string[] }> {
  const held = new Set(d1StoryIds.map((id) => `${SPREADSHEETS_DIR}/${id}.csv`));
  const result = { paths: [] as string[], changed: [] as string[] };
  for (const entry of owed.filter((e) => !held.has(e.path))) {
    const file = await read(entry.path);
    if (file.status === "error") throw new Error(`could not read ${entry.path} to tell whether it changed`);
    if (file.status !== "ok") continue;
    (await gitBlobSha(file.content) === entry.sha ? result.paths : result.changed).push(entry.path);
  }
  return result;
}
