// @vitest-environment jsdom
/**
 * MarkdownEditor.test.tsx — Component-level tests for the MarkdownEditor.
 *
 * Tests the wordCount utility logic and component import stability.
 * Note: EditorView requires real DOM layout (getBoundingClientRect etc.) which
 * jsdom does not provide, so full mount tests are limited to non-layout concerns.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// wordCount — extracted pure utility (also used inside MarkdownEditor)
// ---------------------------------------------------------------------------

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

describe("wordCount", () => {
  it("returns 0 for an empty string", () => {
    expect(wordCount("")).toBe(0);
  });

  it("returns 0 for whitespace-only strings", () => {
    expect(wordCount("   ")).toBe(0);
  });

  it("counts a single word", () => {
    expect(wordCount("hello")).toBe(1);
  });

  it("counts two words", () => {
    expect(wordCount("hello world")).toBe(2);
  });

  it("handles leading and trailing spaces", () => {
    expect(wordCount("  spaced  words  ")).toBe(2);
  });

  it("handles multiple internal spaces", () => {
    expect(wordCount("one   two   three")).toBe(3);
  });

  it("counts a markdown string with formatting markers as words", () => {
    expect(wordCount("**bold** and _italic_")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SSR guard — indirect test via module import
// ---------------------------------------------------------------------------
// In jsdom, typeof window is always "object" so the SSR guard returns normal
// component output. The actual SSR guard is validated by `npm run build` not
// crashing with "document is not defined". We verify here that the module
// can be imported without throwing.

describe("MarkdownEditor module", () => {
  it("can be imported without throwing", async () => {
    // This will throw if there are module-level CodeMirror access issues
    const mod = await import("~/components/ui/MarkdownEditor");
    expect(mod.MarkdownEditor).toBeDefined();
    expect(typeof mod.MarkdownEditor).toBe("function");
  });
});
