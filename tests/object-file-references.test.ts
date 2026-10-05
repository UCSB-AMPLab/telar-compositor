/**
 * The text a rename rewrites: Markdown images and carousel values that are
 * exactly a moved file's name, and tile addresses by prefix. Everything else
 * that names what moved is left and counted.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  applyTextEdits,
  fileReferenceEdits,
  noFileReferenceRules,
  rewriteAudioSource,
  rewriteFileReferences,
  rewriteThumbnail,
  type FileReferenceRules,
} from "~/lib/object-file-references";

const TILES = "https://me.github.io/site/iiif/objects/";

const RULES: FileReferenceRules = {
  moved: [{ from: "map.jpg", to: "atlas.jpg" }],
  carouselShadowed: [],
  tiles: { from: `${TILES}map/`, to: `${TILES}atlas/` },
  oldSiteId: "map",
};

describe("rewriteFileReferences", () => {
  it("rewrites a block image and an image inside a line", () => {
    const text = "![A map](map.jpg){lg}\nCaption\n\nInline ![m](map.jpg \"t\") here.\n";
    expect(rewriteFileReferences(text, RULES)).toBe(
      "![A map](atlas.jpg){lg}\nCaption\n\nInline ![m](atlas.jpg \"t\") here.\n",
    );
  });

  it("rewrites a tile address by prefix", () => {
    const text = `![m](${TILES}map/page-1/full/max/0/default.jpg)`;
    expect(rewriteFileReferences(text, RULES)).toBe(`![m](${TILES}atlas/page-1/full/max/0/default.jpg)`);
  });

  it("rewrites a carousel value and leaves one assets/images answers first", () => {
    const text = ":::carousel\nimage:  map.jpg \nalt: A\n---\nimage: other.jpg\n:::\n";
    expect(rewriteFileReferences(text, RULES)).toBe(":::carousel\nimage:  atlas.jpg \nalt: A\n---\nimage: other.jpg\n:::\n");
    const shadowed = { ...RULES, carouselShadowed: ["map.jpg"] };
    expect(rewriteFileReferences(text, shadowed)).toBe(text);
  });

  it("does not let assets/images hold back a Markdown image", () => {
    const shadowed = { ...RULES, carouselShadowed: ["map.jpg"] };
    expect(rewriteFileReferences("![m](map.jpg)", shadowed)).toBe("![m](atlas.jpg)");
  });

  it("leaves and counts case variants, folder forms, raw HTML images and links to the old page", () => {
    const text = [
      "![m](MAP.jpg)",
      "![m](/telar-content/objects/map.jpg)",
      "![m](map/001.jpg)",
      '<img src="map.jpg">',
      "[the map](/site/objects/map/)",
      "![m](unrelated.jpg)",
    ].join("\n");
    const result = fileReferenceEdits(text, RULES);
    expect(result.edits).toEqual([]);
    expect(result.left).toBe(5);
  });

  it("rewrites nothing under the rules of a rename inside a collision", () => {
    const text = `![m](map.jpg)\n![t](${TILES}map/info.json)`;
    expect(rewriteFileReferences(text, noFileReferenceRules("map"))).toBe(text);
  });
});

describe("forms the rename reads as the framework does", () => {
  it("leaves a link, an absolute path, a longer id's tile address and a bare name in prose", () => {
    const text = [
      "[map](map.jpg)", "![x](/map.jpg)", "![x](old-map.jpg)", "map.jpg",
      `![t](${TILES}map-2/info.json)`,
    ].join("\n");
    expect(fileReferenceEdits(text, RULES).edits).toEqual([]);
  });

  it("rewrites a tile address under the old prefix in an image and leaves one in prose", () => {
    const text = `![p](${TILES}map/page-1/full/max/0/default.jpg) and ${TILES}map/info.json`;
    expect(rewriteFileReferences(text, RULES)).toBe(
      `![p](${TILES}atlas/page-1/full/max/0/default.jpg) and ${TILES}map/info.json`,
    );
  });

  it("rewrites an image whose alt text holds brackets", () => {
    expect(rewriteFileReferences('See ![the map [detail]](map.jpg "Map") here.', RULES)).toBe(
      'See ![the map [detail]](atlas.jpg "Map") here.',
    );
  });

  it("leaves an image line outside a carousel, and a commented one", () => {
    const text = "image: map.jpg\n:::tabs\nimage: map.jpg\n:::\n:::carousel\n# image: map.jpg\n:::";
    expect(fileReferenceEdits(text, RULES).edits).toEqual([]);
  });

  it("reads the widget type in any case, as the framework lowers it", () => {
    expect(rewriteFileReferences(":::Carousel\nimage: map.jpg\n:::", RULES)).toBe(":::Carousel\nimage: atlas.jpg\n:::");
  });

  it("answers ascending edits that do not overlap across a carousel and an image", () => {
    const text = ":::carousel\nimage: map.jpg\n:::\n![m](map.jpg)";
    const { edits } = fileReferenceEdits(text, RULES);
    expect(edits.map((e) => e.offset)).toEqual([...edits.map((e) => e.offset)].sort((a, b) => a - b));
    expect(applyTextEdits(text, edits)).toBe(":::carousel\nimage: atlas.jpg\n:::\n![m](atlas.jpg)");
  });
});

describe("fileReferenceEdits", () => {
  it("answers edits at offsets that apply to the original text, a concurrent edit elsewhere kept", () => {
    const text = "Intro\n![m](map.jpg)\nOutro";
    const { edits } = fileReferenceEdits(text, RULES);
    expect(edits).toEqual([{ offset: 11, length: 7, insert: "atlas.jpg" }]);
    expect(applyTextEdits(text, edits)).toBe("Intro\n![m](atlas.jpg)\nOutro");
  });
});

describe("rewriteThumbnail", () => {
  it("rewrites a moved file's path from the site root, with or without a slash, and a tile address", () => {
    expect(rewriteThumbnail("telar-content/objects/map.jpg", RULES)).toBe("telar-content/objects/atlas.jpg");
    expect(rewriteThumbnail("/telar-content/objects/map.jpg", RULES)).toBe("/telar-content/objects/atlas.jpg");
    expect(rewriteThumbnail(`${TILES}map/full/200,/0/default.jpg`, RULES)).toBe(`${TILES}atlas/full/200,/0/default.jpg`);
    expect(rewriteThumbnail("assets/images/map.jpg", RULES)).toBeNull();
    expect(rewriteThumbnail("map.jpg", RULES)).toBeNull();
    expect(rewriteThumbnail("telar-content/objects/Map.jpg", RULES)).toBeNull();
    expect(rewriteThumbnail("", RULES)).toBeNull();
  });
});

describe("rewriteAudioSource", () => {
  it("follows a source that is exactly a moved file's name", () => {
    const rules = { ...RULES, moved: [{ from: "voz.mp3", to: "voces.mp3" }] };
    expect(rewriteAudioSource("voz.mp3", rules)).toBe("voces.mp3");
    expect(rewriteAudioSource("https://x/voz.mp3", rules)).toBeNull();
  });
});
