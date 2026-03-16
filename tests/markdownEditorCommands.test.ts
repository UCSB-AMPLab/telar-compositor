/**
 * markdownEditorCommands.test.ts — Unit tests for MarkdownEditor command utilities.
 *
 * Tests the pure wrapText helper exported from commands.ts. These tests do not
 * require a DOM — they validate the wrap/unwrap string logic directly.
 */

import { describe, it, expect } from "vitest";
import { wrapText } from "~/components/ui/markdown-editor/commands";

describe("wrapText", () => {
  it("wraps plain text with a bold marker", () => {
    expect(wrapText("hello", "**")).toBe("**hello**");
  });

  it("unwraps already-wrapped bold text", () => {
    expect(wrapText("**hello**", "**")).toBe("hello");
  });

  it("wraps an empty string (empty selection)", () => {
    expect(wrapText("", "**")).toBe("****");
  });

  it("wraps plain text with an italic underscore marker", () => {
    expect(wrapText("hello", "_")).toBe("_hello_");
  });

  it("unwraps already-wrapped italic underscore text", () => {
    expect(wrapText("_hello_", "_")).toBe("hello");
  });

  it("wraps plain text with italic asterisk marker", () => {
    expect(wrapText("world", "*")).toBe("*world*");
  });

  it("does not unwrap if only one side has the marker", () => {
    // "**hello" — starts with ** but doesn't end with **
    expect(wrapText("**hello", "**")).toBe("****hello**");
  });
});
