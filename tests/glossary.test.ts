import { describe, it, expect } from "vitest";
import { slugifyTermId } from "~/lib/slug";

describe("term_id slugification", () => {
  it("slugifies title to lowercase hyphenated term_id", () => {
    expect(slugifyTermId("Encomienda")).toBe("encomienda");
  });

  it("strips non-alphanumeric characters and parentheses", () => {
    expect(slugifyTermId("New Granada (1538)")).toBe("new-granada-1538");
  });

  it("handles leading and trailing spaces", () => {
    expect(slugifyTermId("   Spaces   ")).toBe("spaces");
  });

  it("returns empty string for empty title", () => {
    expect(slugifyTermId("")).toBe("");
  });
});

describe("glossary alphabetical sort", () => {
  it("sorts terms alphabetically by title", () => {
    const terms = [
      { title: "Banana" },
      { title: "apple" },
      { title: "Cherry" },
    ];
    const sorted = [...terms].sort((a, b) =>
      a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
    );
    expect(sorted.map((t) => t.title)).toEqual(["apple", "Banana", "Cherry"]);
  });

  it("handles case-insensitive sorting correctly", () => {
    const terms = [
      { title: "Zebra" },
      { title: "mango" },
      { title: "Avocado" },
    ];
    const sorted = [...terms].sort((a, b) =>
      a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
    );
    expect(sorted.map((t) => t.title)).toEqual(["Avocado", "mango", "Zebra"]);
  });
});
