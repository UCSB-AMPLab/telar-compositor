/**
 * The compare form of a page file: whether the Compositor's version of a page
 * differs from GitHub's.
 *
 * It compares whole files, never parsed fields: the import's parse trims the
 * body, falls back to the slug for a title it cannot read and keeps a block it
 * cannot parse only as text, so two files a reader tells apart can parse to
 * the same fields. The Compositor's side is the file a publish of the page
 * would commit; GitHub's side is the file as the repository holds it.
 *
 * The two sides differ only by a leading byte-order mark and line endings.
 * The five page files this project owns (`tests/fixtures/pages/`) each
 * re-render byte for byte from the row imported from them, so no other
 * normalisation is admitted: a file differing from its re-rendering in
 * anything else, the count of trailing newlines or blank lines after the
 * block included, compares different.
 *
 * The raw form of a page's content, and its hash, are in `page-canonical.ts`.
 *
 * The change check for page files (`checkPageContent`) and the accept's read
 * of GitHub's version (`readPagesForAccept`) are below the compare form.
 *
 * @version v1.5.0-beta
 */

import { cleanCommitContent } from "~/lib/commit.server";
import type { CommitFile } from "~/lib/commit.server";
import { getSubtreeOids, listSubtreeEntries } from "~/lib/github.server";
import type { FileAtRef } from "~/lib/github.server";
import { parsePageMarkdown } from "~/lib/import.server";
import { pageContentAsLoaded, pageRawHash } from "~/lib/page-canonical";
import type { PageContent } from "~/lib/page-canonical";
import { capturedFrontmatter } from "~/lib/page-frontmatter.server";
import { ownPageFrontmatter } from "~/lib/one-language-pages";
import { UnwritablePageFrontmatterError, carriedPageFile, pageRowsToCommitFiles } from "~/lib/publish.server";
import { readBlobAt, readBlobText } from "~/lib/story-files.server";
import type { RepoAccess } from "~/lib/story-files.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import type { SheetWarning } from "~/lib/sheet-warnings";
import { pushUnreadable } from "~/lib/unreadable-characters.server";
import { isRecordedPageFileName } from "~/lib/page-files-record";
import type { PageFilesRecord } from "~/lib/page-files-record";
import type { IngestPageMenuEntry } from "../../workers/page-menu-entries";

/** A page as the compare form reads it: its content and the slug its file is written at. */
export interface ComparablePage extends PageContent {
  slug: string;
}

/**
 * A leading byte-order mark. The repository's strict reads keep it; the
 * import's read and the publish's carry-forward drop it, so a published file
 * never has one.
 */
const LEADING_BOM = /^﻿/;

/**
 * Line endings as `\n`. The block keeps the line ending it was imported
 * with and the publish frames the page with that ending, while the body keeps
 * whatever its lines had, so a page's line endings are not the author's
 * content on either side.
 */
function withLfEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** GitHub's side: the file with a leading byte-order mark removed and line endings as `\n`. */
export function githubPageFile(file: string): string {
  return withLfEndings(file.replace(LEADING_BOM, ""));
}

/**
 * The Compositor's side: the file a publish of `page` commits, line endings
 * as `\n`, or null when a publish writes no file for it (an empty title or
 * slug).
 *
 * A page whose block was never captured (`frontmatter` null) is published
 * with the block of the file it was imported as, at the publish's revision,
 * read with a leading byte-order mark dropped (`withCarriedFrontmatter`,
 * `readCarryForwardContent`). That file is `carriedFile`: the caller reads it
 * by publish's rule, since it is another page's file when the page's
 * `frontmatter_source` names another slug and that file is present. The block
 * goes through the same writer, so an edit the writer would erase shows as a
 * difference. A block no edit can retitle throws
 * `UnwritablePageFrontmatterError`, as the publish does.
 */
export async function compositorPageFile(page: ComparablePage, carriedFile: string): Promise<string | null> {
  const file = await publishedPageFile(page, carriedFile);
  return file === null ? null : withLfEndings(file.content);
}

/**
 * The file a publish of `page` commits, byte for byte as the commit encodes
 * it, or null when a publish writes no file for it. `carriedFile` and the
 * throw are as for `compositorPageFile`, which is this file with its line
 * endings as `\n`.
 */
export async function publishedPageFile(page: ComparablePage, carriedFile: string): Promise<CommitFile | null> {
  const frontmatter = page.frontmatter ?? capturedFrontmatter(carriedFile.replace(LEADING_BOM, ""));
  const [file] = await pageRowsToCommitFiles([{ ...page, frontmatter }]);
  if (!file) return null;
  return { path: file.path, content: cleanCommitContent(file.path, file.content) };
}

/**
 * True when a publish of `page` would change what `githubFile` holds, beyond
 * a leading byte-order mark and line endings. A page a publish writes no
 * file for differs. `carriedFile` is as for `compositorPageFile`, and is
 * `githubFile` when the page was imported as the file at its own slug.
 */
export async function pageDiffersFromGitHub(
  page: ComparablePage,
  githubFile: string,
  carriedFile: string = githubFile,
): Promise<boolean> {
  return (await compositorPageFile(page, carriedFile)) !== githubPageFile(githubFile);
}

// ---------------------------------------------------------------------------
// The change check for page files
// ---------------------------------------------------------------------------

/** The folder the framework builds pages from, directly and not below. */
export const PAGE_TEXTS_DIR = "telar-content/texts/pages";

/** A page D1 holds, as the change check reads it. */
export interface PageCheckD1Page {
  id: number;
  slug: string;
  title: string;
  body: string | null;
  frontmatter: string | null;
  frontmatter_source: string | null;
}

/** How the dialog lists one page whose file changed on GitHub. */
export type PageContentKind = "github-only" | "conflict";

/**
 * One page the dialog lists. `expected` is the raw hash of D1's content at
 * check time, as the collaboration object's map holds it
 * (`pageContentAsLoaded`): the accept hands it to the collaboration object,
 * which refuses the page when its live map no longer hashes to it.
 */
export interface PageContentChange {
  pageId: number;
  /** The slug of the file the check read, trimmed as publish writes it. */
  slug: string;
  /** D1's title, for the dialog to name the page. */
  title: string;
  kind: PageContentKind;
  /** Whether the dialog takes GitHub's version by default. */
  acceptByDefault: boolean;
  expected: string;
  /** Set when the base has no file at the page's slug: added on both sides. */
  addedBoth?: true;
  /** The file the site's language serves at the page's address, when the page takes its text. */
  takesLanguageFrom?: string;
}

/**
 * How the dialog lists a page file present on one side only.
 * Taking GitHub's side removes the page for the first four, takes GitHub's
 * file onto the page renamed here for `edited-renamed-here`, and restores the
 * page deleted here for `deleted-here-edited`.
 */
export type PageFileKind =
  | "deleted" | "deleted-conflict" | "deleted-renamed-here" | "not-on-github"
  | "edited-renamed-here" | "deleted-here-edited";

/** One page file present on one side only, as the dialog offers it. */
export interface PageFileChange {
  /** The file the check read, by its name in the pages folder. */
  name: string;
  /** The page the change is about; for `deleted-here-edited`, the id the record kept for it. */
  pageId: number;
  /** The page's slug in the Compositor; the file's own for `deleted-here-edited`. */
  slug: string;
  /** D1's title, or for `deleted-here-edited` the title of GitHub's file. */
  title: string;
  kind: PageFileKind;
  acceptByDefault: boolean;
  /** The raw hash of D1's page at check time; empty for `deleted-here-edited`. */
  expected: string;
  /** Whether a saved menu entry names the page, which a removal drops. */
  inMenu?: boolean;
  /** Set when the removal is the one-language reduction's: the file of the page that stays. */
  otherLanguageOf?: string;
}

/** A page file GitHub added, taken by every accept (R2, R6, R7). */
export interface PageAddition {
  name: string;
  slug: string;
  /** The title parsed from GitHub's file. */
  title: string;
  /** The menu entry GitHub's menu gives it, or null (E). */
  menu?: IngestPageMenuEntry | null;
  /** The slug of the file the site's language serves at its address, when that is another file. */
  readFrom?: string;
  /** The file's block as parsed; the check's own, never sent to the dialog. */
  frontmatter?: string | null;
}

/**
 * A held page the one-language reduction removes: its removal, and its text as
 * a page of its own (the Compositor's title and body, its block without the
 * language lines). `servedAt` names the page the site's language serves it
 * at. The check's own, never the dialog's choice.
 */
export interface ReducedHeldPage {
  name: string;
  remove: { pageId: number; slug: string; expected: string };
  text: AcceptedPageContent;
  servedAt?: number;
}

/**
 * The page-file part of the change check: the pages whose file differs, the
 * page files on one side only, and the record the head would carry with
 * nothing applied (`record`: every addition with no page, R5); or why the
 * files could not be read to a conclusion, in which case the site stays
 * divergent and nothing of it is offered.
 */
export type PageContentCheck =
  | {
      conclusive: true; changes: PageContentChange[]; suppressedEditorOnly: number;
      files?: PageFileChange[]; additions?: PageAddition[]; record?: PageFilesRecord; reduced?: ReducedHeldPage[];
    }
  | { conclusive: false; reason: string };

export interface PageCheckInput extends RepoAccess {
  /** The recorded base commit, or null when the site has none. */
  base: string | null;
  /** The HEAD commit every read is pinned to. */
  head: string;
  d1: readonly PageCheckD1Page[];
  /**
   * Receives each page file read at HEAD whose bytes are not valid UTF-8,
   * named by its path. Nothing read at the base is reported.
   */
  warnings?: SheetWarning[];
  /** Receives an added file read lossily when `warnings` is not collected, so it still counts as unreadable. */
  unreadable?: SheetWarning[];
  /** The page files record as stored (A); null or absent for none. */
  record?: PageFilesRecord | null;
  /** The last publish's `page_slugs`, read only while there is no record (R9). */
  publishedSlugs?: readonly string[];
}

/**
 * The name, relative to the pages folder, of the file a page is held by: its
 * trimmed slug, whatever its title. Null for a page the check leaves alone:
 * one with no slug, and one whose slug puts its file in a subfolder, which the
 * framework does not build.
 *
 * A page with a blank title is held too. A publish writes no file for it
 * (`compositorPageFile` answers null), so it compares as changed here, and a
 * GitHub edit to its file is a conflict the author is offered. Leaving it out
 * would read that edit as nothing, and once the title is back a publish would
 * write over an edit nobody was shown.
 */
export function heldPageFileName(page: { slug: string | null }): string | null {
  const slug = (page.slug ?? "").trim();
  return slug === "" || slug.includes("/") ? null : `${slug}.md`;
}

/**
 * The pages folder at each commit, as blob SHAs by path relative to it, or
 * why it cannot be trusted: a commit that does not resolve or a malformed
 * answer, anything but a tree at the path, or a listing `listSubtreeEntries`
 * does not accept (truncated, or holding a symlink or a submodule anywhere
 * below). A folder absent at a commit that resolves is empty there.
 */
async function pageTrees(access: RepoAccess, commits: readonly string[]): Promise<Map<string, Map<string, string>> | string> {
  const { token, owner, repo } = access;
  const trees = await getSubtreeOids(token, owner, repo, commits, [PAGE_TEXTS_DIR]);
  if (!trees.ok) return `the page trees came back ${trees.reason}`;
  const out = new Map<string, Map<string, string>>();
  for (const commit of commits) {
    const at = trees.at(commit, PAGE_TEXTS_DIR);
    if (at.kind === "absent") {
      out.set(commit, new Map());
      continue;
    }
    if (at.kind !== "tree") return `${PAGE_TEXTS_DIR} is not a tree at ${commit}`;
    const listing = await listSubtreeEntries(token, owner, repo, at.oid);
    if (listing === null) return `${PAGE_TEXTS_DIR} could not be listed completely`;
    out.set(commit, listing.files);
  }
  return out;
}

/**
 * The pages folder at `commit`, as blob SHAs by path relative to it, or why it
 * cannot be trusted, as `pageTrees` reads it.
 */
export async function pageFolderFiles(access: RepoAccess, commit: string): Promise<Map<string, string> | string> {
  const trees = await pageTrees(access, [commit]);
  return typeof trees === "string" ? trees : (trees.get(commit) ?? new Map());
}

/**
 * A strict read of a file in the pages folder at `commit`, answered from the
 * folder's listing there: absent when the listing has no such file, else its
 * text by blob SHA (`readBlobText`, which keeps each blob read), or a failed
 * read. The reader `carriedPageFile` takes. A file whose bytes are not valid
 * UTF-8 reads with `lossy` set.
 */
export function pageFileReader(
  access: RepoAccess,
  commit: string,
  files: ReadonlyMap<string, string>,
): (path: string) => Promise<FileAtRef> {
  return async (path) => {
    const name = path.startsWith(`${PAGE_TEXTS_DIR}/`) ? path.slice(PAGE_TEXTS_DIR.length + 1) : null;
    const sha = name === null ? undefined : files.get(name);
    if (sha === undefined) return { status: "absent" };
    try {
      return okRead(await readBlobAt(access, commit, path, sha));
    } catch (err) {
      if (err instanceof SheetUnreadableError) return { status: "error" };
      throw err;
    }
  };
}

/** A blob read as `getFileAtRef` answers it, the flag set only for lossy bytes. */
function okRead(blob: { text: string; lossy: boolean }): FileAtRef {
  return blob.lossy ? { status: "ok", content: blob.text, lossy: true } : { status: "ok", content: blob.text };
}

/**
 * `read`, naming in `warnings` each file it reads lossily. A page with a
 * blank title is not written by a publish until it has one, so its warning
 * says to give it one first.
 */
function reportingReader(
  read: (path: string) => Promise<FileAtRef>,
  page: PageCheckD1Page,
  warnings: SheetWarning[] | undefined,
): (path: string) => Promise<FileAtRef> {
  const repair = page.title.trim() === "" ? "title_then_publish" : "publish";
  return async (path) => {
    const answer = await read(path);
    if (answer.status === "ok" && answer.lossy) pushUnreadable(warnings, path, repair);
    return answer;
  };
}

/** A read the check needs failed: the check is inconclusive, never "no change". */
class PageReadFailed extends Error {
  constructor(path: string, commit: string) {
    super(`${path} could not be read at ${commit}`);
    this.name = "PageReadFailed";
  }
}

/**
 * A page's own file at `commit`, and the file a publish would carry its
 * block from there, read by publish's rule (`carriedPageFile`), which is its
 * own file for a page whose block was captured. Each file read lossily is
 * named in `warnings` when a list is given.
 */
async function pageFilesAt(
  access: RepoAccess,
  commit: string,
  files: ReadonlyMap<string, string>,
  page: PageCheckD1Page,
  name: string,
  warnings?: SheetWarning[],
): Promise<{ file: string; carried: string }> {
  const read = reportingReader(pageFileReader(access, commit, files), page, warnings);
  const path = `${PAGE_TEXTS_DIR}/${name}`;
  const own = await read(path);
  if (own.status !== "ok") throw new PageReadFailed(path, commit);
  if (page.frontmatter !== null) return { file: own.content, carried: own.content };
  const carried = await carriedPageFile(page, read);
  if (!carried.ok) throw new PageReadFailed(carried.path, commit);
  return { file: own.content, carried: carried.content };
}

/**
 * Whether D1's page differs from its file at `base`, the Compositor's side of
 * `classifyPage`: true with no base, or no file at the base, since nothing
 * then says the page is unchanged here.
 */
export async function pageEditedSinceBase(access: RepoAccess, base: string | null, page: PageCheckD1Page, name: string): Promise<boolean> {
  const files = base === null ? null : await pageFolderFiles(access, base);
  if (typeof files === "string") throw new PageReadFailed(`${PAGE_TEXTS_DIR}/${name}`, base!);
  if (files === null || !files.has(name)) return true;
  const read = await pageFilesAt(access, base!, files, page, name);
  const comparable: ComparablePage = { slug: name.slice(0, -".md".length), title: page.title, body: page.body, frontmatter: page.frontmatter };
  return pageDiffersFromGitHub(comparable, read.file, read.carried);
}

type ClassifiedPage = PageContentChange | "none" | "editor-only";

/**
 * One page D1 holds whose file HEAD has, classified by whole files (the
 * compare form above):
 * - with a base, its file's blob unchanged: nothing, and nothing is read;
 * - with a base that has no file at its slug, added on both sides: any
 *   difference is a conflict, kept by default;
 * - HEAD's file what a publish of D1's page would write: nothing;
 * - with a base: GitHub's file unchanged but for a byte-order mark and line
 *   endings, the Compositor only (not listed); else the Compositor's page
 *   differing from the base file, both (a conflict, kept by default); else
 *   GitHub only (listed, taken by default);
 * - with no base, nothing tells which side changed, so any difference is a
 *   conflict.
 */
async function classifyPage(
  input: PageCheckInput,
  trees: Map<string, Map<string, string>>,
  page: PageCheckD1Page,
  name: string,
): Promise<ClassifiedPage> {
  const headFiles = trees.get(input.head)!;
  const headSha = headFiles.get(name);
  if (headSha === undefined) return "none";
  const baseFiles = input.base ? trees.get(input.base)! : null;
  const baseSha = baseFiles?.get(name);
  if (baseSha === headSha) return "none";
  const slug = name.slice(0, -".md".length);
  const comparable: ComparablePage = { slug, title: page.title, body: page.body, frontmatter: page.frontmatter };
  const head = await pageFilesAt(input, input.head, headFiles, page, name, input.warnings);
  if (!(await pageDiffersFromGitHub(comparable, head.file, head.carried))) return "none";
  const change = async (kind: PageContentKind): Promise<PageContentChange> => ({
    pageId: page.id,
    slug,
    title: page.title,
    kind,
    acceptByDefault: kind === "github-only",
    expected: await pageRawHash(pageContentAsLoaded(page)),
  });
  if (!baseFiles) return change("conflict");
  if (baseSha === undefined) return { ...(await change("conflict")), addedBoth: true };
  const base = await pageFilesAt(input, input.base!, baseFiles, page, name);
  if (githubPageFile(head.file) === githubPageFile(base.file)) return "editor-only";
  const editorChanged = await pageDiffersFromGitHub(comparable, base.file, base.carried);
  return change(editorChanged ? "conflict" : "github-only");
}

/** What one file name's reading adds to the check (`readFileName`). */
interface FileReading {
  change?: PageFileChange;
  addition?: PageAddition;
  /** The file's record entry at HEAD; undefined leaves it out. */
  recorded?: number | null;
  suppressed?: true;
}

/** The pages folder at the base and HEAD, the record and D1, as the readings of B take them. */
interface FileScope {
  input: PageCheckInput;
  headFiles: Map<string, string>;
  baseFiles: Map<string, string> | null;
  byId: Map<number, PageCheckD1Page>;
  /** Over no record, the files the last publish's `page_slugs` names (R9). */
  published: Set<string>;
}

export async function pageFileChange(page: PageCheckD1Page, name: string, kind: PageFileKind): Promise<PageFileChange> {
  return {
    name, pageId: page.id, slug: page.slug.trim(), title: page.title, kind,
    acceptByDefault: kind === "deleted",
    expected: await pageRawHash(pageContentAsLoaded(page)),
  };
}

/**
 * A held page GitHub has no file for: with no base, not on GitHub (kept by
 * default); absent at the base too, added here (left out); else deleted on
 * GitHub, a conflict when the page differs from the base file.
 */
async function absentHeldReading(scope: FileScope, page: PageCheckD1Page, name: string): Promise<FileReading> {
  const { input, baseFiles } = scope;
  if (!baseFiles) return { change: await pageFileChange(page, name, "not-on-github") };
  if (!baseFiles.has(name)) return { suppressed: true };
  const base = await pageFilesAt(input, input.base!, baseFiles, page, name);
  const comparable: ComparablePage = { slug: name.slice(0, -".md".length), title: page.title, body: page.body, frontmatter: page.frontmatter };
  const edited = await pageDiffersFromGitHub(comparable, base.file, base.carried);
  return { change: await pageFileChange(page, name, edited ? "deleted-conflict" : "deleted") };
}

/** GitHub's file at HEAD, parsed; a lossy one is named and answers null. */
async function readAddedFile(scope: FileScope, name: string): Promise<{ title: string; frontmatter: string | null } | null> {
  const { input, headFiles } = scope;
  const path = `${PAGE_TEXTS_DIR}/${name}`;
  const read = await pageFileReader(input, input.head, headFiles)(path);
  if (read.status !== "ok") throw new PageReadFailed(path, input.head);
  if (read.lossy) {
    pushUnreadable(input.warnings ?? input.unreadable, path);
    return null;
  }
  const parsed = parsePageMarkdown(read.content.replace(LEADING_BOM, ""), name.slice(0, -".md".length));
  return { title: parsed.title ?? "", frontmatter: parsed.frontmatter ?? null };
}

/**
 * A file the record gives a page that no longer holds it: renamed here when
 * D1 still has the page, deleted here when not. Unchanged on GitHub, left out;
 * deleted there, offered when renamed here; edited there, offered.
 */
async function recordedPageReading(scope: FileScope, name: string, id: number): Promise<FileReading> {
  const { headFiles, baseFiles } = scope;
  const page = scope.byId.get(id);
  const headSha = headFiles.get(name);
  const baseSha = baseFiles?.get(name);
  if (headSha === undefined) {
    return page && baseSha !== undefined ? { change: await pageFileChange(page, name, "deleted-renamed-here") } : {};
  }
  if (baseSha === headSha) return { recorded: id, suppressed: true };
  if (page) return { recorded: id, change: await pageFileChange(page, name, "edited-renamed-here") };
  const read = await readAddedFile(scope, name);
  if (read === null) return { recorded: id };
  const slug = name.slice(0, -".md".length);
  return {
    recorded: id,
    change: { name, pageId: id, slug, title: read.title, kind: "deleted-here-edited", acceptByDefault: false, expected: "" },
  };
}

/**
 * A file no page holds, read by B's rows after the held page: the record's
 * page, the record's file with no page (R5), the old file of a page renamed
 * or deleted here over no record (R9), or an addition (R6, R7), which a lossy
 * read leaves out of the record.
 */
async function unheldReading(scope: FileScope, name: string): Promise<FileReading> {
  const record = scope.input.record ?? null;
  const entry = record && Object.hasOwn(record.files, name) ? record.files[name] : undefined;
  if (typeof entry === "number") return recordedPageReading(scope, name, entry);
  if (!scope.headFiles.has(name)) return {};
  if (entry === null || (record === null && scope.published.has(name))) return { recorded: null };
  const read = await readAddedFile(scope, name);
  if (read === null) return {};
  return { recorded: null, addition: { name, slug: name.slice(0, -".md".length), ...read } };
}

/** The file names B reads: every `.md` file directly in the folder at either commit, and every held page's. */
function fileNamesOf(scope: FileScope, held: ReadonlyMap<string, PageCheckD1Page>): string[] {
  const names = new Set([...held.keys(), ...scope.headFiles.keys(), ...(scope.baseFiles?.keys() ?? [])]);
  return [...names].filter(isRecordedPageFileName).sort();
}

/** The readings of B over every file name, beside the held pages' content changes. */
async function readFileNames(
  scope: FileScope,
  held: ReadonlyMap<string, PageCheckD1Page>,
): Promise<{ files: PageFileChange[]; additions: PageAddition[]; record: PageFilesRecord; suppressed: number }> {
  const out = { files: [] as PageFileChange[], additions: [] as PageAddition[], suppressed: 0 };
  const files: Record<string, number | null> = {};
  for (const name of fileNamesOf(scope, held)) {
    const page = held.get(name);
    if (page && scope.headFiles.has(name)) {
      files[name] = page.id;
      continue;
    }
    const reading = page ? await absentHeldReading(scope, page, name) : await unheldReading(scope, name);
    if (reading.change) out.files.push(reading.change);
    if (reading.addition) out.additions.push(reading.addition);
    if (reading.recorded !== undefined) files[name] = reading.recorded;
    if (reading.suppressed) out.suppressed++;
  }
  return { ...out, record: { commit: scope.input.head, files } };
}

/** The content changes of the held pages whose file HEAD has (`classifyPage`). */
async function heldContentChanges(
  input: PageCheckInput,
  trees: Map<string, Map<string, string>>,
  held: ReadonlyMap<string, PageCheckD1Page>,
): Promise<{ changes: PageContentChange[]; suppressedEditorOnly: number }> {
  const changes: PageContentChange[] = [];
  let suppressedEditorOnly = 0;
  for (const [name, page] of held) {
    if (!trees.get(input.head)!.has(name)) continue;
    const result = await classifyPage(input, trees, page, name);
    if (result === "editor-only") suppressedEditorOnly++;
    else if (result !== "none") changes.push(result);
  }
  return { changes, suppressedEditorOnly };
}

/** Each page held by a file, by that file's name. */
function heldByName(d1: readonly PageCheckD1Page[]): Map<string, PageCheckD1Page> {
  const held = new Map<string, PageCheckD1Page>();
  for (const page of d1) {
    const name = heldPageFileName(page);
    if (name !== null) held.set(name, page);
  }
  return held;
}

/**
 * The page files compared across the base, HEAD, D1 and the record, every read at the one HEAD commit (or the base) it is given and
 * strict: a file absent is absent, and any other failure makes the check
 * inconclusive, never a value. So is a page whose front matter no publish
 * could write (`UnwritablePageFrontmatterError`), since no side of it can be
 * rendered to compare.
 *
 * A page held at a file HEAD has is compared by content (`classifyPage`):
 * whether HEAD's file is what a publish would write (nothing to do); whether
 * GitHub changed the file between the base and HEAD, both GitHub's files read
 * the same way; whether the Compositor changed the page, which is D1's page
 * differing from the base file by `pageDiffersFromGitHub`. Every other `.md`
 * file directly in the folder at either commit, and every held page HEAD has
 * no file for, is read by B's rows (`readFileNames`); a file in a subfolder,
 * which the framework does not build, and any other name are not.
 *
 * With a base, only files whose blob changed between the base and HEAD are
 * read, besides the added files whose title the dialog shows. Each file is
 * read once per blob SHA and kept for later checks (`readBlobText`). A project
 * holding no page still reads the folder: a page GitHub added matters there.
 */
export async function checkPageContent(input: PageCheckInput): Promise<PageContentCheck> {
  const held = heldByName(input.d1);
  const trees = await pageTrees(input, input.base ? [input.base, input.head] : [input.head]);
  if (typeof trees === "string") return { conclusive: false, reason: trees };
  const scope: FileScope = {
    input,
    headFiles: trees.get(input.head)!,
    baseFiles: input.base ? trees.get(input.base)! : null,
    byId: new Map(input.d1.map((page) => [page.id, page])),
    published: new Set(input.record ? [] : (input.publishedSlugs ?? []).map((slug) => `${slug}.md`)),
  };
  try {
    const { changes, suppressedEditorOnly } = await heldContentChanges(input, trees, held);
    const { suppressed, ...files } = await readFileNames(scope, held);
    return { conclusive: true, changes, suppressedEditorOnly: suppressedEditorOnly + suppressed, ...files };
  } catch (err) {
    if (err instanceof PageReadFailed || err instanceof UnwritablePageFrontmatterError) {
      return { conclusive: false, reason: err.message };
    }
    throw err;
  }
}

/** GitHub's version of a page as an accept brings it in. */
export type AcceptedPageContent = PageContent & { body: string; frontmatter: string };

/**
 * The accepted pages' content at `head`, by slug, parsed as the import
 * parses a page file (`parsePageMarkdown`, the byte-order mark dropped as the
 * import's read drops it), a block naming another page by `localized_for`
 * taken without its language lines (`ownPageFrontmatter`). The comparison
 * stays whole-file; this parse is only what the accept stores.
 *
 * Read strictly, through the check's own readers, so the file imported is the
 * file the check compared: the pages folder listed at `head`, each file by
 * its blob. A folder that cannot be listed, a file no longer there, and a
 * read that fails all throw: the accept does not import a guess.
 */
export async function readPagesForAccept(
  access: RepoAccess,
  head: string,
  slugs: readonly string[],
): Promise<Map<string, AcceptedPageContent>> {
  const out = new Map<string, AcceptedPageContent>();
  if (slugs.length === 0) return out;
  const trees = await pageTrees(access, [head]);
  if (typeof trees === "string") throw new Error(`the accepted pages could not be read: ${trees}`);
  const files = trees.get(head)!;
  for (const slug of slugs) {
    const path = `${PAGE_TEXTS_DIR}/${slug}.md`;
    const sha = files.get(`${slug}.md`);
    if (sha === undefined) throw new Error(`${path} is not in the commit the check read`);
    const text = await readBlobText(access, head, path, sha);
    const page = parsePageMarkdown(text.replace(LEADING_BOM, ""), slug);
    out.set(slug, { ...page, frontmatter: ownPageFrontmatter(page.frontmatter) });
  }
  return out;
}
