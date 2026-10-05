/**
 * The fields of a story's steps and layers that the colliding columns of its
 * recorded base feed, and its rows with those fields masked out: what the
 * change check needs to tell a Compositor edit elsewhere in the story from the
 * column the base cannot place (story-content.server.ts, `classifyD1Story`).
 *
 * @version v1.5.0-beta
 */

import { mapStoryCsv } from "~/lib/import.server";
import type { StoryLayerRow, StoryStepRow } from "~/lib/publish.server";

const STEP_FIELDS = [
  "kind", "object_id", "x", "y", "zoom", "page", "question", "answer",
  "alt_text", "clip_start", "clip_end", "loop", "extra_columns",
] as const;
const LAYER_FIELDS = ["title", "button_label", "content"] as const;

type StepField = (typeof STEP_FIELDS)[number];
type LayerField = (typeof LAYER_FIELDS)[number];

/** The step fields, and the layer fields by layer number, a set of columns feeds. */
export interface StoryMask {
  steps: Set<StepField>;
  layers: Set<`${number}.${LayerField}`>;
}

/**
 * Columns whose reach the probe cannot show: `step` orders the steps, and a
 * layer cell may name a file whose text and front matter title it brings in.
 * A collision on any of them leaves nothing the comparison can mask with
 * confidence.
 */
const UNMAPPABLE = new Set(["step", "layer1_content", "layer2_content", "layer1_file", "layer2_file"]);

/**
 * Fields that cannot be masked. A step with no object is written as a section
 * card, with no coordinates, and a text-less one is not written at all, so
 * masking `kind` or `object_id` hides edits to coordinates and to which steps
 * there are. The custom-column blob is written whole by the accept, so masking
 * it would let GitHub's blob replace the author's other custom columns.
 */
const UNMASKABLE: ReadonlySet<StepField> = new Set(["kind", "object_id", "extra_columns"]);

/** A step with both layers filled, which each probe changes in one column. */
const PROBE_ROW: Record<string, string> = {
  step: "1",
  object: "probe",
  question: "q",
  answer: "a",
  layer1_button: "b1",
  layer1_content: "c1",
  layer2_button: "b2",
  layer2_content: "c2",
};

/**
 * The values each column is read at. A field is fed by the column when its
 * reading differs across them: "true" reads as text and as a truthy value,
 * "1" as a number, which a coordinate or page reads where it drops "true",
 * and "" as nothing.
 */
const PROBE_VALUES = ["true", "1", ""];

/** One probe row as the import maps it, flattened to field readings. */
function readings(row: Record<string, string>): Map<string, string> {
  const { steps, layers } = mapStoryCsv([row], 0);
  const out = new Map<string, string>();
  const step = steps[0] as Record<string, unknown> | undefined;
  for (const f of STEP_FIELDS) out.set(f, JSON.stringify(step?.[f] ?? null));
  for (const layer of layers) {
    for (const f of LAYER_FIELDS) out.set(`${layer.layer_number}.${f}`, JSON.stringify(layer[f] ?? null));
  }
  return out;
}

/**
 * The fields the `collided` columns feed, read through the import's own
 * mapper (`mapStoryCsv`) as `fieldsFedBy` in sync.server.ts reads a sheet's,
 * or null when one of them is `UNMAPPABLE` or feeds an `UNMASKABLE` field.
 * The probe finds what each column feeds on its own reading, not in every
 * combination of columns; a null mask, like a masked comparison that finds a
 * difference, leaves the author's story the default.
 */
export function storyMaskFor(collided: ReadonlySet<string>): StoryMask | null {
  const mask: StoryMask = { steps: new Set(), layers: new Set() };
  for (const name of collided) {
    if (UNMAPPABLE.has(name)) return null;
    const read = PROBE_VALUES.map((value) => readings({ ...PROBE_ROW, [name]: value }));
    const keys = new Set(read.flatMap((r) => [...r.keys()]));
    for (const key of keys) {
      if (new Set(read.map((r) => r.get(key))).size === 1) continue;
      if ((STEP_FIELDS as readonly string[]).includes(key)) mask.steps.add(key as StepField);
      else mask.layers.add(key as `${number}.${LayerField}`);
    }
  }
  return [...mask.steps].some((f) => UNMASKABLE.has(f)) ? null : mask;
}

/**
 * The values of the masked fields, step by step in step order and each
 * layer's by its step's number: what two readings must share for the
 * collided columns to say the same on both. Empty and absent read alike.
 */
export function collidedValues(
  stepRows: readonly StoryStepRow[],
  layerRows: readonly StoryLayerRow[],
  mask: StoryMask,
): string {
  const value = (v: unknown) => (v === undefined || v === null || v === "" ? null : v);
  const numberOf = new Map(stepRows.map((s) => [s.id, s.step_number]));
  const steps = [...stepRows]
    .sort((a, b) => a.step_number - b.step_number)
    .map((s) => [s.step_number, ...[...mask.steps].map((f) => value(s[f]))]);
  const layers = layerRows
    .map((l) => [
      numberOf.get(l.step_id) ?? null,
      l.layer_number,
      ...LAYER_FIELDS.map((f) => (mask.layers.has(`${l.layer_number}.${f}`) ? value(l[f]) : null)),
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ steps, layers });
}

/**
 * `stepRows` and `layerRows` with every masked field set to one value on
 * whichever side they come from: null, and "media" for a step's kind.
 */
export function maskedRows<S extends StoryStepRow, L extends StoryLayerRow>(
  stepRows: readonly S[],
  layerRows: readonly L[],
  mask: StoryMask,
): { stepRows: S[]; layerRows: L[] } {
  return {
    stepRows: stepRows.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const f of mask.steps) out[f] = f === "kind" ? "media" : null;
      return out as S;
    }),
    layerRows: layerRows.map((row) => {
      const out: Record<string, unknown> = { ...row };
      for (const f of LAYER_FIELDS) if (mask.layers.has(`${row.layer_number}.${f}`)) out[f] = null;
      return out as L;
    }),
  };
}

/** Whether two sets of layer files hold the same names with the same text. */
export function sameLayerFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => Object.hasOwn(b, name) && b[name] === a[name]);
}
