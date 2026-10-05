/**
 * The publish checks name the warnings a GitHub edit left in a sheet.
 *
 * A sheet can parse to the values D1 holds and still raise a warning: a row
 * with more cells than columns, a second bilingual header row, a column with
 * no heading. The next publish rewrites the sheet from D1, so the checks say
 * so before it does, naming the sheet and the row. Each sheet is read once, at
 * the commit the checks compared against, and a sheet that cannot be read whole
 * gives nothing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import type { FileAtRef } from "~/lib/github.server";
import type { ValidationResult } from "~/lib/publish.server";
import { sheetWarningChecksAt } from "~/lib/sheet-warning-checks.server";
import { headingFilesOf } from "~/lib/sheet-warnings";
import { discoverSheetTabs } from "~/lib/sheets.server";

vi.mock("~/lib/sheets.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  discoverSheetTabs: vi.fn(),
}));

const DIR = "telar-content/spreadsheets";
const ok = (content: string): FileAtRef => ({ status: "ok", content });
const PASSING: ValidationResult = { blockers: [], warnings: [] };

function readerOf(files: Record<string, FileAtRef>) {
  return vi.fn(async (path: string) => files[path] ?? ({ status: "absent" } as FileAtRef));
}

const RAGGED_OBJECTS = "object_id,title\nloom,Loom,extra cell\nspindle,Spindle\n";

describe("sheetWarningChecksAt", () => {
  it("names the sheet and the row of a ragged row", async () => {
    const read = readerOf({ [`${DIR}/objects.csv`]: ok(RAGGED_OBJECTS) });
    const items = await sheetWarningChecksAt(PASSING, [], read);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      code: "sheet_warning",
      sheetWarning: { code: "ragged_row", sheet: "objects.csv", row: { label: "loom" } },
    });
  });

  it("reads each sheet once: project, objects, glossary and every story", async () => {
    const read = readerOf({
      [`${DIR}/project.csv`]: ok("story_id,title\nweavers,The Weavers\n"),
      [`${DIR}/objects.csv`]: ok("object_id,title\nloom,Loom\n"),
      [`${DIR}/glossary.csv`]: ok("term_id,title,definition\nwarp,Warp,Threads\n"),
    });
    await sheetWarningChecksAt(PASSING, ["weavers", "dyers"], read);
    expect(read.mock.calls.map((c) => c[0]).sort()).toEqual([
      `${DIR}/dyers.csv`,
      `${DIR}/glossary.csv`,
      `${DIR}/objects.csv`,
      `${DIR}/project.csv`,
      `${DIR}/weavers.csv`,
    ]);
  });

  it("reads the Spanish file of a site sheet only where the English one is absent, and names that file", async () => {
    const read = readerOf({
      [`${DIR}/objetos.csv`]: ok(RAGGED_OBJECTS),
      [`${DIR}/proyecto.csv`]: ok("story_id,title\nweavers,The Weavers,extra cell\n"),
    });
    const items = await sheetWarningChecksAt(PASSING, ["weavers"], read);
    expect(items.map((i) => i.sheetWarning)).toEqual([
      expect.objectContaining({ code: "ragged_row", sheet: "proyecto.csv" }),
      expect.objectContaining({ code: "ragged_row", sheet: "objetos.csv" }),
    ]);
    expect(items.map((i) => i.entityId)).toEqual(["proyecto.csv/0", "objetos.csv/0"]);
  });

  it("does not read objetos.csv where objects.csv is there", async () => {
    const read = readerOf({ [`${DIR}/objects.csv`]: ok(RAGGED_OBJECTS), [`${DIR}/objetos.csv`]: ok(RAGGED_OBJECTS) });
    const items = await sheetWarningChecksAt(PASSING, [], read);
    expect(items).toHaveLength(1);
    expect(read.mock.calls.map((c) => c[0])).not.toContain(`${DIR}/objetos.csv`);
  });

  it("names the sheet and the row of a ragged row in project.csv", async () => {
    const csv = "story_id,title\nweavers,The Weavers,extra cell\n";
    const read = readerOf({ [`${DIR}/project.csv`]: ok(csv) });
    const items = await sheetWarningChecksAt(PASSING, ["weavers"], read);
    expect(items.map((i) => i.sheetWarning)).toEqual([
      expect.objectContaining({ code: "ragged_row", sheet: "project.csv", row: { label: "weavers" } }),
    ]);
  });

  it("reads a story sheet through the story mapper", async () => {
    const csv = "step,object,x,y,zoom,question,answer\n1,loom,left,0.5,1,Q,A\n";
    const read = readerOf({ [`${DIR}/weavers.csv`]: ok(csv) });
    const items = await sheetWarningChecksAt(PASSING, ["weavers"], read);
    expect(items.map((i) => i.sheetWarning)).toEqual([
      expect.objectContaining({ code: "coordinate_invalid", sheet: "weavers.csv", column: "x" }),
    ]);
  });

  it("gives nothing while the stale-head blocker stands, and reads nothing", async () => {
    const read = readerOf({ [`${DIR}/objects.csv`]: ok(RAGGED_OBJECTS) });
    const stale: ValidationResult = {
      blockers: [{ code: "stale_head", message: "stale_head" }],
      warnings: [],
    };
    expect(await sheetWarningChecksAt(stale, [], read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it("gives nothing for a sheet that cannot be read whole", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = readerOf({ [`${DIR}/objects.csv`]: { status: "error" } });
    expect(await sheetWarningChecksAt(PASSING, [], read)).toEqual([]);
  });

  it("leaves out the warnings the publish already blocks on", async () => {
    const read = readerOf({ [`${DIR}/objects.csv`]: ok("object_id,title,_metadata\nloom,Loom,x\n") });
    const items = await sheetWarningChecksAt(PASSING, [], read);
    expect(items.map((i) => i.sheetWarning?.code)).not.toContain("reserved_column");
  });

  it("gives nothing for a clean sheet", async () => {
    const read = readerOf({ [`${DIR}/objects.csv`]: ok("object_id,title\nloom,Loom\n") });
    expect(await sheetWarningChecksAt(PASSING, [], read)).toEqual([]);
  });

  it("lists misread headings as a non-blocking check naming the file", async () => {
    const read = readerOf({ [`${DIR}/objects.csv`]: ok("Object_ID,title\nloom,Loom\n") });
    const items = await sheetWarningChecksAt(PASSING, [], read);
    expect(items).toEqual([
      {
        code: "sheet_warning",
        message: "sheet_warning",
        entityId: "objects.csv/0",
        sheetWarning: { code: "header_spelling", headers: ["Object_ID"], names: ["object_id"], sheet: "objects.csv" },
      },
    ]);
    expect(headingFilesOf({ warnings: items })).toEqual(["objects.csv"]);
  });

  it("names a story file's misread headings", async () => {
    const read = readerOf({ [`${DIR}/weavers.csv`]: ok("step,object,Question\n1,loom,Q\n") });
    const items = await sheetWarningChecksAt(PASSING, ["weavers"], read);
    expect(items.map((i) => i.sheetWarning)).toEqual([
      { code: "header_spelling", headers: ["Question"], names: ["question"], sheet: "weavers.csv" },
    ]);
  });

  it("names no glossary heading the current release reads, though the publish rewrites it", async () => {
    // The current release folds the glossary's headings to lower case after renaming.
    const read = readerOf({ [`${DIR}/glossary.csv`]: ok("Term_ID,Title,definition\nwarp,Warp,Threads\n") });
    expect(await sheetWarningChecksAt(PASSING, [], read)).toEqual([]);
  });

  it("drops a file's misread headings where the build takes the sheet from a Google Sheets tab", async () => {
    vi.mocked(discoverSheetTabs).mockResolvedValue([{ name: "objects", gid: "0" }] as never);
    const read = readerOf({
      [`${DIR}/objects.csv`]: ok("Object_ID,title\nloom,Loom\n"),
      [`${DIR}/weavers.csv`]: ok("Step,object\n1,loom\n"),
    });
    const sheets = { enabled: true, publishedUrl: "https://docs.google.com/spreadsheets/d/e/X/pubhtml" };
    const items = await sheetWarningChecksAt(PASSING, ["weavers"], read, sheets);
    expect(items.map((i) => (i.sheetWarning as { sheet?: string } | undefined)?.sheet)).toEqual(["weavers.csv"]);
    expect(items.map((i) => i.entityId)).toEqual(["weavers.csv/0"]);
    expect(discoverSheetTabs).toHaveBeenCalledWith(sheets.publishedUrl);
  });

  it("keeps the headings when the tabs cannot be listed, and does not throw", async () => {
    vi.mocked(discoverSheetTabs).mockRejectedValue(new Error("offline"));
    const read = readerOf({ [`${DIR}/objects.csv`]: ok("Object_ID,title\nloom,Loom\n") });
    const sheets = { enabled: true, publishedUrl: "https://docs.google.com/spreadsheets/d/e/X/pubhtml" };
    const items = await sheetWarningChecksAt(PASSING, [], read, sheets);
    expect(items.map((i) => i.sheetWarning?.code)).toEqual(["header_spelling"]);
  });

  it("keeps another file's headings when one file's read throws", async () => {
    const read = vi.fn(async (path: string): Promise<FileAtRef> => {
      if (path === `${DIR}/weavers.csv`) throw new Error("network");
      return path === `${DIR}/objects.csv` ? ok("Object_ID,title\nloom,Loom\n") : { status: "absent" };
    });
    const items = await sheetWarningChecksAt(PASSING, ["weavers"], read);
    expect(items.map((i) => (i.sheetWarning as { sheet?: string } | undefined)?.sheet)).toEqual(["objects.csv"]);
  });

  it("names no file for the template's own headings", async () => {
    const read = readerOf({
      [`${DIR}/objects.csv`]: ok("object_id,title\nloom,Loom\n"),
      [`${DIR}/weavers.csv`]: ok("step,object,question\n1,loom,Q\n"),
    });
    const items = await sheetWarningChecksAt(PASSING, ["weavers"], read);
    expect(headingFilesOf({ warnings: items })).toEqual([]);
  });
});
