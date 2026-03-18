/**
 * Tests for captureViewportState — pure viewport state extraction utility.
 */

import { describe, it, expect } from "vitest";
import { captureViewportState } from "~/lib/viewer-utils";

describe("captureViewportState", () => {
  it("returns correct x, y, zoom values from viewport center", () => {
    const result = captureViewportState({ x: 0.5, y: 0.3 }, 1.75, 0);
    expect(result.x).toBe(0.5);
    expect(result.y).toBe(0.3);
    expect(result.zoom).toBe(1.75);
  });

  it("converts 0-based pageIndex to 1-indexed page string", () => {
    const result = captureViewportState({ x: 0.5, y: 0.5 }, 1, 0);
    expect(result.page).toBe("1");
  });

  it("converts pageIndex 1 to page '2'", () => {
    const result = captureViewportState({ x: 0.5, y: 0.5 }, 1, 1);
    expect(result.page).toBe("2");
  });

  it("converts pageIndex 4 to page '5'", () => {
    const result = captureViewportState({ x: 0.2, y: 0.8 }, 2.5, 4);
    expect(result.page).toBe("5");
  });

  it("uses '1' when pageIndex is null (single-page object)", () => {
    const result = captureViewportState({ x: 0.5, y: 0.5 }, 1, null);
    expect(result.page).toBe("1");
  });

  it("returns fractional coordinates with full precision", () => {
    const result = captureViewportState({ x: 0.123456789, y: 0.987654321 }, 3.14159, 0);
    expect(result.x).toBeCloseTo(0.123456789, 8);
    expect(result.y).toBeCloseTo(0.987654321, 8);
    expect(result.zoom).toBeCloseTo(3.14159, 4);
  });
});
