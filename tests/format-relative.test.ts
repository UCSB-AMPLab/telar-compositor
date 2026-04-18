import { describe, it, expect } from "vitest";
import { formatRelative } from "../app/lib/format-relative";

describe("formatRelative", () => {
  it("returns '' for null input", () => {
    expect(formatRelative(null)).toBe("");
  });

  it("returns '' for undefined input", () => {
    expect(formatRelative(undefined)).toBe("");
  });

  it("returns neverLabel for null input when provided", () => {
    expect(formatRelative(null, "Never")).toBe("Never");
  });

  it("returns 'Just now' for timestamp 30 seconds ago", () => {
    const ago = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatRelative(ago)).toBe("Just now");
  });

  it("returns singular '1 minute ago' for timestamp 1 minute ago", () => {
    const ago = new Date(Date.now() - 61 * 1000).toISOString();
    expect(formatRelative(ago)).toBe("1 minute ago");
  });

  it("returns plural '5 minutes ago' for timestamp 5 minutes ago", () => {
    const ago = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatRelative(ago)).toBe("5 minutes ago");
  });

  it("returns singular '1 hour ago' for timestamp 1 hour ago", () => {
    const ago = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    expect(formatRelative(ago)).toBe("1 hour ago");
  });

  it("returns plural '3 hours ago' for timestamp 3 hours ago", () => {
    const ago = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(ago)).toBe("3 hours ago");
  });

  it("returns singular '1 day ago' for timestamp 1 day ago", () => {
    const ago = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(ago)).toBe("1 day ago");
  });

  it("returns plural '7 days ago' for timestamp 7 days ago", () => {
    const ago = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelative(ago)).toBe("7 days ago");
  });

  it("returns locale date string for timestamp 45 days ago", () => {
    const date = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const ago = date.toISOString();
    expect(formatRelative(ago)).toBe(date.toLocaleDateString());
  });
});
