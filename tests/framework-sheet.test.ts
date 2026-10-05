/**
 * The framework's 1.8.0 sheet reading, ported: the byte splitter, the lines
 * pandas skips, pandas' labels, the bilingual header-row rule, the data rows
 * and the names columns claim. The cases are the framework's own tests
 * (tests/unit/test_migration_v180_sheets.py, test_column_processing.py,
 * test_glossary_kinds.py, test_csv_utils.py), restated against the port, and
 * the pandas cases measured against pandas 3.0.5. They hold without the
 * framework checkout; `framework-sheet-parity.test.ts` runs the same functions
 * against the framework's Python.
 *
 * @version v1.5.0-beta
 */
import { describe, expect, it } from "vitest";

import { foldHeader } from "~/lib/column-mapping";
import {
  FRAMEWORK_GLOSSARY_COLUMN_ALIASES,
  FrameworkSheetUnreadableError,
  cellsOf,
  claimedNames,
  dataRows,
  editedText,
  frameworkIsHeaderRow,
  holdsValues,
  isSkippedFields,
  isSkippedRow,
  pandasLabels,
  LOWERED_ONLY_AFTER_UNICODE_14,
  pythonLower,
  readFrameworkSheet,
  splitRecords,
} from "~/lib/framework-sheet.server";
import { FRAMEWORK_OBJECTS_READER, FRAMEWORK_OBJECT_FIELDS, collidingHeaderGroups } from "~/lib/import.server";
import { pythonStrip } from "~/lib/column-mapping";

const OBJECTS = { canonicalFields: FRAMEWORK_OBJECT_FIELDS };
const GLOSSARY = { sheetAliases: FRAMEWORK_GLOSSARY_COLUMN_ALIASES };

/** The groups the build refuses: every claim more than one column makes. */
function collisions(labels: string[], scope = {}): number[][] {
  return [...claimedNames(labels, scope).values()].filter((members) => members.length > 1);
}

describe("splitRecords", () => {
  it("keeps each field's bytes and each record's terminator", () => {
    expect(splitRecords('a,"b ""c"", d"\r\n  e ,\n\rf')).toEqual([
      { fields: ["a", '"b ""c"", d"'], ending: "\r\n" },
      { fields: ["  e ", ""], ending: "\n" },
      { fields: [""], ending: "\r" },
      { fields: ["f"], ending: "" },
    ]);
  });

  it("reads a quoted field across lines as one field", () => {
    expect(splitRecords('"Two\nlines",x\n')).toEqual([{ fields: ['"Two\nlines"', "x"], ending: "\n" }]);
  });

  it.each(['a,"b"c\n', 'a,"b\n', '"a"" ,b\n'])("refuses what it cannot split exactly: %j", (text) => {
    expect(splitRecords(text)).toBeNull();
  });

  it("splits nothing into no records", () => {
    expect(splitRecords("")).toEqual([]);
  });
});

describe("cellsOf", () => {
  it("reads a blank record as no cells, and unquotes a quoted field", () => {
    expect(cellsOf([""])).toEqual([]);
    expect(cellsOf(['"a ""b"""', "c", '""'])).toEqual(['a "b"', "c", ""]);
  });
});

describe("the lines pandas skips", () => {
  it.each(["", " ", "\t", " \t "])("skips an unquoted field of spaces and tabs: %j", (field) => {
    expect(isSkippedFields([field])).toBe(true);
  });

  it.each(['""', '"  "', "\f", "\v", "\u0085", "﻿", " ", "a"])("reads %j alone as a row", (field) => {
    expect(isSkippedFields([field])).toBe(false);
  });

  it("reads a lone delimiter as a row", () => {
    expect(isSkippedFields(["", ""])).toBe(false);
  });

  it("judges cells csv has read the same way, a quoted blank included", () => {
    expect(isSkippedRow([])).toBe(true);
    expect(isSkippedRow([" \t"])).toBe(true);
    expect(isSkippedRow(["\f"])).toBe(false);
    expect(isSkippedRow(["", ""])).toBe(false);
  });

  it("uses spaces and tabs for a skipped line, and CPython's whitespace for a stripped cell", () => {
    // The two rules part on these: pandas reads each as a cell, CPython strips it.
    for (const ch of ["\f", "\v", "\u0085", "\u001c"]) {
      expect(isSkippedFields([ch]), JSON.stringify(ch)).toBe(false);
      expect(pythonStrip(ch), JSON.stringify(ch)).toBe("");
    }
    // And on this one neither skips nor strips it.
    expect(isSkippedFields(["﻿"])).toBe(false);
    expect(pythonStrip("﻿")).toBe("﻿");
  });
});

describe("pandasLabels", () => {
  it.each<[string[], string[]]>([
    [["note", "note", "note.1"], ["note", "note.2", "note.1"]],
    [["a", "a", "a.1", "a.1"], ["a", "a.2", "a.1", "a.1.1"]],
    [["Unnamed: 1", "", "x"], ["Unnamed: 1", "Unnamed: 1.1", "x"]],
    [["step", "answer", "note", "note"], ["step", "answer", "note", "note.1"]],
    [["", ""], ["Unnamed: 0", "Unnamed: 1"]],
    [["a\u0000b", "\u0000"], ["a", "Unnamed: 1"]],
    [[" note ", "#x"], [" note ", "#x"]],
  ])("labels %j as pandas 3.0.5 does", (header, labels) => {
    expect(pandasLabels(header)).toEqual(labels);
  });

  it("takes one more byte-order mark off the front than the framework did", () => {
    expect(readFrameworkSheet("﻿﻿a,b\n").labels).toEqual(["a", "b"]);
    expect(readFrameworkSheet("﻿﻿a,b\n").header).toEqual(["﻿a", "b"]);
  });

  it("tokenizes a line ended by a lone CR again when the next starts with a space", () => {
    // Measured: pandas reads `\t\r  x\n` with the header `\t`, and `\r  x\n` with an empty one.
    expect(pandasLabels(["x"], "\t\r  x\n")).toEqual(["\t"]);
    expect(pandasLabels(["x"], "\r  x\n")).toEqual(["Unnamed: 0"]);
  });

  it("falls back to the header alone where a quote stays open to the end of the text", () => {
    expect(pandasLabels(["x"], 'x\n"a')).toEqual(["x"]);
    expect(pandasLabels(["x"], 'x\na\n"b')).toEqual(["x"]);
  });

  it("refuses a sheet pandas reads with a different number of columns", () => {
    // pandas skips the mark-only first line the framework reads as a header.
    expect(() => readFrameworkSheet("﻿﻿\na,b\n")).toThrow(FrameworkSheetUnreadableError);
  });
});

describe("readFrameworkSheet", () => {
  it("takes the first line pandas does not skip as the header", () => {
    const sheet = readFrameworkSheet("\r\n  \t\r\nnote,Note,step\r\n,v,1\r\n \t\r\n,w,2\r\n");
    expect(sheet.headerAt).toBe(2);
    expect(sheet.header).toEqual(["note", "Note", "step"]);
    expect(sheet.body).toEqual([["", "v", "1"], ["", "w", "2"]]);
  });

  it("trusts no split that reads back differently from csv", () => {
    expect(readFrameworkSheet('object_id,medium\nm,"M"x\n').records).toBeNull();
  });
});

describe("editedText", () => {
  it("takes a field and one delimiter from each record pandas reads, and leaves skipped lines as written", () => {
    const sheet = readFrameworkSheet("﻿a,b,c\r\n \t\r\n1,,3\r\n4\n");
    expect(editedText(sheet, [1], false)).toBe("﻿a,c\r\n \t\r\n1,3\r\n4\n");
  });

  it("marks the first header field inside its quotes", () => {
    expect(editedText(readFrameworkSheet('"note",Note\n,x\n'), [], true)).toBe('"#note",Note\n,x\n');
    expect(editedText(readFrameworkSheet("note,Note\n,x\n"), [], true)).toBe("#note,Note\n,x\n");
  });

  it("refuses to mark a column it removes, or to edit a sheet it cannot split", () => {
    expect(editedText(readFrameworkSheet("a,b\n"), [0], true)).toBeNull();
    expect(editedText(readFrameworkSheet('a,b\n"x"y,z\n'), [1], false)).toBeNull();
    expect(editedText(readFrameworkSheet(""), [], false)).toBeNull();
  });
});

describe("frameworkIsHeaderRow (TestIsHeaderRow, TestABlankCellIsAbsentHoweverTheFileWasRead)", () => {
  it.each<[string[], boolean]>([
    [["step", "object", "question", "answer", "x", "y", "zoom"], true],
    [["paso", "objeto", "pregunta", "respuesta", "x", "y", "zoom"], true],
    [["1", "textile-001", "What is this?", "A textile.", "0.5", "0.5", "1.0"], false],
    [["Step", "OBJECT", "Question", "answer"], true],
    [["step", "object", "question", "unknown_col", "x"], true],
    [["value1", "value2", "step", "value3", "value4"], false],
    [["step", "object", "", "", "question"], true],
    [["", "", "", ""], false],
  ])("%j is a header row: %s", (row, verdict) => {
    expect(frameworkIsHeaderRow(row)).toBe(verdict);
  });

  it.each(["", "   ", "\t"])("a header row padded with %j is still a header", (blank) => {
    expect(frameworkIsHeaderRow(["id_termino", "titulo", "definicion", blank, blank])).toBe(true);
  });

  it.each(["", "   "])("a data row padded with %j is still data", (blank) => {
    expect(frameworkIsHeaderRow(["encomienda", "Encomienda", "A grant of labour.", blank, blank])).toBe(false);
  });

  it.each(["quoted_in_stories", "citado_en_historias", "citada_en_historias"])(
    "a header naming the removed column %s is still a header",
    (spelling) => {
      expect(frameworkIsHeaderRow(["id_termino", "titulo", "definicion", spelling])).toBe(true);
    },
  );

  it("does not rescue a term row with a legacy spelling", () => {
    expect(frameworkIsHeaderRow(["encomienda", "Encomienda", "Un sistema de trabajo.", "otra-historia"])).toBe(false);
  });

  it.each([[[]], [["", "", "", ""]], [["  ", "", "\n"]]])("a row of nothing is not a header: %j", (row) => {
    expect(frameworkIsHeaderRow(row)).toBe(false);
  });

  it.each(["privado", "protegido"])("the masculine form %s reads as a header row", (header) => {
    expect(frameworkIsHeaderRow(["orden", "titulo", "subtitulo", header])).toBe(true);
  });

  it("counts the glossary's own aliases on the glossary", () => {
    expect(frameworkIsHeaderRow(["id_término", "titulo", "definición", "tipo"], FRAMEWORK_GLOSSARY_COLUMN_ALIASES)).toBe(true);
    expect(frameworkIsHeaderRow(["term_id", "title", "definition", "kind"], FRAMEWORK_GLOSSARY_COLUMN_ALIASES)).toBe(true);
    expect(frameworkIsHeaderRow(["id_término", "titulo", "definición", "tipo"])).toBe(false);
  });
});

describe("dataRows", () => {
  it("leaves out comment rows and a bilingual header row first among the rest", () => {
    const sheet = readFrameworkSheet(
      "object_id,title,medium,object_type\n# instructions,,,write here\nid_objeto,titulo,medio,tipo_objeto\nmap-1,A map,Ink,\n",
    );
    expect(dataRows(sheet)).toEqual([["map-1", "A map", "Ink", ""]]);
  });

  it("judges the header row on the columns the build keeps", () => {
    // Five names, four known: a header row. Marking the first column leaves three of four.
    const text = "note,Note,step,answer,object,extra\npregunta,,paso,respuesta,objeto,libre\n,x,1,Here.,map-1,e\n";
    expect(dataRows(readFrameworkSheet(text))).toHaveLength(1);
    expect(dataRows(readFrameworkSheet(`#${text}`))).toHaveLength(2);
  });

  it("reads a first cell with a leading space before `#` as a comment", () => {
    expect(dataRows(readFrameworkSheet("a,b\n  #x,1\ny,2\n"))).toEqual([["y", "2"]]);
  });

  it("finds values after stripping, as CPython strips", () => {
    const rows = [["a", " \u0085 "], ["b"]];
    expect(holdsValues(rows, 1)).toBe(false);
    expect(holdsValues([["a", "﻿"]], 1)).toBe(true);
  });
});

describe("claimedNames", () => {
  it("claims the mapped name or the folded label, in the order first claimed, and skips `#` labels", () => {
    expect(claimedNames(["Step", "paso", " note ", "#medium", "Note"])).toEqual(
      new Map([["step", [0, 1]], ["note", [2, 4]]]),
    );
  });

  describe("TestTwoColumnsCannotClaimOneName", () => {
    it.each([
      ["orden", "titulo", "privado", "protected"],
      ["orden", "titulo", "protected", "privado"],
      ["orden", "titulo", "protegido", "protected"],
      ["orden", "titulo", "privado", "privada"],
    ])("an alias beside another spelling of its name collides: %j", (...labels) => {
      expect(collisions(labels)).toHaveLength(1);
    });

    it("an ordinary sheet claims its canonical names", () => {
      expect([...claimedNames(["orden", "titulo", "privado"]).keys()]).toEqual(["order", "title", "protected"]);
      expect(collisions(["order", "title"])).toEqual([]);
    });
  });

  describe("TestCaseAndSpacingDoNotGetPastTheCollisionRefusal", () => {
    it.each([
      ["term_id", "Note", "note"],
      ["term_id", "note", "NOTE"],
      ["term_id", "note", " note "],
      ["term_id", "Title", "title"],
      ["protected", "Protegido"],
      ["Protected", "privado"],
      ["PRIVADO", "protegido"],
    ])("two spellings of one header collide: %j", (...labels) => {
      expect(collisions(labels)).toHaveLength(1);
    });

    it.each([[["Title"]], [["Title", "Note"]], [["term_id", "Title", "definition"]]])(
      "one spelling of each header does not: %j",
      (labels) => {
        expect(collisions(labels)).toEqual([]);
      },
    );
  });

  describe("TestTheAliasMapIsScopedToTheSheetItRunsOn", () => {
    it("an objects sheet keeps the author's own privado", () => {
      expect([...claimedNames(["id_objeto", "privado"], OBJECTS).keys()]).toEqual(["object_id", "privado"]);
    });

    it("a story sheet reads it as the protection flag", () => {
      expect([...claimedNames(["paso", "privado"]).keys()]).toEqual(["step", "protected"]);
    });

    it.each([
      ["titulo", "title"], ["fuente", "source"], ["medio", "medium"], ["creador", "creator"],
      ["año", "year"], ["descripcion", "description"], ["crédito", "credit"],
    ])("the objects sheet still reads %s as %s", (alias, canonical) => {
      expect([...claimedNames([alias], OBJECTS).keys()]).toEqual([canonical]);
    });

    it("an unscoped sheet gets the whole map", () => {
      expect([...claimedNames(["id_termino", "definicion"]).keys()]).toEqual(["term_id", "definition"]);
    });
  });

  describe("tipo is the glossary's alone (test_glossary_kinds.py)", () => {
    it("the glossary reads tipo as kind, and kind beside it collides", () => {
      expect([...claimedNames(["id_termino", "titulo", "tipo"], GLOSSARY).keys()]).toEqual(["term_id", "title", "kind"]);
      expect(collisions(["term_id", "title", "kind", "tipo"], GLOSSARY)).toEqual([[2, 3]]);
    });

    it("a story or objects sheet keeps tipo", () => {
      expect([...claimedNames(["paso", "objeto", "tipo"]).keys()]).toContain("tipo");
      expect([...claimedNames(["id_objeto", "titulo", "tipo"], OBJECTS).keys()]).toContain("tipo");
      expect(collisions(["term_id", "title", "kind", "tipo"])).toEqual([]);
    });
  });

  it("privado beside protected on an objects sheet is not a collision", () => {
    expect(collisions(["object_id", "title", "protected", "privado"], OBJECTS)).toEqual([]);
  });

  it("medium beside object_type on an objects sheet is", () => {
    expect(collisions(["object_id", "title", "medium", "object_type"], OBJECTS)).toEqual([[2, 3]]);
  });
});

describe("pythonLower", () => {
  it("leaves as they are the code points the build's Python 3.11 has no lowercase for", () => {
    // Node folds both of these to U+A7CF; Python 3.11 lowers neither.
    expect(pythonLower("\ua7ce\ua7cf")).toBe("\ua7ce\ua7cf");
    expect(pythonLower("NOTE\u1c89")).toBe("note\u1c89");
    expect(pythonLower("\u0130")).toBe("i\u0307");
  });

  it("judges a final sigma in context, with such a code point ending the context", () => {
    expect(pythonLower("ΑΣ Α")).toBe("ας α");
    expect(pythonLower("ΑΣΑ")).toBe("ασα");
    expect(pythonLower("ΑΣ\ua7cbΑ")).toBe("ας\ua7cbα");
  });

  it("keeps two headers apart that Node would fold together", () => {
    expect(claimedNames(["step", "answer", "\ua7ce", "\ua7cf"])).toEqual(
      new Map([["step", [0]], ["answer", [1]], ["\ua7ce", [2]], ["\ua7cf", [3]]]),
    );
  });
});

describe("foldHeader", () => {
  it("equals lower-then-strip, the framework's order, over every BMP code point alone and beside a letter", () => {
    const pythonOrder = (s: string) => pythonStrip(pythonLower(s));
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      for (const s of [ch, `A${ch}`, `${ch}A`, ` ${ch} `, `Σ${ch}`]) {
        if (foldHeader(s) !== pythonOrder(s)) throw new Error(`differs on ${JSON.stringify(s)}`);
      }
    }
  });

  it("leaves as they are the letters the build's Python 3.11 does not lower", () => {
    expect(foldHeader("\ua7ce")).toBe("\ua7ce");
    expect(foldHeader(" NOTE\u1c89 ")).toBe("note\u1c89");
    for (const cp of LOWERED_ONLY_AFTER_UNICODE_14) {
      const ch = String.fromCodePoint(cp);
      expect(foldHeader(ch), cp.toString(16)).toBe(ch);
    }
  });

  it("does not report two headers the build keeps apart as one column", () => {
    expect(collidingHeaderGroups(["title", "\ua7ce", "\ua7cf"])).toEqual([]);
    expect(collidingHeaderGroups(["\ua7ce", "\ua7cf"], FRAMEWORK_OBJECTS_READER)).toEqual([]);
    expect(collidingHeaderGroups(["Note", "note"])).toEqual([["Note", "note"]]);
  });
});
