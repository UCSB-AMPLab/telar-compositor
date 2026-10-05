/**
 * What an object's ID change writes, worked out from the reads taken at one
 * head and from D1.
 *
 * The new ID follows the upload's rule, has to survive the site's sheet
 * reader (on a release under 1.8.0, no pandas missing-value token and no
 * all-digit id), and has to be the object's alone. No
 * other row may carry it as written, or be read by the site as it, an image
 * extension stripped or the letter case folded, since a step is matched
 * ignoring case when no exact match exists. No file of the objects folder
 * other than the object's own may sit under it, as a flat file's stem or a
 * folder's name, compared ignoring case: the move would put two images under
 * one ID. "Other row" covers D1's rows other than the object's and the
 * sheet's rows whose id is not the object's, as written or stripped.
 *
 * The commit's texts are objects.csv with the object's rows renamed in place,
 * every story CSV whose `object` cells or inline layer text change,
 * glossary.csv's definitions, and the Markdown files under the story layer,
 * page and glossary folders whose references to a moved file change. Inside
 * a collision nothing that names a file is rewritten: the file and the tiles
 * under the shared site ID stay the other row's.
 *
 * Every repository read is strict, and a file that cannot be read, or that
 * decodes lossily, refuses the rename with `rename_failed` and nothing
 * committed, since a file rewritten from a partial read would lose what the
 * read missed.
 *
 * @version v1.5.0-beta
 */

import { getFileAtRef, type TreeEntry } from "~/lib/github.server";
import { collectObjectBlobPaths } from "~/lib/object-repo-delete.server";
import {
  renameObjectRecords,
  rewriteGlossaryCsv,
  rewriteStoryCsv,
  storyObjectValues,
  type CsvCellRewrite,
} from "~/lib/csv-record-scan.server";
import { objectFileStems, siteIiifObjectBase, siteObjectId } from "~/lib/object-id";
import { renameIdRefusal } from "~/lib/object-rename-id";
import {
  carouselShadowedNames,
  isStoryCsvPath,
  planObjectFileMoves,
  renameTextFilePaths,
  type PlacedBlob,
} from "~/lib/object-rename-files";
import { renameInsideCollision, renameStepValues, type RenameObjectRows } from "~/lib/object-rename-steps";
import {
  noFileReferenceRules,
  rewriteAudioSource,
  rewriteFileReferences,
  rewriteThumbnail,
  type FileReferenceRules,
} from "~/lib/object-file-references";
import { pythonStrip } from "~/lib/python-whitespace";
import { SPREADSHEETS_DIR } from "~/lib/site-sheets.server";

/** Where a Telar site keeps its object images. */
const OBJECTS_PREFIX = "telar-content/objects/";

/** The site configuration, read at the head. */
const CONFIG_YML_PATH = "_config.yml";

/**
 * The glossary sheet, whose definitions are rewritten beside its story
 * reading: glossary.csv, else glosario.csv where the head has no glossary.csv
 * (the build's own order); with glossary.csv there, glosario.csv is a story.
 */
const GLOSSARY_CSV_PATH = `${SPREADSHEETS_DIR}/glossary.csv`;
const GLOSARIO_CSV_PATH = `${SPREADSHEETS_DIR}/glosario.csv`;

/** A refusal the action answers, with the values its message names. */
export interface RenameRefusal {
  error: string;
  params?: Record<string, string>;
}

/** Thrown from deep in the rename to answer `answer` with nothing committed. */
export class RenameRefused extends Error {
  readonly answer: RenameRefusal;

  constructor(answer: RenameRefusal) {
    super(answer.error);
    this.name = "RenameRefused";
    this.answer = answer;
  }
}

/** The object rows and files a rename is judged against. */
export interface RenameContext {
  oldId: string;
  newId: string;
  /** The object's D1 row id. */
  docId: number;
  tree: readonly TreeEntry[];
  /** objects.csv's ids at the head in file order, repeats included; empty with no file. */
  sheetIds: readonly string[];
  /** D1's rows in `compareSheetOrder` order. */
  d1Rows: ReadonlyArray<{ id: number; object_id: string }>;
  version: string | null;
}

/** True when a sheet id is the object `oldId`'s, as written or stripped as the importer strips it. */
export function isSheetRowOf(id: string, oldId: string): boolean {
  return id === oldId || pythonStrip(id) === oldId;
}

/** The ids of every row that is not the object's own. */
function otherRowIds(ctx: RenameContext): string[] {
  return [
    ...ctx.d1Rows.filter((row) => row.id !== ctx.docId).map((row) => row.object_id),
    ...ctx.sheetIds.filter((id) => !isSheetRowOf(id, ctx.oldId)),
  ];
}

/** The object's own files: those under the stems that are its alone, and its folder. */
export function ownObjectPaths(ctx: RenameContext): Set<string> {
  const stems = objectFileStems(ctx.oldId, ctx.sheetIds, ctx.version);
  return new Set(collectObjectBlobPaths([...ctx.tree], ctx.oldId, stems));
}

/**
 * The first file of the objects folder, other than the object's own, whose
 * flat stem or folder name is the new ID ignoring case, named from inside
 * the folder; null when there is none.
 */
function fileUnderNewId(ctx: RenameContext): string | null {
  const own = ownObjectPaths(ctx);
  const target = ctx.newId.toLowerCase();
  for (const entry of ctx.tree) {
    if (entry.type !== "blob" || own.has(entry.path) || !entry.path.startsWith(OBJECTS_PREFIX)) continue;
    const rest = entry.path.slice(OBJECTS_PREFIX.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest.replace(/\.[^.]+$/, "") : rest.slice(0, slash);
    if (name.toLowerCase() === target) return rest;
  }
  return null;
}

/**
 * Why the new ID cannot be the object's, or null when it can: the judgement
 * the page shares (`renameIdRefusal`), against every other row, then a file
 * of the objects folder already under it.
 */
export function newIdRefusal(ctx: RenameContext): RenameRefusal | null {
  const refusal = renameIdRefusal(ctx.newId, otherRowIds(ctx), ctx.version);
  if (refusal) return refusal;
  const file = fileUnderNewId(ctx);
  return file === null ? null : { error: "rename_file_exists", params: { file } };
}

/** The two orders the object rows are known in. */
export function renameRowsOf(ctx: RenameContext): RenameObjectRows {
  return { sheet: ctx.sheetIds.map((id) => ({ object_id: id })), d1: ctx.d1Rows, version: ctx.version };
}

/**
 * The rules the rename's text rewrites follow: the moved files, the moved
 * names a carousel never reaches, and the tile prefix under the site's base
 * (none without one). Inside a collision, rules that rewrite nothing.
 */
export function renameFileRules(
  ctx: RenameContext,
  moved: ReadonlyArray<{ from: string; to: string }>,
  siteBase: string | null,
): FileReferenceRules {
  const oldSiteId = siteObjectId(ctx.oldId, ctx.version);
  if (renameInsideCollision(ctx.oldId, renameRowsOf(ctx))) return noFileReferenceRules(oldSiteId);
  const tiles = siteBase
    ? {
        from: `${siteIiifObjectBase(siteBase, ctx.oldId, ctx.version)}/`,
        to: `${siteIiifObjectBase(siteBase, ctx.newId, ctx.version)}/`,
      }
    : null;
  return {
    moved: [...moved],
    carouselShadowed: carouselShadowedNames(ctx.tree, moved.map((entry) => entry.from)),
    tiles,
    oldSiteId,
  };
}

/** True when `rules` can rewrite nothing, so no text file need be read. */
function rewritesNothing(rules: FileReferenceRules): boolean {
  return rules.moved.length === 0 && rules.tiles === null;
}

/**
 * Subrequests one Worker invocation may make: the Workers Paid default, as
 * the Compositor's Wrangler configurations set no `limits.subrequests`. A
 * D1 query, a Durable Object call and a GitHub request each count.
 */
const WORKER_SUBREQUEST_LIMIT = 10_000;

/**
 * Subrequests held back from the rename's reads for the rest of its run: the
 * caller's standing and the write gate, the lease, the token and the head,
 * finishing earlier operations, the D1 reads and record writes, the tile
 * cache listed and cleared, the commit's four requests, the ingest and the
 * build's dispatch.
 */
const RENAME_SUBREQUEST_RESERVE = 1_000;

/** A contents read of a file this size or larger answers no content, and the file is read again raw. */
const CONTENTS_INLINE_BYTES = 1_000_000;

/** The GitHub requests a strict read of `path` makes: two when the tree gives it no size or one past the inline limit. */
function readsOfPath(sizes: ReadonlyMap<string, number | undefined>, path: string): number {
  if (!sizes.has(path)) return 1;
  const size = sizes.get(path);
  return size === undefined || size >= CONTENTS_INLINE_BYTES ? 2 : 1;
}

/**
 * The GitHub reads the rename makes at the head: the tree, objects.csv,
 * `_config.yml`, and each of `paths` (the story CSVs, and the text files
 * when the rules can rewrite one), counted per `readsOfPath`.
 */
function renameReadCount(tree: readonly TreeEntry[], objectsPath: string, paths: readonly string[]): number {
  const sizes = new Map(tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.size]));
  const read = [objectsPath, CONFIG_YML_PATH, ...paths];
  return 1 + read.reduce((sum, path) => sum + readsOfPath(sizes, path), 0);
}

/**
 * Refuses with `rename_too_many_files` when the reads would take the run past
 * the Worker's subrequest limit, so a large site is refused before its first
 * story read rather than failing partway. `count` is the reads; `limit` the
 * reads the run allows.
 */
function refuseOverSubrequestLimit(tree: readonly TreeEntry[], objectsPath: string, paths: readonly string[]): void {
  const count = renameReadCount(tree, objectsPath, paths);
  const allowed = WORKER_SUBREQUEST_LIMIT - RENAME_SUBREQUEST_RESERVE;
  if (count > allowed) {
    throw new RenameRefused({ error: "rename_too_many_files", params: { count: String(count), limit: String(allowed) } });
  }
}

/** The repository reads a commit needs: the token, the repository and the head. */
export interface RepoAtHead {
  token: string;
  owner: string;
  repo: string;
  head: string;
}

/** Each of `paths` read strictly at the head; any read that fails or decodes lossily refuses. */
export async function readTextsAtHead(at: RepoAtHead, paths: readonly string[]): Promise<Array<{ path: string; content: string }>> {
  return Promise.all(
    paths.map(async (path) => {
      const read = await getFileAtRef(at.token, at.owner, at.repo, path, at.head, { strict: true });
      if (read.status !== "ok" || read.lossy) throw new RenameRefused({ error: "rename_failed" });
      return { path, content: read.content };
    }),
  );
}

/** The story CSVs at the head, the system sheets left out (`isStoryCsvPath`). */
export function renameStoryCsvPaths(tree: readonly TreeEntry[]): string[] {
  return tree.filter((entry) => entry.type === "blob" && isStoryCsvPath(entry.path)).map((entry) => entry.path);
}

/**
 * The step values the rename rewrites (`renameStepValues`), from every story
 * CSV's raw `object` cells and every D1 step's value. A story CSV that does
 * not read clean refuses.
 */
export function stepValuesOf(
  ctx: RenameContext,
  stories: ReadonlyArray<{ content: string }>,
  d1StepValues: ReadonlyArray<string | null>,
): string[] {
  const candidates: Array<string | null> = [];
  for (const story of stories) {
    const values = storyObjectValues(story.content);
    if (values === null) throw new RenameRefused({ error: "rename_failed" });
    candidates.push(...values);
  }
  candidates.push(...d1StepValues);
  return renameStepValues(ctx.oldId, candidates, renameRowsOf(ctx));
}

/** What the commit writes. */
export interface RenameCommitContent {
  placements: PlacedBlob[];
  deletions: Array<{ path: string; mode: string }>;
  texts: Array<{ path: string; content: string }>;
  rules: FileReferenceRules;
  stepValues: string[];
}

/** The file moves, or a refusal naming the file in the way. */
function fileMovesOf(ctx: RenameContext) {
  const plan = planObjectFileMoves({
    tree: ctx.tree, oldId: ctx.oldId, newId: ctx.newId, sheetIds: ctx.sheetIds, version: ctx.version,
  });
  if (!plan.ok) throw new RenameRefused({ error: "rename_file_exists", params: { file: plan.file } });
  return plan;
}

/** objects.csv with the object's rows renamed, and their thumbnail and audio source where they name what moved. */
function renamedObjectsCsv(ctx: RenameContext, source: string, rules: FileReferenceRules): string {
  const renamed = renameObjectRecords(source, ctx.oldId, ctx.newId, (column, value) =>
    column === "thumbnail" ? rewriteThumbnail(value, rules) : rewriteAudioSource(value, rules),
  );
  if (renamed.status !== "renamed") throw new RenameRefused({ error: "rename_failed" });
  return renamed.text;
}

/** The text of a cell rewrite, `current` when it changed nothing; an unusable file refuses. */
function rewrittenText(current: string, rewrite: CsvCellRewrite): string {
  if (rewrite.status === "unusable") throw new RenameRefused({ error: "rename_failed" });
  return rewrite.status === "rewritten" ? rewrite.text : current;
}

/** The story CSVs (the glossary's definitions included) that change. */
function renamedStoryCsvs(
  stories: ReadonlyArray<{ path: string; content: string }>,
  rename: { stepValues: string[]; newId: string; rules: FileReferenceRules; glossaryPath: string },
): Array<{ path: string; content: string }> {
  const rewriteCellText = (text: string) => rewriteFileReferences(text, rename.rules);
  const stepValues = new Set(rename.stepValues);
  const changed: Array<{ path: string; content: string }> = [];
  for (const story of stories) {
    let text = rewrittenText(story.content, rewriteStoryCsv(story.content, { stepValues, newId: rename.newId, rewriteText: rewriteCellText }));
    if (story.path === rename.glossaryPath) text = rewrittenText(text, rewriteGlossaryCsv(text, rewriteCellText));
    if (text !== story.content) changed.push({ path: story.path, content: text });
  }
  return changed;
}

/** The Markdown files of `paths` whose references to a moved file change. */
async function renamedTextFiles(
  at: RepoAtHead,
  paths: readonly string[],
  rules: FileReferenceRules,
): Promise<Array<{ path: string; content: string }>> {
  const files = await readTextsAtHead(at, paths);
  return files
    .map((file) => ({ path: file.path, content: rewriteFileReferences(file.content, rules) }))
    .filter((file, i) => file.content !== files[i].content);
}

/**
 * Everything the rename's commit carries, given objects.csv's text at the
 * head (which has a row for the object) and D1's step values. Throws
 * `RenameRefused` for a target already taken or a file that cannot be read
 * or rewritten cleanly, or for a site whose reads would pass the Worker's
 * subrequest limit (`refuseOverSubrequestLimit`), before any story is read.
 */
export async function planRenameCommit(
  at: RepoAtHead,
  ctx: RenameContext,
  input: { objectsPath: string; objectsCsv: string; d1StepValues: ReadonlyArray<string | null>; siteBase: string | null },
): Promise<RenameCommitContent> {
  const files = fileMovesOf(ctx);
  const rules = renameFileRules(ctx, files.moved, input.siteBase);
  const storyPaths = renameStoryCsvPaths(ctx.tree);
  // No text file is read when the rules can rewrite nothing in one.
  const textPaths = rewritesNothing(rules) ? [] : renameTextFilePaths(ctx.tree);
  refuseOverSubrequestLimit(ctx.tree, input.objectsPath, [...storyPaths, ...textPaths]);
  const glossaryPath = ctx.tree.some((entry) => entry.path === GLOSSARY_CSV_PATH) ? GLOSSARY_CSV_PATH : GLOSARIO_CSV_PATH;
  const stories = await readTextsAtHead(at, storyPaths);
  const stepValues = stepValuesOf(ctx, stories, input.d1StepValues);
  const texts = [
    { path: input.objectsPath, content: renamedObjectsCsv(ctx, input.objectsCsv, rules) },
    ...renamedStoryCsvs(stories, { stepValues, newId: ctx.newId, rules, glossaryPath }),
    ...(await renamedTextFiles(at, textPaths, rules)),
  ];
  return { placements: files.placed, deletions: files.removed, texts, rules, stepValues };
}
