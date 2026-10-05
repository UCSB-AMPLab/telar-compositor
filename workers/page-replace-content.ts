/**
 * The `pages.replaceContent` arm of `/ingest-sync`: GitHub's version of a
 * page, accepted in the full sync dialog, replacing the page's title, body
 * and front matter.
 *
 * An entry applies only while the live page is still the one the author
 * reviewed: the raw hash of its live map (`pageRawHash`, of the title and
 * body texts and the `frontmatter` string or null) must equal the entry's
 * `expected`, which the check took from D1's row as the map loads it
 * (`pageContentAsLoaded`). An edit made after the check, or not yet
 * snapshotted when it ran, refuses the entry. The title and body are
 * replaced in place and the block is set in the map, so the next client edit
 * is judged against the accepted state; the slug is never written.
 *
 * It runs before the front matter captures of the same load, which write
 * only onto a block still null, so where both name one page this arm's block
 * is the one stored.
 *
 * @version v1.5.0-beta
 */

import * as Y from "yjs";

import { pageContentAsLoaded, pageRawHash } from "~/lib/page-canonical";
import type { PageContent } from "~/lib/page-canonical";
import { pageById } from "./page-capture";

/**
 * One accepted page, by D1 row id: GitHub's version as the import parses the
 * file, and the raw hash of the Compositor's version the author reviewed.
 */
export interface IngestPageReplaceContent {
  pageId: number;
  expected: string;
  title: string;
  body: string;
  frontmatter: string;
}

/** What each `pages.replaceContent` entry met, by page id. */
export interface PageContentOutcome {
  applied: number[];
  /** The live page already holds this content: a replay, a no-op. */
  alreadyApplied: number[];
  /** The live page is no longer the one reviewed; nothing of it applied. */
  changedSinceReview: number[];
  /** No such page in the document, a map that cannot be read, or D1 not showing it. */
  failed: number[];
}

/** A page the document holds the incoming content for, reported only once D1 shows it. */
export interface PageContentCandidate {
  pageId: number;
  incomingHash: string;
  outcome: "applied" | "alreadyApplied";
}

/** One accepted replacement, checked and planned before the transaction that applies it. */
export interface PageReplacement {
  entry: IngestPageReplaceContent;
  page: Y.Map<unknown>;
  incomingHash: string;
}

export function emptyPageContentOutcome(): PageContentOutcome {
  return { applied: [], alreadyApplied: [], changedSinceReview: [], failed: [] };
}

/** A page map's content as its raw hash reads it, or null when its title or body is not text. */
export function livePageContent(page: Y.Map<unknown>): PageContent | null {
  const title = page.get("title");
  const body = page.get("body");
  if (!(title instanceof Y.Text) || !(body instanceof Y.Text)) return null;
  const frontmatter = page.get("frontmatter");
  return { title: title.toString(), body: body.toString(), frontmatter: typeof frontmatter === "string" ? frontmatter : null };
}

/**
 * Each entry checked against the live page and, where it may apply, planned.
 * Otherwise: the live page already hashes to the incoming content, a
 * candidate for `alreadyApplied`; it differs from `expected`, refused whole
 * as changed since review; no page holds the id, or its map cannot be read,
 * failed. Runs inside the gate and before the transaction: the hash is
 * async, the transaction is not.
 */
export async function planPageReplacements(
  pagesArray: Y.Array<Y.Map<unknown>>,
  entries: readonly IngestPageReplaceContent[],
  outcome: PageContentOutcome,
  candidates: PageContentCandidate[],
): Promise<PageReplacement[]> {
  const plans: PageReplacement[] = [];
  for (const entry of entries) {
    const page = pageById(pagesArray, entry.pageId);
    const live = page ? livePageContent(page) : null;
    if (!page || !live) {
      outcome.failed.push(entry.pageId);
      continue;
    }
    const [liveHash, incomingHash] = await Promise.all([
      pageRawHash(live),
      pageRawHash({ title: entry.title, body: entry.body, frontmatter: entry.frontmatter }),
    ]);
    if (liveHash === incomingHash) {
      candidates.push({ pageId: entry.pageId, incomingHash, outcome: "alreadyApplied" });
      continue;
    }
    if (liveHash !== entry.expected) {
      outcome.changedSinceReview.push(entry.pageId);
      continue;
    }
    plans.push({ entry, page, incomingHash });
  }
  return plans;
}

/**
 * The planned replacements written to their page maps, each a candidate for
 * `applied`: the title and body through `replaceText`, which replaces a
 * `Y.Text` in place so a bound editor follows, and the block set in the map.
 * Runs inside the caller's transaction.
 */
export function applyPageReplacements(
  plans: readonly PageReplacement[],
  replaceText: (map: Y.Map<unknown>, key: string, value: string) => void,
  candidates: PageContentCandidate[],
): void {
  for (const { entry, page, incomingHash } of plans) {
    replaceText(page, "title", entry.title);
    replaceText(page, "body", entry.body);
    page.set("frontmatter", entry.frontmatter);
    candidates.push({ pageId: entry.pageId, incomingHash, outcome: "applied" });
  }
}

/**
 * Each candidate reported as its outcome only when D1, read after the flush
 * attempt, holds the incoming content: the page's row, by its id and this
 * project, hashed as the map loads it. Otherwise, or when the row cannot be
 * read, failed. The flush's own answer and the live document are not
 * evidence: a replay finds the content in the document whether or not it
 * reached D1. Runs inside the gate.
 */
export async function settlePageContent(
  db: D1Database,
  projectId: number | null,
  candidates: readonly PageContentCandidate[],
  outcome: PageContentOutcome,
): Promise<void> {
  for (const candidate of candidates) {
    let persisted = false;
    try {
      const row = await db
        .prepare("SELECT title, body, frontmatter FROM project_pages WHERE id = ? AND project_id = ?")
        .bind(candidate.pageId, projectId)
        .first<{ title: string | null; body: string | null; frontmatter: string | null }>();
      persisted = row !== null && (await pageRawHash(pageContentAsLoaded(row))) === candidate.incomingHash;
    } catch (err) {
      console.error(`[ingest-sync] project ${projectId}: page ${candidate.pageId} content not read back`, err);
    }
    (persisted ? outcome[candidate.outcome] : outcome.failed).push(candidate.pageId);
  }
}
