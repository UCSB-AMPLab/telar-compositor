import { describe, it, expect } from "vitest";
import { normaliseSlug, makeUniqueSlug } from "~/lib/slug";

describe("makeUniqueSlug", () => {
  it("returns original slug when no duplicates exist", () => {
    expect(makeUniqueSlug("team", new Set(["about"]))).toEqual({ slug: "team", wasAdjusted: false });
  });

  it("appends -2 when slug already exists", () => {
    expect(makeUniqueSlug("about", new Set(["about"]))).toEqual({ slug: "about-2", wasAdjusted: true });
  });

  it("appends -3 when slug and slug-2 both exist", () => {
    expect(makeUniqueSlug("about", new Set(["about", "about-2"]))).toEqual({ slug: "about-3", wasAdjusted: true });
  });

  it("excludes self slug from collision check", () => {
    expect(makeUniqueSlug("about", new Set(["about"]), "about")).toEqual({ slug: "about", wasAdjusted: false });
  });

  it("returns wasAdjusted: true when suffix added", () => {
    const result = makeUniqueSlug("about", new Set(["about"]));
    expect(result.wasAdjusted).toBe(true);
  });

  it("returns wasAdjusted: false when no suffix needed", () => {
    const result = makeUniqueSlug("team", new Set(["about"]));
    expect(result.wasAdjusted).toBe(false);
  });

  it("returns untitled with wasAdjusted: true when base is empty", () => {
    expect(makeUniqueSlug("", new Set())).toEqual({ slug: "untitled", wasAdjusted: true });
  });

  it("normaliseSlug converts Hello World! to hello-world", () => {
    expect(normaliseSlug("Hello World!")).toBe("hello-world");
  });
});
