/**
 * What HEAD holds against what D1 would publish, for the GitHub status
 * refresh (github-status.server.ts). `contentFilesMayHaveChanged` settles from
 * trees alone whether a D1 story's or page's files may have changed between
 * two commits. `renderedContentMatchesHead` settles whether HEAD already holds
 * what a publish of D1's stories and pages would commit, by git blob SHA; the
 * only files it reads are a story CSV whose blob is not the plain render, and
 * the file a page whose block was never captured carries it from. Every
 * answer the trees cannot settle is the conservative one, "may have changed"
 * or "no match".
 *
 * @version v1.5.5-beta
 */
import { eq } from "drizzle-orm";
import { layers, project_config, project_pages, projects, steps, stories } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { getFileAtRef, getSubtreeOids, listSubtreeFiles } from "~/lib/github.server";
import type { SubtreeAt } from "~/lib/github.server";
import { carriedPageFile, renderStoryFiles } from "~/lib/publish.server";
import { PAGE_TEXTS_DIR, heldPageFileName, pageFileReader, publishedPageFile } from "~/lib/page-content.server";
import { isRecordedPageFileName, parsePageFilesRecord } from "~/lib/page-files-record";
import type { PageCheckD1Page } from "~/lib/page-content.server";
import type { CommitFile } from "~/lib/commit.server";
import { gitBlobSha } from "~/lib/story-files.server";

const SPREADSHEETS_DIR = "telar-content/spreadsheets";
const STORY_TEXTS_DIR = "telar-content/texts/stories";

type Db = ReturnType<typeof getDb>;

const INCONCLUSIVE = null;

/**
 * One story subtree at both commits, as a comparable pair: both files maps,
 * with an absent subtree as an empty map, or null when the trees cannot
 * settle it (anything but a tree at the path, a tree at one commit only, or
 * a listing `listSubtreeFiles` cannot trust). Equal oids are listed once.
 */
async function subtreePair(
  token: string,
  owner: string,
  repo: string,
  before: SubtreeAt,
  after: SubtreeAt,
): Promise<{ same: boolean; before: Map<string, string>; after: Map<string, string> } | null> {
  if (before.kind === "absent" && after.kind === "absent") return { same: true, before: new Map(), after: new Map() };
  if (before.kind !== "tree" || after.kind !== "tree") return INCONCLUSIVE;
  if (before.oid === after.oid) {
    const files = await listSubtreeFiles(token, owner, repo, before.oid);
    return files === null ? INCONCLUSIVE : { same: true, before: files, after: files };
  }
  const [b, a] = await Promise.all([
    listSubtreeFiles(token, owner, repo, before.oid),
    listSubtreeFiles(token, owner, repo, after.oid),
  ]);
  return b === null || a === null ? INCONCLUSIVE : { same: false, before: b, after: a };
}

/**
 * Whether the files of a D1 story or page may have changed between `base`
 * and `head`, decided from trees alone, all three subtrees read in one
 * request: any blob change under `texts/stories`, a change to
 * `spreadsheets/<story>.csv` for a story D1 holds, or a page file added,
 * removed or changed as the change check reads it (`pageFilesMayHaveChanged`).
 *
 * It answers "may have changed" whenever the trees cannot settle it: a commit
 * that does not resolve or a malformed answer (`getSubtreeOids`), anything
 * but a tree at a subtree path, a story subtree at one commit only, a
 * truncated listing, or a symlink or submodule anywhere in a subtree it
 * lists. A story subtree absent at both commits is no change.
 */
export async function contentFilesMayHaveChanged(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
  storyIds: readonly string[],
  pageFileNames: ReadonlySet<string>,
): Promise<boolean> {
  const trees = await getSubtreeOids(token, owner, repo, [base, head], [SPREADSHEETS_DIR, STORY_TEXTS_DIR, PAGE_TEXTS_DIR]);
  if (!trees.ok) return true;
  if (await storyFilesMayHaveChanged(token, owner, repo, base, head, trees, storyIds)) return true;
  return pageFilesMayHaveChanged(token, owner, repo, trees.at(base, PAGE_TEXTS_DIR), trees.at(head, PAGE_TEXTS_DIR), pageFileNames);
}

type SubtreeAnswers = Extract<Awaited<ReturnType<typeof getSubtreeOids>>, { ok: true }>;

/** The story half of `contentFilesMayHaveChanged`. */
async function storyFilesMayHaveChanged(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
  trees: SubtreeAnswers,
  storyIds: readonly string[],
): Promise<boolean> {
  const texts = trees.at(base, STORY_TEXTS_DIR);
  const textsAfter = trees.at(head, STORY_TEXTS_DIR);
  if (texts.kind === "tree" && textsAfter.kind === "tree" && texts.oid !== textsAfter.oid) return true;
  const [sheets, textPair] = await Promise.all([
    subtreePair(token, owner, repo, trees.at(base, SPREADSHEETS_DIR), trees.at(head, SPREADSHEETS_DIR)),
    subtreePair(token, owner, repo, texts, textsAfter),
  ]);
  if (sheets === null || textPair === null) return true;
  if (sheets.same) return false;
  return storyIds.some((id) => sheets.before.get(`${id}.csv`) !== sheets.after.get(`${id}.csv`));
}

/**
 * Whether the page files may have changed between the two commits as the
 * change check reads them: a `.md` file directly in the pages
 * folder added, or one of `watchedNames` (the files a page holds or the
 * record gives a page) removed or with a different blob. A file in a
 * subfolder, which the framework does not build, is not a change.
 *
 * It answers "may have changed" whenever the trees cannot settle it: anything
 * but a tree at the path, or a listing `listSubtreeFiles` cannot trust. The
 * folder absent at both commits is no change, and absent at one only is one.
 */
async function pageFilesMayHaveChanged(
  token: string,
  owner: string,
  repo: string,
  before: SubtreeAt,
  after: SubtreeAt,
  watchedNames: ReadonlySet<string>,
): Promise<boolean> {
  if (before.kind === "other" || after.kind === "other") return true;
  if (before.kind === "absent" || after.kind === "absent") return before.kind !== after.kind;
  const pair = await subtreePair(token, owner, repo, before, after);
  if (pair === null) return true;
  if (pair.same) return false;
  const added = [...pair.after.keys()].some((name) => isRecordedPageFileName(name) && !pair.before.has(name));
  return added || [...watchedNames].some((name) => pair.before.get(name) !== pair.after.get(name));
}

/** A project's story rows. */
export function storyRowsOf(db: Db, projectId: number) {
  return db.select().from(stories).where(eq(stories.project_id, projectId));
}

export type StoryRow = Awaited<ReturnType<typeof storyRowsOf>>[number];

/** A story's step and layer rows, read as a publish reads them. */
async function storyContentRows(db: Db, story: StoryRow) {
  const stepRows = await db.select().from(steps).where(eq(steps.story_id, story.id));
  const layerRows: (typeof layers.$inferSelect)[] = [];
  for (const step of stepRows) {
    layerRows.push(...(await db.select().from(layers).where(eq(layers.step_id, step.id))));
  }
  return { stepRows, layerRows };
}

/**
 * Whether HEAD already holds exactly what a publish of D1's stories would
 * commit: each story's step CSV and layer files, rendered by
 * `renderStoryFiles`, have the git blob SHA HEAD's tree gives their paths.
 * A differing or missing file is a difference. A file HEAD has that the
 * render does not produce is one only if a story's step CSV names it, and
 * then that CSV differs from the rendered one, so it is already counted;
 * a file no CSV names changes no story. Blob SHAs are compared; the only file
 * read is a story CSV whose blob is not the plain render, which the publish
 * wrote in the file's own layout (`storyFilesAsPublished`).
 *
 * A HEAD the trees cannot settle is no match: a commit that does not resolve
 * or a malformed answer, anything but a tree at a subtree path, a truncated
 * listing, or a symlink or submodule in a story subtree (`listSubtreeFiles`), so a
 * symlink where a rendered file should be is a mismatch even when its blob
 * SHA happens to equal the rendered file's.
 */
async function renderedStoriesMatchHead(
  token: string,
  owner: string,
  repo: string,
  head: string,
  db: Db,
  projectId: number,
  storyRows: StoryRow[],
): Promise<boolean> {
  const trees = await getSubtreeOids(token, owner, repo, [head], [SPREADSHEETS_DIR, STORY_TEXTS_DIR]);
  if (!trees.ok) return false;
  const headBlobs = new Map<string, string>();
  for (const dir of [SPREADSHEETS_DIR, STORY_TEXTS_DIR]) {
    const at = trees.at(head, dir);
    if (at.kind === "other") return false;
    if (at.kind === "absent") continue;
    const files = await listSubtreeFiles(token, owner, repo, at.oid);
    if (files === null) return false;
    for (const [path, sha] of files) headBlobs.set(`${dir}/${path}`, sha);
  }
  const [config] = await db
    .select({ lang: project_config.lang })
    .from(project_config)
    .where(eq(project_config.project_id, projectId));
  const siteLang = config?.lang ?? undefined;
  for (const story of storyRows) {
    const { stepRows, layerRows } = await storyContentRows(db, story);
    const at = { token, owner, repo, head, headBlobs };
    if (!(await storyMatchesHead(at, story.story_id, stepRows, layerRows, siteLang))) return false;
  }
  return true;
}

/** What reading a story's files at HEAD needs: the repository, HEAD, and the blob SHAs HEAD's story subtrees hold. */
interface StoryHeadRead {
  token: string;
  owner: string;
  repo: string;
  head: string;
  headBlobs: ReadonlyMap<string, string>;
}

/** Whether HEAD's blobs hold every file a publish writes for one story, in the layout of the story's CSV at HEAD. */
async function storyMatchesHead(
  at: StoryHeadRead,
  storyId: string,
  stepRows: Parameters<typeof renderStoryFiles>[1],
  layerRows: Parameters<typeof renderStoryFiles>[2],
  siteLang: string | undefined,
): Promise<boolean> {
  const files = await storyFilesAsPublished(
    at,
    storyId,
    await renderStoryFiles(storyId, stepRows, layerRows, siteLang),
    (existingCsv) => renderStoryFiles(storyId, stepRows, layerRows, siteLang, existingCsv),
  );
  if (files === null) return false;
  for (const file of files) {
    if (at.headBlobs.get(file.path) !== (await gitBlobSha(file.content))) return false;
  }
  return true;
}

/**
 * A story's files as a publish writes them. The publish writes the step CSV in
 * the file's own layout, so when HEAD's CSV is another blob than the plain
 * render, it is read strictly at HEAD and the story rendered again in that
 * layout, as `storyFilesForPublish` does. A CSV HEAD lacks, or one that cannot
 * be read, gives no files: the story does not match.
 */
async function storyFilesAsPublished(
  at: StoryHeadRead,
  storyId: string,
  plain: CommitFile[],
  renderIn: (existingCsv: string) => Promise<CommitFile[]>,
): Promise<CommitFile[] | null> {
  const path = `${SPREADSHEETS_DIR}/${storyId}.csv`;
  const headSha = at.headBlobs.get(path);
  const plainCsv = plain.find((file) => file.path === path);
  if (headSha === undefined || plainCsv === undefined || headSha === (await gitBlobSha(plainCsv.content))) return plain;
  const read = await getFileAtRef(at.token, at.owner, at.repo, path, at.head, { strict: true });
  return read.status === "ok" ? renderIn(read.content) : null;
}

/** The files a page holds, and those the stored record gives a page. */
export async function watchedPageFiles(db: Db, projectId: number, pageRows: readonly PageCheckD1Page[]): Promise<Set<string>> {
  const [stored] = await db.select({ record: projects.page_files_json }).from(projects).where(eq(projects.id, projectId));
  const recorded = Object.entries(parsePageFilesRecord(stored?.record)?.files ?? {}).flatMap(([name, id]) => (id === null ? [] : [name]));
  return new Set([...pageRows.flatMap((page) => heldPageFileName(page) ?? []), ...recorded]);
}

/** A project's pages, as the refresh compares them. */
export function pageRowsOf(db: Db, projectId: number): Promise<PageCheckD1Page[]> {
  return db
    .select({
      id: project_pages.id,
      slug: project_pages.slug,
      title: project_pages.title,
      body: project_pages.body,
      frontmatter: project_pages.frontmatter,
      frontmatter_source: project_pages.frontmatter_source,
    })
    .from(project_pages)
    .where(eq(project_pages.project_id, projectId));
}

/**
 * Whether HEAD already holds exactly what a publish of D1's pages would
 * commit: each page's file (`publishedPageFile`), directly in the pages
 * folder, has the git blob SHA HEAD's tree gives its path. A differing or
 * missing file is a difference, and so is a `.md` file directly in the
 * folder that no page holds, which the change check reads as an addition. A page whose block was never captured is rendered with the block
 * of the file publish carries it from, read at HEAD by publish's own rule
 * (`carriedPageFile`), and that read is the only file read here; a captured
 * page reads none. A page whose title is blank, for which a publish writes no
 * file, is no match while HEAD holds a file at its slug (`heldPageFileName`).
 *
 * A HEAD the trees cannot settle is no match, as for the stories: a commit
 * that does not resolve, anything but a tree at the path, a listing that
 * cannot be trusted, a carried file that cannot be read, and a page whose
 * front matter no publish could write.
 */
async function renderedPagesMatchHead(
  token: string,
  owner: string,
  repo: string,
  head: string,
  pageRows: readonly PageCheckD1Page[],
): Promise<boolean> {
  const held = pageRows.flatMap((page) => {
    const name = heldPageFileName(page);
    return name === null ? [] : [{ page, name }];
  });
  const files = await pageFilesAtHead(token, owner, repo, head);
  if (files === null) return false;
  const heldNames = new Set(held.map(({ name }) => name));
  if ([...files.keys()].some((name) => isRecordedPageFileName(name) && !heldNames.has(name))) return false;
  const read = pageFileReader({ token, owner, repo }, head, files);
  try {
    for (const { page, name } of held) {
      if (!(await renderedPageMatches(page, name, files, read))) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * The pages folder at `head`, blob SHAs by path relative to it, or null when
 * the tree cannot settle it (`renderedPagesMatchHead`). A folder absent at a
 * commit that resolves is empty.
 */
async function pageFilesAtHead(token: string, owner: string, repo: string, head: string): Promise<Map<string, string> | null> {
  const trees = await getSubtreeOids(token, owner, repo, [head], [PAGE_TEXTS_DIR]);
  if (!trees.ok) return null;
  const at = trees.at(head, PAGE_TEXTS_DIR);
  if (at.kind === "other") return null;
  if (at.kind === "absent") return new Map();
  return listSubtreeFiles(token, owner, repo, at.oid);
}

/**
 * Whether HEAD holds, at `name`, the blob a publish of `page` would commit,
 * the block of a page never captured carried by publish's rule through
 * `read`. A page a publish writes no file for, and a carried file that cannot
 * be read, are no match; a block no publish could write throws.
 */
async function renderedPageMatches(
  page: PageCheckD1Page,
  name: string,
  files: ReadonlyMap<string, string>,
  read: ReturnType<typeof pageFileReader>,
): Promise<boolean> {
  const carried = page.frontmatter === null ? await carriedPageFile(page, read) : { ok: true as const, content: "" };
  if (!carried.ok) return false;
  const slug = name.slice(0, -".md".length);
  const file = await publishedPageFile({ slug, title: page.title, body: page.body, frontmatter: page.frontmatter }, carried.content);
  return file !== null && files.get(name) === (await gitBlobSha(file.content));
}

/**
 * Whether HEAD already holds what a publish of D1's stories and pages would
 * commit (`renderedStoriesMatchHead`, `renderedPagesMatchHead`). No story
 * reads no story tree.
 */
export async function renderedContentMatchesHead(
  token: string,
  owner: string,
  repo: string,
  head: string,
  db: Db,
  projectId: number,
  storyRows: StoryRow[],
  pageRows: readonly PageCheckD1Page[],
): Promise<boolean> {
  const storiesMatch =
    storyRows.length === 0 || (await renderedStoriesMatchHead(token, owner, repo, head, db, projectId, storyRows));
  return storiesMatch && renderedPagesMatchHead(token, owner, repo, head, pageRows);
}
