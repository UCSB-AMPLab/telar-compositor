/**
 * The record scanner and Papa agree about where every record ends.
 *
 * `CsvCommentExtractionError` is thrown only when `readCsvSourceRows` returns
 * null, which it does only when the Compositor's own record scanner
 * (`recordFieldsEnd`) and Papa's parser draw a record boundary in two places,
 * or read the same record's characters as different cells. No input is known
 * to reach that branch, so the two tests that cover the refusal mock the
 * reader. This file is what makes the branch unreachable by construction: it
 * runs the real reader over every short string of the characters that matter
 * to CSV framing, over seeded random strings, over generated line-ending,
 * byte-order-mark, quote and blank-line mixes, over the files whose size puts
 * Papa's line-ending guess on a 1 MiB sample, and over every CSV committed
 * under tests/fixtures, and asserts a reading comes back whose rows hold the
 * cells Papa read and whose ranges tile the source in order. A change to the
 * scanner or to papaparse that makes the refusal reachable fails here.
 *
 * Short strings cannot show a disagreement that needs a long quoted field or
 * the 1 MiB sample; the three large cases below are the ones that can.
 *
 * @version v1.5.0-beta
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { readCsvSourceRows } from "~/lib/csv-record-scan.server";
import { TELAR_CSV_PARSE_CONFIG } from "~/lib/import.server";

const BOM = "﻿";

/** The first input the reader refuses, or a description of how it disagrees with Papa. */
function disagreement(source: string): string | null {
  const reading = readCsvSourceRows(source);
  if (reading === null) return "readCsvSourceRows returned null";
  const papa = Papa.parse<string[]>(source, TELAR_CSV_PARSE_CONFIG).data;
  if (reading.rows.length !== papa.length) {
    return `${reading.rows.length} rows against Papa's ${papa.length}`;
  }
  let previousEnd = 0;
  for (let i = 0; i < papa.length; i++) {
    const row = reading.rows[i];
    if (JSON.stringify(row.cells) !== JSON.stringify(papa[i])) return `row ${i} cells differ from Papa's`;
    if (row.range.start < previousEnd || row.range.end <= row.range.start) return `row ${i} range overlaps or is empty`;
    previousEnd = row.range.end;
  }
  return null;
}

function expectAgreement(inputs: Iterable<string>): number {
  let count = 0;
  for (const source of inputs) {
    count += 1;
    const found = disagreement(source);
    if (found !== null) {
      throw new Error(`scanner and Papa disagree on ${JSON.stringify(source)}: ${found}`);
    }
  }
  return count;
}

/** Every string of length 1 to `max` over `alphabet`. */
function* everyString(alphabet: readonly string[], max: number): Generator<string> {
  let layer: string[] = [""];
  for (let length = 1; length <= max; length++) {
    const next: string[] = [];
    for (const prefix of layer) for (const token of alphabet) next.push(prefix + token);
    yield* next;
    layer = next;
  }
}

/** A small deterministic generator, so a failure names an input that can be rebuilt. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("the record scanner and Papa agree about record boundaries", () => {
  it("agree on every string of length 1 to 5 over the framing characters", () => {
    const alphabet = [",", '"', "\n", "\r", " ", "#", "a", BOM];
    expect(expectAgreement(everyString(alphabet, 5))).toBe(37448);
  });

  it("agree on seeded random strings over a wider alphabet", () => {
    const tokens = [
      ",", '"', "\n", "\r", "\r\n", " ", "#", "a", "\t", ";", BOM, '""', "x,y", '"a"  ', "\n\n",
      "é", "# ", " ", "\r\r", "\n\r",
    ];
    const next = seeded(566);
    const inputs: string[] = [];
    for (let n = 0; n < 20000; n++) {
      const length = 1 + Math.floor(next() * 40);
      let source = "";
      for (let i = 0; i < length; i++) source += tokens[Math.floor(next() * tokens.length)];
      inputs.push(source);
    }
    expect(expectAgreement(inputs)).toBe(20000);
  });

  it("agree on files built from records under every line-ending, BOM, quote and blank-line mix", () => {
    const records = [
      "object_id,title",
      "obj-1,Un objeto",
      '"obj-2","line one\nline two"',
      '"obj-3","line one\r\nline two"',
      '"obj-4","a ""quoted"" word"',
      '"trailing quote"',
      '"closed"  ',
      "# an instruction,,",
      '"# a quoted instruction",x',
      "",
      "   ",
      ",,",
      "a,b,c,d,e",
      `${BOM}obj-5,mid-file mark`,
      'obj-6,"unfinished',
    ];
    const terminators = ["\n", "\r\n", "\r"];
    const next = seeded(276);
    const inputs: string[] = [];
    for (const lead of ["", BOM]) {
      for (const tail of ["", "\n", "\r\n", "\r", "\n\n"]) {
        for (let n = 0; n < 1500; n++) {
          const count = 1 + Math.floor(next() * 7);
          let source = lead;
          for (let i = 0; i < count; i++) {
            source += records[Math.floor(next() * records.length)];
            if (i < count - 1) source += terminators[Math.floor(next() * terminators.length)];
          }
          inputs.push(source + tail);
        }
      }
    }
    expect(expectAgreement(inputs)).toBe(15000);
  });

  it("agree where each single terminator is the file's own and the others are content", () => {
    const inputs: string[] = [];
    for (const own of ["\n", "\r\n", "\r"]) {
      for (const other of ["\n", "\r\n", "\r"].filter((t) => t !== own)) {
        inputs.push(
          [`a,b`, `"x${other}y",z`, `c,"p${other}q"`, `# note`].join(own),
          [`${BOM}a,b`, `"x${other}y",z`, `"unterminated${other}`].join(own),
          `a,b${own}c,"d"${other}e${own}`,
        );
      }
    }
    expect(expectAgreement(inputs)).toBe(18);
  });

  it("agree past Papa's 1 MiB line-ending sample", () => {
    const filler = "row,value\n".repeat(110000);
    expect(filler.length).toBeGreaterThan(1024 * 1024);
    const crlfThenQuotedBreak = `${filler}a,b\r\n"x\r\ny",z\r\n`;
    const crlfWithUnterminatedQuote = `${"row,\"a\nb\"\r\n".repeat(90000)}last,"open\nquote`;
    const bomInCarriageReturns = `${BOM}${"row,value\r".repeat(110000)}end,1\r`;
    expect(expectAgreement([crlfThenQuotedBreak, crlfWithUnterminatedQuote, bomInCarriageReturns])).toBe(3);
  });

  it("agree on every CSV committed under tests/fixtures", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".csv")) files.push(path);
      }
    };
    walk(join(__dirname, "fixtures"));
    expect(files.length).toBeGreaterThan(3);
    expect(expectAgreement(files.map((file) => readFileSync(file, "utf8")))).toBe(files.length);
  });
});
