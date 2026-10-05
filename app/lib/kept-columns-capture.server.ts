/**
 * The kept columns a publish reads from a story's CSV before it rewrites the
 * file from D1.
 *
 * A story imported before steps kept their unmapped columns holds
 * `extra_columns` empty on every step, and its next publish would write the
 * fixed columns only, deleting the author's own columns from
 * `telar-content/spreadsheets/<story>.csv`. So before the file set is built,
 * each such story's CSV at the publish commit is read, its steps are aligned
 * with D1's, and the columns go into the document through the collaboration
 * object's `steps.captureKeptColumns` arm, which flushes them to D1.
 *
 * A story is read only when both hold:
 * - unrecorded: none of its D1 steps has a kept column. The two paths that
 *   record kept columns, the import and the sync accept, read the whole file
 *   and record every column with a value, and removing a column in the
 *   Compositor empties it on every step, so a story with any recorded column
 *   has been read and is not read again;
 * - its CSV at the publish commit differs, as a git blob, from the CSV the
 *   publish would commit (`renderStoryFiles`). Equal blobs hold nothing D1
 *   does not, and after one publish every file is what D1 renders.
 * A story with no CSV at that commit has nothing to lose and is not read.
 *
 * A row whose only content is in custom columns was skipped by the import,
 * and the framework keeps it. The capture inserts it as a
 * step (`carryKeptCells`), so a story with no steps in D1 is read too: every
 * row of it may be such a row.
 *
 * Anything that cannot be read to a conclusion throws `StoriesUnreadableError`
 * and the publish refuses: a file that cannot be read is never overwritten.
 *
 * @version v1.5.0-beta
 */

import { and, eq } from "drizzle-orm";
import { layers, steps, stories } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import { hasStoryRowContent, parseExtraColumns } from "~/lib/extra-columns.server";
import { makeInternalMarkerHeaders } from "~/lib/internal-marker.server";
import { pythonStrip } from "~/lib/python-whitespace";
import { projectCsvStoryRows } from "~/lib/import.server";
import { renderStoryFiles } from "~/lib/publish.server";
import type { StoryLayerRow, StoryStepRow } from "~/lib/publish.server";
import { canonicalRaw, contentFromRows, contentInOrder, stepRowsInOrder } from "~/lib/story-canonical";
import { getFileAtRef, getSubtreeOids, listSubtreeEntries } from "~/lib/github.server";
import type { SubtreeAt } from "~/lib/github.server";
import { siteSheetFileAt } from "~/lib/site-sheets.server";
import { rawCanonicalFromD1 } from "~/lib/story-content.server";
import { gitBlobSha } from "~/lib/story-files.server";
import type { CommitFiles, RepoAccess } from "~/lib/story-files.server";
import { storyFileRowsAt } from "~/lib/story-file-rows.server";
import type { StoryFileRows } from "~/lib/story-file-rows.server";

const SPREADSHEETS_DIR = "telar-content/spreadsheets";
const STORY_TEXTS_DIR = "telar-content/texts/stories";

/**
 * The story subtrees at one commit: each step CSV's blob SHA, and a strict
 * read of a story's content through the readers `readStoriesForAccept` uses.
 * The spreadsheets subtree is listed when this is built, the texts subtree
 * at the first read, each once, and each held to what `storyTrees` (`story-content.server.ts`) requires:
 * a listing that cannot be trusted throws, naming why, and so does a read, as
 * `readStoriesForAccept` throws.
 */
export interface StoryFilesAt {
  /** The blob SHA of `<id>.csv` in the spreadsheets subtree, or undefined when there is none. */
  sheetSha(id: string): string | undefined;
  read(id: string): Promise<StoryFileRows>;
}

export async function storyFilesAt(input: RepoAccess, head: string): Promise<StoryFilesAt> {
  const { token, owner, repo } = input;
  const trees = await getSubtreeOids(token, owner, repo, [head], [SPREADSHEETS_DIR, STORY_TEXTS_DIR]);
  if (!trees.ok) throw new Error(`the story files could not be listed: the story trees came back ${trees.reason}`);
  const files: CommitFiles = { sheets: new Map(), texts: new Map(), textDirs: new Set() };
  const sheets = trees.at(head, SPREADSHEETS_DIR);
  if (sheets.kind !== "absent") files.sheets = await subtreeFiles(input, sheets, SPREADSHEETS_DIR, head).then((l) => l.files);
  // Listed on the first read only: a publish whose every CSV equals the
  // render reads no story, so a texts listing it cannot trust changes nothing.
  let texts: Promise<void> | null = null;
  const listTexts = () => (texts ??= (async () => {
    const at = trees.at(head, STORY_TEXTS_DIR);
    if (at.kind === "absent") return;
    const listing = await subtreeFiles(input, at, STORY_TEXTS_DIR, head);
    files.texts = listing.files;
    files.textDirs = listing.dirs;
  })());
  return {
    sheetSha: (id) => files.sheets.get(`${id}.csv`),
    read: async (id) => {
      await listTexts();
      return storyFileRowsAt(input, head, files, id);
    },
  };
}

/** A subtree's complete listing, as `storyTrees` (`story-content.server.ts`) requires one, or a throw naming why not. */
async function subtreeFiles(
  input: RepoAccess,
  at: SubtreeAt,
  dir: string,
  head: string,
): Promise<{ files: Map<string, string>; dirs: Set<string> }> {
  if (at.kind !== "tree") {
    throw new Error(`the story files could not be listed: ${dir} is not a tree at ${head}`);
  }
  const listing = await listSubtreeEntries(input.token, input.owner, input.repo, at.oid);
  if (listing === null) throw new Error(`the story files could not be listed: ${dir} could not be listed completely`);
  return listing;
}

/** A D1 step row with the key the document orders it by. */
export type CaptureStepRow = StoryStepRow & { order_key: string | null };
/** A D1 layer row with the key the document orders it by. */
export type CaptureLayerRow = StoryLayerRow & { order_key: string | null };

/** A story as D1 holds it after the publish's forced snapshot; its layers are read only when needed. */
export interface CaptureStory {
  storyId: string;
  stepRows: CaptureStepRow[];
  loadLayers: () => Promise<CaptureLayerRow[]>;
}

/** One story's capture, as `steps.captureKeptColumns` takes it. */
export interface KeptColumnsCapture {
  storyId: string;
  /** The raw canonical hash of the D1 rows the capture was aligned against. */
  expected: string;
  steps: Array<{ stepId: number; extra_columns: string }>;
  /** Rows the Compositor never had, each inserted after the D1 step it names. */
  inserts: CaptureInsert[];
}

/**
 * Why a publish refuses over its kept-columns capture, as the publish's error
 * code: nothing has been committed when this is thrown.
 */
export class KeptColumnsRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KeptColumnsRefusal";
    this.code = code;
  }
}

/**
 * A story CSV the capture had to read and could not, or the listing that
 * would have found it. `storyId` is null for the listing.
 */
export class StoriesUnreadableError extends KeptColumnsRefusal {
  readonly storyId: string | null;

  constructor(storyId: string | null, reason: string) {
    super(
      "stories_unreadable",
      storyId === null ? `the story files could not be read: ${reason}` : `story "${storyId}" could not be read: ${reason}`,
    );
    this.name = "StoriesUnreadableError";
    this.storyId = storyId;
  }
}

/** Whether a kept-column blob holds at least one column. */
function hasKeptColumns(raw: string | null | undefined): boolean {
  return Object.keys(parseExtraColumns(raw)).length > 0;
}

/**
 * No step of the story has its kept columns recorded. `"{}"` is recorded with
 * none left (a removal of the last one, `~/lib/story-columns`); null and `""`
 * were never recorded.
 */
export function isUnrecorded(stepRows: readonly StoryStepRow[]): boolean {
  return !stepRows.some((step) => typeof step.extra_columns === "string" && step.extra_columns !== "");
}

/** The CSV `renderStoryFiles` would commit for these rows. */
async function renderedCsv(storyId: string, stepRows: StoryStepRow[], layerRows: StoryLayerRow[]): Promise<string> {
  const path = `telar-content/spreadsheets/${storyId}.csv`;
  const file = (await renderStoryFiles(storyId, stepRows, layerRows)).find((f) => f.path === path);
  if (!file) throw new Error(`no ${storyId}.csv among the rendered files`);
  return file.content;
}

/** Each canonical step as a key `pairSteps` compares. */
async function stepKeys(content: Parameters<typeof canonicalRaw>[0]): Promise<string[]> {
  const canon = await canonicalRaw(content);
  if (!canon.readable) throw new Error(JSON.stringify(canon.reason));
  return canon.steps.map((step) => JSON.stringify(step));
}

/**
 * The cells the import tested, skipping a row with all of them
 * empty after a Python strip (`mapStoryCsv`'s filter held only these then).
 * It tested them on the row as parsed, its layer file references resolved.
 */
const IMPORT_TESTED_CELLS = [
  "object", "question", "answer", "layer1_button", "layer1_content", "layer2_button", "layer2_content", "alt_text",
] as const;

/**
 * A file row the import skipped, and the framework keeps: every
 * cell that import tested is empty in `cells`, the row as that import saw it
 * (`StoryFileRows.importedCells`), and the row's kept cells make it a row of
 * its own (`hasStoryRowContent`). No step of an unrecorded story in D1 can be
 * one.
 */
function isCustomOnlyRow(step: StoryStepRow, cells: Record<string, string> | undefined): boolean {
  if (cells === undefined) return false;
  if (!IMPORT_TESTED_CELLS.every((cell) => pythonStrip(cells[cell] ?? "") === "")) return false;
  return hasStoryRowContent(parseExtraColumns(step.extra_columns));
}

/** A step the capture adds to the story, as `steps.captureKeptColumns` carries it. */
export interface CapturedStep {
  page?: string;
  x?: number;
  y?: number;
  zoom?: number;
  clip_start?: string;
  clip_end?: string;
  loop?: string;
  extra_columns: string;
}

/** A row the Compositor never had, to be inserted after `afterStepId` (first when null). */
export interface CaptureInsert {
  afterStepId: number | null;
  step: CapturedStep;
}

/** The fields a custom-only row can hold besides its kept cells, as the story reader mapped them. */
function capturedStep(row: StoryStepRow): CapturedStep {
  const step: Record<string, string | number> = {};
  for (const field of ["page", "x", "y", "zoom", "clip_start", "clip_end", "loop"] as const) {
    const value = row[field];
    if (value !== null && value !== undefined && value !== "") step[field] = value;
  }
  return { ...step, extra_columns: row.extra_columns as string } as CapturedStep;
}

/** Each file row's raw canonical key, kept columns left out, in the order given. */
async function fileStepKeys(file: { stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] }): Promise<string[]> {
  return stepKeys(
    contentInOrder(
      file.stepRows.map((s) => ({
        ...s,
        extra_columns: null,
        layers: file.layerRows
          .filter((l) => l.step_id === s.id)
          .sort((a, b) => a.layer_number - b.layer_number),
      })),
    ),
  );
}

/**
 * The file's kept cells carried onto D1's steps, and the file's custom-only
 * rows to insert. D1's steps in `order_key` order and the file's other rows
 * in the order the framework renders them are each keyed on their raw
 * canonical content with kept columns left out, and paired by `pairSteps`. A
 * paired step takes the file row's cells.
 *
 * A custom-only row (`isCustomOnlyRow`) is kept out of the pairing, since the
 * Compositor never had it and it would otherwise take an edited step's place.
 * It is inserted after the D1 step paired with the nearest earlier paired
 * row, or first when none is, in the file's order.
 */
export async function carryKeptCells(
  d1: { stepRows: CaptureStepRow[]; layerRows: CaptureLayerRow[] },
  file: StoryFileRows,
): Promise<{ steps: Array<{ stepId: number; extra_columns: string }>; inserts: CaptureInsert[] }> {
  const ordered = stepRowsInOrder(d1.stepRows);
  const d1Keys = await stepKeys(
    contentFromRows(d1.stepRows.map((s) => ({ ...s, extra_columns: null })), d1.layerRows),
  );
  // Already in the framework's order, numbered 1..n (`rowsFromContent`).
  const pairable = file.stepRows.flatMap((row, index) => (isCustomOnlyRow(row, file.importedCells[row.id]) ? [] : [index]));
  const fileKeys = await fileStepKeys({ stepRows: pairable.map((i) => file.stepRows[i]), layerRows: file.layerRows });
  const partner = new Map<number, number>();
  const steps: Array<{ stepId: number; extra_columns: string }> = [];
  for (const { existing, incoming } of pairSteps(d1Keys, fileKeys)) {
    const row = pairable[incoming];
    partner.set(row, ordered[existing].id);
    const cells = file.stepRows[row].extra_columns;
    if (cells && hasKeptColumns(cells)) steps.push({ stepId: ordered[existing].id, extra_columns: cells });
  }
  return { steps, inserts: insertsAfterPartners(file.stepRows, partner, new Set(pairable)) };
}

/** Each custom-only row, in file order, after the D1 step of the nearest earlier paired row. */
function insertsAfterPartners(
  rows: readonly StoryStepRow[],
  partner: ReadonlyMap<number, number>,
  pairable: ReadonlySet<number>,
): CaptureInsert[] {
  const inserts: CaptureInsert[] = [];
  let afterStepId: number | null = null;
  rows.forEach((row, index) => {
    if (!pairable.has(index)) inserts.push({ afterStepId, step: capturedStep(row) });
    else if (partner.has(index)) afterStepId = partner.get(index)!;
  });
  return inserts;
}

type StepPair = { existing: number; incoming: number };

/**
 * D1's steps paired with the file's.
 *
 * A step whose content is the same on both sides is that step, wherever it
 * now stands: moved in the Compositor or not. Steps sharing one content are
 * paired in order, since nothing in them tells them apart. Those identical
 * pairs that keep their relative order on both sides are the anchors, and a
 * step edited in the Compositor pairs by position with the file's step
 * between the same two anchors; a step left over in a stretch was deleted
 * here, or is new here, and takes nothing.
 */
function pairSteps(d1Keys: string[], fileKeys: string[]): StepPair[] {
  const identical = identicalPairs(d1Keys, fileKeys);
  const anchors = inOrder(identical);
  const d1Used = new Set(identical.map((p) => p.existing));
  const fileUsed = new Set(identical.map((p) => p.incoming));
  const edited: StepPair[] = [];
  const bounds = [{ existing: -1, incoming: -1 }, ...anchors, { existing: d1Keys.length, incoming: fileKeys.length }];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const d1Gap = between(bounds[g].existing, bounds[g + 1].existing, d1Used);
    const fileGap = between(bounds[g].incoming, bounds[g + 1].incoming, fileUsed);
    for (let k = 0; k < Math.min(d1Gap.length, fileGap.length); k++) {
      edited.push({ existing: d1Gap[k], incoming: fileGap[k] });
    }
  }
  return [...identical, ...edited];
}

/** Steps with the same content on both sides, the n-th of a content with the n-th. */
function identicalPairs(d1Keys: string[], fileKeys: string[]): StepPair[] {
  const fileByKey = new Map<string, number[]>();
  fileKeys.forEach((key, i) => fileByKey.set(key, [...(fileByKey.get(key) ?? []), i]));
  const taken = new Map<string, number>();
  const pairs: StepPair[] = [];
  d1Keys.forEach((key, existing) => {
    const n = taken.get(key) ?? 0;
    const incoming = fileByKey.get(key)?.[n];
    if (incoming === undefined) return;
    taken.set(key, n + 1);
    pairs.push({ existing, incoming });
  });
  return pairs;
}

/** The longest run of pairs in order on both sides (`pairs` sorted by `existing`). */
function inOrder(pairs: StepPair[]): StepPair[] {
  const best = pairs.map(() => 1);
  const prev = pairs.map(() => -1);
  for (let i = 0; i < pairs.length; i++) {
    for (let j = 0; j < i; j++) {
      if (pairs[j].incoming < pairs[i].incoming && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1;
        prev[i] = j;
      }
    }
  }
  let end = best.indexOf(Math.max(0, ...best));
  const run: StepPair[] = [];
  while (end !== -1) {
    run.unshift(pairs[end]);
    end = prev[end];
  }
  return run;
}

/** The unused indices strictly between two bounds, in order. */
function between(from: number, to: number, used: Set<number>): number[] {
  const out: number[] = [];
  for (let i = from + 1; i < to; i++) if (!used.has(i)) out.push(i);
  return out;
}

/**
 * The captures a publish at `publishSha` needs, one per story whose CSV holds
 * kept columns D1 never recorded; empty when none does. Reads the repository
 * only when some story is unrecorded.
 */
export async function planKeptColumnsCapture(
  access: RepoAccess,
  publishSha: string,
  storiesInD1: readonly CaptureStory[],
): Promise<KeptColumnsCapture[]> {
  const candidates = storiesInD1.filter((s) => isUnrecorded(s.stepRows));
  if (candidates.length === 0) return [];

  let files: StoryFilesAt;
  try {
    files = await storyFilesAt(access, publishSha);
  } catch (err) {
    throw new StoriesUnreadableError(null, (err as Error).message);
  }

  const captures: KeptColumnsCapture[] = [];
  for (const story of candidates) {
    const capture = await storyCapture(story, files);
    if (capture !== null) captures.push(capture);
  }
  return captures;
}

/**
 * One candidate story's capture, or null when its file holds nothing to
 * capture: no CSV, a CSV equal to the render, no kept column, or nothing
 * that carries or inserts.
 */
async function storyCapture(story: CaptureStory, files: StoryFilesAt): Promise<KeptColumnsCapture | null> {
  const sheetSha = files.sheetSha(story.storyId);
  if (sheetSha === undefined) return null;
  const layerRows = await story.loadLayers();
  if ((await gitBlobSha(await renderedCsv(story.storyId, story.stepRows, layerRows))) === sheetSha) return null;

  let file: StoryFileRows;
  try {
    file = await files.read(story.storyId);
  } catch (err) {
    throw new StoriesUnreadableError(story.storyId, (err as Error).message);
  }
  if (!file.stepRows.some((s) => hasKeptColumns(s.extra_columns))) return null;

  const { steps: carried, inserts } = await carryKeptCells({ stepRows: story.stepRows, layerRows }, file);
  if (carried.length === 0 && inserts.length === 0) return null;
  const raw = await rawCanonicalFromD1(story.stepRows, layerRows);
  if (!raw.readable) throw new StoriesUnreadableError(story.storyId, JSON.stringify(raw.reason));
  return { storyId: story.storyId, expected: raw.hash, steps: carried, inserts };
}

/**
 * The project's stories with their step rows, as D1 holds them; each story's
 * layers read only if its CSV is read. The step columns are the ones
 * `renderStoryFiles` renders, and `order_key` for the raw canonical form.
 */
export async function readCaptureStories(db: ReturnType<typeof getDb>, projectId: number): Promise<CaptureStory[]> {
  const [storyRows, stepRows] = await Promise.all([
    db.select({ id: stories.id, story_id: stories.story_id }).from(stories).where(eq(stories.project_id, projectId)),
    db
      .select({
        story: steps.story_id,
        id: steps.id,
        step_number: steps.step_number,
        order_key: steps.order_key,
        kind: steps.kind,
        object_id: steps.object_id,
        x: steps.x,
        y: steps.y,
        zoom: steps.zoom,
        page: steps.page,
        question: steps.question,
        answer: steps.answer,
        alt_text: steps.alt_text,
        clip_start: steps.clip_start,
        clip_end: steps.clip_end,
        loop: steps.loop,
        extra_columns: steps.extra_columns,
      })
      .from(steps)
      .innerJoin(stories, eq(steps.story_id, stories.id))
      .where(eq(stories.project_id, projectId)),
  ]);
  return storyRows.map((story) => ({
    storyId: story.story_id,
    stepRows: stepRows.filter((s) => s.story === story.id).map(({ story: _story, ...row }) => row),
    loadLayers: () =>
      db
        .select({
          step_id: layers.step_id,
          layer_number: layers.layer_number,
          order_key: layers.order_key,
          title: layers.title,
          button_label: layers.button_label,
          content: layers.content,
        })
        .from(layers)
        .innerJoin(steps, eq(layers.step_id, steps.id))
        .where(eq(steps.story_id, story.id)),
  }));
}

/** What the collaboration object's answer to a capture means for the publish. */
export type CaptureDelivery = "captured" | "changed" | "failed" | "unreachable";

interface CaptureAnswer {
  refused?: { stepCaptureKeptColumns?: number[] };
  keptColumns?: { captured?: string[]; changed?: string[] };
}

/**
 * Sends the captures to the collaboration object, which answers only once
 * they are flushed to D1 and broadcast. `captured` only when every story sent
 * is reported captured; `changed` when every story that was not is reported
 * changed since the read; `failed` for any other answer, a refused entry or a
 * non-200 included; `unreachable` when the object could not answer.
 */
export async function sendKeptColumnsCapture(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  captures: readonly KeptColumnsCapture[],
): Promise<CaptureDelivery> {
  const response = await postCapture(env, projectId, captures);
  if (response === null) return "unreachable";
  if (!response.ok) {
    console.error(`[publish] project ${projectId}: kept-columns capture answered ${response.status}`);
    return "failed";
  }
  const answer = (await response.json().catch(() => ({}))) as CaptureAnswer;
  return deliveryOf(projectId, captures, answer);
}

/** The capture posted to `/ingest-sync` alone, or null when the object could not answer. */
async function postCapture(
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  captures: readonly KeptColumnsCapture[],
): Promise<Response | null> {
  try {
    const headers = await makeInternalMarkerHeaders(projectId, env.SESSION_SECRET, "ingest-sync");
    const stub = env.COLLABORATION.get(env.COLLABORATION.idFromName(String(projectId)));
    return await stub.fetch(
      new Request("https://internal/ingest-sync", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ steps: { captureKeptColumns: captures } }),
      }),
    );
  } catch (err) {
    console.error(`[publish] project ${projectId}: kept-columns capture unreachable`, err);
    return null;
  }
}

/** What a 200 answer says of the captures sent (see `sendKeptColumnsCapture`). */
function deliveryOf(projectId: number, captures: readonly KeptColumnsCapture[], answer: CaptureAnswer): CaptureDelivery {
  if ((answer.refused?.stepCaptureKeptColumns ?? []).length > 0) {
    console.error(`[publish] project ${projectId}: kept-columns capture refused`, answer.refused);
    return "failed";
  }
  const captured = new Set(answer.keptColumns?.captured ?? []);
  const changed = new Set(answer.keptColumns?.changed ?? []);
  const notCaptured = captures.map((c) => c.storyId).filter((id) => !captured.has(id));
  if (notCaptured.length === 0) return "captured";
  console.error(`[publish] project ${projectId}: kept columns not captured`, { notCaptured, answer: answer.keptColumns });
  return notCaptured.every((id) => changed.has(id)) ? "changed" : "failed";
}

/** The refusal a publish answers for a delivery that is not `captured`. */
const DELIVERY_REFUSALS: Record<Exclude<CaptureDelivery, "captured">, string> = {
  changed: "changed_during_publish",
  unreachable: "snapshot_unreachable",
  failed: "snapshot_failed",
};

/**
 * The capture a publish at `publishSha` needs, read, planned and delivered,
 * ending once the collaboration object has taken all of it, or at once when
 * there is nothing to capture. Anything else throws `KeptColumnsRefusal`
 * carrying the publish's error code: `StoriesUnreadableError` for a CSV that
 * cannot be read, and `DELIVERY_REFUSALS`' code for a capture not taken.
 */
export async function captureKeptColumns(
  db: ReturnType<typeof getDb>,
  env: Pick<Env, "COLLABORATION" | "SESSION_SECRET">,
  projectId: number,
  access: RepoAccess,
  publishSha: string,
): Promise<void> {
  await captureProjectKeptColumns(db, projectId, access, publishSha);
  const captures = await planKeptColumnsCapture(access, publishSha, await readCaptureStories(db, projectId));
  if (captures.length === 0) return;
  const delivery = await sendKeptColumnsCapture(env, projectId, captures);
  if (delivery !== "captured") {
    throw new KeptColumnsRefusal(DELIVERY_REFUSALS[delivery], `kept-columns capture ${delivery}`);
  }
}

/**
 * The custom columns project.csv holds for stories whose `extra_columns` D1
 * never recorded (NULL, as it is for every story imported before the column existed), written
 * to D1 before the file set rewrites the file from D1 and would drop them.
 * NULL means not known, not none: a story that has been read holds a blob,
 * and nothing writes an empty one, so a story whose row carries no custom
 * cell stays NULL and is read again at the next publish.
 *
 * The column is D1's alone (the snapshot UPDATE omits it), so it is written
 * directly, as the sync accept writes it. The sync cannot record these: the
 * repository's value equals the sync base, so D1's NULL reads as the
 * Compositor's own change and is suppressed.
 *
 * A project.csv the import refuses (colliding columns) is left as it was
 * before: the layout writes it without custom cells, as it did.
 */
async function captureProjectKeptColumns(
  db: ReturnType<typeof getDb>,
  projectId: number,
  access: RepoAccess,
  publishSha: string,
): Promise<void> {
  const rows = await db
    .select({ story_id: stories.story_id, source_path: stories.source_path, extra_columns: stories.extra_columns })
    .from(stories)
    .where(eq(stories.project_id, projectId));
  const unrecorded = rows.filter((r) => !r.extra_columns);
  if (unrecorded.length === 0) return;
  const { path: projectPath, file: read } = await siteSheetFileAt("project", (path) =>
    getFileAtRef(access.token, access.owner, access.repo, path, publishSha, { strict: true }),
  );
  if (read.status === "error") throw new StoriesUnreadableError(null, `${projectPath} could not be read`);
  if (read.status !== "ok") return;
  let fileRows: ReturnType<typeof projectCsvStoryRows>;
  try {
    fileRows = projectCsvStoryRows(read.content.replace(/^\uFEFF/, ""));
  } catch {
    return;
  }
  const fileRowById = new Map<string, (typeof fileRows)[number]>();
  for (const row of fileRows) if (!fileRowById.has(row.story_id as string)) fileRowById.set(row.story_id as string, row);
  for (const story of unrecorded) {
    const row = fileRowById.get(repositoryIdOf(story));
    if (!row?.extra_columns) continue;
    await db
      .update(stories)
      .set({ extra_columns: row.extra_columns })
      .where(and(eq(stories.project_id, projectId), eq(stories.story_id, story.story_id)));
  }
}

/**
 * The ID a story has in the repository's project.csv. A story's `source_path`
 * is the story CSV it was last read from or written to: the import records
 * where it found it (the spreadsheets folder, `_data/` or the root), and the
 * snapshot records the earlier file at a rename. That file is named for the
 * ID the story had; matching on the current ID would take another story's
 * row when one passes into the ID this one left. With no `source_path`, the
 * current ID is the key.
 */
function repositoryIdOf(story: { story_id: string; source_path: string | null }): string {
  const path = story.source_path;
  if (!path?.endsWith(".csv")) return story.story_id;
  for (const dir of [`${SPREADSHEETS_DIR}/`, "_data/", ""]) {
    if (path.startsWith(dir) && !path.slice(dir.length).includes("/")) return path.slice(dir.length, -".csv".length);
  }
  return story.story_id;
}
