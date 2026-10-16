/**
 * The manifest's `csv_language_match` operation: the validator, the cell it
 * writes for each site language and in which field of the row, what it
 * leaves alone, the site language it reads as the framework reads it, and the
 * runs the chain reports.
 *
 * The operation is tests/fixtures/csv-language-match-op.json, the one the
 * framework generates for the `telar` glossary entry, as it generated it. The
 * glossary is the template's
 * header and instruction rows with the `telar` entry as each release wrote it.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect } from "vitest";
import OP_JSON from "./fixtures/csv-language-match-op.json";
import { applyCsvLanguageMatch, frameworkLanguage } from "~/lib/csv-language-match.server";
import { applyManifestChain } from "~/lib/manifest-runner.server";
import {
  validateManifest,
  ManifestValidationError,
  type CsvLanguageMatchOp,
  type Language,
  type Manifest,
} from "~/lib/manifest-schema.server";
import { collectFilesReferencedByChain } from "~/lib/upgrade.server";

const OP = OP_JSON as CsvLanguageMatchOp;
const FILE = OP.file;

const HEAD_EN = [
  "term_id,title,definition",
  "id_término,titulo,definición",
  '# Make it lower-case and avoid spaces.,# Please provide a title — this is required.,"Panel content: write text here, paste markdown, or the name of an .md file in /components/texts/glossary/ (the .md extension is required)"',
];
const HEAD_ES = ["id_término,titulo,definición", "term_id,title,definition"];

function quoted(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/** A glossary with the `telar` entry's definition `definition`, its lines ended by `newline`. */
function glossary(definition: string, { newline = "\n", head = HEAD_EN } = {}): string {
  const cell = quoted(definition.replace(/\n/g, newline));
  return [...head, `telar,Telar,${cell}`, "impressionism,Impressionism,An art movement"].join(newline) + newline;
}

function apply(content: string, lang: Language, op: CsvLanguageMatchOp = OP): { changed: boolean; text: string | undefined } {
  const files = new Map([[FILE, content]]);
  const changed = applyCsvLanguageMatch(files, op, lang);
  return { changed, text: files.get(FILE) };
}

function manifestWith(op: unknown): unknown {
  return {
    schema_version: 1,
    from_version: "1.8.1",
    to_version: "1.8.2",
    description: "test",
    operations: [op],
    manual_steps: { en: [], es: [] },
  };
}

describe("csv_language_match on the telar entry", () => {
  for (const [i, released] of OP.cases.entries()) {
    for (const lang of ["en", "es"] as const) {
      it(`writes the ${lang} paragraph over released text ${i + 1}, and nothing else`, () => {
        const { changed, text } = apply(glossary(released.equals), lang);
        expect(changed).toBe(true);
        expect(text).toBe(glossary(released.values[lang]!));
      });
    }
  }

  it("leaves a definition the author edited alone", () => {
    const edited = `${OP.cases[1].equals} Edited.`;
    expect(apply(glossary(edited), "en")).toEqual({ changed: false, text: glossary(edited) });
  });

  it("matches a CRLF file's cell and keeps every CRLF line ending", () => {
    const before = glossary(OP.cases[0].equals, { newline: "\r\n" });
    const { changed, text } = apply(before, "es");
    expect(changed).toBe(true);
    expect(text).toBe(glossary(OP.cases[0].values.es!, { newline: "\r\n" }));
  });

  it("writes a line break inside the value with the cell's own CRLF", () => {
    const op: CsvLanguageMatchOp = { ...OP, cases: [{ equals: OP.cases[0].equals, values: { en: "One.\n\nTwo." } }] };
    const { text } = apply(glossary(OP.cases[0].equals, { newline: "\r\n" }), "en", op);
    expect(text).toContain('telar,Telar,"One.\r\n\r\nTwo."\r\n');
  });

  it("matches a glossary.csv that opens with a byte order mark, and keeps the mark", () => {
    const { changed, text } = apply(`﻿${glossary(OP.cases[1].equals, { newline: "\r\n" })}`, "en");
    expect(changed).toBe(true);
    expect(text).toBe(`﻿${glossary(OP.cases[1].values.en!, { newline: "\r\n" })}`);
  });

  it("changes nothing more when applied twice", () => {
    const once = apply(glossary(OP.cases[1].equals), "es").text!;
    expect(apply(once, "es")).toEqual({ changed: false, text: once });
  });

  it("finds the columns under the Spanish headers the Compositor publishes for a Spanish site", () => {
    const head = { head: HEAD_ES };
    const { changed, text } = apply(glossary(OP.cases[1].equals, head), "es");
    expect(changed).toBe(true);
    expect(text).toBe(glossary(OP.cases[1].values.es!, head));
  });

  it("changes nothing without the row, the column or the file", () => {
    const noRow = glossary(OP.cases[0].equals).replace("telar,Telar,", "loom,Telar,");
    expect(apply(noRow, "en")).toEqual({ changed: false, text: noRow });
    const noColumn = glossary(OP.cases[0].equals).replace(/definition/, "description");
    expect(apply(noColumn, "en")).toEqual({ changed: false, text: noColumn });
    const files = new Map<string, string>();
    expect(applyCsvLanguageMatch(files, OP, "en")).toBe(false);
    expect(files.has(FILE)).toBe(false);
  });

  it("writes the definition's own field when the released text is quoted in another column of the row", () => {
    const op: CsvLanguageMatchOp = { ...OP, cases: [{ equals: "old", values: { en: "new" } }] };
    const before = 'term_id,title,definition\ntelar,"Text ""old"" cited",old\n';
    expect(apply(before, "en", op)).toEqual({ changed: true, text: 'term_id,title,definition\ntelar,"Text ""old"" cited",new\n' });
  });

  it("writes the definition's own field when another column holds the same quoted text", () => {
    const op: CsvLanguageMatchOp = { ...OP, cases: [{ equals: "old, text", values: { en: "new, text" } }] };
    const before = 'term_id,title,definition\ntelar,"old, text","old, text"\n';
    expect(apply(before, "en", op).text).toBe('term_id,title,definition\ntelar,"old, text","new, text"\n');
  });

  it("writes an unquoted field unquoted, and quotes it where the new text needs quotes", () => {
    const plain: CsvLanguageMatchOp = { ...OP, cases: [{ equals: "old", values: { en: "new" } }] };
    const before = "term_id,title,definition,kind\ntelar,Telar,old,concept\n";
    expect(apply(before, "en", plain).text).toBe("term_id,title,definition,kind\ntelar,Telar,new,concept\n");
    const quoting: CsvLanguageMatchOp = { ...OP, cases: [{ equals: "old", values: { en: 'a "new", text' } }] };
    expect(apply(before, "en", quoting).text).toBe('term_id,title,definition,kind\ntelar,Telar,"a ""new"", text",concept\n');
  });

  it("changes nothing when two rows hold the key", () => {
    const twice = glossary(OP.cases[0].equals) + `telar,Telar,${quoted(OP.cases[0].equals)}\n`;
    expect(apply(twice, "en")).toEqual({ changed: false, text: twice });
  });

  it("changes nothing when the case has no text in the site's language", () => {
    const op: CsvLanguageMatchOp = { ...OP, cases: [{ equals: OP.cases[0].equals, values: { en: OP.cases[0].values.en } }] };
    const before = glossary(OP.cases[0].equals);
    expect(apply(before, "es", op)).toEqual({ changed: false, text: before });
  });
});

describe("csv_language_match in the chain", () => {
  const chain = [validateManifest(manifestWith(OP))];

  const config = (lang: string) => `telar:\n  version: "1.8.2"\ntelar_language: ${lang}\n`;

  it("reports the run, its language and that it changed the glossary", () => {
    const result = applyManifestChain(chain, new Map([[FILE, glossary(OP.cases[0].equals)], ["_config.yml", config('"en"')]]), "en");
    expect(result.files.get(FILE)).toBe(glossary(OP.cases[0].values.en!));
    expect(result.languageMatches).toEqual([{ op: OP, lang: "en", changed: true }]);
  });

  it("reports the run as changing nothing when the definition was edited", () => {
    const result = applyManifestChain(chain, new Map([[FILE, glossary("Our own words.")], ["_config.yml", config('"en"')]]), "en");
    expect(result.languageMatches).toEqual([{ op: OP, lang: "en", changed: false }]);
  });

  it("writes the Spanish paragraph for telar_language ES, as the framework lowercases it, whatever language the chain is given", () => {
    const result = applyManifestChain(chain, new Map([[FILE, glossary(OP.cases[1].equals)], ["_config.yml", config('"ES"')]]), "en");
    expect(result.files.get(FILE)).toBe(glossary(OP.cases[1].values.es!));
    expect(result.languageMatches[0].lang).toBe("es");
  });

  it("reads the glossary before the chain runs", () => {
    expect(collectFilesReferencedByChain(chain as Manifest[])).toContain(FILE);
  });
});

describe("the site language csv_language_match reads, as the framework's _detect_language reads it", () => {
  const cases: Array<[string, string | undefined, Language]> = [
    ["lowercase Spanish", 'telar_language: "es"\n', "es"],
    ["uppercase Spanish", "telar_language: ES\n", "es"],
    ["a Spanish locale", "telar_language: es-CO\n", "es"],
    ["English", "telar_language: en\n", "en"],
    ["a language neither", "telar_language: fr\n", "en"],
    ["the nested form", "telar:\n  telar_language: Es\n", "es"],
    ["a null top-level key over the nested form", "telar_language:\ntelar:\n  telar_language: es\n", "es"],
    ["no key", "title: Site\n", "en"],
    ["a value that is not text", "telar_language: 12\n", "en"],
    ["a config that does not load", "telar_language: [es\n", "en"],
    ["no config", undefined, "en"],
  ];
  for (const [name, config, lang] of cases) {
    it(`reads ${name} as ${lang}`, () => {
      expect(frameworkLanguage(config)).toBe(lang);
    });
  }
});

describe("csv_language_match validation", () => {
  it("accepts the operation the framework generated", () => {
    expect(() => validateManifest(manifestWith(OP))).not.toThrow();
  });

  const malformed: Array<[string, unknown, string]> = [
    ["without a key", { ...OP, key: undefined }, "/operations/0/key"],
    ["without cases", (({ cases: _cases, ...rest }) => rest)(OP), "/operations/0/cases"],
    ["with no cases", { ...OP, cases: [] }, "/operations/0/cases"],
    ["with a case that has no equals", { ...OP, cases: [{ values: { en: "x" } }] }, "/operations/0/cases/0/equals"],
    ["with a value that is not text", { ...OP, cases: [{ equals: "x", values: { es: 1 } }] }, "/operations/0/cases/0/values/es"],
    ["with values that are not an object", { ...OP, cases: [{ equals: "x", values: "x" }] }, "/operations/0/cases/0/values"],
    ["on a file outside the scope allowlist", { ...OP, file: "../glossary.csv" }, "/operations/0/file"],
  ];
  for (const [name, op, path] of malformed) {
    it(`refuses one ${name}`, () => {
      let caught: unknown;
      try {
        validateManifest(manifestWith(op));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ManifestValidationError);
      expect((caught as ManifestValidationError).path).toBe(path);
    });
  }
});
