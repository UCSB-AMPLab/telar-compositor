/**
 * The file plan of a rename: moves and copies name blobs by the SHA and mode
 * they already have, a move removes the path it leaves, a shared stem is
 * copied, and a target already taken, in any letter case, refuses with
 * `rename_file_exists`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import type { TreeEntry } from "~/lib/github.server";
import {
  carouselShadowedNames,
  isStoryCsvPath,
  planObjectFileMoves,
  renameTextFilePaths,
} from "~/lib/object-rename-files";

const VERSION = "1.8.0";

function renameTreeBlob(path: string, sha = `sha-${path}`, mode = "100644"): TreeEntry {
  return { path, mode, type: "blob", sha };
}

const objectsFolderBlob = (name: string, mode?: string) => renameTreeBlob(`telar-content/objects/${name}`, `sha-${name}`, mode);

describe("planObjectFileMoves", () => {
  it("moves a flat image with its blob SHA and mode, and removes the path it leaves", () => {
    const plan = planObjectFileMoves({
      tree: [objectsFolderBlob("map.jpg", "100755"), objectsFolderBlob("other.jpg")],
      oldId: "map",
      newId: "atlas",
      sheetIds: ["map", "other"],
      version: VERSION,
    });
    expect(plan).toEqual({
      ok: true,
      placed: [{ path: "telar-content/objects/atlas.jpg", sha: "sha-map.jpg", mode: "100755" }],
      removed: [{ path: "telar-content/objects/map.jpg", mode: "100755" }],
      moved: [{ from: "map.jpg", to: "atlas.jpg" }],
    });
  });

  it("moves the folder layout", () => {
    const plan = planObjectFileMoves({
      tree: [objectsFolderBlob("map/001.jpg"), objectsFolderBlob("map/sub/002.jpg"), objectsFolderBlob("mapa/001.jpg")],
      oldId: "map",
      newId: "atlas",
      sheetIds: ["map"],
      version: VERSION,
    });
    expect(plan.ok && plan.placed.map((p) => [p.path, p.sha])).toEqual([
      ["telar-content/objects/atlas/001.jpg", "sha-map/001.jpg"],
      ["telar-content/objects/atlas/sub/002.jpg", "sha-map/sub/002.jpg"],
    ]);
    expect(plan.ok && plan.removed.map((r) => r.path)).toEqual([
      "telar-content/objects/map/001.jpg",
      "telar-content/objects/map/sub/002.jpg",
    ]);
  });

  it("moves both stems of an id ending in an extension, and refuses when the second target is taken", () => {
    const both = planObjectFileMoves({
      tree: [objectsFolderBlob("map.jpg"), objectsFolderBlob("map.jpg.png")],
      oldId: "map.jpg",
      newId: "atlas",
      sheetIds: ["map.jpg"],
      version: VERSION,
    });
    expect(both.ok && both.moved).toEqual([
      { from: "map.jpg", to: "atlas.jpg" },
      { from: "map.jpg.png", to: "atlas.png" },
    ]);

    const clash = planObjectFileMoves({
      tree: [objectsFolderBlob("map.jpg"), objectsFolderBlob("map.jpg.jpg")],
      oldId: "map.jpg",
      newId: "atlas",
      sheetIds: ["map.jpg"],
      version: VERSION,
    });
    expect(clash).toEqual({ ok: false, error: "rename_file_exists", file: "atlas.jpg" });
  });

  it("refuses a target another file already holds, in any letter case", () => {
    for (const existing of ["atlas.png", "ATLAS.PNG", "Atlas.png"]) {
      const plan = planObjectFileMoves({
        tree: [objectsFolderBlob("map.png"), objectsFolderBlob(existing)],
        oldId: "map",
        newId: "atlas",
        sheetIds: ["map"],
        version: VERSION,
      });
      expect(plan).toEqual({ ok: false, error: "rename_file_exists", file: existing });
    }
  });

  it("copies a stem another row also reads as, keeping the file it was copied from", () => {
    // `map` beside `map.jpg`: the file map.jpg is the image of both rows.
    const plan = planObjectFileMoves({
      tree: [objectsFolderBlob("map.jpg")],
      oldId: "map",
      newId: "atlas",
      sheetIds: ["map", "map.jpg"],
      version: VERSION,
    });
    expect(plan).toEqual({
      ok: true,
      placed: [{ path: "telar-content/objects/atlas.jpg", sha: "sha-map.jpg", mode: "100644" }],
      removed: [],
      moved: [],
    });
  });

  it("moves a repeated id's files, every occurrence of the id being the object itself", () => {
    const plan = planObjectFileMoves({
      tree: [objectsFolderBlob("map.jpg")],
      oldId: "map",
      newId: "atlas",
      sheetIds: ["map", "other", "map"],
      version: VERSION,
    });
    expect(plan.ok && plan.removed.map((r) => r.path)).toEqual(["telar-content/objects/map.jpg"]);
  });
});

describe("carouselShadowedNames", () => {
  it("names the moved files assets/images answers first, letter-case variants included", () => {
    const tree = [renameTreeBlob("assets/images/map.jpg"), renameTreeBlob("assets/images/plan.JPG"), renameTreeBlob("assets/images/deep/x.jpg")];
    expect(carouselShadowedNames(tree, ["map.jpg", "plan.jpg", "x.jpg", "atlas.jpg", "MAP.jpg"])).toEqual([
      "map.jpg",
      "plan.jpg",
      "MAP.jpg",
    ]);
  });
});

describe("isStoryCsvPath", () => {
  it("takes every spreadsheet but the system files, and nothing outside the folder", () => {
    const S = "telar-content/spreadsheets/";
    expect(isStoryCsvPath(`${S}historia.csv`)).toBe(true);
    expect(isStoryCsvPath(`${S}glossary.csv`)).toBe(true);
    for (const name of ["project.csv", "proyecto.csv", "objects.csv", "objetos.csv"]) {
      expect(isStoryCsvPath(`${S}${name}`)).toBe(false);
    }
    expect(isStoryCsvPath("_data/historia.csv")).toBe(false);
    expect(isStoryCsvPath("historia.csv")).toBe(false);
    expect(isStoryCsvPath(`${S}sub/historia.csv`)).toBe(false);
  });
});

describe("renameTextFilePaths", () => {
  it("lists the Markdown files of the layer, page and glossary folders", () => {
    const tree = [
      renameTreeBlob("telar-content/texts/stories/one/layer.md"),
      renameTreeBlob("telar-content/texts/pages/about.md"),
      renameTreeBlob("telar-content/texts/glossary/term.md"),
      renameTreeBlob("telar-content/texts/stories/notes.txt"),
      renameTreeBlob("README.md"),
    ];
    expect(renameTextFilePaths(tree)).toEqual([
      "telar-content/texts/stories/one/layer.md",
      "telar-content/texts/pages/about.md",
      "telar-content/texts/glossary/term.md",
    ]);
  });
});
