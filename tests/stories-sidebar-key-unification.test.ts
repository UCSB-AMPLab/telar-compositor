/**
 * stories-sidebar-key-unification.test.ts — pins the three step-key sites in
 * the Story Editor that must all agree so a step's sidebar row, its nested
 * L1/L2 sub-rows, and its create-highlight land on the same row and stay put
 * across the snapshotToD1 id backfill.
 *
 * @version v1.4.1-beta
 *
 * The Story Editor once carried two competing step-keying conventions in one
 * file: the remote-delete detection keyed tempId-first (the shared `keyFor`),
 * while the sidebar row, the `layersByStep` map, and the create-highlight
 * effect keyed id-first (`id > 0 ? id : _tempId`). An id-first key flips the
 * moment `snapshotToD1` backfills a freshly-created step's real D1 id (id 0 ->
 * 42), so any observer that had recorded the pre-backfill key stopped matching
 * the post-backfill row. Concretely that left the create-highlight effect a
 * latent false-highlight (the backfilled step read as newly-arrived) and let
 * the layer sub-rows drift off their parent step at the backfill.
 *
 * These tests reproduce the three key computations exactly as the route now
 * runs them — all three call the shared tempId-first `keyFor` — and drive a
 * created step through its id backfill to prove: the sidebar row key is stable,
 * a `layersByStep` lookup keyed in the route still resolves from the sidebar
 * after the backfill, and the highlight effect sees no newly-arrived key when a
 * step is merely backfilled. The route module itself can't be imported here
 * (server-only deps in its import graph), the same constraint noted in
 * stories-active-step-remote-delete.
 */

import { describe, it, expect } from "vitest";
import { keyFor } from "~/lib/item-key";

interface StepRow {
  id: number;
  kind?: "media" | "section";
  _tempId?: string | null;
  _yIndex?: number;
}

interface LayerSummary {
  layer_number: number;
  button_label: string | null;
}

/**
 * Faithful copy of the route's `layersByStep` key derivation: skip section
 * cards, key every media step by the shared `keyFor`, and drop empty layer
 * lists. Mirrors the `useMemo` in `_app.stories.$storyId.tsx`.
 */
function buildLayersByStep(
  steps: StepRow[],
  layersFor: (step: StepRow) => LayerSummary[],
): Record<string, LayerSummary[]> {
  const map: Record<string, LayerSummary[]> = {};
  for (const s of steps) {
    if (s.kind === "section") continue;
    const key = keyFor(s);
    const summaries = layersFor(s);
    if (summaries.length > 0) map[key] = summaries;
  }
  return map;
}

/**
 * Faithful copy of the sidebar row's lookup: the row computes its own key with
 * the same shared `keyFor` and reads `layersByStep[key]`.
 */
function sidebarRowLayers(
  step: StepRow,
  layersByStep: Record<string, LayerSummary[]>,
): LayerSummary[] | undefined {
  return layersByStep[keyFor(step)];
}

/**
 * Faithful copy of the create-highlight effect's seen-key diff: on each render
 * it re-derives the key set with the shared `keyFor`, treats the first render
 * as a baseline, and highlights only keys not seen before.
 */
function makeHighlighter() {
  let seen = new Set<string>();
  let seeded = false;

  function render(steps: StepRow[]): string[] {
    const next = new Set<string>();
    const newly: string[] = [];
    for (const s of steps) {
      const k = keyFor(s);
      next.add(k);
      if (!seen.has(k)) newly.push(k);
    }
    if (!seeded) {
      seen = next;
      seeded = true;
      return [];
    }
    seen = next;
    return newly;
  }

  return { render };
}

describe("story editor sidebar/layers/highlight key unification", () => {
  it("keeps a step's sidebar row key stable across the id backfill", () => {
    const created: StepRow = { id: 0, _tempId: "uuid-A", _yIndex: 0 };
    const backfilled: StepRow = { id: 42, _tempId: "uuid-A", _yIndex: 0 };
    expect(keyFor(created)).toBe("uuid-A");
    expect(keyFor(backfilled)).toBe("uuid-A");
    expect(keyFor(created)).toBe(keyFor(backfilled));
  });

  it("resolves a layersByStep lookup from the sidebar after the backfill", () => {
    const created: StepRow = { id: 0, _tempId: "uuid-A", _yIndex: 0 };
    const layers: LayerSummary[] = [
      { layer_number: 1, button_label: "More" },
      { layer_number: 2, button_label: "Even more" },
    ];

    // The route builds the map while the step is still pre-backfill.
    const map = buildLayersByStep([created], () => layers);

    // After snapshotToD1 backfills the real id, the sidebar row re-derives its
    // key and must still find the same L1/L2 summaries.
    const backfilled: StepRow = { id: 42, _tempId: "uuid-A", _yIndex: 0 };
    const found = sidebarRowLayers(backfilled, map);
    expect(found).toBe(layers);
    expect(found?.map((l) => l.layer_number)).toEqual([1, 2]);
  });

  it("keys layers by id for steps loaded from D1 (no _tempId)", () => {
    const loaded: StepRow = { id: 7, _tempId: null, _yIndex: 0 };
    const layers: LayerSummary[] = [{ layer_number: 1, button_label: null }];
    const map = buildLayersByStep([loaded], () => layers);
    expect(map["7"]).toBe(layers);
    expect(sidebarRowLayers(loaded, map)).toBe(layers);
  });

  it("skips section cards when building layersByStep", () => {
    const section: StepRow = { id: 3, kind: "section", _tempId: null, _yIndex: 0 };
    const map = buildLayersByStep([section], () => [
      { layer_number: 1, button_label: "x" },
    ]);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it("does not re-highlight a step whose id is merely backfilled", () => {
    const hl = makeHighlighter();
    const created: StepRow = { id: 0, _tempId: "uuid-A", _yIndex: 0 };
    // First render seeds the baseline (no highlight on already-present rows).
    expect(hl.render([created])).toEqual([]);
    // The backfill render flips only the numeric id — tempId-first keying keeps
    // the key "uuid-A", so nothing reads as newly-arrived.
    const backfilled: StepRow = { id: 42, _tempId: "uuid-A", _yIndex: 0 };
    expect(hl.render([backfilled])).toEqual([]);
  });

  it("still highlights a genuinely new step", () => {
    const hl = makeHighlighter();
    const a: StepRow = { id: 1, _tempId: null, _yIndex: 0 };
    expect(hl.render([a])).toEqual([]);
    // A collaborator adds a new step: its key has not been seen, so it lights up.
    const b: StepRow = { id: 0, _tempId: "uuid-B", _yIndex: 1 };
    expect(hl.render([a, b])).toEqual(["uuid-B"]);
    // And on the new step's own backfill it must not light up a second time.
    const bBackfilled: StepRow = { id: 9, _tempId: "uuid-B", _yIndex: 1 };
    expect(hl.render([a, bBackfilled])).toEqual([]);
  });

  it("agrees across all three sites for the same step, before and after backfill", () => {
    const layers: LayerSummary[] = [{ layer_number: 1, button_label: "L1" }];

    for (const step of [
      { id: 0, _tempId: "uuid-A", _yIndex: 0 } as StepRow,
      { id: 42, _tempId: "uuid-A", _yIndex: 0 } as StepRow,
    ]) {
      const rowKey = keyFor(step);
      const map = buildLayersByStep([step], () => layers);
      const layerKey = Object.keys(map)[0];
      const hl = makeHighlighter();
      hl.render([{ id: 1, _tempId: null, _yIndex: 5 }]); // seed with an unrelated row
      const [highlightKey] = hl.render([
        { id: 1, _tempId: null, _yIndex: 5 },
        step,
      ]);
      expect(rowKey).toBe("uuid-A");
      expect(layerKey).toBe("uuid-A");
      expect(highlightKey).toBe("uuid-A");
    }
  });
});
