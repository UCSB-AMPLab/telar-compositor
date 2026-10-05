/**
 * The page-file check as the sync runs it: what it loads beside
 * D1's pages, what it adds to `checkPageContent`'s readings, and what an
 * accept and Keep my version make of them.
 *
 * The check loads the page files record and, while there is none, the last
 * publish's `page_slugs` (R9). Its base is `head_sha`, or while that is null
 * the record's `commit` (R6).
 *
 * An added page gets the menu entry GitHub's `_data/navigation.yml` gives it
 * (`menuEntryForAddedPage`), read strictly at the check's HEAD and only when
 * a page is added; a read that fails makes the check inconclusive. A page
 * GitHub deleted is named with whether a saved entry names it.
 *
 * The pages are reduced to one file per page (`reducedCheck`): a site is in
 * one language, so a file the site's language does not serve is never a page,
 * whether GitHub added it or the project already holds it.
 *
 * An accept takes its additions from its own run of the check at the pinned
 * head, never from the client; the client names only the files it chose to
 * follow GitHub on, each with the hash it reviewed.
 *
 * @version v1.5.0-beta
 */

import { eq } from "drizzle-orm";
import { project_config, project_pages, projects } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { getFileAtRef } from "~/lib/github.server";
import { menuEntryForAddedPage, parseGithubMenu } from "~/lib/github-menu.server";
import {
  PAGE_TEXTS_DIR, checkPageContent, heldPageFileName, pageEditedSinceBase, pageFileChange, pageFileReader, pageFolderFiles, readPagesForAccept,
} from "~/lib/page-content.server";
import type { PageAddition, PageCheckD1Page, PageContentChange, PageContentCheck, PageFileChange, ReducedHeldPage } from "~/lib/page-content.server";
import { capturedFrontmatter } from "~/lib/page-frontmatter.server";
import type { FileAtRef } from "~/lib/github.server";
import { pageContentAsLoaded, pageRawHash } from "~/lib/page-canonical";
import { ownPageFrontmatter, readBlock, reducePageFiles } from "~/lib/one-language-pages";
import { parsePageFilesRecord, serialisePageFilesRecord } from "~/lib/page-files-record";
import type { PageFilesRecord } from "~/lib/page-files-record";
import type { SheetWarning } from "~/lib/sheet-warnings";
import type { RepoAccess } from "~/lib/story-files.server";
import type { NavItemLike } from "~/lib/yjs-helpers";
import type { IngestPageInsert } from "../../workers/collaboration";
import type { IngestMenuAnchor } from "../../workers/page-menu-entries";
import type { IngestPageRemove } from "../../workers/page-remove-rename";
import type { IngestPageReplaceContent } from "../../workers/page-replace-content";

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

/** A file the sync's reduction reads: a held page's, or one GitHub added. */
interface SyncPageFile {
  name: string;
  frontmatter: string;
  body: string;
  page?: PageCheckD1Page;
  addition?: PageAddition;
}

/**
 * A held page's block for the reduction: D1's, else the block of its file at
 * HEAD, since a page imported before blocks were stored holds none.
 */
async function heldBlock(read: () => Promise<(path: string) => Promise<FileAtRef>>, page: PageCheckD1Page, name: string): Promise<string> {
  if (typeof page.frontmatter === "string") return page.frontmatter;
  const file = await (await read())(`${PAGE_TEXTS_DIR}/${name}`);
  if (file.status === "error") throw new Error(`${PAGE_TEXTS_DIR}/${name} could not be read`);
  return file.status === "ok" ? capturedFrontmatter(file.content) : "";
}

/** A reader of the pages folder at `head`, which lists the folder when first asked. */
function lazyHeadReader(access: RepoAccess, head: string): () => Promise<(path: string) => Promise<FileAtRef>> {
  let reader: ((path: string) => Promise<FileAtRef>) | null = null;
  return async () => {
    if (reader) return reader;
    const folder = await pageFolderFiles(access, head);
    if (typeof folder === "string") throw new Error(folder);
    return (reader = pageFileReader(access, head, folder));
  };
}

/** The held pages but those in `gone`, as the reduction reads them. */
async function heldSyncFiles(headReader: () => Promise<(path: string) => Promise<FileAtRef>>, d1: readonly PageCheckD1Page[], gone: ReadonlySet<number>): Promise<SyncPageFile[]> {
  const held: SyncPageFile[] = [];
  for (const page of d1) {
    const name = heldPageFileName(page);
    if (name !== null && !gone.has(page.id)) held.push({ name, frontmatter: await heldBlock(headReader, page, name), body: "", page });
  }
  return held;
}

/** The held pages whose file the check does not find removed, and the added files, as the reduction reads them. */
async function syncPageFiles(access: RepoAccess, head: string, check: ConclusiveCheck, d1: readonly PageCheckD1Page[]): Promise<SyncPageFile[]> {
  const gone = new Set((check.files ?? []).filter((c) => REMOVAL_KINDS.has(c.kind)).map((c) => c.pageId));
  const held = await heldSyncFiles(lazyHeadReader(access, head), d1, gone);
  const added = (check.additions ?? []).map((addition) => ({ name: addition.name, frontmatter: addition.frontmatter ?? "", body: "", addition }));
  return [...held, ...added];
}

/**
 * Whether the pages the project holds include a pair the reduction would
 * change, from D1's blocks alone; GitHub is read only for a page whose block
 * D1 does not hold.
 */
export async function holdsReducedPair(access: RepoAccess, head: string, d1: readonly PageCheckD1Page[], siteLanguage: unknown): Promise<boolean> {
  const held = await heldSyncFiles(lazyHeadReader(access, head), d1, new Set());
  return reducePageFiles(held, siteLanguage).removed.length > 0;
}

/** The change a held page takes from the file served at its address: that file's text by default, the author's when the page was edited here. */
async function servedChange(held: SyncPageFile & { page: PageCheckD1Page }, from: SyncPageFile, edited: (f: SyncPageFile) => Promise<boolean>): Promise<PageContentChange> {
  const page = held.page;
  const conflict = await edited(held);
  const kind = conflict ? "conflict" : "github-only";
  return {
    pageId: page.id, slug: from.name.slice(0, -".md".length), title: page.title, kind, acceptByDefault: !conflict,
    expected: await pageRawHash(pageContentAsLoaded(page)), takesLanguageFrom: from.name,
  };
}

/** An added page as the accept reads it: from the file served at its address. */
function servedAddition(addition: PageAddition, source: SyncPageFile, fromSlug: string): PageAddition {
  if (source.addition === addition) return addition;
  return { ...addition, title: source.addition?.title ?? source.page!.title, readFrom: fromSlug };
}

/** The file of the page a removed file is the other language's version of: the one it is served at, else the one it names. */
function stayingFile(removed: SyncPageFile, kept: readonly { file: SyncPageFile; source: SyncPageFile }[]): string {
  const served = kept.find((k) => k.source === removed);
  if (served) return served.file.name;
  const reading = readBlock(removed.frontmatter);
  return reading.kind === "localized" ? reading.localizedFor.text : removed.name;
}

/** A removed held page as `ReducedHeldPage` carries it. */
async function reducedHeldPage(f: SyncPageFile & { page: PageCheckD1Page }, servedAt: number | undefined): Promise<ReducedHeldPage> {
  const { pageId, slug, expected } = await pageFileChange(f.page, f.name, "deleted");
  const text = { title: f.page.title, body: f.page.body ?? "", frontmatter: ownPageFrontmatter(f.frontmatter) };
  return { name: f.name, remove: { pageId, slug, expected }, text, ...(servedAt === undefined ? {} : { servedAt }) };
}

/**
 * The check reduced to one file per page (`reducePageFiles`), over the held
 * pages and the files GitHub added. An added file the reduction removes is
 * not offered. A held page it removes is carried in `reduced`. One the site's
 * language serves at a held page's address has no card: that page takes its
 * text, marked with the file (`takesLanguageFrom`), by default unless the
 * page was edited here. Any other is offered as a removal that names the page
 * that stays (`otherLanguageOf`), removed by default unless it was edited
 * here since the base. For a page GitHub added, the added page is read from
 * the file served at its address. Every removed file stays in the record with
 * no page, so the next publish deletes it.
 */
async function reducedCheck(access: RepoAccess, base: string | null, head: string, check: ConclusiveCheck, scope: PageCheckScope): Promise<ConclusiveCheck> {
  const { kept, removed } = reducePageFiles(await syncPageFiles(access, head, check, scope.d1), scope.siteLanguage);
  const edited = async (f: SyncPageFile) => !!f.page && (await pageEditedSinceBase(access, base, f.page, f.name));
  const removedPages = removed.flatMap((f) => (f.page ? [f.page] : []));
  const record = { ...check.record!, files: { ...check.record!.files, ...Object.fromEntries(removed.map((f) => [f.name, null])) } };
  const files = [...(check.files ?? [])];
  const reduced: ReducedHeldPage[] = [];
  for (const f of removed) {
    if (!f.page) continue;
    const servedAt = kept.find((k) => k.source === f)?.file.page?.id;
    reduced.push(await reducedHeldPage({ ...f, page: f.page }, servedAt));
    if (servedAt !== undefined) continue;
    files.push({ ...(await pageFileChange(f.page, f.name, (await edited(f)) ? "deleted-conflict" : "deleted")), otherLanguageOf: stayingFile(f, kept) });
  }
  let changes = check.changes.filter((c) => !removedPages.some((p) => p.id === c.pageId));
  const additions: PageAddition[] = [];
  for (const { file, source } of kept) {
    const fromSlug = source.name.slice(0, -".md".length);
    if (file.addition) additions.push(servedAddition(file.addition, source, fromSlug));
    if (!file.page || source === file) continue;
    const change = await servedChange({ ...file, page: file.page }, source, edited);
    changes = [...changes.filter((c) => c.pageId !== change.pageId), change];
  }
  return { ...check, changes, files, additions, record, ...(reduced.length > 0 ? { reduced } : {}) };
}

/** A removal named with whether a saved entry names its page. */
function withMenuEntry(change: PageFileChange, scope: PageCheckScope): PageFileChange {
  if (!REMOVAL_KINDS.has(change.kind)) return change;
  const page = scope.d1.find((p) => p.id === change.pageId)!;
  return { ...change, inMenu: scope.saved.some((item) => item.type === "page" && item.slug === page.slug) };
}

/**
 * The page-file check at `base` and `head` over `scope`, its additions and
 * removals named for the dialog. A failure of the check itself, the menu read
 * included, is an answer it could not reach, never an empty one.
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
    const reduced = await reducedCheck(access, base, head, check, scope);
    const additions = await additionsWithMenu(access, head, scope, reduced.additions ?? []);
    if (additions === null) return { conclusive: false, reason: `${NAVIGATION_PATH} could not be read at ${head}` };
    const files = (reduced.files ?? []).map((c) => withMenuEntry(c, scope));
    return { ...reduced, files, additions };
  } catch (err) {
    return { conclusive: false, reason: `the page files could not be checked: ${(err as Error).message}` };
  }
}

/**
 * The record Keep my version writes with `shown`, as stored text: the check's
 * record with nothing applied, every addition with no page (R5), so the next
 * publish deletes it. Undefined when the check does not conclude or cannot
 * run: the record is then carried unchanged.
 */
export async function keptPageFilesRecordJson(
  db: Db,
  projectId: number,
  access: RepoAccess,
  base: string | null,
  shown: string,
): Promise<string | undefined> {
  try {
    const scope = await loadPageCheckScope(db, projectId);
    const check = await checkPageFiles(access, scope, pagesBaseOf(base, scope.record), shown);
    return check.conclusive && check.record ? serialisePageFilesRecord(check.record) : undefined;
  } catch (err) {
    console.warn(`[accept-divergence] project ${projectId}: page files record carried unchanged`, err);
    return undefined;
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
  const content = await readPagesForAccept(access, head, [...additions.map((a) => a.readFrom ?? a.slug), ...restored]);
  const insert = [
    ...additions.map((a): IngestPageInsert => ({
      slug: a.slug, ...content.get(a.readFrom ?? a.slug)!, created_by: null, ...(a.menu ? { menu: a.menu } : {}),
    })),
    ...restored.map((slug): IngestPageInsert => ({ slug, ...content.get(slug)!, created_by: null })),
  ];
  return { insert, remove, stale, unnamed: false };
}

/**
 * The page arms and record of an accept once the held pages the reduction
 * removes (`reduced`) are applied to them. One the site's language serves is
 * removed whichever way its page's decision went, and that page, where its
 * text is accepted, takes the Compositor's copy of it. Any other the author
 * did not choose to remove becomes a page of its own: its text replaced
 * without its language lines, and its file mapped to it in the record.
 */
export function withReducedHeldPages(
  check: ConclusiveCheck,
  accepted: readonly IngestPageReplaceContent[],
  removed: readonly IngestPageRemove[],
): { replaceContent: IngestPageReplaceContent[]; remove: IngestPageRemove[]; record: PageFilesRecord } {
  const reduced = check.reduced ?? [];
  const served = reduced.filter((r) => r.servedAt !== undefined);
  const own = reduced.filter((r) => r.servedAt === undefined && !removed.some((x) => x.pageId === r.remove.pageId));
  const replaceContent = accepted.map((e) => ({ ...e, ...served.find((r) => r.servedAt === e.pageId)?.text }));
  replaceContent.push(...own.map((r) => ({ pageId: r.remove.pageId, expected: r.remove.expected, ...r.text })));
  const files = { ...check.record!.files, ...Object.fromEntries(own.map((r) => [r.name, r.remove.pageId])) };
  return { replaceContent, remove: [...removed, ...served.map((r) => r.remove)], record: { ...check.record!, files } };
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
