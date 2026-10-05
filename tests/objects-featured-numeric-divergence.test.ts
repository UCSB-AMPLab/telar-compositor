/**
 * Pins the one known divergence between the Compositor's `featured` read and
 * the framework's own: the framework applies its explicit-feature mask to
 * `df['featured'].astype(str)` of a column pandas has already type-inferred
 * from the raw CSV text (`telar.core.csv_to_json`'s
 * `pd.read_csv(csv_path, on_bad_lines='warn')`, no `dtype` argument), and the
 * Compositor has no such column to infer — it reads the cell's text
 * directly. See `FEATURED_TRUTHY`'s docstring in `app/lib/import.server.ts`
 * for the two divergent cases in prose; this file drives pandas' real read
 * to show they hold.
 *
 * What diverges is the mask that decides whether a row is an EXPLICIT
 * feature request, not the site's final `is_featured_sample` verdict: when
 * the mask matches nothing at all, `_select_featured_objects` falls through
 * to a sample of the rows whose `object_warning` value strips to an empty
 * string, and a row the mask missed can still come out featured there. The
 * fixtures below cannot show that happening and are not meant to — they
 * carry no `object_warning` column, which the sample requires — and the
 * sample is not a contract the Compositor mirrors either way. This suite
 * asserts the mask alone, and is titled for the mask.
 *
 * The divergence needs pandas to read the cell as a number. Dtype is
 * settled at read time, before `telar/core.py` drops the bilingual row, so
 * one cell pandas takes as text — most often that row's `destacado`, which
 * the template ships — is enough to keep an ordinary sheet's column textual
 * and leave the two sides agreeing. The bilingual case below is that
 * counterexample, the same bare `1` next to an empty cell with a bilingual
 * row ahead of it.
 *
 * Two things narrow that reprieve. A cell holding one of pandas' default
 * missing-value tokens (`NA`, `null` and the rest) is not text for this
 * purpose and leaves the column numeric, which the last case below pins.
 * And a file with enough records to fill pandas' parser buffer is inferred
 * a chunk at a time — the buffer counts records, sized by the column count,
 * not bytes — so a chunk holding no text reads its own digits as numbers
 * even where the column overall is textual. Which numbers is not fixed
 * either: a chunk of bare integers gives integers, while a missing or
 * decimal value in the same chunk gives floats, and `1` and `1.0` fall on
 * opposite sides of the framework's whitelist. That case needs tens of
 * thousands of rows and is not fixture material here.
 *
 * This is NOT a parity test: the two sides are expected to disagree here.
 * `tests/objects-featured-parity.test.ts` is what has to hold to hold.
 *
 * @version v1.5.0-beta
 */

import { execFileSync } from "node:child_process";
import { it, expect } from "vitest";

import { pythonStrip } from "~/lib/column-mapping";
import { FEATURED_TRUTHY } from "~/lib/import.server";
import { describeWithPythonPandas, FRAMEWORK_TIMEOUT_MS } from "./helpers/framework-checkout";

/** The Compositor's own read, off the cell's raw text. */
function compositorFeatured(cell: string): boolean {
  return FEATURED_TRUTHY.has(pythonStrip(cell).toLowerCase());
}

/**
 * The framework's explicit-feature mask over an `object_id,featured` CSV
 * built from `rows` in order, computed the way
 * `telar.processors.objects.featured._select_featured_objects` computes it,
 * fed by the read `telar.core.csv_to_json` performs: `pd.read_csv` with no
 * `dtype` argument, so the column's type is whatever pandas infers from
 * every row given. Returns the mask in the same order as `rows`.
 *
 * No bilingual-row drop is simulated here: dtype is locked in at read time,
 * before `telar/core.py` would drop that row, and slicing a frame does not
 * change a column's already-inferred dtype — so the mask over the rows that
 * survive the drop is the same whether the drop is modelled or not. A
 * caller wanting the bilingual case includes that row in `rows` and reads
 * the mask at the surviving rows' positions.
 *
 * `timeout` bounds the child directly, the same reason
 * `driveFrameworkSelector` does: Vitest's own per-test timeout cannot reach
 * inside a blocked `execFileSync` call.
 */
function frameworkFeaturedMask(rows: string[]): boolean[] {
  const csv = `object_id,featured\n${rows.map((r, i) => `o${i + 1},${r}`).join("\n")}\n`;
  const script = [
    "import io, json, sys",
    "import pandas as pd",
    "df = pd.read_csv(io.StringIO(sys.stdin.read()))",
    "featured_values = {'yes', 'true', 'si', 'sí', '1'}",
    "mask = df['featured'].astype(str).str.lower().str.strip().isin(featured_values)",
    "print(json.dumps(mask.tolist()))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", script], {
    input: csv,
    encoding: "utf-8",
    timeout: FRAMEWORK_TIMEOUT_MS,
  });
  return JSON.parse(out.trim()) as boolean[];
}

/** The mask for the first of two rows — the shape most of these cases need. */
function frameworkFeaturedFirstRow(firstRow: string, secondRow: string): boolean {
  return frameworkFeaturedMask([firstRow, secondRow])[0];
}

describeWithPythonPandas(
  "featured: the explicit-feature mask diverges under dtype inference, not the site's final verdict — and only where pandas reads the cell as a number",
  () => {
    it("a bare 1 sharing a column with an empty cell: the framework's mask does not count it as an explicit feature request, the Compositor says featured", () => {
      expect(frameworkFeaturedFirstRow("1", "")).toBe(false);
      expect(compositorFeatured("1")).toBe(true);
    }, FRAMEWORK_TIMEOUT_MS);

    it("a leading-zero 01 sharing a column with a 0: the framework's mask says featured, the Compositor says not featured", () => {
      expect(frameworkFeaturedFirstRow("01", "0")).toBe(true);
      expect(compositorFeatured("01")).toBe(false);
    }, FRAMEWORK_TIMEOUT_MS);

    it("agrees when the featured column holds text, not a bare number", () => {
      expect(frameworkFeaturedFirstRow("sí", "no")).toBe(true);
      expect(compositorFeatured("sí")).toBe(true);
    }, FRAMEWORK_TIMEOUT_MS);

    it("agrees on the same bare 1 next to an empty cell once a bilingual row keeps the column textual", () => {
      const mask = frameworkFeaturedMask(["destacado", "1", ""]);
      expect(mask[1]).toBe(true);
      expect(compositorFeatured("1")).toBe(true);
    }, FRAMEWORK_TIMEOUT_MS);

    // The limit of that reprieve: pandas reads NA as a missing value, not as
    // text, so the column stays numeric and the bare 1 diverges again. Pinned
    // because the docstring's "one text cell is enough" would otherwise be
    // read as covering every non-numeric spelling.
    it("still diverges when the only non-numeric cell is one pandas reads as missing", () => {
      const mask = frameworkFeaturedMask(["NA", "1", ""]);
      expect(mask[1]).toBe(false);
      expect(compositorFeatured("1")).toBe(true);
    }, FRAMEWORK_TIMEOUT_MS);
  },
);
