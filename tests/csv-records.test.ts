/**
 * Record boundaries, the rule both the serializers and the record scanner
 * hold: a record is delimited by the quoting, never by a physical line.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import Papa from "papaparse";
import { splitCsvRecords } from "~/lib/csv-records";

describe("splitCsvRecords", () => {
  it("returns nothing for an empty text", () => {
    expect(splitCsvRecords("", ",", "\n")).toEqual([]);
  });

  it("returns each record without its terminator", () => {
    expect(splitCsvRecords("a,b\nc,d\n", ",", "\n")).toEqual(["a,b", "c,d"]);
  });

  it("returns a final record that carries no terminator", () => {
    expect(splitCsvRecords("a,b\nc,d", ",", "\n")).toEqual(["a,b", "c,d"]);
  });

  it("takes one terminator for the whole text, the one it is given", () => {
    // Read on CR, the LF is content in the second record's first field rather
    // than a terminator of its own.
    expect(splitCsvRecords("a,b\r\nc,d\re,f", ",", "\r")).toEqual(["a,b", "\nc,d", "e,f"]);
  });

  it("agrees with Papa on a mixed-terminator text read with Papa's own pair", () => {
    const text = "a,b\r\nc,d\re,f";
    const papa = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true });

    expect([papa.meta.delimiter, papa.meta.linebreak]).toEqual([",", "\r"]);
    expect(splitCsvRecords(text, papa.meta.delimiter, papa.meta.linebreak)).toHaveLength(
      papa.data.length,
    );
  });

  it("reads a text on the delimiter it is given, not on the comma", () => {
    expect(splitCsvRecords('a;"b;c"\nd;e', ";", "\n")).toEqual(['a;"b;c"', "d;e"]);
    expect(splitCsvRecords('a;"b\nc"\nd;e', ";", "\n")).toEqual(['a;"b\nc"', "d;e"]);
  });

  it("keeps a newline inside a quoted field as content", () => {
    expect(splitCsvRecords('a,"b\nc"\nd,e', ",", "\n")).toEqual(['a,"b\nc"', "d,e"]);
  });

  it("keeps a CRLF inside a quoted field as content", () => {
    expect(splitCsvRecords('a,"b\r\nc"\r\nd,e', ",", "\r\n")).toEqual(['a,"b\r\nc"', "d,e"]);
  });

  it("reads a doubled quote inside a quoted field as a literal quote", () => {
    expect(splitCsvRecords('a,"say ""hi"",\nthen go"\nb,c', ",", "\n")).toEqual([
      'a,"say ""hi"",\nthen go"',
      "b,c",
    ]);
  });

  it("treats a quote that does not open a field as an ordinary character", () => {
    expect(splitCsvRecords('a,b"c\nd,e', ",", "\n")).toEqual(['a,b"c', "d,e"]);
  });

  it("keeps scanning past a quote followed by text, as Papa does", () => {
    // Papa closes a quoted field only at a quote followed by the delimiter, a
    // terminator or the end of the text. `"a"b` is none of those, so the field
    // runs on and swallows the line below.
    expect(splitCsvRecords('"a"b,c\n#keep,d', ",", "\n")).toEqual(['"a"b,c\n#keep,d']);
    expect(Papa.parse<string[]>('"a"b,c\n#keep,d', { header: false }).data).toHaveLength(1);
  });

  it("closes a quoted field at a quote followed by spaces and the delimiter", () => {
    expect(splitCsvRecords('"a"  ,b\nc,d', ",", "\n")).toEqual(['"a"  ,b', "c,d"]);
  });

  it("closes a quoted field at a quote followed by spaces and the terminator", () => {
    expect(splitCsvRecords('a,"b"  \nc,d', ",", "\n")).toEqual(['a,"b"  ', "c,d"]);
  });

  it("keeps a blank line as a record of its own", () => {
    expect(splitCsvRecords("a\n\nb", ",", "\n")).toEqual(["a", "", "b"]);
  });

  it("leaves a leading byte-order mark on the first record", () => {
    expect(splitCsvRecords("﻿a,b\nc,d", ",", "\n")).toEqual(["﻿a,b", "c,d"]);
  });

  it("runs an unterminated quoted field to the end of the text", () => {
    expect(splitCsvRecords('a,"b\nc\nd', ",", "\n")).toEqual(['a,"b\nc\nd']);
  });

  it("puts every character of the text into exactly one record", () => {
    // Papa guesses CRLF here, so the LFs are content and the text is two
    // records — the terminator between them is the only character no record
    // carries.
    const text = 'h1,h2\r\n"a\nb",c\n\n# note\nd,"e""f"\n';
    const records = splitCsvRecords(text, ",", "\r\n");
    expect(records).toHaveLength(2);
    expect(records.join("\r\n")).toBe(text);
  });

  it("emits no trailing empty record where Papa emits one", () => {
    expect(splitCsvRecords("a,b\n", ",", "\n")).toEqual(["a,b"]);
    expect(Papa.parse<string[]>("a,b\n", { header: false }).data).toHaveLength(2);
  });
});
