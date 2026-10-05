import { describe, it, expect } from "vitest";
import Papa from "papaparse";
import {
  serializeObjectsCsv,
  extractCommentRows,
  OBJECTS_CSV_COLUMNS,
  dbObjectToCsvRow,
  type ObjectDbRow,
} from "~/lib/csv-export.server";
import { mapObjectsCsv, parseTelarCsv } from "~/lib/import.server";
import { splitCsvRecords } from "~/lib/csv-records";
import { serializeGlossaryCsv } from "~/lib/publish.server";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
  describeWithFrameworkTag,
  frameworkGlossaryTerms,
  frameworkObjectsRead,
  frameworkScriptsAtTag,
} from "./helpers/framework-checkout";

const EXPECTED_HEADER =
  "object_id,title,alt_text,featured,creator,description,source_url,period,year,medium_genre,subjects,source,credit,thumbnail,dimensions";

const EXPECTED_BILINGUAL_ROW =
  "id_objeto,titulo,texto_alt,destacado,creador,descripcion,url_fuente,periodo,año,medio_genero,temas,fuente,credito,miniatura,dimensiones";

function makeObject(overrides: Partial<{
  object_id: string;
  title: string | null;
  featured: boolean | null;
  creator: string | null;
  description: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  medium_genre: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  alt_text: string | null;
  dimensions: string | null;
  extra_columns: string | null;
}> = {}) {
  return {
    object_id: "obj-001",
    title: "Test Object",
    featured: false as boolean | null,
    creator: null as string | null,
    description: null as string | null,
    source_url: null as string | null,
    period: null as string | null,
    year: null as string | null,
    medium_genre: null as string | null,
    subjects: null as string | null,
    source: null as string | null,
    credit: null as string | null,
    thumbnail: null as string | null,
    alt_text: null as string | null,
    dimensions: null as string | null,
    extra_columns: null as string | null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractCommentRows
// ---------------------------------------------------------------------------

describe("extractCommentRows", () => {
  it("returns lines that start with # directly", () => {
    const csv = `object_id,title\n# This is an instruction row\nobj-001,Test Object`;
    const result = extractCommentRows(csv);
    expect(result).toEqual(["# This is an instruction row"]);
  });

  it("returns lines that start with quoted # (PapaParse-quoted comment fields)", () => {
    const csv = `object_id,title\n"# Instruction with comma, here",foo\nobj-001,Test`;
    const result = extractCommentRows(csv);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('"#');
  });

  it("returns multiple comment lines when present", () => {
    const csv = [
      "object_id,title",
      "# First instruction",
      "# Second instruction",
      "obj-001,Real Object",
    ].join("\n");
    const result = extractCommentRows(csv);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("# First instruction");
    expect(result[1]).toBe("# Second instruction");
  });

  it("returns empty array when no comment rows exist", () => {
    const csv = `object_id,title\nobj-001,Test Object\nobj-002,Another Object`;
    const result = extractCommentRows(csv);
    expect(result).toEqual([]);
  });

  it("returns a CRLF file's comment row without its terminator", () => {
    const csv = "object_id,title\r\n# Comment row\r\nobj-001,Test";
    const result = extractCommentRows(csv);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("# Comment row");
  });

  it("returns a CRLF file's comment row from beside a multi-line quoted field", () => {
    const csv =
      'object_id,title,"editor\r\n#note"\r\n# Comment row\r\nobj-001,Test,"a\r\n# not a comment"\r\n';
    expect(extractCommentRows(csv)).toEqual(["# Comment row"]);
  });

  it("passes over a `#` that opens a line inside a quoted field", () => {
    const csv = 'object_id,title\nobj-001,"A title\n# not a comment"\n';
    expect(extractCommentRows(csv)).toEqual([]);
  });

  it("passes over a `#` that opens a line inside a quoted header", () => {
    const csv = 'object_id,title,"editor\n#note"\nobj-001,Test,v\n';
    expect(extractCommentRows(csv)).toEqual([]);
  });

  it("keeps a quoted comment record Papa reads only with its terminator", () => {
    // `"#note"  ` closes its quote with spaces before the terminator, which is
    // Papa's `extraSpaces` rule — legal in the file, and reported
    // InvalidQuotes/MissingQuotes when the record is read with nothing after
    // it. Judged that way the author's comment is dropped.
    expect(extractCommentRows('object_id,title\n"#note"  \na,A\n')).toEqual(['"#note"  ']);
  });

  it("carries that comment through a republish byte for byte", () => {
    const output = serializeObjectsCsv(
      [makeObject({ object_id: "a", title: "A", alt_text: "alt" })],
      'object_id,title\n"#note"  \na,A\n',
    );
    expect(output.split("\n")[2]).toBe('"#note"  ');
    expect(Papa.parse<string[]>(output, { header: false }).errors).toEqual([]);
  });

  it("repairs a candidate comment record Papa reads as malformed", () => {
    // `"#note"x` opens a quoted field that never closes, so the record runs to
    // the end of the text and carries the rest of the file with it — Papa's
    // own boundary, and the reason re-inserting it verbatim swallows the data.
    // The lines after the first are data the serializer writes again from D1.
    expect(extractCommentRows('object_id,title\n"#note"x,ignored\nold,Old')).toEqual([
      "#'#note'x,ignored",
    ]);
  });

  it("leaves the data rows readable when such a record is in the existing file", () => {
    const output = serializeObjectsCsv(
      [makeObject({ object_id: "new", title: "New", alt_text: "alt" })],
      'object_id,title\n"#note"x,ignored\nold,Old',
    );
    expect(splitCsvRecords(output, ",", "\n")[2]).toBe("#'#note'x,ignored");
    const parsed = Papa.parse<string[]>(output, { header: false });
    expect(parsed.errors).toEqual([]);
    const rows = mapObjectsCsv(parseTelarCsv(output), 1);
    expect(rows.map((r) => r.object_id)).toEqual(["new"]);
  });

  it("repairs a malformed candidate opening with a bare # too", () => {
    // `#note,"abc"x` opens no quoted field in its first cell, so it is a
    // comment candidate by the bare `#` and malformed by the second cell.
    expect(extractCommentRows('object_id,title\n#note,"abc"x\nold,Old\n')).toEqual([
      "#note,'abc'x",
    ]);
  });

  it("keeps a comment row between the bilingual row and the data", () => {
    const existingCsv = [
      "object_id,title",
      "id_objeto,titulo",
      "# Example: obj-001",
      "obj-001,Test Object",
    ].join("\n");
    const output = serializeObjectsCsv([makeObject({ object_id: "obj-002" })], existingCsv);
    const records = output.split("\n");
    expect(records[0]).toBe(EXPECTED_HEADER);
    expect(records[1]).toBe(EXPECTED_BILINGUAL_ROW);
    expect(records[2]).toBe("# Example: obj-001");
    expect(records[3]).toContain("obj-002");
  });

  it("preserves comment rows through serializeObjectsCsv round-trip when existingCsv provided", () => {
    const existingCsv = [
      "object_id,title,featured,creator,description,source_url,period,year,medium_genre,subjects,source,credit,thumbnail",
      "id_objeto,titulo,destacado,creador,descripcion,url_fuente,periodo,año,medio_genero,temas,fuente,credito,miniatura",
      "# Example: obj-001",
      "obj-001,Test Object,,,,,,,,,,,",
    ].join("\n");

    const newObjects = [
      {
        object_id: "obj-002",
        title: "New Object",
        featured: false as boolean | null,
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
        alt_text: null,
      },
    ];

    const output = serializeObjectsCsv(newObjects, existingCsv);
    expect(output).toContain("# Example: obj-001");
    expect(output).toContain("obj-002");
  });
});

describe("OBJECTS_CSV_COLUMNS", () => {
  it("has correct column order (matches framework shipped template)", () => {
    expect(OBJECTS_CSV_COLUMNS).toEqual([
      "object_id",
      "title",
      "alt_text",
      "featured",
      "creator",
      "description",
      "source_url",
      "period",
      "year",
      "medium_genre",
      "subjects",
      "source",
      "credit",
      "thumbnail",
      "dimensions",
    ]);
  });
});

describe("serializeObjectsCsv", () => {
  it("Test 1: header row matches OBJECTS_CSV_COLUMNS order", () => {
    const csv = serializeObjectsCsv([makeObject(), makeObject({ object_id: "obj-002" })]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(EXPECTED_HEADER);
  });

  it("Test 2: second row is bilingual row", () => {
    const csv = serializeObjectsCsv([makeObject()]);
    const lines = csv.split("\n");
    expect(lines[1]).toBe(EXPECTED_BILINGUAL_ROW);
  });

  it("Test 2b: third column is alt_text in header and texto_alt in bilingual row (framework template order)", () => {
    const csv = serializeObjectsCsv([makeObject()]);
    const lines = csv.split("\n");
    expect(lines[0].split(",")[2]).toBe("alt_text");
    expect(lines[1].split(",")[2]).toBe("texto_alt");
  });

  it("Test 2c: preserved comment-row cells stay aligned under framework-ordered headers", () => {
    // A comment row whose per-column cells are aligned to the framework
    // template order. The first cell carries the leading '#', subsequent
    // cells annotate the column above them. After publish the header order
    // matches the framework template, so these cells still sit under the
    // headers they describe.
    const existingCsv = [
      EXPECTED_HEADER,
      EXPECTED_BILINGUAL_ROW,
      "# id note,title note,alt_text note,featured note,creator note,desc note,url note,period note,year note,genre note,subjects note,source note,credit note,thumb note,dim note",
      "obj-001,Test Object,,,,,,,,,,,,,",
    ].join("\n");

    const output = serializeObjectsCsv([makeObject({ object_id: "obj-002", title: "New" })], existingCsv);
    const lines = output.split("\n");

    // Output header is the framework template order.
    expect(lines[0]).toBe(EXPECTED_HEADER);

    // The comment row is preserved verbatim (line index 2 = after header + bilingual).
    expect(lines[2]).toBe(
      "# id note,title note,alt_text note,featured note,creator note,desc note,url note,period note,year note,genre note,subjects note,source note,credit note,thumb note,dim note",
    );

    // Spot-check alignment: header[2] is alt_text and the comment cell[2]
    // still annotates it.
    const header = lines[0].split(",");
    const commentCells = lines[2].split(",");
    expect(header[2]).toBe("alt_text");
    expect(commentCells[2]).toBe("alt_text note");
  });

  it("Test 3: featured=true serialises as 'yes', featured=false serialises as empty string", () => {
    const csv = serializeObjectsCsv([
      makeObject({ object_id: "obj-yes", featured: true }),
      makeObject({ object_id: "obj-no", featured: false }),
    ]);
    const lines = csv.split("\n");
    // Lines: 0=header, 1=bilingual, 2=first data, 3=second data
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    // Skip bilingual row (index 0 after header)
    const dataRows = parsed.data.slice(1);
    expect(dataRows[0].featured).toBe("yes");
    expect(dataRows[1].featured).toBe("");
  });

  it("Test 4: null fields serialise as empty strings", () => {
    const csv = serializeObjectsCsv([
      makeObject({
        creator: null,
        description: null,
        title: null,
        year: null,
      }),
    ]);
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.creator).toBe("");
    expect(dataRow.description).toBe("");
    expect(dataRow.title).toBe("");
    expect(dataRow.year).toBe("");
  });

  it("Test 5: round-trip: serializeObjectsCsv output fed to mapObjectsCsv produces equivalent data", () => {
    const original = [
      makeObject({ object_id: "obj-001", title: "Object One", featured: true, creator: "Artist A" }),
      makeObject({ object_id: "obj-002", title: "Object Two", featured: false }),
    ];

    const csv = serializeObjectsCsv(original);
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    // parsed.data[0] is the bilingual row, parsed.data[1..] are data rows
    const dataRows = parsed.data.slice(1);
    const mapped = mapObjectsCsv(dataRows, 1);

    expect(mapped[0].object_id).toBe("obj-001");
    expect(mapped[0].title).toBe("Object One");
    expect(mapped[0].featured).toBe(true);
    expect(mapped[1].object_id).toBe("obj-002");
    expect(mapped[1].featured).toBe(false);
  });

  it("Test 6: Spanish characters (accented letters, ñ) survive the round-trip without corruption", () => {
    const original = [
      makeObject({
        object_id: "obj-es",
        title: "Ánfora de terracota",
        description: "Pieza del siglo XVIII con decoración en añil",
        creator: "Artesano desconocido",
        period: "Período colonial",
        year: "1750",
        medium_genre: "Cerámica",
        subjects: "Arqueología; Época colonial",
        source: "Colección Muñoz",
        credit: "Donado por la familia Peñalosa",
      }),
    ];

    const csv = serializeObjectsCsv(original);
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row

    expect(dataRow.title).toBe("Ánfora de terracota");
    expect(dataRow.description).toBe("Pieza del siglo XVIII con decoración en añil");
    expect(dataRow.creator).toBe("Artesano desconocido");
    expect(dataRow.subjects).toBe("Arqueología; Época colonial");
    expect(dataRow.source).toBe("Colección Muñoz");
  });

  it("Test alt_text: includes alt_text column value", () => {
    const csv = serializeObjectsCsv([makeObject({ alt_text: "A weaving loom" })]);
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.alt_text).toBe("A weaving loom");
  });

  it("Test alt_text null: emits empty string for null alt_text", () => {
    const csv = serializeObjectsCsv([makeObject({ alt_text: null })]);
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.alt_text).toBe("");
  });

  it("header contains medium_genre (not object_type)", () => {
    const csv = serializeObjectsCsv([makeObject()]);
    const header = csv.split("\n")[0];
    expect(header).toContain("medium_genre");
    expect(header).not.toContain("object_type");
  });

  it("bilingual row contains medio_genero (not tipo_objeto)", () => {
    const csv = serializeObjectsCsv([makeObject()]);
    const bilingual = csv.split("\n")[1];
    expect(bilingual).toContain("medio_genero");
    expect(bilingual).not.toContain("tipo_objeto");
  });

  it("object row with medium_genre outputs value in medium_genre column", () => {
    const csv = serializeObjectsCsv([makeObject({ medium_genre: "Photograph" })]);
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.medium_genre).toBe("Photograph");
  });

  it("Test 7: descriptions with embedded commas and newlines are properly quoted by PapaParse", () => {
    const csv = serializeObjectsCsv([
      makeObject({
        object_id: "obj-tricky",
        description: 'Contains, a comma and\na newline',
      }),
    ]);

    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: false });
    const dataRow = parsed.data.find((r) => r.object_id === "obj-tricky");
    expect(dataRow).toBeDefined();
    expect(dataRow!.description).toBe('Contains, a comma and\na newline');
  });

  it("H17 (a): dimensions value emits a dimensions column with dimensiones bilingual label", () => {
    const csv = serializeObjectsCsv([makeObject({ dimensions: "24 x 30 cm" })]);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("dimensions");
    expect(lines[1]).toContain("dimensiones");
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data[1]; // skip bilingual row
    expect(dataRow.dimensions).toBe("24 x 30 cm");
  });

  it("H17 (b): extra_columns union emits sorted custom columns after fixed columns, per-row values", () => {
    const csv = serializeObjectsCsv([
      makeObject({ object_id: "obj-a", extra_columns: '{"procedencia":"Bogotá"}' }),
      makeObject({ object_id: "obj-b", extra_columns: '{"inventory_no":"X-12"}' }),
    ]);
    const header = csv.split("\n")[0];
    // Both custom columns present, sorted alphabetically, after the fixed columns
    expect(header).toBe(`${EXPECTED_HEADER},inventory_no,procedencia`);

    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRows = parsed.data.slice(1); // skip bilingual row
    const rowA = dataRows.find((r) => r.object_id === "obj-a")!;
    const rowB = dataRows.find((r) => r.object_id === "obj-b")!;
    expect(rowA.procedencia).toBe("Bogotá");
    expect(rowA.inventory_no).toBe("");
    expect(rowB.inventory_no).toBe("X-12");
    expect(rowB.procedencia).toBe("");
  });

  it("H17 (c): null extra_columns yields only fixed columns + dimensions, no spurious columns", () => {
    const csv = serializeObjectsCsv([makeObject({ extra_columns: null })]);
    const header = csv.split("\n")[0];
    expect(header).toBe(EXPECTED_HEADER);
  });

  it("H17 (d): corrupt extra_columns does not throw and emits no extra columns for that row", () => {
    let csv = "";
    expect(() => {
      csv = serializeObjectsCsv([makeObject({ extra_columns: "{not json" })]);
    }).not.toThrow();
    const header = csv.split("\n")[0];
    expect(header).toBe(EXPECTED_HEADER);
  });

  it("H17 (e): round-trip dimensions + custom column through parseTelarCsv + mapObjectsCsv", () => {
    const csv = serializeObjectsCsv([
      makeObject({
        object_id: "obj-rt",
        dimensions: "24 x 30 cm",
        extra_columns: '{"procedencia":"Bogotá"}',
      }),
    ]);
    const rows = parseTelarCsv(csv);
    const mapped = mapObjectsCsv(rows, 1);
    const obj = mapped.find((m) => m.object_id === "obj-rt")!;
    expect(obj.dimensions).toBe("24 x 30 cm");
    expect(obj.extra_columns).toBeDefined();
    expect(JSON.parse(obj.extra_columns as string)).toEqual({ procedencia: "Bogotá" });
  });

  it("H17 (f): 5 custom columns round-trip without a phantom id_objeto data row", () => {
    // With 15 fixed + 5 custom = 20 columns, the bilingual row used to echo the
    // 5 custom keys verbatim → only 15/20 = 0.75 < 0.8 known → header detection
    // failed and ingested the bilingual row as a phantom data object.
    const original = [
      makeObject({
        object_id: "obj-c1",
        title: "First",
        extra_columns:
          '{"acc_no":"A-1","loc":"Sala 1","prov":"Bogotá","cond":"Buena","rights":"CC-BY"}',
      }),
      makeObject({
        object_id: "obj-c2",
        title: "Second",
        extra_columns:
          '{"acc_no":"A-2","loc":"Sala 2","prov":"Cali","cond":"Regular","rights":"CC0"}',
      }),
    ];

    const csv = serializeObjectsCsv(original);
    const lines = csv.split("\n");

    // The bilingual row's custom-column cells must be empty so they don't
    // dilute header detection. Header + bilingual = lines[0], lines[1].
    const header = lines[0].split(",");
    const bilingual = lines[1].split(",");
    const customStart = OBJECTS_CSV_COLUMNS.length;
    for (let i = customStart; i < header.length; i++) {
      expect(bilingual[i]).toBe("");
    }

    // No phantom id_objeto row, and exactly as many data rows as input objects.
    const rows = parseTelarCsv(csv);
    expect(rows.some((r) => r.object_id === "id_objeto")).toBe(false);
    const mapped = mapObjectsCsv(rows, 1);
    expect(mapped).toHaveLength(original.length);

    // Custom column values round-trip per object.
    const a = mapped.find((m) => m.object_id === "obj-c1")!;
    const b = mapped.find((m) => m.object_id === "obj-c2")!;
    expect(JSON.parse(a.extra_columns as string)).toMatchObject({
      acc_no: "A-1",
      prov: "Bogotá",
    });
    expect(JSON.parse(b.extra_columns as string)).toMatchObject({
      acc_no: "A-2",
      prov: "Cali",
    });
  });

  it("H17 (g): with 4+ custom columns parseTelarCsv yields no object_id === 'id_objeto' row", () => {
    const csv = serializeObjectsCsv([
      makeObject({
        object_id: "obj-4c",
        extra_columns: '{"k1":"v1","k2":"v2","k3":"v3","k4":"v4"}',
      }),
    ]);
    const rows = parseTelarCsv(csv);
    expect(rows.find((r) => r.object_id === "id_objeto")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dbObjectToCsvRow — D1 → CSV row mapping used by every serializeObjectsCsv
// call site (publish + objects routes). Regression for passing raw D1 rows
// straight to serializeObjectsCsv, which would silently drop object_type.
// ---------------------------------------------------------------------------

describe("dbObjectToCsvRow", () => {
  function makeDbRow(overrides: Partial<ObjectDbRow> = {}): ObjectDbRow {
    return {
      object_id: "obj-001",
      title: "My Object",
      featured: false,
      creator: null,
      description: null,
      source_url: null,
      period: null,
      year: null,
      object_type: null,
      subjects: null,
      source: null,
      credit: null,
      thumbnail: null,
      alt_text: null,
      ...overrides,
    };
  }

  it("maps D1 object_type to CSV medium_genre (v1.0.0 rename)", () => {
    const row = dbObjectToCsvRow(makeDbRow({ object_type: "Photograph" }));
    expect(row.medium_genre).toBe("Photograph");
    expect((row as unknown as Record<string, unknown>).object_type).toBeUndefined();
  });

  it("maps null object_type to null medium_genre", () => {
    const row = dbObjectToCsvRow(makeDbRow({ object_type: null }));
    expect(row.medium_genre).toBeNull();
  });

  it("passes through all other fields verbatim", () => {
    const row = dbObjectToCsvRow(
      makeDbRow({
        object_id: "obj-042",
        title: "Titulo",
        featured: true,
        creator: "Autor",
        description: "Desc",
        source_url: "https://ex.com",
        period: "XIX",
        year: "1850",
        subjects: "a, b",
        source: "s",
        credit: "c",
        thumbnail: "t.jpg",
        alt_text: "alt",
      }),
    );
    expect(row).toMatchObject({
      object_id: "obj-042",
      title: "Titulo",
      featured: true,
      creator: "Autor",
      description: "Desc",
      source_url: "https://ex.com",
      period: "XIX",
      year: "1850",
      subjects: "a, b",
      source: "s",
      credit: "c",
      thumbnail: "t.jpg",
      alt_text: "alt",
    });
  });

  it("round-trips a custom header carrying a newline, byte for byte", () => {
    // A quoted header may hold a newline, and RFC 4180 says nothing against it.
    // Every section of the file is a whole record set, so the bilingual row can
    // only land after the header record, never inside its second physical line.
    const first = serializeObjectsCsv([
      makeObject({
        object_id: "obj-nl",
        // Stated, because an absent alt_text is filled from the title on the way
        // back in and the two exports would differ for a reason of its own.
        alt_text: "alt",
        extra_columns: JSON.stringify({ "editor\nnote": "v" }),
      }),
    ]);
    // Projected back onto the fixture's own shape: every field it does not set
    // is null on both sides, so these four carry the whole row.
    const second = serializeObjectsCsv(
      mapObjectsCsv(parseTelarCsv(first), 1).map((o) =>
        makeObject({
          object_id: o.object_id,
          title: o.title ?? null,
          alt_text: o.alt_text ?? null,
          extra_columns: o.extra_columns ?? null,
        }),
      ),
    );
    expect(second).toBe(first);
    // The bilingual row is the second RECORD, whatever the header's line count.
    const records = Papa.parse<string[]>(first.trimEnd()).data;
    expect(records[0].at(-1)).toBe("editor\nnote");
    expect(records[1].slice(0, OBJECTS_CSV_COLUMNS.length).join(",")).toBe(EXPECTED_BILINGUAL_ROW);
    expect(records[1].at(-1)).toBe("");
    expect(records[2].at(-1)).toBe("v");
  });

  it("round-trips through serializeObjectsCsv so medium_genre lands in the CSV", () => {
    const csv = serializeObjectsCsv(
      [makeDbRow({ object_id: "obj-x", object_type: "Audio" })].map(dbObjectToCsvRow),
    );
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data.find((r) => r.object_id === "obj-x");
    expect(dataRow?.medium_genre).toBe("Audio");
  });
});

// ---------------------------------------------------------------------------
// Republishing a file whose own header holds a `#` line
//
// The output of a publish is the input of the next one: whatever the serializer
// writes, `extractCommentRows` reads back. A custom column headed with a
// newline is the case where a scan over physical lines and a scan over records
// part company — the header's second line opens with `#`, so it is taken for a
// comment, emitted above the data, and taken for one again next time.
// ---------------------------------------------------------------------------

describe("a file whose header carries a newline followed by #", () => {
  const glossaryTerms = [
    {
      term_id: "loom",
      title: "Loom",
      definition: "A device.",
      related_terms: null,
      extra_columns: JSON.stringify({ "editor\n#note": "v" }),
    },
  ];

  it("republishes a glossary byte-identically, three times over", () => {
    const first = serializeGlossaryCsv(glossaryTerms);
    const second = serializeGlossaryCsv(glossaryTerms, first);
    const third = serializeGlossaryCsv(glossaryTerms, second);
    expect(second).toBe(first);
    expect(third).toBe(second);
    expect(first).toContain('"editor\n#note"');
  });

  it("republishes objects byte-identically, three times over", () => {
    const objectRows = [
      makeObject({
        object_id: "obj-nl",
        alt_text: "alt",
        extra_columns: JSON.stringify({ "editor\n#note": "v" }),
      }),
    ];
    const first = serializeObjectsCsv(objectRows);
    const second = serializeObjectsCsv(objectRows, first);
    const third = serializeObjectsCsv(objectRows, second);
    expect(second).toBe(first);
    expect(third).toBe(second);
  });

  it("republishes a value holding a # line byte-identically", () => {
    const objectRows = [
      makeObject({
        object_id: "obj-hash",
        alt_text: "alt",
        description: "A description\n# not a comment",
      }),
    ];
    const first = serializeObjectsCsv(objectRows);
    const second = serializeObjectsCsv(objectRows, first);
    expect(second).toBe(first);
  });

  it("still carries a genuine comment row across a republish of such a file", () => {
    const withComment = serializeGlossaryCsv(
      glossaryTerms,
      ["term_id,title", "id_término,titulo", "# Keep me", "loom,Loom"].join("\n"),
    );
    expect(withComment).toContain("# Keep me");
    expect(serializeGlossaryCsv(glossaryTerms, withComment)).toBe(withComment);
  });
});

// ---------------------------------------------------------------------------
// Where the comment row lands
//
// The framework's template puts its instruction rows above the data, and the
// bilingual row has to be the second record for either header detector to
// recognise it. Both are assertions about record ORDER, and presence alone
// cannot see them: a comment emitted below the data, or above the bilingual
// row, satisfies "contains" and equals its own previous output. Custom columns
// are in the fixture because they are what pushes a header across a record
// boundary — a custom header may hold a newline, and a section cut on physical
// lines then puts the bilingual row inside the header's own quotes.
// ---------------------------------------------------------------------------

describe("a published file that has both a comment row and custom columns", () => {
  const COMMENT = "# Una fila de instrucciones";

  it("writes the glossary records as header, bilingual row, comment, data", () => {
    const terms = [
      {
        term_id: "loom",
        title: "Loom",
        definition: "A device.",
        related_terms: null,
        extra_columns: JSON.stringify({ curator: "Ana", "editor\n#note": "v" }),
      },
    ];
    const records = splitCsvRecords(
      serializeGlossaryCsv(terms, ["term_id,title", COMMENT, "loom,Loom"].join("\n")),
      ",",
      "\n",
    );
    expect(records).toHaveLength(4);
    expect(records[0]).toBe(
      'term_id,title,definition,related_terms,curator,"editor\n#note"',
    );
    expect(records[1]).toBe("id_término,titulo,definición,términos_relacionados,,");
    expect(records[2]).toBe(COMMENT);
    expect(records[3]).toBe("loom,Loom,A device.,,Ana,v");
  });

  it("writes the objects records as header, bilingual row, comment, data", () => {
    const objectRows = [
      makeObject({
        object_id: "obj-1",
        title: "Un objeto",
        alt_text: "alt",
        extra_columns: JSON.stringify({ curator: "Ana", "editor\n#note": "v" }),
      }),
    ];
    const records = splitCsvRecords(
      serializeObjectsCsv(objectRows, ["object_id,title", COMMENT, "obj-1,Un objeto"].join("\n")),
      ",",
      "\n",
    );
    expect(records).toHaveLength(4);
    expect(records[0]).toBe(`${EXPECTED_HEADER},curator,"editor\n#note"`);
    expect(records[1]).toBe(`${EXPECTED_BILINGUAL_ROW},,`);
    expect(records[2]).toBe(COMMENT);
    expect(records[3]).toContain("obj-1,Un objeto");
    expect(records[3].endsWith(",Ana,v")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A repaired comment is a comment to everyone, and stable forever
// ---------------------------------------------------------------------------

/**
 * The malformed candidate shapes, each above one data row.
 *
 * The last two open with a quote and reach the `#` only after it: a bare quote
 * whose field runs on to the next line, and a quote enclosing a space before
 * the marker. A candidate test reading the record's RAW text sees a `"` and a
 * space where the importer — which reads the decoded cell — sees a comment, so
 * the author's text is dropped from a file the importer keeps it in.
 */
const MALFORMED_CANDIDATES: Array<[string, string, string]> = [
  ["a quote followed by text", '"#note"x,ignored', "#'#note'x,ignored"],
  ["a quote that never closes", '"#a\nold,Old', "#'#a"],
  ["a quote closed after text", '"#a"x",d', "#'#a'x',d"],
  ["a lone quote above the marker", '"\n#note', "#'"],
  ["a space between the quote and the marker", '" #note"x,ignored', "#' #note'x,ignored"],
];

describe("a malformed comment candidate is repaired to a plain # line", () => {
  const objectsFile = (candidate: string) => `object_id,title\n${candidate}\nobj-1,A\n`;
  const republish = (existing: string) =>
    serializeObjectsCsv([makeObject({ object_id: "obj-1", title: "A", alt_text: "alt" })], existing);

  for (const [shape, candidate, repaired] of MALFORMED_CANDIDATES) {
    it(`repairs ${shape} and holds that text across three republishes`, () => {
      const first = republish(objectsFile(candidate));
      const second = republish(first);
      const third = republish(second);

      expect(splitCsvRecords(first, ",", "\n")[2]).toBe(repaired);
      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it(`leaves the republished file readable after ${shape}`, () => {
      const output = republish(objectsFile(candidate));

      expect(Papa.parse<string[]>(output, { header: false }).errors).toEqual([]);
      expect(mapObjectsCsv(parseTelarCsv(output), 1).map((r) => r.object_id)).toEqual(["obj-1"]);
    });
  }

  it("leaves a well-formed comment exactly as it was written", () => {
    expect(extractCommentRows("object_id,title\n# plain\nobj-1,A\n")).toEqual(["# plain"]);
  });
});

// ---------------------------------------------------------------------------
// A file-leading BOM belongs to the encoding, not to the comment
// ---------------------------------------------------------------------------

const BOM = "\uFEFF";

describe("a comment at offset zero does not carry the file's byte-order mark", () => {
  const leadingComment = `${BOM}#note\nobject_id,title\nobj-1,A`;

  it("drops the mark from the first extracted comment", () => {
    expect(extractCommentRows(leadingComment)).toEqual(["#note"]);
  });

  // A mark anywhere but offset zero is a character in the cell, and CPython's
  // strip leaves it there — so the framework's objects reader keeps the row and
  // builds an object whose id is the mark and the text behind it. Carried
  // through as a COMMENT the row would be written above the data as well,
  // where the site reads it as that same object again. It is a data row here
  // because it is a data row there.
  it("leaves a mark opening a row anywhere else a data row, as the framework reads it", () => {
    const csv = `object_id,title\n${BOM}#note\nobj-1,A`;

    expect(extractCommentRows(csv)).toEqual([]);
    expect(mapObjectsCsv(parseTelarCsv(csv), 1).map((r) => r.object_id)).toEqual([
      `${BOM}#note`,
      "obj-1",
    ]);
  });

  it("republishes with no mark anywhere in the file", () => {
    const output = serializeObjectsCsv(
      [makeObject({ object_id: "obj-1", title: "A", alt_text: "alt" })],
      leadingComment,
    );

    // The file's first record is its header, written back as the header line,
    // so `#note` heads the first column once and is not carried as a comment too.
    expect(splitCsvRecords(output, ",", "\n")[0].split(",")[0]).toBe("#note");
    expect(output.split("#note")).toHaveLength(2);
    expect(output.includes(BOM)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A comment is a row whose FIRST cell carries the marker
//
// `telar.core.csv_to_json` filters on the first column alone
// (scripts/telar/core.py:94 on the test instance, :90 at the published tag), so
// `x,#note` is the object `x` to the site. Extracted here as a comment it is
// written back verbatim above the data on every publish AND never shown in the
// Compositor: an object nobody can edit that the site rebuilds every time.
// ---------------------------------------------------------------------------

describe("the marker's position in the row", () => {
  it("extracts a record whose first cell opens with the marker", () => {
    expect(extractCommentRows("object_id,title\n#note,X\na,A\n")).toEqual(["#note,X"]);
  });

  it("leaves a record whose marker sits in a later cell to the data", () => {
    const csv = "object_id,title\nx,#note\na,A\n";

    expect(extractCommentRows(csv)).toEqual([]);
    expect(mapObjectsCsv(parseTelarCsv(csv), 1).map((r) => r.object_id)).toEqual(["x", "a"]);
  });

  it("carries a title opening with the marker through a republish as data", () => {
    const csv = "object_id,title\nx,#1 in the series\n";
    const output = serializeObjectsCsv(
      [makeObject({ object_id: "x", title: "#1 in the series", alt_text: "alt" })],
      csv,
    );

    expect(splitCsvRecords(output, ",", "\n")).toHaveLength(3);
    expect(mapObjectsCsv(parseTelarCsv(output), 1).map((r) => r.title)).toEqual([
      "#1 in the series",
    ]);
  });
});

describe("the well-formed comment shapes", () => {
  it("leaves a quoted comment exactly as it was written", () => {
    expect(extractCommentRows('object_id,title\n"# quoted, with comma"\nobj-1,A\n')).toEqual([
      '"# quoted, with comma"',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A comment is a row of the file's own parse
//
// Whether a record is a comment is decided on the cells the importer received,
// from the one reading of the whole file it received them in — never on a
// second reading of the record alone. Papa strips U+FEFF at absolute offset
// zero and nowhere else, so a record re-read on its own has a mark stripped
// that the file's own parse keeps, and the cell it decodes to is a cell no
// reader of the file ever sees.
// ---------------------------------------------------------------------------

describe("a mid-file mark in front of a quote", () => {
  const existing = `object_id,title\n${BOM}"#note",X\na,A\n`;

  it("leaves the record a data row rather than a comment", () => {
    // The mark is the first cell's first character, so the quote behind it is
    // ordinary content and the file's parse hands the importer a two-cell data
    // row whose id is `"#note"`. Re-read alone the mark goes, the record is
    // `"#note",X`, and the first cell decodes to `#note` — a comment to a
    // reading nothing else in the system performs.
    expect(extractCommentRows(existing)).toEqual([]);
    // The id is the cell `parseTelarCsv` stores, and it is the cell the
    // classification was made on: one strip, so the object the site builds and
    // the object the Compositor holds are the same object.
    expect(mapObjectsCsv(parseTelarCsv(existing), 1).map((r) => r.object_id)).toEqual([
      `${BOM}"#note"`,
      "a",
    ]);
  });

  it("does not carry the record into the republished file as a comment", () => {
    const output = serializeObjectsCsv(
      [makeObject({ object_id: "a", title: "A", alt_text: "alt" })],
      existing,
    );

    expect(output).not.toContain(BOM);
    expect(splitCsvRecords(output, ",", "\n").some((record) => record.includes("#note"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// An id the framework keeps has to survive the round trip
//
// CPython's strip leaves U+FEFF, so a first cell of `<mark>#note` is an OBJECT
// to both framework releases and to the importer's own comment rule. The cell
// the importer STORES is what the next publish writes back, so a store that
// takes the mark off publishes `#note,X` — which both releases then drop as a
// comment, and the object is gone from the site and from every import after.
// ---------------------------------------------------------------------------

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "an object whose id opens with a mark the framework keeps",
  () => {
    const source = `object_id,title\n${BOM}#note,X\na,A\n`;

    /** The ids one import of `source` creates. */
    const importedIds = () =>
      mapObjectsCsv(parseTelarCsv(source), 1).map((r) => r.object_id as string);

    /** The file a publish of those ids writes back over `source`. */
    const published = () =>
      serializeObjectsCsv(
        importedIds().map((id) => makeObject({ object_id: id, title: "X", alt_text: "alt" })),
        source,
      );

    it("imports, publishes and re-imports under the id the file carries", () => {
      expect(importedIds()).toEqual([`${BOM}#note`, "a"]);
      expect(mapObjectsCsv(parseTelarCsv(published()), 1).map((r) => r.object_id)).toEqual([
        `${BOM}#note`,
        "a",
      ]);
    });

    for (const [release, scripts] of [
      ["the test instance", () => FRAMEWORK_SCRIPTS_DIR],
      ["the published tag", () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG)],
    ] as const) {
      it(
        `builds both objects out of the republished file on ${release}`,
        () => {
          const read = frameworkObjectsRead(published(), scripts());
          expect(read.error).toBeUndefined();
          expect(read.ids).toEqual([`${BOM}#note`, "a"]);
        },
        FRAMEWORK_TIMEOUT_MS,
      );
    }
  },
);

describeWithFrameworkTag(
  PUBLISHED_FRAMEWORK_TAG,
  "the objects.csv a malformed comment record republishes into",
  () => {
    /**
     * The republished file, with one object and one unreadable comment
     * candidate in the file it replaces.
     */
    const published = (existing: string) =>
      serializeObjectsCsv(
        [
          {
            object_id: "obj-1",
            title: "Un objeto",
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
          },
        ],
        existing,
      );

    /** The same repaired row on a glossary sheet, above one term. */
    const glossaryFile = (candidate: string) =>
      serializeGlossaryCsv(
        [
          {
            term_id: "t-1",
            title: "Un término",
            definition: "Una definición",
            related_terms: null,
          },
        ],
        `term_id,title,definition\n${candidate}\nt-1,Un término,Una definición\n`,
      );

    for (const [release, scripts, foldFirst] of [
      ["the test instance", () => FRAMEWORK_SCRIPTS_DIR, false],
      ["the published tag", () => frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG), true],
    ] as const) {
      for (const [shape, candidate] of MALFORMED_CANDIDATES) {
        it(
          `reads the repaired ${shape} as a comment on objects.csv on ${release}`,
          () => {
            const read = frameworkObjectsRead(
              published(`object_id,title\n${candidate}\nold,Old\n`),
              scripts(),
            );
            expect(read.error).toBeUndefined();
            expect(read.ids).toEqual(["obj-1"]);
          },
          FRAMEWORK_TIMEOUT_MS,
        );

        // The page generator skips a term whose id opens `#`, so nothing the
        // repair writes reaches the site. The link map skips no such row: a
        // repaired record wide enough to carry a title costs one spurious
        // entry there, which is what a preserved comment has always cost.
        it(
          `writes no glossary page for the repaired ${shape} on ${release}`,
          () => {
            const read = frameworkGlossaryTerms(glossaryFile(candidate), foldFirst, scripts());
            expect(read.error).toBeUndefined();
            expect(read.pages).toEqual(["t-1"]);
            expect(read.linkMap).toContain("t-1");
          },
          FRAMEWORK_TIMEOUT_MS,
        );
      }

      // pandas keeps a mid-file U+FEFF and Python's `strip` does not remove
      // it, so a mark relocated below the generated header makes the comment a
      // phantom object whose id is the mark and the text after it.
      it(
        `reads no phantom object from a file-leading mark on ${release}`,
        () => {
          const read = frameworkObjectsRead(
            published(`${BOM}#note\nobject_id,title\nold,Old\n`),
            scripts(),
          );
          expect(read.error).toBeUndefined();
          expect(read.ids).toEqual(["obj-1"]);
        },
        FRAMEWORK_TIMEOUT_MS,
      );
    }
  },
);
