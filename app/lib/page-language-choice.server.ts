/**
 * A page held in more than one language, and the publish page's choice of
 * which version to keep.
 *
 * A Telar site is in one language. The template ships its about page twice,
 * `about.md`, and `acerca.md` with `localized_for: about.md` and
 * `language: es`, and a site holding both holds one page in two languages
 * (`reducePageFiles` in `one-language-pages.ts` reads the pair as the build
 * does). That is a decision for the author, not a change on GitHub: the sync
 * leaves the pair alone, and the publish page names each such page and waits
 * for the author to choose the version to keep.
 *
 * A version is a held page whose file names the page by `localized_for`, and
 * the page is the one whose file it names. Keeping the page's own version
 * removes every other one. Keeping another gives the page that version's
 * title, body and front matter, less its `localized_for` and `language`
 * lines, and removes every other version, that one included: the page keeps
 * its file name, its address and its menu entries. Either way the removed
 * versions' files are the ones the publish deletes.
 *
 * A version's block is the one the build reads: D1's, or for a page never
 * captured the block of the file a publish carries it from. A page whose
 * block cannot be read is read as a page of its own.
 *
 * The choice is applied by the collaboration object's `/ingest-sync`, all or
 * nothing, through its page-content and page-removal arms, each entry by the
 * hash of the row as D1 holds it (`pageRawHash`), so a page that changed
 * since D1 was read refuses the whole choice and nothing is applied.
 *
 * @version v1.5.5-beta
 */

import { eq } from "drizzle-orm";
import { project_config, project_pages } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { pageContentAsLoaded, pageRawHash } from "~/lib/page-canonical";
import { PAGE_TEXTS_DIR, heldPageFileName } from "~/lib/page-content.server";
import { ownPageFrontmatter, readBlock, reducePageFiles } from "~/lib/one-language-pages";
import { parsePageFilesRecord } from "~/lib/page-files-record";
import { recordImportedPages } from "~/lib/page-files-record.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { withCarriedFrontmatter, type CarryForwardSource } from "~/lib/publish.server";
import type { PageLanguageGroup, PageLanguageVersion } from "~/lib/page-language-choice";
import type { IngestPageRemove } from "../../workers/page-remove-rename";
import type { IngestPageReplaceContent } from "../../workers/page-replace-content";

/** A page row as the choice reads it, with the block the build reads (`block`; null for none read). */
export interface LanguagePageRow {
  id: number;
  slug: string | null;
  title: string | null;
  body: string | null;
  frontmatter: string | null;
  block: string | null;
}

interface HeldGroup<R extends LanguagePageRow> {
  page: R;
  others: R[];
}

/** The pages held in more than one language, by the rows that hold each version. */
function heldGroups<R extends LanguagePageRow>(rows: readonly R[], siteLanguage: unknown): HeldGroup<R>[] {
  const files = rows.flatMap((row) => {
    const name = heldPageFileName(row);
    return name === null ? [] : [{ name, frontmatter: row.block ?? "", body: "", row }];
  });
  const { kept, removed } = reducePageFiles(files, siteLanguage);
  const groups = new Map<string, HeldGroup<R>>();
  for (const file of removed) {
    const reading = readBlock(file.frontmatter);
    if (reading.kind !== "localized" || reading.localizedFor.string === null) continue;
    const page = kept.find((k) => k.file.name === reading.localizedFor.string)?.file;
    if (!page) continue;
    const group = groups.get(page.name) ?? { page: page.row, others: [] };
    group.others.push(file.row);
    groups.set(page.name, group);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, group]) => group);
}

function languageVersionOf(row: LanguagePageRow): PageLanguageVersion {
  return { pageId: row.id, file: heldPageFileName(row)!, title: (row.title ?? "").trim() };
}

/**
 * D1's pages as the choice reads them, each with the block the build reads
 * at `source` (`withCarriedFrontmatter`, a read that fails leaving none), and
 * the site's language.
 */
export async function readLanguagePages(
  db: ReturnType<typeof getDb>,
  projectId: number,
  source: CarryForwardSource,
): Promise<{ rows: LanguagePageRow[]; siteLanguage: string | null }> {
  const [stored, config] = await Promise.all([
    db
      .select({
        id: project_pages.id, slug: project_pages.slug, title: project_pages.title, body: project_pages.body,
        frontmatter: project_pages.frontmatter, frontmatter_source: project_pages.frontmatter_source,
      })
      .from(project_pages)
      .where(eq(project_pages.project_id, projectId)),
    db.select({ lang: project_config.lang }).from(project_config).where(eq(project_config.project_id, projectId)).limit(1),
  ]);
  const carried = await withCarriedFrontmatter(stored, source, false);
  const rows = stored.map((row, i) => ({
    id: row.id, slug: row.slug, title: row.title, body: row.body, frontmatter: row.frontmatter, block: carried[i].frontmatter,
  }));
  return { rows, siteLanguage: config[0]?.lang ?? null };
}

/** The pages the publish page asks about, for a site whose `telar_language` is `siteLanguage`. */
export function pageLanguageGroups(rows: readonly LanguagePageRow[], siteLanguage: unknown): PageLanguageGroup[] {
  return heldGroups(rows, siteLanguage).map((g) => ({ page: languageVersionOf(g.page), others: g.others.map(languageVersionOf) }));
}

/** The kept file names a publish posted; anything but a JSON list of plain `.md` names is none. */
export function keptPageFiles(raw: unknown): Set<string> {
  if (typeof raw !== "string") return new Set();
  try {
    const names = JSON.parse(raw) as unknown;
    if (!Array.isArray(names)) return new Set();
    return new Set(names.filter((n): n is string => typeof n === "string" && /^[^/]+\.md$/.test(n)));
  } catch {
    return new Set();
  }
}

/** What applying the choice sends, and the files of the versions it removes. */
export interface PageLanguageArms {
  replaceContent: IngestPageReplaceContent[];
  remove: IngestPageRemove[];
  /** File names in the pages folder. */
  dropped: string[];
}

const rowHash = (row: LanguagePageRow) => pageRawHash(pageContentAsLoaded(row));

/**
 * The arms that keep, of each group, the one version `kept` names; null when
 * a group has no version in `kept`, or more than one.
 */
async function pageLanguageArms(groups: readonly HeldGroup<LanguagePageRow>[], kept: ReadonlySet<string>): Promise<PageLanguageArms | null> {
  const arms: PageLanguageArms = { replaceContent: [], remove: [], dropped: [] };
  for (const { page, others } of groups) {
    const chosen = [page, ...others].filter((row) => kept.has(heldPageFileName(row)!));
    if (chosen.length !== 1) return null;
    const keep = chosen[0];
    if (keep !== page) {
      arms.replaceContent.push({
        pageId: page.id, expected: await rowHash(page),
        title: keep.title ?? "", body: keep.body ?? "", frontmatter: ownPageFrontmatter(keep.block ?? ""),
      });
    }
    for (const other of others) {
      arms.remove.push({ pageId: other.id, slug: (other.slug ?? "").trim(), expected: await rowHash(other) });
      arms.dropped.push(heldPageFileName(other)!);
    }
  }
  return arms;
}

/** Why a publish did not apply the choice: none was made for a page, or the collaboration object did not apply it. */
export class PageLanguageChoiceRefused extends Error {
  constructor(readonly code: "unchosen" | "not_applied") {
    super(`page language choice: ${code}`);
    this.name = "PageLanguageChoiceRefused";
  }
}

/** The ids an ingest answer lists as applied or already applied under `arm`. */
function appliedIds(body: unknown, arm: "pageContent" | "pageRemove"): Set<number> {
  const outcome = (body as Record<string, Record<string, unknown> | undefined> | null)?.[arm];
  const ids = [...(Array.isArray(outcome?.applied) ? outcome.applied : []), ...(Array.isArray(outcome?.alreadyApplied) ? outcome.alreadyApplied : [])];
  return new Set(ids.filter((id): id is number => typeof id === "number"));
}

/** Post the arms to the collaboration object, all or nothing, and say whether every entry was applied. */
async function sendArms(env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">, projectId: number, arms: PageLanguageArms): Promise<boolean> {
  const pages = { remove: arms.remove, ...(arms.replaceContent.length > 0 ? { replaceContent: arms.replaceContent } : {}) };
  const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
  const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
  const response = await stub.fetch(
    new Request("https://internal/ingest-sync", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ pages, allOrNothing: true }),
    }),
  );
  if (!response.ok) return false;
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return false;
  }
  const content = appliedIds(body, "pageContent");
  const removed = appliedIds(body, "pageRemove");
  return arms.replaceContent.every((e) => content.has(e.pageId)) && arms.remove.every((e) => removed.has(e.pageId));
}

/** What a publish applies the choice over: D1's pages, the site's language, the kept names and the stored record. */
export interface PageLanguageChoiceInput {
  rows: readonly LanguagePageRow[];
  siteLanguage: unknown;
  kept: ReadonlySet<string>;
  /** `projects.page_files_json` as the publish read it. */
  recordJson: string | null;
}

/**
 * Apply the author's choice for each page held in more than one language, and
 * answer the paths of the files the publish deletes for it; none when the
 * site holds no such page.
 *
 * Over a stored record, each removed version's file is first entered in it
 * with no page (`recordImportedPages`), so a publish that fails after the
 * choice still leaves the next one to delete the file. With no record none is
 * started, since a record holding only these files would hide the files the
 * last publish's `page_slugs` names; the publish deletes the paths
 * answered here, and the record it writes once it lands holds the rest.
 *
 * Throws `PageLanguageChoiceRefused`: `unchosen` when a page has no kept
 * version or more than one, before anything is written; `not_applied` when
 * the record could not be written or the collaboration object did not apply
 * every entry, which, the ingest being all or nothing, leaves every page as
 * it was.
 */
export async function applyPageLanguageChoice(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET" | "DB">,
  projectId: number,
  input: PageLanguageChoiceInput,
): Promise<string[]> {
  const groups = heldGroups(input.rows, input.siteLanguage);
  if (groups.length === 0) return [];
  const arms = await pageLanguageArms(groups, input.kept);
  if (arms === null) throw new PageLanguageChoiceRefused("unchosen");
  const record = parsePageFilesRecord(input.recordJson);
  if (record !== null) {
    const entries = Object.fromEntries(arms.dropped.map((name) => [name, null]));
    if (!(await recordImportedPages(env.DB, projectId, record.commit, entries))) throw new PageLanguageChoiceRefused("not_applied");
  }
  if (!(await sendArms(env, projectId, arms))) throw new PageLanguageChoiceRefused("not_applied");
  return arms.dropped.map((name) => `${PAGE_TEXTS_DIR}/${name}`);
}
