/**
 * glossary.csv published in the file's own column layout.
 *
 * The file's columns keep their order and header text, its comment rows stay
 * under the columns they annotate, and what the file lacks is appended. The
 * header text is kept for a fixed column only where every framework release
 * the Compositor publishes to reads it as that column.
 *
 * The first fixture quotes the header and the two instruction rows of
 * `telar-content/spreadsheets/glossary.csv` in the framework (9a9186bc),
 * with one term.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { GLOSSARY_CSV_COLUMNS, serializeGlossaryCsv } from "~/lib/publish.server";
import { GLOSSARY_CANONICAL_SCOPE, mapGlossaryCsv, parseTelarCsv } from "~/lib/import.server";
import { FRAMEWORK_GLOSSARY_COLUMN_ALIASES } from "~/lib/framework-sheet.server";
import {
  FRAMEWORK_SCRIPTS_DIR,
  FRAMEWORK_TIMEOUT_MS,
  PUBLISHED_FRAMEWORK_TAG,
  describeWithFramework,
  describeWithFrameworkTag,
  frameworkCsvToJson,
  frameworkGlossaryRead,
  frameworkScriptsAtTag,
  frameworkTagPresent,
  readFrameworkGlossaryAliases,
} from "./helpers/framework-checkout";

type Term = Parameters<typeof serializeGlossaryCsv>[0][number];

const INSTANCE_HEADER = "term_id,title,definition,kind";
const INSTANCE_COMMENT_EN =
  '# Make it lower-case and avoid spaces.,# Please provide a title — this is required.,"Panel content: write text here, paste markdown, or the name of an .md file in /components/texts/glossary/ (the .md extension is required)","# Optional. Leave blank for a key term, or write source for a primary source."';
const INSTANCE_COMMENT_ES =
  "# Escríbelo en minúsculas y sin espacios.,# Incluye un título: este campo es obligatorio.,\"Contenido del panel: escribe texto aquí, pega markdown, o indica un archivo archivo .md en /components/texts/glossary/ (la extensión .md es obligatoria)\",# Opcional. Déjalo en blanco si es un término; escribe fuente si es una fuente primaria.";

/** The terms D1 holds after the import reads `file`. */
function glossaryTermsImported(file: string): Term[] {
  return mapGlossaryCsv(parseTelarCsv(file, undefined, false, GLOSSARY_CANONICAL_SCOPE)) as Term[];
}

const FIXTURES: Record<number, string> = {
  1: [INSTANCE_HEADER, INSTANCE_COMMENT_EN, INSTANCE_COMMENT_ES, "telar,Telar,A loom,source"].join("\n") + "\n",
  2: "title,term_id,notes,definition\n# title note,# id note,# notes note,# def note\nTelar,telar,mine,A loom\n",
  3: "term_id,title,fuente_original,definition\n# id,# t,# source,# def\ntelar,Telar,,A loom\n",
  "4a": "id_término,título,definición\ntelar,Telar,A loom\n",
  "4b": "id_termino,titulo,definicion,terminos_relacionados\ntelar,Telar,A loom,\n",
  5: "Term_ID,Title,Definition\ntelar,Telar,A loom\n",
  6: "term_id,title,,definition\n# id,# t,# blank,# def\ntelar,Telar,,A loom\n",
  7: "term_id,title,definition,kind,tipo\n# id,# t,# d,# kind,# tipo\ntelar,Telar,A loom,,source\n",
  8: "term_id,title,definition,notes,Notes\ntelar,Telar,A loom,mine,\n",
} as unknown as Record<number, string>;

const glossaryPublished = (key: number | string) => {
  const file = FIXTURES[key as number];
  return serializeGlossaryCsv(glossaryTermsImported(file), file);
};
const glossaryLines = (key: number | string) => glossaryPublished(key).split("\n");

describe("glossary.csv in the file's own layout", () => {
  it("1: the test instance's file keeps `kind` and both instruction rows byte for byte", () => {
    const out = glossaryLines(1);
    expect(out[0]).toBe("term_id,title,definition,kind,related_terms");
    expect(out.slice(2, 4)).toEqual([INSTANCE_COMMENT_EN, INSTANCE_COMMENT_ES]);
  });

  it("2: columns keep their order, the comment row stays under its cells, `related_terms` is appended", () => {
    const out = glossaryLines(2);
    expect(out[0]).toBe("title,term_id,notes,definition,related_terms");
    expect(out[2]).toBe("# title note,# id note,# notes note,# def note");
    expect(out[3]).toBe("Telar,telar,mine,A loom,");
  });

  it("3: an empty custom column keeps its place and its comment cell", () => {
    const out = glossaryLines(3);
    expect(out[0]).toBe("term_id,title,fuente_original,definition,related_terms");
    expect(out[2]).toBe("# id,# t,# source,# def");
  });

  it("4: the Spanish header text is kept, accented or not", () => {
    expect(glossaryLines("4a")[0]).toBe("id_término,título,definición,related_terms");
    expect(glossaryLines("4b")[0]).toBe("id_termino,titulo,definicion,terminos_relacionados");
  });

  it("5: a capitalised header is written in the English name, which the glossaryPublished tag's link map needs", () => {
    expect(glossaryLines(5)[0]).toBe("term_id,title,definition,related_terms");
  });

  it("6: a blank header cell is kept in place with its comment cell", () => {
    const out = glossaryLines(6);
    expect(out[0]).toBe("term_id,title,,definition,related_terms");
    expect(out[2]).toBe("# id,# t,# blank,# def");
  });

  it("7: an empty `kind` beside a `tipo` holding a value is left out with its comment cell", () => {
    const out = glossaryLines(7);
    expect(out[0]).toBe("term_id,title,definition,tipo,related_terms");
    expect(out[2]).toBe("# id,# t,# d,# tipo");
    expect(out[3]).toBe("telar,Telar,A loom,source,");
  });

  it("7b: a sheet headed `tipo` keeps that header and the kind the author picked", () => {
    const file = "term_id,title,definition,tipo\n# id,# t,# d,# tipo\ntelar,Telar,A loom,source\n";
    const terms = glossaryTermsImported(file).map((t) => ({ ...t, kind: "place" }));
    const out = serializeGlossaryCsv(terms, file).split("\n");
    expect(out[0]).toBe("term_id,title,definition,tipo,related_terms");
    expect(out[3]).toBe("telar,Telar,A loom,place,");
  });

  it("7c: a sheet with no kind column gets `kind` appended once an entry has one", () => {
    const file = "term_id,title,definition\n# id,# t,# d\ntelar,Telar,A loom\n";
    const terms = glossaryTermsImported(file).map((t) => ({ ...t, kind: "source" }));
    const out = serializeGlossaryCsv(terms, file).split("\n");
    expect(out[0]).toBe("term_id,title,definition,related_terms,kind");
    expect(out[3]).toBe("telar,Telar,A loom,,source");
    expect(serializeGlossaryCsv(glossaryTermsImported(file), file).split("\n")[0]).toBe(
      "term_id,title,definition,related_terms",
    );
  });

  it("7d: a kind that names no kind is written as it was written", () => {
    const file = "term_id,title,definition,kind\n# id,# t,# d,# k\ntelar,Telar,A loom,Fuente_Primaria?\n";
    const imported = glossaryTermsImported(file);
    expect(imported[0].kind).toBe("Fuente_Primaria?");
    expect(imported[0].extra_columns).toBeUndefined();
    expect(serializeGlossaryCsv(imported, file).split("\n")[3]).toBe("telar,Telar,A loom,Fuente_Primaria?,");
  });

  it("8: an empty `Notes` beside a `notes` holding a value is left out", () => {
    const out = glossaryLines(8);
    expect(out[0]).toBe("term_id,title,definition,notes,related_terms");
    expect(out[2]).toBe("telar,Telar,A loom,mine,");
  });

  it("9: a D1 title in the first column that would read as a comment takes the plain layout", () => {
    const file = "title,term_id,definition\n";
    const term: Term = { term_id: "series", title: "#1 in the series", definition: "D", related_terms: null };
    expect(serializeGlossaryCsv([term], file).split("\n")[0]).toBe(GLOSSARY_CSV_COLUMNS.join(","));
  });

  it("10: a header Papa refused gets the canonical header and the file's comment rows", () => {
    const file = 'term_id,"title"x",notas\n# guide,t,d\ntelar,Telar,A loom\n';
    const term: Term = { term_id: "telar", title: "Telar", definition: "A loom", related_terms: null };
    const out = serializeGlossaryCsv([term], file).split("\n");
    expect(out[0]).toBe(GLOSSARY_CSV_COLUMNS.join(","));
    expect(out[2]).toBe("# guide,t,d");
  });

  it("11: a glossary that is not valid UTF-8 is written in the plain layout", () => {
    const file = "id_t�rmino,t�tulo,definici�n\n# guide,t,d\n";
    const out = serializeGlossaryCsv([], file, true).split("\n");
    expect(out[0]).toBe(GLOSSARY_CSV_COLUMNS.join(","));
    expect(out[2]).toBe("# guide,t,d");
  });

  it("a kept key the file lacks is appended, and the layout writes it exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const term: Term = {
      term_id: "telar", title: "Telar", definition: "A loom", related_terms: null,
      extra_columns: JSON.stringify({ notes: "mine" }),
    };
    const out = serializeGlossaryCsv([term], "term_id,title,definition\n# a,# b,# c\n").split("\n");
    expect(out[0]).toBe("term_id,title,definition,related_terms,notes");
    expect(out[3]).toBe("telar,Telar,A loom,,mine");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([1, 2, 3, "4a", "4b", 5, 6, 7, 8])("12: fixture %s read back gives D1's terms", (key) => {
    const file = FIXTURES[key as number];
    const terms = glossaryTermsImported(file);
    expect(terms.length).toBeGreaterThan(0);
    const again = glossaryTermsImported(glossaryPublished(key));
    const glossaryPick = (ts: Term[]) => ts.map((t) => [t.term_id, t.title, t.definition, t.related_terms ?? "", t.extra_columns ?? ""]);
    expect(glossaryPick(again)).toEqual(glossaryPick(terms));
  });
});

function glossaryReadByBoth(csv: string, scriptsDir: string) {
  return { glossary: frameworkGlossaryRead(csv, scriptsDir), sheet: frameworkCsvToJson(csv, "glossary", scriptsDir) };
}

function expectGlossaryBuilt(key: number | string, scriptsDir: string) {
  const { glossary, sheet } = glossaryReadByBoth(glossaryPublished(key), scriptsDir);
  expect(glossary.refused).toEqual([]);
  expect(sheet.ok).toBe(true);
  expect(glossary.linkIds).toContain("telar");
  expect(glossary.pages).toContain("telar.md");
}

const KEYS = [1, 2, 3, "4a", "4b", 5, 6, 7, 8] as const;

describeWithFramework("30: the glossaryPublished glossary.csv, read by the head", () => {
  it.each(KEYS)("fixture %s builds a page and a link for its term", { timeout: FRAMEWORK_TIMEOUT_MS }, (key) => {
    expectGlossaryBuilt(key, FRAMEWORK_SCRIPTS_DIR);
  });
});

describeWithFrameworkTag(PUBLISHED_FRAMEWORK_TAG, "30: the glossaryPublished glossary.csv, read by the glossaryPublished tag", () => {
  const scripts = frameworkTagPresent(PUBLISHED_FRAMEWORK_TAG) ? frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG) : "";
  it.each(KEYS)("fixture %s builds a page and a link for its term", { timeout: FRAMEWORK_TIMEOUT_MS }, (key) => {
    expectGlossaryBuilt(key, scripts);
  });

  it("5: the source's `Term_ID` holds no link map at the tag", { timeout: FRAMEWORK_TIMEOUT_MS }, () => {
    expect(frameworkGlossaryRead(FIXTURES[5 as number], scripts).linkIds).toEqual([]);
  });
});

describeWithFramework("29: the glossary's header aliases", () => {
  it("equal the head's entry for entry", () => {
    expect(readFrameworkGlossaryAliases()).toEqual({ ...FRAMEWORK_GLOSSARY_COLUMN_ALIASES });
  });
});

describeWithFrameworkTag(PUBLISHED_FRAMEWORK_TAG, "29: the glossary's header aliases at the glossaryPublished tag", () => {
  it("do not exist, so the tag entry of the glossary's releases is the one every sheet uses", () => {
    expect(readFrameworkGlossaryAliases(frameworkScriptsAtTag(PUBLISHED_FRAMEWORK_TAG))).toBeNull();
  });
});
