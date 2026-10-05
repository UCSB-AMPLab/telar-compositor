/**
 * Which files in telar-content/objects the site tiles, by its framework
 * version.
 *
 * The tiler looks for `{site id}{ext}` with each extension of its search list
 * spelled as listed and in uppercase, and nothing else (`generate_iiif.py`,
 * `find_image_for_object`). The list is the tiler's at the site's release:
 * v1.7.0's nine (`.jpg .jpeg .png .heic .heif .webp .tif .tiff .pdf`), 1.8.0's
 * `IMAGE_EXTENSIONS_ORDERED` (those nine and `.gif .bmp .svg`), and before
 * v0.9.0 without `.pdf`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { tileableExtensions, tileableStem, tileableStems } from "~/lib/object-id";

const V17 = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff", ".pdf"];
const V18 = [...V17, ".gif", ".bmp", ".svg"];

describe("tileableExtensions", () => {
  it("is the tiler's search list at the release, in its order", () => {
    expect(tileableExtensions("1.7.0")).toEqual(V17);
    expect(tileableExtensions("v1.7.0")).toEqual(V17);
    expect(tileableExtensions("1.8.0")).toEqual(V18);
    expect(tileableExtensions("1.8.0-rc.1")).toEqual(V18);
  });

  it("holds .pdf from v0.9.0, the release whose tiler first searches it", () => {
    expect(tileableExtensions("0.8.0")).toEqual(V17.filter((e) => e !== ".pdf"));
    expect(tileableExtensions("0.9.0-beta")).toEqual(V17);
  });

  it("reads a site with no readable version as 1.7.0", () => {
    expect(tileableExtensions(null)).toEqual(V17);
    expect(tileableExtensions("")).toEqual(V17);
  });
});

describe("tileableStem", () => {
  it("takes an extension of the release's list spelled all lowercase or all uppercase", () => {
    expect(tileableStem("map.jpg", "1.7.0")).toBe("map");
    expect(tileableStem("map.JPG", "1.7.0")).toBe("map");
    expect(tileableStem("MAP.JPG", "1.7.0")).toBe("MAP");
  });

  it("takes no other spelling, as the tiler looks for none", () => {
    expect(tileableStem("map.Jpg", "1.7.0")).toBeNull();
    expect(tileableStem("map.jPG", "1.8.0")).toBeNull();
  });

  it("takes .heic and .heif from v1.7.0's list", () => {
    expect(tileableStem("map.heic", "1.7.0")).toBe("map");
    expect(tileableStem("map.HEIF", "1.7.0")).toBe("map");
  });

  it.each(["gif", "bmp", "svg"])("takes .%s on 1.8.0 only", (ext) => {
    expect(tileableStem(`map.${ext}`, "1.8.0")).toBe("map");
    expect(tileableStem(`map.${ext.toUpperCase()}`, "1.8.0")).toBe("map");
    expect(tileableStem(`map.${ext}`, "1.7.0")).toBeNull();
    expect(tileableStem(`map.${ext}`, null)).toBeNull();
  });

  it("takes no audio or unknown extension, nor a name with none", () => {
    expect(tileableStem("map.mp3", "1.7.0")).toBeNull();
    expect(tileableStem("map.mp3", "1.8.0")).toBeNull();
    expect(tileableStem("map", "1.8.0")).toBeNull();
  });

  it("removes only the last extension", () => {
    expect(tileableStem("map.jpg.png", "1.7.0")).toBe("map.jpg");
  });
});

describe("tileableStems", () => {
  const tree = [
    { path: "telar-content/objects/map.jpg", type: "blob" },
    { path: "telar-content/objects/PLAN.PNG", type: "blob" },
    { path: "telar-content/objects/mixed.Jpg", type: "blob" },
    { path: "telar-content/objects/chart.gif", type: "blob" },
    { path: "telar-content/objects/song.mp3", type: "blob" },
    { path: "telar-content/objects/sub/deep.jpg", type: "blob" },
    { path: "telar-content/objects/dir.jpg", type: "tree" },
    { path: "telar-content/other/else.jpg", type: "blob" },
    { path: "objects/top.jpg", type: "blob" },
  ];

  it("is the stems of the tileable blobs directly in telar-content/objects", () => {
    expect([...tileableStems(tree, "1.7.0")].sort()).toEqual(["PLAN", "map"]);
    expect([...tileableStems(tree, "1.8.0")].sort()).toEqual(["PLAN", "chart", "map"]);
  });
});
