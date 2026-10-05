/**
 * The last publish's snapshot, moved past a front matter capture so that the
 * capture never makes a page read as changed.
 *
 * A page's hash takes its front matter only when it has some
 * (`buildPageContentHashes`), so a legacy page published before its block was
 * stored was recorded without it. Once the Pages loader captures the block,
 * the same page hashes differently and the publish review would list it as
 * changed although nobody edited it. So, after the collaboration object has
 * stored the blocks, each captured page's entry in `projects.publish_snapshot`
 * is moved to the hash the page has now, and only where the entry holds the
 * hash the page had before the capture: a page edited since the last publish
 * does not match it and still reads as changed.
 *
 * The snapshot is written by the publish action too, so the move is a
 * compare-and-set on the text it read, retried when a publish lands between
 * the read and the write.
 *
 * @version v1.5.0-beta
 */

import { buildPageContentHashes, type PublishSnapshot } from "~/lib/publish.server";

/** A page row as the snapshot's hash reads it. */
interface HashedRow {
  slug: string;
  title: string;
  body: string | null;
  frontmatter: string | null;
}

/** How many times the move is tried when a publish rewrites the snapshot meanwhile. */
const MOVE_TRIES = 3;

/** The snapshot's text parsed, or null for none or for text that is not JSON. */
export function parsedSnapshot(snapshotJson: string | null): PublishSnapshot | null {
  if (!snapshotJson) return null;
  try {
    return JSON.parse(snapshotJson) as PublishSnapshot;
  } catch {
    return null;
  }
}

/** Replace `before` with `after` at `key` where it stands; true when it did. */
function moveEntry(hashes: Record<string, string> | undefined, key: string, before: string, after: string): boolean {
  if (!hashes || hashes[key] !== before) return false;
  hashes[key] = after;
  return true;
}

/**
 * One captured page's entries, `entity_hashes.pages` and the legacy
 * `page_hashes` copy, set to its hash now where they hold its pre-capture
 * hash. True when either did.
 */
function moveRowEntries(snapshot: PublishSnapshot, row: HashedRow): boolean {
  const [key, after] = Object.entries(buildPageContentHashes([row]))[0] ?? [];
  const before = buildPageContentHashes([{ ...row, frontmatter: null }])[key ?? ""];
  if (key === undefined || before === undefined || before === after) return false;
  const inEntities = moveEntry(snapshot.entity_hashes?.pages, key, before, after);
  const inLegacy = moveEntry(snapshot.page_hashes, key, before, after);
  return inEntities || inLegacy;
}

/**
 * The snapshot in which each captured page's entry that held its
 * pre-capture hash holds its hash now instead, or null when no entry did. `rows` are the pages as
 * D1 holds them after the capture. The legacy `page_hashes` copy moves with
 * `entity_hashes.pages` so the two stay one record.
 */
export function snapshotPastCaptures(snapshotJson: string | null, rows: readonly HashedRow[]): string | null {
  const snapshot = parsedSnapshot(snapshotJson);
  if (!snapshot?.entity_hashes?.pages) return null;
  let moved = false;
  for (const row of rows) moved = moveRowEntries(snapshot, row) || moved;
  return moved ? JSON.stringify(snapshot) : null;
}

/** Move the project's publish snapshot past the capture of `pageIds`; see the module comment. */
export async function movePublishSnapshotPastCaptures(db: D1Database, projectId: number, pageIds: readonly number[]): Promise<void> {
  if (pageIds.length === 0) return;
  const marks = pageIds.map(() => "?").join(", ");
  for (let attempt = 0; attempt < MOVE_TRIES; attempt++) {
    const project = await db.prepare("SELECT publish_snapshot FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ publish_snapshot: string | null }>();
    const rows = await db.prepare(
      `SELECT id, slug, title, body, frontmatter FROM project_pages WHERE project_id = ? AND id IN (${marks})`,
    )
      .bind(projectId, ...pageIds)
      .all<HashedRow>();
    const next = snapshotPastCaptures(project?.publish_snapshot ?? null, rows.results);
    if (next === null) return;
    const write = await db.prepare("UPDATE projects SET publish_snapshot = ? WHERE id = ? AND publish_snapshot = ?")
      .bind(next, projectId, project!.publish_snapshot)
      .run();
    if ((write.meta?.changes ?? 0) > 0) return;
  }
}
