/**
 * One CSV, three traversals, one classification.
 *
 * The importer (`parseTelarCsv`, its own `Papa.parse`), the record scanner
 * (`readCsvSourceRows`, two more parses, with `createCsvRecordSkipDetector`
 * applied to its rows as `removeObjectRecord`, `objectRowTexts` and
 * `parseSheetObjectIds` apply it) and the detector run directly over a plain
 * `Papa.parse` of the source each decide which records are data. A record one
 * imports and another skips is an object whose deletion reports its record
 * absent while the record stays. A shared predicate keeps their rules equal
 * but not their inputs, so this file generates files and asks all of them
 * about every record: comment rows, the bilingual header row at every position
 * it can occupy, blank rows of every kind Papa and pandas disagree over, ids
 * that open `#`, rows wider and narrower than the header, a `#` column, a BOM,
 * and each line ending. It asserts the three agree on which records are data,
 * and that the comment rows `extractCommentRows` carries and the record
 * `removeObjectRecord` cuts for each id are the records those verdicts name.
 *
 * @version v1.5.0-beta
 */

import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { extractCommentRows } from "~/lib/csv-export.server";
import { readCsvSourceRows, removeObjectRecord } from "~/lib/csv-record-scan.server";
import {
  OBJECTS_CANONICAL_SCOPE,
  TELAR_CSV_PARSE_CONFIG,
  createCsvRecordSkipDetector,
  instructionHeaderOf,
  parseTelarCsv,
} from "~/lib/import.server";
import { parseSheetObjectIds } from "~/lib/pending-object-ops.server";

const BOM = "﻿";

/** One generated record, `n` making its id and title its own. */
const KINDS: Record<string, (n: number) => string> = {
  data: (n) => `d${n},Title ${n},Creator ${n},Source ${n}`,
  dataWide: (n) => `d${n},Title ${n},c,s,x,y`,
  dataNarrow: (n) => `d${n}`,
  dataQuotedBreak: (n) => `d${n},"Title\n${n}",c,s`,
  dataHashTitle: (n) => `d${n},# title ${n},c,s`,
  hashId: (n) => `#d${n},Title ${n},c,s`,
  spacedHashId: (n) => ` #d${n},Title ${n},c,s`,
  quotedHashId: (n) => `"#d${n}",Title ${n},c,s`,
  comment: (n) => `# note ${n},,,`,
  commentBare: (n) => `# note ${n}`,
  commentQuotedBreak: (n) => `"# note\n${n}",x`,
  bilingual: () => "id_objeto,titulo,creador,fuente",
  bilingualPadded: () => "id_objeto,titulo,creador,fuente,",
  bilingualNote: () => "id_objeto,titulo,creador,fuente,Notas de la autora,Otras notas",
  headerLike: () => "source,Creator,Title,Object",
  blank: () => "",
  blankSpaces: () => "   ",
  blankTab: () => "\t",
  blankVtab: () => "\u000b",
  blankCommas: () => ",",
  blankCommasWide: () => ",,,",
};

const KIND_NAMES = Object.keys(KINDS);

const HEADERS = ["object_id,title,creator,source", "object_id,title,creator,source,#notes,#more", "object_id,title,#creator,source"];

/** Records joined by `terminator`, the header first, a BOM optionally ahead of it. */
function build(header: string, kinds: readonly string[], terminator: string, lead: string, tail: string): string {
  const records = [header, ...kinds.map((kind, i) => KINDS[kind](i + 1))];
  return lead + records.join(terminator) + tail;
}

type Verdict = "data" | "comment" | "bilingual-header" | "blank";

/** The detector, run directly over a plain Papa.parse of `source`. */
function directVerdicts(source: string): { cells: string[]; verdict: Verdict }[] {
  const table = Papa.parse<string[]>(source, TELAR_CSV_PARSE_CONFIG).data;
  if (table.length === 0) return [];
  const detect = createCsvRecordSkipDetector(false, instructionHeaderOf(table));
  return table.slice(1).map((cells) => {
    const v = detect(cells, table[0].length);
    return { cells, verdict: v.skip ? (v.reason as Verdict) : "data" };
  });
}

/** The same detector over the scanner's rows, as `removeObjectRecord` builds it. */
function scannerVerdicts(source: string): { cells: string[]; verdict: Verdict; text: string; start: number; end: number }[] | null {
  const reading = readCsvSourceRows(source);
  if (reading === null) return null;
  const rows = reading.rows.map((row) => row.cells);
  if (rows.length === 0) return [];
  const detect = createCsvRecordSkipDetector(false, instructionHeaderOf(rows));
  return reading.rows.slice(1).map((row) => {
    const v = detect(row.cells, rows[0].length);
    return {
      cells: row.cells,
      verdict: v.skip ? (v.reason as Verdict) : "data",
      text: row.range.text,
      start: row.range.start,
      end: row.range.end,
    };
  });
}

/** The first disagreement among the traversals on `source`, or null. */
function classificationDisagreement(source: string): string | null {
  const direct = directVerdicts(source);
  const scanned = scannerVerdicts(source);
  if (scanned === null) return "the scanner refused the source";
  if (direct.length !== scanned.length) return `${direct.length} records directly, ${scanned.length} scanned`;
  for (let i = 0; i < direct.length; i++) {
    if (direct[i].verdict !== scanned[i].verdict) {
      return `record ${i + 1}: direct ${direct[i].verdict}, scanner ${scanned[i].verdict}`;
    }
  }

  const keptDirect = direct.filter((r) => r.verdict === "data").map((r) => r.cells[0] ?? "");
  const imported = parseTelarCsv(source, undefined, false, OBJECTS_CANONICAL_SCOPE).map((row) => row.object_id ?? "");
  if (JSON.stringify(imported) !== JSON.stringify(keptDirect)) {
    return `importer kept ${JSON.stringify(imported)}, classification kept ${JSON.stringify(keptDirect)}`;
  }

  const comments = extractCommentRows(source);
  const commentTexts = scanned.filter((r) => r.verdict === "comment").map((r) => r.text);
  // A comment on the header's own line is not in the data records at all.
  const headerComment = comments.length === commentTexts.length + 1 ? comments.slice(1) : comments;
  if (JSON.stringify(headerComment) !== JSON.stringify(commentTexts)) {
    return `extractCommentRows carried ${JSON.stringify(comments)}, the verdicts name ${JSON.stringify(commentTexts)}`;
  }

  const sheetIds = parseSheetObjectIds(source);
  if (sheetIds.kind === "ids") {
    const expected = new Set(keptDirect.filter((id) => id.trim() !== ""));
    if (JSON.stringify([...sheetIds.ids].sort()) !== JSON.stringify([...expected].sort())) {
      return `parseSheetObjectIds read ${JSON.stringify([...sheetIds.ids])}, classification kept ${JSON.stringify([...expected])}`;
    }
  }

  for (const record of scanned.filter((r) => r.verdict === "data")) {
    const id = record.cells[0];
    if (id === undefined || id.trim() === "" || keptDirect.filter((k) => k === id).length !== 1) continue;
    const removal = removeObjectRecord(source, id);
    if (removal.status !== "removed") return `removeObjectRecord(${JSON.stringify(id)}) answered ${removal.status}`;
    const cut = source.slice(0, record.start) + source.slice(record.end);
    if (removal.text !== cut) return `removeObjectRecord(${JSON.stringify(id)}) cut something other than that record`;
  }
  return null;
}

function expectClassificationAgreement(sources: Iterable<string>): number {
  let count = 0;
  for (const source of sources) {
    count += 1;
    const found = classificationDisagreement(source);
    if (found !== null) throw new Error(`classification disagrees on ${JSON.stringify(source)}: ${found}`);
  }
  return count;
}

/** Every sequence of 1 to `max` kinds. */
function* sequences(max: number): Generator<string[]> {
  let layer: string[][] = [[]];
  for (let length = 1; length <= max; length++) {
    const next: string[][] = [];
    for (const prefix of layer) for (const kind of KIND_NAMES) next.push([...prefix, kind]);
    yield* next;
    layer = next;
  }
}

describe("the importer, the scanner and the detector classify every record alike", () => {
  it("agree on every sequence of three record kinds under each header, line ending and BOM", () => {
    const inputs: string[] = [];
    for (const header of HEADERS) {
      for (const kinds of sequences(3)) {
        for (const [terminator, lead, tail] of [["\n", "", "\n"], ["\r\n", BOM, ""], ["\r", "", "\r"]] as const) {
          inputs.push(build(header, kinds, terminator, lead, tail));
        }
      }
    }
    expect(expectClassificationAgreement(inputs)).toBe(HEADERS.length * (21 + 21 ** 2 + 21 ** 3) * 3);
  }, 60000);

  it("agree on longer seeded sequences with the bilingual row and blanks anywhere", () => {
    let state = 276;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    const inputs: string[] = [];
    for (let n = 0; n < 6000; n++) {
      const length = 4 + Math.floor(next() * 8);
      const kinds = Array.from({ length }, () => KIND_NAMES[Math.floor(next() * KIND_NAMES.length)]);
      const header = HEADERS[Math.floor(next() * HEADERS.length)];
      const terminator = ["\n", "\r\n", "\r"][Math.floor(next() * 3)];
      inputs.push(build(header, kinds, terminator, next() < 0.3 ? BOM : "", next() < 0.5 ? terminator : ""));
    }
    expect(expectClassificationAgreement(inputs)).toBe(6000);
  }, 60000);

  it("agree on the files the bilingual-header tests are written around", () => {
    const sources = [
      "object_id,title,creator,source\n# comment\nid_objeto,titulo,creador,fuente\nd1,One,c,s\n",
      "object_id,title,creator,source\nd1,One,c,s\nid_objeto,titulo,creador,fuente\nd2,Two,c,s\n",
      "object_id,title,creator,source\n\n   \nid_objeto,titulo,creador,fuente\nd1,One,c,s\n",
      "object_id,title,creator,#notes\n,,,\nid_objeto,titulo,creador,nota\nd1,One,c,x\n",
      'object_id,title,creator,source\n#d1,One,c,s\n "#d2",Two,c,s\nd3,Three,c,s\n',
      "object_id,title,creator,source\nid_objeto,titulo,creador,fuente\nsource,Creator,Title,Object\n",
      `${BOM}object_id,title,creator,source\r\nid_objeto,titulo,creador,fuente\r\nd1,One,c,s\r\n`,
    ];
    expect(expectClassificationAgreement(sources)).toBe(sources.length);
  });
});
