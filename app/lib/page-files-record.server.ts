/**
 * What each writer of the page files record records, and the publish's
 * deletions from it. The record's type and its stored text are in
 * `page-files-record.ts`.
 *
 * A publish deletes each recorded file no page it captured holds, beside the
 * files its snapshot's `page_slugs` names, so a page renamed or deleted before
 * any publish recorded its slug leaves no file behind.
 *
 * @version v1.5.0-beta
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { projects } from "~/db/schema";
import { getRepoHead } from "~/lib/github.server";
import type { PublishSnapshot } from "~/lib/publish.server";
import { PAGE_TEXTS_DIR, heldPageFileName, pageFolderFiles } from "~/lib/page-content.server";
import type { RepoAccess } from "~/lib/story-files.server";
import {
  isRecordedPageFileName,
  mergedPageFilesRecord,
  parsePageFilesRecord,
  serialisePageFilesRecord,
} from "~/lib/page-files-record";
import type { PageFilesRecord } from "~/lib/page-files-record";
import { reduceScannedPages } from "~/lib/one-language-pages";
import type { ScannedPage } from "~/lib/import.server";

/** A page as the record reads it: its row id and the slug its file is at. */
export interface RecordedPage {
  id: number;
  slug: string | null;
}

/** How many times a merge is tried when another writer changes the record meanwhile. */
const MERGE_TRIES = 3;

/** Each page's held file name mapped to its id; a page held by no file is left out. */
function heldFiles(pages: readonly RecordedPage[]): Map<string, number> {
  const held = new Map<string, number>();
  for (const page of pages) {
    const name = heldPageFileName(page);
    if (name !== null) held.set(name, page.id);
  }
  return held;
}

/**
 * The record a landed publish writes at `commit`: every page it captured that
 * is held by a file (`heldPageFileName`), mapped to its id. A page with a blank
 * title, which the publish does not write, is held all the same, so the next
 * publish does not read its file as one no page holds and delete it.
 */
export function heldPagesRecord(commit: string, pages: readonly RecordedPage[]): PageFilesRecord {
  return { commit, files: Object.fromEntries(heldFiles(pages)) };
}

/**
 * The page file paths a publish deletes from the record: each recorded file no
 * captured page holds. None for no record. The caller adds the snapshot's
 * deletions (`computePageDeletions`) and drops any path it also writes; the
 * commit sends only those present at the head it is built on.
 */
export function recordedPageDeletions(record: PageFilesRecord | null, pages: readonly RecordedPage[]): string[] {
  if (record === null) return [];
  const held = heldFiles(pages);
  return Object.keys(record.files)
    .filter((name) => !held.has(name))
    .map((name) => `${PAGE_TEXTS_DIR}/${name}`);
}

/**
 * `page_files_json` written with a head write from `fromSha`: `recordJson`
 * only while head_sha is still `fromSha`, else the record the row holds, so a
 * head another writer recorded keeps that writer's record. Null-aware as
 * `headAdvancedFrom` is.
 */
export function pageFilesRecordAdvancedFrom(fromSha: string | null, recordJson: string): SQL {
  return sql`CASE WHEN ${projects.head_sha} IS ${fromSha} THEN ${recordJson} ELSE ${projects.page_files_json} END`;
}

/**
 * The record given to a project with none yet, of a file no page holds that a
 * publish recorded (R9): `<slug>.md` for a slug in the snapshot's
 * `page_slugs`. It is the old file of a page renamed or deleted here since that
 * publish, and is recorded with no page so the next publish deletes it.
 */
function publishedSlugFiles(snapshot: PublishSnapshot | null): Set<string> {
  return new Set((snapshot?.page_slugs ?? []).map((slug) => `${slug}.md`).filter(isRecordedPageFileName));
}

/** What the onboarding record is derived from. */
export interface OnboardingRecordInput {
  /** The commit the onboarding wrote, which the record describes. */
  commit: string;
  /** The names of the files in the pages folder at `commit`. */
  folder: Iterable<string>;
  /** The project's pages as D1 holds them. */
  pages: readonly RecordedPage[];
  /** The record the write replaces. */
  previous: PageFilesRecord | null;
  /** The last publish's snapshot, read only when there is no previous record. */
  snapshot: PublishSnapshot | null;
}

/**
 * The record onboarding writes with the head it records, from the pages folder
 * there and D1: each file a page holds maps to that page. A file the replaced
 * record lists keeps its entry, so a page renamed here between the import and
 * onboarding does not read as an addition afterwards. Over no record, a file no
 * page holds that the snapshot's `page_slugs` names is recorded with no page
 * (R9). Any other file is left out.
 */
export function onboardingPageFilesRecord(input: OnboardingRecordInput): PageFilesRecord {
  const held = heldFiles(input.pages);
  const published = input.previous === null ? publishedSlugFiles(input.snapshot) : new Set<string>();
  const files: Record<string, number | null> = {};
  for (const name of input.folder) {
    if (!isRecordedPageFileName(name)) continue;
    if (held.has(name)) files[name] = held.get(name)!;
    else if (input.previous !== null && name in input.previous.files) files[name] = input.previous.files[name];
    else if (published.has(name)) files[name] = null;
  }
  return { commit: input.commit, files };
}

/** What onboarding reads to record its head. */
export interface OnboardingRecordRead {
  access: RepoAccess;
  commit: string;
  previousJson: string | null;
  snapshotJson: string | null;
}

/** The snapshot's text parsed, or null for none or for text that is not JSON. */
function onboardingSnapshotOf(text: string | null): PublishSnapshot | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as PublishSnapshot;
  } catch {
    return null;
  }
}

/**
 * The record onboarding writes with its head, as stored text, or `undefined`
 * when the pages folder at its commit or the pages cannot be read: the commit
 * has landed, so the caller records its head all the same and carries the
 * record it holds unchanged rather than describe files nothing read.
 */
export async function onboardingRecordJson(
  db: D1Database,
  projectId: number,
  read: OnboardingRecordRead,
): Promise<string | undefined> {
  try {
    const folder = await pageFolderFiles(read.access, read.commit);
    if (typeof folder === "string") throw new Error(folder);
    const pages = await db.prepare("SELECT id, slug FROM project_pages WHERE project_id = ?")
      .bind(projectId)
      .all<RecordedPage>();
    return serialisePageFilesRecord(onboardingPageFilesRecord({
      commit: read.commit,
      folder: folder.keys(),
      pages: pages.results,
      previous: parsePageFilesRecord(read.previousJson),
      snapshot: onboardingSnapshotOf(read.snapshotJson),
    }));
  } catch (err) {
    console.warn(`[onboarding] project ${projectId}: page files record carried unchanged`, err);
    return undefined;
  }
}

/** The `projects` columns to set for an onboarding record: none when it could not be read, so the stored one stays. */
export function pageFilesColumn(json: string | undefined): { page_files_json?: string } {
  return json === undefined ? {} : { page_files_json: json };
}

/**
 * The commit the Pages screen's import reads: the recorded head when there is
 * one, so the pages it brings in are those of the commit the Compositor has
 * read, else the head of `main`.
 */
export async function pagesImportCommit(access: RepoAccess, headSha: string | null | undefined): Promise<string> {
  return headSha ?? (await getRepoHead(access.token, access.owner, access.repo, "main"));
}

/**
 * Record the pages the Pages screen's import brought in: each file mapped to
 * the id of the page inserted from it, merged into the project's record (R10).
 * The import records no head, so the write is a compare-and-set on the record
 * itself; one that loses to another writer reads the record again and merges
 * once more. True when a write landed or there was nothing to record.
 */
export async function recordImportedPages(
  db: D1Database,
  projectId: number,
  scanCommit: string,
  entries: Record<string, number | null>,
): Promise<boolean> {
  if (Object.keys(entries).length === 0) return true;
  for (let attempt = 0; attempt < MERGE_TRIES; attempt++) {
    const row = await db.prepare("SELECT page_files_json FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ page_files_json: string | null }>();
    if (!row) return false;
    const next = serialisePageFilesRecord(
      mergedPageFilesRecord(parsePageFilesRecord(row.page_files_json), scanCommit, entries),
    );
    const write = await db.prepare("UPDATE projects SET page_files_json = ? WHERE id = ? AND page_files_json IS ?")
      .bind(next, projectId, row.page_files_json)
      .run();
    if ((write.meta?.changes ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Record the pages the Pages screen's import inserted, `insertedPages` being
 * the ingest's answer of each inserted page's id by slug, and each file in
 * `removed` with no page, so the next publish deletes it. The pages are in by
 * then, so a write that fails is logged and the import still answers what it
 * imported.
 */
export async function recordPagesImport(
  db: D1Database,
  projectId: number,
  scanCommit: string,
  insertedPages: Record<string, number> | undefined,
  removed: readonly string[] = [],
): Promise<void> {
  const entries: Record<string, number | null> = Object.fromEntries(removed.map((name) => [name, null]));
  for (const [slug, id] of Object.entries(insertedPages ?? {})) entries[`${slug}.md`] = id;
  try {
    if (!(await recordImportedPages(db, projectId, scanCommit, entries))) {
      console.warn(`[import-pages] project ${projectId}: the page files record was not written`);
    }
  } catch (err) {
    console.warn(`[import-pages] project ${projectId}: the page files record was not written`, err);
  }
}

/**
 * The Pages screen's scan reduced to one file per page for the site's
 * language as D1 holds it. A language that cannot be read leaves the scan as
 * read, with nothing removed: the reduction is never made for a guessed
 * language.
 */
export async function reducedPagesScan<P extends ScannedPage>(
  db: D1Database,
  projectId: number,
  pages: P[],
): Promise<ReturnType<typeof reduceScannedPages<P>>> {
  let row: { lang: string | null } | null;
  try {
    row = await db.prepare("SELECT lang FROM project_config WHERE project_id = ?").bind(projectId).first<{ lang: string | null }>();
  } catch {
    row = null;
  }
  return row ? reduceScannedPages(pages, row.lang) : { pages, removed: [], servedAt: {} };
}
