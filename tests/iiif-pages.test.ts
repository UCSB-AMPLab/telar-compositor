/**
 * Characterisation of the IIIF page library: what a manifest yields as tile
 * sources, thumbnails and labels across Presentation v2 and v3, how a source is
 * named, and which thumbnail size an Image API server's own declarations allow.
 *
 * These extractors decide how many pages an object has, which is what the page
 * chooser offers and what the viewer clamps against, so each shape a manifest
 * can take is pinned here rather than discovered in a browser.
 *
 * The service-derived-thumbnail fixture below reproduces the first canvas
 * (page 0) of https://juancobo.com/138la/iiif/poma/manifest.json, content this
 * project owns: a vips-generated level-0 image service that declares `sizes`
 * but no `thumbnail`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  extractAllPages,
  extractV2Pages,
  extractV3Pages,
  formatPageNumber,
  sourceKeyFor,
} from "~/lib/iiif-pages";
import { thumbnailUrlFromInfo } from "~/lib/use-iiif-thumbnail";

const IMAGE_URL = "https://example.org/iiif/3/page-1/full/max/0/default.jpg";

function v3Canvas(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    items: [{ items: [{ body }] }],
  };
}

function v2Canvas(resource: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...extra, images: [{ resource }] };
}

describe("extractV3Pages — tile sources", () => {
  it("takes the Image API service id and appends info.json", () => {
    const pages = extractV3Pages({
      items: [v3Canvas({ service: [{ id: "https://example.org/iiif/3/a" }] })],
    });
    expect(pages).toEqual([{ tileSource: "https://example.org/iiif/3/a/info.json" }]);
  });

  it("derives info.json from an Image API body id", () => {
    const pages = extractV3Pages({
      items: [v3Canvas({ id: IMAGE_URL, type: "Image" })],
    });
    expect(pages).toEqual([
      { tileSource: "https://example.org/iiif/3/page-1/info.json" },
    ]);
  });

  it("falls back to a bare image URL that names no Image API base", () => {
    const pages = extractV3Pages({
      items: [v3Canvas({ id: "https://example.org/plain.jpg", type: "Image" })],
    });
    expect(pages).toEqual([{ tileSource: "https://example.org/plain.jpg" }]);
  });
});

describe("extractV2Pages — tile sources", () => {
  it("takes the service @id and appends info.json", () => {
    const pages = extractV2Pages({
      sequences: [
        { canvases: [v2Canvas({ service: { "@id": "https://example.org/iiif/2/a" } })] },
      ],
    });
    expect(pages).toEqual([{ tileSource: "https://example.org/iiif/2/a/info.json" }]);
  });

  it("falls back to the resource @id", () => {
    const pages = extractV2Pages({
      sequences: [{ canvases: [v2Canvas({ "@id": "https://example.org/plain.jpg" })] }],
    });
    expect(pages).toEqual([{ tileSource: "https://example.org/plain.jpg" }]);
  });
});

describe("extractAllPages — thumbnails", () => {
  const body = { service: [{ id: "https://example.org/iiif/3/a" }] };

  it("reads a v3 canvas thumbnail object", () => {
    const [page] = extractAllPages({
      items: [v3Canvas(body, { thumbnail: { id: "https://example.org/t.jpg" } })],
    });
    expect(page.thumbnail).toBe("https://example.org/t.jpg");
  });

  it("reads a v3 canvas thumbnail array", () => {
    const [page] = extractAllPages({
      items: [v3Canvas(body, { thumbnail: [{ id: "https://example.org/t.jpg" }] })],
    });
    expect(page.thumbnail).toBe("https://example.org/t.jpg");
  });

  it("falls back to a v3 body thumbnail array", () => {
    const [page] = extractAllPages({
      items: [
        v3Canvas({ ...body, thumbnail: [{ id: "https://example.org/b.jpg" }] }),
      ],
    });
    expect(page.thumbnail).toBe("https://example.org/b.jpg");
  });

  it("prefers the canvas thumbnail over the body's", () => {
    const [page] = extractAllPages({
      items: [
        v3Canvas(
          { ...body, thumbnail: { id: "https://example.org/b.jpg" } },
          { thumbnail: { id: "https://example.org/c.jpg" } }
        ),
      ],
    });
    expect(page.thumbnail).toBe("https://example.org/c.jpg");
  });

  it("attaches no thumbnail when neither carries one", () => {
    const [page] = extractAllPages({ items: [v3Canvas(body)] });
    expect(page.thumbnail).toBeUndefined();
  });

  it.each([
    ["object", { "@id": "https://example.org/t.jpg" }],
    ["string", "https://example.org/t.jpg"],
    ["array", [{ "@id": "https://example.org/t.jpg" }]],
  ])("reads a v2 canvas thumbnail as %s", (_shape, thumbnail) => {
    const [page] = extractAllPages({
      sequences: [
        {
          canvases: [
            v2Canvas({ service: { "@id": "https://example.org/iiif/2/a" } }, { thumbnail }),
          ],
        },
      ],
    });
    expect(page.thumbnail).toBe("https://example.org/t.jpg");
  });
});

describe("extractAllPages — thumbnails derived from the body's image service", () => {
  // The body id, its dimensions and the service id are those of page 0 of
  // https://juancobo.com/138la/iiif/poma/manifest.json (no canvas or body
  // thumbnail, a level-0 service whose one real derivative is 208x279, which
  // is the body id's own). The `sizes` array is varied per case: these are
  // shape tests of the fallback order, so the shared fixture declares a
  // larger size the live service does not, which keeps a service-derived URL
  // and the body id's URL distinct and lets a test tell the two fallbacks
  // apart. The one case that reproduces the live declaration says so.
  const pomaBody = {
    id: "https://s3.us-west-001.backblazeb2.com/juancobo-138la-iiif/poma/poma0000/full/208,279/0/default.jpg",
    type: "Image",
    format: "image/jpeg",
    width: 208,
    height: 279,
    service: [
      {
        id: "https://s3.us-west-001.backblazeb2.com/juancobo-138la-iiif/poma/poma0000",
        type: "ImageService3",
        profile: "level0",
        width: 830,
        height: 1113,
        sizes: [
          { width: 415, height: 557 },
          { width: 830, height: 1113 },
        ],
      },
    ],
  };

  it("derives a thumbnail from the service's declared sizes", () => {
    const [page] = extractV3Pages({ items: [v3Canvas(pomaBody)] });
    expect(page.thumbnail).toBe(
      "https://s3.us-west-001.backblazeb2.com/juancobo-138la-iiif/poma/poma0000/full/415,557/0/default.jpg"
    );
  });

  it("reproduces the live page 0: one declared size, the body's own derivative", () => {
    const body = {
      ...pomaBody,
      service: [{ ...pomaBody.service[0], sizes: [{ width: 208, height: 279 }] }],
    };
    const [page] = extractV3Pages({ items: [v3Canvas(body)] });
    expect(page.thumbnail).toBe(pomaBody.id);
  });

  it("picks a size exactly at the minimum width over a larger one", () => {
    const body = {
      ...pomaBody,
      service: [
        {
          ...pomaBody.service[0],
          sizes: [
            { width: 149, height: 200 },
            { width: 150, height: 201 },
            { width: 415, height: 557 },
          ],
        },
      ],
    };
    const [page] = extractV3Pages({ items: [v3Canvas(body)] });
    expect(page.thumbnail).toBe(
      "https://s3.us-west-001.backblazeb2.com/juancobo-138la-iiif/poma/poma0000/full/150,201/0/default.jpg"
    );
  });

  it("accepts a body whose long side is exactly 1,000 px and refuses 1,001", () => {
    const at = { id: "https://example.org/a/full/700,1000/0/default.jpg", type: "Image", width: 700, height: 1000 };
    const over = { id: "https://example.org/b/full/700,1001/0/default.jpg", type: "Image", width: 700, height: 1001 };
    const [a, b] = extractV3Pages({ items: [v3Canvas(at), v3Canvas(over)] });
    expect(a.thumbnail).toBe(at.id);
    expect(b.thumbnail).toBeUndefined();
  });

  it("falls back to the body id when the service declares no sizes", () => {
    const { sizes: _sizes, ...serviceWithoutSizes } = pomaBody.service[0];
    const body = { ...pomaBody, service: [serviceWithoutSizes] };
    const [page] = extractV3Pages({ items: [v3Canvas(body)] });
    expect(page.thumbnail).toBe(pomaBody.id);
  });

  it("attaches no thumbnail for a large body with no declared sizes", () => {
    const body = {
      id: "https://example.org/poma/poma0000/full/max/0/default.jpg",
      type: "Image",
      width: 830,
      height: 1113,
    };
    const [page] = extractV3Pages({ items: [v3Canvas(body)] });
    expect(page.thumbnail).toBeUndefined();
  });

  it("derives a v2 thumbnail from a resource's service sizes", () => {
    const resource = {
      "@id": pomaBody.id,
      service: {
        "@id": "https://s3.us-west-001.backblazeb2.com/juancobo-138la-iiif/poma/poma0000",
        "@context": "http://iiif.io/api/image/2/context.json",
        profile: "http://iiif.io/api/image/2/level0.json",
        sizes: pomaBody.service[0].sizes,
      },
    };
    const [page] = extractV2Pages({
      sequences: [{ canvases: [v2Canvas(resource)] }],
    });
    expect(page.thumbnail).toBe(
      "https://s3.us-west-001.backblazeb2.com/juancobo-138la-iiif/poma/poma0000/full/415,557/0/default.jpg"
    );
  });

  it("prefers a canvas-declared thumbnail over the service-derived one", () => {
    const [page] = extractV3Pages({
      items: [v3Canvas(pomaBody, { thumbnail: { id: "https://example.org/declared.jpg" } })],
    });
    expect(page.thumbnail).toBe("https://example.org/declared.jpg");
  });

  it("prefers a body-declared thumbnail over the service-derived one", () => {
    // Unlike the canvas-declared case above, this puts `thumbnail` and
    // `service` on the same object (the body), so it fails if the priority
    // between the declared value and the service-derived fallback is ever
    // reversed — the earlier canvas-declared case can't catch that, since a
    // canvas thumbnail is read before the body is inspected at all.
    const body = { ...pomaBody, thumbnail: { id: "https://example.org/body-declared.jpg" } };
    const [page] = extractV3Pages({ items: [v3Canvas(body)] });
    expect(page.thumbnail).toBe("https://example.org/body-declared.jpg");
  });

  it("uses the first service entry that carries an id, not the last", () => {
    // Three entries: the first has no id (skipped), the second is the one
    // that should be used, and the third also carries an id with a
    // different size — present so that a bug which picks the *last*
    // id-bearing entry instead of the *first* yields a different, wrong URL
    // rather than accidentally matching.
    const body = {
      ...pomaBody,
      service: [
        { type: "ImageService3", profile: "level0", sizes: [{ width: 999, height: 999 }] },
        {
          id: "https://example.org/iiif/3/first-with-id",
          type: "ImageService3",
          profile: "level0",
          sizes: [{ width: 415, height: 557 }],
        },
        {
          id: "https://example.org/iiif/3/decoy-last",
          type: "ImageService3",
          profile: "level0",
          sizes: [{ width: 999, height: 999 }],
        },
      ],
    };
    const [page] = extractV3Pages({ items: [v3Canvas(body)] });
    expect(page.thumbnail).toBe(
      "https://example.org/iiif/3/first-with-id/full/415,557/0/default.jpg"
    );
  });

  it("drops an invalid sizes entry rather than throwing, and leaves later canvases intact", () => {
    // A malformed `sizes` entry (e.g. `null`, as a hand-edited or
    // partially-generated manifest might carry) must not reach
    // `pickThumbnailSize`, whose `.sort` dereferences `.width` on every
    // entry: an unvalidated `null` throws there, and the extractor's outer
    // catch then drops this canvas *and every canvas after it*. Two usable
    // canvases must still yield two pages.
    const invalidSizesBody = {
      id: "https://example.org/iiif/3/bad/full/max/0/default.jpg",
      type: "Image",
      service: [
        {
          id: "https://example.org/iiif/3/bad",
          type: "ImageService3",
          profile: "level0",
          sizes: [null],
        },
      ],
    };
    const pages = extractV3Pages({
      items: [v3Canvas(invalidSizesBody), v3Canvas(pomaBody)],
    });
    expect(pages).toHaveLength(2);
    // The invalid entry leaves no usable size, and this body is not itself a
    // small derivative (no declared width/height), so it falls through to
    // no thumbnail at all rather than a service-derived or body-id one.
    expect(pages[0].thumbnail).toBeUndefined();
    expect(pages[1].thumbnail).toBe(
      "https://s3.us-west-001.backblazeb2.com/juancobo-138la-iiif/poma/poma0000/full/415,557/0/default.jpg"
    );
  });
});

describe("extractAllPages — labels", () => {
  const body = { service: [{ id: "https://example.org/iiif/3/a" }] };

  it("reads a v3 language map", () => {
    const [page] = extractAllPages({
      items: [v3Canvas(body, { label: { es: ["Folio 1r"] } })],
    });
    expect(page.label).toBe("Folio 1r");
  });

  it.each([
    ["a plain string", "Folio 1r"],
    ["a language-tagged value", { "@value": "Folio 1r" }],
    ["an array of language-tagged values", [{ "@value": "Folio 1r" }]],
  ])("reads a v2 label as %s", (_shape, label) => {
    const [page] = extractAllPages({
      sequences: [
        {
          canvases: [
            v2Canvas({ service: { "@id": "https://example.org/iiif/2/a" } }, { label }),
          ],
        },
      ],
    });
    expect(page.label).toBe("Folio 1r");
  });

  it("attaches no label when the canvas carries none", () => {
    const [page] = extractAllPages({ items: [v3Canvas(body)] });
    expect(page.label).toBeUndefined();
  });
});

describe("sourceKeyFor", () => {
  it("names the same pair of URLs the same way", () => {
    expect(sourceKeyFor("m", "i")).toBe(sourceKeyFor("m", "i"));
  });

  it("distinguishes a different manifest and a different info.json", () => {
    expect(sourceKeyFor("m", "i")).not.toBe(sourceKeyFor("m2", "i"));
    expect(sourceKeyFor("m", "i")).not.toBe(sourceKeyFor("m", "i2"));
  });

  it("distinguishes an absent URL from an empty one it might be confused with", () => {
    expect(sourceKeyFor(null, "i")).not.toBe(sourceKeyFor("i", null));
  });
});

describe("thumbnailUrlFromInfo", () => {
  const base = { id: "https://example.org/iiif/3/a" };

  it("takes the smallest declared size at or above the minimum", () => {
    const url = thumbnailUrlFromInfo(
      { ...base, sizes: [{ width: 400, height: 500 }, { width: 200, height: 250 }] },
      160
    );
    expect(url).toBe("https://example.org/iiif/3/a/full/200,250/0/default.jpg");
  });

  it("takes a size exactly at the minimum", () => {
    const url = thumbnailUrlFromInfo(
      { ...base, sizes: [{ width: 160, height: 200 }, { width: 400, height: 500 }] },
      160
    );
    expect(url).toBe("https://example.org/iiif/3/a/full/160,200/0/default.jpg");
  });

  it("takes the largest declared size when every size is below the minimum", () => {
    const url = thumbnailUrlFromInfo(
      { ...base, sizes: [{ width: 80, height: 100 }, { width: 120, height: 150 }] },
      160
    );
    expect(url).toBe("https://example.org/iiif/3/a/full/120,150/0/default.jpg");
  });

  it("invents nothing when the server declares no sizes", () => {
    expect(thumbnailUrlFromInfo({ ...base, sizes: [] }, 160)).toBeNull();
    expect(thumbnailUrlFromInfo({ ...base }, 160)).toBeNull();
  });

  it("reads the v2 @id as the base URL", () => {
    const url = thumbnailUrlFromInfo(
      {
        "@context": "http://iiif.io/api/image/2/context.json",
        "@id": "https://example.org/iiif/2/a",
        sizes: [{ width: 200, height: 250 }],
      },
      160
    );
    expect(url).toBe("https://example.org/iiif/2/a/full/200,250/0/default.jpg");
  });

  it("reads the v3 id as the base URL", () => {
    const url = thumbnailUrlFromInfo(
      {
        "@context": "http://iiif.io/api/image/3/context.json",
        id: "https://example.org/iiif/3/a",
        sizes: [{ width: 200, height: 250 }],
      },
      160
    );
    expect(url).toBe("https://example.org/iiif/3/a/full/200,250/0/default.jpg");
  });

  it("returns nothing without a base URL", () => {
    expect(thumbnailUrlFromInfo({ sizes: [{ width: 200, height: 250 }] }, 160)).toBeNull();
  });
});

describe("formatPageNumber", () => {
  it("groups a four-digit count in both locales", () => {
    expect(formatPageNumber("en", 1240)).toBe("1,240");
    expect(formatPageNumber("es", 1240)).toBe("1.240");
  });

  it("leaves a small number ungrouped", () => {
    expect(formatPageNumber("en", 3)).toBe("3");
    expect(formatPageNumber("es", 3)).toBe("3");
  });
});
