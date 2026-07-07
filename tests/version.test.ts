import { describe, it, expect } from "vitest";
import { normalizeVersionTag, stripVersionPrefix } from "~/lib/version";

describe("normalizeVersionTag", () => {
  it("adds a leading v when missing", () => {
    expect(normalizeVersionTag("1.4.0")).toBe("v1.4.0");
  });

  it("leaves an existing leading v untouched", () => {
    expect(normalizeVersionTag("v1.4.0")).toBe("v1.4.0");
  });

  it("is idempotent", () => {
    expect(normalizeVersionTag(normalizeVersionTag("1.4.0"))).toBe("v1.4.0");
  });

  it("handles prerelease suffixes", () => {
    expect(normalizeVersionTag("1.4.0-beta")).toBe("v1.4.0-beta");
  });
});

describe("stripVersionPrefix", () => {
  it("removes a leading v when present", () => {
    expect(stripVersionPrefix("v1.4.0")).toBe("1.4.0");
  });

  it("leaves a tag without a leading v untouched", () => {
    expect(stripVersionPrefix("1.4.0")).toBe("1.4.0");
  });

  it("is idempotent", () => {
    expect(stripVersionPrefix(stripVersionPrefix("v1.4.0"))).toBe("1.4.0");
  });

  it("handles prerelease suffixes", () => {
    expect(stripVersionPrefix("v1.4.0-beta")).toBe("1.4.0-beta");
  });
});
