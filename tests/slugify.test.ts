import { describe, it, expect } from "vitest";
import { slugify } from "~/lib/slugify";

describe("slugify", () => {
  it("converts a title to a lowercase hyphenated slug", () => {
    expect(slugify("The Codex Mendoza")).toBe("the-codex-mendoza");
  });

  it("collapses multiple spaces into a single hyphen", () => {
    expect(slugify("  Hello   World  ")).toBe("hello-world");
  });

  it("strips diacritics and normalises accented characters", () => {
    expect(slugify("Café Résumé")).toBe("cafe-resume");
  });

  it("returns an empty string when there are no alphanumeric characters", () => {
    expect(slugify("!!!")).toBe("");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("---test---")).toBe("test");
  });

  it("strips special characters including slashes and backslashes", () => {
    expect(slugify("a/b\\c")).toBe("abc");
  });

  it("replaces ampersands and surrounding spaces with a single hyphen", () => {
    expect(slugify("Story 1 & Story 2")).toBe("story-1-story");
  });

  it("handles numeric-only titles", () => {
    expect(slugify("2024")).toBe("2024");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(slugify("   ")).toBe("");
  });

  it("handles mixed alphanumeric and punctuation", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });

  it("truncates long titles to 3 words by default", () => {
    expect(slugify("Tableau comparatif et Figure de La Hauteur des Principales Montagnes")).toBe("tableau-comparatif-et");
  });

  it("does not truncate titles with 3 or fewer words", () => {
    expect(slugify("The Codex Mendoza")).toBe("the-codex-mendoza");
  });

  it("respects custom maxWords parameter", () => {
    expect(slugify("one two three four five", 2)).toBe("one-two");
  });

  it("returns full slug when maxWords is 0", () => {
    expect(slugify("one two three four five", 0)).toBe("one-two-three-four-five");
  });
});
