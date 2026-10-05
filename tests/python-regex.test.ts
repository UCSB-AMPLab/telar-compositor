/**
 * This file pins `compilePythonPattern` construct by construct. These cases
 * name the construct, and they run anywhere.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { compilePythonPattern, pythonCaseFold } from "~/lib/python-regex";

/** Every match of `pattern` in `text`, as whole-match strings. */
function matches(pattern: string, flags: string, text: string): string[] {
  return [...text.matchAll(compilePythonPattern(pattern, flags))].map((m) => m[0]);
}

describe("line anchors under MULTILINE", () => {
  it("breaks a line at a newline, as Python does", () => {
    expect(matches("^a", "gm", "a\na")).toEqual(["a", "a"]);
  });

  it.each([
    ["a carriage return", "\r"],
    ["a line separator", " "],
    ["a paragraph separator", " "],
  ])("does not break a line at %s, which JavaScript's own m would", (_name, sep) => {
    expect(matches("^a", "gm", `a${sep}a`)).toEqual(["a"]);
  });

  it("ends a line only at a newline", () => {
    expect(matches("a$", "gm", "a\na")).toEqual(["a", "a"]);
    expect(matches("a$", "gm", "a\ra")).toEqual(["a"]);
  });

  it("leaves a caret inside a character class as negation", () => {
    expect(matches("[^a]", "gm", "abc")).toEqual(["b", "c"]);
  });
});

describe("the dot", () => {
  it("excludes only a newline, so a carriage return is matched", () => {
    expect(matches("a.b", "g", "a\rb")).toEqual(["a\rb"]);
    expect(matches("a.b", "g", "a\nb")).toEqual([]);
  });

  it("matches everything under DOTALL", () => {
    expect(matches("a.b", "gs", "a\nb")).toEqual(["a\nb"]);
  });
});

describe("whitespace", () => {
  it.each([
    ["a file separator", ""],
    ["a next line", ""],
    ["a form feed", ""],
  ])("counts %s, which CPython does", (_name, ch) => {
    expect(matches("a\\sb", "g", `a${ch}b`)).toEqual([`a${ch}b`]);
  });

  it("does not count U+FEFF, which only JavaScript calls whitespace", () => {
    expect(matches("a\\sb", "g", "a﻿b")).toEqual([]);
  });

  it("negates the same set", () => {
    expect(matches("a\\Sb", "g", "a﻿b")).toEqual(["a﻿b"]);
    expect(matches("a\\Sb", "g", "ab")).toEqual([]);
  });

  it("keeps the any-character idiom meaning any character", () => {
    expect(matches("a[\\s\\S]b", "g", "a﻿b")).toEqual(["a﻿b"]);
    expect(matches("a[\\s\\S]b", "g", "a\nb")).toEqual(["a\nb"]);
  });
});

describe("the word boundary", () => {
  it("is Unicode-aware, so an accented letter is a word character", () => {
    expect(matches("img\\b", "g", "imgé")).toEqual([]);
    expect(matches("img\\b", "g", "img>")).toEqual(["img"]);
  });
});

describe("case folding", () => {
  // Inverted from a case that expected the compiler to expand both. Python
  // equates them when matching a literal but NOT when comparing what a
  // backreference captured, and only the second can be reached by folding the
  // text — so the two are handled in different places. The dotless i is the
  // pattern's business; the dotted capital I is the shadow's, and this file
  // sees the pattern.
  it("expands a dotless i in the pattern, which JavaScript does not fold", () => {
    expect(matches("img", "gi", "ımg")).toEqual(["ımg"]);
  });

  it("expands a long s in the pattern for the same reason", () => {
    expect(matches("span", "gi", "ſpan")).toEqual(["ſpan"]);
  });

  it("leaves a dotted capital I to the folded shadow, not to the pattern", () => {
    expect(compilePythonPattern("img", "gi").source).not.toContain("\u0130");
  });

  it("still folds the letters JavaScript's own Unicode folding covers", () => {
    expect(matches("span", "gi", "ſpan")).toEqual(["ſpan"]);
    expect(matches("k", "gi", "K")).toEqual(["K"]);
  });

  it("folds nothing when the pattern is case-sensitive", () => {
    expect(matches("img", "g", "İmg")).toEqual([]);
  });
});

describe("what the compiler refuses rather than mistranslates", () => {
  it.each(["\\d", "\\w", "\\D", "\\W"])(
    "refuses %s, whose meaning differs between the engines",
    (escape) => {
      expect(() => compilePythonPattern(`a${escape}b`, "g")).toThrow(/no faithful/);
    },
  );

  it("refuses a negated whitespace escape inside a character class", () => {
    expect(() => compilePythonPattern("[a\\S]", "g")).toThrow(/character class/);
  });

  // The shadow folds the INPUT, not the pattern, and JavaScript's own folding
  // does not equate these with their ASCII letters. A pattern carrying one as
  // a literal would therefore match text Python matches, and text Python does
  // not, depending on which side the code point fell. No rule in the table
  // carries one; the refusal is what keeps it that way.
  it.each([
    ["a dotted capital I", "\u0130", "U+0130"],
    ["a Kelvin sign", "\u212a", "U+212A"],
    ["a dotless i", "\u0131", "U+0131"],
    ["a long s", "\u017f", "U+017F"],
  ])("refuses %s in a case-insensitive pattern, naming it", (_name, literal, named) => {
    expect(() => compilePythonPattern(`<${literal}mg>`, "gi")).toThrow(named);
  });

  // The refusal above reads the pattern's characters, and an escape hides one
  // from it: `\u0130` is six characters, none of them the code point it
  // denotes. Every code-point escape is therefore refused in a
  // case-insensitive pattern — the framework's table writes none — and the
  // message names both the escape and what it stands for.
  it.each([
    ["a four-digit unicode escape", String.raw`<\u0130mg>`, "U+0130"],
    ["one inside a character class", String.raw`[a\u0131]`, "U+0131"],
    ["a two-digit hex escape", String.raw`<\x49mg>`, "U+0049"],
    ["an eight-digit unicode escape", String.raw`<\U00000130mg>`, "U+0130"],
  ])("refuses %s in a case-insensitive pattern", (_name, pattern, named) => {
    expect(() => compilePythonPattern(pattern, "gi")).toThrow(named);
  });

  it("refuses a named code point escape too, naming the escape itself", () => {
    expect(() => compilePythonPattern(String.raw`\N{LATIN SMALL LETTER I}`, "gi")).toThrow(
      "\\N{LATIN SMALL LETTER I}",
    );
  });

  it("takes a code-point escape in a case-sensitive pattern, which folds nothing", () => {
    expect(matches(String.raw`\u0130mg`, "g", "İmg here")).toEqual(["İmg"]);
  });

  it("takes the same literal in a case-sensitive pattern, where it means itself", () => {
    expect(matches("\u0130mg", "g", "\u0130mg here")).toEqual(["\u0130mg"]);
  });
});

describe("the folded shadow", () => {
  it("maps only what Python's backreference comparison equates", () => {
    expect(pythonCaseFold("v\u0130deo")).toBe("video");
    expect(pythonCaseFold("\u212aelvin")).toBe("kelvin");
  });

  it("leaves the code points Python's comparison refuses, however it matches them", () => {
    expect(pythonCaseFold("vıdeo")).toBe("vıdeo");
    expect(pythonCaseFold("ſpan")).toBe("ſpan");
  });

  // Every index in the copy must be the same position in the original, or the
  // ranges cut from the original would be the wrong ranges.
  it.each(["vİdeo", "Kelvin", "plain text", "", "aİbKc"])(
    "returns a copy of %j the same length as the original",
    (text) => {
      expect(pythonCaseFold(text)).toHaveLength(text.length);
    },
  );
});
