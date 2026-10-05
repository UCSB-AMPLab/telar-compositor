/**
 * This file pins the set of characters the Compositor cleans out of text
 * (`~/lib/unsafe-text`) and checks that the front-matter escaper handles the
 * same set.
 *
 * The expected set is written out below as literal code points, not derived
 * from the module, so a code point added to or dropped from the module's
 * ranges fails here rather than agreeing with itself.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { cleanText, needsCleaning, isUnsafeCodePoint } from "~/lib/unsafe-text";
import { escapeYamlString } from "~/lib/knap-filters.server";

/** Removed outright. */
const REMOVED = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
  0x7f, 0x80, 0x81, 0x82, 0x83, 0x84,
  0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
  0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
  0xfffe, 0xffff,
];

/** Cleaned to a space. */
const SEPARATING = [0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0x2028, 0x2029];

/** Never touched. */
const KEPT_CONTROLS = [0x09, 0x0a, 0x0d];

const EXPECTED_SET = new Set([...REMOVED, ...SEPARATING]);

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

describe("cleanText", () => {
  it.each(REMOVED.map((cp) => [hex(cp), cp]))("removes %s", (_label, cp) => {
    const text = `ab${String.fromCodePoint(cp as number)}cd`;
    expect(needsCleaning(text)).toBe(true);
    expect(cleanText(text)).toBe("abcd");
  });

  it.each(SEPARATING.map((cp) => [hex(cp), cp]))("turns %s into a space", (_label, cp) => {
    const text = `ab${String.fromCodePoint(cp as number)}cd`;
    expect(needsCleaning(text)).toBe(true);
    expect(cleanText(text)).toBe("ab cd");
  });

  it("keeps tab, newline and carriage return", () => {
    const text = "a\tb\nc\r\nd";
    expect(needsCleaning(text)).toBe(false);
    expect(cleanText(text)).toBe(text);
  });

  it("replaces a lone high surrogate and a lone low surrogate with U+FFFD", () => {
    expect(cleanText("a\ud800b")).toBe("a\ufffdb");
    expect(cleanText("a\udc00b")).toBe("a\ufffdb");
    expect(cleanText("a\ud800")).toBe("a\ufffd");
    expect(cleanText("\udfff\ud83d")).toBe("\ufffd\ufffd");
  });

  it("keeps a well-formed surrogate pair", () => {
    const text = "cántaro 🏺 fin";
    expect(needsCleaning(text)).toBe(false);
    expect(cleanText(text)).toBe(text);
  });

  it("returns clean text unchanged", () => {
    const text = "Ánfora de terracota — «decorada» en añil, 1650.\nSegunda línea.";
    expect(needsCleaning(text)).toBe(false);
    expect(cleanText(text)).toBe(text);
  });

  it("cleans the hyphenation noncharacter a PDF leaves at a line break", () => {
    expect(cleanText("Mediterr\ufffeanean")).toBe("Mediterranean");
  });

  it("cleans a mix of members in one pass", () => {
    expect(cleanText("\u0001a\u2028b\u0085c\ufffe\ud800")).toBe("a b c\ufffd");
  });

  it("the module's set is exactly the expected set across the BMP", () => {
    const extra: string[] = [];
    const missing: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const inModule = isUnsafeCodePoint(cp);
      const expected = EXPECTED_SET.has(cp);
      if (inModule && !expected) extra.push(hex(cp));
      if (!inModule && expected) missing.push(hex(cp));
      const text = String.fromCodePoint(cp);
      expect(needsCleaning(text), hex(cp)).toBe(expected);
    }
    expect(extra).toEqual([]);
    expect(missing).toEqual([]);
    for (const cp of KEPT_CONTROLS) expect(isUnsafeCodePoint(cp)).toBe(false);
  });
});

describe("the escaper and cleanText agree on the set", () => {
  it("escapeYamlString leaves no member raw", () => {
    for (const cp of EXPECTED_SET) {
      const out = escapeYamlString(`a${String.fromCodePoint(cp)}b`);
      expect(out.includes(String.fromCodePoint(cp)), hex(cp)).toBe(false);
    }
  });

  it("escapeYamlString and cleanText both leave a non-member raw", () => {
    for (const cp of [0x20, 0x41, 0xa0, 0xe9, 0x2014, 0x3000, 0xfeff, 0xfffd]) {
      const char = String.fromCodePoint(cp);
      expect(cleanText(char), hex(cp)).toBe(char);
      expect(escapeYamlString(char), hex(cp)).toBe(`"${char}"`);
    }
  });
});
