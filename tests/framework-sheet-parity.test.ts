/**
 * The ports the 1.8.0 sheet repair rests on, run against the framework's own
 * Python over seeded random input: CPython's `csv.reader`, the repair's byte
 * splitter, pandas' column labels, the bilingual header-row rule and the
 * constants they read.
 *
 * Each random text is drawn from the characters that decide how a sheet is
 * read: the delimiter, the quote, both line-ending characters, a space, a tab,
 * the comment mark, a NUL and a byte-order mark, beside one ordinary letter.
 * One interpreter answers a whole batch, and every assertion names its seed
 * and text, so a failure reproduces from the message.
 *
 * Needs the framework checkout and its `.venv` (pandas 3.0.5); skips visibly
 * without it, or fails with TELAR_PARITY_REQUIRED=1.
 *
 * @version v1.5.0-beta
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { foldHeader } from "~/lib/column-mapping";
import { RESERVED_COLUMN_NAMES } from "~/lib/extra-columns.server";
import {
  FRAMEWORK_GLOSSARY_COLUMN_ALIASES,
  FrameworkSheetUnreadableError,
  GLOSSARY_SHEETS,
  OBJECTS_SHEETS,
  PROJECT_SHEETS,
  SPREADSHEETS_DIR,
  frameworkIsHeaderRow,
  pandasLabels,
  pythonLower,
  readFrameworkSheet,
  splitRecords,
} from "~/lib/framework-sheet.server";
import { ONCE_PUBLISHED_HEADER_TOKENS } from "~/lib/import.server";
import { pythonCsvRows } from "~/lib/python-csv";
import { PINNED_TEXT_HEADERS, repairSheet, type ColumnChoice, type SheetRole } from "~/lib/sheet-collision-repair.server";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_PYTHON,
  FRAMEWORK_TIMEOUT_MS,
  describeWithRequiredFramework,
  frameworkCsvToJson,
} from "./helpers/framework-checkout";

/** mulberry32, so a failing case is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", ",", '"', "\r", "\n", " ", "\t", "#", "\u0000", "﻿"];

/** The same characters with header words among them, so that repeated and suffixed labels arise. */
const WORDS = [...ALPHABET, "a.1", "a.2", "Unnamed: 0", "Unnamed: 1", "b", "B"];

function randomText(random: () => number, maxLength: number, alphabet: readonly string[] = ALPHABET): string {
  const length = Math.floor(random() * (maxLength + 1));
  let text = "";
  for (let i = 0; i < length; i += 1) text += alphabet[Math.floor(random() * alphabet.length)];
  return text;
}

/**
 * Runs `body` in one framework interpreter with `data` as `inp`, and returns
 * what it assigned to `out`. `migrations.v180_sheets` is imported as `vs` and
 * `telar.csv_utils` as `cu`.
 */
function framework<T>(body: string, data: unknown): T {
  const script = [
    "import sys, io, csv, json",
    `sys.path.insert(0, ${JSON.stringify(FRAMEWORK_SCRIPTS_DIR)})`,
    "from migrations import v180_sheets as vs",
    "import telar.csv_utils as cu",
    "inp = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
    "out = None",
    body,
    "sys.stdout.buffer.write(json.dumps(out).encode('utf-8'))",
  ].join("\n");
  const stdout = execFileSync(FRAMEWORK_PYTHON, ["-c", script], {
    input: JSON.stringify(data),
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(stdout.toString("utf-8")) as T;
}

const FUZZ_COUNT = 5000;

describeWithRequiredFramework("the 1.8.0 sheet readers against the framework's Python", () => {
  it("pythonCsvRows reads every random text as csv.reader does", () => {
    const random = seeded(0x514b01);
    const texts = Array.from({ length: FUZZ_COUNT }, () => randomText(random, 40));
    const expected = framework<string[][][]>(
      "with vs._field_limit_lifted():\n" +
        "    out = [list(csv.reader(io.StringIO(t, newline=''))) for t in inp]",
      texts,
    );
    expect(expected).toHaveLength(texts.length);
    texts.forEach((text, i) => {
      expect(pythonCsvRows(text), `seed 0x514b01, case ${i}: ${JSON.stringify(text)}`).toEqual(expected[i]);
    });
  }, FRAMEWORK_TIMEOUT_MS);

  it("splitRecords splits every random text as split_records does, or refuses it as it does", () => {
    const random = seeded(0x514b02);
    const texts = Array.from({ length: FUZZ_COUNT }, () => randomText(random, 40));
    const expected = framework<([string[], string][] | null)[]>("out = [vs.split_records(t) for t in inp]", texts);
    expect(expected).toHaveLength(texts.length);
    let split = 0;
    texts.forEach((text, i) => {
      const records = splitRecords(text);
      if (records) split += 1;
      expect(
        records?.map((r) => [r.fields, r.ending]) ?? null,
        `seed 0x514b02, case ${i}: ${JSON.stringify(text)}`,
      ).toEqual(expected[i]);
    });
    // Both outcomes are exercised, or the comparison proves half of the rule.
    expect(split).toBeGreaterThan(FUZZ_COUNT / 10);
    expect(split).toBeLessThan(FUZZ_COUNT - FUZZ_COUNT / 10);
  }, FRAMEWORK_TIMEOUT_MS);

  it("readFrameworkSheet reads every random text as Sheet does, or refuses it as it does", () => {
    const random = seeded(0x514b03);
    const texts = Array.from({ length: FUZZ_COUNT }, (_, i) => randomText(random, 40, i % 2 ? WORDS : ALPHABET));
    type Reading =
      | { error: string }
      | { bom: boolean; rows: string[][]; records: [string[], string][] | null; skipped: boolean[]; header_at: number; labels: string[] };
    const expected = framework<Reading[]>(
      [
        "out = []",
        "for t in inp:",
        "    try:",
        "        s = vs.Sheet('x.csv', t)",
        "    except (csv.Error, ValueError) as e:",
        "        out.append({'error': type(e).__name__})",
        "        continue",
        "    out.append({'bom': s.bom, 'rows': s.rows, 'records': s.records, 'skipped': s.skipped,",
        "                'header_at': s.header_at, 'labels': s.labels})",
      ].join("\n"),
      texts,
    );
    expect(expected).toHaveLength(texts.length);
    let refused = 0;
    texts.forEach((text, i) => {
      const where = `seed 0x514b03, case ${i}: ${JSON.stringify(text)}`;
      const want = expected[i];
      let sheet;
      try {
        sheet = readFrameworkSheet(text);
      } catch (error) {
        expect(error, where).toBeInstanceOf(FrameworkSheetUnreadableError);
        expect(want, where).toHaveProperty("error");
        refused += 1;
        return;
      }
      expect(want, where).not.toHaveProperty("error");
      expect(
        {
          bom: sheet.bom,
          rows: sheet.rows,
          records: sheet.records?.map((r) => [r.fields, r.ending]) ?? null,
          skipped: sheet.skipped,
          header_at: sheet.headerAt,
          labels: sheet.labels,
        },
        where,
      ).toEqual(want);
    });
    expect(refused).toBeGreaterThan(0);
  }, FRAMEWORK_TIMEOUT_MS);

  it("pandasLabels labels every random header as pandas_labels does", () => {
    const random = seeded(0x514b04);
    const words = ["a", "a.1", "a.2", "a.1.1", "b", "", "Unnamed: 1", "Unnamed: 0", "Unnamed: 1.1", "a\u0000x", "\u0000", "#a", " a"];
    const headers = Array.from({ length: FUZZ_COUNT }, () =>
      Array.from({ length: 1 + Math.floor(random() * 7) }, () => words[Math.floor(random() * words.length)]),
    );
    const expected = framework<(string[] | { error: string })[]>(
      [
        "out = []",
        "for h in inp:",
        "    try:",
        "        out.append(vs.pandas_labels(h))",
        "    except ValueError as e:",
        "        out.append({'error': type(e).__name__})",
      ].join("\n"),
      headers,
    );
    expect(expected).toHaveLength(headers.length);
    headers.forEach((header, i) => {
      const where = `seed 0x514b04, case ${i}: ${JSON.stringify(header)}`;
      let labels: string[] | { error: string };
      try {
        labels = pandasLabels(header);
      } catch {
        labels = { error: "ValueError" };
      }
      expect(labels, where).toEqual(expected[i]);
    });
  }, FRAMEWORK_TIMEOUT_MS);

  it("frameworkIsHeaderRow judges every random row as is_header_row does, with and without the glossary's aliases", () => {
    const random = seeded(0x514b05);
    const words = [
      "step", "paso", "Objeto", " answer ", "x", "zoom", "tipo", "kind", "quoted_in_stories", "", "  ", "\t",
      "note", "Note", "value", "1", "id_término", "definición", "PRIVADO", "medium_genre",
    ];
    const rows = Array.from({ length: FUZZ_COUNT }, () =>
      Array.from({ length: Math.floor(random() * 7) }, () => words[Math.floor(random() * words.length)]),
    );
    const expected = framework<[boolean, boolean][]>(
      "out = [[bool(cu.is_header_row(r)), bool(cu.is_header_row(r, sheet_aliases=cu.GLOSSARY_COLUMN_ALIASES))] for r in inp]",
      rows,
    );
    expect(expected).toHaveLength(rows.length);
    rows.forEach((row, i) => {
      expect(
        [frameworkIsHeaderRow(row), frameworkIsHeaderRow(row, FRAMEWORK_GLOSSARY_COLUMN_ALIASES)],
        `seed 0x514b05, case ${i}: ${JSON.stringify(row)}`,
      ).toEqual(expected[i]);
    });
  }, FRAMEWORK_TIMEOUT_MS);

  it("pythonLower lowers as the venv's Python 3.14 does, except where Unicode 15 and 16 added a lowercase", () => {
    // The venv carries Unicode 16 and the build's Python 3.11 Unicode 14, so
    // the two part exactly on the mappings Unicode 15 and 16 added; pinned, so
    // a move on either side is seen.
    const differing = lowerDifferences(
      framework<Record<string, string>>(`out = ${LOWER_TABLE}`, null),
    );
    const named = ["1C89", "A7CB", "A7CC", "A7DA", "A7DC"];
    for (let cp = 0x10d50; cp <= 0x10d65; cp += 1) named.push(cp.toString(16).toUpperCase());
    expect(differing).toEqual(named);
  }, FRAMEWORK_TIMEOUT_MS);

  describe("a sheet repaired with the author's choice converts under the framework and publishes the kept column", () => {
    const repaired = (name: string, text: string, role: SheetRole, choices: ColumnChoice[]) => {
      const result = repairSheet({ path: `${SPREADSHEETS_DIR}/${name}`, text, role, choices });
      if (result.kind !== "repaired") throw new Error(`expected a repair, got ${result.kind}`);
      return result.text;
    };

    it("objects: object_type kept over medium", () => {
      const text = repaired("objects.csv", "object_id,title,medium,object_type\nm1,A,Ink,Paper\nm2,B,Oil,\n", "objects", [
        { positions: [2, 3], keep: 3 },
      ]);
      const converted = frameworkCsvToJson(text, "objects");
      expect(converted.ok, converted.log).toBe(true);
      expect(converted.rows.map((r) => [r.object_id, r.medium])).toEqual([["m1", "Paper"], ["m2", null]]);
    }, FRAMEWORK_TIMEOUT_MS);

    it("story: Note kept over note", () => {
      const text = repaired("s.csv", "step,object,question,answer,note,Note\n1,map-1,Q?,A.,x,y\n", "story", [
        { positions: [4, 5], keep: 5 },
      ]);
      const converted = frameworkCsvToJson(text, "story");
      expect(converted.ok, converted.log).toBe(true);
      expect(converted.rows.map((r) => r.Note)).toEqual(["y"]);
    }, FRAMEWORK_TIMEOUT_MS);

    it("story: a first column holding values, marked so the step stays", () => {
      const text = repaired("s.csv", "note,Note,step,answer\nv,#kept,1,Here.\n", "story", [{ positions: [0, 1], keep: 1 }]);
      expect(text).toBe("#note,Note,step,answer\nv,#kept,1,Here.\n");
      const converted = frameworkCsvToJson(text, "story");
      expect(converted.ok, converted.log).toBe(true);
      expect(converted.rows.map((r) => [r.step, r.Note, "note" in r || "#note" in r])).toEqual([[1, "#kept", false]]);
    }, FRAMEWORK_TIMEOUT_MS);

    it("glossary: tipo kept over kind", () => {
      const text = repaired("glossary.csv", "term_id,title,definition,kind,tipo\nx,X,D,term,source\n", "glossary", [
        { positions: [3, 4], keep: 4 },
      ]);
      const kinds = framework<string[]>(
        [
          "import contextlib, pandas as pd",
          "df = pd.read_csv(io.StringIO(inp, newline=''), dtype=str, keep_default_na=False)",
          "with contextlib.redirect_stdout(io.StringIO()):",
          "    out = list(cu.normalize_column_names(df, sheet_aliases=cu.GLOSSARY_COLUMN_ALIASES)['kind'])",
        ].join("\n"),
        text,
      );
      expect(kinds).toEqual(["source"]);
    }, FRAMEWORK_TIMEOUT_MS);
  });

  describe("the second header row is deleted only where the framework publishes every surviving cell as before", () => {
    // The reference is the same sheet with the colliding column renamed to a name nothing else claims,
    // which the framework converts while it still sees the second header row. pandas types a column from
    // every cell it reads, the second header row's words included, so deleting the row can change what a
    // column publishes. Compared is the text the framework publishes for each cell (`str()` of the value:
    // 1 and "1" are alike, 1.0 is not), not the types.
    const LATER = (rows: string[]) =>
      `step,answer,object,note,Note,extra\npaso,respuesta,objeto,pregunta,,libre\n${rows.map((r) => `${r}\n`).join("")}`;
    const FIRST = (rows: string[]) =>
      `note,Note,step,answer,object,extra\npregunta,,paso,respuesta,objeto,libre\n${rows.map((r) => `${r}\n`).join("")}`;
    const renamed = (text: string) => text.replace(/(^|,)note,/, "$1aside,");
    /** The sheet with the column and the second header row deleted, as a repair that ignored the types would leave it. */
    const naive = (text: string) => {
      const column = text.split("\n")[0].split(",").indexOf("note");
      return text
        .split("\n")
        .filter((_, r) => r !== 1)
        .map((line) => line.split(",").filter((_, i) => i !== column).join(","))
        .join("\n");
    };
    const without = (row: Record<string, string>) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "aside"));
    const repair = (text: string) => repairSheet({ path: `${SPREADSHEETS_DIR}/s.csv`, text, role: "story" });

    const REPAIRED: [string, string][] = [
      ["a later column, with a step of 1, 2, 3", LATER(["1,Here.,map-1,,x,e", "2,There.,map-2,,y,f", "3,Now.,map-3,,z,g"])],
      ["the first column, with a step of 1, 2", FIRST([",x,1,Here.,map-1,e", ",y,2,There.,map-2,f"])],
      ["a decimal that publishes as written", LATER(["1.5,Here.,map-1,,x,e", "2.25,There.,map-2,,y,f"])],
      ["a step of 0 and an object of 001, which the framework reads as text", LATER(["0,Here.,001,,x,e"])],
    ];
    const STOPPED: [string, string][] = [
      ["a zero-padded answer", LATER(["1,001,map-1,,x,e"])],
      ["a step 1 beside 1.5", LATER(["1,Here.,map-1,,x,e", "1.5,There.,map-2,,y,f"])],
      ["a trailing zero", LATER(["1.50,Here.,map-1,,x,e"])],
      ["numbers with an empty cell: the build reads only an empty cell as missing, so they are floats", LATER(["1,Here.,map-1,,x,e", ",There.,map-2,,y,f", "3,Now.,map-3,,z,g"])],
    ];

    it.each(REPAIRED)("repaired, publishing the same text: %s", (_label, text) => {
      const result = repair(text);
      if (result.kind !== "repaired") throw new Error(`expected a repair, got ${result.kind}`);
      const repaired = frameworkCsvToJson(result.text, "story");
      const before = frameworkCsvToJson(renamed(text), "story");
      expect(repaired.ok, repaired.log).toBe(true);
      expect(before.ok, before.log).toBe(true);
      expect(before.published.length).toBe(repaired.published.length);
      expect(repaired.published).toEqual(before.published.map(without));
      if (text.includes(",001,")) expect(repaired.published.map((row) => row.object)).toEqual(["001"]);
    }, FRAMEWORK_TIMEOUT_MS);

    it("the headers the repair exempts are the ones the framework pins to text", () => {
      const pinned = framework<string[]>("out = sorted(cu.text_column_dtypes())", null);
      expect([...PINNED_TEXT_HEADERS].sort()).toEqual(pinned);
    }, FRAMEWORK_TIMEOUT_MS);

    it.each(STOPPED)("stopped, where deleting the row would publish other text: %s", (_label, text) => {
      const before = frameworkCsvToJson(renamed(text), "story");
      const deleted = frameworkCsvToJson(naive(text), "story");
      expect(before.ok, before.log).toBe(true);
      expect(deleted.ok, deleted.log).toBe(true);
      expect(deleted.published).not.toEqual(before.published.map(without));
      expect(repair(text)).toMatchObject({
        kind: "sheet_rows_changed",
        partialText: text,
        refused: [{ header: "note", reason: "header_row" }],
      });
    }, FRAMEWORK_TIMEOUT_MS);
  });

  it("the constants are the framework's", () => {
    const expected = framework<Record<string, unknown>>(
      [
        "out = {'aliases': cu.GLOSSARY_COLUMN_ALIASES, 'legacy': sorted(cu.LEGACY_HEADER_SPELLINGS),",
        "       'reserved': sorted(cu.RESERVED_COLUMN_NAMES), 'project': list(vs.PROJECT_SHEETS),",
        "       'objects': list(vs.OBJECTS_SHEETS), 'glossary': list(vs.GLOSSARY_SHEETS),",
        "       'dir': vs.SPREADSHEETS_DIR}",
      ].join("\n"),
      null,
    );
    expect({
      aliases: { ...FRAMEWORK_GLOSSARY_COLUMN_ALIASES },
      legacy: [...ONCE_PUBLISHED_HEADER_TOKENS].sort(),
      reserved: [...RESERVED_COLUMN_NAMES].sort(),
      project: [...PROJECT_SHEETS],
      objects: [...OBJECTS_SHEETS],
      glossary: [...GLOSSARY_SHEETS],
      dir: SPREADSHEETS_DIR,
    }).toEqual(expected);
  }, FRAMEWORK_TIMEOUT_MS);
});

/** Every code point's lowercase where it is not the code point itself, as a Python expression. */
const LOWER_TABLE =
  "{str(cp): chr(cp).lower() for cp in range(0x110000) if not 0xd800 <= cp <= 0xdfff and chr(cp).lower() != chr(cp)}";

/** Every code point's `lower().strip()` where it is not the code point itself, as a Python expression. */
const FOLD_TABLE =
  "{str(cp): chr(cp).lower().strip() for cp in range(0x110000) if not 0xd800 <= cp <= 0xdfff and chr(cp).lower().strip() != chr(cp)}";

/** The code points, in hex, where `pythonLower` and a Python's lowercase table disagree. */
function lowerDifferences(table: Record<string, string>): string[] {
  const differing: string[] = [];
  for (let cp = 0; cp < 0x110000; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (pythonLower(ch) !== (table[String(cp)] ?? ch)) differing.push(cp.toString(16).toUpperCase());
  }
  return differing;
}

/**
 * A Python whose Unicode data has the build's case mappings: 3.12 carries
 * Unicode 15.0, which added no case mapping to the 14.0 of the build's 3.11.
 */
const BUILD_CASE_PYTHON = "/usr/local/bin/python3.12";
const buildCasePythonPresent = existsSync(BUILD_CASE_PYTHON);

describe.skipIf(!buildCasePythonPresent)(
  buildCasePythonPresent
    ? "pythonLower against the build's case mappings"
    : `pythonLower against the build's case mappings [skipped: no ${BUILD_CASE_PYTHON}]`,
  () => {
    it("agrees with Python 3.12 on every code point", () => {
      const version = execFileSync(BUILD_CASE_PYTHON, ["-c", "import unicodedata; print(unicodedata.unidata_version)"])
        .toString()
        .trim();
      expect(version).toBe("15.0.0");
      const table = JSON.parse(
        execFileSync(BUILD_CASE_PYTHON, ["-c", `import json; print(json.dumps(${LOWER_TABLE}))`], {
          maxBuffer: 64 * 1024 * 1024,
        }).toString(),
      ) as Record<string, string>;
      expect(lowerDifferences(table)).toEqual([]);
    }, FRAMEWORK_TIMEOUT_MS);

    it("foldHeader agrees with Python 3.12's `lower().strip()` on every code point", () => {
      const table = JSON.parse(
        execFileSync(BUILD_CASE_PYTHON, ["-c", `import json; print(json.dumps(${FOLD_TABLE}))`], {
          maxBuffer: 64 * 1024 * 1024,
        }).toString(),
      ) as Record<string, string>;
      const differing: string[] = [];
      for (let cp = 0; cp < 0x110000; cp += 1) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue;
        const ch = String.fromCodePoint(cp);
        if (foldHeader(ch) !== (table[String(cp)] ?? ch)) differing.push(cp.toString(16).toUpperCase());
      }
      expect(differing).toEqual([]);
    }, FRAMEWORK_TIMEOUT_MS);
  },
);
