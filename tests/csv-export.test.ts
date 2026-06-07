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

  it("normalises CRLF line endings before filtering", () => {
    const csv = "object_id,title\r\n# Comment row\r\nobj-001,Test";
    const result = extractCommentRows(csv);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("# Comment row");
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

  it("round-trips through serializeObjectsCsv so medium_genre lands in the CSV", () => {
    const csv = serializeObjectsCsv(
      [makeDbRow({ object_id: "obj-x", object_type: "Audio" })].map(dbObjectToCsvRow),
    );
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
    const dataRow = parsed.data.find((r) => r.object_id === "obj-x");
    expect(dataRow?.medium_genre).toBe("Audio");
  });
});
