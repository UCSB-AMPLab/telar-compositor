/**
 * The CSV record scanner: boundaries over the untouched source.
 *
 * A delete removes one object's record and nothing else. Everything a Telar
 * site's objects.csv can carry has to survive that edit byte for byte — a
 * leading BOM, CRLF terminators, non-ASCII titles, the bilingual label row,
 * comment rows, custom columns, and fields holding newlines, commas and
 * doubled quotes. So the fixtures below carry all of it at once, and the
 * assertions are string equality against the original with one range cut out,
 * not a re-serialisation that happens to parse the same.
 *
 * The other half is what the scanner refuses. An absence is as consequential
 * as a removal — the branch commits the object's images away either way — so
 * a file the scan cannot claim to have read is `unusable`, never `absent`: a
 * record PapaParse rejects, an unterminated quote among them, and a row no
 * range aligns to. And a record the importer would skip is never a candidate,
 * so the label row and a row whose first cell opens `#` survive an id that
 * happens to match their text.
 *
 * What it must NOT refuse is every file below that reads clean to the
 * importer: one parse answers for both sides, and the delimiter, the
 * terminator and the record's own position in the file come from that parse,
 * so a delete the importer can account for goes through.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import Papa from "papaparse";
import { scanCsvRecords, removeObjectRecord } from "~/lib/csv-record-scan.server";
import { extractCommentRows, reserialiseSurvivingObjects, serializeObjectsCsv } from "~/lib/csv-export.server";
import { splitCsvRecords } from "~/lib/csv-records";
import {
  OBJECTS_CANONICAL_SCOPE,
  mapObjectsCsv,
  parseTelarCsv,
  resolvedColumnPosition,
} from "~/lib/import.server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOM = "\uFEFF";

/** Header, bilingual label row, comments, custom columns, CRLF, non-ASCII. */
const FULL_CSV =
  BOM +
  "object_id,title,description,credit,nota_del_curso\r\n" +
  "id_objeto,titulo,descripcion,credito,\r\n" +
  "# Una fila de comentario que el marco conserva\r\n" +
  'mapa-de-santafe,"Mapa de Santafé, 1791","Dice ""la muy noble ciudad"",\r\ny sigue en otra línea.",Archivo General,revisar\r\n' +
  "# comentario pegado justo antes del objetivo\r\n" +
  'plano-de-tunja,"Plano de Tunja","Con coma, y acentos: ñ á é",Biblioteca Nacional,\r\n' +
  "retrato-anonimo,Retrato anónimo,,,\r\n";

/** The record the delete targets, terminator included. */
const TUNJA_RECORD =
  'plano-de-tunja,"Plano de Tunja","Con coma, y acentos: ñ á é",Biblioteca Nacional,\r\n';

// ---------------------------------------------------------------------------
// scanCsvRecords
// ---------------------------------------------------------------------------

describe("scanCsvRecords", () => {
  it("splits on records, not on lines", () => {
    const records = scanCsvRecords(FULL_CSV, ",", "\r\n");

    // Header, label row, comment, mapa (two physical lines), comment, tunja,
    // retrato — seven records over eight lines.
    expect(records).toHaveLength(7);
    expect(records[3].text).toContain("\r\ny sigue en otra línea.");
  });

  it("gives ranges that reconstruct the source exactly", () => {
    const records = scanCsvRecords(FULL_CSV, ",", "\r\n");

    expect(records.map((r) => FULL_CSV.slice(r.start, r.end)).join("")).toBe(FULL_CSV);
  });

  it("leaves the BOM in the first record's range", () => {
    const records = scanCsvRecords(FULL_CSV, ",", "\r\n");

    expect(records[0].start).toBe(0);
    expect(records[0].text.startsWith(BOM)).toBe(true);
  });

  it("keeps a quoted field's commas, newlines and doubled quotes in one record", () => {
    const records = scanCsvRecords('a,"one,two\ntwo-and-a-half ""quoted""",c\nnext,row,here\n', ",", "\n");

    expect(records).toHaveLength(2);
    expect(records[1].text).toBe("next,row,here");
  });

  it("treats a blank line as a record of its own", () => {
    const records = scanCsvRecords("a,b\n\nc,d\n", ",", "\n");

    expect(records.map((r) => r.text)).toEqual(["a,b", "", "c,d"]);
  });

  it("closes the last record at the end of an unterminated source", () => {
    const records = scanCsvRecords("a,b\nc,d", ",", "\n");

    expect(records[1]).toEqual({ start: 4, end: 7, text: "c,d" });
  });

  // The terminator's LENGTH at a record boundary, which ranges alone do not
  // pin: a scan given "\n" for a CRLF file finds its match inside the real
  // CRLF, draws the same ranges, and leaves the stray CR on the end of every
  // record's text. Exact texts see it; a CR-only file, where a scan given "\n"
  // finds no boundary at all and returns the whole source as one record, sees
  // it too.
  it("draws a CRLF file's records with the CR outside every one of them", () => {
    expect(scanCsvRecords("object_id,title\r\nobj-1,A\r\nobj-2,B\r\n", ",", "\r\n")).toEqual([
      { start: 0, end: 17, text: "object_id,title" },
      { start: 17, end: 26, text: "obj-1,A" },
      { start: 26, end: 35, text: "obj-2,B" },
    ]);
  });

  it("draws a CR-only file's records on the lone CR", () => {
    expect(scanCsvRecords("object_id,title\robj-1,A\robj-2,B\r", ",", "\r")).toEqual([
      { start: 0, end: 16, text: "object_id,title" },
      { start: 16, end: 24, text: "obj-1,A" },
      { start: 24, end: 32, text: "obj-2,B" },
    ]);
  });

  // Papa strips U+FEFF at absolute offset zero alone, so the same character
  // opening a later record is field content: it opens the field, and the quote
  // behind it is an ordinary character rather than a quoted field's start.
  // Taken for a BOM there, the scan keeps one record where Papa reads two, and
  // the row hiding in the half it swallowed is invisible to anything reading
  // the records back.
  it("cuts a mid-file U+FEFF record where Papa cuts it", () => {
    const source = `a,b\n${BOM}"#one\n#two",v\nz,Z`;

    expect(scanCsvRecords(source, ",", "\n")).toEqual([
      { start: 0, end: 4, text: "a,b" },
      { start: 4, end: 11, text: `${BOM}"#one` },
      { start: 11, end: 19, text: '#two",v' },
      { start: 19, end: 22, text: "z,Z" },
    ]);
    const papa = Papa.parse<string[]>(source, { header: false, delimiter: "," });
    expect(papa.errors).toEqual([]);
    expect(papa.data).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// removeObjectRecord
// ---------------------------------------------------------------------------

describe("removeObjectRecord", () => {
  // The import leaves a `#` column's cells out when it decides whether row 2
  // is the bilingual header, as the framework does; a reading that counted
  // them would see one more data row than the import and refuse the file.
  it("reads a bilingual row the import skips for a # column's sake as the import does", () => {
    const csv = [
      "object_id,title,creator,#notes",
      "id_objeto,titulo,creador,instructions for this column",
      "painting-001,The Garden,Monet,",
      "painting-002,The Pond,Monet,",
      "",
    ].join("\n");

    const result = removeObjectRecord(csv, "painting-001");

    expect(result).toEqual({
      status: "removed",
      text: csv.replace("painting-001,The Garden,Monet,\n", ""),
    });
  });

  it("removes the target record and leaves the rest byte for byte", () => {
    const result = removeObjectRecord(FULL_CSV, "plano-de-tunja");

    expect(result).toEqual({
      status: "removed",
      text: FULL_CSV.replace(TUNJA_RECORD, ""),
    });
  });

  it("keeps the BOM, the label row, the comments and the custom column", () => {
    const result = removeObjectRecord(FULL_CSV, "plano-de-tunja");
    const text = result.status === "removed" ? result.text : "";

    expect(text.startsWith(BOM + "object_id,title,description,credit,nota_del_curso\r\n")).toBe(true);
    expect(text).toContain("id_objeto,titulo,descripcion,credito,\r\n");
    expect(text).toContain("# Una fila de comentario que el marco conserva\r\n");
    expect(text).toContain("# comentario pegado justo antes del objetivo\r\n");
    expect(text).toContain("retrato-anonimo,Retrato anónimo,,,\r\n");
  });

  it("removes a record whose own fields hold newlines, commas and doubled quotes", () => {
    const result = removeObjectRecord(FULL_CSV, "mapa-de-santafe");
    const text = result.status === "removed" ? result.text : "";

    expect(text).not.toContain("Mapa de Santafé");
    expect(text).not.toContain("y sigue en otra línea");
    expect(text).toContain(TUNJA_RECORD);
  });

  it("removes the last record with its terminator and nothing after it", () => {
    const result = removeObjectRecord(FULL_CSV, "retrato-anonimo");

    expect(result).toEqual({
      status: "removed",
      text: FULL_CSV.replace("retrato-anonimo,Retrato anónimo,,,\r\n", ""),
    });
  });

  it("finds the id in whichever column carries it", () => {
    const csv = "title,object_id\nUn plano,plano-de-tunja\nOtro,mapa\n";

    expect(removeObjectRecord(csv, "plano-de-tunja")).toEqual({
      status: "removed",
      text: "title,object_id\nOtro,mapa\n",
    });
  });

  it("never takes a comment row, even one whose text matches the id", () => {
    const csv = "object_id,title\n#plano-de-tunja,anotación\nplano-de-tunja,Plano\n";

    expect(removeObjectRecord(csv, "#plano-de-tunja")).toEqual({ status: "absent" });
  });

  it("answers absent when the CSV holds no such object", () => {
    expect(removeObjectRecord(FULL_CSV, "no-existe")).toEqual({ status: "absent" });
  });

  it("answers unusable when the header carries no object_id column", () => {
    expect(removeObjectRecord("id,title\nplano,Plano\n", "plano")).toEqual({
      status: "unusable",
    });
  });

  it("answers unusable on an empty source", () => {
    expect(removeObjectRecord("", "plano")).toEqual({ status: "unusable" });
  });

  it("cuts a CRLF record whole, leaving no lone CR at the seam", () => {
    const result = removeObjectRecord("object_id,title\r\nobj-1,A\r\nobj-2,B\r\n", "obj-1");

    expect(result).toEqual({ status: "removed", text: "object_id,title\r\nobj-2,B\r\n" });
    expect(result.status === "removed" && /\r(?!\n)/.test(result.text)).toBe(false);
  });

  it("cuts a CR-only file's record with its lone CR", () => {
    expect(removeObjectRecord("object_id,title\robj-1,A\robj-2,B\r", "obj-1")).toEqual({
      status: "removed",
      text: "object_id,title\robj-2,B\r",
    });
  });

  // A mid-file U+FEFF leaves the quote behind it an ordinary character, so the
  // parse and the scan both cut here after `${BOM}"#one` and the object in the
  // next record is one the importer created and this reads back. Refusing was
  // the answer while the record was re-read on its own: stripped of the mark
  // it opened a quoted field that never closed, the two halves joined, and the
  // object went missing from a file that has it.
  it("deletes an object sitting behind a mid-file U+FEFF", () => {
    const csv = `object_id,title\n${BOM}"#one\nobj-2",v\nz,Z`;

    expect(importedIds(csv)).toEqual([`${BOM}"#one`, 'obj-2"', "z"]);
    expect(removeObjectRecord(csv, 'obj-2"')).toEqual({
      status: "removed",
      text: `object_id,title\n${BOM}"#one\nz,Z`,
    });
  });
});

// ---------------------------------------------------------------------------
// What the scanner refuses
// ---------------------------------------------------------------------------

describe("removeObjectRecord — a file it cannot read is never an absence", () => {
  it("reads a record on the file's own delimiter, not one guessed from the record", () => {
    // Left to guess from this row alone, PapaParse splits on the semicolon and
    // the id lands in no cell — an absence that would delete the images and
    // keep the row.
    const csv = "object_id,title\nplano,one;two;three\n";

    expect(removeObjectRecord(csv, "plano")).toEqual({
      status: "removed",
      text: "object_id,title\n",
    });
  });

  // A sheet exported with semicolons or tabs is a ONE-COLUMN comma file, to
  // the framework's `pd.read_csv` and to every reading here: its separator
  // sits inside the single cell, and the quote it carries opens nothing. The
  // header cell then names no id column, which is a file this branch has no
  // id to look for in — `unusable`, never the absence that would commit the
  // object's images away.
  it.each([
    { name: "semicolon", delimiter: ";" },
    { name: "tab", delimiter: "\t" },
  ])("reads a $name-separated export as one column", ({ delimiter }) => {
    const csv = `object_id${delimiter}title\na${delimiter}"A\nb"\nz${delimiter}Z\n`;

    expect(importedIds(csv)).toEqual([]);
    expect(removeObjectRecord(csv, "a")).toEqual({ status: "unusable" });
  });

  it("never cuts part of a record in a file whose cells hold semicolons", () => {
    const csv = 'object_id\na;"A\nb";y\nc;x;y\nd;x;y\n';

    // Every cell is whole and the ids carry their own semicolons, so the id
    // `a` belongs to no row here and the file is untouched.
    expect(importedIds(csv)).toEqual(['a;"A', 'b";y', "c;x;y", "d;x;y"]);
    expect(removeObjectRecord(csv, "a")).toEqual({ status: "absent" });
    expect(removeObjectRecord(csv, 'a;"A')).toEqual({
      status: "removed",
      text: 'object_id\nb";y\nc;x;y\nd;x;y\n',
    });
  });

  it("refuses a file whose target record leaves a quote unterminated", () => {
    const csv = 'object_id,title\nplano,"unclosed\nother,Keep\n';

    expect(removeObjectRecord(csv, "plano")).toEqual({ status: "unusable" });
  });

  it("refuses a file whose EARLIER record leaves a quote unterminated", () => {
    // The unterminated field swallows the target, so a scan that answered from
    // the records it did read would report the object absent.
    const csv = 'object_id,title\nfirst,"unclosed\nplano,Plano\n';

    expect(removeObjectRecord(csv, "plano")).toEqual({ status: "unusable" });
  });

  it("refuses a file holding a record PapaParse rejects", () => {
    const csv = 'object_id,title\n"plano"x,"Plano"\nother,Keep\n';

    expect(removeObjectRecord(csv, "other")).toEqual({ status: "unusable" });
  });

  // A surplus cell was refused while the record was read twice: the two
  // readings could number the cells apart, and the id would then be taken from
  // a cell carrying no name. One parse hands both sides the same cells and the
  // header resolves one position over them, so the surplus belongs to no
  // column on either side — the importer drops it and warns, and the record is
  // the object's to delete.
  it("removes a data record whose field count disagrees with the header", () => {
    const csv = "object_id,title\nplano,Plano,surplus\n";

    expect(importedIds(csv)).toEqual(["plano"]);
    expect(removeObjectRecord(csv, "plano")).toEqual({
      status: "removed",
      text: "object_id,title\n",
    });
  });

  // A closing quote with spaces before the terminator is Papa's `extraSpaces`
  // rule and legal, so the file reads whole and republishes with the comment
  // intact. The same characters with nothing after them are `InvalidQuotes`, so
  // a record read with its terminator stripped off refuses a file every other
  // path handles — and refusing is a delete the author cannot complete.
  it("reads a record whose closing quote is followed by spaces", () => {
    const csv = 'object_id,title\n"#note"  \na,A\n';

    expect(removeObjectRecord(csv, "a")).toEqual({
      status: "removed",
      text: 'object_id,title\n"#note"  \n',
    });
  });

  it("keeps a blank line without calling the file ragged", () => {
    const csv = "object_id,title\n\nplano,Plano\notro,Otro\n";

    expect(removeObjectRecord(csv, "plano")).toEqual({
      status: "removed",
      text: "object_id,title\n\notro,Otro\n",
    });
  });
});

// ---------------------------------------------------------------------------
// Records the importer skips are never candidates
// ---------------------------------------------------------------------------

describe("removeObjectRecord — the importer decides what is data", () => {
  it("never takes the bilingual label row, whatever id is asked for", () => {
    expect(removeObjectRecord(FULL_CSV, "id_objeto")).toEqual({ status: "absent" });
  });

  it("takes a record whose `#` sits in a cell other than the first", () => {
    // The framework's row rule tests the first column alone, so this is the
    // object `plano` with a title opening `#` — a record the author can delete.
    const csv = "object_id,title\nplano,# Keep this instruction\n";

    expect(importedIds(csv)).toEqual(["plano"]);
    expect(removeObjectRecord(csv, "plano")).toEqual({
      status: "removed",
      text: "object_id,title\n",
    });
  });
});

// ---------------------------------------------------------------------------
// One classifier, so the two paths cannot disagree
// ---------------------------------------------------------------------------

/** The ids an import of `csv` would create, in the order it creates them. */
function importedIds(csv: string): string[] {
  return mapObjectsCsv(parseTelarCsv(csv, undefined, false, OBJECTS_CANONICAL_SCOPE), 1).map(
    (row) => row.object_id,
  );
}

describe("removeObjectRecord — label-row classification matches the importer's", () => {
  const header = "object_id,title,description,credit\n";
  const data = "obj-1,A,,\n";
  const labelish = (pad: string) => `${header}id_objeto,titulo,descripcion,${pad}\n${data}`;

  it("removes the record a padded label row's fourth cell makes data", () => {
    // Three known names padded with a cell holding nothing but U+FEFF. CPython
    // strips no BOM, so the cell is populated and matches nothing: 3 of 4, under
    // the 0.8 threshold, and an object. Trimmed JavaScript's way it is 3 of 3,
    // the label row, and a deletion that reports the object absent.
    const csv = labelish(BOM);

    expect(importedIds(csv)).toEqual(["id_objeto", "obj-1"]);
    expect(removeObjectRecord(csv, "id_objeto")).toEqual({
      status: "removed",
      text: header + data,
    });
  });

  it("keeps the label row padded with U+0085, which both sides strip away", () => {
    const csv = labelish("\u0085");

    expect(importedIds(csv)).toEqual(["obj-1"]);
    expect(removeObjectRecord(csv, "id_objeto")).toEqual({ status: "absent" });
  });

  it("keeps the label row padded with an empty cell", () => {
    const csv = labelish("");

    expect(importedIds(csv)).toEqual(["obj-1"]);
    expect(removeObjectRecord(csv, "id_objeto")).toEqual({ status: "absent" });
  });

  it("keeps a label row of four known names", () => {
    const csv = `${header}id_objeto,titulo,descripcion,credito\n${data}`;

    expect(importedIds(csv)).toEqual(["obj-1"]);
    expect(removeObjectRecord(csv, "id_objeto")).toEqual({ status: "absent" });
  });
});

// The header test is spent once, on the first non-comment record of
// the file, and `createCsvRecordSkipDetector` is the one factory both
// `parseTelarCsv` and `removeObjectRecord` build it from — one fixture here,
// asserted on both paths, so a caller that drifted back to testing every
// record would fail this rather than only the importer's own suite.
describe("removeObjectRecord — a later header-like row is data, and the importer agrees", () => {
  const header = "object_id,title,creator,source\n";
  const first = "painting-001,The Garden,Claude Monet,Private collection\n";
  // Every cell here is, on its own, a known bilingual token (object, source,
  // creator, title) — 4 of 4 against the header test. It is real data.
  const laterHeaderLike = "source,Creator,Title,Object\n";
  const csv = header + first + laterHeaderLike;

  it("the importer keeps it as an object", () => {
    expect(importedIds(csv)).toEqual(["painting-001", "source"]);
  });

  it("the record scanner agrees it is data, and removes it", () => {
    expect(removeObjectRecord(csv, "source")).toEqual({
      status: "removed",
      text: header + first,
    });
  });
});

// The test is spent on its first look, whatever it finds there — a MATCH
// consumes it exactly as a non-match does. The fixture above never exercises
// that: its first record is ordinary data, so the test is already spent by a
// NON-match before `laterHeaderLike` is ever reached, and would pass the same
// way even if a match left the test available again. This one's first record
// is the genuine bilingual header row, so the test is spent by a MATCH —
// only that proves a second header-like row still survives once the one that
// actually IS a header has been skipped.
describe("removeObjectRecord — the test does not reopen after it matches, and the importer agrees", () => {
  const header = "object_id,title,creator,source\n";
  const bilingualHeader = "id_objeto,titulo,creador,fuente\n";
  // Every cell here is, on its own, a known bilingual token too — 4 of 4
  // against the header test. It is real data, one record after the one
  // header row the file actually has.
  const laterHeaderLike = "source,Creator,Title,Object\n";
  const csv = header + bilingualHeader + laterHeaderLike;

  it("the importer keeps it as an object", () => {
    expect(importedIds(csv)).toEqual(["source"]);
  });

  it("the record scanner agrees it is data, and removes it", () => {
    expect(removeObjectRecord(csv, "source")).toEqual({
      status: "removed",
      text: header + bilingualHeader,
    });
  });
});

describe("removeObjectRecord — identity comes from the importer", () => {
  // Two headers claim `object_id`. The importer keeps one by the collision
  // rule and the other carries no name, so the id has to be read out of the
  // column the importer kept. Matched on another column instead, `obj-1` takes
  // the record belonging to `obj-2`, or finds a cell that is empty — the
  // object's images committed away and a stranger's row deleted with them, or
  // a delete refused on a file nothing is wrong with.
  it("reads the id from the one column that holds values when it comes last", () => {
    const csv = "object_id,title,id_objeto\n,A,obj-2\n,B,obj-1\n";

    expect(
      resolvedColumnPosition(
        [["object_id", "title", "id_objeto"], ["", "A", "obj-2"], ["", "B", "obj-1"]],
        "object_id",
        OBJECTS_CANONICAL_SCOPE,
      ),
    ).toBe(2);
    expect(importedIds(csv)).toEqual(["obj-2", "obj-1"]);
    expect(removeObjectRecord(csv, "obj-1")).toEqual({
      status: "removed",
      text: "object_id,title,id_objeto\n,A,obj-2\n",
    });
  });

  it("reads the id from the one column that holds values when it comes first", () => {
    const csv = "object_id,title,id_objeto\nobj-1,A,\nobj-2,B,\n";

    expect(
      resolvedColumnPosition(
        [["object_id", "title", "id_objeto"], ["obj-1", "A", ""], ["obj-2", "B", ""]],
        "object_id",
        OBJECTS_CANONICAL_SCOPE,
      ),
    ).toBe(0);
    expect(importedIds(csv)).toEqual(["obj-1", "obj-2"]);
    expect(removeObjectRecord(csv, "obj-1")).toEqual({
      status: "removed",
      text: "object_id,title,id_objeto\nobj-2,B,\n",
    });
  });

  // A value in a comment row is no value: the only filled cell of
  // `id_objeto` is a comment's, so `object_id` keeps the name.
  it("does not count a comment row when choosing the id column", () => {
    const csv = "object_id,title,id_objeto\n#note,,x\nobj-1,A,\nobj-2,B,\n";

    expect(importedIds(csv)).toEqual(["obj-1", "obj-2"]);
    expect(removeObjectRecord(csv, "obj-2")).toEqual({
      status: "removed",
      text: "object_id,title,id_objeto\n#note,,x\nobj-1,A,\n",
    });
  });

  it("resolves the id column the importer does when neither holds values", () => {
    const table = [["id_objeto", "title", "object_id"], ["", "A", ""]];

    expect(resolvedColumnPosition(table, "object_id", OBJECTS_CANONICAL_SCOPE)).toBe(2);
    expect(Object.keys(parseTelarCsv("id_objeto,title,object_id\n,A,\n", undefined, false,
      OBJECTS_CANONICAL_SCOPE)[0])).toEqual(["title", "object_id"]);
  });

  // Whether the import keeps one, refuses the sheet, or keeps both is
  // awaiting a ruling; until then the last column keeps the name, and a
  // delete reads the id where the importer does.
  it("reads the id from the last column when both hold values, as a deletion keeps the last", () => {
    const csv = "object_id,title,id_objeto\nobj-1,A,obj-2\nx,B,obj-1\n";

    expect(
      resolvedColumnPosition(
        [["object_id", "title", "id_objeto"], ["obj-1", "A", "obj-2"], ["x", "B", "obj-1"]],
        "object_id",
        OBJECTS_CANONICAL_SCOPE,
      ),
    ).toBe(2);
    expect(importedIds(csv)).toEqual(["obj-2", "obj-1"]);
    expect(removeObjectRecord(csv, "obj-1")).toEqual({
      status: "removed",
      text: "object_id,title,id_objeto\nobj-1,A,obj-2\n",
    });
  });

  it("takes the id from id_objeto when that is the only column claiming it", () => {
    const csv = "id_objeto,title\nobj-1,A\nobj-2,B\n";

    expect(importedIds(csv)).toEqual(["obj-1", "obj-2"]);
    expect(removeObjectRecord(csv, "obj-1")).toEqual({
      status: "removed",
      text: "id_objeto,title\nobj-2,B\n",
    });
  });

  it("counts a space-only record the way the importer counts it", () => {
    // A delimiter-free record of nothing but spaces is a row pandas never
    // creates (see `isPandasBlankLine`) — the importer skips it without
    // spending the header test on it, and this module has to reach the same
    // verdict from the same shared classifier. A blank rule written here
    // instead of taken from the parse could disagree either way (calling it
    // data when the importer calls it blank, or the reverse), and the two
    // sides would then count the file's rows apart. There is one answer now,
    // so the delete goes through and the spaces stay where the author left
    // them.
    const csv = "object_id,title\n  \nobj-1,A\n";

    expect(importedIds(csv)).toEqual(["obj-1"]);
    expect(removeObjectRecord(csv, "obj-1")).toEqual({
      status: "removed",
      text: "object_id,title\n  \n",
    });
  });

  it("still answers absent for an id no import would have created", () => {
    const csv = "object_id,title\nobj-1,A\n";

    expect(removeObjectRecord(csv, "obj-2")).toEqual({ status: "absent" });
  });
});

// ---------------------------------------------------------------------------
// One parse decides which records exist
//
// Papa reads the file once, under the importer's own configuration, and that
// reading settles every question at once: which rows there are, which of them
// the importer skips, and which characters each one owns. A second reading of
// the same characters — a record parsed on its own, a blank test of this
// module's own — is a second answer, and every case below is one the two
// answered apart.
// ---------------------------------------------------------------------------

/** One D1 object row, for the publish-then-delete round trips. */
function objectRow(overrides: Record<string, unknown>) {
  return {
    object_id: "a",
    title: "A",
    featured: null,
    creator: null,
    description: null,
    source_url: null,
    period: null,
    year: null,
    medium_genre: null,
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    alt_text: "alt",
    dimensions: null,
    extra_columns: null,
    ...overrides,
  };
}

describe("removeObjectRecord — one parse decides which records exist", () => {
  it("takes every record carrying the id and none of the lines around them", () => {
    // `skipEmptyLines: true` drops a row that is one EMPTY field; the
    // space-only line reaches Papa as a record but `isPandasBlankLine` drops
    // it too (see import.server.ts), so the importer's DATA rows here are
    // `a` and `"a"`, both decoding to id `a`. A scan counting the space-only
    // line as data instead — or a scan and an import that simply disagreed
    // about it — would misalign the two sides' row sequence by one, and cut
    // the space-only line or `""` rather than the records asked for.
    const csv = 'object_id\n \na\n"a"\n""\n';

    expect(removeObjectRecord(csv, "a")).toEqual({
      status: "removed",
      text: 'object_id\n \n""\n',
    });
  });

  it("keeps deleting from a published file whose comment row opens with a mark", () => {
    // A mid-file U+FEFF leaves the quote behind it an ordinary character, so
    // the whole-file parse reads `﻿"#note",X` as a data row whose id carries
    // the mark. Re-read one record at a time the mark is stripped, the row is
    // a comment, and the two sides count the file's rows apart — so the
    // author's next delete answers `unusable` on a file that has the object.
    const existing = `object_id,title\n${BOM}"#note",X\na,A\n`;
    const published = serializeObjectsCsv([objectRow({ object_id: "a", title: "A" })], existing);
    const result = removeObjectRecord(published, "a");

    expect(result.status).toBe("removed");
    expect(result.status === "removed" ? splitCsvRecords(result.text, ",", "\n") : []).toEqual(
      splitCsvRecords(published, ",", "\n").filter((record) => !record.startsWith("a,")),
    );
  });

  it("refuses a final record Papa rejects, for an id it holds and one it does not", () => {
    // Spaces after a closing quote at the END of the input are `InvalidQuotes`
    // and `MissingQuotes`: Papa refuses the record, so the importer's own
    // reading of this file is not one anything may cut a range out of. Read
    // with a terminator appended the same characters are legal, and the file
    // reads as though nothing were wrong.
    const csv = 'object_id,title\r\na,"A"  ';

    expect(removeObjectRecord(csv, "a")).toEqual({ status: "unusable" });
    expect(removeObjectRecord(csv, "missing")).toEqual({ status: "unusable" });
  });

  it("refuses a file whose malformed record is dropped before the step runs", () => {
    // The final lone quote is `MissingQuotes`, and the row it decodes to is one
    // EMPTY field — which `skipEmptyLines` removes before the step callback is
    // ever called. The step parse therefore reports nothing wrong with a file
    // Papa could not read, and an absence answered from it commits the object's
    // images away against a file nobody has read whole.
    const csv = 'object_id,title\na,A\n"';

    expect(removeObjectRecord(csv, "missing")).toEqual({ status: "unusable" });
    expect(removeObjectRecord(csv, "a")).toEqual({ status: "unusable" });
  });

  it("answers absent for a header-only file", () => {
    expect(removeObjectRecord("object_id,title\n", "a")).toEqual({ status: "absent" });
  });

  it("removes a final record with no terminator and exactly its own bytes", () => {
    expect(removeObjectRecord("object_id,title\na,A\nb,B", "b")).toEqual({
      status: "removed",
      text: "object_id,title\na,A\n",
    });
  });

  it("removes a BOM-first file's record without disturbing the mark", () => {
    const csv = `${BOM}object_id,title\na,A\nb,B\n`;

    expect(removeObjectRecord(csv, "a")).toEqual({
      status: "removed",
      text: `${BOM}object_id,title\nb,B\n`,
    });
  });

  // Papa strips a mark at absolute offset ZERO and nowhere else. A blank line
  // ahead of the header puts the mark past that offset, so it stays in the
  // header cell Papa hands over and has to stay in the range read back for it —
  // the first PARSED row is not the record the file opens with once
  // `skipEmptyLines` has dropped one.
  it("keeps a mark the file does not open with in the first parsed row", () => {
    const csv = `\n${BOM}notes,object_id\nInfo,a\n`;

    expect(removeObjectRecord(csv, "a")).toEqual({
      status: "removed",
      text: `\n${BOM}notes,object_id\n`,
    });
    expect(extractCommentRows(csv)).toEqual([]);
  });

  // Papa samples the first 1 MiB of the file it was handed to choose a
  // terminator, and the file it is handed has had a leading U+FEFF taken off
  // (papaparse.js:238, `guessLineEndings` at :1164-1188). A sampler run over
  // the source WITH the mark sees a window one character shorter: the fixture
  // below puts a CRLF's LF exactly there, so the two windows hold two CRs each
  // and disagree over whether the second is followed by an LF — `\r\n` to Papa,
  // a lone `\r` to the sampler. A scan reading that file on `\r` ends every
  // record one character before Papa does, no range lines up, and the author's
  // comment row vanishes from the republish while the delete refuses the file.
  it("reads a file whose terminator decides at the sample boundary", () => {
    const SAMPLE = 1024 * 1024;
    // In the source the mark is at 0, "object_id,title\r\n" runs to 17 and the
    // comment's "#" is at 18, so a padding of SAMPLE - 20 puts the comment's
    // own CR at SAMPLE - 1 and its LF at SAMPLE.
    const padding = "x".repeat(SAMPLE - 20);
    const comment = `#${padding}`;
    const source = `${BOM}object_id,title\r\n${comment}\r\na,A\r\nb,B\r\n`;

    expect(source.charCodeAt(SAMPLE - 1)).toBe(13);
    expect(source.charCodeAt(SAMPLE)).toBe(10);
    expect(Papa.parse<string[]>(source, { header: false, skipEmptyLines: true }).meta.linebreak)
      .toBe("\r\n");

    expect(extractCommentRows(source)).toEqual([comment]);
    expect(removeObjectRecord(source, "a")).toEqual({
      status: "removed",
      text: `${BOM}object_id,title\r\n${comment}\r\nb,B\r\n`,
    });
  });

  it("refuses a file whose first record is a comment, which leaves it no header", () => {
    // Record zero is the header to the importer whatever it holds, so a file
    // opening with a comment declares no column an import resolves to
    // `object_id` and every id in it is one no object was created under.
    expect(removeObjectRecord("#note\nobject_id,title\na,A\n", "a")).toEqual({
      status: "unusable",
    });
  });
});

describe("removeObjectRecord — an id written in more than one row", () => {
  // The site shows the last row carrying an id, so a delete that leaves any of
  // them leaves the object on the site.
  const HEAD = BOM + "object_id,title,description\r\n" + "id_objeto,titulo,descripcion\r\n";
  const FIRST = 'bell,"Bell, first","Two\r\nlines"\r\n';
  const COMMENT = "# nota del curso\r\n";
  const DRUM = "drum,Drum,\r\n";

  it("removes every row carrying the id and leaves the rest byte for byte", () => {
    const source = HEAD + FIRST + COMMENT + DRUM + "bell,Bell again,\r\n";

    expect(removeObjectRecord(source, "bell")).toEqual({
      status: "removed",
      text: HEAD + COMMENT + DRUM,
    });
  });

  // The framework reads `bell  ` as an object of its own (`_clean_object_ids`
  // strips an id only to look for an image extension), so a delete of `bell`
  // leaves that row.
  it("leaves a later row whose id carries trailing spaces, a different object", () => {
    const source = HEAD + FIRST + DRUM + COMMENT + "bell  ,Bell again,\r\n";

    expect(removeObjectRecord(source, "bell")).toEqual({
      status: "removed",
      text: HEAD + DRUM + COMMENT + "bell  ,Bell again,\r\n",
    });
  });

  it("removes a row written once exactly as before", () => {
    const source = HEAD + FIRST + COMMENT + DRUM;

    expect(removeObjectRecord(source, "bell")).toEqual({
      status: "removed",
      text: HEAD + COMMENT + DRUM,
    });
  });

  it("keeps the row of another object the site reads under the same id", () => {
    const source = "object_id,title\nmap,Map\nmap.jpg,Map image\nmap,Map again\n";

    expect(removeObjectRecord(source, "map")).toEqual({
      status: "removed",
      text: "object_id,title\nmap.jpg,Map image\n",
    });
  });
});

describe("removeObjectRecord when the cut would promote a survivor to a repeated header", () => {
  const PROMOTING = [
    "object_id,title,creator,source",
    "painting-001,The Garden,Claude Monet,Private collection",
    "source,Creator,Title,Object",
    "",
  ].join("\n");

  it("hands back the surviving rows for reserialising, since the cut text would read one fewer", () => {
    const result = removeObjectRecord(PROMOTING, "painting-001");

    expect(result.status).toBe("removed");
    if (result.status !== "removed") return;
    expect(result.survivors?.map((row) => row.object_id)).toEqual(["source"]);
  });

  it("hands back no survivors when the cut text reads every other row", () => {
    const csv = "object_id,title\npainting-001,A\npainting-002,B\n";
    const result = removeObjectRecord(csv, "painting-001");

    expect(result).toEqual({ status: "removed", text: "object_id,title\npainting-002,B\n" });
  });
});

describe("reserialiseSurvivingObjects", () => {
  it("writes the survivors under the Compositor's header and bilingual row, so the repeated-header lookalike reads as an object", () => {
    const survivors = [{ object_id: "source", title: "Creator", creator: "Title", source: "Object", nota: "kept" }];
    const text = reserialiseSurvivingObjects(survivors);
    const read = parseTelarCsv(text, undefined, false, OBJECTS_CANONICAL_SCOPE);

    expect(text.split("\n")[1].startsWith("id_objeto,")).toBe(true);
    expect(read.map((row) => row.object_id)).toEqual(["source"]);
    expect(read[0].nota).toBe("kept");
  });

  it("keeps the file's comment rows", () => {
    const csv = [
      "object_id,title,creator,source",
      "painting-001,The Garden,Claude Monet,Private collection",
      "# curator note",
      "source,Creator,Title,Object",
      "",
    ].join("\n");
    const removal = removeObjectRecord(csv, "painting-001");
    if (removal.status !== "removed" || !removal.survivors) throw new Error("expected survivors");

    expect(reserialiseSurvivingObjects(removal.survivors, csv)).toContain("# curator note");
  });

  it("writes a blank alt_text cell as the author left it", () => {
    const csv = [
      "object_id,title,alt_text,creator,source",
      "painting-001,The Garden,A garden,Claude Monet,Private collection",
      "source,Creator,,Title,Object",
      "",
    ].join("\n");
    const removal = removeObjectRecord(csv, "painting-001");
    if (removal.status !== "removed" || !removal.survivors) throw new Error("expected survivors");
    const read = parseTelarCsv(reserialiseSurvivingObjects(removal.survivors, csv), undefined, false, OBJECTS_CANONICAL_SCOPE);

    expect(read.map((row) => row.alt_text ?? "")).toEqual([""]);
  });
});
