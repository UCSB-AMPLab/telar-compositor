/**
 * The layer panel's word count (`app/lib/word-count.ts`), which splits on
 * JavaScript's whitespace.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { computeWordCount } from "~/lib/word-count";

describe("computeWordCount", () => {
  it("returns 0 for an empty string", () => {
    expect(computeWordCount("")).toBe(0);
  });

  it("returns 0 for whitespace-only strings", () => {
    expect(computeWordCount("   ")).toBe(0);
  });

  it("counts a single word", () => {
    expect(computeWordCount("hello")).toBe(1);
  });

  it("counts two words", () => {
    expect(computeWordCount("hello world")).toBe(2);
  });

  it("handles leading and trailing spaces", () => {
    expect(computeWordCount("  spaced  words  ")).toBe(2);
  });

  it("handles multiple internal spaces", () => {
    expect(computeWordCount("one   two   three")).toBe(3);
  });

  it("counts a markdown string with formatting markers as words", () => {
    expect(computeWordCount("**bold** and _italic_")).toBe(3);
  });

  it("counts newlines and tabs as separators", () => {
    expect(computeWordCount("one\ntwo\tthree\r\nfour")).toBe(4);
  });

  it("counts a URL as one word", () => {
    expect(computeWordCount("see https://telar.org/docs now")).toBe(3);
  });
});
