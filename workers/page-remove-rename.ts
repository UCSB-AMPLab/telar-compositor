/**
 * The `pages.remove` and `pages.rename` arms of `/ingest-sync`: a page deleted
 * or renamed on GitHub, accepted in the full sync dialog.
 *
 * A removal names its page by D1 row id, by the slug the check read it at, and
 * by the raw hash of the Compositor's version the author reviewed
 * (`pageRawHash` of the row as the map loads it, `pageContentAsLoaded`). It
 * applies only while the page with that id is at that slug and still hashes
 * to `expected`; otherwise it is changed since review. A rename names its page
 * by id and its old and new slugs, and applies only while the page is at
 * `from` and no other page, nor a page an insert of the same ingest adds,
 * holds `to`: a page elsewhere is changed since review, a taken address is
 * failed. A rename onto a taken slug is refused here rather than left to the
 * snapshot's re-key, which would give the page `to-2`.
 *
 * Both arms change the menu entries naming the page in the same transaction
 * (`page-menu-entries.ts`): a removal drops them, a rename re-points them.
 *
 * Each arm is checked and planned inside the gate before the transaction
 * (the hash is async, the transaction is not), and each entry is reported
 * applied only when D1, read after the flush attempt, shows it.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

import { pageRawHash } from "~/lib/page-canonical";
import { pageById } from "./page-capture";
import { livePageContent } from "./page-replace-content";
import { dropPageMenuEntries, repointPageMenuEntries } from "./page-menu-entries";

/** A page deleted on GitHub, by D1 row id, slug, and the hash of the version reviewed. */
export interface IngestPageRemove {
  pageId: number;
  slug: string;
  expected: string;
}

/**
 * A page renamed on GitHub, by D1 row id, from `from` to `to`, with the block
 * GitHub's file at `to` holds, stored only onto a block never captured.
 */
export interface IngestPageRename {
  pageId: number;
  from: string;
  to: string;
  frontmatter: string;
}

/** What each removal or rename met, by page id. */
export interface PageSlugOutcome {
  applied: number[];
  /** The document already shows the change: a replay, a no-op. */
  alreadyApplied: number[];
  /** The live page differs from the one reviewed, or stands at another slug than the one reviewed. */
  changedSinceReview: number[];
  /** No such page, a map that cannot be read, a taken address, or D1 not showing it. */
  failed: number[];
}

/**
 * An entry the document holds the change for, reported only once D1 shows
 * it: the row gone (`slug` null), or the row at `slug`.
 */
export interface PageSlugCandidate {
  pageId: number;
  slug: string | null;
  outcome: "applied" | "alreadyApplied";
}

interface PlannedRemoval {
  entry: IngestPageRemove;
  page: Y.Map<unknown>;
}

interface PlannedRename {
  entry: IngestPageRename;
  page: Y.Map<unknown>;
}

/** The removals and renames to apply, checked against the document as it stands. */
export interface PageSlugPlans {
  removals: PlannedRemoval[];
  renames: PlannedRename[];
}

export function emptyPageSlugOutcome(): PageSlugOutcome {
  return { applied: [], alreadyApplied: [], changedSinceReview: [], failed: [] };
}

/**
 * Each removal checked against the live page. A page the document does not
 * hold is a candidate for `alreadyApplied`, which D1 settles: with the row
 * gone the removal holds, and a replay is answered so. A page at another slug
 * or hashing to other than `expected` is changed since review; a map that
 * cannot be read is failed.
 */
async function planRemovals(
  pagesArray: Y.Array<Y.Map<unknown>>,
  entries: readonly IngestPageRemove[],
  outcome: PageSlugOutcome,
  candidates: PageSlugCandidate[],
): Promise<PlannedRemoval[]> {
  const plans: PlannedRemoval[] = [];
  for (const entry of entries) {
    const page = pageById(pagesArray, entry.pageId);
    if (!page) {
      candidates.push({ pageId: entry.pageId, slug: null, outcome: "alreadyApplied" });
      continue;
    }
    const live = livePageContent(page);
    if (!live) {
      outcome.failed.push(entry.pageId);
      continue;
    }
    if (page.get("slug") !== entry.slug || (await pageRawHash(live)) !== entry.expected) {
      outcome.changedSinceReview.push(entry.pageId);
      continue;
    }
    plans.push({ entry, page });
  }
  return plans;
}

/** Whether a page map other than `page` holds `slug`. */
function slugHeldElsewhere(pagesArray: Y.Array<Y.Map<unknown>>, page: Y.Map<unknown>, slug: string): boolean {
  return pagesArray.toArray().some((m) => m instanceof Y.Map && m !== page && m.get("slug") === slug);
}

/**
 * Each rename checked against the live page. A page already at `to` is a
 * candidate for `alreadyApplied`; a page elsewhere than `from` is changed
 * since review; no such page, or a `to` that another page holds, that an
 * insert of this ingest takes (`inserted`), or that an earlier rename in it
 * claims, is failed.
 */
function planRenames(
  pagesArray: Y.Array<Y.Map<unknown>>,
  entries: readonly IngestPageRename[],
  inserted: ReadonlySet<string>,
  outcome: PageSlugOutcome,
  candidates: PageSlugCandidate[],
): PlannedRename[] {
  const plans: PlannedRename[] = [];
  const claimed = new Set(inserted);
  for (const entry of entries) {
    const page = pageById(pagesArray, entry.pageId);
    const slug = page?.get("slug");
    if (page && slug === entry.to) {
      candidates.push({ pageId: entry.pageId, slug: entry.to, outcome: "alreadyApplied" });
    } else if (page && slug !== entry.from) {
      outcome.changedSinceReview.push(entry.pageId);
    } else if (!page || claimed.has(entry.to) || slugHeldElsewhere(pagesArray, page, entry.to)) {
      outcome.failed.push(entry.pageId);
    } else {
      claimed.add(entry.to);
      plans.push({ entry, page });
    }
  }
  return plans;
}

/**
 * Both arms checked and planned. Runs inside the gate and before the
 * transaction. `inserted` is the slugs the same ingest's page inserts write,
 * which a rename may not take.
 */
export async function planPageSlugChanges(
  pagesArray: Y.Array<Y.Map<unknown>>,
  arms: { remove: readonly IngestPageRemove[]; rename: readonly IngestPageRename[]; inserted: ReadonlySet<string> },
  outcomes: { remove: PageSlugOutcome; rename: PageSlugOutcome },
  candidates: { remove: PageSlugCandidate[]; rename: PageSlugCandidate[] },
): Promise<PageSlugPlans> {
  return {
    removals: await planRemovals(pagesArray, arms.remove, outcomes.remove, candidates.remove),
    renames: planRenames(pagesArray, arms.rename, arms.inserted, outcomes.rename, candidates.rename),
  };
}

/**
 * The planned removals and renames written to the document, each a candidate
 * for `applied`, with the menu entries naming each page. A removal deletes the
 * page's map, which the snapshot turns into the row's DELETE; a rename sets
 * the slug and stores the block only onto one never captured. Runs inside the
 * caller's transaction, after the page inserts.
 */
export function applyPageSlugChanges(
  pagesArray: Y.Array<Y.Map<unknown>>,
  navigation: unknown,
  plans: PageSlugPlans,
  candidates: { remove: PageSlugCandidate[]; rename: PageSlugCandidate[] },
): void {
  for (const { entry, page } of plans.removals) {
    const index = pagesArray.toArray().indexOf(page);
    if (index >= 0) pagesArray.delete(index, 1);
    dropPageMenuEntries(navigation, entry.slug);
    candidates.remove.push({ pageId: entry.pageId, slug: null, outcome: "applied" });
  }
  for (const { entry, page } of plans.renames) {
    page.set("slug", entry.to);
    const held = page.get("frontmatter");
    if (held === null || held === undefined) page.set("frontmatter", entry.frontmatter);
    repointPageMenuEntries(navigation, entry.from, entry.to);
    candidates.rename.push({ pageId: entry.pageId, slug: entry.to, outcome: "applied" });
  }
}

/**
 * Each candidate reported as its outcome only when D1, read after the flush
 * attempt, shows it: no row with the page's id in this project for a removal,
 * the row at the new slug for a rename. Otherwise, or when the row cannot be
 * read, failed. Runs inside the gate.
 */
export async function settlePageSlugs(
  db: D1Database,
  projectId: number | null,
  candidates: readonly PageSlugCandidate[],
  outcome: PageSlugOutcome,
): Promise<void> {
  for (const candidate of candidates) {
    let persisted = false;
    try {
      const row = await db
        .prepare("SELECT slug FROM project_pages WHERE id = ? AND project_id = ?")
        .bind(candidate.pageId, projectId)
        .first<{ slug: string }>();
      persisted = candidate.slug === null ? row === null : row?.slug === candidate.slug;
    } catch (err) {
      console.error(`[ingest-sync] project ${projectId}: page ${candidate.pageId} slug not read back`, err);
    }
    (persisted ? outcome[candidate.outcome] : outcome.failed).push(candidate.pageId);
  }
}
