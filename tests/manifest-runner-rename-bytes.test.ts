/**
 * csv_rename_column changes the bytes of the header field it renames and no
 * others: line endings, quoting, the byte order mark and the final newline of
 * the rest of the file stay as the author wrote them.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect } from "vitest";
import { applyOperation } from "~/lib/manifest-runner.server";
import type { Operation } from "~/lib/manifest-schema.server";

function rename(content: string, oldName = "byline", newName = "author"): string {
  const files = new Map([["story.csv", content]]);
  const op: Operation = {
    type: "csv_rename_column",
    file_glob: "story.csv",
    old_name: oldName,
    new_name: newName,
  } as Operation;
  applyOperation(files, op, "en", []);
  return files.get("story.csv")!;
}

describe("csv_rename_column writes only the renamed header field", () => {
  it("keeps CRLF line endings and quoted data cells", () => {
    expect(rename('order,byline\r\n1,"A"\r\n')).toBe('order,author\r\n1,"A"\r\n');
  });

  it("keeps LF line endings", () => {
    expect(rename('order,byline\n1,"A"\n')).toBe('order,author\n1,"A"\n');
  });

  it("keeps mixed line endings", () => {
    expect(rename('order,byline\r\n1,"A"\n2,B\r\n')).toBe('order,author\r\n1,"A"\n2,B\r\n');
  });

  it("keeps the byte order mark", () => {
    expect(rename("﻿order,byline\r\n1,A\r\n")).toBe("﻿order,author\r\n1,A\r\n");
  });

  it("renames the first column of a sheet that opens with the byte order mark", () => {
    expect(rename('\uFEFFbyline,order\r\n"1",A\r\n')).toBe('\uFEFFauthor,order\r\n"1",A\r\n');
  });

  it("keeps the quotes a quoted header field had", () => {
    expect(rename('"order","byline"\r\n1,A\r\n')).toBe('"order","author"\r\n1,A\r\n');
  });

  it("quotes a new name that needs it", () => {
    expect(rename("order,byline\n1,A\n", "byline", 'by, "line"')).toBe('order,"by, ""line"""\n1,A\n');
  });

  it("quotes an empty name in a one-column header, so the header line is not blank", () => {
    expect(rename("byline\n1\n", "byline", "")).toBe('""\n1\n');
  });

  it("keeps a missing final newline missing", () => {
    expect(rename("order,byline\n1,A")).toBe("order,author\n1,A");
  });

  it("leaves quoted cells holding commas, quotes and line breaks alone", () => {
    const rows = '1,"a, ""b""\r\nc"\r\n';
    expect(rename(`order,byline\r\n${rows}`)).toBe(`order,author\r\n${rows}`);
  });

  it("renames a quoted header field that holds a comma", () => {
    expect(rename('order,"by,line"\n1,A\n', "by,line", "author")).toBe('order,"author"\n1,A\n');
  });

  it("renames both rows of a bilingual header and nothing else", () => {
    const files = new Map([["story.csv", "order,byline\r\norden,firma\r\n1,\"A\"\r\n"]]);
    applyOperation(
      files,
      {
        type: "csv_rename_column",
        file_glob: "story.csv",
        old_name: { en: "byline", es: "firma" },
        new_name: { en: "author", es: "autor" },
      } as Operation,
      "en",
      [],
    );
    expect(files.get("story.csv")).toBe('order,author\r\norden,autor\r\n1,"A"\r\n');
  });

  it("keeps blank lines above the header", () => {
    expect(rename("\r\n\r\norder,byline\r\n1,A\r\n")).toBe("\r\n\r\norder,author\r\n1,A\r\n");
  });
});

function addX(content: string, after = "order", def = ""): string {
  const files = new Map([["story.csv", content]]);
  const op = { type: "csv_add_column", file_glob: "story.csv", column: "x", after, default: def } as Operation;
  applyOperation(files, op, "en", []);
  return files.get("story.csv")!;
}

describe("csv_add_column writes only the inserted fields", () => {
  it("keeps CRLF and quoted data cells", () => {
    expect(addX('order,title\r\n1,"A"\r\n')).toBe('order,x,title\r\n1,,"A"\r\n');
  });

  it("keeps LF line endings", () => {
    expect(addX('order,title\n1,"A"\n')).toBe('order,x,title\n1,,"A"\n');
  });

  it("keeps mixed line endings", () => {
    expect(addX('order,title\r\n1,"A"\n2,B\r\n')).toBe('order,x,title\r\n1,,"A"\n2,,B\r\n');
  });

  it("keeps the byte order mark", () => {
    expect(addX("﻿order,title\r\n1,A\r\n")).toBe("﻿order,x,title\r\n1,,A\r\n");
  });

  it("keeps quoted header fields", () => {
    expect(addX('"order","title"\n1,A\n')).toBe('"order",x,"title"\n1,,A\n');
  });

  it("keeps a missing final newline missing", () => {
    expect(addX("order,title\n1,A")).toBe("order,x,title\n1,,A");
  });

  it("writes the default, quoted when it needs it", () => {
    expect(addX("order,title\n1,A\n", "order", "a, b")).toBe('order,x,title\n1,"a, b",A\n');
  });

  it("appends after the last column", () => {
    expect(addX('order,title\r\n1,"A"\r\n', "title")).toBe('order,title,x\r\n1,"A",\r\n');
  });

  it("pads a short row up to the insertion point", () => {
    expect(addX("order,title,note\n1\n", "note")).toBe("order,title,note,x\n1,,,\n");
  });

  it("keeps quoted cells holding commas, quotes and line breaks", () => {
    const row = '1,"a, ""b""\r\nc"\r\n';
    expect(addX(`order,title\r\n${row}`)).toBe('order,x,title\r\n1,,"a, ""b""\r\nc"\r\n');
  });

  it("adds to both rows of a bilingual header and keeps blank lines", () => {
    const files = new Map([["story.csv", "\r\norder,title\r\n\r\norden,titulo\r\n1,\"A\"\r\n"]]);
    applyOperation(
      files,
      {
        type: "csv_add_column",
        file_glob: "story.csv",
        column: { en: "x", es: "equis" },
        after: { en: "order", es: "orden" },
        default: "",
      } as Operation,
      "en",
      [],
    );
    expect(files.get("story.csv")).toBe('\r\norder,x,title\r\n\r\norden,equis,titulo\r\n1,,"A"\r\n');
  });
});
