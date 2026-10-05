/**
 * `pythonCsvRows` and `pythonCsvLine` against answers CPython 3.14 gave for
 * each input, recorded here so the suite holds them without the framework
 * checkout. `framework-sheet-parity.test.ts` runs the same functions against
 * the interpreter itself over random texts.
 *
 * @version v1.5.0-beta
 */
import { describe, expect, it } from "vitest";

import { pythonCsvLine, pythonCsvRows } from "~/lib/python-csv";

describe("pythonCsvRows", () => {
  it.each<[string, string[][]]>([
    ["a,b\nc,d\n", [["a", "b"], ["c", "d"]]],
    ["a,b", [["a", "b"]]],
    ["", []],
    ["\r\n\n\r", [[], [], []]],
    ["a\rb", [["a"], ["b"]]],
    ["a,\n", [["a", ""]]],
    [",", [["", ""]]],
  ])("splits records and fields: %j", (text, rows) => {
    expect(pythonCsvRows(text)).toEqual(rows);
  });

  it.each<[string, string[][]]>([
    ['a,"b"c,d\n', [["a", "bc", "d"]]],
    ['"a" ,b', [["a ", "b"]]],
  ])("keeps text after a closing quote in the field: %j", (text, rows) => {
    expect(pythonCsvRows(text)).toEqual(rows);
  });

  it("reads a quote in the middle of an unquoted field as itself", () => {
    expect(pythonCsvRows('a"b,c')).toEqual([['a"b', "c"]]);
  });

  it.each<[string, string[][]]>([
    ['"a', [["a"]]],
    ['"', [[""]]],
    ['a,"', [["a", ""]]],
    ['x\n"a\nb', [["x"], ["a\nb"]]],
  ])("saves a field left open at the end of the data: %j", (text, rows) => {
    expect(pythonCsvRows(text)).toEqual(rows);
  });

  it.each<[string, string[][]]>([
    ['"a\r\nb"', [["a\r\nb"]]],
    ['"a"\r', [["a"]]],
    ['"""', [['"']]],
    ['"a""', [['a"']]],
    ['""', [[""]]],
  ])("reads quoted fields and doubled quotes: %j", (text, rows) => {
    expect(pythonCsvRows(text)).toEqual(rows);
  });

  it("reads a NUL as an ordinary character", () => {
    expect(pythonCsvRows("a\u0000b,c")).toEqual([["a\u0000b", "c"]]);
  });

  it("reads a 200,000-character cell", () => {
    const cell = "x".repeat(200_000);
    expect(pythonCsvRows(`a,"${cell}"\n`)).toEqual([["a", cell]]);
  });
});

describe("pythonCsvLine", () => {
  it("quotes what minimal quoting quotes, and ends the line with CRLF", () => {
    expect(pythonCsvLine([" a", 'b"', "﻿x", ""])).toBe(' a,"b""",﻿x,\r\n');
    expect(pythonCsvLine(["a,b", "c\nd", "e\rf"])).toBe('"a,b","c\nd","e\rf"\r\n');
  });

  it("writes a lone empty cell as a quoted one", () => {
    expect(pythonCsvLine([""])).toBe('""\r\n');
  });
});
