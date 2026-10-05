// @vitest-environment jsdom
/**
 * What `SheetWarnings` writes for each warning code, resolved against the
 * shipped catalogues in both languages.
 *
 * Every code has one sample carrying its fields, and each sentence has to
 * name the sheet it is about (all but the tree warning, which is about the
 * repository) and leave no placeholder unfilled. The English is pinned word
 * for word for the codes whose fields are lists or rows, where the formatting
 * is the component's own, and the plural codes are pinned in both forms. A
 * Spanish key still awaiting review falls back to the English; otherwise the
 * Spanish render must be the Spanish string.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SheetWarning, SheetWarningCode } from "~/lib/sheet-warnings";
import type { CatalogueLanguage } from "./helpers/catalogue-translator";
import { awaitingSpanish } from "./helpers/awaiting-spanish";

let language: CatalogueLanguage = "en";

vi.mock("react-i18next", async () => {
  const { catalogueT } = await import("./helpers/catalogue-translator");
  return { useTranslation: () => ({ t: catalogueT("common", language) }) };
});

import { SheetWarnings } from "~/components/ui/SheetWarnings";

afterEach(() => {
  cleanup();
  language = "en";
});

const SAMPLES: Record<SheetWarningCode, SheetWarning> = {
  ragged_row: { code: "ragged_row", row: { label: "obj-002" }, sheet: "objects.csv" },
  bilingual_header_row: { code: "bilingual_header_row", row: { position: 1 }, sheet: "objects.csv" },
  blank_header: { code: "blank_header", column: 4, sheet: "glossary.csv" },
  column_collision_only_filled: {
    code: "column_collision_only_filled",
    name: "medium_genre",
    headers: ["medium", "object_type"],
    kept: "medium",
    column: 3,
    sheet: "objects.csv",
  },
  column_collision_last: {
    code: "column_collision_last",
    name: "title",
    headers: ["title", "título"],
    column: 4,
    sheet: "glossary.csv",
  },
  reserved_column: { code: "reserved_column", columns: ["_metadata"], sheet: "objects.csv" },
  header_spelling: { code: "header_spelling", headers: ["Step", "Question"], names: ["step", "question"], sheet: "story.csv" },
  instruction_column: { code: "instruction_column", columns: ["#Note", "#nota"], sheet: "objects.csv" },
  folded_columns: {
    code: "folded_columns",
    groups: [["Nota", "nota"], ["credit", "crédito"]],
    sheet: "glossary.csv",
  },
  coordinate_invalid: { code: "coordinate_invalid", step: 2, column: "zoom", value: "abc", sheet: "story-one.csv" },
  page_below_one: { code: "page_below_one", step: 3, value: "0", sheet: "story-one.csv" },
  page_truncated: { code: "page_truncated", step: 4, value: "3.5", readAs: 3, sheet: "story-one.csv" },
  object_site_id_shared: {
    code: "object_site_id_shared",
    ids: ["map", "map.jpg"],
    shown: "map.jpg",
    sameRowEverywhere: true,
    sheet: "objects.csv",
  },
  object_id_repeated: { code: "object_id_repeated", id: "map", sameRowEverywhere: true, sheet: "objects.csv" },
  tree_truncated: { code: "tree_truncated" },
  unreadable_characters: { code: "unreadable_characters", file: "objects.csv", effect: "build_stops", repair: "publish" },
};

/** The catalogue value at a dotted path, or undefined. */
function catalogueValue(lang: CatalogueLanguage, path: string): unknown {
  const file = join(__dirname, "..", "app", "i18n", "locales", lang, "common.json");
  return path.split(".").reduce<unknown>(
    (node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined),
    JSON.parse(readFileSync(file, "utf-8")),
  );
}

/** The two codes' samples for a site whose pages read different rows of one id. */
const SPLIT_SAMPLES: SheetWarning[] = [
  { code: "object_site_id_shared", ids: ["map", "map.jpg"], shown: "map.jpg", sameRowEverywhere: false, sheet: "objects.csv" },
  { code: "object_id_repeated", id: "map", sameRowEverywhere: false, sheet: "objects.csv" },
];

/** The other sentences a misread heading is written in: one heading, `object_id`, and a Google Sheets tab. */
const HEADING_SAMPLES: SheetWarning[] = [
  { code: "header_spelling", headers: ["Step"], names: ["step"], sheet: "story.csv" },
  { code: "header_spelling", headers: ["Object_ID", "Title"], names: ["object_id", "title"], sheet: "objects.csv" },
  { code: "header_spelling", headers: ["Step"], names: ["step"], fromGoogleSheets: true, sheet: "story" },
  { code: "header_spelling", headers: ["Step", "Question"], names: ["step", "question"], fromGoogleSheets: true, sheet: "story" },
];

/** The key a misread heading renders from. */
function headingKeyOf(w: Extract<SheetWarning, { code: "header_spelling" }>): string {
  const count = w.headers.length === 1 ? "one" : "other";
  if (w.fromGoogleSheets) return `sheet_warnings.header_spelling_sheets_${count}`;
  return w.names.includes("object_id") ? "sheet_warnings.header_spelling_object_id" : `sheet_warnings.header_spelling_${count}`;
}

/** The key each sample renders from. */
function keyOf(w: SheetWarning): string {
  if (w.code === "ragged_row" || w.code === "bilingual_header_row") {
    return `sheet_warnings.${w.code}.${"label" in w.row ? "named" : "numbered"}`;
  }
  if (w.code === "header_spelling") return headingKeyOf(w);
  if (w.code === "reserved_column" || w.code === "instruction_column") {
    return `sheet_warnings.${w.code}_${w.columns.length === 1 ? "one" : "other"}`;
  }
  if (w.code === "unreadable_characters") return `sheet_warnings.${w.code}.${w.effect}`;
  if ((w.code === "object_site_id_shared" || w.code === "object_id_repeated") && !w.sameRowEverywhere) {
    return `sheet_warnings.${w.code}_split`;
  }
  return `sheet_warnings.${w.code}`;
}

function renderedSentence(w: SheetWarning): string {
  render(<SheetWarnings warnings={[w]} />);
  return within(screen.getByRole("list")).getByRole("listitem").textContent ?? "";
}

describe("SheetWarnings — one sentence per code", () => {
  for (const lang of ["en", "es"] as const) {
    for (const sample of [...Object.values(SAMPLES), ...SPLIT_SAMPLES, ...HEADING_SAMPLES]) {
      it(`${lang}: ${keyOf(sample)} fills every field and names its sheet`, () => {
        language = lang;
        const text = renderedSentence(sample);
        expect(text).not.toContain("{{");
        expect(text).not.toContain("sheet_warnings.");
        if ("sheet" in sample) expect(text).toContain(sample.sheet);
        if ("file" in sample) expect(text).toContain(sample.file);
        const pending = awaitingSpanish("common").includes(keyOf(sample));
        const source = lang === "es" && !pending ? "es" : "en";
        const template = catalogueValue(source, keyOf(sample));
        expect(typeof template).toBe("string");
        // The words around the fields are the catalogue's own.
        const firstWords = (template as string).split("{{")[0];
        expect(text.startsWith(firstWords)).toBe(true);
      });
    }
  }

  it("names each misread heading as typed and the heading it expects, by sheet and source", () => {
    expect(renderedSentence(SAMPLES.header_spelling)).toBe(
      'In the sheet "story.csv", your site doesn\'t recognize the headings "Step", "Question". It expects "step", "question", in that order, so what\'s in those columns doesn\'t appear on your site. Publish your site from the Publish tab to correct the headings.',
    );
    cleanup();
    expect(renderedSentence(HEADING_SAMPLES[0])).toBe(
      'In the sheet "story.csv", your site doesn\'t recognize the heading "Step". It expects "step", so what\'s in that column doesn\'t appear on your site. Publish your site from the Publish tab to correct the heading.',
    );
    cleanup();
    expect(renderedSentence(HEADING_SAMPLES[1])).toBe(
      'In the sheet "objects.csv", your site doesn\'t recognize the heading "Object_ID", "Title". It expects "object_id", "title", so it can\'t read any of your objects. Publish your site from the Publish tab to correct the heading.',
    );
    cleanup();
    expect(renderedSentence(HEADING_SAMPLES[2])).toBe(
      'Your site reads the tab "story" from Google Sheets, and Telar may not recognize its heading "Step". It expects "step". Change the heading in that tab in Google Sheets so that what\'s in the column appears on your site. If your site stops reading from Google Sheets, your next publish corrects the heading for you.',
    );
  });

  it("writes a cut-off row named by its first cell", () => {
    expect(renderedSentence(SAMPLES.ragged_row)).toBe(
      'Row "obj-002" in the sheet "objects.csv" has values in columns with no heading, so Telar left them out. To keep them, give each of those columns a heading in the sheet.',
    );
  });

  it("writes a skipped row named by its position", () => {
    expect(renderedSentence(SAMPLES.bilingual_header_row)).toContain('Telar skipped row 1 in the sheet "objects.csv"');
  });

  it("names every spelling of a dropped duplicate column, in quotes", () => {
    expect(renderedSentence(SAMPLES.column_collision_only_filled)).toBe(
      'The sheet "objects.csv" has more than one column for "medium_genre": "medium", "object_type". Only "medium" (column 3) has values, so Telar used it and ignored the empty ones. Delete the empty columns from the sheet.',
    );
  });

  it("names each group of folded columns", () => {
    expect(renderedSentence(SAMPLES.folded_columns)).toContain(
      'reads as one: "Nota", "nota"; "credit", "crédito".',
    );
  });

  describe("rows sharing an object id", () => {
    it("says a site that uses the last row everywhere uses it, for an id written twice", () => {
      expect(renderedSentence(SAMPLES.object_id_repeated)).toBe(
        'In the sheet "objects.csv", "map" appears in more than one row. Your site uses the last one, and your next publish keeps only that row.',
      );
    });

    it("says a site that reads different rows shows different rows, for an id written twice", () => {
      expect(renderedSentence(SPLIT_SAMPLES[1])).toBe(
        'In the sheet "objects.csv", "map" appears in more than one row, and different parts of your site show ' +
          "different rows. Your next publish keeps only the last row, and your site then uses it everywhere.",
      );
    });

    it("says a site that uses the last row everywhere shows it, for ids the site reads as one", () => {
      expect(renderedSentence(SAMPLES.object_site_id_shared)).toBe(
        'In the sheet "objects.csv", your site reads "map", "map.jpg" as one object and shows map.jpg. ' +
          "On the Objects tab, change the ID of one of them, or delete the one you don't want to keep.",
      );
    });

    it("says a site that reads different rows shows different rows, for ids the site reads as one", () => {
      expect(renderedSentence(SPLIT_SAMPLES[0])).toBe(
        'In the sheet "objects.csv", your site reads "map", "map.jpg" as one object, and different parts of your ' +
          "site show different rows. On the Objects tab, change the ID of one of them, or delete the one you don't want " +
          "to keep.",
      );
    });
  });

  it("counts the warnings in its summary", () => {
    render(<SheetWarnings warnings={[SAMPLES.ragged_row, SAMPLES.tree_truncated]} />);
    expect(screen.getByText("2 warnings in your sheets")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("counts the columns for a reserved or instruction column, in either language", () => {
    expect(renderedSentence(SAMPLES.reserved_column)).toBe(
      'The sheet "objects.csv" has a column whose heading Telar keeps for its own use: "_metadata". You can\'t publish until you remove it. You can remove it on the Publish tab, or change the heading in the sheet.',
    );
    cleanup();
    expect(renderedSentence(SAMPLES.instruction_column)).toContain(
      'The sheet "objects.csv" has columns whose headings start with "#": "#Note", "#nota".',
    );
    cleanup();
    language = "es";
    expect(renderedSentence(SAMPLES.reserved_column)).toBe(
      'La hoja "objects.csv" tiene una columna con un encabezado que Telar reserva para su propio uso: "_metadata". No podrás publicar hasta que la quites. Puedes quitarla en la pestaña Publicar o cambiarle el encabezado en la hoja.',
    );
    cleanup();
    expect(renderedSentence(SAMPLES.instruction_column)).toContain(
      'La hoja "objects.csv" tiene columnas cuyos encabezados empiezan por "#": "#Note", "#nota".',
    );
  });

  it("writes the Spanish for a cut-off row", () => {
    language = "es";
    expect(renderedSentence(SAMPLES.ragged_row)).toBe(
      'La fila "obj-002" de la hoja "objects.csv" tiene valores en columnas sin encabezado, así que Telar los dejó por fuera. Para conservarlos, ponle un encabezado a cada una de esas columnas en la hoja.',
    );
  });

  describe("a file with unreadable characters", () => {
    const EFFECTS = {
      build_stops: 'The file "objects.csv" has characters your site can\'t read, so your site can\'t update.',
      left_out: 'The file "story-one.csv" has characters your site can\'t read, so your site leaves it out.',
      name_shown:
        'The file "telar-content/texts/stories/layer.md" has characters your site can\'t read, so your site shows the file\'s name instead of its text.',
      from_sheets:
        'On GitHub, the file "objects.csv" has characters that aren\'t valid text. Your site takes this sheet from Google Sheets, so it isn\'t affected.',
      not_used:
        'The file "story-one.csv" has characters that aren\'t valid text. Your site doesn\'t use this file, so it isn\'t affected.',
    } as const;
    const FILES = {
      build_stops: "objects.csv",
      left_out: "story-one.csv",
      name_shown: "telar-content/texts/stories/layer.md",
      from_sheets: "objects.csv",
      not_used: "story-one.csv",
    } as const;
    const REPAIRS = {
      publish: "The next time you publish a change, your site's copy is replaced, with \uFFFD in place of those characters.",
      title_then_publish: "Give this page a title on the Pages tab, and your next publish replaces them with \uFFFD.",
      import_then_publish: "If you import this page, your next publish replaces them with \uFFFD.",
      remove_old_copy: "It's an old copy of one of your stories, and your next publish removes it.",
    } as const;

    for (const effect of Object.keys(EFFECTS) as (keyof typeof EFFECTS)[]) {
      it(`writes what the site does (${effect}), then the repair`, () => {
        const text = renderedSentence({ code: "unreadable_characters", file: FILES[effect], effect, repair: "publish" });
        expect(text).toBe(`${EFFECTS[effect]} ${REPAIRS.publish}`);
      });
    }

    for (const repair of Object.keys(REPAIRS) as (keyof typeof REPAIRS)[]) {
      it(`writes the repair for ${repair} after the effect`, () => {
        const text = renderedSentence({
          code: "unreadable_characters",
          file: "telar-content/texts/pages/about.md",
          effect: "build_stops",
          repair,
        });
        expect(text).toBe(
          `The file "telar-content/texts/pages/about.md" has characters your site can't read, so your site can't update. ${REPAIRS[repair]}`,
        );
      });
    }

    it("writes the Spanish for a file the site can't read and a publish replaces", () => {
      language = "es";
      expect(
        renderedSentence({ code: "unreadable_characters", file: "objects.csv", effect: "build_stops", repair: "publish" }),
      ).toBe(
        'El archivo "objects.csv" tiene caracteres que tu sitio no puede leer, así que el sitio no se puede actualizar. ' +
          "La próxima vez que publiques un cambio, el archivo se reemplazará en el sitio por una versión con \uFFFD en lugar de esos caracteres.",
      );
    });
  });

  it("writes the Spanish for an old copy of a story", () => {
    language = "es";
    expect(
      renderedSentence({ code: "unreadable_characters", file: "story-one.csv", effect: "not_used", repair: "remove_old_copy" }),
    ).toBe(
      'El archivo "story-one.csv" tiene caracteres que no son texto válido. Tu sitio no usa este archivo, así que esto no lo afecta. ' +
        "Es una copia antigua de una de tus historias, y se borrará del sitio la próxima vez que publiques un cambio.",
    );
  });

  describe("the summary", () => {
    const page: SheetWarning = {
      code: "unreadable_characters",
      file: "telar-content/texts/pages/about.md",
      effect: "build_stops",
      repair: "import_then_publish",
    };

    it("counts warnings about the site's files when one names a file that is not a sheet", () => {
      render(<SheetWarnings warnings={[page]} />);
      expect(screen.getByText("1 warning about your site's files")).toBeTruthy();
      cleanup();
      render(<SheetWarnings warnings={[SAMPLES.ragged_row, page]} />);
      expect(screen.getByText("2 warnings about your site's files")).toBeTruthy();
      cleanup();
      language = "es";
      render(<SheetWarnings warnings={[page]} />);
      expect(screen.getByText("1 advertencia en los archivos de tu sitio")).toBeTruthy();
    });

    it("counts warnings in the sheets when every warning names a sheet", () => {
      render(<SheetWarnings warnings={[SAMPLES.ragged_row, SAMPLES.unreadable_characters]} />);
      expect(screen.getByText("2 warnings in your sheets")).toBeTruthy();
    });
  });

  it("renders nothing for no warnings", () => {
    const { container } = render(<SheetWarnings warnings={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
