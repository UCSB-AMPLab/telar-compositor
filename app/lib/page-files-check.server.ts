/**
 * The page-file check as the sync runs it: what it loads beside
 * D1's pages, what it adds to `checkPageContent`'s readings, and what an
 * accept makes of them.
 *
 * The check loads the page files record and, while there is none, the last
 * publish's `page_slugs`. Its base is `head_sha`, or while that is null the
 * record's `commit` (`pagesBaseOf`).
 *
 * An added page gets the menu entry GitHub's `_data/navigation.yml` gives it
 * (`menuEntryForAddedPage`), read strictly at the check's HEAD and only when
 * a page is added; a read that fails makes the check inconclusive. A page
 * GitHub deleted is named with whether a saved entry names it.
 *
 * Every file is read as a page of its own. A page held in two languages
 * (`localized_for`) is not a change on GitHub: the publish page asks which
 * to keep (`page-language-choice.server.ts`).
 *
 * An accept takes its additions from its own run of the check at the pinned
 * head, never from the client; the client names only the files it chose to
 * follow GitHub on, each with the hash it reviewed.
 *
 * @version v1.5.5-beta
 */

import { eq } from "drizzle-orm";
import { project_config, project_pages, projects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { getFileAtRef } from "~/lib/github.server";
import { menuEntryForAddedPage, parseGithubMenu } from "~/lib/github-menu.server";
import { checkPageContent, readPagesForAccept } from "~/lib/page-content.server";
import type { PageAddition, PageCheckD1Page, PageContentCheck, PageFileChange } from "~/lib/page-content.server";
import { parsePageFilesRecord, serialisePageFilesRecord } from "~/lib/page-files-record";
import type { PageFilesRecord } from "~/lib/page-files-record";
import type { SheetWarning } from "~/lib/sheet-warnings";
import type { RepoAccess } from "~/lib/story-files.server";
import type { NavItemLike } from "~/lib/yjs-helpers";
import type { IngestPageInsert } from "../../workers/collaboration";
import type { IngestMenuAnchor } from "../../workers/page-menu-entries";
import type { IngestPageRemove } from "../../workers/page-remove-rename";

type Db = ReturnType<typeof getDb>;

/** What the check reads from D1 beside the trees. */
export interface PageCheckScope {
  d1: PageCheckD1Page[];
  record: PageFilesRecord | null;
  publishedSlugs: string[];
  saved: NavItemLike[];
  siteLanguage: unknown;
}

/** GitHub's menu file, which the sync reads for an added page's entry alone. */
const NAVIGATION_PATH = "_data/navigation.yml";

/** A stored JSON text parsed, or `fallback` for none and for text that is not JSON. */
function parsedOr<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return (JSON.parse(text) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** D1's pages, the record, the snapshot's `page_slugs`, the saved menu and the site's language. */
export async function loadPageCheckScope(db: Db, projectId: number): Promise<PageCheckScope> {
  const d1 = await db
    .select({
      id: project_pages.id, slug: project_pages.slug, title: project_pages.title, body: project_pages.body,
      frontmatter: project_pages.frontmatter, frontmatter_source: project_pages.frontmatter_source,
    })
    .from(project_pages)
    .where(eq(project_pages.project_id, projectId));
  const [project] = await db
    .select({ record: projects.page_files_json, snapshot: projects.publish_snapshot })
    .from(projects)
    .where(eq(projects.id, projectId));
  const [config] = await db
    .select({ navigation: project_config.navigation_json, lang: project_config.lang })
    .from(project_config)
    .where(eq(project_config.project_id, projectId));
  const slugs = parsedOr<{ page_slugs?: unknown }>(project?.snapshot, {}).page_slugs;
  const saved = parsedOr<unknown>(config?.navigation, []);
  return {
    d1,
    record: parsePageFilesRecord(project?.record),
    publishedSlugs: Array.isArray(slugs) ? slugs.filter((s): s is string => typeof s === "string") : [],
    saved: Array.isArray(saved) ? (saved as NavItemLike[]) : [],
    siteLanguage: config?.lang ?? null,
  };
}

/** The pages base: `head_sha`, else the record's commit, else none. */
export function pagesBaseOf(headSha: string | null, record: PageFilesRecord | null): string | null {
  return headSha ?? record?.commit ?? null;
}

/** The field that names a saved entry of each type, as the menu arm matches it. */
const ANCHOR_FIELD = { page: "slug", builtin: "key", external: "url" } as const;

/** The saved entry at `index - 1` as the menu arm names the entry an added page follows. */
function anchorBefore(saved: readonly NavItemLike[], index: number): IngestMenuAnchor | null {
  const item = index > 0 ? saved[index - 1] : undefined;
  const field = item ? ANCHOR_FIELD[item.type] : undefined;
  const value = field ? item?.[field] : undefined;
  return value ? ({ type: item!.type, [field!]: value } as IngestMenuAnchor) : null;
}

/** Each addition given GitHub's menu entry; null when the menu file cannot be read. */
async function additionsWithMenu(
  access: RepoAccess,
  head: string,
  scope: PageCheckScope,
  additions: readonly PageAddition[],
): Promise<PageAddition[] | null> {
  if (additions.length === 0) return [];
  const read = await getFileAtRef(access.token, access.owner, access.repo, NAVIGATION_PATH, head, { strict: true });
  if (read.status === "error") return null;
  const menu = parseGithubMenu(read.status === "ok" ? read.content : null);
  return additions.map((a) => {
    const placed = menuEntryForAddedPage({ slug: a.slug, menu, saved: scope.saved, siteLanguage: scope.siteLanguage });
    return { ...a, menu: placed ? { label: placed.entry.label, after: anchorBefore(scope.saved, placed.index) } : null };
  });
}

/** The kinds whose GitHub side is the page's removal. */
const REMOVAL_KINDS = new Set<PageFileChange["kind"]>(["deleted", "deleted-conflict", "deleted-renamed-here", "not-on-github"]);

/** A removal named with whether a saved entry names its page. */
function withMenuEntry(change: PageFileChange, scope: PageCheckScope): PageFileChange {
  if (!REMOVAL_KINDS.has(change.kind)) return change;
  const page = scope.d1.find((p) => p.id === change.pageId)!;
  return { ...change, inMenu: scope.saved.some((item) => item.type === "page" && item.slug === page.slug) };
}

/**
 * The page-file check at `base` and `head` over `scope`, its additions and
 * removals named for the dialog. A failure of the check itself, the menu read
 * included, is an answer it could not reach, never an empty one, and its
 * cause is a request's: only the folder's own structure (`checkPageContent`)
 * is a structural cause.
 */
export async function checkPageFiles(
  access: RepoAccess,
  scope: PageCheckScope,
  base: string | null,
  head: string,
  sinks: { warnings?: SheetWarning[]; unreadable?: SheetWarning[] } = {},
): Promise<PageContentCheck> {
  try {
    const check = await checkPageContent({
      ...access, base, head, d1: scope.d1, record: scope.record, publishedSlugs: scope.publishedSlugs, ...sinks,
    });
    if (!check.conclusive) return check;
    const additions = await additionsWithMenu(access, head, scope, check.additions ?? []);
    if (additions === null) {
      return { conclusive: false, reason: `${NAVIGATION_PATH} could not be read at ${head}`, cause: "request", paths: [NAVIGATION_PATH] };
    }
    const files = (check.files ?? []).map((c) => withMenuEntry(c, scope));
    return { ...check, files, additions };
  } catch (err) {
    return { conclusive: false, reason: `the page files could not be checked: ${(err as Error).message}`, cause: "request" };
  }
}

type ConclusiveCheck = Extract<PageContentCheck, { conclusive: true }>;

/** A file the author chose to follow GitHub on, as the dialog posts it. */
export interface PageFileTake {
  name: string;
  pageId: number;
  /** The hash the check recorded (`PageFileChange.expected`). */
  expected: string;
}

/** The client's choices, validated: a file name directly in the folder, a positive page id, a string hash. */
export function pageFileTakes(raw: unknown): PageFileTake[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("apply-full-sync refused: pages.takeFiles is not a list");
  return raw.map((entry) => {
    const { name, pageId, expected } = (entry ?? {}) as Record<string, unknown>;
    const plain = typeof name === "string" && /^[^/]+\.md$/.test(name);
    if (!plain || typeof pageId !== "number" || !Number.isSafeInteger(pageId) || pageId <= 0 || typeof expected !== "string") {
      throw new Error("apply-full-sync refused: a page file choice names no page file");
    }
    return { name, pageId, expected };
  });
}

/** One removal, by the hash reviewed. */
function removalOf(change: PageFileChange, take: PageFileTake): IngestPageRemove {
  if (take.expected === "") throw new Error(`the removal of page ${take.pageId} carries no expected hash from its review`);
  return { pageId: change.pageId, slug: change.slug, expected: take.expected };
}

/** The names of the additions the dialog showed, validated: plain `name.md` strings; absent is none. */
export function reviewedAdditionNames(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((n) => typeof n === "string" && /^[^/]+\.md$/.test(n))) {
    throw new Error("apply-full-sync refused: pages.addFiles is not a list of page file names");
  }
  return raw;
}

/**
 * The pages the check's additions and the reviewed ones disagree on, by the
 * page id the check's record now maps each name to; `unnamed` when a name
 * maps to no page. The accept inserts only what the author was shown.
 */
function additionsChangedSinceReview(check: ConclusiveCheck, reviewed: readonly string[]): { stale: number[]; unnamed: boolean } {
  const now = new Set((check.additions ?? []).map((a) => a.name));
  const differing = [...reviewed.filter((n) => !now.has(n)), ...[...now].filter((n) => !reviewed.includes(n))];
  const ids = differing.map((n) => check.record?.files[n]);
  return { stale: ids.filter((id): id is number => typeof id === "number"), unnamed: ids.some((id) => typeof id !== "number") };
}

/**
 * The page arms an accept sends: every addition of its own check, with its
 * menu entry, and each file the author chose to follow GitHub on, matched to
 * the check's listing by name and page id (a removal, or the restore of a
 * page deleted here). A choice the check does not list is answered in
 * `stale` by its page id: the page changed since the check. So is an addition
 * the dialog did not show (`reviewed`) and a shown one the check no longer
 * lists; with no page id to name, `unnamed`.
 */
export async function pageFileArms(
  access: RepoAccess,
  check: ConclusiveCheck,
  takes: readonly PageFileTake[],
  reviewed: readonly string[],
  head: string,
): Promise<{ insert: IngestPageInsert[]; remove: IngestPageRemove[]; stale: number[]; unnamed: boolean }> {
  const stale: number[] = [];
  const remove: IngestPageRemove[] = [];
  const restored: string[] = [];
  for (const take of takes) {
    const change = (check.files ?? []).find((c) => c.name === take.name && c.pageId === take.pageId);
    if (!change) stale.push(take.pageId);
    else if (REMOVAL_KINDS.has(change.kind)) remove.push(removalOf(change, take));
    else if (change.kind === "deleted-here-edited") restored.push(change.slug);
  }
  const added = additionsChangedSinceReview(check, reviewed);
  stale.push(...added.stale);
  if (stale.length > 0 || added.unnamed) return { insert: [], remove: [], stale, unnamed: added.unnamed };
  const additions = check.additions ?? [];
  const content = await readPagesForAccept(access, head, [...additions.map((a) => a.slug), ...restored]);
  const insert = [
    ...additions.map((a): IngestPageInsert => ({
      slug: a.slug, ...content.get(a.slug)!, created_by: null, ...(a.menu ? { menu: a.menu } : {}),
    })),
    ...restored.map((slug): IngestPageInsert => ({ slug, ...content.get(slug)!, created_by: null })),
  ];
  return { insert, remove, stale, unnamed: false };
}

/**
 * The record an accept writes with its head: its check's record, each page it
 * inserted mapped to the id the ingest answered. An insert with no id was not
 * applied, and answers null: the head is not recorded.
 */
export function acceptedPageFilesRecord(
  record: PageFilesRecord,
  inserted: readonly IngestPageInsert[],
  insertedIds: Record<string, number> | undefined,
): string | null {
  const files = { ...record.files };
  for (const { slug } of inserted) {
    const id = insertedIds?.[slug];
    if (typeof id !== "number") return null;
    files[`${slug}.md`] = id;
  }
  return serialisePageFilesRecord({ commit: record.commit, files });
}
