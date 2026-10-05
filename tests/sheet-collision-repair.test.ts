/**
 * The ported 1.8.0 column repair: the framework's own cases from
 * tests/unit/test_migration_v180_sheets.py, byte for byte and record for
 * record (a record is its message key, arguments and status, which is what
 * the framework's message catalogue turns into the sentence its tests read),
 * then the outcomes the Compositor adds: the author's choices, and the
 * deletion of a second header row the framework's repair would stop for.
 *
 * @version v1.5.0-beta
 */
import { describe, expect, it } from "vitest";

import {
  frameworkRecordOf,
  repairSheet,
  sheetsToCheck,
  type RepairSheetResult,
} from "~/lib/sheet-collision-repair.server";
import { repairSite, type FrameworkRecord } from "./helpers/sheet-repair-site";

const applied = (key: string, ...args: string[]): FrameworkRecord => ({ key, args, status: "applied" });
const failed = (key: string, ...args: string[]): FrameworkRecord => ({ key, args, status: "failed" });
const CLEAN = [applied("v180_sheets_clean")];

function header(text: string): string[] {
  return text.replace(/^﻿/, "").split(/\r\n|\r|\n/)[0].split(",");
}

function one(name: string, text: string) {
  const site = repairSite({ [name]: text });
  return { text: site.texts[name], records: site.records, result: site.results[name] };
}

const OBJECTS_EMPTY_OBJECT_TYPE =
  "object_id,title,medium,object_type\nmap-1,A map,Ink on paper,\nmap-2,Another map,,\nmap-3,A third map,Watercolour,\n";

describe("TestOneColumnHoldsValues", () => {
  it("the empty object_type goes and medium stays", () => {
    const { text, records } = one("objects.csv", OBJECTS_EMPTY_OBJECT_TYPE);
    expect(header(text)).toEqual(["object_id", "title", "medium"]);
    expect(records).toEqual([applied("v180_column_dropped", "object_type", "objects.csv", "medium")]);
    expect(text).toBe("object_id,title,medium\nmap-1,A map,Ink on paper\nmap-2,Another map,\nmap-3,A third map,Watercolour\n");
  });

  it("the reverse keeps object_type", () => {
    const { text, records } = one("objects.csv", "object_id,title,medium,object_type\nmap-1,A map,,Ink on paper\nmap-2,Another map,,\n");
    expect(header(text)).toEqual(["object_id", "title", "object_type"]);
    expect(records).toEqual([applied("v180_column_dropped", "medium", "objects.csv", "object_type")]);
  });
});

describe("TestNoColumnHoldsValues", () => {
  it("the canonical spelling wins over file order", () => {
    expect(header(one("objects.csv", "object_id,object_type,title,medium\nmap-1,,A map,\n").text)).toEqual(["object_id", "title", "medium"]);
  });

  it("without a canonical spelling the first wins", () => {
    expect(header(one("objects.csv", "object_id,title,tipo_objeto,object_type\nmap-1,A map,,\n").text)).toEqual([
      "object_id", "title", "tipo_objeto",
    ]);
  });
});

describe("TestMoreThanOneColumnHoldsValues", () => {
  it("nothing is dropped and the owner is told", () => {
    const text = "object_id,title,medium,object_type\nmap-1,A map,Ink,Paper\n";
    const { text: after, records, result } = one("objects.csv", text);
    expect(after).toBe(text);
    expect(records).toEqual([failed("v180_columns_hold_values", "objects.csv", "`medium`, `object_type`")]);
    expect(result.kind).toBe("needs_choices");
  });
});

describe("TestRowsThatAreNotData", () => {
  it("a value in a comment row does not count", () => {
    expect(one("objects.csv", "object_id,title,medium,object_type\n# instructions,,,write the medium here\nmap-1,A map,Ink,\n").text).toBe(
      "object_id,title,medium\n# instructions,,\nmap-1,A map,Ink\n",
    );
  });

  it("a Spanish header row does not count", () => {
    expect(header(one("objects.csv", "object_id,title,medium,object_type\nid_objeto,titulo,medio,tipo_objeto\nmap-1,A map,Ink,\n").text)).toEqual([
      "object_id", "title", "medium",
    ]);
  });

  it("a hash column is never a candidate", () => {
    expect(header(one("objects.csv", "object_id,title,medium,object_type,#medium\nmap-1,A map,Ink,,\n").text)).toEqual([
      "object_id", "title", "medium", "#medium",
    ]);
  });
});

describe("TestTheScopingOfEachSheet", () => {
  it("privado beside protected on the project sheet", () => {
    expect(header(one("project.csv", "order,story_id,title,protected,privado\n1,my-story,My story,yes,\n").text)).toEqual([
      "order", "story_id", "title", "protected",
    ]);
  });

  it("tipo beside kind on the glossary", () => {
    expect(header(one("glossary.csv", "term_id,title,definition,kind,tipo\ncord,Cord,A cord,term,\n").text)).toEqual([
      "term_id", "title", "definition", "kind",
    ]);
  });

  it("privado on the objects sheet is not a collision", () => {
    const text = "object_id,title,protected,privado\nmap-1,A map,,\n";
    expect(one("objects.csv", text)).toMatchObject({ text, records: CLEAN });
  });

  it("note beside Note on a story sheet", () => {
    expect(header(one("my-story.csv", "step,object,question,answer,note,Note\n1,map-1,Where?,Here.,A note,\n").text)).toEqual([
      "step", "object", "question", "answer", "note",
    ]);
  });

  it("two identical headers are left alone", () => {
    const text = "step,object,question,answer,note,note\n1,map-1,Where?,Here.,,\n";
    expect(one("my-story.csv", text).text).toBe(text);
  });

  it("pandas' own suffixes decide what collides", () => {
    const text = "step,answer,note,note,note.1\n1,Here.,,,\n";
    expect(one("my-story.csv", text)).toMatchObject({ text, records: CLEAN });
  });

  it("a suffixed label that does collide is repaired", () => {
    expect(one("my-story.csv", "step,answer,note,Note,note\n1,Here.,x,,\n").text).toBe("step,answer,note,note\n1,Here.,x,\n");
  });

  it("a removal that relabels a twin is repaired in turn", () => {
    const { text, records } = one("my-story.csv", "step,answer,note,note,note,Note\n1,Here.,,,,y\n");
    expect(text).toBe("step,answer,Note\n1,Here.,y\n");
    expect(records.every((r) => r.status === "applied")).toBe(true);
  });

  it("the records name the column the file keeps", () => {
    const { text, records } = one("my-story.csv", "step,answer,Note,note,note\n1,Here.,,,value\n");
    expect(text).toBe("step,answer,note\n1,Here.,value\n");
    expect(records).toEqual([
      applied("v180_column_dropped", "note", "my-story.csv", "note"),
      applied("v180_column_dropped", "Note", "my-story.csv", "note"),
    ]);
  });

  it("columns that are all empty are reported as such", () => {
    const { text, records } = one("my-story.csv", "step,answer,note,Note\n1,Here.,,\n");
    expect(text).toBe("step,answer,note\n1,Here.,\n");
    expect(records).toEqual([applied("v180_column_dropped_all_empty", "Note", "my-story.csv", "note", "note")]);
  });

  it("a collision a removal creates is reported, not left to the build", () => {
    const { records, result } = one("my-story.csv", "step,answer,note,note,Note\n1,Here.,,x,y\n");
    expect(records.filter((r) => r.status === "failed")).toEqual([
      failed("v180_columns_hold_values", "my-story.csv", "`note`, `Note`"),
    ]);
    expect(result).toMatchObject({
      kind: "needs_choices",
      partialText: "step,answer,note,Note\n1,Here.,x,y\n",
      groups: [{ claim: "note", columns: [{ position: 3, header: "note", values: ["x"] }, { position: 4, header: "Note", values: ["y"] }] }],
    });
  });
});

const COMPOSITOR_CASE = "note,Note,step,answer\n,#kept,1,Here.\n";

describe("TestTheRowsTheBuildReads", () => {
  it("an empty first column is marked rather than removed", () => {
    const { text, records, result } = one("story1.csv", COMPOSITOR_CASE);
    expect(text).toBe("#note,Note,step,answer\n,#kept,1,Here.\n");
    expect(records).toEqual([applied("v180_column_marked_note", "note", "story1.csv", "#note")]);
    expect(result.report).toEqual([
      { kind: "marked", sheet: "story1.csv", column: "note", position: 0, markedAs: "#note", chosen: false, heldValues: false },
    ]);
  });

  it("a quoted first header is marked byte for byte", () => {
    const { text, records } = one("story1.csv", '﻿"note",Note,step,answer\r\n,#kept,1,"Here, now."\r\n');
    expect(text).toBe('﻿"#note",Note,step,answer\r\n,#kept,1,"Here, now."\r\n');
    expect(records).toEqual([applied("v180_column_marked_note", "note", "story1.csv", "#note")]);
  });

  it("a later column is still removed", () => {
    const { text, records } = one("story1.csv", "step,answer,note,Note\n1,Here.,,#kept\n");
    expect(text).toBe("step,answer,Note\n1,Here.,#kept\n");
    expect(records).toEqual([applied("v180_column_dropped", "note", "story1.csv", "Note")]);
  });
});

// pandas types a column from every cell it reads, the second header row's words included, so deleting the row can
// change how a column is published: a column of plain integers publishes as written, and one of "001", of "1" beside
// "1.5", or of numbers with an empty cell does not (the build reads only an empty cell as missing).
const laterColumn = (rows: string[]) =>
  `step,answer,object,note,Note,extra\npaso,respuesta,objeto,pregunta,,libre\n${rows.map((r) => `${r}\n`).join("")}`;
const firstColumn = (rows: string[]) =>
  `note,Note,step,answer,object,extra\npregunta,,paso,respuesta,objeto,libre\n${rows.map((r) => `${r}\n`).join("")}`;
const LATER_COLUMN_NEEDED = laterColumn(["1,Here.,map-1,,x,e", "2,There.,map-2,,y,f", "3,Now.,map-3,,z,g"]);
const FIRST_COLUMN_NEEDED = firstColumn([",x,1,Here.,map-1,e", ",y,2,There.,map-2,f"]);

describe("a column the header-row judgement needs", () => {
  it("is removed with the second header row, which the build drops, when it is a later column", () => {
    const { text, records, result } = one("story1.csv", LATER_COLUMN_NEEDED);
    expect(text).toBe("step,answer,object,Note,extra\n1,Here.,map-1,x,e\n2,There.,map-2,y,f\n3,Now.,map-3,z,g\n");
    expect(records).toEqual([applied("v180_column_dropped", "note", "story1.csv", "Note")]);
    expect(result.kind).toBe("repaired");
    expect(result.report.map((e) => e.kind)).toEqual(["dropped", "header_row_deleted"]);
  });

  it("is removed with the second header row when it is the first column and its removal keeps every row", () => {
    const { text, result } = one("story1.csv", FIRST_COLUMN_NEEDED);
    expect(text).toBe("Note,step,answer,object,extra\nx,1,Here.,map-1,e\ny,2,There.,map-2,f\n");
    expect(result.kind).toBe("repaired");
    expect(result.report.map((e) => e.kind)).toEqual(["dropped", "header_row_deleted"]);
  });

  it("is removed with the second header row when a column has a decimal that publishes as written", () => {
    const { text } = one("story1.csv", laterColumn(["1.5,Here.,map-1,,x,e", "2.25,There.,map-2,,y,f"]));
    expect(text).toBe("step,answer,object,Note,extra\n1.5,Here.,map-1,x,e\n2.25,There.,map-2,y,f\n");
  });

  it("is removed with the second header row when the column that would retype is one the framework reads as text", () => {
    const { text } = one("story1.csv", laterColumn(["0,Here.,001,,x,e"]));
    expect(text).toBe("step,answer,object,Note,extra\n0,Here.,001,x,e\n");
  });

  it.each([
    ["a zero-padded answer, which would publish as 1", laterColumn(["1,001,map-1,,x,e"])],
    ["a step 1 beside 1.5, which would publish as 1.0", laterColumn(["1,Here.,map-1,,x,e", "1.5,There.,map-2,,y,f"])],
    ["a trailing zero, which would publish as 1.5", laterColumn(["1.50,Here.,map-1,,x,e"])],
    ["numbers with an empty cell, which would publish as 1.0", laterColumn(["1,Here.,map-1,,x,e", ",There.,map-2,,y,f", "3,Now.,map-3,,z,g"])],
    ["a plus sign, which would publish without it", laterColumn(["+1,Here.,map-1,,x,e"])],
    ["the first column, with a zero-padded answer", firstColumn([",x,1,001,map-1,e"])],
  ])("is kept, and the sheet stopped, when deleting the row would change a published cell: %s", (_label, text) => {
    const { text: after, records, result } = one("story1.csv", text);
    expect(after).toBe(text);
    expect(records).toEqual([failed("v180_column_kept_for_header_row", "note", "story1.csv")]);
    expect(result).toMatchObject({ kind: "sheet_rows_changed", refused: [{ header: "note", reason: "header_row" }] });
  });

  it("leaves a sheet whose header row is no longer needed with its second row", () => {
    const { text } = one("story1.csv", "step,answer,note,Note\n1,Here.,,#kept\n");
    expect(text).toBe("step,answer,Note\n1,Here.,#kept\n");
  });
});

describe("TestTheFileKeepsItsForm", () => {
  it("CRLF with a byte-order mark", () => {
    expect(one("objects.csv", '﻿object_id,title,medium,object_type\r\nmap-1,"A map, folded",Ink,\r\n').text).toBe(
      '﻿object_id,title,medium\r\nmap-1,"A map, folded",Ink\r\n',
    );
  });

  it("a cell holding a newline survives", () => {
    expect(one("my-story.csv", 'step,object,question,answer,note,Note\n1,map-1,Where?,"Two\nlines",,\n').text).toBe(
      'step,object,question,answer,note\n1,map-1,Where?,"Two\nlines",\n',
    );
  });

  it.each(["\r", "\r\n", "\n"])("every terminator is kept: %j", (newline) => {
    const text = ["object_id,title,medium,object_type", "m,M,Ink,", ""].join(newline);
    expect(one("objects.csv", text).text).toBe(["object_id,title,medium", "m,M,Ink", ""].join(newline));
  });

  it("mixed terminators are each kept", () => {
    expect(one("objects.csv", "object_id,title,medium,object_type\r\nm,M,Ink,\nn,N,Oil,\rp,P,,").text).toBe(
      "object_id,title,medium\r\nm,M,Ink\nn,N,Oil\rp,P,",
    );
  });

  it("surviving fields keep their bytes", () => {
    expect(one("objects.csv", 'object_id,"title",object_type,medium\n"m",  spaced  ,,"Ink ""wet"", on\npaper"\nn,"N",  ,\n').text).toBe(
      'object_id,"title",medium\n"m",  spaced  ,"Ink ""wet"", on\npaper"\nn,"N",\n',
    );
  });

  it("the first column can go", () => {
    expect(one("my-story.csv", "Note,step,answer,note\n,1,Here.,x\n").text).toBe("step,answer,note\n1,Here.,x\n");
  });

  it("a short row and a blank line", () => {
    expect(one("objects.csv", "object_id,title,medium,object_type\nm,M\n\nn,N,Ink,\n").text).toBe(
      "object_id,title,medium\nm,M\n\nn,N,Ink\n",
    );
  });

  it.each(['object_id,title,medium,object_type\nm,"M"x,Ink,\n', 'object_id,title,medium,object_type\nm,"M,Ink,\n'])(
    "a file that cannot be split safely is not written: %j",
    (text) => {
      const { text: after, records, result } = one("objects.csv", text);
      expect(after).toBe(text);
      expect(records).toEqual([failed("v180_column_not_removed", "object_type", "objects.csv")]);
      expect(result).toMatchObject({ kind: "sheet_unreadable_for_repair", reason: "unsplittable" });
    },
  );

  it("a field over the csv module's default limit is read", () => {
    const cell = "x".repeat(200_000);
    const { text, records } = one("objects.csv", `object_id,title,medium,object_type\nm,"${cell}",Ink,\n`);
    expect(text).toBe(`object_id,title,medium\nm,"${cell}",Ink\n`);
    expect(records.map((r) => r.status)).toEqual(["applied"]);
  });

  it("a second run changes nothing", () => {
    const first = one("objects.csv", OBJECTS_EMPTY_OBJECT_TYPE).text;
    expect(one("objects.csv", first)).toMatchObject({ text: first, records: CLEAN });
  });
});

describe("TestTheLinesPandasSkips", () => {
  it.each(["\n", "  \t\n"])("a skipped first line %j before a colliding header", (lead) => {
    const { text, records } = one("story1.csv", `${lead}note,Note,step\n,v,1\n`);
    expect(text).toBe(`${lead}Note,step\nv,1\n`);
    expect(records).toEqual([applied("v180_column_dropped", "note", "story1.csv", "Note")]);
  });

  it("a byte-order mark and a blank line", () => {
    expect(one("objects.csv", "﻿\nobject_id,title,medium,object_type\nm,M,Ink,\n").text).toBe("﻿\nobject_id,title,medium\nm,M,Ink\n");
  });

  it("CRLF with skipped lines before and between rows", () => {
    expect(one("story1.csv", "\r\n\r\nnote,Note,step\r\n,v,1\r\n \t\r\n,w,2\r\n").text).toBe("\r\n\r\nNote,step\r\nv,1\r\n \t\r\nw,2\r\n");
  });

  it("a removal that empties a row is not made", () => {
    const text = "step,paso\n1,\n,\n";
    const { text: after, records } = one("story1.csv", text);
    expect(after).toBe(text);
    expect(records).toEqual([failed("v180_column_not_removed", "paso", "story1.csv")]);
  });

  it("a first column whose removal empties a row is marked", () => {
    const { text, records } = one("story1.csv", "paso,step\n,1\n,\n");
    expect(text).toBe("#paso,step\n,1\n,\n");
    expect(records).toEqual([applied("v180_column_marked_note", "paso", "story1.csv", "#paso")]);
  });

  it("a row wider than the header keeps its extra cell", () => {
    expect(one("story1.csv", "\nstep,answer,note,Note\n1,Here.,,x,extra\n").text).toBe("\nstep,answer,Note\n1,Here.,x,extra\n");
    expect(one("story1.csv", "step,answer,note,Note\n1,Here.,,x,extra\n").text).toBe("step,answer,Note\n1,Here.,x,extra\n");
  });

  it("a row left as a quoted empty cell is still a row", () => {
    expect(one("story1.csv", 'step,paso\n1,\n"",\n').text).toBe('step\n1\n""\n');
  });

  it("a removal that would blank the header is not made", () => {
    const text = " ,\t\n";
    const { text: after, records } = one("story1.csv", text);
    expect(after).toBe(text);
    expect(records).toEqual([failed("v180_column_not_removed", "\t", "story1.csv")]);
  });
});

describe("TestReportsWithoutRepair", () => {
  it("a reserved column is named", () => {
    const { records, result } = one("my-story.csv", "step,object,question,answer,_metadata\n1,map-1,Where?,Here.,x\n");
    expect(records).toEqual([failed("v180_reserved_column", "my-story.csv", "_metadata")]);
    expect(result).toMatchObject({ kind: "sheet_reserved_column", columns: ["_metadata"] });
  });

  it("a site without spreadsheets", () => {
    expect(repairSite({}).records).toEqual(CLEAN);
  });
});

describe("the design's named cases", () => {
  it("note,note,Note with values in the last two is resolved in two passes and goes to the author", () => {
    const { text, result } = one("s.csv", "step,answer,note,note,Note\n1,Here.,,x,y\n");
    expect(text).toBe("step,answer,note,Note\n1,Here.,x,y\n");
    expect(result.kind).toBe("needs_choices");
  });

  it("step,answer,note,note,Note with values -> needs_choices on positions 3 and 4", () => {
    const { result } = one("s.csv", "step,answer,note,note,Note\n1,Here.,,x,y\n");
    expect(result.kind === "needs_choices" && result.groups.map((g) => g.columns.map((c) => c.position))).toEqual([[3, 4]]);
  });

  it("a bilingual header row survives a repair", () => {
    const { text } = one("s.csv", "step,answer,note,Note\npaso,respuesta,,\n1,Here.,,x\n");
    expect(text).toBe("step,answer,Note\npaso,respuesta,\n1,Here.,x\n");
  });

  it("two headers only Node's newer Unicode folds together are left alone", () => {
    const text = "step,answer,\ua7ce,\ua7cf\n1,Here.,x,\n";
    expect(one("s.csv", text)).toMatchObject({ text, records: CLEAN, result: { kind: "unchanged" } });
  });

  it("a glossary with tipo, and the other glossary file read as a story", () => {
    const site = repairSite({
      "glossary.csv": "term_id,title,kind,tipo\nx,X,term,\n",
      "glosario.csv": "id_termino,titulo,kind,tipo\nx,X,term,\n",
    });
    expect(header(site.texts["glossary.csv"])).toEqual(["term_id", "title", "kind"]);
    expect(site.texts["glosario.csv"]).toBe("id_termino,titulo,kind,tipo\nx,X,term,\n");
  });
});

describe("outcomes", () => {
  const input = (text: string, name = "s.csv") => ({ path: `telar-content/spreadsheets/${name}`, text, role: "story" as const });

  it("unreadable: pandas reads another number of columns", () => {
    const result = repairSheet(input("﻿﻿\na,a\n"));
    expect(result).toMatchObject({ kind: "sheet_unreadable_for_repair", reason: "unreadable" });
    expect(result.report.map((e) => frameworkRecordOf(e)?.key)).toEqual(["v180_sheet_unreadable"]);
  });

  it("an unsplittable sheet with nothing to repair is unchanged", () => {
    expect(repairSheet(input('a,b\n"x"y,z\n')).kind).toBe("unchanged");
  });

  it("an unsplittable sheet holding values in two columns is unsplittable, not a choice", () => {
    expect(repairSheet(input('a,A\nx,"y"z\n'))).toMatchObject({ kind: "sheet_unreadable_for_repair", reason: "unsplittable" });
  });

  it("a reserved column comes before a refused removal, and the repair still runs", () => {
    const result = repairSheet(input("step,paso,_metadata,note,Note\n1,,,,x\n,\n"));
    expect(result).toMatchObject({ kind: "sheet_reserved_column", partialText: "step,paso,_metadata,Note\n1,,,x\n,\n" });
    expect(result.report.map((e) => e.kind)).toEqual(["reserved_column", "dropped", "not_removed"]);
  });

  it("a refused removal comes before a group holding values", () => {
    const result = repairSheet(input("step,paso,note,Note\n1,,x,y\n,\n"));
    expect(result).toMatchObject({ kind: "sheet_rows_changed", refused: [{ position: 1, header: "paso", reason: "rows_changed" }] });
    expect(result.report.map((e) => e.kind)).toEqual(["not_removed", "hold_values"]);
  });

  it("a group holding values comes before a repair", () => {
    const result = repairSheet(input("step,answer,note,Note,medium,object_type\n1,a,x,y,m,\n"));
    expect(result).toMatchObject({ kind: "needs_choices", partialText: "step,answer,note,Note,medium\n1,a,x,y,m\n" });
  });

  it("a repair with nothing left over is repaired; a clean sheet unchanged", () => {
    expect(repairSheet(input("step,note,Note\n1,,x\n"))).toMatchObject({ kind: "repaired", text: "step,Note\n1,x\n" });
    expect(repairSheet(input("step,note\n1,x\n"))).toMatchObject({ kind: "unchanged", report: [] });
  });
});

describe("the author's choices", () => {
  const input = (text: string, choices: { positions: number[]; keep: number }[]) => ({
    path: "telar-content/spreadsheets/s.csv",
    text,
    role: "story" as const,
    choices,
  });
  const TWO = "step,answer,note,Note\n1,Here.,x,y\n2,There.,z,\n";

  it("keeps the chosen column and drops the other, values and all", () => {
    const result = repairSheet(input(TWO, [{ positions: [2, 3], keep: 3 }]));
    expect(result).toMatchObject({ kind: "repaired", text: "step,answer,Note\n1,Here.,y\n2,There.,\n" });
    expect(result.report).toEqual([
      { kind: "dropped", sheet: "s.csv", column: "note", position: 2, keeper: "Note", keeperPosition: 3, bothEmpty: false, chosen: true },
    ]);
    expect(result.report.map(frameworkRecordOf)).toEqual([null]);
  });

  it("names the columns by position in any order", () => {
    expect(repairSheet(input(TWO, [{ positions: [3, 2], keep: 2 }]))).toMatchObject({
      kind: "repaired",
      text: "step,answer,note\n1,Here.,x\n2,There.,z\n",
    });
  });

  it("refuses a choice whose keep is not among its positions, and duplicate choices, and still asks", () => {
    const result = repairSheet(
      input(TWO, [
        { positions: [2, 3], keep: 1 },
        { positions: [2, 3], keep: 2 },
        { positions: [3, 2], keep: 3 },
      ]),
    );
    expect(result).toMatchObject({
      kind: "needs_choices",
      invalidChoices: [
        { reason: "keep_not_in_group", choice: { keep: 1 } },
        { reason: "duplicate", choice: { keep: 2 } },
        { reason: "duplicate", choice: { keep: 3 } },
      ],
    });
  });

  it("reports a choice that matches no group, even when the sheet is otherwise repaired", () => {
    const result = repairSheet(input(TWO, [{ positions: [2, 3], keep: 2 }, { positions: [0, 1], keep: 0 }]));
    expect(result).toMatchObject({
      kind: "needs_choices",
      groups: [],
      invalidChoices: [{ reason: "unknown_group", choice: { positions: [0, 1] } }],
      partialText: "step,answer,note\n1,Here.,x\n2,There.,z\n",
    });
  });

  it("a choice must name every column of the group, the empty ones included", () => {
    const text = "step,note,Note,NOTE\n1,x,y,\n";
    expect(repairSheet(input(text, [{ positions: [1, 2], keep: 1 }]))).toMatchObject({
      kind: "needs_choices",
      groups: [{ columns: [{ position: 1 }, { position: 2 }, { position: 3 }] }],
      invalidChoices: [{ reason: "unknown_group" }],
    });
    expect(repairSheet(input(text, [{ positions: [1, 2, 3], keep: 2 }]))).toMatchObject({ kind: "repaired", text: "step,Note\n1,y\n" });
  });

  it("a group exposed by a later pass asks again, and a second round settles it", () => {
    // note and note.1 are distinct labels until the empty `note` goes; then
    // the second `note` and `Note` collide, both holding values.
    const text = "step,note,note,Note,medium,object_type\n1,,x,y,m,\n";
    const first = repairSheet(input(text, []));
    expect(first).toMatchObject({
      kind: "needs_choices",
      groups: [{ claim: "note", columns: [{ position: 2, header: "note", values: ["x"] }, { position: 3, header: "Note", values: ["y"] }] }],
    });
    const second = repairSheet(input(text, [{ positions: [2, 3], keep: 3 }]));
    expect(second).toMatchObject({ kind: "repaired", text: "step,Note,medium\n1,y,m\n" });
    expect(second.report).toEqual([
      { kind: "dropped", sheet: "s.csv", column: "note", position: 1, keeper: "Note", keeperPosition: 3, bothEmpty: false, chosen: false },
      { kind: "dropped", sheet: "s.csv", column: "object_type", position: 5, keeper: "medium", keeperPosition: 4, bothEmpty: false, chosen: false },
      { kind: "dropped", sheet: "s.csv", column: "note", position: 2, keeper: "Note", keeperPosition: 3, bothEmpty: false, chosen: true },
    ]);
  });

  it("a group exposed after a chosen pass asks again, and every choice so far is replayed", () => {
    // `note.1` is its own label until the chosen pass removes the first `note`.
    const text = "step,note,note,Note,NOTE\n1,,x,y,z\n";
    const first = repairSheet(input(text, []));
    expect(first.kind === "needs_choices" && first.groups.map((g) => g.columns.map((c) => c.position))).toEqual([[1, 3, 4]]);
    const second = repairSheet(input(text, [{ positions: [1, 3, 4], keep: 4 }]));
    expect(second).toMatchObject({
      kind: "needs_choices",
      groups: [{ claim: "note", columns: [{ position: 2, header: "note", values: ["x"] }, { position: 4, header: "NOTE", values: ["z"] }] }],
      invalidChoices: [],
      partialText: "step,note,NOTE\n1,x,z\n",
    });
    const third = repairSheet(input(text, [{ positions: [1, 3, 4], keep: 4 }, { positions: [2, 4], keep: 4 }]));
    expect(third).toMatchObject({ kind: "repaired", text: "step,NOTE\n1,z\n" });
    expect(third.report.map((e) => e.kind === "dropped" && [e.position, e.keeperPosition, e.chosen])).toEqual([
      [1, 4, true], [3, 4, true], [2, 4, true],
    ]);
  });

  describe("a chosen first column holding values, whose removal would change the rows", () => {
    // Removing `note` puts `#kept` first, which the build reads as a comment row.
    const text = "note,Note,step\nv,#kept,1\n";
    const choice = [{ positions: [0, 1], keep: 1 }];

    it("is marked under the default policy", () => {
      const result = repairSheet(input(text, choice));
      expect(result).toMatchObject({ kind: "repaired", text: "#note,Note,step\nv,#kept,1\n" });
      expect(result.report).toEqual([
        { kind: "marked", sheet: "s.csv", column: "note", position: 0, markedAs: "#note", chosen: true, heldValues: true },
      ]);
    });

    it("is refused under the refuse policy", () => {
      const result = repairSheet(input(text, choice), { chosenFirstColumnWithValues: "refuse" });
      expect(result).toMatchObject({
        kind: "sheet_rows_changed",
        refused: [{ position: 0, header: "note", reason: "rows_changed" }],
        partialText: text,
      });
    });
  });
});

describe("sheetsToCheck", () => {
  const paths = (...names: string[]) => names.map((n) => `telar-content/spreadsheets/${n}`);
  const read = (checked: ReturnType<typeof sheetsToCheck>) => checked.map(({ name, role }) => [name, role]);

  it("takes one project and one objects sheet, English first, and every other CSV as a story", () => {
    expect(
      read(sheetsToCheck(paths("proyecto.csv", "project.csv", "objetos.csv", "b.csv", "a.csv", "notes.txt", "glossary.csv", "glosario.csv"))),
    ).toEqual([
      ["a.csv", "story"], ["b.csv", "story"], ["glosario.csv", "story"], ["glossary.csv", "glossary"],
      ["objetos.csv", "objects"], ["project.csv", "project"],
    ]);
  });

  it("takes the Spanish name where the English is absent", () => {
    expect(read(sheetsToCheck(paths("glosario.csv", "proyecto.csv")))).toEqual([["glosario.csv", "glossary"], ["proyecto.csv", "project"]]);
  });

  it("reads only direct children, case-sensitively, in code-point order", () => {
    expect(
      read(sheetsToCheck([...paths("sub/x.csv", "Y.CSV", "￿.csv", "\u{1f600}.csv", "Z.csv"), "telar-content/other.csv"])),
    ).toEqual([["Z.csv", "story"], ["￿.csv", "story"], ["\u{1f600}.csv", "story"]]);
  });

  it("keeps the path it was given", () => {
    expect(sheetsToCheck(paths("a.csv"))).toEqual([{ path: "telar-content/spreadsheets/a.csv", name: "a.csv", role: "story" }]);
  });
});

describe("cost", () => {
  it("repairs a 2,000-row objects sheet", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `obj-${i},Title ${i},Ink,,"A description, ${i}"`);
    const text = `object_id,title,medium,object_type,description\n${rows.join("\n")}\n`;
    const started = performance.now();
    const result: RepairSheetResult = repairSheet({ path: "telar-content/spreadsheets/objects.csv", text, role: "objects" });
    const elapsed = performance.now() - started;
    expect(result.kind).toBe("repaired");
    console.log(`2,000-row objects repair: ${elapsed.toFixed(0)} ms`);
  });
});
