import { describe, it, expect } from "vitest";
import Papa from "papaparse";
import {
  serializeObjectsCsv,
  extractCommentRows,
  OBJECTS_CSV_COLUMNS,
} from "~/lib/csv-export.server";
import { mapObjectsCsv } from "~/lib/import.server";

const EXPECTED_HEADER =
  "object_id,title,featured,creator,description,source_url,period,year,object_type,subjects,source,credit,thumbnail";

const EXPECTED_BILINGUAL_ROW =
  "id_objeto,titulo,destacado,creador,descripcion,url_fuente,periodo,año,tipo_objeto,temas,fuente,credito,miniatura";

function makeObject(overrides: Partial<{
  object_id: string;
  title: string | null;
  featured: boolean | null;
  creator: string | null;
  description: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  object_type: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
}> = {}) {
  return {
    object_id: "obj-001",
    title: "Test Object",
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
      "object_id,title,featured,creator,description,source_url,period,year,object_type,subjects,source,credit,thumbnail",
      "id_objeto,titulo,destacado,creador,descripcion,url_fuente,periodo,año,tipo_objeto,temas,fuente,credito,miniatura",
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
        object_type: null,
        subjects: null,
        source: null,
        credit: null,
        thumbnail: null,
      },
    ];

    const output = serializeObjectsCsv(newObjects, existingCsv);
    expect(output).toContain("# Example: obj-001");
    expect(output).toContain("obj-002");
  });
});

describe("OBJECTS_CSV_COLUMNS", () => {
  it("has correct column order", () => {
    expect(OBJECTS_CSV_COLUMNS).toEqual([
      "object_id",
      "title",
      "featured",
      "creator",
      "description",
      "source_url",
      "period",
      "year",
      "object_type",
      "subjects",
      "source",
      "credit",
      "thumbnail",
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
        object_type: "Cerámica",
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
});
