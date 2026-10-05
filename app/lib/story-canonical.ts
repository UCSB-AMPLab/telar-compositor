/**
 * The raw canonical form of a story's content, and its hash.
 *
 * A story reduces to its steps in the order the framework renders them, each
 * with its fields and its layers in order, text with line endings as `\n`.
 * The step values themselves are not content: a story renumbered 1, 2, 3 to
 * 10, 20, 30 renders the same and canonicalises the same. Neither are layer
 * filenames, which the publisher derives.
 *
 * There are two canonical forms, with two jobs:
 *
 * - The raw form, here: a story as D1's rows or the live Y.Maps hold it,
 *   canonicalised with none of the publisher's transformations. Its hash is
 *   the `expected` value the collaboration object checks its live maps
 *   against before an accept, so an edit made after the check, or not yet
 *   snapshotted to D1 when it ran, refuses the accept.
 * - The compare form, `canonicalForCompare*` in `story-content.server.ts`: a
 *   story rendered as a publish would write it and parsed back, then reduced
 *   here. It answers whether the Compositor's version differs from GitHub's,
 *   and both sides go through it, so a difference only the publisher would
 *   erase (default coordinates for an unplaced media step, the rule guard's
 *   blank line before `---`) is no difference. It needs the publisher and the
 *   import's parsers, so it lives on the server.
 *
 * Imported by the Worker and the server alike: nothing here may depend on
 * either environment, so it uses only the Web Crypto digest both provide.
 *
 * @version v1.5.0-beta
 */

export interface StoryContentLayer {
  layer_number: number;
  title?: string | null;
  button_label?: string | null;
  content?: string | null;
  /**
   * A layer's front matter block as text, line endings `\n`, where the compare
   * form keeps the block rather than its title: a block that is not in the
   * Compositor writer's own form. Absent for every other layer, and always
   * for the raw form, whose rows and maps carry a title.
   */
  frontmatter?: string | null;
}

export interface StoryContentStep {
  /** The `step` cell as read; undefined where the sheet has no such column. */
  step: string | undefined;
  kind?: string | null;
  object_id?: string | null;
  x?: number | null;
  y?: number | null;
  zoom?: number | null;
  page?: string | null;
  question?: string | null;
  answer?: string | null;
  alt_text?: string | null;
  clip_start?: string | null;
  clip_end?: string | null;
  loop?: string | null;
  /** The kept columns' JSON blob, as D1 and the import store it. */
  extra_columns?: string | null;
  layers: StoryContentLayer[];
}

export interface CanonicalLayer {
  layer_number: number;
  title: string;
  button_label: string;
  content: string;
  /** "" unless the layer's block is compared as text (see StoryContentLayer). */
  frontmatter: string;
}

export interface CanonicalStep {
  kind: string;
  object_id: string;
  x: number | null;
  y: number | null;
  zoom: number | null;
  page: string;
  question: string;
  answer: string;
  alt_text: string;
  clip_start: string;
  clip_end: string;
  loop: string;
  /** Kept cells as [column, value] pairs, sorted by column. */
  extra_columns: Array<[string, string]>;
  layers: CanonicalLayer[];
}

/**
 * Why a story cannot be read, as a code and the values it concerns. The
 * dialog writes the sentence from the code (`SyncStoryContentBlock`), so no
 * reason carries text; a new code is a type error there until it has one.
 */
export type UnreadableReason =
  | { code: "step_missing"; row: number }
  | { code: "step_not_plain"; step: string; row: number }
  | { code: "step_too_precise"; step: string; row: number }
  | { code: "step_repeated"; step: string; earlier: string }
  | { code: "layer_number_repeated"; row: number; layer: number }
  | { code: "layer_reference_not_plain"; reference: string }
  | { code: "layer_reference_directory"; reference: string }
  | { code: "layer_reference_non_ascii"; reference: string }
  | { code: "columns_collide"; column: string; headers: string[] }
  | { code: "files_unreadable" };

export type CanonicalStory =
  | { readable: true; steps: CanonicalStep[]; hash: string }
  | { readable: false; reason: UnreadableReason };

/**
 * A step cell whose numeric reading is certain: an optionally signed ASCII
 * integer, or an optionally signed ASCII decimal of at most 15 significant
 * digits, with no surrounding whitespace.
 *
 * `pd.to_numeric` reads these as the number they spell, and so does
 * `Number()`. Beyond 15 significant digits the two parsers can disagree:
 * `0.3` and `0.30000000000000004` are two numbers to `Number()` and one to
 * pandas, so a duplicate the framework sees would pass unseen here. 15 is the
 * number of decimal digits a double carries without loss, so two distinct
 * decimals within it are two distinct doubles to either parser. Other shapes
 * (exponents, Unicode digits, underscores, padding, words) follow pandas' own
 * grammar or become NaN, which cannot be predicted from here with certainty.
 */
const PLAIN_INTEGER = /^[+-]?\d+$/;
const PLAIN_DECIMAL = /^[+-]?(?:\d+\.\d*|\.\d+)$/;
const MAX_DECIMAL_DIGITS = 15;

/** Why `cell` has no certain numeric reading, or null when it has one. */
function unplainCode(cell: string): "step_not_plain" | "step_too_precise" | null {
  if (PLAIN_INTEGER.test(cell)) return null;
  if (!PLAIN_DECIMAL.test(cell)) return "step_not_plain";
  const digits = cell.replace(/[^0-9]/g, "").replace(/^0+/, "").replace(/0+$/, "");
  return digits.length > MAX_DECIMAL_DIGITS ? "step_too_precise" : null;
}

/**
 * The order the framework renders a story's rows in, as row indices, or the
 * reason it cannot render them unambiguously.
 *
 * The rule, from the framework's source (the framework):
 *
 * - `process_story` sorts the rows by `pd.to_numeric(df['step'],
 *   errors='coerce')` with `kind='mergesort'` (stable) and
 *   `na_position='last'` (scripts/telar/processors/stories.py:897-909). So
 *   steps follow their numeric `step` value, gaps mean nothing, rows sharing a
 *   value keep their row order, and rows with no numeric value go last.
 * - The browser then finds a step's card content and its panels by that
 *   value, first match: `steps.find(s => s.step == contentId)`
 *   (assets/js/telar-story/panels.js:281, navigation.js:599) and
 *   `.story-step[data-step="${step.step}"]` (card-pool.js:808). A value two
 *   steps share therefore shows the first step's content for the second, so a
 *   repeated value (numerically: `2` and `2.0` are one) is unreadable.
 * - A blank or absent value is unreadable too. The sort puts it last, but
 *   under `==` blanks match each other and `0`, and a blank makes pandas type
 *   the whole column as float, so the ordering is certain and the pairing is
 *   not. A value without a certain numeric reading is unreadable for the reasons
 *   given at `PLAIN_INTEGER`.
 */
export function frameworkStepOrder(
  rows: ReadonlyArray<{ step: string | undefined }>,
): { order: number[] } | { unreadable: UnreadableReason } {
  const values: number[] = [];
  const seen = new Map<number, string>();
  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i].step;
    if (cell === undefined || cell.trim() === "") {
      return { unreadable: { code: "step_missing", row: i + 1 } };
    }
    const unplain = unplainCode(cell);
    if (unplain !== null) return { unreadable: { code: unplain, step: cell, row: i + 1 } };
    const value = Number(cell);
    const earlier = seen.get(value);
    if (earlier !== undefined) {
      return { unreadable: { code: "step_repeated", step: cell, earlier } };
    }
    seen.set(value, cell);
    values.push(value);
  }
  const order = values.map((_, i) => i);
  // Array.prototype.sort is stable, as the framework's mergesort is.
  order.sort((a, b) => values[a] - values[b]);
  return { order };
}

function text(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n");
}

function number(value: number | null | undefined): number | null {
  return value ?? null;
}

/** Kept cells sorted by column; a corrupt, empty or absent blob is none. */
function keptCells(raw: string | null | undefined): Array<[string, string]> {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.keys(parsed)
    .sort()
    .map((key): [string, string] => [key, text(String((parsed as Record<string, unknown>)[key]))]);
}

function canonicalLayers(step: StoryContentStep, index: number): CanonicalLayer[] | UnreadableReason {
  const numbers = new Set<number>();
  for (const layer of step.layers) {
    if (numbers.has(layer.layer_number)) {
      return { code: "layer_number_repeated", row: index + 1, layer: layer.layer_number };
    }
    numbers.add(layer.layer_number);
  }
  // The framework reads layers from their numbered columns, layer 1 first.
  return [...step.layers]
    .sort((a, b) => a.layer_number - b.layer_number)
    .map((l) => ({
      layer_number: l.layer_number,
      title: text(l.title),
      button_label: text(l.button_label),
      content: text(l.content),
      frontmatter: text(l.frontmatter),
    }));
}

function canonicalStep(step: StoryContentStep, layers: CanonicalLayer[]): CanonicalStep {
  return {
    kind: step.kind ?? "media",
    object_id: text(step.object_id),
    x: number(step.x),
    y: number(step.y),
    zoom: number(step.zoom),
    page: text(step.page),
    question: text(step.question),
    answer: text(step.answer),
    alt_text: text(step.alt_text),
    clip_start: text(step.clip_start),
    clip_end: text(step.clip_end),
    loop: text(step.loop),
    extra_columns: keptCells(step.extra_columns),
    layers,
  };
}

/**
 * The hash input: every field by position, so it does not depend on how an
 * object's keys happen to be ordered.
 */
function hashInput(steps: CanonicalStep[]): string {
  return JSON.stringify(
    steps.map((s) => [
      s.kind, s.object_id, s.x, s.y, s.zoom, s.page, s.question, s.answer, s.alt_text,
      s.clip_start, s.clip_end, s.loop, s.extra_columns,
      s.layers.map((l) => [l.layer_number, l.title, l.button_label, l.content, l.frontmatter]),
    ]),
  );
}

/** The SHA-256 of `input`'s UTF-8 bytes as lowercase hex, by the Web Crypto digest both environments provide. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A story reduced to its raw canonical content, or the reason it has none.
 * The compare form is this applied to a story that has been through the
 * publisher's render and the import's parse.
 */
export async function canonicalRaw(steps: StoryContentStep[]): Promise<CanonicalStory> {
  const ordered = frameworkStepOrder(steps);
  if ("unreadable" in ordered) return { readable: false, reason: ordered.unreadable };
  const out: CanonicalStep[] = [];
  for (const i of ordered.order) {
    const layers = canonicalLayers(steps[i], i);
    if (!Array.isArray(layers)) return { readable: false, reason: layers };
    out.push(canonicalStep(steps[i], layers));
  }
  return { readable: true, steps: out, hash: await sha256Hex(hashInput(out)) };
}

/** A step's fields as the canonical form reads them. */
export interface ContentStepFields {
  kind?: string | null;
  object_id?: string | null;
  x?: number | null;
  y?: number | null;
  zoom?: number | null;
  page?: string | null;
  question?: string | null;
  answer?: string | null;
  alt_text?: string | null;
  clip_start?: string | null;
  clip_end?: string | null;
  loop?: string | null;
  extra_columns?: string | null;
}

/** A layer's fields as the canonical form reads them. */
export interface ContentLayerFields {
  title?: string | null;
  button_label?: string | null;
  content?: string | null;
}

/** A step row, D1's: its fields, its identity and its place. */
export interface ContentStepRow extends ContentStepFields {
  id: number;
  step_number: number;
  order_key?: string | null;
}

/** A layer row, D1's. */
export interface ContentLayerRow extends ContentLayerFields {
  step_id: number;
  layer_number: number;
  order_key?: string | null;
}

/**
 * Steps already in their order, each with its layers in theirs, as
 * canonicaliser input: every step's `step` and every layer's `layer_number`
 * is its rank in that order. The raw form's input, with nothing of the
 * publisher's applied.
 *
 * Ranks, not the stored numbers, because the order is the `order_key` order
 * the author sees and the stored numbers can lag it; the snapshot writes
 * each step's `step_number` and each layer's `layer_number` as exactly this
 * rank, so a snapshotted row and its live map agree. The Worker takes its
 * maps through `orderedEntries`, and `contentFromRows` sorts D1's rows the
 * same way, so the two sides compute one hash for one story.
 */
export function contentInOrder(
  steps: ReadonlyArray<ContentStepFields & { layers: readonly ContentLayerFields[] }>,
): StoryContentStep[] {
  return steps.map((s, rank) => ({
    step: String(rank + 1),
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
    layers: s.layers.map((l, layerRank) => ({
      layer_number: layerRank + 1,
      title: l.title,
      button_label: l.button_label,
      content: l.content,
    })),
  }));
}

/** `order_key` order, as `orderedEntries` gives it: no key sorts before any key, ties by the second key. */
function byOrderKey<T extends { order_key?: string | null }>(tie: (row: T) => number) {
  return (a: T, b: T): number => {
    const ka = a.order_key ?? "";
    const kb = b.order_key ?? "";
    if (ka !== kb) return ka < kb ? -1 : 1;
    return tie(a) - tie(b);
  };
}

/**
 * D1's step rows in the order `contentFromRows` takes them, so a caller can
 * name the row behind each step of the canonical form by its rank.
 */
export function stepRowsInOrder<T extends ContentStepRow>(stepRows: readonly T[]): T[] {
  return [...stepRows].sort(byOrderKey((row) => row.id));
}

/**
 * D1's rows as canonicaliser input, in `order_key` order with ranks
 * (`contentInOrder`). Ties, which the load's backfill repairs in the live
 * document, fall back to the row id, then for layers to the stored number.
 */
export function contentFromRows(
  stepRows: readonly ContentStepRow[],
  layerRows: readonly ContentLayerRow[],
): StoryContentStep[] {
  const steps = stepRowsInOrder(stepRows);
  return contentInOrder(
    steps.map((s) => ({
      ...s,
      layers: layerRows.filter((l) => l.step_id === s.id).sort(byOrderKey((row) => row.layer_number)),
    })),
  );
}
