/**
 * Unit tests for the shared Yjs ↔ D1 id helpers in `app/lib/yjs-helpers.ts`.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect } from "vitest";
import { isPersistableLayerId } from "~/lib/yjs-helpers";

describe("isPersistableLayerId", () => {
  it("returns true for a positive integer id", () => {
    expect(isPersistableLayerId(5)).toBe(true);
    expect(isPersistableLayerId(1)).toBe(true);
  });
  it("returns false for 0 (Yjs-only layer, _id null coerced to 0)", () => {
    expect(isPersistableLayerId(0)).toBe(false);
  });
  it("returns false for negative ids", () => {
    expect(isPersistableLayerId(-1)).toBe(false);
  });
  it("returns false for NaN / Infinity", () => {
    expect(isPersistableLayerId(NaN)).toBe(false);
    expect(isPersistableLayerId(Infinity)).toBe(false);
  });
  it("returns false for non-integer floats", () => {
    expect(isPersistableLayerId(1.5)).toBe(false);
  });
  it("returns false for null / undefined", () => {
    expect(isPersistableLayerId(null)).toBe(false);
    expect(isPersistableLayerId(undefined)).toBe(false);
  });
  it("accepts a numeric string that is a positive integer", () => {
    expect(isPersistableLayerId("5")).toBe(true);
    expect(isPersistableLayerId("0")).toBe(false);
  });
});
