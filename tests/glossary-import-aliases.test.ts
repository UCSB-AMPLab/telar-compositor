/**
 * glossary.csv is read with the aliases only the glossary reads
 * (`GLOSSARY_COLUMN_ALIASES` in the framework's csv_utils.py): `tipo` is the
 * glossary's `kind`, a second header row naming it is a header row, and `Kind`
 * is the `kind` column. On any other sheet `tipo` stays the author's header.
 * Each case is also run through the framework's own `read_glossary_sheet`.
 *
 * @version v1.5.0-beta
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  CollidingColumnsRefusal,
  FRAMEWORK_GLOSSARY_COLUMN_RENAMES,
  FRAMEWORK_OBJECTS_READER,
  GLOSSARY_CANONICAL_SCOPE,
  checkGlossaryColumns,
  collidingHeaderGroups,
  OBJECTS_CANONICAL_SCOPE,
  createCsvRecordSkipDetector,
  isHeaderRow,
  mapGlossaryCsv,
  parseTelarCsv,
  positionalRow,
} from "~/lib/import.server";
import { GLOSSARY_COLUMN_ALIASES, foldHeader } from "~/lib/column-mapping";
import { runPrePublishValidation } from "~/lib/publish.server";
import {
  FRAMEWORK_PYTHON,
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  describeWithFramework,
} from "./helpers/framework-checkout";

const SPANISH_SECOND_ROW = "term_id,title,definition,kind\nid_termino,titulo,definicion,tipo\nt1,T1,D1,person\n";
const CAPITALISED = "term_id,title,definition,Kind\nt1,T1,D1,person\n";
const SPANISH_HEADER = "term_id,title,definition,tipo\nt1,T1,D1,person\n";

/** The terms an import stores, as `[term_id, its kind and extra_columns]`. */
function imported(csv: string): Array<[string, Record<string, string>]> {
  return mapGlossaryCsv(parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE)).map((term) => [
    term.term_id,
    { ...(term.kind ? { kind: term.kind } : {}), ...(JSON.parse(term.extra_columns ?? "{}") as Record<string, string>) },
  ]);
}

describe("the glossary import reads the glossary's own aliases", () => {
  it("drops a Spanish second header row holding `tipo`", () => {
    expect(imported(SPANISH_SECOND_ROW)).toEqual([["t1", { kind: "person" }]]);
  });

  it("drops that row without a warning, since every cell of it is a header word", () => {
    const warnings: unknown[] = [];
    parseTelarCsv(SPANISH_SECOND_ROW, (w) => warnings.push(w), false, GLOSSARY_CANONICAL_SCOPE);
    expect(warnings).toEqual([]);
  });

  it("reads a `Kind` column as `kind`", () => {
    expect(imported(CAPITALISED)).toEqual([["t1", { kind: "person" }]]);
  });

  it("reads a `tipo` column as `kind`", () => {
    expect(imported(SPANISH_HEADER)).toEqual([["t1", { kind: "person" }]]);
  });

  it("refuses a sheet whose `tipo` and `kind` both hold values, as the build refuses it", () => {
    const csv = "term_id,title,definition,tipo,kind\nt1,T1,D1,person,place\n";
    expect(() =>
      parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE, { severalHoldValues: "refuse", sheetName: "glossary.csv" }),
    ).toThrow(CollidingColumnsRefusal);
  });

  it("counts `tipo` as a header word on the glossary only", () => {
    const row = positionalRow(["id_termino", "titulo", "definicion", "tipo"]);
    expect(isHeaderRow(row)).toBe(false);
    expect(isHeaderRow(row, false, GLOSSARY_COLUMN_ALIASES)).toBe(true);
    const detector = createCsvRecordSkipDetector(false, [], GLOSSARY_COLUMN_ALIASES);
    expect(detector(["id_termino", "titulo", "definicion", "tipo"], 4)).toEqual({ skip: true, reason: "bilingual-header" });
  });

  it("leaves `tipo` as the author's header on the objects sheet", () => {
    const rows = parseTelarCsv("object_id,title,tipo\nm1,Map,chart\n", undefined, false, OBJECTS_CANONICAL_SCOPE);
    expect(rows).toEqual([{ object_id: "m1", title: "Map", tipo: "chart" }]);
  });
});

/** The glossary collision blockers a publish of terms carrying `extras` raises. */
function glossaryBlockers(extras: Record<string, string>) {
  const validation = runPrePublishValidation({
    headSha: "a",
    currentRepoHead: "a",
    stories: [],
    steps: [],
    pages: [],
    objects: [],
    glossary: [{ term_id: "t1", extra_columns: JSON.stringify(extras) }],
  });
  return validation.blockers.filter((b) => b.code === "glossary_colliding_columns");
}

describe("the glossary collision check and instruction columns", () => {
  it("does not block a publish of terms holding `#Note` and `#note`, which the reader removes first", () => {
    expect(glossaryBlockers({ "#Note": "a", "#note": "b" })).toEqual([]);
  });

  it("still blocks two columns that are not instruction columns", () => {
    expect(glossaryBlockers({ Note: "a", note: "b" })).toHaveLength(1);
  });
});

describe("the glossary collision check reads the glossary's own aliases", () => {
  it("blocks a publish of terms holding both `tipo` and `kind`", () => {
    const blockers = glossaryBlockers({ tipo: "person", kind: "place" });
    expect(blockers).toHaveLength(1);
    expect(blockers[0].params?.columns).toBe('"kind", "tipo"');
  });

  it("does not block `kind` alone", () => {
    expect(glossaryBlockers({ kind: "person" })).toEqual([]);
  });

  it("warns at the check of a sheet read with both", () => {
    const warnings: unknown[] = [];
    checkGlossaryColumns([{ term_id: "t1", title: "T1", tipo: "person", kind: "place" }], (w) => warnings.push(w));
    expect(warnings).toEqual([{ code: "folded_columns", groups: [["kind", "tipo"]] }]);
  });

  it("warns at the import of terms holding both", () => {
    const warnings: unknown[] = [];
    mapGlossaryCsv([{ term_id: "t1", title: "T1", tipo: "person", kind: "place" }], (w) => warnings.push(w));
    expect(warnings).toEqual([{ code: "folded_columns", groups: [["kind", "tipo"]] }]);
  });

  it("leaves `tipo` beside `kind` apart on the objects sheet, which reads no glossary alias", () => {
    expect(collidingHeaderGroups(["object_id", "tipo", "kind"], FRAMEWORK_OBJECTS_READER)).toEqual([]);
  });
});

/**
 * `read_glossary_sheet`'s columns and rows, or the name of the error it
 * raises, run in the test instance's own interpreter.
 */
function frameworkGlossarySheet(csv: string): { columns?: string[]; rows?: string[][]; error?: string } {
  const script = [
    "import sys, os, json, io, tempfile, contextlib",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "from telar.glossary import read_glossary_sheet",
    "d = tempfile.mkdtemp()",
    "path = os.path.join(d, 'glossary.csv')",
    "open(path, 'w', encoding='utf-8', newline='').write(sys.stdin.read())",
    "try:",
    "    with contextlib.redirect_stdout(io.StringIO()):",
    "        df = read_glossary_sheet(path)",
    "    out = {'columns': [str(c) for c in df.columns], 'rows': df.values.tolist()}",
    "except Exception as e:",
    "    out = {'error': type(e).__name__}",
    "print(json.dumps(out))",
  ].join("\n");
  const stdout = execFileSync(FRAMEWORK_PYTHON, ["-c", script], { input: csv, encoding: "utf-8" });
  return JSON.parse(stdout.trim().split("\n").at(-1) as string);
}

describeWithFramework("the glossary import against the framework's read_glossary_sheet", () => {
  it.each([
    ["a Spanish second header row holding `tipo`", SPANISH_SECOND_ROW],
    ["a `Kind` column", CAPITALISED],
    ["a `tipo` column", SPANISH_HEADER],
  ])("reads %s as the build does", (_, csv) => {
    const framework = frameworkGlossarySheet(csv);
    expect(framework.columns).toEqual(["term_id", "title", "definition", "kind"]);
    expect(framework.rows).toEqual([["t1", "T1", "D1", "person"]]);
    expect(imported(csv)).toEqual(framework.rows?.map(([id, , , kind]) => [id, { kind }]));
  }, FRAMEWORK_TIMEOUT_MS);

  it("predicts collisions with the table the glossary readers rename with", () => {
    const script = [
      "import sys, json",
      `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
      "import telar.csv_utils as cu",
      "print(json.dumps({**cu.COLUMN_NAME_MAPPING, **cu.GLOSSARY_COLUMN_ALIASES}))",
    ].join("\n");
    const framework = JSON.parse(execFileSync(FRAMEWORK_PYTHON, ["-c", script], { encoding: "utf-8" }));
    expect({ ...FRAMEWORK_GLOSSARY_COLUMN_RENAMES }).toEqual(framework);
  }, FRAMEWORK_TIMEOUT_MS);

  it("refuses `tipo` beside `kind` as the build does", () => {
    const csv = "term_id,title,definition,tipo,kind\nt1,T1,D1,person,place\n";
    expect(frameworkGlossarySheet(csv).error).toBe("ColumnCollisionError");
    expect(glossaryBlockers({ tipo: "person", kind: "place" })).toHaveLength(1);
    expect(() =>
      parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE, { severalHoldValues: "refuse" }),
    ).toThrow(CollidingColumnsRefusal);
  }, FRAMEWORK_TIMEOUT_MS);
});

/**
 * The framework reads every glossary header folded: stripped and lower-cased
 * after the renames (`df.columns.str.lower().str.strip()` in
 * `read_glossary_sheet`), and refuses two headers that fold to one name. The
 * Compositor keeps an author's own spelling for a custom column, so it holds
 * `Notes` where the build holds `notes`; nothing in the Compositor reads a
 * glossary custom column by name, so the spelling is not acted on. What has to
 * agree is which sheets are refused, and that the folded names are the same.
 */
const CUSTOM_HEADER_SHEETS: Array<[string, string]> = [
  ["a capitalised custom column", "term_id,title,definition,Notes,Extra\nt1,T1,D1,a,b\n"],
  ["a padded custom column", "term_id,title,definition, Notes \nt1,T1,D1,a\n"],
];
const CASE_ONLY_COLLISIONS: Array<[string, string, Record<string, string>]> = [
  ["Notes beside notes", "term_id,title,definition,Notes,notes\nt1,T1,D1,a,b\n", { Notes: "a", notes: "b" }],
  ["padded Notes beside NOTES", "term_id,title,definition, Notes ,NOTES\nt1,T1,D1,a,b\n", { " Notes ": "a", NOTES: "b" }],
];

describeWithFramework("glossary custom column headers against the framework's fold", () => {
  it.each(CUSTOM_HEADER_SHEETS)("holds %s under the name the build folds it to", (_, csv) => {
    const framework = frameworkGlossarySheet(csv);
    const [term] = mapGlossaryCsv(parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE));
    const kept = Object.keys(JSON.parse(term.extra_columns ?? "{}") as Record<string, string>).map(foldHeader);
    expect(framework.columns?.slice(3).sort()).toEqual(kept.sort());
  }, FRAMEWORK_TIMEOUT_MS);

  it.each(CASE_ONLY_COLLISIONS)("refuses %s as the build does, and warns and blocks likewise", (_, csv, extras) => {
    expect(frameworkGlossarySheet(csv).error).toBe("ColumnCollisionError");
    const warnings: Array<{ code: string }> = [];
    mapGlossaryCsv(parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE), (w) => warnings.push(w));
    expect(warnings.map((w) => w.code)).toContain("folded_columns");
    expect(glossaryBlockers(extras)).toHaveLength(1);
  }, FRAMEWORK_TIMEOUT_MS);

  it("accepts columns that differ in more than case, in both", () => {
    const csv = "term_id,title,definition,Notes,Notes2\nt1,T1,D1,a,b\n";
    expect(frameworkGlossarySheet(csv).error).toBeUndefined();
    const warnings: Array<{ code: string }> = [];
    mapGlossaryCsv(parseTelarCsv(csv, undefined, false, GLOSSARY_CANONICAL_SCOPE), (w) => warnings.push(w));
    expect(warnings).toEqual([]);
    expect(glossaryBlockers({ Notes: "a", Notes2: "b" })).toEqual([]);
  }, FRAMEWORK_TIMEOUT_MS);
});
