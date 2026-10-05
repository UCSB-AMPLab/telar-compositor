/**
 * The block a publish wrote for a page whose stored settings it could not
 * read, stored once the publish has landed, and the publish snapshot kept in
 * step with it.
 *
 * A stored block that does not read as a mapping is published with the page's
 * title alone (`replacesPageFrontmatter`). The publish review warns of it
 * beforehand; after the commit lands, the block of the file written is stored
 * on the page through the collaboration object, only where the page still
 * holds the block the publish read, so the Pages screen judges the settings
 * the site has.
 *
 * The last publish recorded the page's hash with the old block, so once the
 * written one is stored the page would hash differently and the publish review
 * would list it as changed although its file has not. So the snapshot's entry
 * is moved to the page's hash now. The move is judged from the entry itself:
 * a page entry is the JSON of its hash input (`buildPageContentHashes`), so an
 * entry recording a block the writer replaces with the title, beside a page
 * with the same title, body and slug whose block is the one that write
 * produces, describes a page whose file is unchanged. That judgement needs
 * nothing remembered from the publish, so the Publish loader applies it too
 * (`snapshotSettledOnLoad`): a move that failed after the block was stored is
 * made at the next load.
 *
 * Nothing here throws into the publish: the commit has landed. A failure
 * leaves the page as it was before, with the warning showing, and the next
 * publish sends it again.
 *
 * @version v1.5.0-beta
 */

import { capturedFrontmatter } from "~/lib/page-frontmatter.server";
import {
  buildPageContentHashes,
  replacesPageFrontmatter,
  serializePageMarkdown,
  type PublishPageRow,
  type PublishSnapshot,
} from "~/lib/publish.server";
import { pageIdsIn, postPageIngest } from "~/lib/page-capture.server";
import { parsedSnapshot } from "~/lib/page-capture-snapshot.server";
import type { IngestPageStoreWritten } from "../../workers/page-store-written";

/** A page as the publish captured it, by row id. */
export type WrittenPage = Pick<PublishPageRow, "slug" | "title" | "body" | "frontmatter"> & { id: number };

/** How many times the move is tried when a publish rewrites the snapshot meanwhile. */
const MOVE_TRIES = 3;

/** The block of the file a publish writes for this page, cut as the import cuts it. */
export async function writtenFrontmatterBlock(
  title: string,
  body: string,
  frontmatter: string | null,
  slug: string,
): Promise<string> {
  return capturedFrontmatter(await serializePageMarkdown(title, body, frontmatter, slug));
}

/** One entry per captured page whose stored block the publish replaced with its title. */
export async function writtenFrontmatterEntries(pages: readonly WrittenPage[]): Promise<IngestPageStoreWritten[]> {
  const replaced = pages.filter(replacesPageFrontmatter);
  return Promise.all(replaced.map(async (page) => ({
    pageId: page.id,
    expected: page.frontmatter!,
    frontmatter: await writtenFrontmatterBlock(page.title ?? "", page.body ?? "", page.frontmatter, page.slug ?? ""),
  })));
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** A page's hash input as a snapshot entry records it. */
interface RecordedPage {
  title: string;
  body: string;
  slug: string;
  frontmatter?: string;
}

function recordedPage(entry: string): RecordedPage | null {
  try {
    const parsed = JSON.parse(entry) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as RecordedPage) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `now` is the page `recorded` describes, holding the block a publish
 * of it wrote in place of a block it could not read.
 */
async function isWrittenSince(recorded: string, now: string): Promise<boolean> {
  const before = recordedPage(recorded);
  const after = recordedPage(now);
  if (!before || !after || typeof before.frontmatter !== "string") return false;
  if (before.title !== after.title || before.body !== after.body || before.slug !== after.slug) return false;
  if (!replacesPageFrontmatter(before)) return false;
  return after.frontmatter === await writtenFrontmatterBlock(before.title, before.body, before.frontmatter, before.slug);
}

/**
 * Set the page entry at `slug`, and its legacy `page_hashes` copy where it
 * held the same entry, to `now` when `isWrittenSince` holds; true when it did.
 */
async function moveWrittenEntry(snapshot: PublishSnapshot, slug: string, now: string | undefined): Promise<boolean> {
  const recorded = snapshot.entity_hashes!.pages[slug];
  if (now === undefined || now === recorded || !(await isWrittenSince(recorded, now))) return false;
  snapshot.entity_hashes!.pages[slug] = now;
  if (snapshot.page_hashes?.[slug] === recorded) snapshot.page_hashes[slug] = now;
  return true;
}

/**
 * The snapshot in which each page entry that recorded a block the publish
 * replaced, beside a page now holding the block it wrote (`isWrittenSince`),
 * holds the page's hash now instead; null when no entry moved. `pageHashes`
 * are the pages' hashes now, by slug. The legacy `page_hashes` copy moves with
 * `entity_hashes.pages` where it held the same entry, so the two stay one record.
 */
export async function snapshotPastWrittenFrontmatter(
  snapshotJson: string | null,
  pageHashes: Readonly<Record<string, string>>,
): Promise<string | null> {
  const snapshot = parsedSnapshot(snapshotJson);
  if (!snapshot?.entity_hashes?.pages) return null;
  let moved = false;
  for (const slug of Object.keys(snapshot.entity_hashes.pages)) {
    moved = (await moveWrittenEntry(snapshot, slug, pageHashes[slug])) || moved;
  }
  return moved ? JSON.stringify(snapshot) : null;
}

/**
 * Move the project's publish snapshot past the written blocks, as a
 * compare-and-set on the text it read, retried when a publish lands between
 * the read and the write. Answers the snapshot it wrote, or null when it wrote
 * none.
 */
export async function movePublishSnapshotPastWrittenFrontmatter(
  db: D1Database,
  projectId: number,
  pageHashes: Readonly<Record<string, string>>,
): Promise<string | null> {
  for (let attempt = 0; attempt < MOVE_TRIES; attempt++) {
    const project = await db.prepare("SELECT publish_snapshot FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ publish_snapshot: string | null }>();
    const next = await snapshotPastWrittenFrontmatter(project?.publish_snapshot ?? null, pageHashes);
    if (next === null) return null;
    const write = await db.prepare("UPDATE projects SET publish_snapshot = ? WHERE id = ? AND publish_snapshot = ?")
      .bind(next, projectId, project!.publish_snapshot)
      .run();
    if ((write.meta?.changes ?? 0) > 0) return next;
  }
  return null;
}

/** `snapshotPastWrittenFrontmatter`, or null when it cannot be judged. */
async function settledInMemory(
  snapshotJson: string | null,
  pageHashes: Readonly<Record<string, string>>,
): Promise<string | null> {
  try {
    return await snapshotPastWrittenFrontmatter(snapshotJson, pageHashes);
  } catch (err) {
    console.error("publish review: judging the snapshot past a written page block failed:", err);
    return null;
  }
}

/** `movePublishSnapshotPastWrittenFrontmatter`, logging a failure rather than throwing it. */
async function moveOnLoad(db: D1Database, projectId: number, pageHashes: Readonly<Record<string, string>>): Promise<void> {
  try {
    await movePublishSnapshotPastWrittenFrontmatter(db, projectId, pageHashes);
  } catch (err) {
    console.error("publish review: moving the snapshot past a written page block failed:", err);
  }
}

/**
 * The snapshot the Publish loader compares with: `snapshotJson`, moved past
 * any written block whose move did not land after its publish, judged against
 * `pageHashes`. The answer is always the caller's snapshot moved in memory,
 * never the text D1 holds: `pageHashes` and `snapshotJson` were read together,
 * and D1's snapshot may already hold moves they do not (another load's, or a
 * capture's whose hashes the caller could not read again), so answering with
 * it would compare hashes and a snapshot from different states. D1 is moved
 * as well, as a compare-and-set, only when an entry moves, which no load after
 * the first does; a failure to write it changes nothing the load compares.
 */
export async function snapshotSettledOnLoad(
  db: D1Database,
  projectId: number,
  snapshotJson: string | null,
  pageHashes: Readonly<Record<string, string>>,
): Promise<string | null> {
  const settled = await settledInMemory(snapshotJson, pageHashes);
  if (settled === null) return snapshotJson;
  await moveOnLoad(db, projectId, pageHashes);
  return settled;
}

// ---------------------------------------------------------------------------
// After the publish lands
// ---------------------------------------------------------------------------

/** The pages whose written block the object stored, as they now hash. */
function storedPageHashes(
  pages: readonly WrittenPage[],
  entries: readonly IngestPageStoreWritten[],
  stored: readonly number[],
): Record<string, string> {
  const written = new Map(entries.filter((e) => stored.includes(e.pageId)).map((e) => [e.pageId, e.frontmatter]));
  const rows = pages.filter((p) => written.has(p.id)).map((p) => ({ ...p, frontmatter: written.get(p.id)! }));
  return buildPageContentHashes(rows);
}

/**
 * Store the block the publish wrote for each page whose stored block it
 * replaced with its title, then move the publish snapshot for the pages the
 * collaboration object stored. `pages` are the rows the publish wrote and
 * hashed. Runs after the landed publish is recorded; logs and returns on any
 * failure.
 */
export async function storeWrittenPageFrontmatter(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET" | "DB">,
  projectId: number,
  pages: readonly WrittenPage[],
): Promise<void> {
  try {
    const entries = await writtenFrontmatterEntries(pages);
    if (entries.length === 0) return;
    const answer = await postPageIngest(env, projectId, { storeWrittenFrontmatter: entries });
    if (answer === null) throw new Error("the collaboration object refused the written page blocks");
    const stored = pageIdsIn(answer.body, "storedPages");
    await movePublishSnapshotPastWrittenFrontmatter(env.DB, projectId, storedPageHashes(pages, entries, stored));
  } catch (err) {
    console.error("[publish] storing the page blocks the publish wrote failed", { projectId, err });
  }
}
