/**
 * The site's form of an object id, and the step and file matching built on it.
 *
 * Each expectation is the framework's answer for the same input:
 * `_clean_object_ids` (`scripts/telar/processors/objects/frame.py`) for an id,
 * `_validate_object_references` (`scripts/telar/processors/stories.py`) for a
 * step, `IMAGE_EXTENSIONS` (`scripts/telar/csv_utils.py`) for the set.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  iiifUrlsFor,
  isExternalSource,
  mediaTypesByStepValue,
  resolveStepObject,
  stepReference,
  sharedSiteIds,
  siteObjectId,
  stepUseCounts,
  strippedExtensions,
  objectFileStems,
  sheetReaderLosesId,
} from "~/lib/object-id";

const V17 = "1.7.0";
const V18 = "1.8.0";

const EVERY_RELEASED = [".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".pdf", ".gif", ".bmp", ".svg"];

describe("siteObjectId", () => {
  for (const ext of EVERY_RELEASED) {
    it(`strips ${ext} in lower, upper and mixed case, keeping the stem's case`, () => {
      const mixed = ext.slice(0, 2).toUpperCase() + ext.slice(2);
      expect(siteObjectId(`map${ext}`, V17)).toBe("map");
      expect(siteObjectId(`Map${ext.toUpperCase()}`, V17)).toBe("Map");
      expect(siteObjectId(`MAP${mixed}`, V17)).toBe("MAP");
    });
  }

  it("strips one extension only", () => {
    expect(siteObjectId("map.jpg.png", V17)).toBe("map.jpg");
  });

  it("keeps an extension outside the image set", () => {
    expect(siteObjectId("song.mp3", V17)).toBe("song.mp3");
    expect(siteObjectId("notes.md", V17)).toBe("notes.md");
    expect(siteObjectId("mapa.detail", V17)).toBe("mapa.detail");
  });

  it("leaves an id with no extension unchanged", () => {
    expect(siteObjectId("colonial-map", V17)).toBe("colonial-map");
  });

  it("removes surrounding whitespace before looking for the extension", () => {
    expect(siteObjectId("map.jpg ", V17)).toBe("map");
    expect(siteObjectId(" map.JPG\t", V17)).toBe("map");
  });

  it("keeps an id with no extension exactly as written, whitespace included", () => {
    expect(siteObjectId(" map ", V17)).toBe(" map ");
    expect(siteObjectId("map.mp3 ", V17)).toBe("map.mp3 ");
  });

  it("strips .heic and .heif on a 1.8.0 site and keeps them on a 1.7.0 one", () => {
    expect(siteObjectId("map.heic", V18)).toBe("map");
    expect(siteObjectId("map.HEIF", V18)).toBe("map");
    expect(siteObjectId("map.heic", V17)).toBe("map.heic");
    expect(siteObjectId("map.heif", V17)).toBe("map.heif");
  });

  it("reads a pre-release or v-prefixed version as the release it names", () => {
    expect(siteObjectId("map.heic", "1.8.0-rc.1")).toBe("map");
    expect(siteObjectId("map.heic", "v1.8.0")).toBe("map");
    expect(siteObjectId("map.pdf", "0.9.0-beta")).toBe("map");
  });

  it("keeps .pdf on a site older than 0.9.0", () => {
    expect(siteObjectId("map.pdf", "0.8.1-beta")).toBe("map.pdf");
    expect(siteObjectId("map.jpg", "0.8.1-beta")).toBe("map");
  });

  it("takes a site with no readable version to strip .pdf and not .heic", () => {
    expect(strippedExtensions(null)).toEqual(strippedExtensions(V17));
    expect(siteObjectId("map.pdf", null)).toBe("map");
    expect(siteObjectId("map.heic", undefined)).toBe("map.heic");
  });
});

describe("isExternalSource", () => {
  it("reads the scheme in any case, as the framework's urlparse does", () => {
    expect(isExternalSource("HTTP://example.org/manifest.json")).toBe(true);
    expect(isExternalSource("Https://example.org/manifest.json")).toBe(true);
  });

  it("reads the source trimmed, as get_source_url does", () => {
    expect(isExternalSource(" https://example.org/manifest.json")).toBe(true);
    expect(isExternalSource("\thttp://example.org/manifest.json\n")).toBe(true);
  });

  it("takes no other scheme, and no source, as external", () => {
    expect(isExternalSource("httpx://example.org")).toBe(false);
    expect(isExternalSource("map.jpg")).toBe(false);
    expect(isExternalSource("  ")).toBe(false);
    expect(isExternalSource(null)).toBe(false);
  });
});

describe("iiifUrlsFor", () => {
  const BASE = "https://example.org/site";

  it("builds a self-hosted object's addresses under its site id", () => {
    expect(iiifUrlsFor({ object_id: "map.jpg", source_url: null }, BASE, V17)).toEqual({
      manifestUrl: `${BASE}/iiif/objects/map/manifest.json`,
      infoJsonUrl: `${BASE}/iiif/objects/map/info.json`,
      isSelfHosted: true,
    });
  });

  it("reads an external manifest written with an uppercase scheme or a leading space, trimmed", () => {
    expect(iiifUrlsFor({ object_id: "map.jpg", source_url: " HTTPS://iiif.example.org/m.json" }, BASE, V17)).toEqual({
      manifestUrl: "HTTPS://iiif.example.org/m.json",
      infoJsonUrl: null,
      isSelfHosted: false,
    });
  });

  it("keeps an external object's own manifest, whatever its id", () => {
    const manifest = "https://iiif.example.org/map.jpg/manifest.json";
    expect(iiifUrlsFor({ object_id: "map.jpg", source_url: manifest }, BASE, V17)).toEqual({
      manifestUrl: manifest,
      infoJsonUrl: null,
      isSelfHosted: false,
    });
  });

  it("builds nothing for no object, and no address without a site base", () => {
    expect(iiifUrlsFor(null, BASE, V17)).toEqual({ manifestUrl: null, infoJsonUrl: null, isSelfHosted: false });
    expect(iiifUrlsFor({ object_id: "map", source_url: null }, null, V17)).toEqual({
      manifestUrl: null,
      infoJsonUrl: null,
      isSelfHosted: true,
    });
  });
});

describe("resolveStepObject", () => {
  const map = { object_id: "map" };
  const mapJpg = { object_id: "map.jpg" };

  it("finds object map for a step naming map.jpg", () => {
    expect(resolveStepObject([map], "map.jpg", V17)).toBe(map);
  });

  it("finds object map.jpg for a step naming map", () => {
    expect(resolveStepObject([mapJpg], "map", V17)).toBe(mapJpg);
  });

  it("finds object map for a step naming MAP", () => {
    expect(resolveStepObject([map], "MAP", V17)).toBe(map);
  });

  it("prefers an exact match to a case-insensitive one", () => {
    const upper = { object_id: "Map" };
    expect(resolveStepObject([map, upper], "map", V17)).toBe(map);
    expect(resolveStepObject([upper, map], "Map", V17)).toBe(upper);
  });

  it("takes the later row where two share a site id", () => {
    expect(resolveStepObject([map, mapJpg], "map", V17)).toBe(mapJpg);
    expect(resolveStepObject([mapJpg, map], "map.jpg", V17)).toBe(map);
  });

  it("takes, among site ids differing only in case, the one that first appeared latest", () => {
    // The framework's objects dict keys `Map` (rows 1 and 3) before `map`
    // (row 2); its lowercase map keeps the later key, `map`, whose row is 2.
    const rows = [{ object_id: "Map" }, { object_id: "map" }, { object_id: "Map.jpg" }];
    expect(resolveStepObject(rows, "MAP", V17)).toBe(rows[1]);
  });

  it("trims the step's value as the framework does", () => {
    expect(resolveStepObject([map], " map.jpg ", V17)).toBe(map);
  });

  it("trims a step's value with no extension too, as the framework does", () => {
    expect(resolveStepObject([map], " map ", V17)).toBe(map);
  });

  it("does not find an object whose id keeps its whitespace, since the step's value is trimmed", () => {
    expect(resolveStepObject([{ object_id: " map " }], " map ", V17)).toBeNull();
  });

  it("finds nothing for an empty value or one naming no object", () => {
    expect(resolveStepObject([map], "", V17)).toBeNull();
    expect(resolveStepObject([map], null, V17)).toBeNull();
    expect(resolveStepObject([map], ".jpg", V17)).toBeNull();
    expect(resolveStepObject([map], "mapa", V17)).toBeNull();
  });

  it("leaves the step's value as the author wrote it", () => {
    const step = { object_id: "MAP.jpg" };
    resolveStepObject([map], step.object_id, V17);
    expect(step.object_id).toBe("MAP.jpg");
  });
});

describe("stepUseCounts", () => {
  it("counts a step naming map as a use of map.jpg", () => {
    const counts = stepUseCounts([{ object_id: "map.jpg" }], ["map", "map.jpg", "MAP", "other", null], V17);
    expect(Object.fromEntries(counts)).toEqual({ "map.jpg": 3 });
  });

  it("counts every use of a shared site id against the later row", () => {
    const counts = stepUseCounts([{ object_id: "map" }, { object_id: "map.jpg" }], ["map", "map.jpg"], V17);
    expect(Object.fromEntries(counts)).toEqual({ "map.jpg": 2 });
  });
});

// Before 1.8.0 the story reader takes pandas' missing-value tokens as empty
// cells, so a step whose cell is one is a title card: it shows no object and
// is no use of one.
describe("a step cell that is a missing-value token", () => {
  const na = { object_id: "NA", source_url: "https://example.org/a.mp3" };

  it("names no object before 1.8.0 and on a site with no version", () => {
    expect(stepReference("NA", V17)).toBe("");
    expect(stepReference("None", null)).toBe("");
    expect(resolveStepObject([na], "NA", V17)).toBeNull();
    expect(Object.fromEntries(stepUseCounts([na], ["NA", "null"], V17))).toEqual({});
    expect(Object.keys(mediaTypesByStepValue([{ object_id: "NA" }], [na], V17))).toEqual([]);
  });

  it("is looked up as written from 1.8.0", () => {
    expect(stepReference("NA", V18)).toBe("NA");
    expect(resolveStepObject([na], "NA", V18)).toBe(na);
    expect(Object.fromEntries(stepUseCounts([na], ["NA"], V18))).toEqual({ NA: 1 });
    expect(mediaTypesByStepValue([{ object_id: "NA" }], [na], V18).NA).toBe("audio");
  });

  it("matches the token exactly, as pandas does", () => {
    expect(stepReference(" NA", V17)).toBe("NA");
    expect(stepReference("Na", V17)).toBe("Na");
  });
});

describe("sharedSiteIds", () => {
  it("names, on each of two rows the site reads as one, the other and the row it shows", () => {
    const shared = sharedSiteIds([{ object_id: "map" }, { object_id: "colonial" }, { object_id: "map.jpg" }], V17);
    expect(Object.fromEntries(shared)).toEqual({
      map: { others: ["map.jpg"], shown: "map.jpg" },
      "map.jpg": { others: ["map"], shown: "map.jpg" },
    });
  });

  it("names nothing where every site id is its own", () => {
    expect(sharedSiteIds([{ object_id: "map.jpg" }, { object_id: "Map2" }], V17).size).toBe(0);
  });

  it("follows the site's version", () => {
    const rows = [{ object_id: "map" }, { object_id: "map.heic" }];
    expect(sharedSiteIds(rows, V17).size).toBe(0);
    expect(sharedSiteIds(rows, V18).size).toBe(2);
  });
});

describe("objectFileStems", () => {
  const stems = (id: string, all: string[]) => [...objectFileStems(id, all, V17)].sort();

  it("gives map.jpg its own stem and the stem map when no other row reads as map", () => {
    expect(stems("map.jpg", ["map.jpg", "colonial"])).toEqual(["map", "map.jpg"]);
  });

  it("leaves out the stem map when another row reads as map", () => {
    expect(stems("map.jpg", ["map", "map.jpg"])).toEqual(["map.jpg"]);
    expect(stems("map", ["map", "map.jpg"])).toEqual([]);
  });

  it("gives a row whose id is its site id that stem alone", () => {
    expect(stems("map", ["map"])).toEqual(["map"]);
  });

  // Every row carrying the id is removed with the object, so none of them is
  // another row whose stem the object's files would share.
  it("counts no row that carries the object's own id as another row", () => {
    expect(stems("map", ["map", "map"])).toEqual(["map"]);
    expect(stems("map", ["map", "colonial", "map", "map"])).toEqual(["map"]);
    expect(stems("map.jpg", ["map.jpg", "map.jpg"])).toEqual(["map", "map.jpg"]);
  });

  it("still leaves out a stem another object reads as when the id is repeated", () => {
    expect(stems("map", ["map", "map.jpg", "map"])).toEqual([]);
    expect(stems("map.jpg", ["map", "map.jpg", "map.jpg"])).toEqual(["map.jpg"]);
  });
});

describe("sheetReaderLosesId", () => {
  const INFERRED = [
    "7", "007", "-2", "+3", "1.5", ".5", "5.", "1e3", "1E3", "1e+3", "1e-3", "0e0",
    "inf", "Inf", "-inf", "+Infinity", "infinity", "-Infinity", "nan", "-NaN", "+nan",
    "1.#INF", "1.#IND", "-1.#QNAN", "true", "True", "TRUE", "false", "False", "FALSE",
    " 1e3 ", "\t1.5",
  ];
  it.each(INFERRED)("refuses %j before 1.8.0 and admits it from 1.8.0", (id) => {
    expect(sheetReaderLosesId(id, V17)).toBe(true);
    expect(sheetReaderLosesId(id, V18)).toBe(false);
  });

  it.each(["1e3-map", "true-north", "2024-mapa", "e3", "1e", "infinit", "yes", "t", "plano"])(
    "reads %j as text before 1.8.0",
    (id) => {
      expect(sheetReaderLosesId(id, V17)).toBe(false);
    },
  );
});
