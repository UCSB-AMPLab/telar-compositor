/**
 * The published objects.csv, read by the framework that will build it.
 *
 * Counting `medium_genre` headers in the output cannot detect the defect this
 * guards: under the bug the second column is spelled `medium`, so there is
 * still exactly one literal `medium_genre` and the count passes. The only
 * check that distinguishes them is the framework's own — run the file through
 * `normalize_column_names` and see whether `_refuse_colliding_renames` and
 * `_refuse_reserved_columns` accept it.
 *
 * Bound to the test instance for the reason given in
 * tests/objects-field-derivation.test.ts, and fails loudly when that checkout
 * is absent rather than skipping.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

import { serializeObjectsCsv } from "~/lib/csv-export.server";
import { OBJECTS_CANONICAL_SCOPE, mapObjectsCsv, parseTelarCsv } from "~/lib/import.server";

import { FRAMEWORK_DIR_ENV, FRAMEWORK_SCRIPTS_DIR, frameworkCheckoutPresent } from "./helpers/framework-checkout";

/**
 * Parity with the framework is checked on a machine that has a framework
 * checkout named in TELAR_FRAMEWORK_DIR; CI has none, and proves the Compositor alone. Skipped rather than
 * failed there, with the reason in the title so the skip is visible in the
 * run — a local run stays strict, because locally the checkout is present.
 */
const FRAMEWORK_PRESENT = frameworkCheckoutPresent;
const WHEN_PRESENT = FRAMEWORK_PRESENT
  ? ""
  : ` [skipped: no framework checkout (${FRAMEWORK_DIR_ENV} unset or not a checkout)]`;


interface FrameworkVerdict {
  ok: boolean;
  error?: string;
  message?: string;
  columns?: string[];
  records?: Record<string, string>[];
}

/**
 * Reads a CSV the way the build does: pandas for the file, the framework's own
 * normalisation scoped to OBJECT_FIELDS, and both of its refusals.
 */
function readAsFramework(csv: string): FrameworkVerdict {
  const script = [
    "import sys, io, json",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "import pandas as pd",
    "from telar.csv_utils import normalize_column_names, is_header_row, OBJECT_FIELDS",
    "raw = sys.stdin.buffer.read().decode('utf-8')",
    "df = pd.read_csv(io.StringIO(raw), dtype=str).fillna('')",
    // Exactly what telar/core.py does before normalising: drop the comment
    // rows, then the bilingual second row. Without this the bilingual row is
    // read as an object and every record index is off by one.
    "first = df.columns[0]",
    "df = df[~df[first].astype(str).str.strip().str.startswith('#')]",
    "df = df[[c for c in df.columns if not str(c).startswith('#')]]",
    "if len(df) > 0 and is_header_row(df.iloc[0].values):",
    "    df = df.iloc[1:].reset_index(drop=True)",
    "try:",
    "    out = normalize_column_names(df, OBJECT_FIELDS)",
    "except Exception as e:",
    "    print(json.dumps({'ok': False, 'error': type(e).__name__, 'message': str(e)}))",
    "else:",
    "    print(json.dumps({'ok': True, 'columns': [str(c) for c in out.columns],",
    "                      'records': out.to_dict('records')}))",
  ].join("\n");
  const out = execFileSync("python3", ["-c", script], { input: csv, encoding: "utf-8" });
  // The framework logs its renames to stdout ("[INFO] Normalized column ..."),
  // so the verdict is the last line, not the whole stream.
  const lines = out.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as FrameworkVerdict;
}

const base = {
  object_id: "o1",
  title: "A",
  featured: false,
  creator: null,
  description: null,
  source_url: null,
  period: null,
  year: null,
  medium_genre: "editor value",
  subjects: null,
  source: null,
  credit: "editor credit",
  thumbnail: null,
  alt_text: null,
  dimensions: null,
};

/** The blob shapes a site imported before the mapping modelled them still holds. */
const staleBlobs: Array<[string, string]> = [
  ["medium", JSON.stringify({ medium: "stale medium" })],
  ["crédito", JSON.stringify({ "crédito": "stale credit" })],
  ["iiif_manifest", JSON.stringify({ iiif_manifest: "https://example.org/m.json" })],
  ["medium_genre under its own name", JSON.stringify({ medium_genre: "stale exact" })],
  ["a differently-cased key", JSON.stringify({ Medium_Genre: "stale cased" })],
  ["every spelling at once", JSON.stringify({
    medium: "a", medio: "b", tipo_objeto: "c", object_type: "d", "crédito": "e",
  })],
];

describe.skipIf(!FRAMEWORK_PRESENT)(`published objects.csv, as the framework reads it${WHEN_PRESENT}`, () => {
  it.each(staleBlobs)("is accepted when a blob still carries %s", (_label, blob) => {
    const csv = serializeObjectsCsv([{ ...base, extra_columns: blob }] as never);
    const verdict = readAsFramework(csv);
    expect(verdict.error ?? "", verdict.message ?? "").toBe("");
    expect(verdict.ok).toBe(true);
  });

  it("publishes the editor's value, never the blob's", () => {
    const csv = serializeObjectsCsv([
      { ...base, extra_columns: JSON.stringify({ medium: "stale", "crédito": "stale credit" }) },
    ] as never);
    const verdict = readAsFramework(csv);
    expect(verdict.ok).toBe(true);
    expect(verdict.records?.[0].medium).toBe("editor value");
    expect(verdict.records?.[0].credit).toBe("editor credit");
  });

  it("still carries a column the author invented", () => {
    const csv = serializeObjectsCsv([
      { ...base, extra_columns: JSON.stringify({ provenance: "mine" }) },
    ] as never);
    const verdict = readAsFramework(csv);
    expect(verdict.ok).toBe(true);
    expect(verdict.columns).toContain("provenance");
    expect(verdict.records?.[0].provenance).toBe("mine");
  });

  it("gives a row with no blob an empty cell, not an inherited property", () => {
    const csv = serializeObjectsCsv([
      // A literal JSON string, not an object literal: `{"__proto__": "x"}` in
      // JS sets the prototype instead of a key, so the branch would pass with
      // the very column it exists to test silently absent.
      { ...base, extra_columns: '{"__proto__":"x","constructor":"y","toString":"z"}' },
      { ...base, object_id: "o2", extra_columns: null },
    ] as never);
    const verdict = readAsFramework(csv);
    expect(verdict.ok).toBe(true);
    // Read OWN properties throughout: `row["__proto__"]` answers with the
    // prototype rather than the cell, and would hide the thing under test.
    const cellOf = (row: Record<string, string>, key: string) =>
      Object.getOwnPropertyDescriptor(row, key)?.value;

    // The row that HAS the blob keeps every value: these are the author's own
    // columns, however hostile their names, and nothing may drop them.
    const first = verdict.records?.[0] ?? {};
    expect(cellOf(first, "__proto__"), 'column "__proto__" of the row with the blob').toBe("x");
    expect(cellOf(first, "constructor"), 'column "constructor"').toBe("y");
    expect(cellOf(first, "toString"), 'column "toString"').toBe("z");

    // The row that has none gets empty cells, not inherited properties.
    const second = verdict.records?.[1] ?? {};
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(cellOf(second, key) ?? "", `column "${key}" of the row with no blob`).toBe("");
    }
  });

  // The guard against the check itself going quiet: the framework must still
  // refuse a file that really does carry two columns for one canonical name.
  it("refuses a file whose two headers resolve to one canonical name", () => {
    const verdict = readAsFramework("object_id,medium_genre,medium\no1,editor,stale\n");
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toBe("ColumnCollisionError");
  });

  // pandas keeps `title` and ` title ` as two columns and the framework refuses
  // the source; the import keeps the one with values, so the published file
  // has one `title` column holding it.
  it("publishes one title column from a source with title beside a spaced title", () => {
    const source = "object_id,title, title \no1,,Kept\n";
    expect(readAsFramework(source).error).toBe("ColumnCollisionError");
    const [imported] = mapObjectsCsv(parseTelarCsv(source, undefined, false, OBJECTS_CANONICAL_SCOPE));
    const csv = serializeObjectsCsv([
      { ...base, title: imported.title ?? null, medium_genre: null, credit: null, extra_columns: imported.extra_columns ?? null },
    ] as never);
    const verdict = readAsFramework(csv);
    expect(verdict.ok).toBe(true);
    expect(verdict.columns?.filter((c) => c.startsWith("title"))).toEqual(["title"]);
    expect(verdict.records?.[0].title).toBe("Kept");
  });
});
