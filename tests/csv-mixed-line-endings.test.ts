/**
 * Reading a CSV whose records end in both CRLF and LF, as the framework's
 * `pd.read_csv` reads it: every reader of a Telar CSV ends a record at either.
 *
 * The fixture is the glossary.csv of juancobo/compositor-test's first commit
 * (tests/fixtures/mixed-line-endings/NOTES.md): its header rows end in CRLF and
 * its quoted `telar` definition ends in LF.
 *
 * @version v1.5.5-beta
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseTelarCsv, GLOSSARY_CANONICAL_SCOPE, OBJECTS_CANONICAL_SCOPE } from "~/lib/import.server";
import { unifiedRecordTerminators } from "~/lib/csv-records";
import { readCsvSourceRows, removeObjectRecord, rewriteGlossaryCsv } from "~/lib/csv-record-scan.server";
import { applyCsvLanguageMatch } from "~/lib/csv-language-match.server";
import { applyOperation } from "~/lib/manifest-runner.server";
import type { CsvLanguageMatchOp, Operation } from "~/lib/manifest-schema.server";
import OP_JSON from "./fixtures/csv-language-match-op.json";
import { describeWithFramework, frameworkCsvToJson, FRAMEWORK_TIMEOUT_MS } from "./helpers/framework-checkout";

const FIXTURE = readFileSync(
  join(__dirname, "fixtures/mixed-line-endings/glossary-compositor-test-d0e300a1.csv"),
  "utf8",
);

/**
 * The template's v1 `telar` definition, `TELAR_TERM_DEFINITIONS[0]` in
 * template-content.server.ts, which does not export it; the test below holds
 * this copy to that source.
 */
const V1_TELAR_DEFINITION =
  "Telar is minimal-computing framework for creating layered IIIF visual narratives for digital scholarship, public exhibitions, community storytelling, and classroom projects. Learn more at [Telar.org](https://telar.org)\n\nTelar es un marco de computación mínima para crear narrativas visuales con capas de texto e imágenes IIIF para humanidades digitales, exposiciones públicas y contextos educativos y comunitarios. Aprende más en [Telar.org](https://telar.org)";

describe("the compositor-test glossary.csv at d0e300a1", () => {
  it("is the file the case is about: CRLF header rows and an LF last record", () => {
    expect(FIXTURE.startsWith("term_id,title,definition\r\n")).toBe(true);
    expect(FIXTURE.endsWith('[Telar.org](https://telar.org)"\n')).toBe(true);
    expect(FIXTURE.endsWith('"\r\n')).toBe(false);
  });

  it("holds the v1 template definition copied in this test", () => {
    const source = readFileSync(join(__dirname, "../app/lib/template-content.server.ts"), "utf8");
    expect(source).toContain(`  ${JSON.stringify(V1_TELAR_DEFINITION)},\n`);
  });

  it("imports the telar definition without a trailing quote, as the v1 template wrote it", () => {
    const rows = parseTelarCsv(FIXTURE, undefined, false, GLOSSARY_CANONICAL_SCOPE);
    const telar = rows.find((row) => row.term_id === "telar");
    expect(telar?.definition).toBe(V1_TELAR_DEFINITION);
    expect(rows).toHaveLength(1);
  });

  it("reads clean, each row's range ending one past its own terminator", () => {
    const reading = readCsvSourceRows(FIXTURE);
    expect(reading?.refused).toBe(false);
    const rows = reading!.rows;
    expect(rows.map((row) => row.rejected)).toEqual([false, false, false, false, false]);
    expect(rows[4].cells[2]).toBe(V1_TELAR_DEFINITION);
    expect(FIXTURE.slice(rows[3].range.end - 2, rows[3].range.end)).toBe("\r\n");
    expect(rows[4].range.start).toBe(rows[3].range.end);
    expect(rows[4].range.end).toBe(FIXTURE.length);
    for (const row of rows) expect(FIXTURE.slice(row.range.start, row.range.start + row.range.text.length)).toBe(row.range.text);
  });

  it("is matched by the 1.8.2 csv_language_match, every other byte kept", () => {
    const op = OP_JSON as CsvLanguageMatchOp;
    const files = new Map([[op.file, FIXTURE]]);
    expect(applyCsvLanguageMatch(files, op, "en")).toBe(true);
    const written = files.get(op.file)!;
    const cellAt = FIXTURE.indexOf('"Telar is minimal');
    expect(written.slice(0, cellAt)).toBe(FIXTURE.slice(0, cellAt));
    expect(written.slice(cellAt)).toBe(`"${op.cases[0].values.en}"\n`);
  });

  it("is rewritten in place by a glossary definition rewrite, every other byte kept", () => {
    const result = rewriteGlossaryCsv(FIXTURE, (text) => text.replace("Telar.org](https://telar.org)", "Telar](https://telar.org)"));
    expect(result.status).toBe("rewritten");
    if (result.status !== "rewritten") return;
    const cellAt = FIXTURE.indexOf('"Telar is minimal');
    expect(result.text.slice(0, cellAt)).toBe(FIXTURE.slice(0, cellAt));
    expect(result.text.endsWith('"\n')).toBe(true);
    const reread = parseTelarCsv(result.text, undefined, false, GLOSSARY_CANONICAL_SCOPE);
    expect(reread[0].definition).toBe(V1_TELAR_DEFINITION.replace("Telar.org](https://telar.org)", "Telar](https://telar.org)"));
  });
});

describe("unifiedRecordTerminators", () => {
  it("drops the CR of each CRLF record terminator in a file that also ends records in LF", () => {
    const source = 'a,b\r\nx,"p\r\nq"\ny,z\r\n';
    const unified = unifiedRecordTerminators(source, ",");
    expect(unified.text).toBe('a,b\nx,"p\r\nq"\ny,z\n');
    expect(unified.newline).toBe("\n");
  });

  it("keeps a CR that sits inside a quoted field, before its closing quote", () => {
    const source = 'a,b\r\nx,"q\r"\ny,z\r\n';
    expect(unifiedRecordTerminators(source, ",").text).toBe('a,b\nx,"q\r"\ny,z\n');
  });

  it("maps offsets past each dropped CR back to the source", () => {
    const source = "a,b\r\nc,d\ne,f\r\n";
    const { text, sourceOffset } = unifiedRecordTerminators(source, ",");
    expect(text).toBe("a,b\nc,d\ne,f\n");
    expect([3, 4, 8, 11, 12].map(sourceOffset)).toEqual([3, 5, 9, 12, 14]);
  });

  it("returns a file whose records all end alike as it is, with no terminator pinned", () => {
    for (const source of ['a,b\r\nx,"p\nq"\r\n', 'a,b\nx,"p\r\nq"\n', "a,b\rx,y\r"]) {
      const unified = unifiedRecordTerminators(source, ",");
      expect(unified.text).toBe(source);
      expect(unified.newline).toBeUndefined();
    }
  });
});

describe("each reader on a minimal mixed-ending file", () => {
  it("parseTelarCsv reads a CRLF header and an LF quoted last record as pandas does", () => {
    const rows = parseTelarCsv('term_id,title,definition\r\nx,X,"one\n\ntwo"\n', undefined, false, GLOSSARY_CANONICAL_SCOPE);
    expect(rows).toEqual([{ term_id: "x", title: "X", definition: "one\n\ntwo" }]);
  });

  it("parseTelarCsv reads an LF header and a CRLF unquoted record without a trailing CR", () => {
    const rows = parseTelarCsv("object_id,title\nx,X\r\ny,Y\n", undefined, false, OBJECTS_CANONICAL_SCOPE);
    expect(rows.map((row) => [row.object_id, row.title])).toEqual([["x", "X"], ["y", "Y"]]);
  });

  it("parseTelarCsv keeps a CRLF inside a quoted field, as pandas does", () => {
    const rows = parseTelarCsv('object_id,title\r\nx,"a\r\nb"\ny,Y\r\n', undefined, false, OBJECTS_CANONICAL_SCOPE);
    expect(rows.map((row) => row.title)).toEqual(["a\r\nb", "Y"]);
  });

  it("removeObjectRecord cuts the record with its own terminator and leaves every other byte", () => {
    const source = 'object_id,title\r\na,"A\nx"\nb,B\r\nc,C\n';
    expect(removeObjectRecord(source, "b")).toEqual({ status: "removed", text: 'object_id,title\r\na,"A\nx"\nc,C\n' });
    expect(removeObjectRecord(source, "a")).toEqual({ status: "removed", text: "object_id,title\r\nb,B\r\nc,C\n" });
  });

  it("csv_language_match finds and rewrites the cell of an LF record after CRLF header rows", () => {
    const op = OP_JSON as CsvLanguageMatchOp;
    const before = `term_id,title,definition\r\nother,O,o\r\ntelar,Telar,"${op.cases[0].equals}"\n`;
    const files = new Map([[op.file, before]]);
    expect(applyCsvLanguageMatch(files, op, "es")).toBe(true);
    expect(files.get(op.file)).toBe(`term_id,title,definition\r\nother,O,o\r\ntelar,Telar,"${op.cases[0].values.es}"\n`);
  });

  it("a manifest CSV operation reads the last quoted record without its closing quote", () => {
    const files = new Map([["_data/project.csv", 'order,byline\r\n1,"A\nB"\n']]);
    const op: Operation = {
      type: "csv_rename_column",
      file_glob: "_data/project.csv",
      old_name: { en: "byline", es: "firma" },
      new_name: { en: "author", es: "autor" },
    };
    applyOperation(files, op, "en", []);
    // The record is kept as it was written, closing quote included.
    expect(files.get("_data/project.csv")).toBe('order,author\r\n1,"A\nB"\n');
  });
});

describeWithFramework("mixed-ending sheets against the framework's pandas", () => {
  const cases: [string, "glossary" | "objects"][] = [
    [FIXTURE, "glossary"],
    ['term_id,title,definition\r\nx,X,"one\n\ntwo"\n', "glossary"],
    ['term_id,title,definition\nx,X,"one\r\ntwo"\r\ny,Y,plain\r\n', "glossary"],
    ["object_id,title\nx,X\r\ny,Y\n", "objects"],
    ['object_id,title\r\nx,"a\r\nb"\ny,Y\r\n', "objects"],
  ];
  it(
    "every cell the build reads is the cell the import reads",
    () => {
      for (const [csv, sheet] of cases) {
        const framework = frameworkCsvToJson(csv, sheet);
        expect(framework.ok, JSON.stringify(csv)).toBe(true);
        const scope = sheet === "glossary" ? GLOSSARY_CANONICAL_SCOPE : OBJECTS_CANONICAL_SCOPE;
        const imported = parseTelarCsv(csv, undefined, false, scope);
        const column = sheet === "glossary" ? "definition" : "title";
        expect(imported.map((row) => row[column]), JSON.stringify(csv)).toEqual(
          framework.rows.map((row) => row[column]),
        );
      }
    },
    FRAMEWORK_TIMEOUT_MS,
  );
});

describe("a file that ends records with a lone CR", () => {
  it("is left as it is, so its quoted CRLF and LF stay inside their fields", () => {
    const source = 'title,object_id\r"one\r\ntwo",a\r"three\nfour",b\r';
    const unified = unifiedRecordTerminators(source, ",");
    expect(unified.text).toBe(source);
    expect(unified.sourceOffset(10)).toBe(10);
  });
});

