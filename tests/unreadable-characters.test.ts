/**
 * The fields of the warning for a file read lossily at the head: the name the
 * author sees, what the site does with the file, and when Google Sheets takes
 * a sheet from its tab instead.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import type { SheetWarning } from "~/lib/sheet-warnings";
import { markSheetsEffects, pushUnreadable } from "~/lib/unreadable-characters.server";

function warned(path: string, repair?: "publish" | "title_then_publish" | "import_then_publish"): SheetWarning[] {
  const sink: SheetWarning[] = [];
  pushUnreadable(sink, path, repair);
  return sink;
}

describe("the effect and name of an unreadable file", () => {
  it.each([
    ["telar-content/spreadsheets/objects.csv", "objects.csv"],
    ["telar-content/spreadsheets/project.csv", "project.csv"],
    ["telar-content/spreadsheets/glossary.csv", "glossary.csv"],
    ["telar-content/spreadsheets/objetos.csv", "objetos.csv"],
    ["telar-content/spreadsheets/proyecto.csv", "proyecto.csv"],
    ["_config.yml", "_config.yml"],
    ["index.md", "index.md"],
    ["telar-content/texts/pages/about.md", "telar-content/texts/pages/about.md"],
  ])("%s stops the build, named %s", (path, file) => {
    expect(warned(path)).toEqual([{ code: "unreadable_characters", file, effect: "build_stops", repair: "publish" }]);
  });

  it("leaves a story's step CSV out, named by its file name", () => {
    expect(warned("telar-content/spreadsheets/story-one.csv")).toEqual([
      { code: "unreadable_characters", file: "story-one.csv", effect: "left_out", repair: "publish" },
    ]);
  });

  it("shows a layer file's name, named by its path", () => {
    expect(warned("telar-content/texts/stories/story-one/layer.md")).toEqual([
      {
        code: "unreadable_characters",
        file: "telar-content/texts/stories/story-one/layer.md",
        effect: "name_shown",
        repair: "publish",
      },
    ]);
  });

  it("stops the build for a story CSV at the older _data path, which the next publish removes", () => {
    // Jekyll reads every CSV under _data as site data and stops on bytes that
    // are not valid UTF-8; the publish writes the story to spreadsheets/.
    expect(warned("_data/story-one.csv")).toEqual([
      { code: "unreadable_characters", file: "_data/story-one.csv", effect: "build_stops", repair: "remove_old_copy" },
    ]);
  });

  it("says a story CSV at the repository's root is not used by the site, and the next publish removes it", () => {
    expect(warned("story-one.csv")).toEqual([
      { code: "unreadable_characters", file: "story-one.csv", effect: "not_used", repair: "remove_old_copy" },
    ]);
  });

  it("carries the repair it is given", () => {
    expect(warned("telar-content/texts/pages/about.md", "import_then_publish")[0]).toMatchObject({
      repair: "import_then_publish",
    });
  });

  it("names a file once per list", () => {
    const sink: SheetWarning[] = [];
    pushUnreadable(sink, "telar-content/texts/stories/a.md");
    pushUnreadable(sink, "telar-content/texts/stories/a.md");
    expect(sink).toHaveLength(1);
  });

  it("does nothing without a list", () => {
    expect(() => pushUnreadable(undefined, "index.md")).not.toThrow();
  });
});

describe("a sheet Google Sheets takes from its tab", () => {
  const SHEETS = { enabled: true, publishedUrl: "https://docs.google.com/spreadsheets/d/e/X/pubhtml" };

  function lossy(...paths: string[]): SheetWarning[] {
    const sink: SheetWarning[] = [];
    for (const p of paths) pushUnreadable(sink, p);
    return sink;
  }

  it("is from_sheets for objects.csv and a story CSV with a tab", async () => {
    const warnings = lossy("telar-content/spreadsheets/objects.csv", "telar-content/spreadsheets/story-one.csv");
    await markSheetsEffects(warnings, SHEETS, async () => [{ name: "Objects" }, { name: "Story-One" }]);
    expect(warnings.map((w) => (w as { effect: string }).effect)).toEqual(["from_sheets", "from_sheets"]);
  });

  it("drops a misread-heading warning on a sheet's file where a tab supplies the sheet, and keeps the others", async () => {
    const heading = (sheet: string, fromGoogleSheets?: true): SheetWarning => ({
      code: "header_spelling",
      headers: ["Step"],
      names: ["step"],
      ...(fromGoogleSheets ? { fromGoogleSheets } : {}),
      sheet,
    });
    const warnings = [heading("objects.csv"), heading("story-two.csv"), heading("objects.csv", true)];
    await markSheetsEffects(warnings, SHEETS, async () => [{ name: "Objects" }]);
    expect(warnings).toEqual([heading("story-two.csv"), heading("objects.csv", true)]);
  });

  it("drops a misread-heading warning on a Spanish file whose English tab the build fetches over what the publish writes", async () => {
    const heading = (sheet: string): SheetWarning => ({ code: "header_spelling", headers: ["Object_ID"], names: ["object_id"], sheet });
    const english = [heading("objetos.csv"), heading("proyecto.csv")];
    await markSheetsEffects(english, SHEETS, async () => [{ name: "objects" }, { name: "project" }]);
    expect(english).toEqual([]);
    const spanish = [heading("objetos.csv")];
    await markSheetsEffects(spanish, SHEETS, async () => [{ name: "objetos" }]);
    expect(spanish).toEqual([]);
  });

  it("keeps every misread-heading warning with Sheets off, and lists no tabs", async () => {
    const warnings: SheetWarning[] = [{ code: "header_spelling", headers: ["Step"], names: ["step"], sheet: "objects.csv" }];
    const listTabs = vi.fn(async () => [{ name: "objects" }]);
    await markSheetsEffects(warnings, { enabled: false, publishedUrl: SHEETS.publishedUrl }, listTabs);
    expect(warnings).toHaveLength(1);
    expect(listTabs).not.toHaveBeenCalled();
  });

  it("keeps build_stops and left_out with Sheets on but no tab", async () => {
    const warnings = lossy("telar-content/spreadsheets/objects.csv", "telar-content/spreadsheets/story-one.csv");
    await markSheetsEffects(warnings, SHEETS, async () => [{ name: "project" }, { name: "#story-one" }]);
    expect(warnings.map((w) => (w as { effect: string }).effect)).toEqual(["build_stops", "left_out"]);
  });

  it("stops the build on a glosario.csv the build reads as the glossary, and leaves out one beside glossary.csv", async () => {
    const path = "telar-content/spreadsheets/glosario.csv";
    const alone = lossy(path);
    await markSheetsEffects(alone, null, undefined, async () => false);
    expect(alone[0]).toMatchObject({ file: "glosario.csv", effect: "build_stops" });

    const beside = lossy(path);
    await markSheetsEffects(beside, null, undefined, async () => true);
    expect(beside[0]).toMatchObject({ file: "glosario.csv", effect: "left_out" });
  });

  it("keeps the effects when the tab listing fails", async () => {
    const warnings = lossy("telar-content/spreadsheets/objects.csv", "telar-content/spreadsheets/story-one.csv");
    await markSheetsEffects(warnings, SHEETS, async () => {
      throw new Error("503");
    });
    expect(warnings.map((w) => (w as { effect: string }).effect)).toEqual(["build_stops", "left_out"]);
  });

  it("keeps a root CSV the site does not use out of from_sheets", async () => {
    const warnings = lossy("story-one.csv");
    const listTabs = vi.fn(async () => [{ name: "story-one" }]);
    await markSheetsEffects(warnings, SHEETS, listTabs);
    expect(warnings[0]).toMatchObject({ effect: "not_used" });
    expect(listTabs).not.toHaveBeenCalled();
  });

  it("keeps _config.yml at build_stops with Sheets on", async () => {
    const warnings = lossy("_config.yml", "telar-content/spreadsheets/objects.csv");
    const listTabs = vi.fn(async () => [{ name: "objects" }, { name: "_config" }]);
    await markSheetsEffects(warnings, SHEETS, listTabs);
    expect(warnings[0]).toMatchObject({ file: "_config.yml", effect: "build_stops" });
    expect(warnings[1]).toMatchObject({ file: "objects.csv", effect: "from_sheets" });
  });

  it("lists no tabs when no sheet is named", async () => {
    const listTabs = vi.fn(async () => [{ name: "objects" }]);
    await markSheetsEffects(lossy("_config.yml", "telar-content/texts/pages/about.md"), SHEETS, listTabs);
    await markSheetsEffects([], SHEETS, listTabs);
    expect(listTabs).not.toHaveBeenCalled();
  });

  it("lists no tabs with Sheets off", async () => {
    const listTabs = vi.fn(async () => [{ name: "objects" }]);
    const warnings = lossy("telar-content/spreadsheets/objects.csv");
    await markSheetsEffects(warnings, { enabled: false, publishedUrl: SHEETS.publishedUrl }, listTabs);
    expect(listTabs).not.toHaveBeenCalled();
    expect(warnings[0]).toMatchObject({ effect: "build_stops" });
  });

  it("lists the tabs through discoverSheetTabs by default, with one request", async () => {
    const fetchMock = vi.fn(
      async () => new Response('items.push({name: "objects", pageUrl: "x", gid: "0"});', { status: 200 }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const warnings = lossy("telar-content/spreadsheets/objects.csv");
      await markSheetsEffects(warnings, SHEETS);
      expect(warnings[0]).toMatchObject({ effect: "from_sheets" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
