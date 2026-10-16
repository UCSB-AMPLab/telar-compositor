/**
 * The address a page takes from its title: a title the site already serves
 * (Objects, Stories, Glossary) gets the next free address that is not one.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect } from "vitest";
import { freePageSlug, isReservedPageAddress } from "~/lib/page-address";

describe("freePageSlug", () => {
  it("keeps a title's slug that nothing uses", () => {
    expect(freePageSlug("about", new Set())).toBe("about");
  });

  it("gives a title of Objects the address objects-page", () => {
    expect(freePageSlug("objects", new Set())).toBe("objects-page");
  });

  it("goes on to -2 when objects-page is taken", () => {
    expect(freePageSlug("objects", new Set(["objects-page"]))).toBe("objects-page-2");
  });

  it("still suffixes a taken ordinary slug", () => {
    expect(freePageSlug("about", new Set(["about"]))).toBe("about-2");
  });

  it("returns untitled for an empty base", () => {
    expect(freePageSlug("", new Set())).toBe("untitled");
  });
});

describe("isReservedPageAddress", () => {
  it.each(["stories", "objects", "glossary", "assets", "iiif", "telar-content", "Objects"])("reserves %s", (s) => {
    expect(isReservedPageAddress(s)).toBe(true);
  });
  it("does not reserve a slug that only starts with one", () => {
    expect(isReservedPageAddress("objects-team")).toBe(false);
  });
});
