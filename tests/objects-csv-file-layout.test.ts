/**
 * objects.csv published in the file's own column layout.
 *
 * A comment row annotates the columns by position, so it stays under its
 * headers only while each column keeps its place. The file's header text is
 * kept for a fixed column only where every framework release the Compositor
 * publishes to reads it as that column; elsewhere the English name is written.
 *
 * The template text below is quoted verbatim from
 * `telar-content/spreadsheets/objects.csv` in the framework (f2f29ba5, the
 * file last changed at 6ebd2298): header, bilingual row, both comment rows and
 * the first object.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync } from "node:fs";
import Papa from "papaparse";
import { OBJECTS_CSV_COLUMNS, fileObjectsLayout, serializeObjectsCsv } from "~/lib/csv-export.server";
import type { ObjectRow } from "~/lib/csv-export.server";
import { chosenSheetLayout, plainSheetLayout, writesEachOnce } from "~/lib/sheet-csv-layout.server";
import type { SheetCsvLayout } from "~/lib/sheet-csv-layout.server";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
  describeWithFrameworkTag,
  frameworkCsvToJson,
  frameworkScriptsAtTag,
} from "./helpers/framework-checkout";

const TEMPLATE_HEADER =
  "object_id,title,alt_text,featured,creator,description,source_url,period,year,medium_genre,subjects,source,credit,thumbnail";
const TEMPLATE_BILINGUAL =
  "id_objeto,titulo,texto_alt,destacado,creador,descripcion,url_fuente,periodo,año,medio_genero,temas,fuente,credito,miniatura";
const TEMPLATE_COMMENT_EN =
  "# Make it lower-case and avoid spaces. If you are referring to a local object please ensure the object_id matches the name of the file exactly (with or without the file extension – it doesn't matter).,# Please provide a title — this is required.,\"# Describe what the image shows for screen readers. Mention the subject and key details. Avoid \"\"Image of...\"\" — describe the content directly. If empty, the title is used.\",\"# Mark \"\"yes\"\" to feature on homepage\",# The person or organization that created the original object.,# A brief description of the object shown on the objects page of your published site.,# Here you can include a IIIF manifest and Telar will do the rest of the work for you.,\"# The historical period this object belongs to (e.g. \"\"Colonial period\"\", \"\"19th century\"\").\",# In YYYY format — for filtering and sorting chronologically.,\"# The medium or genre of the object (e.g. \"\"Map\"\", \"\"Photograph\"\", \"\"Engraving\"\").\",# Comma-separated terms for gallery filtering,\"# This will be overlaid over the viewer, unless you specify otherwise in _config.yml.\",\"# Attribution line shown on the published site (e.g. \"\"Courtesy of UCSB Library\"\").\",# Telar generates thumbnails automatically but you can override this by specifying an image file in this column.";
const TEMPLATE_COMMENT_ES =
  "\"# Escríbelo en minúsculas y sin espacios. Si hace referencia a un objeto local, asegúrate de que el object_id coincida exactamente con el nombre del archivo (con o sin extensión; no importa).\",# Incluye un título: este campo es obligatorio.,\"# Describe lo que muestra la imagen para lectores de pantalla. Menciona el sujeto y los detalles clave. Evita \"\"Imagen de...\"\" — describe el contenido directamente. Si se deja vacío, se usa el título.\",\"# Marca \"\"sí\"\" para destacar en la página de inicio\",# La persona u organización que creó el objeto original.,# Una breve descripción del objeto que se muestra en la página de objetos de tu sitio publicado.,# Aquí puedes incluir un manifiesto IIIF y Telar se encargará del resto del trabajo.,\"# El período histórico al que pertenece este objeto (por ejemplo, \"\"Período colonial\"\", \"\"Siglo XIX\"\").\",# En formato AAAA — para filtrar y ordenar cronológicamente.,\"# El medio o género del objeto (por ejemplo, \"\"Mapa\"\", \"\"Fotografía\"\", \"\"Grabado\"\").\",# Términos separados por comas para filtrado de galería,\"# Esto se mostrará encima del visor, a menos que indiques lo contrario en _config.yml.\",\"# Línea de atribución que se muestra en el sitio publicado (por ejemplo, \"\"Cortesía de la Biblioteca de UCSB\"\").\",# Telar genera miniaturas automáticamente pero puedes anular este comportamiento especificando un archivo de imagen en esta columna.";
const TEMPLATE_ROW =
  "atlas-allegory,Aspecto Symbólico del Mundo Hispánico,,,Laureano Atlas,\"Allegorical map of the \"\"Hispanic World\"\", engraved by Laureano Atlas and published as the frontispiece to Vicente Memije, Theses Mathematicas de Cosmographia, Geographia y Hydrographia (Manila: 1761)\",https://figgy.princeton.edu/concern/scanned_resources/3497e01a-5086-4528-86ba-6f67ce402eec/manifest,1761,,,,,Princeton University Library,\"https://iiif-cloud.princeton.edu/iiif/2/a3%2F5c%2F7c%2Fa35c7c70b04342b58dd6116d7390e017%2Fintermediate_file/full/!200,150/0/default.jpg\"";

const TEMPLATE_FILE =
  [TEMPLATE_HEADER, TEMPLATE_BILINGUAL, TEMPLATE_COMMENT_EN, TEMPLATE_COMMENT_ES, TEMPLATE_ROW].join("\n") + "\n";

function readCsv(csv: string): string[][] {
  return Papa.parse<string[]>(csv, { header: false, skipEmptyLines: true }).data;
}

function object(over: Partial<ObjectRow> = {}, extras: Record<string, string> = {}): ObjectRow {
  return {
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
    alt_text: null,
    dimensions: null,
    extra_columns: Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
    ...over,
  };
}

/** The template's first object, as the import stores it. */
const ATLAS = object({
  object_id: "atlas-allegory",
  title: "Aspecto Symbólico del Mundo Hispánico",
  creator: "Laureano Atlas",
  description:
    'Allegorical map of the "Hispanic World", engraved by Laureano Atlas and published as the frontispiece to Vicente Memije, Theses Mathematicas de Cosmographia, Geographia y Hydrographia (Manila: 1761)',
  source_url: "https://figgy.princeton.edu/concern/scanned_resources/3497e01a-5086-4528-86ba-6f67ce402eec/manifest",
  period: "1761",
  credit: "Princeton University Library",
  thumbnail:
    "https://iiif-cloud.princeton.edu/iiif/2/a3%2F5c%2F7c%2Fa35c7c70b04342b58dd6116d7390e017%2Fintermediate_file/full/!200,150/0/default.jpg",
});

/** The fixed columns after `title` in canonical order, as a file lacking them has them appended. */
const AFTER_TITLE = OBJECTS_CSV_COLUMNS.slice(2);

interface ObjectsFixture {
  file: string;
  objects: ObjectRow[];
}

const FIXTURES: Record<number, ObjectsFixture> = {
  14: {
    file: "object_id,title,2020,1990\n# guide,title note,2020 note,1990 note\nobj-1,Un objeto,a,b\n",
    objects: [object({}, { "2020": "a", "1990": "b" })],
  },
  15: { file: TEMPLATE_FILE, objects: [ATLAS] },
  16: {
    file:
      [
        `id_objeto,${TEMPLATE_HEADER}`,
        `,${TEMPLATE_BILINGUAL}`,
        `# otro id,${TEMPLATE_COMMENT_EN}`,
        `# otro id,${TEMPLATE_COMMENT_ES}`,
        `,${TEMPLATE_ROW}`,
      ].join("\n") + "\n",
    objects: [ATLAS],
  },
  17: {
    file: "id_objeto,título,creador,medio_genero\nobj-1,Un objeto,Laureano Atlas,Grabado\n",
    objects: [object({ creator: "Laureano Atlas", medium_genre: "Grabado" })],
  },
  18: {
    file: "object_id,título,crédito,descripción,ubicación\nobj-1,Un objeto,Cortesía,Un mapa,Biblioteca\n",
    objects: [object({ credit: "Cortesía", description: "Un mapa", source: "Biblioteca" })],
  },
  19: {
    file: "object_id,title,notas,_metadata,borrada\n# id,# t,# notas,# meta,# borrada\nobj-1,Un objeto,,,valor\n",
    objects: [object()],
  },
  20: {
    file: "object_id,title,iiif_manifest\n# id,# t,# manifest\nobj-1,Un objeto,https://example.org/iiif/manifest.json\n",
    objects: [object({ source_url: "https://example.org/iiif/manifest.json" })],
  },
};

const published = (n: number) => serializeObjectsCsv(FIXTURES[n].objects, FIXTURES[n].file);
const lineOf = (n: number, i: number) => published(n).split("\n")[i];
const headerOf = (n: number) => readCsv(published(n))[0];

describe("objects.csv in the file's own layout", () => {
  it("14: custom columns keep their places and each comment cell stays under its header", () => {
    const [header, , comment] = readCsv(published(14));
    expect(header).toEqual(["object_id", "title", "2020", "1990", ...AFTER_TITLE]);
    expect(lineOf(14, 2)).toBe("# guide,title note,2020 note,1990 note");
    expect(comment[header.indexOf("2020")]).toBe("2020 note");
  });

  it("15: the template keeps its own header, dimensions appended, and both comment rows byte for byte", () => {
    expect(lineOf(15, 0)).toBe(`${TEMPLATE_HEADER},dimensions`);
    expect(lineOf(15, 2)).toBe(TEMPLATE_COMMENT_EN);
    expect(lineOf(15, 3)).toBe(TEMPLATE_COMMENT_ES);
  });

  it("16: an empty id_objeto beside object_id is left out, and both comment rows lose its cell", () => {
    const rows = readCsv(published(16));
    expect(rows[0]).toEqual([...readCsv(TEMPLATE_HEADER)[0], "dimensions"]);
    expect(rows[2]).toEqual(readCsv(TEMPLATE_COMMENT_EN)[0]);
    expect(rows[3]).toEqual(readCsv(TEMPLATE_COMMENT_ES)[0]);
    expect(rows[4][0]).toBe("atlas-allegory");
  });

  it("17: Spanish headers both releases read as the column are kept", () => {
    expect(headerOf(17).slice(0, 4)).toEqual(["id_objeto", "título", "creador", "medio_genero"]);
  });

  it("17: a header the framework reads as another column is written in English", () => {
    const file = "Object_ID,Title,Creator\nobj-1,Un objeto,Laureano Atlas\n";
    expect(readCsv(serializeObjectsCsv([object({ creator: "Laureano Atlas" })], file))[0][0]).toBe("object_id");
  });

  it("18: crédito, descripción and ubicación, which the published tag does not rename, are written in English", () => {
    const header = headerOf(18);
    expect(header).toEqual(expect.arrayContaining(["credit", "description", "source"]));
    expect(header).not.toContain("crédito");
    expect(header).not.toContain("descripción");
    expect(header).not.toContain("ubicación");
  });

  it("18: título beside them keeps its text", () => {
    expect(headerOf(18).slice(0, 5)).toEqual(["object_id", "título", "credit", "description", "source"]);
  });

  it("19: an empty custom column is kept; an empty reserved one and one with values D1 lacks go, with their comment cells", () => {
    expect(headerOf(19)).toEqual(["object_id", "title", "notas", ...AFTER_TITLE]);
    expect(lineOf(19, 2)).toBe("# id,# t,# notas");
  });

  it("20: iiif_manifest is left out, its value in source_url, and an empty one is left out too", () => {
    const [header, , , data] = readCsv(published(20));
    expect(header).not.toContain("iiif_manifest");
    expect(data[header.indexOf("source_url")]).toBe("https://example.org/iiif/manifest.json");
    const empty = serializeObjectsCsv([object()], "object_id,title,iiif_manifest\nobj-1,Un objeto,\n");
    expect(readCsv(empty)[0]).not.toContain("iiif_manifest");
  });

  it("21: rows are written in the order given, not the file's", () => {
    const file = "object_id,title\na,A\nb,B\n";
    const given = [object({ object_id: "b", title: "B" }), object({ object_id: "a", title: "A" })];
    expect(readCsv(serializeObjectsCsv(given, file)).slice(2).map((r) => r[0])).toEqual(["b", "a"]);
  });

  it("22: a header that does not parse gets the canonical header and the file's comment rows", () => {
    const file = 'object_id,"title"x",notas\n# guide,t,n\nobj-1,Un objeto,n\n';
    const lines = serializeObjectsCsv([object({}, { notas: "n" })], file).split("\n");
    expect(lines[0]).toBe([...OBJECTS_CSV_COLUMNS, "notas"].join(","));
    expect(lines[2]).toBe("# guide,t,n");
  });

  it("23: a D1 title in the first column that would read as a comment takes the canonical layout", () => {
    const file = "title,object_id\nUn objeto,obj-1\n";
    const csv = serializeObjectsCsv([object({ title: "#1 in the series" })], file);
    expect(csv.split("\n")[0]).toBe(OBJECTS_CSV_COLUMNS.join(","));
  });
});

/** `publish` applied to its own output `times` times, the first to `file`. */
function chained(publish: (existing: string) => string, file: string, times: number): string[] {
  const outputs = [publish(file)];
  while (outputs.length < times) outputs.push(publish(outputs[outputs.length - 1]));
  return outputs;
}

describe("a header whose first cell opens with the comment marker", () => {
  it("is written once as the header, and republishing reaches a fixed point after the first publish", () => {
    const file = "# guía,object_id,title\n# n,# id,# t\nhola,obj-1,Un objeto\n";
    const [first, ...rest] = chained((existing) => serializeObjectsCsv([object()], existing), file, 4);
    expect(first.split("\n").filter((line) => line.startsWith("# guía"))).toHaveLength(1);
    for (const later of rest) expect(later).toBe(first);
  });
});

/**
 * Custom columns neither the Compositor's objects scope nor the head's objects
 * reader renames, and which the published tag, reading every sheet unscoped,
 * lands on one column. The empty one of each pair has to go.
 */
const TAG_COLLISIONS: Record<string, ObjectsFixture> = {
  "private beside privada": {
    file: "object_id,title,private,privada\nobj-1,Un objeto,v,\n",
    objects: [object({}, { private: "v" })],
  },
  "page beside página": {
    file: "object_id,title,page,página\nobj-1,Un objeto,v,\n",
    objects: [object({}, { page: "v" })],
  },
  "order beside orden": {
    file: "object_id,title,order,orden\nobj-1,Un objeto,v,\n",
    objects: [object({}, { order: "v" })],
  },
};

describe("an empty custom column only the head's table renames", () => {
  // `privado` is a spelling the head added after the published tag: the tag
  // reads it as a column of its own, and the head's objects reader does not
  // rename onto `protected`, so nothing collides and the empty column stays.
  it("is kept: each release's collisions are judged by its own table", () => {
    const file = "object_id,title,private,privado\nobj-1,Un objeto,v,\n";
    const header = readCsv(serializeObjectsCsv([object({}, { private: "v" })], file))[0];
    expect(header.slice(0, 4)).toEqual(["object_id", "title", "private", "privado"]);
  });
});

describe("an empty custom column the published tag reads onto a written one", () => {
  it.each(Object.entries(TAG_COLLISIONS))("is left out: %s", (_name, { file, objects }) => {
    const header = readCsv(serializeObjectsCsv(objects, file))[0];
    const empty = readCsv(file)[0][3];
    expect(header).not.toContain(empty);
    expect(header.slice(0, 3)).toEqual(readCsv(file)[0].slice(0, 3));
  });
});

describe("24: the once-each check", () => {
  afterEach(() => vi.restoreAllMocks());

  const fixed = (names: readonly string[]) =>
    names.map((name) => ({ header: name, source: { kind: "fixed", name } as const }));

  it("refuses a layout missing a kept key and one writing a fixed column twice", () => {
    const missingKey: SheetCsvLayout = { columns: fixed(OBJECTS_CSV_COLUMNS), commentRows: [] };
    expect(writesEachOnce(missingKey, OBJECTS_CSV_COLUMNS, ["notas"])).toBe(false);
    const twice: SheetCsvLayout = { columns: fixed([...OBJECTS_CSV_COLUMNS, "title"]), commentRows: [] };
    expect(writesEachOnce(twice, OBJECTS_CSV_COLUMNS, [])).toBe(false);
  });

  it("accepts the layouts of 14 and 15", () => {
    const layout14 = fileObjectsLayout(FIXTURES[14].file, ["2020", "1990"]);
    expect(layout14 && writesEachOnce(layout14, OBJECTS_CSV_COLUMNS, ["2020", "1990"])).toBe(true);
    const layout15 = fileObjectsLayout(FIXTURES[15].file, []);
    expect(layout15 && writesEachOnce(layout15, OBJECTS_CSV_COLUMNS, [])).toBe(true);
  });

  it("writes the plain layout for a layout that fails it, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plain = plainSheetLayout(OBJECTS_CSV_COLUMNS, ["notas"], []);
    const failing: SheetCsvLayout = { columns: fixed(OBJECTS_CSV_COLUMNS), commentRows: [] };
    const chosen = chosenSheetLayout("objects.csv", failing, () => plain, OBJECTS_CSV_COLUMNS, ["notas"], []);
    expect(chosen).toEqual(plain);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/** The framework's name for a fixed column where it is not the Compositor's. */
const FRAMEWORK_FIELD: Record<string, string> = { medium_genre: "medium" };

/**
 * The text values D1 holds for an object, by the name the framework reads each
 * under. A value of digits is left out: the published tag infers a number from
 * it, and the question here is where a value lands, not its type.
 */
function valuesOf(obj: ObjectRow): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of OBJECTS_CSV_COLUMNS) {
    const value = obj[name as keyof ObjectRow];
    if (typeof value !== "string" || value === "" || /^[0-9.]+$/.test(value)) continue;
    values[FRAMEWORK_FIELD[name] ?? name] = value;
  }
  return { ...values, ...(obj.extra_columns ? (JSON.parse(obj.extra_columns) as Record<string, string>) : {}) };
}

describeWithFrameworkTag(PUBLISHED_FRAMEWORK_TAG, "the published objects.csv, read by both framework releases", () => {
  const releases = () =>
    [
      ["the test instance", FRAMEWORK_SCRIPTS_DIR],
      [PUBLISHED_FRAMEWORK_TAG, frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG)],
    ] as const;

  it.each([14, 15, 16, 17, 18, 19, 20])(
    "28: fixture %i builds with each value under its field",
    (n) => {
      for (const [release, scripts] of releases()) {
        const read = frameworkCsvToJson(published(n), "objects", scripts);
        expect(read.ok, `${release}: ${read.log}`).toBe(true);
        expect(read.rows, release).toHaveLength(1);
        for (const [field, value] of Object.entries(valuesOf(FIXTURES[n].objects[0]))) {
          expect(read.rows[0][field], `${release}: ${field}`).toBe(value);
        }
      }
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it.each(Object.entries(TAG_COLLISIONS))(
    "28: builds with the kept value under its field at both: %s",
    (_name, { file, objects }) => {
      const output = serializeObjectsCsv(objects, file);
      const [field, value] = Object.entries(JSON.parse(objects[0].extra_columns as string) as Record<string, string>)[0];
      const tagName: Record<string, string> = { private: "protected" };
      for (const [release, scripts] of releases()) {
        const read = frameworkCsvToJson(output, "objects", scripts);
        expect(read.ok, `${release}: ${read.log}`).toBe(true);
        const name = release === PUBLISHED_FRAMEWORK_TAG ? (tagName[field] ?? field) : field;
        expect(read.rows[0][name], `${release}: ${name}`).toBe(value);
      }
    },
    FRAMEWORK_TIMEOUT_MS,
  );

  it("28: fixture 18 is read with credit, description and source at both", () => {
    for (const [release, scripts] of releases()) {
      const row = frameworkCsvToJson(published(18), "objects", scripts).rows[0];
      expect([row.credit, row.description, row.source], release).toEqual(["Cortesía", "Un mapa", "Biblioteca"]);
    }
  }, FRAMEWORK_TIMEOUT_MS);

  it("removes the directory each conversion writes in", () => {
    expect(existsSync(frameworkCsvToJson(FIXTURES[14].file, "objects").dir)).toBe(false);
  }, FRAMEWORK_TIMEOUT_MS);

  it("29: a file headed Object_ID has no object_id at the test instance; its published file has one at both", () => {
    const file = "Object_ID,Title,Creator\nobj-1,Un objeto,Laureano Atlas\n";
    expect(Object.keys(frameworkCsvToJson(file, "objects").rows[0])).not.toContain("object_id");
    const output = serializeObjectsCsv([object({ creator: "Laureano Atlas" })], file);
    for (const [release, scripts] of releases()) {
      const read = frameworkCsvToJson(output, "objects", scripts);
      expect(read.ok, `${release}: ${read.log}`).toBe(true);
      const row = read.rows[0];
      expect([row.object_id, row.title, row.creator], release).toEqual(["obj-1", "Un objeto", "Laureano Atlas"]);
    }
  }, FRAMEWORK_TIMEOUT_MS);
});
