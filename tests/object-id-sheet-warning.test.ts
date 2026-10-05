/**
 * The sheet warning for rows the site reads as one object is written from
 * the catalogue in both locales, naming the rows and the one the site shows.
 *
 * `catalogueT` resolves against the shipped files, so a key missing from
 * either locale fails here rather than reaching the screen as a raw key.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { sheetWarningText } from "~/components/ui/SheetWarnings";
import { catalogueT } from "./helpers/catalogue-translator";

const warning = {
  code: "object_site_id_shared",
  ids: ["map", "map.jpg"],
  shown: "map.jpg",
  sameRowEverywhere: true,
  sheet: "objects.csv",
} as const;

describe("the shared site id sheet warning", () => {
  for (const language of ["en", "es"] as const) {
    it(`is a catalogue sentence in ${language} naming the sheet, the rows and the row shown`, () => {
      const text = sheetWarningText(catalogueT("common", language) as never, { ...warning, ids: [...warning.ids] });
      expect(text).not.toContain("sheet_warnings.");
      expect(text).toContain("objects.csv");
      expect(text).toContain('"map", "map.jpg"');
      expect(text).toContain("map.jpg");
    });
  }
});
