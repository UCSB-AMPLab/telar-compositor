/**
 * The record of the repository file each story's steps were last read from or
 * written to (`stories.source_path`), for the reads made after the import (a
 * sync that inserts a story or accepts its content, and the restore of an
 * orphan story) and for the files a publish writes.
 *
 * Those read a story's CSV in the spreadsheets folder only. A publish deletes
 * an older copy of a story (`_data/<id>.csv`, `<id>.csv`) only at the recorded
 * path, so a path in the spreadsheets folder, like NULL, names none; recording
 * it keeps the column true to the file the story's steps now come from, over
 * an older copy the import read. The import records its own reads as it
 * inserts the stories.
 *
 * @version v1.5.0-beta
 */

import { and, eq } from "drizzle-orm";
import { stories } from "~/db/schema";
import type { getDb } from "~/lib/db.server";

/** A story's CSV in the spreadsheets folder, the only path a sync or a restore reads it at. */
export function storySheetPath(storyId: string): string {
  return `telar-content/spreadsheets/${storyId}.csv`;
}

/**
 * Records that each story in `storyIds` was read from its CSV in the
 * spreadsheets folder. A story with no row yet is left as it is (NULL, which a
 * publish reads the same way). Called once the read content has been applied;
 * a failure is logged and returns, since a missing record changes no publish.
 */
export async function recordStorySheetReads(
  db: ReturnType<typeof getDb>,
  projectId: number,
  storyIds: readonly string[],
): Promise<void> {
  try {
    for (const storyId of storyIds) {
      await db
        .update(stories)
        .set({ source_path: storySheetPath(storyId) })
        .where(and(eq(stories.project_id, projectId), eq(stories.story_id, storyId)));
    }
  } catch (err) {
    console.error("[stories] recording the path a story was read from failed", { projectId, err });
  }
}

/**
 * After a publish, the writes that record each story of `written` at the CSV
 * the publish wrote for it, which is the file the next publish lays it out
 * from. Matched on the row and the ID the publish read, so a story renamed
 * since keeps its earlier record and a story that took a vacated ID since is
 * given no file it was not written to. The publish runs them in one batch
 * with its record of the landed commit, so the two land or miss together.
 */
export function publishedStorySheetWrites(
  db: ReturnType<typeof getDb>,
  projectId: number,
  written: ReadonlyArray<{ id: number; story_id: string }>,
) {
  return written.map((s) => db
    .update(stories)
    .set({ source_path: storySheetPath(s.story_id) })
    .where(and(eq(stories.project_id, projectId), eq(stories.id, s.id), eq(stories.story_id, s.story_id))));
}
