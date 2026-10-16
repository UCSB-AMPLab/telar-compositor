/**
 * The compare form of a story's content: the server side of the change check
 * for step and layer files.
 *
 * The question it answers is whether the Compositor's version of a story
 * differs from GitHub's. Both sides are brought to what a publish would write
 * and read back through the import pipeline's parsers before they are
 * canonicalised (`canonicalRaw`, `story-canonical.ts`):
 *
 * - D1's side: its rows rendered by `renderStoryFiles`, exactly the bytes a
 *   publish commits, then parsed.
 * - GitHub's side: its files parsed, that parse rendered as a publish would
 *   write it, then parsed again.
 *
 * So the publisher's own transformations are on both sides, and a difference
 * only the publisher would erase is no difference: a template story with blank
 * coordinates on GitHub compares equal to the same story imported into D1,
 * which publishes 0.5/0.5/1. For any D1 rows, the compare form of the rows
 * equals the compare form of the files they render to, so a story published
 * and untouched since reads as unchanged; the renderer's guarantees are
 * stated at `layerBody` in publish.server.ts.
 *
 * The raw form, `rawCanonicalFromD1`, is the other job: D1's rows with none of
 * the publisher's transformations, whose hash the collaboration object checks
 * its live maps against.
 *
 * The parse reads no repository: the caller supplies the CSV text and the
 * layer files by name. `mapStoryCsv` runs one row at a time so each step keeps
 * the `step` cell the framework orders by; the mapper's own `step_number`
 * falls back to the row's position, which the framework does not.
 *
 * @version v1.5.5-beta
 */

import { SPREADSHEETS_DIR, isInconclusive, readBlobText, readReportedBlobText, storyTrees } from "~/lib/story-files.server";
import type { CommitFiles, InconclusiveCause, RepoAccess, TreesInconclusive } from "~/lib/story-files.server";
import { collidedValues, maskedRows, sameLayerFiles, storyMaskFor } from "~/lib/story-collided-fields.server";
import type { StoryMask } from "~/lib/story-collided-fields.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { unreadableFileName } from "~/lib/unreadable-characters.server";
import { reasonOf } from "~/lib/story-unreadable.server";
import { isAscii, isPlainReference, layerFilesAt, layerPathCandidates, namedLayerFiles } from "~/lib/story-layer-references.server";
import {
  STORY_CANONICAL_SCOPE,
  layerFrontmatterBlock,
  mapStoryCsv,
  parseTelarCsv,
  resolveLayerFileReferences,
} from "~/lib/import.server";
import type { SeveralHoldValues } from "~/lib/import.server";
import { escapeYamlString } from "~/lib/knap-filters.server";
import { readsAsUntitledLayer1 } from "~/lib/panel-heading";
import { issuesFor } from "~/lib/sheet-warnings";
import type { SheetWarning } from "~/lib/sheet-warnings";
import { renderStoryFiles } from "~/lib/publish.server";
import type { StoryLayerRow, StoryStepRow } from "~/lib/publish.server";
import { canonicalRaw, contentFromRows, frameworkStepOrder, type UnreadableReason } from "~/lib/story-canonical";
import type { CanonicalStory, StoryContentStep } from "~/lib/story-canonical";

const STORY_TEXTS = "telar-content/texts/stories/";

interface ReadStory {
  steps: StoryContentStep[];
  /** Each step's layer cells as the import resolved them, file text or inline. */
  cells: Array<Record<number, string | undefined>>;
  /** Each step's row as parsed, before its layer file references are resolved. */
  sources: Record<string, string>[];
}

/**
 * A cell naming a file not among `layerFiles` is left as it is, so its text
 * is the filename: what the framework shows for a reference it cannot
 * resolve (markdown.py `read_markdown_file` returns None, and stories.py
 * `_layer_content_for` reads the cell inline), and what the import stores.
 *
 * `warnings`, when given, receives what the parse and the mapper found in the
 * sheet, named `<slug>.csv`. `severalHoldValues` is the parse's answer to
 * colliding columns that each hold values (`parseTelarCsv`); `storyAt` passes
 * keep-last for the recorded base.
 */
export async function readStory(
  slug: string,
  csv: string,
  layerFiles: Record<string, string>,
  warnings?: SheetWarning[],
  severalHoldValues: SeveralHoldValues = "refuse",
): Promise<ReadStory> {
  const onWarning = warnings ? issuesFor(`${slug}.csv`, warnings) : undefined;
  const rows = parseTelarCsv(csv, onWarning, false, STORY_CANONICAL_SCOPE, {
    severalHoldValues,
    sheetName: `${slug}.csv`,
  });
  const resolved = await resolveLayerFileReferences(rows, async (name) =>
    Object.hasOwn(layerFiles, name) ? layerFiles[name] : null,
  );
  const out: ReadStory = { steps: [], cells: [], sources: [] };
  for (const [index, row] of resolved.entries()) {
    const { steps, layers } = mapStoryCsv([row], 0, onWarning, out.steps.length);
    if (steps.length === 0) continue;
    const s = steps[0];
    out.steps.push({
      step: row.step,
      kind: s.kind,
      object_id: s.object_id,
      x: s.x,
      y: s.y,
      zoom: s.zoom,
      page: s.page,
      question: s.question,
      answer: s.answer,
      alt_text: s.alt_text,
      clip_start: s.clip_start,
      clip_end: s.clip_end,
      loop: s.loop,
      extra_columns: s.extra_columns,
      layers: layers.map((l) => ({
        layer_number: l.layer_number,
        title: l.title,
        button_label: l.button_label,
        content: l.content,
      })),
    });
    out.cells.push({ 1: row.layer1_content, 2: row.layer2_content });
    out.sources.push(rows[index]);
  }
  return out;
}

/**
 * A story's CSV and layer files read through the import pipeline's parsers:
 * what an accept would import, layer titles included.
 */
export async function parseStoryFiles(
  slug: string,
  csv: string,
  layerFiles: Record<string, string>,
  severalHoldValues: SeveralHoldValues = "refuse",
): Promise<StoryContentStep[]> {
  return (await readStory(slug, csv, layerFiles, undefined, severalHoldValues)).steps;
}

/**
 * The title a layer's front matter block states, when the block is in the
 * Compositor writer's own form, or null.
 *
 * The writer's form is exactly the block `layerFileContent` writes
 * (publish.server.ts, LAYER_FILE_TEMPLATE): `title: ` followed by the
 * `yaml_string` filter's output for the title, which is `escapeYamlString`
 * (knap-filters.server.ts), a JSON string literal with the rejected code
 * points escaped, and nothing else. So a block is in the writer's form when
 * it is `title: ` plus a JSON string literal that `escapeYamlString`
 * reproduces from its own decoding. The title is that decoding: JSON, never a
 * YAML reading.
 */
function writerFormTitle(block: string): string | null {
  const match = /^title: ("(?:[^"\\\n\r]|\\.)*")$/.exec(block);
  if (!match) return null;
  let title: unknown;
  try {
    title = JSON.parse(match[1]);
  } catch {
    return null;
  }
  return typeof title === "string" && escapeYamlString(title) === match[1] ? title : null;
}

/**
 * A story as the compare form reads it: the import's parse, except for each
 * layer's front matter.
 *
 * A layer's block is represented by its title only when the block is in the
 * writer's form (`writerFormTitle`); every other block is represented by its
 * own text, line endings normalised to `\n` and nothing else changed. Why this
 * is complete: D1's side is always rendered by the writer, so every block on
 * that side is in the writer's form, and the only blocks ever compared by
 * title are ones whose meaning the writer fixed; the reading of such a block
 * is a JSON decoding the writer's own escaping inverts. Any other block is
 * compared as text, so an edit to it always shows as a change, whatever YAML
 * makes of it. The cost, accepted, is a difference where an unusual block
 * means what D1's title says.
 *
 * Where the block starts and ends, and whether there is one, is the import's
 * split (`layerFrontmatterBlock`), made by patterns alone.
 */
async function parseForCompare(
  slug: string,
  csv: string,
  layerFiles: Record<string, string>,
  warnings?: SheetWarning[],
  severalHoldValues: SeveralHoldValues = "refuse",
): Promise<StoryContentStep[]> {
  const { steps, cells } = await readStory(slug, csv, layerFiles, warnings, severalHoldValues);
  return steps.map((step, i) => ({
    ...step,
    layers: step.layers.map((layer) => {
      const block = layerFrontmatterBlock(cells[i][layer.layer_number]);
      if (block === null) return layer;
      const title = writerFormTitle(block);
      // Read as the import reads it (`mapStoryCsv`): the heading a publish
      // writes for a layer 1 with no title of its own is no title.
      const layer2 = step.layers.find((l) => l.layer_number === 2) ?? null;
      if (title !== null && layer.layer_number === 1 && readsAsUntitledLayer1({ ...layer, title }, layer2)) {
        return { ...layer, title: undefined };
      }
      if (title !== null) return { ...layer, title: title !== "" ? title : undefined };
      return { ...layer, title: undefined, frontmatter: block.replace(/\r\n?/g, "\n") };
    }),
  }));
}

/** The story's CSV and its layer files by name, out of a set of committed files. */
function committedStory(
  slug: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): { csv: string; layerFiles: Record<string, string> } {
  const csv = files.find((f) => f.path === `telar-content/spreadsheets/${slug}.csv`);
  if (!csv) throw new Error(`no ${slug}.csv among the files`);
  const layerFiles: Record<string, string> = {};
  for (const f of files) {
    if (f.path.startsWith(STORY_TEXTS)) layerFiles[f.path.slice(STORY_TEXTS.length)] = f.content;
  }
  return { csv: csv.content, layerFiles };
}

/** The story's CSV and layer files out of a set of committed files, parsed. */
export async function parseCommittedStory(
  slug: string,
  files: ReadonlyArray<{ path: string; content: string }>,
): Promise<StoryContentStep[]> {
  const { csv, layerFiles } = committedStory(slug, files);
  return parseStoryFiles(slug, csv, layerFiles);
}

/**
 * A parsed story as rows `renderStoryFiles` can write, numbered 1..n in the
 * order the framework renders them, or the reason that order is not known.
 */
export function rowsFromContent(
  steps: readonly StoryContentStep[],
): { stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] } | { unreadable: UnreadableReason } {
  const ordered = frameworkStepOrder(steps);
  if ("unreadable" in ordered) return ordered;
  const stepRows: StoryStepRow[] = [];
  const layerRows: StoryLayerRow[] = [];
  ordered.order.forEach((index, rank) => {
    const s = steps[index];
    stepRows.push({
      id: index,
      step_number: rank + 1,
      kind: s.kind === "section" ? "section" : "media",
      object_id: s.object_id ?? null,
      x: s.x ?? null,
      y: s.y ?? null,
      zoom: s.zoom ?? null,
      page: s.page ?? null,
      question: s.question ?? null,
      answer: s.answer ?? null,
      alt_text: s.alt_text ?? null,
      clip_start: s.clip_start ?? null,
      clip_end: s.clip_end ?? null,
      loop: s.loop ?? null,
      extra_columns: s.extra_columns ?? null,
    });
    for (const l of s.layers) {
      layerRows.push({
        step_id: index,
        layer_number: l.layer_number,
        title: l.title ?? null,
        button_label: l.button_label ?? null,
        content: l.content ?? null,
      });
    }
  });
  return { stepRows, layerRows };
}

/** D1's rows rendered as a publish commits them and read back for comparing. */
async function renderedForCompare(
  slug: string,
  stepRows: StoryStepRow[],
  layerRows: StoryLayerRow[],
): Promise<StoryContentStep[]> {
  const { csv, layerFiles } = committedStory(slug, await renderStoryFiles(slug, stepRows, layerRows));
  return parseForCompare(slug, csv, layerFiles);
}

/** Compare form of D1's side: rendered as a publish commits it, parsed back. */
export async function canonicalForCompareFromD1(
  slug: string,
  stepRows: StoryStepRow[],
  layerRows: StoryLayerRow[],
): Promise<CanonicalStory> {
  return canonicalRaw(await renderedForCompare(slug, stepRows, layerRows));
}

/**
 * Compare form of GitHub's side: the files parsed, rendered as a publish would
 * write that parse, and parsed again.
 *
 * A block compared as text has no title the writer could carry through that
 * round trip, so it travels as a stand-in title, a string made unique to this
 * call, which the writer writes in its own form and the read gives back; the
 * text is put back in its place afterwards.
 *
 * `warnings`, when given, receives what the first parse found in the files;
 * the second parse reads the writer's own output and reports nothing.
 * `severalHoldValues` applies to the first parse; the writer's output has no
 * colliding columns.
 */
export async function canonicalForCompareFromFiles(
  slug: string,
  csv: string,
  layerFiles: Record<string, string>,
  warnings?: SheetWarning[],
  severalHoldValues: SeveralHoldValues = "refuse",
): Promise<CanonicalStory> {
  const standIns = new Map<string, string>();
  const nonce = crypto.randomUUID();
  const parsed = (await parseForCompare(slug, csv, layerFiles, warnings, severalHoldValues)).map((step) => ({
    ...step,
    layers: step.layers.map((layer) => {
      if (!layer.frontmatter) return layer;
      const standIn = `frontmatter-${nonce}-${standIns.size}`;
      standIns.set(standIn, layer.frontmatter);
      return { ...layer, title: standIn, frontmatter: undefined };
    }),
  }));
  const rows = rowsFromContent(parsed);
  if ("unreadable" in rows) return { readable: false, reason: rows.unreadable };
  const read = (await renderedForCompare(slug, rows.stepRows, rows.layerRows)).map((step) => ({
    ...step,
    layers: step.layers.map((layer) => {
      const frontmatter = layer.title ? standIns.get(layer.title) : undefined;
      return frontmatter === undefined ? layer : { ...layer, title: undefined, frontmatter };
    }),
  }));
  return canonicalRaw(read);
}

/** Raw form of D1's rows: none of the publisher's transformations applied. */
export function rawCanonicalFromD1(
  stepRows: OrderedStepRow[],
  layerRows: OrderedLayerRow[],
): Promise<CanonicalStory> {
  return canonicalRaw(contentFromRows(stepRows, layerRows));
}

// ---------------------------------------------------------------------------
// The change check for step and layer files
// ---------------------------------------------------------------------------

/** How the dialog lists one story whose content differs. */
export type StoryContentKind = "github-only" | "conflict" | "steps-deleted" | "unreadable" | "restore-choice";

/** What the dialog can show of a content change, without the content itself. */
export interface StoryContentSummary {
  /** Steps in D1's compare form, or null when D1 does not hold the story or cannot read it. */
  d1Steps: number | null;
  /** Steps in HEAD's compare form, or null when HEAD has no step CSV or cannot be read. */
  headSteps: number | null;
  /** Positions where the two step lists differ, the longer list's extra steps included. */
  changedSteps: number;
}

/**
 * One story the dialog lists.
 *
 * Requirement on the dialog and the accept (slice D): every listed story must
 * carry a choice the author can take in the Compositor. An unreadable story
 * leaves the site divergent, and the stale-head blocker then refuses a
 * publish, so for it that choice is "keep the Compositor's version; the next
 * publish rewrites its files", which the accept must be able to record.
 */
export interface StoryContentChange {
  story_id: string;
  /** The story's title, for the dialog to name it: D1's, else HEAD's row. Set by `computeFullSyncDiff`. */
  title?: string | null;
  kind: StoryContentKind;
  /**
   * Whether GitHub's version is the dialog's default for this story: ticked,
   * or for a conflict the use-GitHub choice selected.
   */
  acceptByDefault: boolean;
  /** Why the story could not be read; unreadable only. */
  reason?: UnreadableReason;
  summary: StoryContentSummary;
  /**
   * The raw-form hash of D1's content at check time (`rawCanonicalFromD1`):
   * the `expected` the accept hands the collaboration object, which refuses
   * the story when its live maps no longer match. Null when D1 does not hold
   * the story or cannot canonicalise it.
   */
  expected: string | null;
}

/**
 * The story-file part of the change check: the stories whose content differs,
 * or why the trees could not settle it, in which case the site stays
 * divergent and nothing of it is offered.
 *
 * A check that concludes with `baseUnresolved` read HEAD alone, because the
 * recorded base is no longer a commit GitHub holds (a force-push): every
 * difference is then a change with no default. One that does not conclude
 * carries its `cause` (`InconclusiveCause`), and where known the repository
 * paths and the stories it covers; none named covers them all.
 */
export type StoryContentCheck =
  | { conclusive: true; changes: StoryContentChange[]; suppressedEditorOnly: number; baseUnresolved?: true }
  | StoryContentInconclusive;

export interface StoryContentInconclusive {
  conclusive: false;
  reason: string;
  cause: InconclusiveCause;
  paths?: string[];
  storyIds?: string[];
}

/** A story D1 holds; its rows are read only when the story is compared. */
/**
 * D1's rows with their `order_key`: the raw form takes steps and layers in
 * that order (`contentFromRows`), as the collaboration object takes its maps.
 */
export type OrderedStepRow = StoryStepRow & { order_key?: string | null };
export type OrderedLayerRow = StoryLayerRow & { order_key?: string | null };

export interface StoryCheckD1Story {
  story_id: string;
  loadRows: () => Promise<{ stepRows: OrderedStepRow[]; layerRows: OrderedLayerRow[] }>;
}

export interface StoryCheckInput {
  token: string;
  owner: string;
  repo: string;
  /** The recorded base commit, or null when the site has none. */
  base: string | null;
  /** The HEAD commit every read is pinned to. */
  head: string;
  d1: readonly StoryCheckD1Story[];
  /**
   * Stories deleted in the Compositor whose row the base and HEAD's
   * project.csv both still hold: offered the restore / keep-deleted choice
   * when their files changed.
   */
  deletedHere: readonly string[];
  /** Story ids with a row in HEAD's project.csv. */
  headRowIds: ReadonlySet<string>;
  /**
   * Receives what the parse of each step CSV read at HEAD found in it, and
   * each step or layer file there whose bytes are not valid UTF-8. Nothing
   * read at the base, the state last reconciled, is reported.
   */
  warnings?: SheetWarning[];
  /**
   * Receives, for each step or layer file read at HEAD whose bytes are not
   * valid UTF-8, by the name the author sees (`unreadableFileName`), the
   * stories whose file it is; filled whether or not `warnings` are given.
   */
  lossyStories?: Map<string, Set<string>>;
}
type StoryRows = { stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] };

type StorySide =
  | { present: false }
  | {
      present: true;
      canonical: CanonicalStory;
      asImported?: CanonicalStory;
      /** The side's files read to rows as the framework reads them, or null when their order is not known. */
      rows: () => Promise<StoryRows | null>;
      /**
       * The layer files the step CSV names, as the framework reads them. The
       * rows keep a layer's body and title but not the rest of its front
       * matter, so the files are compared as they are.
       */
      layerFiles: Record<string, string>;
      /** The rows `asImported` was read from, when they could be ordered. */
      asImportedRows?: { stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] };
      /**
       * The canonical names for which the base's parse chose among colliding
       * columns that held values; absent when there were none.
       */
      collided?: ReadonlySet<string>;
    };

/**
 * Why the story subtrees at `base` and `head` (at `head` alone when there is
 * no base, or the base is no longer a commit GitHub holds) cannot be read to
 * a conclusion, or null when they can: the tree-level conclusion
 * `checkStoryContent` reaches first, reading no file.
 */
export async function storyTreesInconclusive(
  input: RepoAccess,
  base: string | null,
  head: string,
): Promise<TreesInconclusive | null> {
  const read = await checkedStoryTrees(input, base, head);
  return isInconclusive(read) ? read : null;
}

/**
 * The story subtrees at `base` and `head`, as `storyTrees` reads them, with
 * the base the reading kept: null when there is none, or when the base no
 * longer resolves and `head` alone does, so the check runs at the head.
 */
async function checkedStoryTrees(
  input: RepoAccess,
  base: string | null,
  head: string,
): Promise<{ trees: Map<string, CommitFiles>; base: string | null } | TreesInconclusive> {
  const trees = await storyTrees(input, base ? [base, head] : [head]);
  if (!isInconclusive(trees)) return { trees, base };
  if (!base || !trees.unresolved) return trees;
  const atHead = await storyTrees(input, [head]);
  return isInconclusive(atHead) ? atHead : { trees: atHead, base: null };
}

/**
 * The accepted stories' content at `head`, as rows in the order the
 * framework renders them (`rowsFromContent`): each layer row's `step_id` is
 * the index of its step in the parse, which is also its step row's `id`.
 *
 * Read strictly, through the check's own readers, so the content imported is
 * the content the check compared: the story subtrees listed at `head`, the
 * step CSV and the layer files the framework resolves, parsed by the import's
 * parse. A story with no step CSV at `head` reads as no steps. Anything that
 * cannot be read, and a story whose step order is not known, throws: the
 * accept does not import a guess.
 */
export async function readStoriesForAccept(
  input: RepoAccess,
  head: string,
  storyIds: readonly string[],
): Promise<Map<string, { stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] }>> {
  const out = new Map<string, { stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] }>();
  if (storyIds.length === 0) return out;
  const trees = await storyTrees(input, [head]);
  if (isInconclusive(trees)) throw new Error(`the accepted stories could not be read: ${trees.reason}`);
  const files = trees.get(head)!;
  for (const id of storyIds) out.set(id, await storyRowsAt(input, head, files, id));
  return out;
}

/** One story's content at `head`, as `readStoriesForAccept` reads it, from its listed subtrees. */
export async function storyRowsAt(
  input: RepoAccess,
  head: string,
  files: CommitFiles,
  id: string,
): Promise<{ stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] }> {
  const csvSha = files.sheets.get(`${id}.csv`);
  if (csvSha === undefined) return { stepRows: [], layerRows: [] };
  const csv = await readBlobText(input, head, `${SPREADSHEETS_DIR}/${id}.csv`, csvSha);
  const { framework } = await layerFilesAt(input, head, files, id, csv);
  const rows = rowsFromContent(await parseStoryFiles(id, csv, framework));
  if ("unreadable" in rows) throw new Error(`${id}'s step order could not be read: ${JSON.stringify(rows.unreadable)}`);
  return rows;
}

/**
 * One story's compare form at one commit, read strictly; at the recorded
 * `base`, also the reading the import would have given D1 from these files.
 *
 * The base is read keeping the last of several colliding columns that hold
 * values, as `readBaseSheet` in sync.server.ts reads the other sheets' base,
 * and for the same reason: the base is only the reference of a comparison,
 * and it does not change until a sync succeeds, so refusing it would leave
 * the story unreadable and stop the sync that brings the author's fix. HEAD,
 * which an accept would import, is refused. The parse reports each choice it
 * made (`column_collision_last`), and the names it chose for are `collided`:
 * which of their columns the Compositor holds is not known.
 */
async function storyAt(
  input: StoryCheckInput,
  commit: string,
  files: CommitFiles,
  id: string,
  base = false,
): Promise<StorySide> {
  const csvSha = files.sheets.get(`${id}.csv`);
  if (csvSha === undefined) return { present: false };
  const { reported, onLossy } = headReporting(input, !base && commit === input.head, id);
  const csv = await readReportedBlobText(input, commit, `${SPREADSHEETS_DIR}/${id}.csv`, csvSha, reported, undefined, onLossy);
  const severalHoldValues: SeveralHoldValues = base ? "keep-last" : "refuse";
  const { framework, imported } = await layerFilesAt(input, commit, files, id, csv, severalHoldValues, reported, onLossy);
  // The base's findings are not reported, only read for the parse's choice.
  const baseIssues: SheetWarning[] = [];
  const warnings = base ? baseIssues : commit === input.head ? input.warnings : undefined;
  const canonical = await canonicalForCompareFromFiles(id, csv, framework, warnings, severalHoldValues);
  const rows = async () => {
    const read = rowsFromContent(await parseStoryFiles(id, csv, framework, severalHoldValues));
    return "unreadable" in read ? null : read;
  };
  if (!base) return { present: true, canonical, rows, layerFiles: framework };
  const { canonical: asImported, rows: asImportedRows } = await canonicalForCompareAsImported(
    id, csv, imported, severalHoldValues,
  );
  const collided = new Set(baseIssues.flatMap((w) => (w.code === "column_collision_last" ? [w.name] : [])));
  return {
    present: true,
    canonical,
    rows,
    layerFiles: framework,
    asImported,
    ...(asImportedRows ? { asImportedRows } : {}),
    ...(collided.size > 0 ? { collided } : {}),
  };
}

/** What a read at HEAD reports: its warnings, and the story each lossy file is tagged to; nothing for a read at any other commit. */
function headReporting(
  input: StoryCheckInput,
  atHead: boolean,
  id: string,
): { reported: SheetWarning[] | undefined; onLossy: ((path: string) => void) | undefined } {
  if (!atHead) return { reported: undefined, onLossy: undefined };
  return { reported: input.warnings, onLossy: (path) => tagLossy(input.lossyStories, path, id) };
}

/** Records in `sink` that the file at `path`, read lossily at HEAD, is one of story `id`'s. */
function tagLossy(sink: Map<string, Set<string>> | undefined, path: string, id: string): void {
  if (!sink) return;
  const file = unreadableFileName(path);
  const stories = sink.get(file) ?? new Set<string>();
  stories.add(id);
  sink.set(file, stories);
}

/**
 * A story's files read as the import read them into D1 (`parseStoryFiles`:
 * the import's layer titles, and a missing layer file read as the import
 * reads it), then put through the render and parse D1's side gets
 * (`canonicalForCompareFromD1`). Equal to D1's compare form exactly when D1
 * holds what an import of these files would store. Also gives the rows it
 * was read from, when their order is known.
 */
async function canonicalForCompareAsImported(
  slug: string,
  csv: string,
  layerFiles: Record<string, string>,
  severalHoldValues: SeveralHoldValues,
): Promise<{ canonical: CanonicalStory; rows?: { stepRows: StoryStepRow[]; layerRows: StoryLayerRow[] } }> {
  const rows = rowsFromContent(await parseStoryFiles(slug, csv, layerFiles, severalHoldValues));
  if ("unreadable" in rows) return { canonical: { readable: false, reason: rows.unreadable } };
  return { canonical: await canonicalForCompareFromD1(slug, rows.stepRows, rows.layerRows), rows };
}

/** Whether two readings of a story agree once `mask`'s fields are masked out of both. */
async function agreeMasked(slug: string, a: StoryRows | null | undefined, b: StoryRows | null | undefined, mask: StoryMask): Promise<boolean> {
  if (!a || !b) return false;
  const x = maskedRows(a.stepRows, a.layerRows, mask);
  const y = maskedRows(b.stepRows, b.layerRows, mask);
  return sameContent(
    await canonicalForCompareFromD1(slug, x.stepRows, x.layerRows),
    await canonicalForCompareFromD1(slug, y.stepRows, y.layerRows),
  );
}

/**
 * A story whose base's step CSV had colliding columns (`collided`) and which
 * differs between D1 and HEAD, classified with the fields those columns feed
 * masked out (`storyMaskFor`):
 * - HEAD and the base agree masked, their layer files are the same text, and
 *   D1 and HEAD hold the same values in the masked fields: the difference is
 *   the author's own, outside them, and is left to the author as an
 *   editor-only change is;
 * - otherwise a conflict, since the base cannot say which side changed the
 *   masked fields. The accept replaces the whole story, so GitHub's version is
 *   the default only when D1 and the base as imported agree masked. A mask
 *   that cannot be made, or rows whose order is not known, leave the author's
 *   version the default.
 */
async function classifyCollided(
  slug: string,
  d1: StoryRows,
  headSide: Extract<StorySide, { present: true }>,
  baseSide: Extract<StorySide, { present: true }>,
  collided: ReadonlySet<string>,
): Promise<"editor-only" | { repoDefault: boolean }> {
  const mask = storyMaskFor(collided);
  if (!mask) return { repoDefault: false };
  const head = await headSide.rows();
  if (
    head &&
    sameLayerFiles(headSide.layerFiles, baseSide.layerFiles) &&
    (await agreeMasked(slug, head, await baseSide.rows(), mask)) &&
    collidedValues(d1.stepRows, d1.layerRows, mask) === collidedValues(head.stepRows, head.layerRows, mask)
  ) {
    return "editor-only";
  }
  return { repoDefault: await agreeMasked(slug, d1, baseSide.asImportedRows, mask) };
}

/**
 * Whether a story's files changed between base and HEAD: its step CSV's blob,
 * or the blob of a layer file its CSV names at either commit. The CSV is read
 * for its names only when layer files changed and the CSV did not.
 */
async function isCandidate(
  input: StoryCheckInput,
  base: string,
  trees: Map<string, CommitFiles>,
  changedLayers: ReadonlySet<string>,
  id: string,
): Promise<boolean> {
  const before = trees.get(base)!;
  const after = trees.get(input.head)!;
  const csvPath = `${id}.csv`;
  const sha = before.sheets.get(csvPath);
  if (sha !== after.sheets.get(csvPath)) return true;
  if (sha === undefined || changedLayers.size === 0) return false;
  const csv = await readBlobText(input, base, `${SPREADSHEETS_DIR}/${csvPath}`, sha);
  // A superset of the stories whose reading can differ. A plain ASCII
  // reference resolves among its three candidate paths only, so it can read
  // differently only when one of them changed, a directory appearing or going
  // at one included (`changedLayers` holds those too); any other reference is
  // a candidate whenever anything under texts/stories changed.
  return namedLayerFiles(id, csv).some((name) => {
    if (!isPlainReference(name) || !isAscii(name)) return true;
    return layerPathCandidates(name).some((p) => changedLayers.has(p));
  });
}

function symmetricDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...[...a].filter((x) => !b.has(x)), ...[...b].filter((x) => !a.has(x))];
}

function changedPaths(before: Map<string, string>, after: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [path, sha] of before) if (after.get(path) !== sha) out.add(path);
  for (const path of after.keys()) if (!before.has(path)) out.add(path);
  return out;
}

type CanonicalSteps = Extract<CanonicalStory, { readable: true }>["steps"];

function stepsOf(story: CanonicalStory | null): CanonicalSteps | null {
  return story !== null && story.readable ? story.steps : null;
}

function summarise(d1: CanonicalStory | null, head: CanonicalStory | null): StoryContentSummary {
  const a = stepsOf(d1);
  const b = stepsOf(head);
  const left = a ?? [];
  const right = b ?? [];
  let changedSteps = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (JSON.stringify(left[i] ?? null) !== JSON.stringify(right[i] ?? null)) changedSteps++;
  }
  return { d1Steps: a === null ? null : a.length, headSteps: b === null ? null : b.length, changedSteps };
}

function sameContent(a: CanonicalStory | null, b: CanonicalStory | null): boolean {
  if (a === null || b === null) return a === b;
  return a.readable && b.readable && a.hash === b.hash;
}

function unreadableReason(...sides: Array<CanonicalStory | null>): UnreadableReason | null {
  for (const side of sides) if (side && !side.readable) return side.reason;
  return null;
}

type Classified = StoryContentChange | "none" | "editor-only";

/**
 * One D1 story, classified from its compare forms:
 * - HEAD equal to D1: nothing, whoever changed what;
 * - with a base: GitHub only (listed, accepted by default), the Compositor
 *   only (not listed), both (a conflict, resolved for the whole story); a step
 *   CSV present at the base and absent at HEAD while its project.csv row
 *   remains is "steps deleted", not accepted by default, or a conflict when
 *   the Compositor also changed the story since the base (`editedSinceBase`);
 * - with no base there is nothing to tell which side changed, so any
 *   difference is a conflict, not accepted by default, and a step CSV absent
 *   at HEAD while HEAD's project.csv holds the story's row is "steps deleted";
 * - a side that cannot be read makes the story unreadable, with nothing to
 *   accept;
 * - a base whose step CSV had colliding columns holding values (`collided`)
 *   cannot tell which side changed them (`classifyCollided`).
 */
async function classifyD1Story(
  input: StoryCheckInput,
  story: StoryCheckD1Story,
  headSide: StorySide,
  baseSide: StorySide | null,
): Promise<Classified> {
  const { stepRows, layerRows } = await story.loadRows();
  const d1 = await canonicalForCompareFromD1(story.story_id, stepRows, layerRows);
  const raw = await rawCanonicalFromD1(stepRows, layerRows);
  const expected = raw.readable ? raw.hash : null;
  const head = headSide.present ? headSide.canonical : null;
  const base = baseSide?.present ? baseSide.canonical : null;
  const baseAsImported = baseSide?.present ? (baseSide.asImported ?? null) : null;
  const change = (kind: StoryContentKind, acceptByDefault: boolean, reason?: UnreadableReason): StoryContentChange => ({
    story_id: story.story_id,
    kind,
    acceptByDefault,
    ...(reason ? { reason } : {}),
    summary: summarise(d1, head),
    expected,
  });
  const unreadable = unreadableReason(d1, head, base, baseAsImported);
  if (unreadable) return change("unreadable", false, unreadable);
  if (!headSide.present) {
    // With a base, the CSV was there before; with none, a row HEAD's
    // project.csv still holds says the story was published.
    const wasThere = baseSide === null || baseSide.present;
    if (!wasThere || !input.headRowIds.has(story.story_id)) return "none";
    const edited = baseSide?.present && (await editedSinceBase(story.story_id, { stepRows, layerRows }, d1, baseSide));
    return change(edited ? "conflict" : "steps-deleted", false);
  }
  if (sameContent(head, d1)) return "none";
  if (baseSide?.present && baseSide.collided) {
    const classified = await classifyCollided(story.story_id, { stepRows, layerRows }, headSide, baseSide, baseSide.collided);
    return classified === "editor-only" ? classified : change("conflict", classified.repoDefault);
  }
  if (baseSide === null) return change("conflict", false);
  const repoChanged = !sameContent(head, base);
  const editorChanged = !sameContent(d1, baseAsImported);
  if (!repoChanged) return "editor-only";
  return editorChanged ? change("conflict", false) : change("github-only", true);
}

/**
 * Whether D1's story differs from the base as the import reads it, the
 * Compositor's side of `classifyD1Story`. A base whose step CSV had colliding
 * columns holding values compares with those fields masked out
 * (`storyMaskFor`); one no mask can be made for, or whose rows are not in a
 * known order, counts as changed, since nothing then says it is not.
 */
async function editedSinceBase(
  slug: string,
  d1Rows: StoryRows,
  d1: CanonicalStory,
  baseSide: Extract<StorySide, { present: true }>,
): Promise<boolean> {
  if (!baseSide.collided) return !sameContent(d1, baseSide.asImported ?? null);
  const mask = storyMaskFor(baseSide.collided);
  return !mask || !(await agreeMasked(slug, d1Rows, baseSide.asImportedRows, mask));
}

/**
 * The step and layer files of the stories a sync concerns, compared across
 * the recorded base, HEAD and D1, every read at the one HEAD
 * commit (or the base) it is given and strict: an absent file is absent, and
 * any other failure makes the check inconclusive, never a value. A story
 * whose files were read and cannot be understood is listed as unreadable.
 *
 * Three readings, one per question (`classifyD1Story`):
 * - nothing to do: HEAD's strict compare form equals D1's. Only an exact
 *   match of what GitHub holds and what the Compositor holds means nothing;
 * - repoChanged: HEAD's strict compare form differs from the base's. Both
 *   are GitHub's files read the same way, so no GitHub edit is hidden, a
 *   hand-written front matter block included;
 * - editorChanged: D1's compare form differs from the base read as the
 *   import reads it (`canonicalForCompareAsImported`). D1 was seeded by
 *   importing the base, so this is the reading that tells an untouched
 *   import from an edit; the strict form would read every hand-written block
 *   as an edit and list GitHub-only changes as conflicts.
 *
 * Candidates, with a base: the stories whose step CSV changed between base and
 * HEAD, or whose CSV at either commit names a layer file that changed. Only
 * candidates are read in full. With no base every D1 story whose step CSV
 * HEAD holds is compared, since nothing says which changed; so with a base
 * GitHub no longer holds, read at HEAD alone (`baseUnresolved`). Each file is
 * read once per blob SHA and kept for later checks (`readBlobText`), so a file
 * shared by two stories is read once and an unchanged one is not read again.
 */
export async function checkStoryContent(given: StoryCheckInput): Promise<StoryContentCheck> {
  const read = await checkedStoryTrees(given, given.base, given.head);
  if (isInconclusive(read)) return { conclusive: false, ...read };
  const { trees } = read;
  const baseUnresolved = given.base !== null && read.base === null;
  const input = baseUnresolved ? { ...given, base: null, deletedHere: [] } : given;
  const { base, head } = input;

  const headFiles = trees.get(head)!;
  const changedLayers = new Set<string>();
  if (base) {
    const before = trees.get(base)!;
    for (const path of changedPaths(before.texts, headFiles.texts)) changedLayers.add(path);
    // A directory added or removed changes the subtree as a file does.
    for (const dir of symmetricDifference(before.textDirs, headFiles.textDirs)) changedLayers.add(dir);
  }
  const scope: CheckScope = { input, trees, changedLayers };

  try {
    return { conclusive: true, ...(await classifyStories(scope)), ...(baseUnresolved ? { baseUnresolved: true as const } : {}) };
  } catch (err) {
    if (err instanceof StoryFileUnread) {
      return { conclusive: false, reason: err.message, cause: "request", paths: [err.path], storyIds: [err.storyId] };
    }
    throw err;
  }
}

/** A read of one story's file that failed: the check does not conclude, for a request cause. */
class StoryFileUnread extends Error {
  constructor(readonly path: string, readonly storyId: string, message: string) {
    super(message);
    this.name = "StoryFileUnread";
  }
}

/** `run` for story `id`, a failed read named with the story. */
async function forStory<T>(id: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SheetUnreadableError) throw new StoryFileUnread(err.path, id, err.message);
    throw err;
  }
}

/** Every D1 story and every story deleted here, classified in turn. */
async function classifyStories(scope: CheckScope): Promise<{ changes: StoryContentChange[]; suppressedEditorOnly: number }> {
  const { input } = scope;
  const changes: StoryContentChange[] = [];
  let suppressedEditorOnly = 0;
  for (const story of input.d1) {
    const result = await forStory(story.story_id, () => checkD1Story(scope, story));
    if (result === "editor-only") suppressedEditorOnly++;
    else if (result !== "none") changes.push(result);
  }
  for (const id of input.base ? input.deletedHere : []) {
    const result = await forStory(id, () => checkDeletedHere(scope, id));
    if (result) changes.push(result);
  }
  return { changes, suppressedEditorOnly };
}

interface CheckScope {
  input: StoryCheckInput;
  trees: Map<string, CommitFiles>;
  changedLayers: ReadonlySet<string>;
}

/** A story whose files were read and cannot be understood. */
function unreadableChange(id: string, err: unknown): StoryContentChange {
  return {
    story_id: id,
    kind: "unreadable",
    acceptByDefault: false,
    reason: reasonOf(err),
    summary: { d1Steps: null, headSteps: null, changedSteps: 0 },
    expected: null,
  };
}

/** One D1 story: skipped when not a candidate, else read and classified. */
async function checkD1Story(scope: CheckScope, story: StoryCheckD1Story): Promise<Classified> {
  const { input, trees, changedLayers } = scope;
  const { base, head } = input;
  const id = story.story_id;
  const headFiles = trees.get(head)!;
  try {
    if (base && !(await isCandidate(input, base, trees, changedLayers, id))) return "none";
    // With no base, a story HEAD has neither a step CSV nor a row for was
    // never published.
    if (!base && !headFiles.sheets.has(`${id}.csv`) && !input.headRowIds.has(id)) return "none";
    const headSide = await storyAt(input, head, headFiles, id);
    const baseSide = base ? await storyAt(input, base, trees.get(base)!, id, true) : null;
    return await classifyD1Story(input, story, headSide, baseSide);
  } catch (err) {
    if (err instanceof SheetUnreadableError) throw err;
    return unreadableChange(id, err);
  }
}

/** A story deleted here: the restore choice when its files changed there. */
async function checkDeletedHere(scope: CheckScope, id: string): Promise<StoryContentChange | null> {
  const { input, trees, changedLayers } = scope;
  try {
    if (!(await isCandidate(input, input.base!, trees, changedLayers, id))) return null;
  } catch (err) {
    if (err instanceof SheetUnreadableError) throw err;
    return unreadableChange(id, err);
  }
  return {
    story_id: id,
    kind: "restore-choice",
    acceptByDefault: false,
    summary: { d1Steps: null, headSteps: null, changedSteps: 0 },
    expected: null,
  };
}
